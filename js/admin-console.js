// @ts-check
/**
 * admin-console.js — Consola única de Administración de ECM Project.
 *
 * Patrón de las plataformas de obra con más recorrido (Procore, Revizto, ACC):
 *   - Selector de alcance arriba:  Plataforma › Empresa ▾ › Proyecto ▾
 *   - Menú lateral según el alcance elegido
 *   - Cada página: título, descripción, acción principal arriba a la derecha
 *     y tabla con búsqueda y filtros.
 *
 * Expone:
 *   showAdminConsole()              — abre la consola a pantalla completa
 *   updateAdminSectionVisibility()  — muestra/oculta la entrada del explorador
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { authState, recargarEmpresas } from './auth.js?v=194';
import { getAll, put } from './storage.js';
import { TREE as REPORTS_TREE } from './reports.js';

const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH = `${SUPABASE_URL}/auth/v1`;

const ADMIN_ROLES = ['super_admin', 'relevo'];

const MODULOS = [
  { key: 'cronograma',  label: 'Cronograma / EDT / Gantt' },
  { key: 'calendarios', label: 'Calendarios / Recursos' },
  { key: 'lineas_base', label: 'Líneas base' },
  { key: 'lookahead',   label: 'Lookahead / LPS' },
  { key: 'evm',         label: 'EVM / Curva S' },
  { key: 'riesgos',     label: 'Riesgos / MC / DCMA' },
  { key: 'reportes',    label: 'Reportes PDF' },
];
const NIVELES = [
  ['editar', 'Editar'], ['solo_avance', 'Solo avance'], ['solo_ver', 'Solo ver'], ['sin_acceso', 'Sin acceso'],
];
const NIVEL_LABEL = Object.fromEntries(NIVELES);

const ROL_EMP = {
  super_admin: 'Super admin', relevo: 'Relevo', miembro: 'Miembro',
  invitado_externo: 'Invitado externo', pendiente: 'Pendiente',
};
const ROL_PLAT = { propietario: 'Propietario', co_propietario: 'Co-propietario' };
const ROL_GRUPO = { administrador: 'Administrador', miembro: 'Miembro' };
const ESTADO_ORG = { active: ['Activa', 'ok'], suspended: ['Suspendida', 'warn'], deleted: ['Eliminada', 'err'] };

// ============================================================
// Acceso a datos (REST de Supabase con el token del usuario)
// ============================================================
function _hdrs(extra = {}) {
  const tok = authState.session?.access_token;
  return {
    'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY,
    ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...extra,
  };
}

async function _req(method, path, body, prefer = 'return=representation') {
  const res = await fetch(`${REST}/${path}`, {
    method,
    headers: _hdrs(method === 'GET' ? {} : { Prefer: prefer }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(_traducirError(e.message || e.hint || `HTTP ${res.status}`));
  }
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}

function _traducirError(msg) {
  if (/row-level security/i.test(msg)) return 'No tienes permiso para esta acción en esta empresa.';
  if (/duplicate key/i.test(msg)) return 'Ya existe un registro con esos datos.';
  return msg;
}

const _qs    = (p) => new URLSearchParams(p).toString();
const _get   = (t, p = {}) => _req('GET', `${t}?${_qs({ select: '*', ...p })}`).then(r => r || []);
const _post  = (t, row) => _req('POST', t, row);
const _del   = (t, filtro) => _req('DELETE', `${t}?${_qs(filtro)}`, undefined, 'return=minimal');
const _rpc   = (fn, args) => _req('POST', `rpc/${fn}`, args);

/** PATCH que falla si las reglas de acceso no dejaron cambiar ninguna fila. */
async function _patch(t, filtro, campos) {
  const rows = await _req('PATCH', `${t}?${_qs(filtro)}`, campos);
  if (Array.isArray(rows) && rows.length === 0) throw new Error('No tienes permiso para esta acción en esta empresa.');
  return rows;
}

async function _perfiles(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = await _get('profiles', { id: `in.(${uniq.join(',')})`, select: 'id,full_name,email,platform_role' });
  return new Map(rows.map(p => [p.id, p]));
}

async function _audit(orgId, accion, tabla, registroId, detalle = {}) {
  try {
    await _post('auditoria', {
      org_id: orgId || null, user_id: authState.user?.id, accion, tabla,
      registro_id: String(registroId ?? ''), detalle,
    });
  } catch { /* la auditoría nunca bloquea la operación principal */ }
}

// ============================================================
// Roles del usuario actual
// ============================================================
const _esPropietario = () => ['propietario', 'co_propietario'].includes(authState.perfil?.platform_role || '');
const _esTitular     = () => authState.perfil?.platform_role === 'propietario';
const _rolEn = (orgId) => authState.empresas.find(e => e.org_id === orgId)?.empresa_role || '';
const _adminDe = (orgId) => _esPropietario() || ADMIN_ROLES.includes(_rolEn(orgId));

export function updateAdminSectionVisibility() {
  const section = document.getElementById('admin-section');
  if (!section) return;
  const visible = !!authState.user && (
    _esPropietario() ||
    authState.empresas.some(e => ADMIN_ROLES.includes(e.empresa_role)) ||
    authState.empresas.length === 0
  );
  section.style.display = visible ? '' : 'none';
}

// ============================================================
// Formato
// ============================================================
function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _fecha(d, conHora = false) {
  if (!d) return '—';
  const f = new Date(d);
  if (isNaN(f.getTime())) return '—';
  const s = f.toLocaleDateString('es-PE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  return conHora ? `${s} ${f.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })}` : s;
}
const _short = (id) => String(id || '').slice(0, 8);
const _badge = (txt, tono = 'neutral') => `<span class="adm-badge adm-badge-${tono}">${_esc(txt)}</span>`;
const _nombre = (p) => p?.full_name || p?.email?.split('@')[0] || '—';
function _persona(p, fallbackId = '') {
  const n = p ? _nombre(p) : `Usuario ${_short(fallbackId)}`;
  const ini = n.trim().split(/\s+/).map(w => w[0] || '').slice(0, 2).join('').toUpperCase() || '?';
  return `<div class="adm-person"><span class="adm-avatar">${_esc(ini)}</span><div><div class="adm-strong">${_esc(n)}</div>${p?.email ? `<div class="adm-sub">${_esc(p.email)}</div>` : ''}</div></div>`;
}
function _btn(label, act, id, { tono = '', title = '', disabled = false } = {}) {
  return `<button type="button" class="adm-btn adm-btn-sm ${tono ? `adm-btn-${tono}` : ''}" data-act="${act}" data-id="${_esc(id)}" ${title ? `title="${_esc(title)}"` : ''} ${disabled ? 'disabled' : ''}>${_esc(label)}</button>`;
}
function _select(act, id, opciones, valor, { aria = '', disabled = false } = {}) {
  return `<select class="adm-in adm-in-sm" data-act-change="${act}" data-id="${_esc(id)}" aria-label="${_esc(aria)}" ${disabled ? 'disabled' : ''}>${
    opciones.map(([v, l]) => `<option value="${_esc(v)}" ${v === valor ? 'selected' : ''}>${_esc(l)}</option>`).join('')}</select>`;
}

// ============================================================
// Estado de la consola
// ============================================================
const S = {
  /** @type {'plataforma'|'empresa'|'proyecto'} */
  scope: 'empresa',
  page: 'resumen',
  orgId: '',
  projId: '',
  /** @type {any[]} */ orgs: [],
  /** @type {any[]} */ projs: [],
  /** @type {Record<string, (id:string, el:any)=>any>} */ acts: {},
  sel: new Set(),
};
/** @type {HTMLElement|null} */
let _root = null;
/** true si se crearon o editaron proyectos: el explorador debe refrescarse al cerrar. */
let _cambios = false;

const NAV = {
  plataforma: [
    ['resumen', 'Resumen', '📊'], ['empresas', 'Empresas', '🏢'], ['usuarios', 'Usuarios', '👥'],
    ['proyectos', 'Estructura de todas las empresas', '🌳'],
    ['propietarios', 'Propietarios', '👑'], ['auditoria', 'Auditoría', '🧾'], ['reportes', 'Reportes', '📑'],
  ],
  empresa: [
    ['resumen', 'Resumen', '📊'], ['usuarios', 'Usuarios', '👥'], ['proyectos', 'Estructura y proyectos', '🌳'],
    ['areas', 'Áreas', '🧩'], ['plantilla', 'Plantilla de permisos', '🔐'],
    ['auditoria', 'Auditoría', '🧾'], ['datos', 'Datos de la empresa', '📝'], ['reportes', 'Reportes', '📑'],
  ],
  proyecto: [
    ['miembros', 'Miembros', '👥'], ['permisos', 'Permisos del proyecto', '🔐'], ['externos', 'Invitados externos', '🤝'],
  ],
};

function _guardarEstado() {
  try { localStorage.setItem('ecm_admin_console', JSON.stringify({ scope: S.scope, page: S.page, orgId: S.orgId, projId: S.projId })); } catch {}
}
function _leerEstado() {
  try { return JSON.parse(localStorage.getItem('ecm_admin_console') || 'null'); } catch { return null; }
}

// ============================================================
// Apertura y estructura
// ============================================================
export async function showAdminConsole() {
  if (!authState.user) return;
  _injectCss();
  _root?.remove();
  _root = document.createElement('div');
  _root.id = 'admin-console';
  _root.setAttribute('role', 'dialog');
  _root.setAttribute('aria-modal', 'true');
  _root.setAttribute('aria-label', 'Administración');
  _root.innerHTML = `
    <header class="adm-top">
      <div class="adm-brand">⚙ Administración</div>
      <nav class="adm-scope" aria-label="Alcance"></nav>
      <button type="button" class="adm-close" data-close aria-label="Cerrar administración" title="Cerrar (Esc)">✕</button>
    </header>
    <div class="adm-shell">
      <aside class="adm-nav" aria-label="Secciones"></aside>
      <main class="adm-main" tabindex="-1"></main>
    </div>
    <div class="adm-toast" role="status" aria-live="polite"></div>`;
  document.body.appendChild(_root);
  document.body.style.overflow = 'hidden';

  _root.querySelector('[data-close]')?.addEventListener('click', _cerrar);
  _root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !_root?.querySelector('dialog[open]')) _cerrar();
  });
  // Delegación de acciones de las páginas
  _root.querySelector('.adm-main')?.addEventListener('click', (e) => {
    const t = /** @type {HTMLElement} */ (e.target);
    const b = /** @type {HTMLElement|null} */ (t.closest('[data-act]'));
    if (b && !b.hasAttribute('disabled')) S.acts[b.dataset.act || '']?.(b.dataset.id || '', b);
  });
  _root.querySelector('.adm-main')?.addEventListener('change', (e) => {
    const s = /** @type {HTMLSelectElement} */ (e.target);
    if (s.dataset?.actChange) S.acts[s.dataset.actChange]?.(s.dataset.id || '', s);
  });

  await _cargarOrgs();
  const prev = _leerEstado();
  const orgValida = (id) => S.orgs.some(o => o.id === id);
  S.orgId = orgValida(prev?.orgId) ? prev.orgId
    : (orgValida(authState.empresaActual?.org_id) ? authState.empresaActual.org_id : (S.orgs[0]?.id || ''));
  S.scope = prev?.scope && (prev.scope !== 'plataforma' || _esPropietario()) ? prev.scope : (_esPropietario() ? 'plataforma' : 'empresa');
  S.page = prev?.page || NAV[S.scope][0][0];
  await _cargarProyectos();
  S.projId = S.projs.some(p => p.id === prev?.projId) ? prev.projId : '';
  if (S.scope === 'proyecto' && !S.projId) { S.scope = 'empresa'; S.page = 'proyectos'; }
  await _ir(S.scope, S.page);
}

function _cerrar() {
  _root?.remove();
  _root = null;
  document.body.style.overflow = '';
  if (_cambios) window.dispatchEvent(new CustomEvent('ecm:proyectos-cambiados'));
  _cambios = false;
}

async function _cargarOrgs() {
  if (_esPropietario()) {
    S.orgs = await _get('organizations', { deleted_at: 'is.null', select: 'id,name,slug,status,created_at', order: 'created_at.asc' }).catch(() => []);
  } else {
    S.orgs = authState.empresas
      .filter(e => ADMIN_ROLES.includes(e.empresa_role))
      .map(e => ({ id: e.org_id, name: e.org_name, slug: e.org_slug, status: e.org_status }));
  }
}

async function _cargarProyectos() {
  S.projs = S.orgId
    ? await _get('projects', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id,code,name,status,start_date', order: 'name.asc' }).catch(() => [])
    : [];
}

/** Nombre de empresa que distingue duplicados (fecha y código corto). */
function _orgLabel(o) {
  const repetida = S.orgs.filter(x => (x.name || '').trim().toLowerCase() === (o.name || '').trim().toLowerCase()).length > 1;
  return repetida ? `${o.name} · ${_fecha(o.created_at, true)} · ${_short(o.id)}` : o.name;
}

async function _ir(scope, page) {
  S.scope = scope;
  S.page = NAV[scope].some(([k]) => k === page) ? page : NAV[scope][0][0];
  S.sel.clear();
  _guardarEstado();
  _renderScope();
  _renderNav();
  await _renderPage();
}

function _renderScope() {
  const el = _root?.querySelector('.adm-scope');
  if (!el) return;
  const org = S.orgs.find(o => o.id === S.orgId);
  el.innerHTML = `
    ${_esPropietario() ? `<button type="button" class="adm-crumb ${S.scope === 'plataforma' ? 'is-active' : ''}" data-scope="plataforma">Plataforma</button><span class="adm-sep">›</span>` : ''}
    <label class="adm-crumb-sel ${S.scope === 'empresa' ? 'is-active' : ''}">
      <span class="adm-crumb-k">Empresa</span>
      <select data-scope-org aria-label="Empresa">
        ${S.orgs.length ? '' : '<option value="">Sin empresas</option>'}
        ${S.orgs.map(o => `<option value="${_esc(o.id)}" ${o.id === S.orgId ? 'selected' : ''}>${_esc(_orgLabel(o))}</option>`).join('')}
      </select>
    </label>
    <span class="adm-sep">›</span>
    <label class="adm-crumb-sel ${S.scope === 'proyecto' ? 'is-active' : ''}">
      <span class="adm-crumb-k">Proyecto</span>
      <select data-scope-proj aria-label="Proyecto" ${org ? '' : 'disabled'}>
        <option value="">${S.projs.length ? 'Elegir proyecto…' : 'Sin proyectos'}</option>
        ${S.projs.map(p => `<option value="${_esc(p.id)}" ${p.id === S.projId && S.scope === 'proyecto' ? 'selected' : ''}>${_esc(p.code ? `${p.code} · ${p.name}` : p.name)}</option>`).join('')}
      </select>
    </label>`;
  el.querySelector('[data-scope="plataforma"]')?.addEventListener('click', () => _ir('plataforma', 'resumen'));
  el.querySelector('[data-scope-org]')?.addEventListener('change', async (e) => {
    S.orgId = /** @type {HTMLSelectElement} */ (e.target).value;
    S.projId = '';
    await _cargarProyectos();
    await _ir('empresa', 'resumen');
  });
  el.querySelector('[data-scope-proj]')?.addEventListener('change', async (e) => {
    S.projId = /** @type {HTMLSelectElement} */ (e.target).value;
    if (S.projId) await _ir('proyecto', 'miembros');
    else await _ir('empresa', 'proyectos');
  });
}

function _renderNav() {
  const el = _root?.querySelector('.adm-nav');
  if (!el) return;
  const titulo = { plataforma: 'Plataforma', empresa: 'Empresa', proyecto: 'Proyecto' }[S.scope];
  el.innerHTML = `<div class="adm-nav-title">${titulo}</div>` + NAV[S.scope].map(([k, l, ico]) =>
    `<button type="button" class="adm-nav-item ${k === S.page ? 'is-active' : ''}" data-page="${k}" ${k === S.page ? 'aria-current="page"' : ''}><span aria-hidden="true">${ico}</span>${_esc(l)}</button>`).join('');
  el.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click', () => _ir(S.scope, /** @type {HTMLElement} */ (b).dataset.page || '')));
}

async function _renderPage() {
  const main = /** @type {HTMLElement|null} */ (_root?.querySelector('.adm-main'));
  if (!main) return;
  S.acts = {};
  main.innerHTML = '<div class="adm-loading">Cargando…</div>';
  const fn = PAGES[S.scope]?.[S.page];
  try {
    if ((S.scope === 'empresa' || S.scope === 'proyecto') && !S.orgId) { _sinEmpresa(main); return; }
    if (S.scope === 'proyecto' && !S.projId) { await _ir('empresa', 'proyectos'); return; }
    await fn(main);
  } catch (e) {
    main.innerHTML = `<div class="adm-alert adm-alert-err">No se pudo cargar esta página: ${_esc(/** @type {Error} */ (e).message)}</div>`;
  }
  main.focus({ preventScroll: true });
}

// ============================================================
// Piezas de página
// ============================================================
/**
 * Cabecera de página + contenedor del cuerpo.
 * @param {HTMLElement} main
 * @param {{title:string, desc:string, actions?:{label:string, act:string, primary?:boolean, danger?:boolean, disabled?:boolean, title?:string}[]}} cfg
 */
function _pagina(main, { title, desc, actions = [] }) {
  main.innerHTML = `
    <div class="adm-page-head">
      <div><h1 class="adm-h1">${_esc(title)}</h1><p class="adm-desc">${desc}</p></div>
      <div class="adm-page-actions">${actions.map(a =>
        `<button type="button" class="adm-btn ${a.primary ? 'adm-btn-primary' : ''} ${a.danger ? 'adm-btn-danger' : ''}" data-act="${a.act}" ${a.disabled ? 'disabled' : ''} ${a.title ? `title="${_esc(a.title)}"` : ''}>${_esc(a.label)}</button>`).join('')}</div>
    </div>
    <div class="adm-page-body"></div>`;
  return /** @type {HTMLElement} */ (main.querySelector('.adm-page-body'));
}

function _kpis(items) {
  return `<div class="adm-kpis">${items.map(([v, l, tono]) =>
    `<div class="adm-kpi ${tono ? `adm-kpi-${tono}` : ''}"><div class="adm-kpi-v">${_esc(v)}</div><div class="adm-kpi-l">${_esc(l)}</div></div>`).join('')}</div>`;
}

/**
 * Tabla con búsqueda, filtros y selección opcional.
 * @param {HTMLElement} el
 * @param {{columns:{label:string, html:(r:any)=>string, cls?:string}[], rows:any[], empty:string,
 *          search?:(r:any)=>string, filters?:{label:string, options:[string,string][], get:(r:any)=>string, value?:string}[],
 *          selectable?:boolean, rowId?:(r:any)=>string, onSelect?:()=>void}} cfg
 */
function _tabla(el, cfg) {
  const filtros = cfg.filters || [];
  const fState = filtros.map(f => f.value || '');
  let q = '';
  let visibles = cfg.rows;
  el.innerHTML = `
    <div class="adm-toolbar">
      ${cfg.search ? '<input class="adm-in adm-search" type="search" placeholder="Buscar…" aria-label="Buscar">' : ''}
      ${filtros.map((f, i) => `<select class="adm-in adm-filter" data-f="${i}" aria-label="${_esc(f.label)}">
        <option value="">${_esc(f.label)}: todos</option>
        ${f.options.map(([v, l]) => `<option value="${_esc(v)}" ${fState[i] === v ? 'selected' : ''}>${_esc(l)}</option>`).join('')}
      </select>`).join('')}
      <span class="adm-count"></span>
    </div>
    <div class="adm-table-wrap"><table class="adm-table"><thead><tr>
      ${cfg.selectable ? '<th class="adm-chk"><input type="checkbox" data-selall aria-label="Seleccionar todo"></th>' : ''}
      ${cfg.columns.map(c => `<th class="${c.cls || ''}">${_esc(c.label)}</th>`).join('')}
    </tr></thead><tbody></tbody></table></div>`;
  const tbody = /** @type {HTMLElement} */ (el.querySelector('tbody'));
  const count = /** @type {HTMLElement} */ (el.querySelector('.adm-count'));
  const id = (r) => cfg.rowId ? cfg.rowId(r) : r.id;
  const draw = () => {
    visibles = cfg.rows.filter(r =>
      (!q || (cfg.search?.(r) || '').toLowerCase().includes(q)) &&
      filtros.every((f, i) => !fState[i] || f.get(r) === fState[i]));
    tbody.innerHTML = visibles.length
      ? visibles.map(r => `<tr class="${S.sel.has(id(r)) ? 'is-sel' : ''}">
          ${cfg.selectable ? `<td class="adm-chk"><input type="checkbox" data-sel="${_esc(id(r))}" ${S.sel.has(id(r)) ? 'checked' : ''} aria-label="Seleccionar fila"></td>` : ''}
          ${cfg.columns.map(c => `<td class="${c.cls || ''}">${c.html(r)}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${cfg.columns.length + (cfg.selectable ? 1 : 0)}" class="adm-empty">${_esc(cfg.empty)}</td></tr>`;
    count.textContent = `${visibles.length} de ${cfg.rows.length}`;
    const all = /** @type {HTMLInputElement|null} */ (el.querySelector('[data-selall]'));
    if (all) all.checked = visibles.length > 0 && visibles.every(r => S.sel.has(id(r)));
  };
  el.querySelector('.adm-search')?.addEventListener('input', (e) => { q = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase(); draw(); });
  el.querySelectorAll('.adm-filter').forEach(s => s.addEventListener('change', () => {
    const sel = /** @type {HTMLSelectElement} */ (s);
    fState[Number(sel.dataset.f)] = sel.value; draw();
  }));
  if (cfg.selectable) {
    el.addEventListener('change', (e) => {
      const t = /** @type {HTMLInputElement} */ (e.target);
      if (t.dataset.sel !== undefined) { t.checked ? S.sel.add(t.dataset.sel) : S.sel.delete(t.dataset.sel); }
      else if (t.hasAttribute('data-selall')) { visibles.forEach(r => t.checked ? S.sel.add(id(r)) : S.sel.delete(id(r))); }
      else return;
      draw();
      cfg.onSelect?.();
    });
  }
  draw();
}

function _toast(msg, tono = 'ok') {
  const t = /** @type {HTMLElement|null} */ (_root?.querySelector('.adm-toast'));
  if (!t) return;
  t.textContent = msg;
  t.className = `adm-toast is-show adm-toast-${tono}`;
  clearTimeout(Number(t.dataset.timer));
  t.dataset.timer = String(setTimeout(() => { t.className = 'adm-toast'; }, 3500));
}

/**
 * Ventana de formulario / confirmación. Resuelve con el valor que devuelve onSubmit, o null si se cancela.
 * @param {{title:string, desc?:string, html?:string, fields?:any[], submit?:string, danger?:boolean,
 *          confirmWord?:string, cancel?:string|null, onSubmit?:(vals:Record<string,string>)=>Promise<any>}} cfg
 */
function _modal({ title, desc = '', html = '', fields = [], submit = 'Guardar', danger = false, confirmWord = '', cancel = 'Cancelar', onSubmit }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'adm-dlg';
    dlg.innerHTML = `<form method="dialog" class="adm-dlg-body" novalidate>
      <h2 class="adm-h2">${_esc(title)}</h2>
      ${desc ? `<p class="adm-desc">${desc}</p>` : ''}
      ${html}
      ${fields.map(_campo).join('')}
      ${confirmWord ? `<label class="adm-lbl" for="adm-confirm">Para confirmar escribe <b>${_esc(confirmWord)}</b></label>
        <input id="adm-confirm" class="adm-in" data-confirm autocomplete="off" spellcheck="false">` : ''}
      <div class="adm-alert adm-alert-err" data-err hidden></div>
      <div class="adm-dlg-actions">
        ${cancel ? `<button type="button" class="adm-btn" data-cancel>${_esc(cancel)}</button>` : ''}
        <button type="submit" class="adm-btn ${danger ? 'adm-btn-danger' : 'adm-btn-primary'}" ${confirmWord ? 'disabled' : ''}>${_esc(submit)}</button>
      </div>
    </form>`;
    (_root || document.body).appendChild(dlg);
    const form = /** @type {HTMLFormElement} */ (dlg.querySelector('form'));
    const errEl = /** @type {HTMLElement} */ (dlg.querySelector('[data-err]'));
    const okBtn = /** @type {HTMLButtonElement} */ (dlg.querySelector('button[type=submit]'));
    let done = false;
    const fin = (v) => { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(v); };
    dlg.querySelector('[data-cancel]')?.addEventListener('click', () => fin(null));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); fin(null); });
    const conf = /** @type {HTMLInputElement|null} */ (dlg.querySelector('[data-confirm]'));
    conf?.addEventListener('input', () => { okBtn.disabled = conf.value.trim() !== confirmWord; });
    // Campos que aparecen según otro campo (p. ej. empresa externa)
    const sync = () => dlg.querySelectorAll('[data-show-key]').forEach(w => {
      const wEl = /** @type {HTMLElement} */ (w);
      const src = /** @type {HTMLInputElement|null} */ (dlg.querySelector(`[data-k="${wEl.dataset.showKey}"]`));
      wEl.hidden = !src || src.value !== wEl.dataset.showVal;
    });
    dlg.addEventListener('change', sync);
    sync();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      /** @type {Record<string,string>} */
      const vals = {};
      for (const f of fields) {
        const inp = /** @type {HTMLInputElement|null} */ (dlg.querySelector(`[data-k="${f.key}"]`));
        const wrap = inp?.closest('[data-show-key]');
        if (!inp || (wrap && /** @type {HTMLElement} */ (wrap).hidden)) continue;
        vals[f.key] = inp.value.trim();
        if (f.required && !vals[f.key]) { _err(`Completa el campo «${f.label}».`); inp.focus(); return; }
        if (f.type === 'email' && vals[f.key] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(vals[f.key])) { _err('El correo no es válido.'); inp.focus(); return; }
      }
      if (!onSubmit) { fin(vals); return; }
      okBtn.disabled = true;
      const txt = okBtn.textContent;
      okBtn.textContent = 'Procesando…';
      try { fin(await onSubmit(vals) ?? true); }
      catch (ex) { _err(/** @type {Error} */ (ex).message || 'Error'); okBtn.disabled = false; okBtn.textContent = txt; }
    });
    function _err(m) { errEl.textContent = m; errEl.hidden = false; }
    dlg.showModal();
    /** @type {HTMLElement|null} */ (dlg.querySelector('input:not([type=hidden]),select,textarea'))?.focus();
  });
}

function _campo(f) {
  const id = `adm-f-${f.key}`;
  const attrs = `id="${id}" data-k="${f.key}" class="adm-in" ${f.required ? 'required' : ''} ${f.readonly ? 'readonly' : ''}`;
  let ctrl;
  if (f.type === 'select') {
    ctrl = `<select ${attrs}>${(f.options || []).map(([v, l]) => `<option value="${_esc(v)}" ${v === f.value ? 'selected' : ''}>${_esc(l)}</option>`).join('')}</select>`;
  } else {
    ctrl = `<input ${attrs} type="${f.type || 'text'}" value="${_esc(f.value || '')}" placeholder="${_esc(f.placeholder || '')}" autocomplete="off">`;
  }
  const show = f.showIf ? `data-show-key="${f.showIf[0]}" data-show-val="${_esc(f.showIf[1])}"` : '';
  return `<div class="adm-field" ${show}><label class="adm-lbl" for="${id}">${_esc(f.label)}</label>${ctrl}${f.hint ? `<div class="adm-hint">${f.hint}</div>` : ''}</div>`;
}

function _sinEmpresa(main) {
  const body = _pagina(main, {
    title: 'Aún no tienes una empresa',
    desc: 'Crea tu empresa para invitar a tu equipo, crear proyectos y definir permisos por área.',
    actions: [{ label: '+ Crear empresa', act: 'crear', primary: true }],
  });
  body.innerHTML = '<div class="adm-emptybox">🏢<br>La empresa se crea con las 11 áreas estándar y su plantilla de permisos.</div>';
  S.acts.crear = () => _crearEmpresa();
}

async function _crearEmpresa() {
  const id = await _modal({
    title: 'Nueva empresa',
    desc: 'Se crea con las 11 áreas estándar y su plantilla de permisos. Tú quedas como su super admin.',
    fields: [{ key: 'name', label: 'Nombre de la empresa', placeholder: 'Ej: Constructora Pérez SAC', required: true }],
    submit: 'Crear empresa',
    onSubmit: async ({ name }) => {
      if (S.orgs.some(o => (o.name || '').trim().toLowerCase() === name.toLowerCase())) {
        throw new Error('Ya existe una empresa con ese nombre. Usa otro nombre o administra la existente.');
      }
      const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
      const nuevo = await _rpc('crear_empresa', { p_name: name, p_slug: slug, p_owner_id: authState.user?.id });
      await _audit(nuevo, 'crear_empresa', 'organizations', nuevo, { name });
      return nuevo;
    },
  });
  if (!id) return;
  await recargarEmpresas();
  await _cargarOrgs();
  S.orgId = String(id);
  await _cargarProyectos();
  _toast('Empresa creada');
  await _ir('empresa', 'resumen');
}

// ============================================================
// PLATAFORMA
// ============================================================

async function _platUsuarios(main) {
  const body = _pagina(main, {
    title: 'Usuarios',
    desc: 'Todos los usuarios con acceso a la plataforma y sus membresías activas.',
  });
  body.innerHTML = '<div style="padding:32px;color:var(--clr-text-3)">Cargando…</div>';
  try {
    const [mems, profs, orgs] = await Promise.all([
      _get('org_memberships', { select: 'id,user_id,org_id,empresa_role,active,created_at', order: 'created_at.desc' }),
      _get('profiles', { select: 'id,full_name,email' }),
      _get('organizations', { deleted_at: 'is.null', select: 'id,name' }),
    ]);
    const pm = new Map(profs.map(p => [p.id, p]));
    const om = new Map(orgs.map(o => [o.id, o.name]));
    const rows = mems.map(m => ({
      ...m,
      _nombre: _nombre(pm.get(m.user_id)),
      _email: pm.get(m.user_id)?.email || '',
      _empresa: om.get(m.org_id) || '—',
      _rol: ROL_EMP[m.empresa_role] || m.empresa_role || '—',
      _perfil: pm.get(m.user_id),
    }));
    _tabla(body, {
      rows,
      columns: [
        { label: 'Usuario', html: r => _persona(r._perfil || { full_name: r._nombre, email: r._email }, r.user_id) },
        { label: 'Empresa', html: r => `<span style="font-size:12px">${_esc(r._empresa)}</span>` },
        { label: 'Rol', html: r => _badge(r._rol, r.empresa_role === 'super_admin' ? 'ok' : r.empresa_role === 'relevo' ? 'warn' : '') },
        { label: 'Estado', html: r => _badge(r.active ? 'Activo' : 'Revocado', r.active ? 'ok' : 'err') },
        { label: 'Desde', html: r => `<span style="font-size:11px;color:var(--clr-text-3)">${_esc(_fecha(r.created_at))}</span>` },
      ],
      search: r => `${r._nombre} ${r._email} ${r._empresa}`,
      filters: [
        { label: 'Empresa', options: [['', 'Todas las empresas'], ...orgs.map(o => [o.id, o.name])], get: r => r.org_id },
        { label: 'Rol', options: [['', 'Todos los roles'], ...Object.entries(ROL_EMP).map(([k, v]) => [k, v])], get: r => r.empresa_role },
        { label: 'Estado', options: [['', 'Todos'], ['true', 'Activo'], ['false', 'Revocado']], get: r => String(r.active) },
      ],
      empty: 'No hay usuarios registrados en la plataforma.',
    });
  } catch (e) {
    body.innerHTML = `<p style="padding:24px;color:var(--clr-err)">Error: ${_esc(e?.message || String(e))}</p>`;
  }
}

async function _platResumen(main) {
  const [orgs, perfiles, proys, aud] = await Promise.all([
    _get('organizations', { deleted_at: 'is.null', select: 'id,name,status' }),
    _get('profiles', { select: 'id' }),
    _get('projects', { deleted_at: 'is.null', select: 'id' }),
    _get('auditoria', { select: 'id,org_id,user_id,accion,created_at', order: 'created_at.desc', limit: '8' }).catch(() => []),
  ]);
  const nombres = new Map();
  orgs.forEach(o => { const k = (o.name || '').trim().toLowerCase(); nombres.set(k, (nombres.get(k) || 0) + 1); });
  const dups = orgs.filter(o => nombres.get((o.name || '').trim().toLowerCase()) > 1).length;
  const body = _pagina(main, {
    title: 'Resumen de la plataforma',
    desc: 'Vista general de todas las empresas que usan ECM Project.',
    actions: [{ label: 'Ver empresas', act: 'empresas', primary: true }],
  });
  S.acts.empresas = () => _ir('plataforma', 'empresas');
  S.acts.dups = () => _ir('plataforma', 'empresas');
  body.innerHTML = _kpis([
    [orgs.filter(o => o.status !== 'suspended').length, 'Empresas activas'],
    [orgs.filter(o => o.status === 'suspended').length, 'Suspendidas', 'warn'],
    [perfiles.length, 'Usuarios registrados'],
    [proys.length, 'Proyectos'],
  ]) + (dups ? `<div class="adm-alert adm-alert-warn">Hay <b>${dups}</b> empresas con nombre repetido. <button type="button" class="adm-link" data-act="dups">Revisar y eliminar las que no necesitas →</button></div>` : '')
    + '<h2 class="adm-h2">Actividad reciente</h2><div data-aud></div>';
  const pm = await _perfiles(aud.map(a => a.user_id));
  const om = new Map(orgs.map(o => [o.id, o.name]));
  _tabla(/** @type {HTMLElement} */ (body.querySelector('[data-aud]')), {
    rows: aud, empty: 'Sin actividad registrada todavía.',
    columns: [
      { label: 'Fecha', html: a => _esc(_fecha(a.created_at, true)), cls: 'adm-nowrap' },
      { label: 'Usuario', html: a => _esc(_nombre(pm.get(a.user_id))) },
      { label: 'Empresa', html: a => _esc(om.get(a.org_id) || '—') },
      { label: 'Acción', html: a => _esc(_accion(a.accion)) },
    ],
  });
}

async function _platEmpresas(main) {
  const [orgs, mems, proys] = await Promise.all([
    _get('organizations', { deleted_at: 'is.null', select: 'id,name,slug,status,created_at', order: 'created_at.asc' }),
    _get('org_memberships', { select: 'org_id,user_id,empresa_role,active' }),
    _get('projects', { deleted_at: 'is.null', select: 'id,org_id' }),
  ]);
  const pm = await _perfiles(mems.filter(m => m.empresa_role === 'super_admin').map(m => m.user_id));
  const nombres = new Map();
  orgs.forEach(o => { const k = (o.name || '').trim().toLowerCase(); nombres.set(k, (nombres.get(k) || 0) + 1); });
  const rows = orgs.map(o => ({
    ...o,
    dup: nombres.get((o.name || '').trim().toLowerCase()) > 1,
    usuarios: mems.filter(m => m.org_id === o.id && m.active).length,
    proyectos: proys.filter(p => p.org_id === o.id).length,
    admins: mems.filter(m => m.org_id === o.id && m.empresa_role === 'super_admin' && m.active).map(m => _nombre(pm.get(m.user_id))),
    actual: o.id === authState.empresaActual?.org_id,
  }));
  const body = _pagina(main, {
    title: 'Empresas',
    desc: 'Todas las empresas de la plataforma. Cada empresa es independiente: sus usuarios, proyectos y permisos no se mezclan.',
    actions: [
      { label: 'Eliminar seleccionadas', act: 'bulkdel', danger: true, disabled: true },
      { label: '+ Nueva empresa', act: 'nueva', primary: true },
    ],
  });
  const bulkBtn = /** @type {HTMLButtonElement} */ (main.querySelector('[data-act="bulkdel"]'));
  const syncBulk = () => {
    bulkBtn.disabled = S.sel.size === 0;
    bulkBtn.textContent = S.sel.size ? `Eliminar seleccionadas (${S.sel.size})` : 'Eliminar seleccionadas';
  };
  _tabla(body, {
    rows, empty: 'No hay empresas.', selectable: true, onSelect: syncBulk,
    search: o => `${o.name} ${o.slug} ${o.id} ${o.admins.join(' ')}`,
    filters: [
      { label: 'Estado', options: [['active', 'Activa'], ['suspended', 'Suspendida']], get: o => o.status || 'active' },
      { label: 'Nombre', options: [['dup', 'Solo repetidas']], get: o => o.dup ? 'dup' : '' },
    ],
    columns: [
      { label: 'Empresa', html: o => `<div class="adm-strong">${_esc(o.name)} ${o.dup ? _badge('Repetida', 'warn') : ''} ${o.actual ? _badge('En uso ahora', 'info') : ''}</div><div class="adm-sub">Código ${_esc(_short(o.id))}</div>` },
      { label: 'Super admin', html: o => `<div class="adm-cellact">${o.admins.length ? `<span>${_esc(o.admins.join(', '))}</span>` : _badge('Sin asignar', 'warn')}
          ${_btn(o.admins.length ? 'Cambiar' : 'Asignar', 'superadmin', o.id, { tono: o.admins.length ? '' : 'primary-soft' })}</div>` },
      { label: 'Usuarios', html: o => `<div class="adm-cellact"><span>${o.usuarios}</span>${_btn('Gestionar', 'usuarios', o.id)}</div>` },
      { label: 'Proyectos', html: o => String(o.proyectos), cls: 'adm-num' },
      { label: 'Estado', html: o => _badge(...(ESTADO_ORG[o.status] || ESTADO_ORG.active)) },
      { label: 'Creada', html: o => _esc(_fecha(o.created_at, true)), cls: 'adm-nowrap' },
      { label: '', cls: 'adm-actions', html: o => [
        _btn('Abrir', 'abrir', o.id),
        o.status === 'suspended' ? _btn('Reactivar', 'reactivar', o.id) : _btn('Suspender', 'suspender', o.id),
        _btn('Eliminar', 'eliminar', o.id, { tono: 'danger' }),
      ].join('') },
    ],
  });
  syncBulk();
  const byId = (id) => rows.find(o => o.id === id);
  S.acts.nueva = () => _crearEmpresa();
  S.acts.superadmin = async (id) => { if (await _asignarSuperAdmin(byId(id))) await _renderPage(); };
  S.acts.usuarios = async (id) => { await _gestionarUsuariosEmpresa(byId(id)); await _renderPage(); };
  S.acts.abrir = async (id) => { S.orgId = id; S.projId = ''; await _cargarProyectos(); await _ir('empresa', 'resumen'); };
  S.acts.suspender = async (id) => {
    const o = byId(id);
    const ok = await _modal({
      title: `Suspender «${o.name}»`,
      desc: 'Sus usuarios dejarán de poder entrar a esta empresa hasta que la reactives. No se borra nada.',
      submit: 'Suspender', danger: true,
      onSubmit: async () => { await _patch('organizations', { id: `eq.${id}` }, { status: 'suspended' }); await _audit(id, 'suspender_empresa', 'organizations', id); },
    });
    if (ok) { _toast('Empresa suspendida'); await _renderPage(); }
  };
  S.acts.reactivar = async (id) => {
    await _patch('organizations', { id: `eq.${id}` }, { status: 'active' });
    await _audit(id, 'reactivar_empresa', 'organizations', id);
    _toast('Empresa reactivada');
    await _renderPage();
  };
  S.acts.eliminar = (id) => _eliminarEmpresas([byId(id)]);
  S.acts.bulkdel = () => _eliminarEmpresas(rows.filter(o => S.sel.has(o.id)));
}

/** Eliminación con doble confirmación. Es lógica (se marca como eliminada): se puede recuperar desde Supabase. */
async function _eliminarEmpresas(lista) {
  if (!lista.length) return;
  const una = lista.length === 1;
  const proys = lista.reduce((s, o) => s + o.proyectos, 0);
  const usuarios = lista.reduce((s, o) => s + o.usuarios, 0);
  const incluyeActual = lista.some(o => o.actual);
  const detalle = `<ul class="adm-list">${lista.map(o => `<li><b>${_esc(o.name)}</b> <span class="adm-sub">· ${_esc(_fecha(o.created_at, true))} · código ${_esc(_short(o.id))} · ${o.proyectos} proyecto(s) · ${o.usuarios} usuario(s)</span></li>`).join('')}</ul>`;
  // Paso 1: revisar qué se va a eliminar
  const paso1 = await _modal({
    title: una ? `¿Eliminar «${lista[0].name}»?` : `¿Eliminar ${lista.length} empresas?`,
    desc: 'Revisa la lista. La empresa desaparece para todos sus usuarios, junto con el acceso a sus proyectos.',
    html: detalle
      + (proys ? `<div class="adm-alert adm-alert-warn">Atención: ${proys} proyecto(s) quedarán ocultos con la empresa.</div>` : '')
      + (incluyeActual ? '<div class="adm-alert adm-alert-warn">Incluye la empresa que estás usando ahora; la app se recargará.</div>' : ''),
    submit: 'Continuar', danger: true,
  });
  if (!paso1) return;
  // Paso 2: confirmación escrita
  const palabra = una ? lista[0].name.trim() : 'ELIMINAR';
  const ok = await _modal({
    title: 'Confirmación final',
    desc: `Vas a eliminar ${una ? 'esta empresa' : `${lista.length} empresas`}${usuarios ? ` con ${usuarios} usuario(s)` : ''}. Si te equivocas, se puede recuperar desde Supabase.`,
    confirmWord: palabra, submit: una ? 'Eliminar empresa' : `Eliminar ${lista.length} empresas`, danger: true,
    onSubmit: async () => {
      const ids = lista.map(o => o.id);
      await _patch('organizations', { id: `in.(${ids.join(',')})` }, { deleted_at: new Date().toISOString(), status: 'deleted' });
      for (const o of lista) await _audit(o.id, 'eliminar_empresa', 'organizations', o.id, { name: o.name });
    },
  });
  if (!ok) return;
  S.sel.clear();
  if (incluyeActual) { window.location.reload(); return; }
  await recargarEmpresas();
  await _cargarOrgs();
  if (!S.orgs.some(o => o.id === S.orgId)) { S.orgId = S.orgs[0]?.id || ''; await _cargarProyectos(); _renderScope(); }
  _toast(una ? 'Empresa eliminada' : `${lista.length} empresas eliminadas`);
  await _renderPage();
}

/**
 * Panel de gestión de usuarios asignados a una empresa (desde la vista Plataforma > Empresas).
 * @param {{id:string, name:string}} org
 * @returns {Promise<void>}
 */
async function _gestionarUsuariosEmpresa(org) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'adm-dlg';
    dlg.style.cssText = 'width:min(720px,95vw)';
    dlg.innerHTML = `<div class="adm-dlg-body" style="display:flex;flex-direction:column;gap:12px">
      <h2 class="adm-h2">Usuarios de «${_esc(org.name)}»</h2>
      <p class="adm-desc">Miembros activos de esta empresa. Puedes agregar nuevos usuarios o revocar accesos.</p>
      <div id="gue-list" style="max-height:340px;overflow-y:auto"></div>
      <div style="display:flex;gap:8px;margin-top:4px">
        <button type="button" class="adm-btn adm-btn-primary" id="gue-add">+ Agregar usuario</button>
        <button type="button" class="adm-btn" id="gue-close" style="margin-left:auto">Cerrar</button>
      </div>
    </div>`;
    document.body.appendChild(dlg);
    dlg.showModal();

    const listEl = /** @type {HTMLElement} */ (dlg.querySelector('#gue-list'));

    const renderLista = async () => {
      listEl.innerHTML = '<p style="color:#9ca3af;font-size:13px;padding:8px 0">Cargando…</p>';
      const mems = await _get('org_memberships', { org_id: `eq.${org.id}`, active: 'eq.true', select: 'id,user_id,empresa_role,created_at', order: 'created_at.asc' }).catch(() => []);
      const pm = await _perfiles(mems.map(m => m.user_id));
      const rows = mems.map(m => ({ ...m, perfil: pm.get(m.user_id) }));
      if (!rows.length) {
        listEl.innerHTML = '<p style="color:#6b7280;font-size:13px;padding:8px 0">Sin miembros activos.</p>';
        return;
      }
      listEl.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr>
          <th style="text-align:left;padding:5px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-weight:600">Nombre</th>
          <th style="text-align:left;padding:5px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-weight:600">Correo</th>
          <th style="text-align:left;padding:5px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-weight:600">Rol</th>
          <th style="text-align:left;padding:5px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280;font-weight:600">Desde</th>
          <th style="padding:5px 8px;border-bottom:1px solid #e5e7eb"></th>
        </tr></thead>
        <tbody>${rows.map(m => `<tr class="gue-row" data-id="${_esc(m.id)}" data-name="${_esc(_nombre(m.perfil))}">
          <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;font-weight:500">${_esc(_nombre(m.perfil))}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;color:#6b7280">${_esc(m.perfil?.email || '—')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6">${_esc(ROL_EMP[m.empresa_role] || m.empresa_role || '—')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;color:#9ca3af">${_esc(_fecha(m.created_at))}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #f3f4f6"><button type="button" class="adm-btn adm-btn-danger-soft adm-btn-xs gue-quitar">Quitar</button></td>
        </tr>`).join('')}</tbody></table>`;
      listEl.querySelectorAll('.gue-quitar').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row = /** @type {HTMLElement} */ (btn.closest('.gue-row'));
          const memId = row.dataset.id || '';
          const nombre = row.dataset.name || 'usuario';
          const ok = await _modal({
            title: `Quitar acceso a ${nombre}`,
            desc: `Se revocará el acceso de ${_esc(nombre)} a «${_esc(org.name)}». No se borra su cuenta.`,
            submit: 'Quitar acceso', danger: true,
            onSubmit: async () => {
              await _patch('org_memberships', { id: `eq.${memId}` }, { active: false });
              await _audit(org.id, 'revocar_acceso', 'org_memberships', memId);
            },
          });
          if (ok !== null) await renderLista();
        });
      });
    };

    renderLista();

    dlg.querySelector('#gue-add')?.addEventListener('click', async () => {
      const savedOrgId = S.orgId;
      S.orgId = org.id;
      await _invitar({ rol: 'miembro' });
      S.orgId = savedOrgId;
      await renderLista();
    });

    const _cerrar = () => { dlg.remove(); resolve(); };
    dlg.querySelector('#gue-close')?.addEventListener('click', _cerrar);
    dlg.addEventListener('cancel', _cerrar);
  });
}

/**
 * Asigna (o cambia) el super admin de una empresa: una persona con cuenta o una invitación por correo.
 * @param {{id:string, name:string}} org
 */
async function _asignarSuperAdmin(org) {
  const [mems, perfiles] = await Promise.all([
    _get('org_memberships', { org_id: `eq.${org.id}`, select: 'id,user_id,empresa_role,active' }),
    _get('profiles', { select: 'id,full_name,email', order: 'full_name.asc' }),
  ]);
  const actuales = mems.filter(m => m.empresa_role === 'super_admin' && m.active);
  const pm = new Map(perfiles.map(p => [p.id, p]));
  const yo = authState.user?.id;
  const opciones = [
    ['', 'Elegir…'],
    ...perfiles.filter(p => !actuales.some(a => a.user_id === p.id))
      .map(p => [p.id, `${p.id === yo ? 'Yo · ' : ''}${_nombre(p)}${p.email ? ` (${p.email})` : ''}`]),
    ['__email', '+ Invitar por correo a alguien nuevo…'],
  ];
  const res = await _modal({
    title: `Super admin de «${org.name}»`,
    desc: 'El super admin administra toda la empresa: usuarios, proyectos, áreas y permisos.'
      + (actuales.length ? `<br>Actual: <b>${_esc(actuales.map(a => _nombre(pm.get(a.user_id))).join(', '))}</b>` : ''),
    fields: [
      { key: 'user', label: 'Persona', type: 'select', required: true, options: opciones },
      { key: 'email', label: 'Correo de la persona', type: 'email', placeholder: 'nombre@empresa.com', showIf: ['user', '__email'], required: true },
      ...(actuales.length ? [{ key: 'modo', label: '¿Qué pasa con el super admin actual?', type: 'select', value: 'agregar',
        options: [['agregar', 'Se mantiene (habrá más de un super admin)'], ['reemplazar', 'Pasa a ser miembro (reemplazar)']] }] : []),
    ],
    submit: 'Asignar super admin',
    onSubmit: async ({ user, email, modo }) => {
      let userId = user;
      let pwd = null;
      if (user === '__email') {
        const inv = await _invitarPersona(email, { rol: 'super_admin', orgId: org.id, siYaEsMiembro: 'reusar' });
        userId = inv.user_id; pwd = inv.pwd;
      }
      const mem = mems.find(m => m.user_id === userId);
      if (user !== '__email') {
        if (mem) await _patch('org_memberships', { id: `eq.${mem.id}` }, { empresa_role: 'super_admin', active: true });
        else await _post('org_memberships', { org_id: org.id, user_id: userId, empresa_role: 'super_admin', active: true, invited_by: yo });
      }
      if (modo === 'reemplazar') {
        for (const a of actuales.filter(a => a.user_id !== userId)) await _patch('org_memberships', { id: `eq.${a.id}` }, { empresa_role: 'miembro' });
      }
      await _audit(org.id, 'asignar_super_admin', 'org_memberships', userId, { empresa: org.name, persona: _nombre(pm.get(userId)) || email });
      return { pwd };
    },
  });
  if (!res) return false;
  if (res.pwd) await _mostrarClave('', res.pwd);
  _toast('Super admin asignado');
  await recargarEmpresas();
  return true;
}

// ============================================================
// ESTRUCTURA: Empresa › Portafolio › Programa › Proyecto
// Misma información que el lienzo «Estructura de Proyectos» (ambos leen la nube).
// ============================================================
const TIPO = {
  org:  { label: 'Empresa',    ico: '🏢', tono: 'neutral' },
  pf:   { label: 'Portafolio', ico: '📁', tono: 'info' },
  prog: { label: 'Programa',   ico: '🗂', tono: 'violet' },
  proj: { label: 'Proyecto',   ico: '📋', tono: 'ok' },
};
const _progDe = (p) => p.program_id || p.settings?.program_id || null;
const _pfDe = (p, programas) => {
  const prog = programas.find(g => g.id === _progDe(p));
  return prog?.portfolio_id || p.settings?.portfolio_id || null;
};

/** Carga portafolios, programas, proyectos y administradores (de una empresa o de todas). */
async function _cargarEstructura(orgId) {
  const f = (extra) => ({ deleted_at: 'is.null', ...(orgId ? { org_id: `eq.${orgId}` } : {}), ...extra });
  const [pfs, progs, proys, gms] = await Promise.all([
    _get('portfolios', f({ select: 'id,org_id,name,code,description,settings,created_at', order: 'name.asc' })),
    _get('programs', f({ select: 'id,org_id,portfolio_id,name,code,description,settings,created_at', order: 'name.asc' })),
    _get('projects', f({ select: 'id,org_id,program_id,code,name,description,status,start_date,settings', order: 'name.asc' })),
    _get('group_memberships', { ...(orgId ? { org_id: `eq.${orgId}` } : {}), group_role: 'eq.administrador', select: 'project_id,user_id' }).catch(() => []),
  ]);
  const orgs = new Set(S.orgs.map(o => o.id));
  const dentro = (r) => orgs.has(r.org_id);
  const pm = await _perfiles(gms.map(g => g.user_id));
  return { pfs: pfs.filter(dentro), progs: progs.filter(dentro), proys: proys.filter(dentro), gms, pm };
}

/** Guarda (crea o edita) un portafolio o programa. */
async function _guardarNodo(tipo, datos, orgIdFijo) {
  const esPf = tipo === 'pf';
  const nuevo = !datos?.id;
  const orgId = datos?.org_id || orgIdFijo;
  const pfsOrg = orgId ? await _get('portfolios', { org_id: `eq.${orgId}`, deleted_at: 'is.null', select: 'id,name,code', order: 'name.asc' }) : [];
  const orgs = S.orgs.filter(o => o.status !== 'suspended');
  const res = await _modal({
    title: `${nuevo ? 'Nuevo' : 'Editar'} ${esPf ? 'portafolio' : 'programa'}`,
    desc: esPf ? 'Un portafolio agrupa programas y proyectos de una línea de negocio (p. ej. Edificaciones).'
      : 'Un programa agrupa proyectos relacionados dentro de un portafolio.',
    fields: [
      ...(orgId ? [] : [{ key: 'org', label: 'Empresa', type: 'select', required: true, options: [['', 'Elegir…'], ...orgs.map(o => [o.id, _orgLabel(o)])] }]),
      { key: 'name', label: 'Nombre', required: true, value: datos?.name || '' },
      { key: 'code', label: 'Código', value: datos?.code || '', placeholder: esPf ? 'Ej: P01' : 'Ej: Pg01' },
      { key: 'desc', label: 'Descripción', value: datos?.description || '' },
      ...(!esPf && orgId ? [{ key: 'pf', label: 'Portafolio', type: 'select', value: datos?.portfolio_id || '',
        options: [['', '(Ninguno, cuelga de la empresa)'], ...pfsOrg.map(p => [p.id, `${p.code ? p.code + ' · ' : ''}${p.name}`])] }] : []),
    ],
    submit: nuevo ? 'Crear' : 'Guardar',
    onSubmit: async ({ org, name, code, desc, pf }) => {
      const tabla = esPf ? 'portfolios' : 'programs';
      const fila = { name, code: code || null, description: desc || null, updated_at: new Date().toISOString(), ...(!esPf ? { portfolio_id: pf || null } : {}) };
      const oid = orgId || org;
      if (nuevo) {
        const [r] = await _post(tabla, { id: crypto.randomUUID(), org_id: oid, settings: {}, ...fila });
        await _audit(oid, esPf ? 'crear_portafolio' : 'crear_programa', tabla, r.id, { nombre: name });
      } else {
        await _patch(tabla, { id: `eq.${datos.id}` }, fila);
        await _audit(oid, esPf ? 'editar_portafolio' : 'editar_programa', tabla, datos.id, { nombre: name });
      }
      return true;
    },
  });
  if (res) { _cambios = true; _toast(nuevo ? 'Creado' : 'Guardado'); }
  return !!res;
}

/** Elimina (lógicamente) un portafolio o programa; sus hijos quedan colgando del nivel superior. */
async function _eliminarNodo(tipo, nodo, est) {
  const esPf = tipo === 'pf';
  const hijosProg = esPf ? est.progs.filter(g => g.portfolio_id === nodo.id) : [];
  const hijosProj = est.proys.filter(p => esPf ? (p.settings?.portfolio_id === nodo.id && !_progDe(p)) : _progDe(p) === nodo.id);
  const ok = await _modal({
    title: `Eliminar ${esPf ? 'el portafolio' : 'el programa'} «${nodo.name}»`,
    desc: (hijosProg.length || hijosProj.length)
      ? `Sus ${hijosProg.length ? `${hijosProg.length} programa(s) y ` : ''}${hijosProj.length} proyecto(s) <b>no se borran</b>: pasan a colgar del nivel superior.`
      : 'No tiene programas ni proyectos.',
    submit: 'Eliminar', danger: true,
    onSubmit: async () => {
      const now = new Date().toISOString();
      for (const g of hijosProg) await _patch('programs', { id: `eq.${g.id}` }, { portfolio_id: null, updated_at: now });
      for (const p of hijosProj) {
        const settings = { ...(p.settings || {}), ...(esPf ? { portfolio_id: null } : { program_id: null, portfolio_id: nodo.portfolio_id || null }) };
        await _patch('projects', { id: `eq.${p.id}` }, { settings, ...(esPf ? {} : { program_id: null }), updated_at: now });
      }
      await _patch(esPf ? 'portfolios' : 'programs', { id: `eq.${nodo.id}` }, { deleted_at: now, updated_at: now });
      await _audit(nodo.org_id, esPf ? 'eliminar_portafolio' : 'eliminar_programa', esPf ? 'portfolios' : 'programs', nodo.id, { nombre: nodo.name });
    },
  });
  if (ok) { _cambios = true; _toast('Eliminado'); }
  return !!ok;
}

/** Campos de ubicación (portafolio y programa) de un proyecto dentro de su empresa. */
async function _camposUbicacion(orgId, actual = {}) {
  const [pfs, progs] = await Promise.all([
    _get('portfolios', { org_id: `eq.${orgId}`, deleted_at: 'is.null', select: 'id,name,code', order: 'name.asc' }),
    _get('programs', { org_id: `eq.${orgId}`, deleted_at: 'is.null', select: 'id,name,code,portfolio_id', order: 'name.asc' }),
  ]);
  const lbl = (x) => `${x.code ? x.code + ' · ' : ''}${x.name}`;
  return {
    progs,
    fields: [
      { key: 'pf', label: 'Portafolio', type: 'select', value: actual.pf || '', options: [['', '(Ninguno)'], ...pfs.map(p => [p.id, lbl(p)])] },
      { key: 'prog', label: 'Programa', type: 'select', value: actual.prog || '', options: [['', '(Ninguno)'], ...progs.map(g => [g.id, lbl(g)])],
        hint: 'Si eliges un programa, el proyecto queda en el portafolio de ese programa.' },
    ],
  };
}
const _ubicacion = (progs, pf, prog) => {
  const g = progs.find(x => x.id === prog);
  return { program_id: prog || null, portfolio_id: g ? (g.portfolio_id || null) : (pf || null) };
};

/** Crea un proyecto en una empresa (opcionalmente dentro de un portafolio/programa) y le asigna administrador. */
async function _crearProyecto(orgIdFijo = '', ubic = {}) {
  const orgs = S.orgs.filter(o => o.status !== 'suspended');
  if (!orgs.length) { _toast('Primero crea una empresa', 'err'); return null; }
  let orgId = orgIdFijo;
  if (!orgId) {
    const r = await _modal({
      title: 'Nuevo proyecto', desc: '¿En qué empresa?',
      fields: [{ key: 'org', label: 'Empresa', type: 'select', required: true, options: [['', 'Elegir…'], ...orgs.map(o => [o.id, _orgLabel(o)])] }],
      submit: 'Continuar',
    });
    if (!r) return null;
    orgId = r.org;
  }
  const [mems, ub] = await Promise.all([
    _get('org_memberships', { org_id: `eq.${orgId}`, active: 'eq.true', select: 'user_id' }),
    _camposUbicacion(orgId, ubic),
  ]);
  const pm = await _perfiles(mems.map(m => m.user_id));
  const res = await _modal({
    title: 'Nuevo proyecto',
    desc: `En <b>${_esc(S.orgs.find(o => o.id === orgId)?.name || '')}</b>. Queda en la nube y aparece en el explorador y en la Estructura de Proyectos de sus miembros.`,
    fields: [
      { key: 'name', label: 'Nombre del proyecto', required: true, placeholder: 'Ej: Edificio Residencial Las Palmas' },
      { key: 'code', label: 'Código (opcional)', placeholder: 'Ej: LP-2026' },
      { key: 'start', label: 'Fecha de inicio', type: 'date', value: new Date().toISOString().slice(0, 10), required: true },
      ...ub.fields,
      { key: 'admin', label: 'Administrador del proyecto', type: 'select',
        options: [['', 'Asignar después'], ...mems.map(m => [m.user_id, _nombre(pm.get(m.user_id))])] },
    ],
    submit: 'Crear proyecto',
    onSubmit: async ({ name, code, start, pf, prog, admin }) => {
      const u = _ubicacion(ub.progs, pf, prog);
      const [p] = await _post('projects', {
        id: crypto.randomUUID(), org_id: orgId, name, code: code || null, start_date: start,
        status: 'active', is_template: false, program_id: u.program_id, settings: u,
      });
      if (admin) await _post('group_memberships', { org_id: orgId, project_id: p.id, user_id: admin, group_role: 'administrador' });
      await _audit(orgId, 'crear_proyecto', 'projects', p.id, { proyecto: name });
      return p;
    },
  });
  if (!res) return null;
  if (res.org_id === S.orgId) await _cargarProyectos();
  _cambios = true;
  _toast('Proyecto creado');
  return res;
}

/**
 * Asigna el administrador de un proyecto entre los usuarios de su empresa (o invitando a alguien nuevo).
 * @param {{id:string, org_id:string, name:string}} proy
 */
async function _asignarAdminProyecto(proy) {
  const [mems, gms, areas] = await Promise.all([
    _get('org_memberships', { org_id: `eq.${proy.org_id}`, active: 'eq.true', select: 'user_id,empresa_role' }),
    _get('group_memberships', { project_id: `eq.${proy.id}`, select: 'id,user_id,group_role,area_id' }),
    _get('areas', { org_id: `eq.${proy.org_id}`, deleted_at: 'is.null', select: 'id,name', order: 'sort_order.asc' }),
  ]);
  const pm = await _perfiles([...mems.map(m => m.user_id), ...gms.map(g => g.user_id)]);
  const actuales = gms.filter(g => g.group_role === 'administrador');
  const res = await _modal({
    title: `Administrador de «${proy.name}»`,
    desc: 'El administrador gestiona el proyecto: su equipo, su cronograma y sus permisos.'
      + (actuales.length ? `<br>Actual: <b>${_esc(actuales.map(a => _nombre(pm.get(a.user_id))).join(', '))}</b>` : ''),
    fields: [
      { key: 'user', label: 'Persona', type: 'select', required: true, options: [
        ['', 'Elegir…'],
        ...mems.filter(m => !actuales.some(a => a.user_id === m.user_id)).map(m => [m.user_id, `${_nombre(pm.get(m.user_id))} · ${ROL_EMP[m.empresa_role] || ''}`]),
        ['__email', '+ Invitar por correo a alguien nuevo…'],
      ] },
      { key: 'email', label: 'Correo de la persona', type: 'email', placeholder: 'nombre@empresa.com', showIf: ['user', '__email'], required: true },
      { key: 'area', label: 'Área', type: 'select', options: [['', 'Sin área'], ...areas.map(a => [a.id, a.name])] },
      ...(actuales.length ? [{ key: 'modo', label: '¿Qué pasa con el administrador actual?', type: 'select', value: 'reemplazar',
        options: [['reemplazar', 'Pasa a ser miembro (reemplazar)'], ['agregar', 'Se mantiene (habrá dos administradores)']] }] : []),
    ],
    submit: 'Asignar administrador',
    onSubmit: async ({ user, email, area, modo }) => {
      let userId = user;
      let pwd = null;
      if (user === '__email') {
        const inv = await _invitarPersona(email, { rol: 'miembro', orgId: proy.org_id, siYaEsMiembro: 'reusar' });
        userId = inv.user_id; pwd = inv.pwd;
      }
      const g = gms.find(x => x.user_id === userId);
      if (g) await _patch('group_memberships', { id: `eq.${g.id}` }, { group_role: 'administrador', ...(area ? { area_id: area } : {}) });
      else await _post('group_memberships', { org_id: proy.org_id, project_id: proy.id, user_id: userId, group_role: 'administrador', area_id: area || null });
      if (modo === 'reemplazar') {
        for (const a of actuales.filter(a => a.user_id !== userId)) await _patch('group_memberships', { id: `eq.${a.id}` }, { group_role: 'miembro' });
      }
      await _audit(proy.org_id, 'asignar_admin_proyecto', 'group_memberships', userId, { proyecto: proy.name, persona: _nombre(pm.get(userId)) || email });
      return { pwd };
    },
  });
  if (!res) return false;
  if (res.pwd) await _mostrarClave('', res.pwd);
  _toast('Administrador asignado');
  return true;
}

/** Editar nombre, código, fecha de inicio y ubicación (portafolio/programa) de un proyecto. */
async function _editarProyecto(proy) {
  const ub = await _camposUbicacion(proy.org_id, { pf: proy.settings?.portfolio_id || '', prog: _progDe(proy) || '' });
  const ok = await _modal({
    title: 'Editar proyecto',
    fields: [
      { key: 'name', label: 'Nombre', required: true, value: proy.name },
      { key: 'code', label: 'Código', value: proy.code || '' },
      { key: 'start', label: 'Fecha de inicio', type: 'date', value: proy.start_date || '' },
      ...ub.fields,
    ],
    onSubmit: async ({ name, code, start, pf, prog }) => {
      const u = _ubicacion(ub.progs, pf, prog);
      await _patch('projects', { id: `eq.${proy.id}` }, {
        name, code: code || null, start_date: start || null, program_id: u.program_id,
        settings: { ...(proy.settings || {}), ...u }, updated_at: new Date().toISOString(),
      });
      await _audit(proy.org_id, 'editar_proyecto', 'projects', proy.id, { antes: proy.name, ahora: name });
    },
  });
  if (!ok) return false;
  _cambios = true;
  if (proy.org_id === S.orgId) await _cargarProyectos();
  _toast('Proyecto actualizado');
  return true;
}

async function _eliminarProyecto(proy) {
  const ok = await _modal({
    title: `Eliminar el proyecto «${proy.name}»`,
    desc: 'Desaparece para todos los miembros de la empresa. Se puede recuperar desde Supabase si te equivocas.',
    confirmWord: proy.name.trim(), submit: 'Eliminar proyecto', danger: true,
    onSubmit: async () => {
      const now = new Date().toISOString();
      await _patch('projects', { id: `eq.${proy.id}` }, { deleted_at: now, updated_at: now });
      await _audit(proy.org_id, 'eliminar_proyecto', 'projects', proy.id, { proyecto: proy.name });
    },
  });
  if (!ok) return false;
  _cambios = true;
  if (proy.org_id === S.orgId) await _cargarProyectos();
  _toast('Proyecto eliminado');
  return true;
}

/** Nodos plegados del árbol (se recuerdan entre visitas). */
const _plegados = (() => { try { return new Set(JSON.parse(localStorage.getItem('ecm_admin_plegados') || '[]')); } catch { return new Set(); } })();
const _guardarPlegados = () => { try { localStorage.setItem('ecm_admin_plegados', JSON.stringify([..._plegados])); } catch {} };

/**
 * Árbol Empresa › Portafolio › Programa › Proyecto. Si orgId es '' muestra todas las empresas.
 * @param {HTMLElement} main
 * @param {string} orgId
 */
async function _estructura(main, orgId) {
  const est = await _cargarEstructura(orgId);
  const { pfs, progs, proys, gms, pm } = est;
  const adminsDe = (pid) => gms.filter(g => g.project_id === pid).map(g => _nombre(pm.get(g.user_id)));
  const orgs = orgId ? S.orgs.filter(o => o.id === orgId) : S.orgs;

  // Construir filas del árbol en orden
  /** @type {{k:string, tipo:string, nivel:number, d:any, padre:string|null, hijos:number}[]} */
  const filas = [];
  const add = (tipo, d, nivel, padre) => { const f = { k: `${tipo}:${d.id}`, tipo, nivel, d, padre, hijos: 0 }; filas.push(f); return f; };
  const proyEn = (pred) => proys.filter(pred);
  for (const o of orgs) {
    const fo = add('org', o, 0, null);
    const pfsO = pfs.filter(p => p.org_id === o.id);
    const progsO = progs.filter(g => g.org_id === o.id);
    const proysO = proys.filter(p => p.org_id === o.id);
    const progValido = (id) => progsO.some(g => g.id === id);
    const pfValido = (id) => pfsO.some(p => p.id === id);
    for (const pf of pfsO) {
      const fpf = add('pf', pf, 1, fo.k); fo.hijos++;
      for (const g of progsO.filter(g => g.portfolio_id === pf.id)) {
        const fg = add('prog', g, 2, fpf.k); fpf.hijos++;
        for (const p of proysO.filter(p => _progDe(p) === g.id)) { add('proj', p, 3, fg.k); fg.hijos++; }
      }
      for (const p of proysO.filter(p => !progValido(_progDe(p)) && p.settings?.portfolio_id === pf.id)) { add('proj', p, 2, fpf.k); fpf.hijos++; }
    }
    for (const g of progsO.filter(g => !pfValido(g.portfolio_id))) {
      const fg = add('prog', g, 1, fo.k); fo.hijos++;
      for (const p of proysO.filter(p => _progDe(p) === g.id)) { add('proj', p, 2, fg.k); fg.hijos++; }
    }
    for (const p of proysO.filter(p => !progValido(_progDe(p)) && !pfValido(p.settings?.portfolio_id))) { add('proj', p, 1, fo.k); fo.hijos++; }
  }
  const byK = new Map(filas.map(f => [f.k, f]));

  const body = _pagina(main, {
    title: orgId ? 'Estructura y proyectos' : 'Estructura de todas las empresas',
    desc: 'Empresa › Portafolio › Programa › Proyecto. Es la misma estructura que ves en el lienzo «Estructura de Proyectos»: lo que cambies aquí se refleja allá.',
    actions: [
      ...(orgId ? [{ label: 'Ver en lienzo', act: 'lienzo' }] : []),
      { label: '+ Portafolio', act: 'npf' },
      { label: '+ Programa', act: 'nprog' },
      { label: '+ Proyecto', act: 'nproj', primary: true },
    ],
  });
  const sinAdmin = proys.filter(p => !adminsDe(p.id).length).length;
  body.innerHTML = _kpis([
    ...(orgId ? [] : [[orgs.length, 'Empresas']]),
    [pfs.length, 'Portafolios'], [progs.length, 'Programas'], [proys.length, 'Proyectos'],
    [sinAdmin, 'Proyectos sin administrador', sinAdmin ? 'warn' : ''],
  ]) + `<div class="adm-tabs">
      <button class="adm-tab-btn is-active" data-tab="tabla">${orgId ? 'Tabla' : 'Estructura de todas las empresas'}</button>
      <button class="adm-tab-btn" data-tab="org">Estructura Jerárquica</button>
    </div>
    <div data-tabpanel="tabla">
      <div class="adm-toolbar">
        <input class="adm-in adm-search" type="search" placeholder="Buscar en la estructura…" aria-label="Buscar" data-q>
        <select class="adm-in" data-ftipo aria-label="Mostrar"><option value="">Mostrar: todo</option><option value="sin">Solo proyectos sin administrador</option></select>
        <button type="button" class="adm-btn adm-btn-sm" data-expand>Expandir todo</button>
        <button type="button" class="adm-btn adm-btn-sm" data-collapse>Contraer todo</button>
      </div>
      <div class="adm-table-wrap"><table class="adm-table adm-tree"><thead><tr>
        <th>Nombre</th><th>Tipo</th><th>Código</th><th>Administrador</th><th></th>
      </tr></thead><tbody></tbody></table></div>
    </div>
    <div data-tabpanel="org" hidden></div>`;
  const tbody = /** @type {HTMLElement} */ (body.querySelector('tbody'));
  let q = '', soloSin = false;

  const accionesDe = (f) => {
    const id = f.k;
    if (f.tipo === 'org') return _btn('+ Portafolio', 'npf', id) + _btn('+ Programa', 'nprog', id) + _btn('+ Proyecto', 'nproj', id) + _btn('Usuarios', 'uorg', id);
    if (f.tipo === 'pf') return _btn('+ Programa', 'nprog', id) + _btn('+ Proyecto', 'nproj', id) + _btn('Editar', 'ednodo', id) + _btn('Eliminar', 'delnodo', id, { tono: 'danger' });
    if (f.tipo === 'prog') return _btn('+ Proyecto', 'nproj', id) + _btn('Editar', 'ednodo', id) + _btn('Eliminar', 'delnodo', id, { tono: 'danger' });
    return _btn('Editar', 'edproj', id) + _btn('Miembros y permisos', 'gestionar', id) + _btn('Eliminar', 'delproj', id, { tono: 'danger' });
  };
  const visible = (f) => { for (let p = f.padre; p; p = byK.get(p)?.padre || null) if (_plegados.has(p)) return false; return true; };
  const coincide = (f) => {
    if (soloSin) return f.tipo === 'proj' && !adminsDe(f.d.id).length;
    return !q || `${f.d.name} ${f.d.code || ''}`.toLowerCase().includes(q);
  };
  const draw = () => {
    let lista;
    if (q || soloSin) {
      // Mostrar las coincidencias y sus ancestros
      const keep = new Set();
      filas.filter(coincide).forEach(f => { for (let k = f.k; k; k = byK.get(k)?.padre || null) keep.add(k); });
      lista = filas.filter(f => keep.has(f.k));
    } else lista = filas.filter(visible);
    tbody.innerHTML = lista.length ? lista.map(f => {
      const t = TIPO[f.tipo];
      const pleg = _plegados.has(f.k) && !(q || soloSin);
      const caret = f.hijos ? `<button type="button" class="adm-caret" data-act="toggle" data-id="${_esc(f.k)}" aria-expanded="${!pleg}" aria-label="${pleg ? 'Expandir' : 'Contraer'}">${pleg ? '▸' : '▾'}</button>` : '<span class="adm-caret-sp"></span>';
      const admins = f.tipo === 'proj' ? adminsDe(f.d.id) : [];
      const adminHtml = f.tipo === 'proj'
        ? `<div class="adm-cellact">${admins.length ? `<span>${_esc(admins.join(', '))}</span>` : _badge('Sin asignar', 'warn')}${_btn(admins.length ? 'Cambiar' : 'Asignar', 'padmin', f.k, { tono: admins.length ? '' : 'primary-soft' })}</div>`
        : f.tipo === 'org' ? '<span class="adm-sub">Super admin: ver Usuarios</span>' : '';
      return `<tr class="adm-tree-${f.tipo}">
        <td><div class="adm-tree-cell" style="padding-left:${f.nivel * 22}px">${caret}<span class="adm-tree-ico" aria-hidden="true">${t.ico}</span>
          <span class="adm-strong">${_esc(f.d.name)}</span>${f.hijos && pleg ? ` <span class="adm-sub">(${f.hijos})</span>` : ''}</div></td>
        <td>${_badge(t.label, t.tono)}</td>
        <td class="adm-sub">${_esc(f.d.code || (f.tipo === 'org' ? _short(f.d.id) : '—'))}</td>
        <td>${adminHtml}</td>
        <td class="adm-actions">${accionesDe(f)}</td>
      </tr>`;
    }).join('') : `<tr><td colspan="5" class="adm-empty">${q || soloSin ? 'Sin resultados.' : 'Aún no hay estructura. Empieza con «+ Portafolio» o «+ Proyecto».'}</td></tr>`;
  };
  body.querySelector('[data-q]')?.addEventListener('input', (e) => { q = /** @type {HTMLInputElement} */ (e.target).value.trim().toLowerCase(); draw(); });
  body.querySelector('[data-ftipo]')?.addEventListener('change', (e) => { soloSin = /** @type {HTMLSelectElement} */ (e.target).value === 'sin'; draw(); });
  body.querySelector('[data-expand]')?.addEventListener('click', () => { filas.forEach(f => _plegados.delete(f.k)); _guardarPlegados(); draw(); });
  body.querySelector('[data-collapse]')?.addEventListener('click', () => { filas.filter(f => f.hijos && f.tipo !== 'org').forEach(f => _plegados.add(f.k)); _guardarPlegados(); draw(); });
  draw();

  // Tab switching
  let _orgDrawn = false;
  const _orgPanel = /** @type {HTMLElement} */ (body.querySelector('[data-tabpanel="org"]'));
  body.querySelectorAll('.adm-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = /** @type {HTMLElement} */ (btn).dataset.tab;
      body.querySelectorAll('.adm-tab-btn').forEach(b => b.classList.toggle('is-active', b === btn));
      body.querySelectorAll('[data-tabpanel]').forEach(p => { /** @type {HTMLElement} */ (p).hidden = /** @type {HTMLElement} */ (p).dataset.tabpanel !== tab; });
      if (tab === 'org' && !_orgDrawn) { _orgDrawn = true; _renderOrgChartAdmin(_orgPanel, filas, adminsDe); }
    });
  });

  // Contexto de una fila (empresa, portafolio y programa donde crear)
  const ctx = (k) => {
    const f = k ? byK.get(k) : null;
    if (!f) return { org: orgId, pf: '', prog: '' };
    const d = f.d;
    if (f.tipo === 'org') return { org: d.id, pf: '', prog: '' };
    if (f.tipo === 'pf') return { org: d.org_id, pf: d.id, prog: '' };
    if (f.tipo === 'prog') return { org: d.org_id, pf: d.portfolio_id || '', prog: d.id };
    return { org: d.org_id, pf: d.settings?.portfolio_id || '', prog: _progDe(d) || '' };
  };
  const recargar = async (hecho) => {
    if (!hecho) return;
    const activeTab = /** @type {HTMLElement|null} */ (_root?.querySelector('.adm-tab-btn.is-active'))?.dataset?.tab || 'tabla';
    await _renderPage();
    if (activeTab !== 'tabla') {
      /** @type {HTMLElement|null} */ (_root?.querySelector(`.adm-tab-btn[data-tab="${activeTab}"]`))?.click();
    }
  };
  S.acts.toggle = (k) => { _plegados.has(k) ? _plegados.delete(k) : _plegados.add(k); _guardarPlegados(); draw(); };
  S.acts.npf = async (k) => recargar(await _guardarNodo('pf', null, ctx(k).org));
  S.acts.nprog = async (k) => { const c = ctx(k); recargar(await _guardarNodo('prog', c.pf ? { org_id: c.org, portfolio_id: c.pf } : null, c.org)); };
  S.acts.nproj = async (k) => { const c = ctx(k); recargar(!!(await _crearProyecto(c.org, { pf: c.pf, prog: c.prog }))); };
  S.acts.ednodo = async (k) => { const f = byK.get(k); recargar(await _guardarNodo(f.tipo, f.d, f.d.org_id)); };
  S.acts.delnodo = async (k) => { const f = byK.get(k); recargar(await _eliminarNodo(f.tipo, f.d, est)); };
  S.acts.edproj = async (k) => recargar(await _editarProyecto(byK.get(k).d));
  S.acts.delproj = async (k) => recargar(await _eliminarProyecto(byK.get(k).d));
  S.acts.padmin = async (k) => recargar(await _asignarAdminProyecto(byK.get(k).d));
  S.acts.gestionar = async (k) => {
    const p = byK.get(k).d;
    if (S.orgId !== p.org_id) { S.orgId = p.org_id; await _cargarProyectos(); }
    S.projId = p.id;
    await _ir('proyecto', 'miembros');
  };
  S.acts.uorg = async (k) => {
    const f = byK.get(k);
    if (S.orgId !== f.d.id) { S.orgId = f.d.id; await _cargarProyectos(); }
    await _ir('empresa', 'usuarios');
  };
  S.acts.lienzo = () => {
    _cambios = false;
    _cerrar();
    window.dispatchEvent(new CustomEvent('ecm:abrir-estructura', { detail: { orgId } }));
  };
}

function _renderOrgChartAdmin(container, filas, adminsDe) {
  const CW = 160, CH = 88, HG = 28, VG = 56;
  const kids = new Map();
  filas.forEach(f => {
    const p = f.padre ?? '__ROOT__';
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(f);
  });
  const roots = filas.filter(f => f.padre === null);

  const subtreeW = new Map();
  const getW = (f) => {
    if (subtreeW.has(f.k)) return subtreeW.get(f.k);
    const ch = kids.get(f.k) || [];
    const w = ch.length ? ch.reduce((s, c) => s + getW(c) + HG, -HG) : CW;
    subtreeW.set(f.k, Math.max(CW, w));
    return subtreeW.get(f.k);
  };
  roots.forEach(getW);

  const pos = new Map();
  const place = (f, cx, y) => {
    pos.set(f.k, { x: cx - CW / 2, y, cx });
    const ch = kids.get(f.k) || [];
    if (!ch.length) return;
    const total = ch.reduce((s, c) => s + getW(c) + HG, -HG);
    let lx = cx - total / 2;
    ch.forEach(c => { const cw = getW(c); place(c, lx + cw / 2, y + CH + VG); lx += cw + HG; });
  };

  let sx = 20;
  roots.forEach(r => { const rw = getW(r); place(r, sx + rw / 2, 20); sx += rw + HG * 3; });

  let maxX = 0, maxY = 0;
  pos.forEach(({ x, y }) => { maxX = Math.max(maxX, x + CW + 20); maxY = Math.max(maxY, y + CH + 20); });

  const COL = { org: ['#e8f5e9', '#2e7d32', '#1b5e20'], pf: ['#e3f0fd', '#1976d2', '#0d47a1'], prog: ['#f3e8ff', '#7b1fa2', '#4a148c'], proj: ['#fff8e1', '#ef6c00', '#bf360c'] };

  let lines = '', cards = '';
  pos.forEach((p, k) => {
    const f = filas.find(x => x.k === k);
    if (!f) return;
    const t = TIPO[f.tipo];
    const [bg, bd, fg] = COL[f.tipo] || ['#fff', '#888', '#000'];
    const admins = f.tipo === 'proj' ? adminsDe(f.d.id) : [];
    const id = _esc(f.k);
    let acts = '';
    if (f.tipo === 'org') acts = `<button class="oct-act-btn" data-act="npf" data-id="${id}">+PF</button><button class="oct-act-btn" data-act="nprog" data-id="${id}">+Prog</button><button class="oct-act-btn" data-act="nproj" data-id="${id}">+Proy</button>`;
    else if (f.tipo === 'pf') acts = `<button class="oct-act-btn" data-act="ednodo" data-id="${id}">✏</button><button class="oct-act-btn" data-act="nprog" data-id="${id}">+Prog</button><button class="oct-act-btn" data-act="nproj" data-id="${id}">+Proy</button><button class="oct-act-btn oct-act-btn-d" data-act="delnodo" data-id="${id}">🗑</button>`;
    else if (f.tipo === 'prog') acts = `<button class="oct-act-btn" data-act="ednodo" data-id="${id}">✏</button><button class="oct-act-btn" data-act="nproj" data-id="${id}">+Proy</button><button class="oct-act-btn oct-act-btn-d" data-act="delnodo" data-id="${id}">🗑</button>`;
    else acts = `<button class="oct-act-btn" data-act="edproj" data-id="${id}">✏</button><button class="oct-act-btn oct-act-btn-d" data-act="delproj" data-id="${id}">🗑</button>`;
    const editAct = f.tipo === 'proj' ? 'edproj' : f.tipo !== 'org' ? 'ednodo' : '';
    const nodeEdit = editAct ? `data-act="${editAct}" data-id="${id}" tabindex="0" role="button" aria-label="Editar ${_esc(f.d.name)}"` : '';
    cards += `<div class="oct-node${editAct ? ' oct-node-edit' : ''}" style="left:${p.x}px;top:${p.y}px;width:${CW}px;height:${CH}px;background:${bg};border-color:${bd};color:${fg};overflow:visible" ${nodeEdit}>
      <div class="oct-node-ico">${t.ico}</div>
      <div class="oct-node-nm" title="${_esc(f.d.name)}">${_esc(f.d.name)}</div>
      <div class="oct-node-tp">${t.label}${f.d.code ? ` · ${_esc(f.d.code)}` : ''}</div>
      ${admins.length ? `<div class="oct-node-adm">${_esc(admins[0])}</div>` : ''}
      <div class="oct-node-acts">${acts}</div>
    </div>`;
    const ch = kids.get(k) || [];
    ch.forEach(c => {
      const cp = pos.get(c.k);
      if (!cp) return;
      const midY = p.y + CH + VG / 2;
      lines += `<path d="M${p.cx} ${p.y + CH} L${p.cx} ${midY} L${cp.cx} ${midY} L${cp.cx} ${cp.y}" fill="none" stroke="var(--clr-border,#d1d5db)" stroke-width="2" stroke-linecap="round"/>`;
    });
  });

  container.innerHTML = `<div class="oct-wrap"><div style="position:relative;width:${maxX}px;height:${maxY}px;min-width:100%">
    <svg style="position:absolute;inset:0;width:${maxX}px;height:${maxY}px;pointer-events:none;overflow:visible" aria-hidden="true">${lines}</svg>
    ${cards}
  </div></div>`;
}

const _platProyectos = (main) => _estructura(main, '');

async function _platPropietarios(main) {
  const rows = await _get('profiles', { platform_role: 'in.(propietario,co_propietario)', select: 'id,full_name,email,platform_role,created_at' });
  rows.sort((a, b) => (a.platform_role === 'propietario' ? -1 : 1) - (b.platform_role === 'propietario' ? -1 : 1));
  const hayCo = rows.some(r => r.platform_role === 'co_propietario');
  const body = _pagina(main, {
    title: 'Propietarios',
    desc: 'El propietario controla toda la plataforma. El co-propietario lo reemplaza en su ausencia, con los mismos permisos.',
    actions: [{ label: '+ Designar co-propietario', act: 'designar', primary: true, disabled: !_esTitular() || hayCo,
      title: !_esTitular() ? 'Solo el propietario puede designar' : (hayCo ? 'Ya hay un co-propietario; quítalo primero para cambiarlo' : '') }],
  });
  _tabla(body, {
    rows, empty: 'Sin propietarios.',
    columns: [
      { label: 'Persona', html: p => _persona(p) },
      { label: 'Rol', html: p => _badge(ROL_PLAT[p.platform_role] || p.platform_role, p.platform_role === 'propietario' ? 'gold' : 'violet') },
      { label: '', cls: 'adm-actions', html: p => p.platform_role === 'co_propietario' && _esTitular() ? _btn('Quitar', 'quitar', p.id, { tono: 'danger' }) : '' },
    ],
  });
  S.acts.designar = async () => {
    const candidatos = await _get('profiles', { platform_role: 'eq.ninguno', select: 'id,full_name,email', order: 'full_name.asc' });
    if (!candidatos.length) {
      await _modal({ title: 'No hay a quién designar', desc: 'La persona debe tener cuenta en ECM Project. Invítala primero como usuario de una empresa y vuelve aquí.', submit: 'Entendido', cancel: null });
      return;
    }
    const ok = await _modal({
      title: 'Designar co-propietario',
      desc: 'Tendrá control total de la plataforma, igual que tú. Elige a alguien de plena confianza.',
      fields: [{ key: 'user', label: 'Persona', type: 'select', required: true, options: [['', 'Elegir…'], ...candidatos.map(c => [c.id, `${_nombre(c)}${c.email ? ` (${c.email})` : ''}`])] }],
      submit: 'Designar',
      onSubmit: async ({ user }) => { await _patch('profiles', { id: `eq.${user}` }, { platform_role: 'co_propietario' }); await _audit(null, 'designar_co_propietario', 'profiles', user); },
    });
    if (ok) { _toast('Co-propietario designado'); await _renderPage(); }
  };
  S.acts.quitar = async (id) => {
    const ok = await _modal({
      title: 'Quitar co-propietario', desc: 'Perderá el control de la plataforma. Conserva su acceso a las empresas donde sea miembro.',
      submit: 'Quitar', danger: true,
      onSubmit: async () => { await _patch('profiles', { id: `eq.${id}` }, { platform_role: 'ninguno' }); await _audit(null, 'quitar_co_propietario', 'profiles', id); },
    });
    if (ok) { _toast('Co-propietario quitado'); await _renderPage(); }
  };
}

const ACCIONES = {
  crear_empresa: 'Creó la empresa', eliminar_empresa: 'Eliminó la empresa', suspender_empresa: 'Suspendió la empresa',
  reactivar_empresa: 'Reactivó la empresa', editar_empresa: 'Editó los datos de la empresa',
  invitar_usuario: 'Invitó a un usuario', cambiar_rol: 'Cambió un rol', revocar_acceso: 'Revocó un acceso',
  reactivar_acceso: 'Reactivó un acceso', asignar_relevo: 'Asignó el relevo', regenerar_clave_temporal: 'Generó una clave temporal',
  designar_co_propietario: 'Designó co-propietario', quitar_co_propietario: 'Quitó co-propietario',
  crear_area: 'Creó un área', renombrar_area: 'Renombró un área', eliminar_area: 'Eliminó un área',
  cambiar_permiso: 'Cambió un permiso', ajustar_permiso_proyecto: 'Ajustó un permiso del proyecto',
  agregar_miembro: 'Agregó un miembro al proyecto', quitar_miembro: 'Quitó un miembro del proyecto',
  cambiar_miembro: 'Cambió rol o área de un miembro', invitar_externo: 'Invitó a un externo',
  asignar_super_admin: 'Asignó super admin', crear_proyecto: 'Creó un proyecto', editar_proyecto: 'Editó un proyecto',
  asignar_admin_proyecto: 'Asignó administrador de proyecto', eliminar_proyecto: 'Eliminó un proyecto',
  crear_portafolio: 'Creó un portafolio', editar_portafolio: 'Editó un portafolio', eliminar_portafolio: 'Eliminó un portafolio',
  crear_programa: 'Creó un programa', editar_programa: 'Editó un programa', eliminar_programa: 'Eliminó un programa',
};
const _accion = (a) => ACCIONES[a] || a;

async function _auditoria(main, orgId) {
  const filtro = { select: 'id,org_id,user_id,accion,tabla,detalle,created_at', order: 'created_at.desc', limit: '300' };
  if (orgId) filtro.org_id = `eq.${orgId}`;
  const rows = await _get('auditoria', filtro);
  const pm = await _perfiles(rows.map(r => r.user_id));
  const om = new Map(S.orgs.map(o => [o.id, o.name]));
  const body = _pagina(main, {
    title: 'Auditoría',
    desc: orgId ? 'Quién hizo qué y cuándo en esta empresa (últimos 300 registros).' : 'Quién hizo qué y cuándo en toda la plataforma (últimos 300 registros).',
  });
  const acciones = [...new Set(rows.map(r => r.accion))];
  _tabla(body, {
    rows, empty: 'Sin registros todavía.',
    search: r => `${_nombre(pm.get(r.user_id))} ${_accion(r.accion)} ${JSON.stringify(r.detalle || {})} ${om.get(r.org_id) || ''}`,
    filters: [{ label: 'Acción', options: acciones.map(a => [a, _accion(a)]), get: r => r.accion }],
    columns: [
      { label: 'Fecha', html: r => _esc(_fecha(r.created_at, true)), cls: 'adm-nowrap' },
      { label: 'Usuario', html: r => _esc(_nombre(pm.get(r.user_id))) },
      ...(orgId ? [] : [{ label: 'Empresa', html: r => _esc(om.get(r.org_id) || '—') }]),
      { label: 'Acción', html: r => _esc(_accion(r.accion)) },
      { label: 'Detalle', html: r => `<span class="adm-sub">${_esc(Object.entries(r.detalle || {}).map(([k, v]) => `${k}: ${v}`).join(' · '))}</span>` },
    ],
  });
}

// ============================================================
// EMPRESA
// ============================================================
const _org = () => S.orgs.find(o => o.id === S.orgId);

async function _empResumen(main) {
  const [mems, areas] = await Promise.all([
    _get('org_memberships', { org_id: `eq.${S.orgId}`, select: 'user_id,empresa_role,active' }),
    _get('areas', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id' }).catch(() => []),
  ]);
  const pm = await _perfiles(mems.filter(m => ADMIN_ROLES.includes(m.empresa_role)).map(m => m.user_id));
  const nombresDe = (rol) => mems.filter(m => m.empresa_role === rol && m.active).map(m => _nombre(pm.get(m.user_id))).join(', ') || 'Sin asignar';
  const org = _org();
  const body = _pagina(main, {
    title: org?.name || 'Empresa',
    desc: 'Resumen de la empresa: su equipo, proyectos y estructura de áreas.',
    actions: [{ label: '+ Invitar usuario', act: 'invitar', primary: true }],
  });
  S.acts.invitar = async () => { await _ir('empresa', 'usuarios'); S.acts.invitar?.(''); };
  S.acts.go = (page) => _ir('empresa', page);
  S.acts.superadmin = async () => { if (await _asignarSuperAdmin({ id: S.orgId, name: org?.name || '' })) await _renderPage(); };
  body.innerHTML = _kpis([
    [mems.filter(m => m.active).length, 'Usuarios activos'],
    [S.projs.length, 'Proyectos'],
    [areas.length, 'Áreas'],
  ]) + `
    <div class="adm-cards">
      <div class="adm-card"><div class="adm-card-k">Super admin</div><div class="adm-cellact"><span class="adm-strong">${_esc(nombresDe('super_admin'))}</span>${_esPropietario() ? _btn(nombresDe('super_admin') === 'Sin asignar' ? 'Asignar' : 'Cambiar', 'superadmin', S.orgId) : ''}</div></div>
      <div class="adm-card"><div class="adm-card-k">Relevo (reemplaza al super admin)</div><div class="adm-strong">${_esc(nombresDe('relevo'))}</div></div>
      <div class="adm-card"><div class="adm-card-k">Estado</div>${_badge(...(ESTADO_ORG[org?.status] || ESTADO_ORG.active))}</div>
    </div>
    <h2 class="adm-h2">Accesos rápidos</h2>
    <div class="adm-quick">
      <button type="button" class="adm-quick-item" data-act="go" data-id="usuarios">👥 Gestionar usuarios y roles</button>
      <button type="button" class="adm-quick-item" data-act="go" data-id="proyectos">📁 Proyectos y sus administradores</button>
      <button type="button" class="adm-quick-item" data-act="go" data-id="plantilla">🔐 Ajustar permisos por área</button>
    </div>`;
}

async function _empUsuariosLocal(main) {
  const allMems = await getAll('memberships').catch(() => []);
  const mems = allMems.filter(m => m.org_id === S.orgId && !m.deleted_at);
  const opcRol = [['miembro', 'Miembro'], ['super_admin', 'Super admin'], ['relevo', 'Relevo'], ['invitado_externo', 'Invitado externo']];
  const body = _pagina(main, {
    title: 'Usuarios',
    desc: 'Personas con acceso a la empresa y su rol. Los datos se guardan en este dispositivo.',
    actions: [{ label: '+ Agregar usuario', act: 'invitar', primary: true }],
  });
  _tabla(body, {
    rows: mems, empty: 'Aún no hay usuarios. Agrega al primero.',
    search: r => `${r.name || ''} ${r.email || ''} ${r.role || ''}`,
    filters: [
      { label: 'Rol', options: opcRol, get: r => r.role },
      { label: 'Estado', options: [['activo', 'Activo'], ['revocado', 'Revocado']], get: r => r.active ? 'activo' : 'revocado' },
    ],
    columns: [
      { label: 'Usuario', html: r => `<span class="adm-strong">${_esc(r.name || r.email || '—')}</span>${r.email ? `<div class="adm-sub">${_esc(r.email)}</div>` : ''}` },
      { label: 'Rol', html: r => _select('rol', r.id, opcRol, r.role, { aria: 'Rol' }) },
      { label: 'Estado', html: r => r.active ? _badge('Activo', 'ok') : _badge('Revocado', 'err') },
      { label: 'Desde', html: r => _esc(_fecha(r.created_at)), cls: 'adm-nowrap' },
      { label: '', cls: 'adm-actions', html: r => [
        r.active ? _btn('Revocar', 'revocar', r.id, { tono: 'danger' }) : _btn('Reactivar', 'reactivar', r.id),
        _btn('Eliminar', 'eliminar', r.id, { tono: 'danger' }),
      ].join('') },
    ],
  });
  const byId = (id) => mems.find(r => r.id === id);
  const _uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  S.acts.invitar = async () => {
    const ok = await _modal({
      title: 'Agregar usuario',
      desc: 'Los datos se guardan en este dispositivo.',
      fields: [
        { key: 'name', label: 'Nombre completo', required: true, placeholder: 'Juan Pérez' },
        { key: 'email', label: 'Correo', type: 'email', placeholder: 'juan@empresa.com' },
        { key: 'role', label: 'Rol en la empresa', type: 'select', value: 'miembro', options: opcRol },
      ],
      submit: 'Agregar',
      onSubmit: async ({ name, email, role }) => {
        await put('memberships', { id: _uid(), org_id: S.orgId, name: name.trim(), email: (email || '').trim(), role, active: true, created_at: new Date().toISOString() });
      },
    });
    if (ok !== null) { _toast('Usuario agregado'); await _renderPage(); }
  };
  S.acts.rol = async (id, sel) => {
    const r = byId(id);
    if (r) { await put('memberships', { ...r, role: sel.value }); _toast('Rol actualizado'); await _renderPage(); }
  };
  S.acts.revocar = async (id) => {
    const r = byId(id);
    if (r) { await put('memberships', { ...r, active: false }); _toast('Acceso revocado'); await _renderPage(); }
  };
  S.acts.reactivar = async (id) => {
    const r = byId(id);
    if (r) { await put('memberships', { ...r, active: true }); _toast('Acceso reactivado'); await _renderPage(); }
  };
  S.acts.eliminar = async (id) => {
    const r = byId(id);
    const ok = await _modal({
      title: 'Eliminar usuario', desc: `Eliminar a ${_esc(r?.name || '—')} de esta empresa. No se puede deshacer.`,
      submit: 'Eliminar', danger: true,
      onSubmit: async () => { if (r) await put('memberships', { ...r, deleted_at: new Date().toISOString() }); },
    });
    if (ok !== null) { _toast('Usuario eliminado'); await _renderPage(); }
  };
}

async function _empUsuarios(main) {
  // Si la empresa es local (no está en Supabase), usar gestión local
  if (!S.orgs.some(o => o.id === S.orgId)) { return _empUsuariosLocal(main); }
  const mems = await _get('org_memberships', { org_id: `eq.${S.orgId}`, select: 'id,user_id,empresa_role,empresa_ext,active,temp_password,expires_at,created_at', order: 'created_at.asc' });
  const pm = await _perfiles(mems.map(m => m.user_id));
  const rows = mems.map(m => ({ ...m, perfil: pm.get(m.user_id) }));
  const yo = authState.user?.id;
  const body = _pagina(main, {
    title: 'Usuarios',
    desc: 'Personas con acceso a la empresa y su rol. <b>Super admin</b> administra todo; <b>Relevo</b> lo reemplaza; <b>Miembro</b> trabaja en los proyectos asignados.',
    actions: [{ label: '+ Invitar usuario', act: 'invitar', primary: true }],
  });
  const opcRol = [['super_admin', 'Super admin'], ['relevo', 'Relevo'], ['miembro', 'Miembro'], ['invitado_externo', 'Invitado externo']];
  _tabla(body, {
    rows, empty: 'Aún no hay usuarios. Invita al primero.',
    search: r => `${_nombre(r.perfil)} ${r.perfil?.email || ''} ${ROL_EMP[r.empresa_role] || ''} ${r.empresa_ext || ''}`,
    filters: [
      { label: 'Rol', options: opcRol, get: r => r.empresa_role },
      { label: 'Estado', options: [['activo', 'Activo'], ['revocado', 'Revocado']], get: r => r.active ? 'activo' : 'revocado' },
    ],
    columns: [
      { label: 'Usuario', html: r => _persona(r.perfil, r.user_id) + (r.empresa_ext ? `<div class="adm-sub">Empresa: ${_esc(r.empresa_ext)}</div>` : '') },
      { label: 'Rol', html: r => _select('rol', r.id, opcRol, r.empresa_role, { aria: 'Rol', disabled: r.user_id === yo && !_esPropietario() }) },
      { label: 'Estado', html: r => r.active ? _badge('Activo', 'ok') : _badge('Revocado', 'err') },
      { label: 'Clave', html: r => r.temp_password ? _badge('Temporal, sin cambiar', 'warn') : '<span class="adm-sub">Propia</span>' },
      { label: 'Desde', html: r => _esc(_fecha(r.created_at)), cls: 'adm-nowrap' },
      { label: '', cls: 'adm-actions', html: r => r.user_id === yo ? '<span class="adm-sub">Tú</span>' : [
        r.temp_password ? _btn('Nueva clave', 'clave', r.id, { title: 'Generar otra clave temporal' }) : '',
        r.active ? _btn('Revocar', 'revocar', r.id, { tono: 'danger' }) : _btn('Reactivar', 'reactivar', r.id),
      ].join('') },
    ],
  });
  const byId = (id) => rows.find(r => r.id === id);
  S.acts.invitar = () => _invitar({ rol: 'miembro' });
  S.acts.rol = async (id, sel) => {
    const r = byId(id);
    const nuevo = sel.value;
    try {
      const supers = rows.filter(x => x.empresa_role === 'super_admin' && x.active);
      if (r.empresa_role === 'super_admin' && nuevo !== 'super_admin' && supers.length <= 1) {
        throw new Error('La empresa necesita al menos un super admin. Asigna otro antes de cambiar este rol.');
      }
      if (nuevo === 'relevo') {
        for (const x of rows.filter(x => x.empresa_role === 'relevo' && x.id !== id)) {
          await _patch('org_memberships', { id: `eq.${x.id}` }, { empresa_role: 'miembro' });
        }
      }
      await _patch('org_memberships', { id: `eq.${id}` }, { empresa_role: nuevo });
      await _audit(S.orgId, nuevo === 'relevo' ? 'asignar_relevo' : 'cambiar_rol', 'org_memberships', id, { usuario: _nombre(r.perfil), rol: ROL_EMP[nuevo] });
      _toast(nuevo === 'relevo' ? 'Relevo asignado (solo puede haber uno)' : 'Rol actualizado');
      await _renderPage();
    } catch (e) { sel.value = r.empresa_role; _toast(/** @type {Error} */ (e).message, 'err'); }
  };
  S.acts.revocar = async (id) => {
    const r = byId(id);
    const ok = await _modal({
      title: `Revocar acceso a ${_nombre(r.perfil)}`, desc: 'No podrá entrar a esta empresa. Su historial se conserva y puedes reactivarlo cuando quieras.',
      submit: 'Revocar acceso', danger: true,
      onSubmit: async () => {
        if (r.empresa_role === 'super_admin' && rows.filter(x => x.empresa_role === 'super_admin' && x.active).length <= 1) throw new Error('Es el único super admin de la empresa.');
        await _patch('org_memberships', { id: `eq.${id}` }, { active: false });
        await _audit(S.orgId, 'revocar_acceso', 'org_memberships', id, { usuario: _nombre(r.perfil) });
      },
    });
    if (ok) { _toast('Acceso revocado'); await _renderPage(); }
  };
  S.acts.reactivar = async (id) => {
    await _patch('org_memberships', { id: `eq.${id}` }, { active: true });
    await _audit(S.orgId, 'reactivar_acceso', 'org_memberships', id, { usuario: _nombre(byId(id).perfil) });
    _toast('Acceso reactivado');
    await _renderPage();
  };
  S.acts.clave = async (id) => {
    const pwd = _genClave();
    await _patch('org_memberships', { id: `eq.${id}` }, { temp_password: pwd });
    await _audit(S.orgId, 'regenerar_clave_temporal', 'org_memberships', id);
    await _mostrarClave(byId(id).perfil?.email || '', pwd);
    await _renderPage();
  };
}

function _genClave() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => chars[b % chars.length]).join('');
}

function _mostrarClave(email, pwd) {
  return _modal({
    title: 'Clave temporal',
    desc: 'Envíala a la persona por un medio seguro. Al entrar por primera vez se le pedirá cambiarla.',
    html: `<div class="adm-secret">${email ? `<div><span class="adm-sub">Usuario</span><br><b>${_esc(email)}</b></div>` : ''}
      <div><span class="adm-sub">Clave temporal</span><br><code>${_esc(pwd)}</code></div></div>`,
    submit: 'Listo', cancel: null,
  });
}

/**
 * Invita a una persona a una empresa (por defecto la del alcance actual). Si ya tiene cuenta, solo la agrega.
 * @param {{rol:string, empresaExt?:string, expira?:string|null, orgId?:string, siYaEsMiembro?:'error'|'reusar'}} opts
 * @returns {Promise<{mem_id:string, user_id:string, pwd:string|null}>}
 */
async function _invitarPersona(email, { rol, empresaExt = '', expira = null, orgId = S.orgId, siYaEsMiembro = 'error' }) {
  email = email.toLowerCase();
  let [perfil] = await _get('profiles', { email: `eq.${email}`, select: 'id' });
  let pwd = null;
  if (!perfil) {
    pwd = _genClave();
    const res = await fetch(`${AUTH}/signup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password: pwd }),
    });
    const data = await res.json().catch(() => ({}));
    const uid = data?.user?.id || data?.id;
    if (!uid) throw new Error(data?.msg || data?.message || data?.error_description || 'No se pudo crear la cuenta.');
    perfil = { id: uid };
  }
  const [existe] = await _get('org_memberships', { org_id: `eq.${orgId}`, user_id: `eq.${perfil.id}`, select: 'id,active' });
  if (existe) {
    if (existe.active && siYaEsMiembro === 'error') throw new Error('Esa persona ya es usuario de esta empresa.');
    await _patch('org_memberships', { id: `eq.${existe.id}` }, { active: true, empresa_role: rol, empresa_ext: empresaExt || null, expires_at: expira });
    return { mem_id: existe.id, user_id: perfil.id, pwd: null };
  }
  const [mem] = await _post('org_memberships', {
    org_id: orgId, user_id: perfil.id, empresa_role: rol, empresa_ext: empresaExt || null,
    active: true, temp_password: pwd, invited_by: authState.user?.id, expires_at: expira,
  });
  await _audit(orgId, rol === 'invitado_externo' ? 'invitar_externo' : 'invitar_usuario', 'org_memberships', mem?.id, { email, rol: ROL_EMP[rol] });
  return { mem_id: mem?.id, user_id: perfil.id, pwd };
}

async function _invitar({ rol }) {
  const res = await _modal({
    title: 'Invitar usuario',
    desc: 'Si la persona aún no tiene cuenta, se crea con una clave temporal que le entregarás tú.',
    fields: [
      { key: 'email', label: 'Correo', type: 'email', required: true, placeholder: 'nombre@empresa.com' },
      { key: 'rol', label: 'Rol en la empresa', type: 'select', value: rol, options: [['miembro', 'Miembro'], ['relevo', 'Relevo'], ['super_admin', 'Super admin'], ['invitado_externo', 'Invitado externo']] },
      { key: 'ext', label: 'Empresa de la persona invitada', placeholder: 'Ej: Supervisión ABC', showIf: ['rol', 'invitado_externo'] },
    ],
    submit: 'Invitar',
    onSubmit: ({ email, rol: r, ext }) => _invitarPersona(email, { rol: r, empresaExt: ext }),
  });
  if (!res) return;
  if (res.pwd) await _mostrarClave('', res.pwd); else _toast('Usuario agregado a la empresa');
  await _renderPage();
}

const _empProyectos = (main) => _estructura(main, S.orgId);

async function _empAreas(main) {
  const [areas, gms] = await Promise.all([
    _get('areas', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id,name,sort_order,is_default', order: 'sort_order.asc' }),
    _get('group_memberships', { org_id: `eq.${S.orgId}`, select: 'area_id' }).catch(() => []),
  ]);
  const rows = areas.map(a => ({ ...a, uso: gms.filter(g => g.area_id === a.id).length }));
  const body = _pagina(main, {
    title: 'Áreas',
    desc: 'Las áreas agrupan a las personas por función (Planificación, Costos, Calidad…). Cada área tiene sus permisos por módulo.',
    actions: [{ label: '+ Nueva área', act: 'nueva', primary: true }],
  });
  _tabla(body, {
    rows, empty: 'Sin áreas.',
    search: a => a.name,
    filters: [{ label: 'Tipo', options: [['std', 'Estándar'], ['custom', 'Personalizada']], get: a => a.is_default ? 'std' : 'custom' }],
    columns: [
      { label: '#', html: a => String(a.sort_order), cls: 'adm-num' },
      { label: 'Área', html: a => `<span class="adm-strong">${_esc(a.name)}</span>` },
      { label: 'Tipo', html: a => a.is_default ? _badge('Estándar') : _badge('Personalizada', 'info') },
      { label: 'Personas asignadas', html: a => String(a.uso), cls: 'adm-num' },
      { label: '', cls: 'adm-actions', html: a => _btn('Renombrar', 'renombrar', a.id) + (a.is_default ? '' : _btn('Eliminar', 'eliminar', a.id, { tono: 'danger', disabled: a.uso > 0, title: a.uso > 0 ? 'Tiene personas asignadas' : '' })) },
    ],
  });
  const byId = (id) => rows.find(a => a.id === id);
  S.acts.nueva = async () => {
    const ok = await _modal({
      title: 'Nueva área', desc: 'Empieza con permiso «Solo ver» en todos los módulos; ajústalo en Plantilla de permisos.',
      fields: [{ key: 'name', label: 'Nombre del área', required: true, placeholder: 'Ej: Producción' }],
      submit: 'Crear área',
      onSubmit: async ({ name }) => {
        const [a] = await _post('areas', { org_id: S.orgId, name, sort_order: Math.max(0, ...rows.map(r => r.sort_order)) + 1, is_default: false });
        await _post('permisos', MODULOS.map(m => ({ org_id: S.orgId, area_id: a.id, project_id: null, modulo: m.key, nivel: 'solo_ver' })));
        await _audit(S.orgId, 'crear_area', 'areas', a.id, { area: name });
      },
    });
    if (ok) { _toast('Área creada'); await _renderPage(); }
  };
  S.acts.renombrar = async (id) => {
    const a = byId(id);
    const ok = await _modal({
      title: 'Renombrar área',
      fields: [{ key: 'name', label: 'Nombre', required: true, value: a.name }],
      onSubmit: async ({ name }) => { await _patch('areas', { id: `eq.${id}` }, { name }); await _audit(S.orgId, 'renombrar_area', 'areas', id, { antes: a.name, ahora: name }); },
    });
    if (ok) { _toast('Área renombrada'); await _renderPage(); }
  };
  S.acts.eliminar = async (id) => {
    const a = byId(id);
    const ok = await _modal({
      title: `Eliminar el área «${a.name}»`, desc: 'Se borran también sus permisos.', submit: 'Eliminar área', danger: true,
      onSubmit: async () => { await _del('areas', { id: `eq.${id}` }); await _audit(S.orgId, 'eliminar_area', 'areas', id, { area: a.name }); },
    });
    if (ok) { _toast('Área eliminada'); await _renderPage(); }
  };
}

/**
 * Matriz área × módulo. En modo proyecto muestra el nivel efectivo y marca los ajustes propios del proyecto.
 * @param {HTMLElement} main
 * @param {boolean} deProyecto
 */
async function _matrizPermisos(main, deProyecto) {
  const [areas, perms] = await Promise.all([
    _get('areas', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id,name,sort_order', order: 'sort_order.asc' }),
    _get('permisos', { org_id: `eq.${S.orgId}`, select: 'id,area_id,project_id,modulo,nivel' }),
  ]);
  const base = new Map(perms.filter(p => !p.project_id).map(p => [`${p.area_id}|${p.modulo}`, p]));
  const ajuste = new Map(perms.filter(p => deProyecto && p.project_id === S.projId).map(p => [`${p.area_id}|${p.modulo}`, p]));
  const proy = S.projs.find(p => p.id === S.projId);
  const body = _pagina(main, deProyecto ? {
    title: 'Permisos del proyecto',
    desc: `Por defecto, <b>${_esc(proy?.name || 'el proyecto')}</b> usa la plantilla de la empresa. Cambia una celda solo si este proyecto necesita algo distinto; las celdas ajustadas se marcan con borde.`,
  } : {
    title: 'Plantilla de permisos',
    desc: 'Qué puede hacer cada área en cada módulo. Se aplica a todos los proyectos de la empresa, salvo ajustes propios de un proyecto.',
  });
  const opc = NIVELES;
  body.innerHTML = `
    <div class="adm-legend">${NIVELES.map(([k, l]) => `<span class="adm-lv adm-lv-${k}">${l}</span>`).join('')}
      <span class="adm-sub">Editar: crea y modifica · Solo avance: registra avance · Solo ver: consulta</span></div>
    <div class="adm-table-wrap"><table class="adm-table adm-matrix"><thead><tr><th>Área</th>
      ${MODULOS.map(m => `<th>${_esc(m.label)}</th>`).join('')}${deProyecto ? '<th></th>' : ''}</tr></thead><tbody>
      ${areas.length ? areas.map(a => `<tr><td class="adm-strong">${_esc(a.name)}</td>${MODULOS.map(m => {
        const k = `${a.id}|${m.key}`;
        const nivel = (ajuste.get(k) || base.get(k))?.nivel || 'sin_acceso';
        return `<td class="${ajuste.has(k) ? 'is-override' : ''}"><select class="adm-in adm-in-sm adm-lvsel adm-lv-${nivel}" data-act-change="nivel" data-id="${_esc(k)}" aria-label="${_esc(`${a.name} · ${m.label}`)}">${
          opc.map(([v, l]) => `<option value="${v}" ${v === nivel ? 'selected' : ''}>${l}</option>`).join('')}</select></td>`;
      }).join('')}${deProyecto ? `<td>${MODULOS.some(m => ajuste.has(`${a.id}|${m.key}`)) ? _btn('Restablecer', 'reset', a.id, { title: 'Volver a la plantilla de la empresa' }) : ''}</td>` : ''}</tr>`).join('')
      : `<tr><td colspan="${MODULOS.length + 1}" class="adm-empty">Sin áreas. Créalas en Áreas.</td></tr>`}
    </tbody></table></div>`;
  S.acts.nivel = async (k, sel) => {
    const [areaId, modulo] = k.split('|');
    const nivel = sel.value;
    try {
      if (!deProyecto) {
        const p = base.get(k);
        if (p) await _patch('permisos', { id: `eq.${p.id}` }, { nivel });
        else await _post('permisos', { org_id: S.orgId, area_id: areaId, project_id: null, modulo, nivel });
        await _audit(S.orgId, 'cambiar_permiso', 'permisos', k, { area: areas.find(a => a.id === areaId)?.name, modulo, nivel: NIVEL_LABEL[nivel] });
      } else {
        const p = ajuste.get(k);
        if (nivel === (base.get(k)?.nivel || 'sin_acceso')) { if (p) await _del('permisos', { id: `eq.${p.id}` }); }
        else if (p) await _patch('permisos', { id: `eq.${p.id}` }, { nivel });
        else await _post('permisos', { org_id: S.orgId, area_id: areaId, project_id: S.projId, modulo, nivel });
        await _audit(S.orgId, 'ajustar_permiso_proyecto', 'permisos', k, { proyecto: proy?.name, area: areas.find(a => a.id === areaId)?.name, modulo, nivel: NIVEL_LABEL[nivel] });
      }
      _toast('Permiso guardado');
      await _renderPage();
    } catch (e) { _toast(/** @type {Error} */ (e).message, 'err'); await _renderPage(); }
  };
  S.acts.reset = async (areaId) => {
    try {
      await _del('permisos', { org_id: `eq.${S.orgId}`, area_id: `eq.${areaId}`, project_id: `eq.${S.projId}` });
      _toast('Restablecido a la plantilla');
      await _renderPage();
    } catch (e) { _toast(/** @type {Error} */ (e).message, 'err'); }
  };
}

async function _empDatos(main) {
  const [org] = await _get('organizations', { id: `eq.${S.orgId}`, select: 'id,name,slug,status,created_at' });
  const editable = _adminDe(S.orgId);
  const body = _pagina(main, { title: 'Datos de la empresa', desc: 'Información general de la empresa.' });
  body.innerHTML = `<form class="adm-form" data-form novalidate>
    ${_campo({ key: 'name', label: 'Nombre', value: org?.name, required: true, readonly: !editable })}
    ${_campo({ key: 'slug', label: 'Identificador interno', value: org?.slug, readonly: true })}
    ${_campo({ key: 'id', label: 'Código', value: org?.id, readonly: true })}
    ${_campo({ key: 'created', label: 'Creada', value: _fecha(org?.created_at, true), readonly: true })}
    <div class="adm-field"><span class="adm-lbl">Estado</span><div>${_badge(...(ESTADO_ORG[org?.status] || ESTADO_ORG.active))}</div></div>
    ${editable ? '<div class="adm-form-actions"><button type="submit" class="adm-btn adm-btn-primary">Guardar cambios</button></div>' : ''}
  </form>`;
  body.querySelector('[data-form]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = /** @type {HTMLInputElement} */ (body.querySelector('[data-k="name"]')).value.trim();
    if (!name) { _toast('El nombre no puede quedar vacío', 'err'); return; }
    try {
      await _patch('organizations', { id: `eq.${S.orgId}` }, { name });
      await _audit(S.orgId, 'editar_empresa', 'organizations', S.orgId, { antes: org?.name, ahora: name });
      await recargarEmpresas();
      await _cargarOrgs();
      _renderScope();
      _toast('Datos guardados');
    } catch (ex) { _toast(/** @type {Error} */ (ex).message, 'err'); }
  });
}

// ============================================================
// PROYECTO
// ============================================================
async function _proyMiembros(main) {
  const [gms, mems, areas] = await Promise.all([
    _get('group_memberships', { project_id: `eq.${S.projId}`, select: 'id,user_id,group_role,area_id,created_at', order: 'created_at.asc' }),
    _get('org_memberships', { org_id: `eq.${S.orgId}`, active: 'eq.true', select: 'user_id,empresa_role' }),
    _get('areas', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id,name', order: 'sort_order.asc' }),
  ]);
  const pm = await _perfiles([...gms.map(g => g.user_id), ...mems.map(m => m.user_id)]);
  const am = new Map(areas.map(a => [a.id, a.name]));
  const rows = gms.map(g => ({ ...g, perfil: pm.get(g.user_id), rolEmp: mems.find(m => m.user_id === g.user_id)?.empresa_role }));
  const proy = S.projs.find(p => p.id === S.projId);
  const body = _pagina(main, {
    title: 'Miembros del proyecto',
    desc: `Quién trabaja en <b>${_esc(proy?.name || '')}</b>. El <b>administrador</b> gestiona el proyecto; cada miembro tiene un <b>área</b>, que define sus permisos.`,
    actions: [{ label: '+ Agregar miembro', act: 'agregar', primary: true }],
  });
  const opcArea = [['', 'Sin área'], ...areas.map(a => [a.id, a.name])];
  _tabla(body, {
    rows, empty: 'Nadie asignado todavía. Agrega al administrador del proyecto y a su equipo.',
    search: r => `${_nombre(r.perfil)} ${r.perfil?.email || ''} ${am.get(r.area_id) || ''}`,
    filters: [
      { label: 'Rol', options: [['administrador', 'Administrador'], ['miembro', 'Miembro']], get: r => r.group_role },
      { label: 'Área', options: areas.map(a => [a.id, a.name]), get: r => r.area_id || '' },
    ],
    columns: [
      { label: 'Persona', html: r => _persona(r.perfil, r.user_id) + (r.rolEmp === 'invitado_externo' ? _badge('Externo', 'violet') : '') },
      { label: 'Rol en el proyecto', html: r => _select('grol', r.id, [['administrador', 'Administrador'], ['miembro', 'Miembro']], r.group_role, { aria: 'Rol en el proyecto' }) },
      { label: 'Área', html: r => _select('garea', r.id, opcArea, r.area_id || '', { aria: 'Área' }) },
      { label: 'Desde', html: r => _esc(_fecha(r.created_at)), cls: 'adm-nowrap' },
      { label: '', cls: 'adm-actions', html: r => _btn('Quitar', 'quitar', r.id, { tono: 'danger' }) },
    ],
  });
  const byId = (id) => rows.find(r => r.id === id);
  S.acts.agregar = async () => {
    const libres = mems.filter(m => !gms.some(g => g.user_id === m.user_id));
    if (!libres.length) {
      await _modal({ title: 'No hay personas disponibles', desc: 'Todos los usuarios de la empresa ya están en este proyecto. Invita a más personas desde Empresa › Usuarios, o a un externo desde Invitados externos.', submit: 'Entendido', cancel: null });
      return;
    }
    const ok = await _modal({
      title: 'Agregar miembro',
      fields: [
        { key: 'user', label: 'Persona', type: 'select', required: true, options: [['', 'Elegir…'], ...libres.map(m => [m.user_id, `${_nombre(pm.get(m.user_id))} · ${ROL_EMP[m.empresa_role] || ''}`])] },
        { key: 'rol', label: 'Rol en el proyecto', type: 'select', value: 'miembro', options: [['miembro', 'Miembro'], ['administrador', 'Administrador']] },
        { key: 'area', label: 'Área', type: 'select', options: opcArea, hint: 'Define qué puede hacer en cada módulo.' },
      ],
      submit: 'Agregar',
      onSubmit: async ({ user, rol, area }) => {
        const [g] = await _post('group_memberships', { org_id: S.orgId, project_id: S.projId, user_id: user, group_role: rol, area_id: area || null });
        await _audit(S.orgId, 'agregar_miembro', 'group_memberships', g?.id, { proyecto: proy?.name, persona: _nombre(pm.get(user)), rol: ROL_GRUPO[rol], area: am.get(area) || '—' });
      },
    });
    if (ok) { _toast('Miembro agregado'); await _renderPage(); }
  };
  const cambiar = (campo) => async (id, sel) => {
    const r = byId(id);
    try {
      await _patch('group_memberships', { id: `eq.${id}` }, { [campo]: sel.value || null });
      await _audit(S.orgId, 'cambiar_miembro', 'group_memberships', id, { persona: _nombre(r.perfil), [campo === 'area_id' ? 'area' : 'rol']: campo === 'area_id' ? (am.get(sel.value) || '—') : ROL_GRUPO[sel.value] });
      _toast('Cambio guardado');
      await _renderPage();
    } catch (e) { _toast(/** @type {Error} */ (e).message, 'err'); await _renderPage(); }
  };
  S.acts.grol = cambiar('group_role');
  S.acts.garea = cambiar('area_id');
  S.acts.quitar = async (id) => {
    const r = byId(id);
    const ok = await _modal({
      title: `Quitar a ${_nombre(r.perfil)} del proyecto`, desc: 'Deja de ver este proyecto. Sigue siendo usuario de la empresa.', submit: 'Quitar', danger: true,
      onSubmit: async () => { await _del('group_memberships', { id: `eq.${id}` }); await _audit(S.orgId, 'quitar_miembro', 'group_memberships', id, { proyecto: proy?.name, persona: _nombre(r.perfil) }); },
    });
    if (ok) { _toast('Miembro quitado'); await _renderPage(); }
  };
}

async function _proyExternos(main) {
  const [mems, gms, areas] = await Promise.all([
    _get('org_memberships', { org_id: `eq.${S.orgId}`, empresa_role: 'eq.invitado_externo', select: 'id,user_id,empresa_ext,active,expires_at,temp_password' }),
    _get('group_memberships', { project_id: `eq.${S.projId}`, select: 'id,user_id,area_id' }),
    _get('areas', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id,name', order: 'sort_order.asc' }),
  ]);
  const rows = mems.map(m => ({ ...m, gm: gms.find(g => g.user_id === m.user_id) })).filter(r => r.gm);
  const pm = await _perfiles(rows.map(r => r.user_id));
  const am = new Map(areas.map(a => [a.id, a.name]));
  const hoy = new Date().toISOString().slice(0, 10);
  const proy = S.projs.find(p => p.id === S.projId);
  const body = _pagina(main, {
    title: 'Invitados externos',
    desc: 'Personas de otras empresas (cliente, supervisión, subcontratas) con acceso solo a este proyecto y por tiempo limitado.',
    actions: [{ label: '+ Invitar externo', act: 'invitar', primary: true }],
  });
  const vencido = (r) => r.expires_at && r.expires_at.slice(0, 10) < hoy;
  _tabla(body, {
    rows, empty: 'Sin invitados externos en este proyecto.',
    search: r => `${_nombre(pm.get(r.user_id))} ${pm.get(r.user_id)?.email || ''} ${r.empresa_ext || ''}`,
    filters: [{ label: 'Estado', options: [['activo', 'Activo'], ['vencido', 'Vencido'], ['revocado', 'Revocado']], get: r => !r.active ? 'revocado' : (vencido(r) ? 'vencido' : 'activo') }],
    columns: [
      { label: 'Persona', html: r => _persona(pm.get(r.user_id), r.user_id) },
      { label: 'Empresa', html: r => _esc(r.empresa_ext || '—') },
      { label: 'Área', html: r => _esc(am.get(r.gm.area_id) || '—') },
      { label: 'Acceso hasta', html: r => _esc(r.expires_at ? _fecha(r.expires_at) : 'Sin fecha'), cls: 'adm-nowrap' },
      { label: 'Estado', html: r => !r.active ? _badge('Revocado', 'err') : (vencido(r) ? _badge('Vencido', 'warn') : _badge('Activo', 'ok')) },
      { label: '', cls: 'adm-actions', html: r => r.active ? _btn('Revocar', 'revocar', r.id, { tono: 'danger' }) : '' },
    ],
  });
  S.acts.invitar = async () => {
    const res = await _modal({
      title: 'Invitar externo',
      desc: `Tendrá acceso solo a <b>${_esc(proy?.name || 'este proyecto')}</b>, con los permisos del área que elijas.`,
      fields: [
        { key: 'email', label: 'Correo', type: 'email', required: true, placeholder: 'nombre@otraempresa.com' },
        { key: 'ext', label: 'Empresa de la persona', required: true, placeholder: 'Ej: Supervisión ABC' },
        { key: 'area', label: 'Área', type: 'select', required: true, options: [['', 'Elegir…'], ...areas.map(a => [a.id, a.name])] },
        { key: 'hasta', label: 'Acceso hasta', type: 'date', hint: 'Déjalo vacío para un acceso sin fecha de fin.' },
      ],
      submit: 'Invitar',
      onSubmit: async ({ email, ext, area, hasta }) => {
        const inv = await _invitarPersona(email, { rol: 'invitado_externo', empresaExt: ext, expira: hasta ? new Date(`${hasta}T23:59:59`).toISOString() : null });
        const [g] = await _get('group_memberships', { project_id: `eq.${S.projId}`, user_id: `eq.${inv.user_id}`, select: 'id' });
        if (!g) await _post('group_memberships', { org_id: S.orgId, project_id: S.projId, user_id: inv.user_id, group_role: 'miembro', area_id: area });
        return inv;
      },
    });
    if (!res) return;
    if (res.pwd) await _mostrarClave('', res.pwd); else _toast('Externo agregado al proyecto');
    await _renderPage();
  };
  S.acts.revocar = async (id) => {
    const r = rows.find(x => x.id === id);
    const ok = await _modal({
      title: `Revocar a ${_nombre(pm.get(r.user_id))}`, desc: 'Pierde el acceso a la empresa y a sus proyectos.', submit: 'Revocar', danger: true,
      onSubmit: async () => { await _patch('org_memberships', { id: `eq.${id}` }, { active: false }); await _audit(S.orgId, 'revocar_acceso', 'org_memberships', id, { externo: _nombre(pm.get(r.user_id)) }); },
    });
    if (ok) { _toast('Acceso revocado'); await _renderPage(); }
  };
}

// ============================================================
// Reportes de administración
// ============================================================

/**
 * Renderiza un reporte de administración: en un iframe (vista previa inline) o en ventana nueva.
 * @param {string} title  Título del reporte
 * @param {string} html   Contenido HTML del reporte
 * @param {string} ctxName  Nombre de contexto (empresa o "Plataforma")
 * @param {HTMLIFrameElement|null} [frame]  Si se provee, escribe en el iframe; si no, abre ventana nueva.
 */
function _printAdmPdf(title, html, ctxName, frame = null) {
  const _d = new Date();
  const _dd = String(_d.getDate()).padStart(2, '0');
  const _mm = String(_d.getMonth() + 1).padStart(2, '0');
  const _yy = _d.getFullYear();
  const _hh = String(_d.getHours()).padStart(2, '0');
  const _mi = String(_d.getMinutes()).padStart(2, '0');
  const titleFile = `ECM-Admin-${title.replace(/\s+/g, '-')}-${_dd}${_mm}${_yy}`;
  const ctxEsc = _esc(ctxName);
  const titleEsc = _esc(title);
  const PAPER_SEL = '<span class="lbl">Papel:</span><select id="paper" onchange="setOri()" title="Tamaño de papel">' +
    '<option value="A4" selected>A4</option><option value="A3">A3</option><option value="Carta">Carta</option>' +
    '<option value="Oficio">Oficio</option><option value="Tabloide">Tabloide</option></select><div class="sep"></div>';
  const PAPER_JS = "var PAPERS={A4:[210,297],A3:[297,420],Carta:[216,279],Oficio:[216,330],Tabloide:[279,432]};" +
    "function paperSize(o){var p=PAPERS[(document.getElementById('paper')||{}).value]||PAPERS.A4;" +
    "var a=Math.min(p[0],p[1]),b=Math.max(p[0],p[1]);return o==='landscape'?[b,a]:[a,b];}";
  const _docTarget = frame
    ? (frame.contentDocument || frame.contentWindow?.document || null)
    : (() => { const w = window.open('', '_blank', 'width=1100,height=880'); if (!w) { _toast('El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.'); } return w?.document || null; })();
  if (!_docTarget) return;
  _docTarget.open();
  _docTarget.write(`<!DOCTYPE html><html><head>
<meta charset="utf-8">
<title>${titleFile}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,sans-serif;margin:0;padding:0;background:#f1f5f9;color:#1f2937}
  .tb{background:#fff;padding:8px 14px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;position:sticky;top:0;z-index:100;border-bottom:1px solid #e2e8f0}
  .tb button{padding:5px 11px;border:1px solid #d1d5db;border-radius:5px;cursor:pointer;font-size:12px;background:#fff;color:#374151;white-space:nowrap}
  .tb button.pri{background:#4f46e5;color:#fff;border-color:#4f46e5;font-weight:600;font-size:13px;padding:6px 16px}
  .tb button.pri:hover{background:#4338ca}
  .tb button.act{background:#ede9fe;color:#4f46e5;border-color:#c4b5fd;font-weight:600}
  .tb button:hover:not(.pri){background:#f8fafc}
  .tb .sep{width:1px;height:20px;background:#e2e8f0;flex-shrink:0}
  .tb .lbl{font-size:11px;color:#64748b;white-space:nowrap}
  .tb select{font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;background:#fff;color:#374151}
  .tb input[type=text]{font-size:12px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#f8fafc;color:#374151;width:300px}
  .pv{padding:20px;display:flex;flex-direction:column;align-items:center;gap:16px;min-height:calc(100dvh - 52px)}
  .a4{background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.4);padding:14mm 15mm;width:var(--pw,210mm);min-height:var(--ph,297mm);overflow:auto}
  h1{font-size:15px;margin:0 0 4mm;text-align:center;color:#1a365d;font-weight:700}
  h2{font-size:13px;margin:10px 0 5px;color:#1f2937}
  .subtitle{font-size:10px;text-align:center;color:#4a5568;margin:-1mm 0 7mm}
  table{border-collapse:collapse;width:100%;margin-bottom:8mm}
  th,td{border:1px solid #ccc;padding:4px 8px;font-size:11px}
  th{background:#f4f5f7;font-weight:600;text-align:left}
  .stat-row{display:flex;gap:6mm;margin-bottom:8mm;flex-wrap:wrap}
  .stat{border:1px solid #d1d5db;border-radius:6px;padding:6px 10px;min-width:100px;text-align:center;background:#f8fafc}
  .stat-val{font-size:18px;font-weight:700;color:#4f46e5}
  .stat-lbl{font-size:9px;color:#64748b;margin-top:2px}
  .print-header{position:fixed;top:0;left:0;right:0;height:26px;display:none;align-items:center;justify-content:space-between;padding:0 10mm;border-bottom:0.5pt solid #CBD5E0;font-size:6pt;color:#4A5568;background:#fff;z-index:9999}
  .print-footer{position:fixed;bottom:0;left:0;right:0;height:22px;display:none;align-items:center;justify-content:space-between;padding:0 10mm;border-top:0.5pt solid #CBD5E0;font-size:6pt;color:#718096;background:#fff;z-index:9999}
  @media print{
    body{background:#fff}
    .tb{display:none!important}
    .pv{padding:0;min-height:0}
    .a4{box-shadow:none;width:100%;min-height:0;padding:1.5mm 0 0!important}
    .print-header,.print-footer{display:flex!important}
    @page{margin:10mm}
  }
</style></head><body>
<div class="tb">
  ${PAPER_SEL}
  <span class="lbl">Orientaci&#243;n:</span>
  <button id="bp" class="act" onclick="setOri('portrait')">&#x1F4C4; Vertical</button>
  <button id="bl" onclick="setOri('landscape')">&#x1F5C2; Horizontal</button>
  <div class="sep"></div>
  <span class="lbl">&#x1F4C1; Archivo:</span>
  <input type="text" id="fn" value="${titleFile}.pdf" oninput="document.title=this.value.replace(/\\.pdf$/i,'')">
  <div class="sep"></div>
  <button onclick="window.close()">&#x2715; Cerrar</button>
  <button class="pri" style="margin-left:auto" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
</div>
<div class="pv"><div class="a4" id="a4">
<div class="print-header"><span>ECM Project</span><span>${ctxEsc}</span><span>${_dd}-${_mm}-${_yy}, ${_hh}:${_mi}</span></div>
<div class="print-footer"><span>Administraci&#243;n</span><span>&#8212;</span><span>P&#225;gina <span id="phf-tot">1</span></span></div>
<h1>${titleEsc}</h1>
<p class="subtitle">${ctxEsc} &middot; ${_dd}-${_mm}-${_yy}, ${_hh}:${_mi}</p>
${html}</div></div>
<script>
  (function(){function _u(){var h=document.getElementById('a4');if(!h)return;var t=Math.max(1,Math.ceil(h.scrollHeight/1120));var el=document.getElementById('phf-tot');if(el)el.textContent='P\\u00E1gina 1 de '+t;}window.addEventListener('beforeprint',_u);_u();})();
  document.title=${JSON.stringify(titleFile)};
  ${PAPER_JS}
  var _ori='portrait';
  function setOri(o){
    if(o)_ori=o; o=_ori;
    var sz=paperSize(o),a=document.getElementById('a4');
    a.style.setProperty('--pw',sz[0]+'mm'); a.style.setProperty('--ph',sz[1]+'mm');
    document.getElementById('bp').classList.toggle('act',o==='portrait');
    document.getElementById('bl').classList.toggle('act',o==='landscape');
    var s=document.getElementById('_ps')||document.createElement('style');
    s.id='_ps';s.textContent='@page{size:'+sz[0]+'mm '+sz[1]+'mm}';document.head.appendChild(s);
  }
  setOri('portrait');
<\/script></body></html>`);
  _docTarget.close();
}

/**
 * Página de reportes de administración (plataforma o empresa).
 * Layout de dos paneles: lista de reportes a la izquierda, vista previa en iframe a la derecha.
 * @param {HTMLElement} main
 * @param {'plataforma'|'empresa'} scope
 */
async function _admReportes(main, scope) {
  const orgName = scope === 'empresa'
    ? (S.orgs.find(o => o.id === S.orgId)?.name || 'Empresa')
    : 'Plataforma';

  const ADM_ITEMS = scope === 'plataforma' ? [
    { ico: '📊', name: 'Resumen de plataforma',           act: 'rptPlatResumen' },
    { ico: '🏢', name: 'Lista de empresas',               act: 'rptEmpresas' },
    { ico: '👥', name: 'Usuarios de la plataforma',       act: 'rptUsuarios' },
    { ico: '🌳', name: 'Estructura de todas las empresas', act: 'rptEstructuraPlat' },
    { ico: '🗂', name: 'Estructura Jerárquica',           act: 'rptEstructuraJer' },
    { ico: '🧾', name: 'Actividad reciente',              act: 'rptActividad' },
  ] : [
    { ico: '📊', name: 'Resumen de empresa',     act: 'rptEmpResumen' },
    { ico: '👥', name: 'Miembros y roles',        act: 'rptMiembros' },
    { ico: '👤', name: 'Usuarios',               act: 'rptEmpUsuarios' },
    { ico: '🌳', name: 'Estructura de proyectos', act: 'rptProyectos' },
    { ico: '🧾', name: 'Auditoría de empresa',    act: 'rptAuditoria' },
  ];

  const body = _pagina(main, {
    title: 'Reportes',
    desc: 'Vista previa e impresión PDF de los reportes de administración.',
    actions: [{ label: '🖨 Imprimir / PDF (A4)', act: 'imprimir', primary: true }],
  });

  const printBtn = /** @type {HTMLButtonElement|null} */ (main.querySelector('[data-act="imprimir"]'));
  if (printBtn) printBtn.disabled = true;

  body.innerHTML = `<div class="adm-rpt-split">
    <nav class="adm-rpt-tree" id="adm-rpt-tree"></nav>
    <div class="adm-rpt-frame-wrap" id="adm-rpt-frame-wrap">
      <div class="adm-rpt-msg">Seleccione un reporte de la lista para ver su vista previa.</div>
    </div>
  </div>`;

  const tree = /** @type {HTMLElement} */ (body.querySelector('#adm-rpt-tree'));
  const frameWrap = /** @type {HTMLElement} */ (body.querySelector('#adm-rpt-frame-wrap'));

  // ── Reportes de administración ─────────────────────────────────────────────
  ADM_ITEMS.forEach(item => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'adm-rpt-item';
    btn.dataset.act = item.act;
    btn.innerHTML = `<span class="adm-rpt-item-ico">${item.ico}</span><span>${_esc(item.name)}</span>`;
    tree.appendChild(btn);
  });

  let _busy = false;

  const _generar = async (act, btn) => {
    if (_busy) return;
    _busy = true;
    tree.querySelectorAll('.adm-rpt-item').forEach(b => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    frameWrap.innerHTML = '<div class="adm-rpt-msg adm-rpt-loading">⏳ Generando vista previa…</div>';
    if (printBtn) printBtn.disabled = true;
    try {
      // ── Reportes de administración (HTML inline) ─────────────────────────
      let html = '', titleRpt = '';
      if (act === 'rptPlatResumen') {
        const [orgs, perfiles, proys, aud] = await Promise.all([
          _get('organizations', { deleted_at: 'is.null', select: 'id,name,status' }),
          _get('profiles', { select: 'id' }),
          _get('projects', { deleted_at: 'is.null', select: 'id' }),
          _get('auditoria', { select: 'id,org_id,user_id,accion,created_at', order: 'created_at.desc', limit: '50' }).catch(() => []),
        ]);
        const pm = await _perfiles(aud.map(/** @type {any} */ (a) => a.user_id));
        const om = new Map(orgs.map(o => [o.id, o.name]));
        titleRpt = 'Resumen de plataforma';
        html = `<div class="stat-row">
          <div class="stat"><div class="stat-val">${orgs.filter(o => o.status !== 'suspended').length}</div><div class="stat-lbl">Empresas activas</div></div>
          <div class="stat"><div class="stat-val">${orgs.filter(o => o.status === 'suspended').length}</div><div class="stat-lbl">Suspendidas</div></div>
          <div class="stat"><div class="stat-val">${perfiles.length}</div><div class="stat-lbl">Usuarios registrados</div></div>
          <div class="stat"><div class="stat-val">${proys.length}</div><div class="stat-lbl">Proyectos</div></div>
        </div>
        <h2>Actividad reciente</h2>
        <table><thead><tr><th>Fecha</th><th>Usuario</th><th>Empresa</th><th>Acción</th></tr></thead><tbody>
          ${aud.map(/** @type {any} */ (a) => `<tr><td>${_esc(_fecha(a.created_at, true))}</td><td>${_esc(_nombre(pm.get(a.user_id)))}</td><td>${_esc(om.get(a.org_id) || '—')}</td><td>${_esc(a.accion || '—')}</td></tr>`).join('')}
        </tbody></table>`;
      } else if (act === 'rptEmpresas') {
        const [orgs, mems, proys] = await Promise.all([
          _get('organizations', { deleted_at: 'is.null', select: 'id,name,status,created_at' }),
          _get('org_memberships', { active: 'eq.true', select: 'org_id,user_id,empresa_role' }),
          _get('projects', { deleted_at: 'is.null', select: 'id,org_id' }),
        ]);
        titleRpt = 'Lista de empresas';
        html = `<table><thead><tr><th>Empresa</th><th>Estado</th><th>Miembros</th><th>Proyectos</th><th>Creada</th></tr></thead><tbody>
          ${orgs.map(o => {
            const memCount = mems.filter(/** @type {any} */ (m) => m.org_id === o.id).length;
            const pryCount = proys.filter(/** @type {any} */ (p) => p.org_id === o.id).length;
            const st = o.status === 'suspended' ? 'Suspendida' : o.status === 'deleted' ? 'Eliminada' : 'Activa';
            return `<tr><td>${_esc(o.name)}</td><td>${_esc(st)}</td><td style="text-align:right">${memCount}</td><td style="text-align:right">${pryCount}</td><td>${_esc(_fecha(o.created_at))}</td></tr>`;
          }).join('')}
        </tbody></table>`;
      } else if (act === 'rptUsuarios') {
        const [mems, profs, orgs] = await Promise.all([
          _get('org_memberships', { active: 'eq.true', select: 'id,user_id,org_id,empresa_role,created_at', order: 'created_at.asc' }),
          _get('profiles', { select: 'id,full_name,email' }),
          _get('organizations', { deleted_at: 'is.null', select: 'id,name' }),
        ]);
        const pm = new Map(profs.map(p => [p.id, p]));
        const om = new Map(orgs.map(o => [o.id, o.name]));
        titleRpt = 'Usuarios de la plataforma';
        html = `<table><thead><tr><th>Usuario</th><th>Correo</th><th>Empresa</th><th>Rol</th><th>Desde</th></tr></thead><tbody>
          ${mems.map(m => {
            const p = pm.get(m.user_id) || {};
            return `<tr><td>${_esc(_nombre(p))}</td><td>${_esc(/** @type {any} */ (p).email || '—')}</td><td>${_esc(om.get(m.org_id) || '—')}</td><td>${_esc(ROL_EMP[m.empresa_role] || m.empresa_role)}</td><td>${_esc(_fecha(m.created_at))}</td></tr>`;
          }).join('') || '<tr><td colspan="5" style="color:#9ca3af">Sin usuarios</td></tr>'}
        </tbody></table>`;
      } else if (act === 'rptEstructuraPlat') {
        const [orgs, pfsAll, progsAll, proysAll] = await Promise.all([
          _get('organizations', { deleted_at: 'is.null', select: 'id,name,status', order: 'name.asc' }),
          _get('portfolios', { deleted_at: 'is.null', select: 'id,org_id,name,code', order: 'name.asc' }),
          _get('programs', { deleted_at: 'is.null', select: 'id,org_id,portfolio_id,name,code', order: 'name.asc' }),
          _get('projects', { deleted_at: 'is.null', select: 'id,org_id,program_id,name,code,settings', order: 'name.asc' }),
        ]);
        titleRpt = 'Estructura de todas las empresas';
        const _tColor = { pf: '#f59e0b', prog: '#8b5cf6', proj: '#3b82f6' };
        const _tLabel = { pf: 'Portafolio', prog: 'Programa', proj: 'Proyecto' };
        const _indent = (n) => n > 0 ? `<span style="display:inline-block;width:${n * 20}px"></span>` : '';
        const _erow = (name, code, tipo, nivel) => {
          const color = _tColor[tipo]; const label = _tLabel[tipo];
          return `<tr><td>${_indent(nivel)}<span style="display:inline-block;background:${color};color:#fff;font-size:10px;padding:1px 6px;border-radius:3px;margin-right:6px">${label}</span>${_esc(name)}</td><td style="font-size:11px;color:#6b7280">${_esc(code || '—')}</td></tr>`;
        };
        const _buildEst = (orgId) => {
          const oPfs = pfsAll.filter(p => p.org_id === orgId);
          const oProgs = progsAll.filter(g => g.org_id === orgId);
          const oProys = proysAll.filter(p => p.org_id === orgId);
          const progOf = (p) => p.program_id || p.settings?.program_id || null;
          const pfOf = (p) => { const gid = progOf(p); if (gid) { const g = oProgs.find(x => x.id === gid); return g?.portfolio_id || p.settings?.portfolio_id || null; } return p.settings?.portfolio_id || null; };
          const rows = [];
          const usedProgs = new Set(); const usedProys = new Set();
          for (const pf of oPfs) {
            rows.push(_erow(pf.name, pf.code, 'pf', 1));
            for (const prog of oProgs.filter(g => g.portfolio_id === pf.id)) {
              rows.push(_erow(prog.name, prog.code, 'prog', 2)); usedProgs.add(prog.id);
              for (const proj of oProys.filter(p => progOf(p) === prog.id)) { rows.push(_erow(proj.name, proj.code, 'proj', 3)); usedProys.add(proj.id); }
            }
            for (const proj of oProys.filter(p => !progOf(p) && pfOf(p) === pf.id && !usedProys.has(p.id))) { rows.push(_erow(proj.name, proj.code, 'proj', 2)); usedProys.add(proj.id); }
          }
          for (const prog of oProgs.filter(g => !usedProgs.has(g.id))) {
            rows.push(_erow(prog.name, prog.code, 'prog', 1));
            for (const proj of oProys.filter(p => progOf(p) === prog.id)) { rows.push(_erow(proj.name, proj.code, 'proj', 2)); usedProys.add(proj.id); }
          }
          for (const proj of oProys.filter(p => !usedProys.has(p.id))) rows.push(_erow(proj.name, proj.code, 'proj', 1));
          return rows;
        };
        html = orgs.map(o => {
          const rows = _buildEst(o.id);
          return `<h2 style="margin-top:20px;margin-bottom:4px">🏢 ${_esc(o.name)}</h2>
            ${rows.length
              ? `<table><thead><tr><th>Nombre</th><th>Código</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
              : `<p style="color:#9ca3af;font-size:12px;padding-left:12px">Sin proyectos.</p>`}`;
        }).join('') || '<p style="color:#9ca3af">Sin empresas registradas.</p>';
      } else if (act === 'rptEstructuraJer') {
        const [orgs, pfsAllJ, progsAllJ, proysAllJ, gms] = await Promise.all([
          _get('organizations', { deleted_at: 'is.null', select: 'id,name', order: 'name.asc' }),
          _get('portfolios', { deleted_at: 'is.null', select: 'id,org_id,name,code', order: 'name.asc' }),
          _get('programs', { deleted_at: 'is.null', select: 'id,org_id,portfolio_id,name,code', order: 'name.asc' }),
          _get('projects', { deleted_at: 'is.null', select: 'id,org_id,program_id,name,code,settings', order: 'name.asc' }),
          _get('group_memberships', { group_role: 'eq.administrador', select: 'project_id,user_id' }).catch(() => []),
        ]);
        const profIds = [...new Set(gms.map(g => g.user_id))];
        const pm = profIds.length ? await _perfiles(profIds) : new Map();
        const adminsDe = (pid) => gms.filter(g => g.project_id === pid).map(g => _nombre(pm.get(g.user_id))).filter(Boolean);
        titleRpt = 'Estructura Jerárquica';
        const COL = { org: { bg: '#e8f5e9', bd: '#2e7d32', fg: '#1b5e20', lbl: 'Empresa' }, pf: { bg: '#e3f0fd', bd: '#1976d2', fg: '#0d47a1', lbl: 'Portafolio' }, prog: { bg: '#f3e8ff', bd: '#7b1fa2', fg: '#4a148c', lbl: 'Programa' }, proj: { bg: '#fff8e1', bd: '#ef6c00', fg: '#bf360c', lbl: 'Proyecto' } };
        const _card = (name, tipo, code, admins) => {
          const c = COL[tipo] || COL.proj;
          return `<div style="display:inline-block;min-width:130px;max-width:160px;border:2px solid ${c.bd};border-radius:8px;background:${c.bg};padding:6px 8px;font-size:11px;vertical-align:top;text-align:center">
            <div style="font-size:9px;font-weight:700;letter-spacing:.06em;color:${c.fg};text-transform:uppercase;margin-bottom:3px">${c.lbl}</div>
            <div style="font-weight:600;color:#1e293b;margin-bottom:2px;word-break:break-word">${_esc(name)}</div>
            ${code ? `<div style="font-size:9px;color:#64748b">${_esc(code)}</div>` : ''}
            ${admins.length ? `<div style="font-size:9px;color:#475569;margin-top:3px;border-top:1px solid ${c.bd};padding-top:2px">${_esc(admins[0])}</div>` : ''}
          </div>`;
        };
        const _jerWrap = (items) => items.length ? `<div style="display:flex;flex-direction:row;align-items:flex-start;position:relative"><div style="position:absolute;top:0;left:0;right:0;height:2px;background:#d1d5db"></div>${items.join('')}</div>` : '';
        const _jerConn = (inner) => `<div style="display:inline-flex;flex-direction:column;align-items:center;padding:0 6px"><div style="width:2px;height:16px;background:#d1d5db"></div>${inner}</div>`;
        const _branchOrg = (orgId) => {
          const oPfs = pfsAllJ.filter(p => p.org_id === orgId);
          const oProgs = progsAllJ.filter(g => g.org_id === orgId);
          const oProys = proysAllJ.filter(p => p.org_id === orgId);
          const progOf = (p) => p.program_id || p.settings?.program_id || null;
          const pfOf = (p) => { const gid = progOf(p); if (gid) { const g = oProgs.find(x => x.id === gid); return g?.portfolio_id || p.settings?.portfolio_id || null; } return p.settings?.portfolio_id || null; };
          const usedP = new Set(); const usedJ = new Set();
          const items = [];
          for (const pf of oPfs) {
            const pfProgs = oProgs.filter(g => g.portfolio_id === pf.id);
            const pfProjsD = oProys.filter(p => !progOf(p) && pfOf(p) === pf.id);
            const pfItems = [];
            for (const prog of pfProgs) {
              usedP.add(prog.id);
              const progProjs = oProys.filter(p => progOf(p) === prog.id);
              const ppItems = progProjs.map(proj => { usedJ.add(proj.id); return _jerConn(_card(proj.name, 'proj', proj.code, adminsDe(proj.id))); });
              const progSub = _jerWrap(ppItems);
              pfItems.push(_jerConn(_card(prog.name, 'prog', prog.code, []) + (progSub ? `<div style="width:2px;height:16px;background:#d1d5db"></div>${progSub}` : '')));
            }
            for (const proj of pfProjsD) { usedJ.add(proj.id); pfItems.push(_jerConn(_card(proj.name, 'proj', proj.code, adminsDe(proj.id)))); }
            const pfSub = _jerWrap(pfItems);
            items.push(_jerConn(_card(pf.name, 'pf', pf.code, []) + (pfSub ? `<div style="width:2px;height:16px;background:#d1d5db"></div>${pfSub}` : '')));
          }
          for (const prog of oProgs.filter(g => !usedP.has(g.id))) {
            const ppItems = oProys.filter(p => progOf(p) === prog.id).map(proj => { usedJ.add(proj.id); return _jerConn(_card(proj.name, 'proj', proj.code, adminsDe(proj.id))); });
            const progSub = _jerWrap(ppItems);
            items.push(_jerConn(_card(prog.name, 'prog', prog.code, []) + (progSub ? `<div style="width:2px;height:16px;background:#d1d5db"></div>${progSub}` : '')));
          }
          for (const proj of oProys.filter(p => !usedJ.has(p.id))) items.push(_jerConn(_card(proj.name, 'proj', proj.code, adminsDe(proj.id))));
          return _jerWrap(items);
        };
        html = `<style>.jer-root{page-break-inside:avoid}</style>` + orgs.map(o => {
          const branch = _branchOrg(o.id);
          return `<div class="jer-root" style="margin-bottom:32px">
            <div style="display:flex;flex-direction:column;align-items:center">
              ${_card(o.name, 'org', '', [])}
              ${branch ? `<div style="width:2px;height:16px;background:#d1d5db"></div>
              <div style="overflow-x:auto;width:100%"><div style="display:flex;justify-content:center">${branch}</div></div>` : '<p style="color:#9ca3af;font-size:11px;margin-top:8px">Sin proyectos</p>'}
            </div>
          </div>`;
        }).join('') || '<p style="color:#9ca3af">Sin empresas registradas.</p>';
      } else if (act === 'rptActividad') {
        const aud = await _get('auditoria', { select: 'id,org_id,user_id,accion,created_at', order: 'created_at.desc', limit: '100' }).catch(() => []);
        const orgs = await _get('organizations', { deleted_at: 'is.null', select: 'id,name' });
        const pm = await _perfiles(aud.map(/** @type {any} */ (a) => a.user_id));
        const om = new Map(orgs.map(o => [o.id, o.name]));
        titleRpt = 'Actividad reciente';
        html = `<table><thead><tr><th>Fecha</th><th>Usuario</th><th>Empresa</th><th>Acción</th></tr></thead><tbody>
          ${aud.map(/** @type {any} */ (a) => `<tr><td>${_esc(_fecha(a.created_at, true))}</td><td>${_esc(_nombre(pm.get(a.user_id)))}</td><td>${_esc(om.get(a.org_id) || '—')}</td><td>${_esc(a.accion || '—')}</td></tr>`).join('') || '<tr><td colspan="4" style="color:#9ca3af">Sin actividad registrada.</td></tr>'}
        </tbody></table>`;
      } else if (act === 'rptEmpResumen') {
        const [mems, proys, areas] = await Promise.all([
          _get('org_memberships', { org_id: `eq.${S.orgId}`, active: 'eq.true', select: 'id,empresa_role' }),
          _get('projects', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id,name' }),
          _get('areas', { org_id: `eq.${S.orgId}`, select: 'id' }).catch(() => []),
        ]);
        titleRpt = 'Resumen de empresa';
        html = `<div class="stat-row">
          <div class="stat"><div class="stat-val">${mems.length}</div><div class="stat-lbl">Miembros activos</div></div>
          <div class="stat"><div class="stat-val">${proys.length}</div><div class="stat-lbl">Proyectos</div></div>
          <div class="stat"><div class="stat-val">${areas.length}</div><div class="stat-lbl">Áreas</div></div>
        </div>
        <h2>Proyectos</h2>
        <table><thead><tr><th>#</th><th>Proyecto</th></tr></thead><tbody>
          ${proys.map((p, i) => `<tr><td style="text-align:right;width:40px">${i + 1}</td><td>${_esc(p.name)}</td></tr>`).join('') || '<tr><td colspan="2" style="color:#9ca3af">Sin proyectos</td></tr>'}
        </tbody></table>`;
      } else if (act === 'rptMiembros') {
        const mems = await _get('org_memberships', { org_id: `eq.${S.orgId}`, select: 'id,user_id,empresa_role,active,created_at', order: 'created_at.asc' });
        const pm = await _perfiles(mems.map(m => m.user_id));
        titleRpt = 'Miembros y roles';
        html = `<table><thead><tr><th>Miembro</th><th>Correo</th><th>Rol</th><th>Estado</th><th>Desde</th></tr></thead><tbody>
          ${mems.map(m => {
            const p = pm.get(m.user_id);
            const rol = ROL_EMP[m.empresa_role] || m.empresa_role;
            const est = m.active ? 'Activo' : 'Revocado';
            return `<tr><td>${_esc(_nombre(p))}</td><td>${_esc(p?.email || '—')}</td><td>${_esc(rol)}</td><td>${_esc(est)}</td><td>${_esc(_fecha(m.created_at))}</td></tr>`;
          }).join('') || '<tr><td colspan="5" style="color:#9ca3af">Sin miembros</td></tr>'}
        </tbody></table>`;
      } else if (act === 'rptEmpUsuarios') {
        const mems = await _get('org_memberships', { org_id: `eq.${S.orgId}`, select: 'id,user_id,empresa_role,active,created_at', order: 'created_at.asc' });
        const pm = await _perfiles(mems.map(m => m.user_id));
        titleRpt = 'Usuarios';
        html = `<table><thead><tr><th>Usuario</th><th>Correo</th><th>Rol</th><th>Estado</th><th>Desde</th></tr></thead><tbody>
          ${mems.map(m => {
            const p = pm.get(m.user_id) || {};
            return `<tr><td>${_esc(_nombre(p))}</td><td>${_esc(p?.email || '—')}</td><td>${_esc(ROL_EMP[m.empresa_role] || m.empresa_role)}</td><td>${_esc(m.active ? 'Activo' : 'Revocado')}</td><td>${_esc(_fecha(m.created_at))}</td></tr>`;
          }).join('') || '<tr><td colspan="5" style="color:#9ca3af">Sin usuarios</td></tr>'}
        </tbody></table>`;
      } else if (act === 'rptProyectos') {
        const [pfsE, progsE, proysE] = await Promise.all([
          _get('portfolios', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id,name,code,created_at', order: 'name.asc' }),
          _get('programs', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id,name,code,created_at', order: 'name.asc' }),
          _get('projects', { org_id: `eq.${S.orgId}`, deleted_at: 'is.null', select: 'id,name,code,created_at', order: 'name.asc' }),
        ]);
        titleRpt = 'Estructura de proyectos';
        const rowsE = [
          ...pfsE.map(p => `<tr><td>${_esc(p.name)}</td><td>Portafolio</td><td>${_esc(_fecha(p.created_at))}</td></tr>`),
          ...progsE.map(p => `<tr><td>${_esc(p.name)}</td><td>Programa</td><td>${_esc(_fecha(p.created_at))}</td></tr>`),
          ...proysE.map(p => `<tr><td>${_esc(p.name)}</td><td>Proyecto</td><td>${_esc(_fecha(p.created_at))}</td></tr>`),
        ];
        html = `<table><thead><tr><th>Nombre</th><th>Tipo</th><th>Creado</th></tr></thead><tbody>
          ${rowsE.join('') || '<tr><td colspan="3" style="color:#9ca3af">Sin proyectos</td></tr>'}
        </tbody></table>`;
      } else if (act === 'rptAuditoria') {
        const aud = await _get('auditoria', { org_id: `eq.${S.orgId}`, select: 'id,user_id,accion,created_at', order: 'created_at.desc', limit: '100' }).catch(() => []);
        const pm = await _perfiles(aud.map(/** @type {any} */ (a) => a.user_id));
        titleRpt = 'Auditoría de empresa';
        html = `<table><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th></tr></thead><tbody>
          ${aud.map(/** @type {any} */ (a) => `<tr><td>${_esc(_fecha(a.created_at, true))}</td><td>${_esc(_nombre(pm.get(a.user_id)))}</td><td>${_esc(a.accion || '—')}</td></tr>`).join('') || '<tr><td colspan="3" style="color:#9ca3af">Sin registros</td></tr>'}
        </tbody></table>`;
      }
      if (!html) {
        frameWrap.innerHTML = '<div class="adm-rpt-msg">Reporte no disponible.</div>';
        if (printBtn) printBtn.disabled = false;
        tree.querySelectorAll('.adm-rpt-item').forEach(b => b.classList.remove('is-active'));
        return;
      }
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;background:#f1f5f9';
      frameWrap.innerHTML = '';
      frameWrap.appendChild(frame);
      _printAdmPdf(titleRpt, html, orgName, frame);
      if (printBtn) {
        const _enable = () => { if (printBtn) printBtn.disabled = false; };
        frame.addEventListener('load', _enable, { once: true });
        setTimeout(_enable, 900);
      }
    } catch (e) {
      frameWrap.innerHTML = `<div class="adm-rpt-msg">Error: ${_esc(e?.message || String(e))}</div>`;
      tree.querySelectorAll('.adm-rpt-item').forEach(b => b.classList.remove('is-active'));
    } finally {
      _busy = false;
    }
  };

  tree.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */ (e.target)?.closest?.('.adm-rpt-item');
    if (!btn) return;
    const act = /** @type {HTMLElement} */ (btn).dataset.act || '';
    _generar(act, /** @type {any} */ (btn));
  });

  S.acts.imprimir = () => {
    const frame = /** @type {HTMLIFrameElement|null} */ (frameWrap.querySelector('iframe'));
    const win = frame?.contentWindow;
    if (!win) return;
    const field = /** @type {HTMLInputElement|null} */ (win.document?.querySelector('#fn, #fn-inp'));
    const name = (field?.value || win.document?.title || 'ECM-Admin').replace(/\.pdf$/i, '').trim();
    const prev = document.title;
    document.title = name;
    try { win.print(); } finally { setTimeout(() => { document.title = prev; }, 0); }
  };
}

/** @type {Record<string, Record<string, (main:HTMLElement)=>Promise<void>>>} */
const PAGES = {
  plataforma: {
    resumen: _platResumen, empresas: _platEmpresas, usuarios: _platUsuarios, proyectos: _platProyectos, propietarios: _platPropietarios,
    auditoria: (m) => _auditoria(m, ''), reportes: (m) => _admReportes(m, 'plataforma'),
  },
  empresa: {
    resumen: _empResumen, usuarios: _empUsuarios, proyectos: _empProyectos, areas: _empAreas,
    plantilla: (m) => _matrizPermisos(m, false), auditoria: (m) => _auditoria(m, S.orgId), datos: _empDatos,
    reportes: (m) => _admReportes(m, 'empresa'),
  },
  proyecto: {
    miembros: _proyMiembros, permisos: (m) => _matrizPermisos(m, true), externos: _proyExternos,
  },
};

// ============================================================
// Estilos
// ============================================================
function _injectCss() {
  if (document.getElementById('adm-css')) return;
  const st = document.createElement('style');
  st.id = 'adm-css';
  st.textContent = `
#admin-console{position:fixed;inset:0;z-index:1500;display:flex;flex-direction:column;background:var(--clr-bg,#f7f8fa);color:var(--clr-text,#111827);font-family:var(--font-data,system-ui);font-size:14px}
#admin-console *{box-sizing:border-box}
.adm-top{display:flex;align-items:center;gap:16px;padding:10px 18px;background:var(--clr-surface,#fff);border-bottom:1px solid var(--clr-border,#d1d5db);min-height:56px}
.adm-brand{font-family:var(--font-ui,system-ui);font-weight:800;font-size:16px;white-space:nowrap}
.adm-scope{display:flex;align-items:center;gap:6px;flex:1;min-width:0;overflow-x:auto}
.adm-crumb{border:1px solid transparent;background:none;border-radius:8px;padding:6px 10px;font:inherit;font-weight:600;color:var(--clr-text-2,#374151);cursor:pointer;white-space:nowrap}
.adm-crumb:hover{background:var(--clr-hover,rgba(0,0,0,.05))}
.adm-crumb.is-active,.adm-crumb-sel.is-active{border-color:var(--clr-primary,#4f46e5);background:var(--clr-primary-l,#ede9fe);color:var(--clr-primary,#4f46e5)}
.adm-crumb-sel{display:flex;align-items:center;gap:6px;border:1px solid var(--clr-border-2,#e5e7eb);border-radius:8px;padding:2px 4px 2px 10px;min-width:0}
.adm-crumb-k{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--clr-text-3,#5b6270);font-weight:700}
.adm-crumb-sel select{border:none;background:transparent;font:inherit;font-weight:600;color:inherit;padding:5px 4px;max-width:340px;cursor:pointer}
.adm-sep{color:var(--clr-text-3,#5b6270)}
.adm-close{border:1px solid var(--clr-border,#d1d5db);background:var(--clr-surface,#fff);color:inherit;border-radius:8px;width:34px;height:34px;cursor:pointer;font-size:14px}
.adm-shell{display:flex;flex:1;min-height:0}
.adm-nav{width:232px;flex-shrink:0;padding:14px 10px;border-right:1px solid var(--clr-border,#d1d5db);background:var(--clr-surface,#fff);overflow-y:auto}
.adm-nav-title{font-family:var(--font-ui,system-ui);font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--clr-text-3,#5b6270);padding:4px 10px 8px}
.adm-nav-item{display:flex;gap:10px;align-items:center;width:100%;text-align:left;border:none;background:none;border-radius:8px;padding:9px 10px;font:inherit;color:var(--clr-text-2,#374151);cursor:pointer;margin-bottom:2px}
.adm-nav-item:hover{background:var(--clr-hover,rgba(0,0,0,.05))}
.adm-nav-item.is-active{background:var(--clr-primary-l,#ede9fe);color:var(--clr-primary,#4f46e5);font-weight:700}
.adm-main{flex:1;min-width:0;overflow:auto;padding:24px 28px 48px;outline:none}
.adm-page-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px;flex-wrap:wrap}
.adm-h1{font-family:var(--font-ui,system-ui);font-size:22px;font-weight:800;margin:0 0 4px}
.adm-h2{font-family:var(--font-ui,system-ui);font-size:16px;font-weight:800;margin:22px 0 10px}
.adm-desc{margin:0;color:var(--clr-text-3,#5b6270);max-width:760px;line-height:1.5}
.adm-page-actions{display:flex;gap:8px;flex-wrap:wrap}
.adm-btn{border:1px solid var(--clr-border,#d1d5db);background:var(--clr-surface,#fff);color:var(--clr-text,#111827);border-radius:8px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;white-space:nowrap}
.adm-btn:hover:not([disabled]){background:var(--clr-surface-2,#f0f2f5)}
.adm-btn[disabled]{opacity:.45;cursor:not-allowed}
.adm-btn-primary{background:var(--clr-primary,#4f46e5);border-color:var(--clr-primary,#4f46e5);color:#fff}
.adm-btn-primary:hover:not([disabled]){background:var(--clr-primary-h,#4338ca)}
.adm-btn-danger{color:var(--clr-error,#c62828);border-color:color-mix(in srgb,var(--clr-error,#c62828) 40%,transparent)}
.adm-btn-danger:hover:not([disabled]){background:var(--clr-error-bg,#ffebee)}
.adm-dlg .adm-btn-danger[type=submit]{background:var(--clr-error,#c62828);color:#fff;border-color:var(--clr-error,#c62828)}
.adm-btn-sm{padding:5px 10px;font-size:12px}
.adm-btn-xs{padding:3px 8px;font-size:11px}
.adm-btn-primary-soft{background:var(--clr-primary-l,#ede9fe);border-color:transparent;color:var(--clr-primary,#4f46e5)}
.adm-btn-danger-soft{color:var(--clr-error,#c62828);border-color:color-mix(in srgb,var(--clr-error,#c62828) 30%,transparent);background:var(--clr-error-bg,#ffebee)}
.adm-cellact{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.adm-tree-cell{display:flex;align-items:center;gap:6px;min-width:260px}
.adm-caret{border:none;background:none;color:var(--clr-text-3,#5b6270);cursor:pointer;width:20px;height:20px;border-radius:4px;font-size:12px;padding:0;flex-shrink:0}
.adm-caret:hover{background:var(--clr-hover,rgba(0,0,0,.05))}
.adm-caret-sp{display:inline-block;width:20px;flex-shrink:0}
.adm-tree-ico{width:20px;text-align:center;flex-shrink:0}
.adm-tree tr.adm-tree-org td{background:var(--clr-surface-2,#f0f2f5);font-size:15px}
.adm-tree tr.adm-tree-pf td:first-child .adm-strong{color:#1976D2}
.adm-tree tr.adm-tree-prog td:first-child .adm-strong{color:#7B1FA2}
.adm-tree tr.adm-tree-proj td:first-child .adm-strong{color:#2E7D32;font-weight:600}
.adm-link{border:none;background:none;color:var(--clr-primary,#4f46e5);font:inherit;font-weight:700;cursor:pointer;padding:0}
.adm-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.adm-in{border:1px solid var(--clr-border,#d1d5db);background:var(--clr-surface,#fff);color:var(--clr-text,#111827);border-radius:8px;padding:8px 10px;font:inherit;max-width:100%}
.adm-in[readonly]{background:var(--clr-surface-2,#f0f2f5);color:var(--clr-text-3,#5b6270)}
.adm-in-sm{padding:4px 8px;font-size:12px}
.adm-search{width:260px}
.adm-count{margin-left:auto;color:var(--clr-text-3,#5b6270);font-size:12px}
.adm-table-wrap{overflow-x:auto;border:1px solid var(--clr-border,#d1d5db);border-radius:10px;background:var(--clr-surface,#fff)}
.adm-table{width:100%;border-collapse:collapse}
.adm-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--clr-text-3,#5b6270);font-weight:700;padding:10px 12px;background:var(--clr-surface-2,#f0f2f5);border-bottom:1px solid var(--clr-border,#d1d5db);white-space:nowrap}
.adm-table td{padding:10px 12px;border-bottom:1px solid var(--clr-border-2,#e5e7eb);vertical-align:middle}
.adm-table tr:last-child td{border-bottom:none}
.adm-table tbody tr:hover{background:var(--clr-selected-bg,#eff6ff)}
.adm-table tr.is-sel{background:var(--clr-primary-l,#ede9fe)}
.adm-chk{width:36px}
.adm-num{text-align:right;font-variant-numeric:tabular-nums}
.adm-nowrap{white-space:nowrap}
.adm-actions{text-align:right;white-space:nowrap}
.adm-actions .adm-btn+.adm-btn{margin-left:6px}
.adm-empty{text-align:center;color:var(--clr-text-3,#5b6270);padding:28px!important}
.adm-strong{font-weight:700}
.adm-sub{font-size:12px;color:var(--clr-text-3,#5b6270)}
.adm-person{display:flex;align-items:center;gap:10px}
.adm-avatar{width:30px;height:30px;border-radius:50%;background:var(--clr-primary,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.adm-badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;white-space:nowrap;background:var(--clr-surface-2,#f0f2f5);color:var(--clr-text-2,#374151);vertical-align:middle}
.adm-badge-ok{background:var(--clr-ok-bg,#e8f5e9);color:var(--clr-ok,#2e7d32)}
.adm-badge-warn{background:var(--clr-warn-bg,#fff8e1);color:var(--clr-warn,#ef6c00)}
.adm-badge-err{background:var(--clr-error-bg,#ffebee);color:var(--clr-error,#c62828)}
.adm-badge-info{background:var(--clr-normal-bg,#e3f0fd);color:var(--clr-normal,#1976D2)}
.adm-badge-gold{background:#fef3c7;color:#92400e}
.adm-badge-violet{background:#f3e8ff;color:#6b21a8}
.adm-kpis{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px}
.adm-kpi{display:flex;align-items:center;gap:7px;background:var(--clr-surface,#fff);border:1px solid var(--clr-border,#d1d5db);border-radius:20px;padding:5px 13px}
.adm-kpi-v{font-family:var(--font-ui,system-ui);font-size:14px;font-weight:700;line-height:1}
.adm-kpi-l{font-size:12px;color:var(--clr-text-2,#374151)}
.adm-kpis .adm-kpi:nth-child(1) .adm-kpi-v{color:#2e7d32}
.adm-kpis .adm-kpi:nth-child(2) .adm-kpi-v{color:#1565c0}
.adm-kpis .adm-kpi:nth-child(3) .adm-kpi-v{color:#6a1fa2}
.adm-kpis .adm-kpi:nth-child(4) .adm-kpi-v{color:#00695c}
.adm-kpi-warn .adm-kpi-v{color:var(--clr-warn,#ef6c00)!important}
.adm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.adm-card{background:var(--clr-surface,#fff);border:1px solid var(--clr-border,#d1d5db);border-radius:10px;padding:14px 16px}
.adm-card-k{font-size:12px;color:var(--clr-text-3,#5b6270);margin-bottom:4px}
.adm-quick{display:flex;gap:10px;flex-wrap:wrap}
.adm-quick-item{border:1px solid var(--clr-border,#d1d5db);background:var(--clr-surface,#fff);color:inherit;border-radius:10px;padding:12px 16px;font:inherit;font-weight:600;cursor:pointer}
.adm-quick-item:hover{border-color:var(--clr-primary,#4f46e5)}
.adm-alert{border-radius:8px;padding:10px 14px;margin:10px 0;line-height:1.5}
.adm-alert[hidden]{display:none}
.adm-alert-warn{background:var(--clr-warn-bg,#fff8e1);color:var(--clr-text,#111827);border:1px solid color-mix(in srgb,var(--clr-warn,#ef6c00) 35%,transparent)}
.adm-alert-err{background:var(--clr-error-bg,#ffebee);color:var(--clr-error,#c62828);border:1px solid color-mix(in srgb,var(--clr-error,#c62828) 35%,transparent)}
.adm-loading,.adm-emptybox{color:var(--clr-text-3,#5b6270);padding:40px;text-align:center;line-height:1.8}
.adm-emptybox{border:1px dashed var(--clr-border,#d1d5db);border-radius:12px;font-size:15px}
.adm-legend{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.adm-lv{padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700}
.adm-lv-editar{background:#dcfce7;color:#166534}
.adm-lv-solo_avance{background:#dbeafe;color:#1e40af}
.adm-lv-solo_ver{background:#f3e8ff;color:#6b21a8}
.adm-lv-sin_acceso{background:#f3f4f6;color:#4b5563}
.adm-lvsel{font-weight:700;border-color:transparent}
.adm-matrix td{padding:6px 8px}
.adm-matrix th:not(:first-child){white-space:normal;min-width:110px}
.adm-matrix td.is-override .adm-lvsel{outline:2px solid var(--clr-primary,#4f46e5);outline-offset:1px}
.adm-dlg{position:fixed;inset:0;margin:auto;height:fit-content;max-height:calc(100dvh - 32px);overflow:auto;border:none;border-radius:14px;padding:0;box-shadow:0 12px 48px rgba(0,0,0,.28);width:min(520px,calc(100vw - 32px));background:var(--clr-surface,#fff);color:var(--clr-text,#111827)}
.adm-dlg::backdrop{background:rgba(15,23,42,.45)}
.adm-dlg-body{padding:22px 24px;font-family:var(--font-data,system-ui);font-size:14px}
.adm-dlg-body .adm-h2{margin:0 0 6px;font-size:18px}
.adm-dlg-body .adm-desc{margin-bottom:14px}
.adm-dlg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.adm-field{margin-bottom:12px}
.adm-field[hidden]{display:none}
.adm-field .adm-in{width:100%}
.adm-lbl{display:block;font-size:12px;font-weight:700;color:var(--clr-text-2,#374151);margin-bottom:4px}
.adm-hint{font-size:12px;color:var(--clr-text-3,#5b6270);margin-top:4px}
.adm-list{margin:6px 0 10px;padding-left:18px;max-height:220px;overflow:auto;line-height:1.6}
.adm-secret{display:grid;gap:10px;background:var(--clr-surface-2,#f0f2f5);border-radius:8px;padding:12px 14px}
.adm-secret code{font-size:18px;font-weight:700;letter-spacing:.06em;user-select:all}
.adm-form{max-width:520px;background:var(--clr-surface,#fff);border:1px solid var(--clr-border,#d1d5db);border-radius:10px;padding:18px 20px}
.adm-form-actions{margin-top:8px}
.adm-toast{position:fixed;right:20px;bottom:20px;padding:10px 16px;border-radius:10px;background:#1f2937;color:#fff;font-weight:600;opacity:0;transform:translateY(8px);transition:all .2s;pointer-events:none;z-index:1600;max-width:min(420px,calc(100vw - 40px))}
.adm-toast.is-show{opacity:1;transform:none}
.adm-toast-err{background:var(--clr-error,#c62828)}
.adm-tabs{display:flex;gap:2px;margin-bottom:14px;border-bottom:2px solid var(--clr-border,#d1d5db)}
.adm-tab-btn{background:none;border:none;border-bottom:2px solid transparent;margin-bottom:-2px;padding:8px 18px;font:inherit;font-size:13px;font-weight:600;color:var(--clr-text-3,#5b6270);cursor:pointer;border-radius:6px 6px 0 0}
.adm-tab-btn:hover{color:var(--clr-text,#111827);background:var(--clr-hover,rgba(0,0,0,.04))}
.adm-tab-btn.is-active{color:var(--clr-primary,#4f46e5);border-bottom-color:var(--clr-primary,#4f46e5)}
.oct-wrap{overflow:auto;padding:8px 4px 16px}
.oct-node{position:absolute;border:1.5px solid;border-radius:9px;padding:8px 10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;box-shadow:0 1px 4px rgba(0,0,0,.09)}
.oct-node-ico{font-size:18px;line-height:1}
.oct-node-nm{font-weight:700;font-size:12px;text-align:center;line-height:1.3;max-width:100%;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.oct-node-tp{font-size:10px;opacity:.7;text-align:center;margin-top:1px}
.oct-node-adm{font-size:10px;text-align:center;opacity:.8;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.oct-node-acts{position:absolute;bottom:-34px;left:50%;transform:translateX(-50%);display:flex;gap:3px;padding:3px 5px;background:var(--clr-surface,#fff);border:1px solid var(--clr-border,#d1d5db);border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.15);opacity:0;pointer-events:none;transition:opacity .15s;z-index:20;white-space:nowrap}
.oct-node:hover .oct-node-acts,.oct-node:focus-within .oct-node-acts{opacity:1;pointer-events:auto}
.oct-act-btn{background:transparent;border:1px solid rgba(0,0,0,.15);border-radius:4px;cursor:pointer;font-size:10px;padding:2px 5px;font-weight:600;line-height:1.4;color:var(--clr-text,#111827)}
.oct-act-btn:hover{background:var(--clr-hover,rgba(0,0,0,.06))}
.oct-act-btn-d{color:#b91c1c;border-color:rgba(185,28,28,.25)}
.oct-node-edit{cursor:pointer}
.oct-node-edit:hover{box-shadow:0 3px 12px rgba(0,0,0,.18)}
.oct-node-edit:focus{outline:2px solid var(--clr-primary,#4f46e5);outline-offset:2px}
.adm-rpt-split{display:flex;border:1px solid var(--clr-border,#d1d5db);border-radius:8px;overflow:hidden;height:calc(100dvh - 240px);min-height:420px}
.adm-rpt-tree{width:220px;flex-shrink:0;overflow-y:auto;padding:8px 6px;border-right:1px solid var(--clr-border,#d1d5db);background:var(--clr-surface,#fff)}
.adm-rpt-item{display:flex;align-items:center;gap:9px;width:100%;text-align:left;border:none;background:none;border-radius:6px;padding:9px 10px;font:inherit;font-size:13px;color:var(--clr-text-2,#374151);cursor:pointer;margin-bottom:2px}
.adm-rpt-item:hover{background:var(--clr-hover,rgba(0,0,0,.05))}
.adm-rpt-item.is-active{background:var(--clr-primary-l,#ede9fe);color:var(--clr-primary,#4f46e5);font-weight:700}
.adm-rpt-item-ico{font-size:16px;flex-shrink:0;width:20px;text-align:center}
.adm-rpt-frame-wrap{flex:1;min-width:0;position:relative;background:var(--clr-surface-2,#f1f5f9)}
.adm-rpt-msg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--clr-text-3,#5b6270);font-size:13px;padding:24px;text-align:center}
@media (max-width:760px){
  .adm-top{flex-wrap:wrap;padding:8px 16px}
  .adm-scope{order:3;flex-basis:100%}
  .adm-shell{flex-direction:column}
  .adm-nav{width:auto;display:flex;overflow-x:auto;border-right:none;border-bottom:1px solid var(--clr-border,#d1d5db);padding:6px 10px}
  .adm-nav-title{display:none}
  .adm-nav-item{width:auto;white-space:nowrap}
  .adm-main{padding:16px}
  .adm-search{width:100%}
  .adm-table{min-width:680px}
  .adm-matrix{min-width:900px}
  .adm-rpt-split{height:calc(100dvh - 200px);min-height:320px}
  .adm-rpt-tree{width:160px}
}`;
  st.id = 'ecm-adm-styles';
  if (!document.getElementById('ecm-adm-styles')) document.head.appendChild(st);
}
