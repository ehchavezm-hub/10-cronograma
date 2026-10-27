// @ts-check
/**
 * auth.js — Autenticación Supabase Auth + gestión de sesión ECM Project.
 *
 * Expone:
 *   authState      — estado reactivo { user, session, perfil, empresas, empresaActual }
 *   authInit()     — llamar al inicio; restaura sesión desde localStorage
 *   showLoginModal() — abre el modal de login
 *   logout()       — cierra sesión y recarga
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, IS_LOCAL_MODE } from './config.js';

// ============================================================
// Estado reactivo
// ============================================================
const _subs = [];

export const authState = {
  user:          null,   // objeto auth.users de Supabase
  session:       null,   // { access_token, refresh_token, expires_at }
  perfil:        null,   // fila de profiles
  empresas:      [],     // filas de org_memberships JOIN organizations
  empresaActual: null,   // { org_id, org_name, empresa_role }
  mustChangePwd: false,  // true si temp_password aún activo

  subscribe(fn) { _subs.push(fn); return () => { const i = _subs.indexOf(fn); if (i >= 0) _subs.splice(i,1); }; },
  _notify() { _subs.forEach(fn => fn(authState)); },
};

// ============================================================
// Helpers fetch Auth API
// ============================================================
const AUTH = `${SUPABASE_URL}/auth/v1`;
const REST = `${SUPABASE_URL}/rest/v1`;

function _hdrs(token) {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

async function _authFetch(path, body, token) {
  const res = await fetch(`${AUTH}${path}`, {
    method: 'POST',
    headers: _hdrs(token),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.message || data.error || `HTTP ${res.status}`);
  return data;
}

async function _restGet(tabla, filter, token) {
  const qs = new URLSearchParams({ select: '*', ...filter });
  const res = await fetch(`${REST}/${tabla}?${qs}`, { headers: _hdrs(token) });
  if (!res.ok) return [];
  return res.json().catch(() => []);
}

async function _rpcPost(fn, args, token) {
  const res = await fetch(`${REST}/rpc/${fn}`, {
    method: 'POST',
    headers: _hdrs(token),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.message || d.error || `HTTP ${res.status}`);
  }
  return res.json().catch(() => null);
}

async function _restPatch(tabla, id, campos, token) {
  const res = await fetch(`${REST}/${tabla}?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ..._hdrs(token), 'Prefer': 'return=representation' },
    body: JSON.stringify(campos),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// ============================================================
// Persistencia de sesión
// ============================================================
const SESSION_KEY = 'ecm_session';

function _saveSession(s) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {}
}
function _loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}
function _clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  try { localStorage.removeItem('ecm_empresa_actual'); } catch {}
}

// ============================================================
// Carga de perfil y empresas tras login
// ============================================================
async function _loadPerfil(token, userId) {
  const rows = await _restGet('profiles', { 'id': `eq.${userId}` }, token);
  return rows[0] || null;
}

async function _loadEmpresas(token, userId) {
  const rows = await _restGet('org_memberships', {
    'user_id': `eq.${userId}`,
    'active':  'eq.true',
    'select':  'id,org_id,empresa_role,temp_password,expires_at,organizations(id,name,slug,status)',
  }, token);
  return rows.map(r => ({
    mem_id:       r.id,
    org_id:       r.org_id,
    org_name:     r.organizations?.name ?? r.org_id,
    org_slug:     r.organizations?.slug ?? '',
    org_status:   r.organizations?.status ?? 'active',
    empresa_role: r.empresa_role,
    has_temp_pwd: !!r.temp_password,
    expires_at:   r.expires_at,
  }));
}

// ============================================================
// Inicialización (llamar al arrancar la app)
// ============================================================
export async function authInit() {
  if (IS_LOCAL_MODE) return;

  const saved = _loadSession();
  if (!saved?.access_token) return;

  // Intentar refrescar token
  try {
    const data = await _authFetch('/token?grant_type=refresh_token', {
      refresh_token: saved.refresh_token,
    });
    await _applySession(data);
  } catch {
    _clearSession();
    authState._notify();
  }
}

async function _applySession(data) {
  if (!data?.access_token) return;

  const token  = data.access_token;
  const userId = data.user?.id;

  authState.session = data;
  authState.user    = data.user;
  _saveSession({ access_token: token, refresh_token: data.refresh_token });

  // Cargar perfil y empresas en paralelo
  const [perfil, empresas] = await Promise.all([
    _loadPerfil(token, userId),
    _loadEmpresas(token, userId),
  ]);

  authState.perfil   = perfil;
  authState.empresas = empresas;

  // Si no tiene rol propietario, verificar si hay que asignarlo (primer usuario)
  if (perfil && perfil.platform_role === 'ninguno') {
    try {
      const existentes = await _restGet('profiles', { 'platform_role': 'eq.propietario', 'select': 'id' }, token);
      if (existentes.length === 0) {
        await fetch(`${REST}/profiles?id=eq.${userId}`, {
          method: 'PATCH',
          headers: { ..._hdrs(token), 'Prefer': 'return=minimal' },
          body: JSON.stringify({ platform_role: 'propietario' }),
        });
        authState.perfil = await _loadPerfil(token, userId);
      }
    } catch {}
    try { await _rpcPost('reclamar_propietario', {}, token); } catch {}
  }

  // Empresa actual: la guardada o la primera disponible
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('ecm_empresa_actual') || 'null'); } catch {}
  const match = empresas.find(e => e.org_id === stored?.org_id) || empresas[0] || null;
  authState.empresaActual = match;
  authState.mustChangePwd = match?.has_temp_pwd ?? false;

  // Actualizar token en el cliente sb global
  try {
    const { sb } = await import('./supabase.js');
    sb?.setToken(token);
  } catch {}

  authState._notify();
}

// ============================================================
// Login con email + contraseña
// ============================================================
export async function login(email, password) {
  const data = await _authFetch('/token?grant_type=password', { email, password });
  await _applySession(data);
  return authState;
}

// ============================================================
// Registro de nuevo usuario
// ============================================================
export async function register(email, password) {
  const data = await _authFetch('/signup', { email, password });
  // Supabase puede requerir confirmación de email; si devuelve sesión, la aplicamos
  if (data.access_token) {
    await _applySession(data);
  }
  return data;
}

// ============================================================
// Cambiar contraseña (clave temporal → permanente)
// ============================================================
export async function cambiarPassword(newPassword) {
  const token = authState.session?.access_token;
  if (!token) throw new Error('Sin sesión activa');
  const res = await fetch(`${AUTH}/user`, {
    method: 'PUT',
    headers: _hdrs(token),
    body: JSON.stringify({ password: newPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.message || `HTTP ${res.status}`);

  // Limpiar temp_password en org_memberships
  const mem = authState.empresas.find(e => e.org_id === authState.empresaActual?.org_id);
  if (mem) {
    await _restPatch('org_memberships', mem.mem_id, { temp_password: null }, token);
  }
  authState.mustChangePwd = false;
  authState._notify();
  return true;
}

// ============================================================
// Seleccionar empresa activa
// ============================================================
export function seleccionarEmpresa(org_id) {
  const e = authState.empresas.find(x => x.org_id === org_id);
  if (!e) return;
  authState.empresaActual = e;
  authState.mustChangePwd = e.has_temp_pwd;
  try { localStorage.setItem('ecm_empresa_actual', JSON.stringify({ org_id })); } catch {}
  authState._notify();
}

// ============================================================
// Logout
// ============================================================
export async function logout() {
  const token = authState.session?.access_token;
  if (token) {
    try { await fetch(`${AUTH}/logout`, { method: 'POST', headers: _hdrs(token) }); } catch {}
  }
  _clearSession();
  authState.user = null;
  authState.session = null;
  authState.perfil = null;
  authState.empresas = [];
  authState.empresaActual = null;
  authState.mustChangePwd = false;
  try {
    const { sb } = await import('./supabase.js');
    sb?.clearToken();
  } catch {}
  authState._notify();
  window.location.reload();
}

// ============================================================
// Modal de login — montado dinámicamente
// ============================================================
let _modalEl = null;

export function showLoginModal() {
  if (_modalEl) { _modalEl.showModal(); return; }

  _modalEl = document.createElement('dialog');
  _modalEl.id = 'dlg-auth';
  _modalEl.setAttribute('aria-modal', 'true');
  _modalEl.setAttribute('aria-labelledby', 'dlg-auth-title');
  _modalEl.innerHTML = _loginHTML();
  document.body.appendChild(_modalEl);

  _bindLoginEvents(_modalEl);
  _modalEl.showModal();
}

function _loginHTML() {
  return `
<div id="auth-container" style="
  background:var(--clr-surface,#fff);
  border-radius:16px;
  padding:32px;
  width:min(420px,90vw);
  font-family:var(--font-ui,system-ui);
  box-shadow:0 8px 32px rgba(0,0,0,.18);
">
  <!-- PASO 1: login -->
  <div id="auth-step-login">
    <h2 id="dlg-auth-title" style="margin:0 0 4px;font-size:1.25rem;font-weight:700;color:var(--clr-text,#111)">
      Iniciar sesión
    </h2>
    <p style="margin:0 0 24px;font-size:.85rem;color:var(--clr-text-3,#666)">
      ECM Project
    </p>
    <div id="auth-error" role="alert" style="display:none;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:.85rem;color:#b91c1c"></div>
    <label style="display:block;font-size:.82rem;font-weight:600;color:var(--clr-text-2,#444);margin-bottom:4px">Correo electrónico</label>
    <input id="auth-email" type="email" autocomplete="email" placeholder="usuario@empresa.com"
      style="width:100%;box-sizing:border-box;padding:9px 12px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:8px;font-size:.9rem;margin-bottom:14px;background:var(--clr-input-bg,#f9fafb);color:var(--clr-text,#111)">
    <label style="display:block;font-size:.82rem;font-weight:600;color:var(--clr-text-2,#444);margin-bottom:4px">Contraseña</label>
    <input id="auth-password" type="password" autocomplete="current-password" placeholder="••••••••"
      style="width:100%;box-sizing:border-box;padding:9px 12px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:8px;font-size:.9rem;margin-bottom:20px;background:var(--clr-input-bg,#f9fafb);color:var(--clr-text,#111)">
    <div id="auth-confirm-pwd-wrap" style="display:none">
      <label style="display:block;font-size:.82rem;font-weight:600;color:var(--clr-text-2,#444);margin-bottom:4px">Confirmar contraseña</label>
      <input id="auth-confirm-password" type="password" autocomplete="new-password" placeholder="Repetir contraseña"
        style="width:100%;box-sizing:border-box;padding:9px 12px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:8px;font-size:.9rem;margin-bottom:20px;background:var(--clr-input-bg,#f9fafb);color:var(--clr-text,#111)">
    </div>
    <button id="auth-submit" style="
      width:100%;padding:10px;border:none;border-radius:8px;
      background:var(--clr-accent,#4f46e5);color:#fff;
      font-size:.95rem;font-weight:600;cursor:pointer;
    ">Ingresar</button>
    <p id="auth-loading" style="display:none;text-align:center;margin-top:12px;font-size:.85rem;color:var(--clr-text-3,#666)">Verificando…</p>
    <p style="text-align:center;margin-top:16px;font-size:.82rem;color:var(--clr-text-3,#666)">
      <a id="auth-mode-toggle" href="#" style="color:var(--clr-accent,#4f46e5);text-decoration:none;font-weight:600">
        ¿No tienes cuenta? Crear cuenta
      </a>
    </p>
  </div>

  <!-- PASO 2: seleccionar empresa -->
  <div id="auth-step-empresa" style="display:none">
    <h2 style="margin:0 0 4px;font-size:1.25rem;font-weight:700;color:var(--clr-text,#111)">Seleccionar empresa</h2>
    <p style="margin:0 0 20px;font-size:.85rem;color:var(--clr-text-3,#666)">Elige la empresa con la que deseas trabajar</p>
    <div id="auth-empresa-list" style="display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto"></div>
  </div>

  <!-- PASO 3: cambiar contraseña temporal -->
  <div id="auth-step-pwd" style="display:none">
    <h2 style="margin:0 0 4px;font-size:1.25rem;font-weight:700;color:var(--clr-text,#111)">Cambiar contraseña</h2>
    <p style="margin:0 0 20px;font-size:.85rem;color:var(--clr-text-3,#666)">
      Tu cuenta tiene una contraseña temporal. Elige una contraseña permanente para continuar.
    </p>
    <div id="auth-pwd-error" role="alert" style="display:none;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:.85rem;color:#b91c1c"></div>
    <label style="display:block;font-size:.82rem;font-weight:600;color:var(--clr-text-2,#444);margin-bottom:4px">Nueva contraseña</label>
    <input id="auth-newpwd" type="password" autocomplete="new-password" placeholder="Mínimo 8 caracteres"
      style="width:100%;box-sizing:border-box;padding:9px 12px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:8px;font-size:.9rem;margin-bottom:14px;background:var(--clr-input-bg,#f9fafb);color:var(--clr-text,#111)">
    <label style="display:block;font-size:.82rem;font-weight:600;color:var(--clr-text-2,#444);margin-bottom:4px">Confirmar contraseña</label>
    <input id="auth-newpwd2" type="password" autocomplete="new-password" placeholder="Repetir contraseña"
      style="width:100%;box-sizing:border-box;padding:9px 12px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:8px;font-size:.9rem;margin-bottom:20px;background:var(--clr-input-bg,#f9fafb);color:var(--clr-text,#111)">
    <button id="auth-pwd-submit" style="
      width:100%;padding:10px;border:none;border-radius:8px;
      background:var(--clr-accent,#4f46e5);color:#fff;
      font-size:.95rem;font-weight:600;cursor:pointer;
    ">Establecer contraseña</button>
  </div>
</div>`;
}

function _show(id) {
  ['auth-step-login','auth-step-empresa','auth-step-pwd'].forEach(s => {
    const el = document.getElementById(s);
    if (el) el.style.display = s === id ? '' : 'none';
  });
}

function _err(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

function _bindLoginEvents(dlg) {
  const emailEl      = dlg.querySelector('#auth-email');
  const pwdEl        = dlg.querySelector('#auth-password');
  const submitEl     = dlg.querySelector('#auth-submit');
  const loadEl       = dlg.querySelector('#auth-loading');
  const toggleEl     = dlg.querySelector('#auth-mode-toggle');
  const confirmWrap  = dlg.querySelector('#auth-confirm-pwd-wrap');
  const confirmEl    = dlg.querySelector('#auth-confirm-password');
  const titleEl      = dlg.querySelector('#dlg-auth-title');

  let _mode = 'login'; // 'login' | 'register'

  toggleEl?.addEventListener('click', e => {
    e.preventDefault();
    _mode = _mode === 'login' ? 'register' : 'login';
    _err('auth-error', '');
    if (_mode === 'register') {
      if (titleEl) titleEl.textContent = 'Crear cuenta';
      submitEl.textContent = 'Registrarme';
      toggleEl.textContent = '¿Ya tienes cuenta? Iniciar sesión';
      if (confirmWrap) confirmWrap.style.display = '';
    } else {
      if (titleEl) titleEl.textContent = 'Iniciar sesión';
      submitEl.textContent = 'Ingresar';
      toggleEl.textContent = '¿No tienes cuenta? Crear cuenta';
      if (confirmWrap) confirmWrap.style.display = 'none';
    }
  });

  // Enter en campos → submit
  [emailEl, pwdEl, confirmEl].forEach(el => el?.addEventListener('keydown', e => {
    if (e.key === 'Enter') submitEl?.click();
  }));

  submitEl?.addEventListener('click', async () => {
    _err('auth-error', '');
    const email = emailEl?.value.trim();
    const pwd   = pwdEl?.value;
    if (!email || !pwd) { _err('auth-error', 'Ingresa tu correo y contraseña'); return; }

    if (_mode === 'register') {
      const confirm = confirmEl?.value;
      if (pwd.length < 8) { _err('auth-error', 'La contraseña debe tener al menos 8 caracteres'); return; }
      if (pwd !== confirm) { _err('auth-error', 'Las contraseñas no coinciden'); return; }

      submitEl.disabled = true;
      if (loadEl) loadEl.style.display = '';
      let keepDisabled = false;
      try {
        const data = await register(email, pwd);
        if (data.access_token) {
          const _tok = data.access_token;
          const _uid = data.user?.id;
          // 1. Crear/asegurar fila en profiles
          try {
            await fetch(`${REST}/profiles`, {
              method: 'POST',
              headers: { ..._hdrs(_tok), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify({ id: _uid, email, name: email.split('@')[0], platform_role: 'ninguno' }),
            });
          } catch {}
          // 2. Si no existe ningún propietario, asignar este usuario
          try {
            const existentes = await _restGet('profiles', { 'platform_role': 'eq.propietario', 'select': 'id' }, _tok);
            if (existentes.length === 0) {
              await fetch(`${REST}/profiles?id=eq.${_uid}`, {
                method: 'PATCH',
                headers: { ..._hdrs(_tok), 'Prefer': 'return=minimal' },
                body: JSON.stringify({ platform_role: 'propietario' }),
              });
            }
          } catch {}
          // 3. Intentar también vía RPC (si el SQL ya fue ejecutado)
          try { await _rpcPost('reclamar_propietario', {}, _tok); } catch {}
          // 4. Recargar perfil
          try {
            authState.perfil = await _loadPerfil(_tok, _uid);
            authState._notify();
          } catch {}
          _afterLogin();
        } else {
          // Supabase requiere confirmación de email
          _err('auth-error', '');
          const errEl = document.getElementById('auth-error');
          if (errEl) {
            errEl.style.background = '#f0fdf4';
            errEl.style.borderColor = '#86efac';
            errEl.style.color = '#15803d';
            errEl.textContent = 'Cuenta creada. Revisa tu correo para confirmar tu cuenta antes de iniciar sesión.';
            errEl.style.display = '';
          }
          keepDisabled = true;
        }
      } catch (e) {
        _err('auth-error', e.message || 'Error al crear cuenta');
      } finally {
        if (!keepDisabled) submitEl.disabled = false;
        if (loadEl) loadEl.style.display = 'none';
      }
      return;
    }

    submitEl.disabled = true;
    if (loadEl) loadEl.style.display = '';
    try {
      await login(email, pwd);
      _afterLogin();
    } catch (e) {
      _err('auth-error', e.message || 'Error al iniciar sesión');
    } finally {
      submitEl.disabled = false;
      if (loadEl) loadEl.style.display = 'none';
    }
  });

  // Cambiar contraseña
  dlg.querySelector('#auth-pwd-submit')?.addEventListener('click', async () => {
    _err('auth-pwd-error', '');
    const p1 = dlg.querySelector('#auth-newpwd')?.value;
    const p2 = dlg.querySelector('#auth-newpwd2')?.value;
    if (!p1 || p1.length < 8) { _err('auth-pwd-error', 'La contraseña debe tener al menos 8 caracteres'); return; }
    if (p1 !== p2) { _err('auth-pwd-error', 'Las contraseñas no coinciden'); return; }
    try {
      await cambiarPassword(p1);
      dlg.close();
    } catch (e) {
      _err('auth-pwd-error', e.message || 'Error al cambiar contraseña');
    }
  });
}

function _afterLogin() {
  const { empresas, mustChangePwd } = authState;

  if (mustChangePwd) {
    _show('auth-step-pwd');
    return;
  }

  if (empresas.length === 0) {
    // Propietario sin empresa aún: puede crear la primera desde el app
    if (authState.perfil?.platform_role === 'propietario') {
      _modalEl?.close();
      return;
    }
    // Sin empresas asignadas — mostrar mensaje
    const el = document.getElementById('auth-step-login');
    if (el) el.innerHTML += `<p style="margin-top:16px;color:#92400e;background:#fef3c7;border-radius:8px;padding:10px 14px;font-size:.85rem">
      Tu cuenta no está asignada a ninguna empresa. Contacta al administrador.
    </p>`;
    return;
  }

  if (empresas.length === 1) {
    seleccionarEmpresa(empresas[0].org_id);
    _modalEl?.close();
    return;
  }

  // Múltiples empresas → selección
  _show('auth-step-empresa');
  _renderEmpresaList();
}

function _renderEmpresaList() {
  const container = document.getElementById('auth-empresa-list');
  if (!container) return;
  container.innerHTML = '';
  authState.empresas.forEach(e => {
    const btn = document.createElement('button');
    btn.style.cssText = `
      display:flex;align-items:center;gap:12px;
      padding:12px 14px;border:1.5px solid var(--clr-border,#d1d5db);
      border-radius:10px;background:var(--clr-surface,#fff);
      cursor:pointer;text-align:left;width:100%;
      transition:border-color .15s,background .15s;
    `;
    const roleLabel = { super_admin:'Super Admin', relevo:'Relevo', miembro:'Miembro', invitado_externo:'Invitado' };
    btn.innerHTML = `
      <div style="width:36px;height:36px;border-radius:50%;background:var(--clr-accent-light,#ede9fe);display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0">🏢</div>
      <div>
        <div style="font-weight:600;font-size:.9rem;color:var(--clr-text,#111)">${_esc(e.org_name)}</div>
        <div style="font-size:.78rem;color:var(--clr-text-3,#666)">${roleLabel[e.empresa_role] || e.empresa_role}</div>
      </div>
    `;
    btn.addEventListener('mouseenter', () => { btn.style.borderColor = 'var(--clr-accent,#4f46e5)'; btn.style.background = 'var(--clr-surface-2,#f8f8ff)'; });
    btn.addEventListener('mouseleave', () => { btn.style.borderColor = 'var(--clr-border,#d1d5db)'; btn.style.background = 'var(--clr-surface,#fff)'; });
    btn.addEventListener('click', () => {
      seleccionarEmpresa(e.org_id);
      if (authState.mustChangePwd) { _show('auth-step-pwd'); return; }
      _modalEl?.close();
    });
    container.appendChild(btn);
  });
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
