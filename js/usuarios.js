// @ts-check
/**
 * usuarios.js — Gestión de usuarios y membresías de empresa.
 *
 * Expone:
 *   showUsuariosPanel()     — abre panel de administración de usuarios
 *   invitarUsuario(datos)   — invita un nuevo usuario a la empresa
 *   cambiarRolUsuario(...)  — cambia el rol de un miembro
 *   revocarAcceso(mem_id)   — desactiva un miembro
 *   asignarRelevo(mem_id)   — designa al relevo del super_admin
 */

import { authState } from './auth.js?v=181';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH = `${SUPABASE_URL}/auth/v1`;

function _hdrs(extra = {}) {
  const token = authState.session?.access_token;
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    ...(token ? { 'Authorization': `Bearer ${token}`, 'Prefer': 'return=representation' } : {}),
    ...extra,
  };
}

async function _get(tabla, filter) {
  const qs = new URLSearchParams({ select: '*', ...filter });
  const res = await fetch(`${REST}/${tabla}?${qs}`, { headers: _hdrs() });
  if (!res.ok) return [];
  return res.json().catch(() => []);
}

async function _patch(tabla, id, campos) {
  const res = await fetch(`${REST}/${tabla}?id=eq.${id}`, {
    method: 'PATCH',
    headers: _hdrs(),
    body: JSON.stringify(campos),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `HTTP ${res.status}`); }
  return res.json().catch(() => null);
}

async function _insert(tabla, row) {
  const res = await fetch(`${REST}/${tabla}`, {
    method: 'POST',
    headers: _hdrs(),
    body: JSON.stringify(row),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `HTTP ${res.status}`); }
  return res.json().catch(() => null);
}

// ============================================================
// Obtener lista de usuarios de la empresa actual
// ============================================================
export async function listarUsuarios() {
  const orgId = authState.empresaActual?.org_id;
  if (!orgId) return [];
  const rows = await _get('org_memberships', {
    'org_id': `eq.${orgId}`,
    'select': 'id,user_id,empresa_role,active,temp_password,expires_at,created_at,profiles(id,full_name,short_code,cargo,active)',
  });
  return rows;
}

// ============================================================
// Invitar usuario a la empresa (genera clave temporal)
// ============================================================
export async function invitarUsuario({ email, empresa_role = 'miembro', empresa_ext = null }) {
  const orgId = authState.empresaActual?.org_id;
  if (!orgId) throw new Error('Sin empresa seleccionada');

  // Generar clave temporal de 8 caracteres
  const tempPwd = _genTempPwd();

  // 1. Crear usuario en Supabase Auth (admin invite)
  //    Se usa el endpoint /auth/v1/admin/users (requiere service role)
  //    En su lugar, usamos signup con confirmación deshabilitada vía signUp
  const signupRes = await fetch(`${AUTH}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password: tempPwd }),
  });
  const signupData = await signupRes.json().catch(() => ({}));

  let userId = signupData?.user?.id || signupData?.id;

  // Si el usuario ya existe, buscar su perfil
  if (!userId) {
    const profs = await _get('profiles', { 'select': 'id', 'short_code': `ilike.%${email.split('@')[0]}%` });
    if (profs.length === 0) throw new Error(signupData?.message || signupData?.error_description || 'No se pudo crear el usuario');
    userId = profs[0].id;
  }

  // 2. Crear membresía en org_memberships
  const mem = await _insert('org_memberships', {
    org_id:       orgId,
    user_id:      userId,
    empresa_role,
    empresa_ext,
    active:       true,
    temp_password: tempPwd,
    invited_by:   authState.user?.id,
  });

  // 3. Registrar en auditoría
  await _auditoria('invitar_usuario', 'org_memberships', mem?.[0]?.id || userId, { email, empresa_role });

  return { ...mem?.[0], temp_password: tempPwd };
}

// ============================================================
// Cambiar rol de un usuario
// ============================================================
export async function cambiarRolUsuario(mem_id, nuevo_rol) {
  const ROLES_VALIDOS = ['super_admin','relevo','miembro','invitado_externo'];
  if (!ROLES_VALIDOS.includes(nuevo_rol)) throw new Error(`Rol inválido: ${nuevo_rol}`);
  const result = await _patch('org_memberships', mem_id, { empresa_role: nuevo_rol });
  await _auditoria('cambiar_rol', 'org_memberships', mem_id, { nuevo_rol });
  return result;
}

// ============================================================
// Revocar acceso (desactivar, no eliminar)
// ============================================================
export async function revocarAcceso(mem_id) {
  const result = await _patch('org_memberships', mem_id, { active: false });
  await _auditoria('revocar_acceso', 'org_memberships', mem_id, {});
  return result;
}

// ============================================================
// Reactivar acceso
// ============================================================
export async function reactivarAcceso(mem_id) {
  const result = await _patch('org_memberships', mem_id, { active: true });
  await _auditoria('reactivar_acceso', 'org_memberships', mem_id, {});
  return result;
}

// ============================================================
// Asignar relevo (solo puede haberlo uno por empresa)
// ============================================================
export async function asignarRelevo(nuevo_mem_id) {
  const orgId = authState.empresaActual?.org_id;
  if (!orgId) throw new Error('Sin empresa seleccionada');

  // Quitar relevo previo
  const actuales = await _get('org_memberships', {
    'org_id':       `eq.${orgId}`,
    'empresa_role': 'eq.relevo',
    'select':       'id',
  });
  for (const m of actuales) {
    await _patch('org_memberships', m.id, { empresa_role: 'miembro' });
  }

  // Asignar nuevo relevo
  await _patch('org_memberships', nuevo_mem_id, { empresa_role: 'relevo' });
  await _auditoria('asignar_relevo', 'org_memberships', nuevo_mem_id, {});
}

// ============================================================
// Regenerar clave temporal
// ============================================================
export async function regenerarClaveTemporal(mem_id) {
  const newPwd = _genTempPwd();
  await _patch('org_memberships', mem_id, { temp_password: newPwd });
  await _auditoria('regenerar_clave_temporal', 'org_memberships', mem_id, {});
  return newPwd;
}

// ============================================================
// Auditoría interna
// ============================================================
async function _auditoria(accion, tabla, registro_id, detalle) {
  const orgId = authState.empresaActual?.org_id;
  try {
    await _insert('auditoria', {
      org_id:      orgId,
      user_id:     authState.user?.id,
      accion,
      tabla,
      registro_id: String(registro_id),
      detalle,
    });
  } catch { /* no bloquear la operación principal si falla */ }
}

// ============================================================
// Generador de contraseña temporal
// ============================================================
function _genTempPwd() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let pwd = '';
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  arr.forEach(b => { pwd += chars[b % chars.length]; });
  return pwd;
}

// ============================================================
// Panel de administración de usuarios (UI)
// ============================================================
let _panelEl = null;

export async function showUsuariosPanel() {
  const rol        = authState.empresaActual?.empresa_role;
  const platRol    = authState.perfil?.platform_role || '';
  const sinEmpresa = authState.empresas.length === 0;
  const esAdmin    = ['super_admin','relevo'].includes(rol)
    || ['propietario','co_propietario'].includes(platRol)
    || sinEmpresa;
  if (!esAdmin) {
    alert('Solo el Super Admin o Relevo pueden gestionar usuarios.');
    return;
  }
  if (sinEmpresa) {
    alert('Primero debes crear tu empresa. Usa "Configurar empresa" en el menú.');
    return;
  }

  if (!_panelEl) {
    _panelEl = document.createElement('div');
    _panelEl.id = 'panel-usuarios';
    _panelEl.setAttribute('role', 'dialog');
    _panelEl.setAttribute('aria-modal', 'true');
    _panelEl.setAttribute('aria-label', 'Administración de usuarios');
    _panelEl.style.cssText = 'display:none;position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.4)';
    document.body.appendChild(_panelEl);
  }

  await _renderUsuariosPanel();
  _panelEl.style.display = '';
}

async function _renderUsuariosPanel() {
  if (!_panelEl) return;
  const empresa = authState.empresaActual;

  let rows = [];
  let loadErr = '';
  try { rows = await listarUsuarios(); } catch (e) { loadErr = e.message; }

  const rolLabel = { super_admin:'Super Admin', relevo:'Relevo', miembro:'Miembro', invitado_externo:'Invitado ext.' };

  _panelEl.innerHTML = `
<div style="
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  background:var(--clr-surface,#fff);border-radius:16px;
  width:min(740px,95vw);max-height:90vh;overflow:hidden;
  display:flex;flex-direction:column;
  box-shadow:0 8px 40px rgba(0,0,0,.22);
  font-family:var(--font-ui,system-ui);
">
  <!-- Header -->
  <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--clr-border,#e2e8f0)">
    <div>
      <h2 style="margin:0;font-size:1.1rem;font-weight:700;color:var(--clr-text,#111)">Usuarios — ${_esc(empresa?.org_name)}</h2>
      <p style="margin:2px 0 0;font-size:.8rem;color:var(--clr-text-3,#666)">Gestión de acceso a la empresa</p>
    </div>
    <div style="display:flex;gap:8px;align-items:center">
      <button id="usp-btn-invite" style="padding:7px 14px;background:var(--clr-accent,#4f46e5);color:#fff;border:none;border-radius:8px;font-size:.85rem;font-weight:600;cursor:pointer">+ Invitar usuario</button>
      <button id="usp-btn-close" style="padding:7px 12px;background:none;border:1.5px solid var(--clr-border,#d1d5db);border-radius:8px;font-size:.85rem;cursor:pointer;color:var(--clr-text,#111)">✕</button>
    </div>
  </div>

  <!-- Body -->
  <div style="overflow-y:auto;padding:16px 24px;flex:1">
    ${loadErr ? `<p style="color:#b91c1c">${_esc(loadErr)}</p>` : ''}
    ${rows.length === 0 && !loadErr ? '<p style="color:var(--clr-text-3,#666);font-size:.88rem">No hay usuarios aún. Invita al primero.</p>' : ''}
    ${rows.map(r => {
      const p = r.profiles || {};
      const nombre = p.full_name || '(sin nombre)';
      const activo = r.active !== false;
      const tieneTemp = !!r.temp_password;
      return `
<div data-mem-id="${r.id}" style="
  display:flex;align-items:center;gap:12px;
  padding:12px 14px;border:1px solid var(--clr-border,#e2e8f0);
  border-radius:10px;margin-bottom:8px;
  opacity:${activo?1:.5};
">
  <div style="width:36px;height:36px;border-radius:50%;background:var(--clr-accent-light,#ede9fe);display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0">
    ${nombre.charAt(0).toUpperCase()}
  </div>
  <div style="flex:1;min-width:0">
    <div style="font-weight:600;font-size:.88rem;color:var(--clr-text,#111)">${_esc(nombre)}</div>
    <div style="font-size:.77rem;color:var(--clr-text-3,#666);display:flex;gap:8px;flex-wrap:wrap">
      <span>${rolLabel[r.empresa_role] || r.empresa_role}</span>
      ${tieneTemp ? '<span style="color:#92400e;background:#fef3c7;border-radius:4px;padding:1px 5px">clave temporal</span>' : ''}
      ${!activo ? '<span style="color:#7f1d1d;background:#fee2e2;border-radius:4px;padding:1px 5px">inactivo</span>' : ''}
    </div>
  </div>
  <div class="usp-actions" style="display:flex;gap:6px;flex-shrink:0">
    ${authState.empresaActual?.empresa_role === 'super_admin' ? `
      <button data-action="rol" data-mem="${r.id}" title="Cambiar rol"
        style="padding:4px 9px;border:1px solid var(--clr-border,#d1d5db);border-radius:6px;background:none;font-size:.78rem;cursor:pointer;color:var(--clr-text-2,#444)">Rol</button>
      ${tieneTemp ? `<button data-action="tempwd" data-mem="${r.id}" title="Ver/regenerar clave temporal"
        style="padding:4px 9px;border:1px solid #fbbf24;border-radius:6px;background:none;font-size:.78rem;cursor:pointer;color:#92400e">🔑 Clave</button>` : ''}
      ${activo
        ? `<button data-action="revocar" data-mem="${r.id}"
            style="padding:4px 9px;border:1px solid #fca5a5;border-radius:6px;background:none;font-size:.78rem;cursor:pointer;color:#b91c1c">Revocar</button>`
        : `<button data-action="reactivar" data-mem="${r.id}"
            style="padding:4px 9px;border:1px solid #86efac;border-radius:6px;background:none;font-size:.78rem;cursor:pointer;color:#15803d">Reactivar</button>`
      }
    ` : ''}
  </div>
</div>`;
    }).join('')}
  </div>

  <!-- Form invitar (hidden) -->
  <div id="usp-invite-form" style="display:none;padding:16px 24px;border-top:1px solid var(--clr-border,#e2e8f0)">
    <h3 style="margin:0 0 14px;font-size:.95rem;font-weight:700;color:var(--clr-text,#111)">Invitar nuevo usuario</h3>
    <div id="usp-invite-msg" role="alert" style="display:none;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.84rem"></div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div style="flex:2;min-width:180px">
        <label style="display:block;font-size:.8rem;font-weight:600;color:var(--clr-text-2,#444);margin-bottom:3px">Correo electrónico</label>
        <input id="usp-inv-email" type="email" placeholder="usuario@empresa.com"
          style="width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:7px;font-size:.87rem;background:var(--clr-input-bg,#f9fafb);color:var(--clr-text,#111)">
      </div>
      <div style="flex:1;min-width:130px">
        <label style="display:block;font-size:.8rem;font-weight:600;color:var(--clr-text-2,#444);margin-bottom:3px">Rol</label>
        <select id="usp-inv-rol"
          style="width:100%;box-sizing:border-box;padding:8px 10px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:7px;font-size:.87rem;background:var(--clr-input-bg,#f9fafb);color:var(--clr-text,#111)">
          <option value="miembro">Miembro</option>
          <option value="relevo">Relevo</option>
          <option value="invitado_externo">Invitado externo</option>
        </select>
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button id="usp-inv-submit" style="padding:8px 18px;background:var(--clr-accent,#4f46e5);color:#fff;border:none;border-radius:7px;font-size:.87rem;font-weight:600;cursor:pointer">Crear usuario</button>
      <button id="usp-inv-cancel" style="padding:8px 14px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:7px;background:none;font-size:.87rem;cursor:pointer;color:var(--clr-text,#111)">Cancelar</button>
    </div>
  </div>
</div>`;

  // Eventos
  _panelEl.querySelector('#usp-btn-close')?.addEventListener('click', () => { _panelEl.style.display = 'none'; });
  _panelEl.querySelector('#usp-btn-invite')?.addEventListener('click', () => {
    const form = _panelEl.querySelector('#usp-invite-form');
    if (form) form.style.display = form.style.display === 'none' ? '' : 'none';
  });
  _panelEl.querySelector('#usp-inv-cancel')?.addEventListener('click', () => {
    const form = _panelEl.querySelector('#usp-invite-form');
    if (form) form.style.display = 'none';
  });
  _panelEl.querySelector('#usp-inv-submit')?.addEventListener('click', async () => {
    const msgEl = _panelEl.querySelector('#usp-invite-msg');
    const email = _panelEl.querySelector('#usp-inv-email')?.value.trim();
    const rol   = _panelEl.querySelector('#usp-inv-rol')?.value;
    if (!email) { _showMsg(msgEl, 'error', 'Ingresa el correo electrónico'); return; }
    _showMsg(msgEl, 'info', 'Creando usuario…');
    try {
      const result = await invitarUsuario({ email, empresa_role: rol });
      const tempPwd = result.temp_password;
      _showMsg(msgEl, 'success',
        `Usuario creado. Clave temporal: <strong style="font-family:monospace">${_esc(tempPwd)}</strong> — entregala al usuario de forma segura.`
      );
      setTimeout(() => _renderUsuariosPanel(), 2000);
    } catch (e) {
      _showMsg(msgEl, 'error', e.message);
    }
  });

  // Acciones en filas
  _panelEl.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const memId  = btn.dataset.mem;
      if (action === 'revocar') {
        if (!confirm('¿Revocar el acceso de este usuario?')) return;
        try { await revocarAcceso(memId); await _renderUsuariosPanel(); } catch (e) { alert(e.message); }
      }
      if (action === 'reactivar') {
        try { await reactivarAcceso(memId); await _renderUsuariosPanel(); } catch (e) { alert(e.message); }
      }
      if (action === 'rol') {
        const nuevo = prompt('Nuevo rol (super_admin / relevo / miembro / invitado_externo):');
        if (!nuevo) return;
        try { await cambiarRolUsuario(memId, nuevo.trim()); await _renderUsuariosPanel(); } catch (e) { alert(e.message); }
      }
      if (action === 'tempwd') {
        if (!confirm('¿Regenerar la clave temporal de este usuario?')) return;
        try {
          const pwd = await regenerarClaveTemporal(memId);
          alert(`Nueva clave temporal: ${pwd}\nEntregala al usuario de forma segura.`);
          await _renderUsuariosPanel();
        } catch (e) { alert(e.message); }
      }
    });
  });
}

function _showMsg(el, tipo, html) {
  if (!el) return;
  const styles = {
    error:   'background:#fef2f2;border:1px solid #fca5a5;color:#b91c1c',
    success: 'background:#f0fdf4;border:1px solid #86efac;color:#15803d',
    info:    'background:#eff6ff;border:1px solid #93c5fd;color:#1d4ed8',
  };
  el.style.cssText = `border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:.84rem;${styles[tipo]||styles.info}`;
  el.innerHTML = html;
  el.style.display = '';
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
