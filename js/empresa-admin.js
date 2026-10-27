// @ts-check
/**
 * empresa-admin.js — Panel de administración de empresa.
 *
 * Secciones:
 *   1. Datos de la empresa (nombre, slug)
 *   2. Áreas (listar, crear, renombrar, eliminar)
 *   3. Permisos por área × módulo (plantilla de empresa)
 *   4. Historial de auditoría
 *
 * Solo accesible a super_admin y relevo.
 */

import { authState } from './auth.js?v=180';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const REST = `${SUPABASE_URL}/rest/v1`;

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

async function _insert(tabla, row) {
  const res = await fetch(`${REST}/${tabla}`, {
    method: 'POST', headers: _hdrs(),
    body: JSON.stringify(row),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `HTTP ${res.status}`); }
  return res.json().catch(() => null);
}

async function _patch(tabla, id, campos) {
  const res = await fetch(`${REST}/${tabla}?id=eq.${id}`, {
    method: 'PATCH', headers: _hdrs(),
    body: JSON.stringify(campos),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `HTTP ${res.status}`); }
  return res.json().catch(() => null);
}

async function _delete(tabla, id) {
  const res = await fetch(`${REST}/${tabla}?id=eq.${id}`, {
    method: 'DELETE', headers: _hdrs(),
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.message || `HTTP ${res.status}`); }
}

// ============================================================
// Módulos del sistema (7 módulos ECM Project)
// ============================================================
const MODULOS = [
  { key: 'cronograma',  label: 'Cronograma / EDT / Gantt' },
  { key: 'calendarios', label: 'Calendarios / Recursos' },
  { key: 'lineas_base', label: 'Líneas base' },
  { key: 'lookahead',   label: 'Lookahead / LPS' },
  { key: 'evm',         label: 'EVM / Curva S' },
  { key: 'riesgos',     label: 'Riesgos / MC / DCMA' },
  { key: 'reportes',    label: 'Reportes PDF' },
];

const NIVELES = ['editar', 'solo_avance', 'solo_ver', 'sin_acceso'];
const NIVEL_LABEL = { editar: 'Editar', solo_avance: 'Solo avance', solo_ver: 'Solo ver', sin_acceso: 'Sin acceso' };
const NIVEL_COLOR = { editar: '#16a34a', solo_avance: '#2563eb', solo_ver: '#9333ea', sin_acceso: '#9ca3af' };

// ============================================================
// Formulario crear empresa (onboarding)
// ============================================================
function _mostrarFormCrearEmpresa() {
  document.getElementById('dlg-crear-empresa')?.remove();
  const dlg = document.createElement('dialog');
  dlg.id = 'dlg-crear-empresa';
  dlg.innerHTML = `
<div style="background:var(--clr-surface,#fff);border-radius:16px;padding:32px;width:min(420px,90vw);font-family:var(--font-ui,system-ui)">
  <h2 style="margin:0 0 8px;font-size:1.2rem;font-weight:700;color:var(--clr-text,#111)">Crear empresa</h2>
  <p style="margin:0 0 20px;font-size:.85rem;color:var(--clr-text-3,#666)">Configura el nombre de tu organización para comenzar.</p>
  <div id="cre-error" role="alert" style="display:none;background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:.85rem;color:#b91c1c"></div>
  <label style="display:block;font-size:.82rem;font-weight:600;color:var(--clr-text-2,#444);margin-bottom:4px">Nombre de la empresa</label>
  <input id="cre-nombre" type="text" placeholder="Ej: Constructora Pérez SAC"
    style="width:100%;box-sizing:border-box;padding:9px 12px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:8px;font-size:.9rem;margin-bottom:20px;background:var(--clr-input-bg,#f9fafb);color:var(--clr-text,#111)">
  <div style="display:flex;gap:10px">
    <button id="cre-cancel" style="flex:1;padding:10px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:8px;background:none;font-size:.9rem;cursor:pointer;color:var(--clr-text,#111)">Cancelar</button>
    <button id="cre-submit" style="flex:2;padding:10px;border:none;border-radius:8px;background:var(--clr-accent,#4f46e5);color:#fff;font-size:.9rem;font-weight:600;cursor:pointer">Crear empresa</button>
  </div>
  <p id="cre-loading" style="display:none;text-align:center;margin-top:10px;font-size:.85rem;color:var(--clr-text-3,#666)">Creando empresa…</p>
</div>`;
  document.body.appendChild(dlg);

  dlg.querySelector('#cre-cancel')?.addEventListener('click', () => dlg.close());
  dlg.querySelector('#cre-submit')?.addEventListener('click', async () => {
    const nombre = dlg.querySelector('#cre-nombre')?.value?.trim();
    const errEl  = dlg.querySelector('#cre-error');
    const loadEl = dlg.querySelector('#cre-loading');
    const submitEl = dlg.querySelector('#cre-submit');
    if (!nombre) { if (errEl) { errEl.textContent = 'Ingresa el nombre de la empresa'; errEl.style.display = ''; } return; }
    if (errEl) errEl.style.display = 'none';
    if (loadEl) loadEl.style.display = '';
    if (submitEl) submitEl.disabled = true;
    try {
      const userId = authState.user?.id;
      if (!userId) throw new Error('Usuario no autenticado');
      // slug único
      const slug = nombre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now();
      // 1. Crear organización
      const orgRows = await _insert('organizations', { name: nombre, slug, owner_id: userId });
      const orgId = Array.isArray(orgRows) ? orgRows[0]?.id : orgRows?.id;
      if (!orgId) throw new Error('No se pudo obtener el ID de la empresa creada');
      // 2. Crear membresía como super_admin
      await _insert('org_memberships', { org_id: orgId, user_id: userId, empresa_role: 'super_admin', active: true });
      window.location.reload();
    } catch (e) {
      if (errEl) { errEl.textContent = e.message || 'Error al crear empresa. Intenta de nuevo.'; errEl.style.display = ''; }
      if (loadEl) loadEl.style.display = 'none';
      if (submitEl) submitEl.disabled = false;
    }
  });

  dlg.showModal();
}

// ============================================================
// Panel principal
// ============================================================
let _panelEl = null;

export async function showEmpresaAdminPanel() {
  const rol = authState.empresaActual?.empresa_role;
  const sinEmpresa = authState.empresas.length === 0;
  if (!sinEmpresa && !['super_admin', 'relevo'].includes(rol)) {
    alert('Solo el Super Admin o Relevo pueden acceder a la configuración de empresa.');
    return;
  }
  if (sinEmpresa) {
    _mostrarFormCrearEmpresa();
    return;
  }

  if (!_panelEl) {
    _panelEl = document.createElement('div');
    _panelEl.id = 'panel-empresa-admin';
    _panelEl.setAttribute('role', 'dialog');
    _panelEl.setAttribute('aria-modal', 'true');
    _panelEl.setAttribute('aria-label', 'Configuración de empresa');
    _panelEl.style.cssText = 'display:none;position:fixed;inset:0;z-index:900;background:rgba(0,0,0,.4)';
    document.body.appendChild(_panelEl);
  }

  await _renderPanel('areas');
  _panelEl.style.display = '';
}

async function _renderPanel(tab = 'areas') {
  if (!_panelEl) return;
  const empresa = authState.empresaActual;

  const tabs = [
    { key: 'areas',     label: 'Áreas' },
    { key: 'permisos',  label: 'Permisos por área' },
    { key: 'proyectos', label: 'Proyectos' },
    { key: 'auditoria', label: 'Auditoría' },
  ];

  _panelEl.innerHTML = `
<div style="
  position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  background:var(--clr-surface,#fff);border-radius:16px;
  width:min(860px,96vw);max-height:92vh;overflow:hidden;
  display:flex;flex-direction:column;
  box-shadow:0 8px 40px rgba(0,0,0,.22);
  font-family:var(--font-ui,system-ui);
">
  <!-- Header -->
  <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid var(--clr-border,#e2e8f0);flex-shrink:0">
    <div>
      <h2 style="margin:0;font-size:1.1rem;font-weight:700;color:var(--clr-text,#111)">⚙ Configuración — ${_esc(empresa?.org_name)}</h2>
      <p style="margin:2px 0 0;font-size:.78rem;color:var(--clr-text-3,#666)">Administración de la empresa</p>
    </div>
    <button id="ea-btn-close" style="padding:7px 12px;background:none;border:1.5px solid var(--clr-border,#d1d5db);border-radius:8px;font-size:.85rem;cursor:pointer;color:var(--clr-text,#111)">✕</button>
  </div>

  <!-- Tabs -->
  <div style="display:flex;gap:4px;padding:10px 24px 0;border-bottom:1px solid var(--clr-border,#e2e8f0);flex-shrink:0">
    ${tabs.map(t => `
      <button data-tab="${t.key}" style="
        padding:7px 14px;border:none;background:none;cursor:pointer;
        font-size:.85rem;font-weight:600;
        color:${tab === t.key ? 'var(--clr-accent,#4f46e5)' : 'var(--clr-text-2,#555)'};
        border-bottom:2px solid ${tab === t.key ? 'var(--clr-accent,#4f46e5)' : 'transparent'};
        margin-bottom:-1px;
      ">${t.label}</button>
    `).join('')}
  </div>

  <!-- Body -->
  <div id="ea-body" style="overflow-y:auto;padding:20px 24px;flex:1"></div>
</div>`;

  _panelEl.querySelector('#ea-btn-close')?.addEventListener('click', () => { _panelEl.style.display = 'none'; });
  _panelEl.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => _renderPanel(btn.dataset.tab));
  });

  const body = _panelEl.querySelector('#ea-body');
  if (!body) return;

  if (tab === 'areas')     await _renderAreas(body);
  if (tab === 'permisos')  await _renderPermisos(body);
  if (tab === 'proyectos') await _renderProyectos(body);
  if (tab === 'auditoria') await _renderAuditoria(body);
}

// ============================================================
// Tab: Áreas
// ============================================================
async function _renderAreas(container) {
  const orgId = authState.empresaActual?.org_id;
  let areas = [];
  try { areas = await _get('areas', { 'org_id': `eq.${orgId}`, 'order': 'sort_order.asc,name.asc' }); } catch {}

  container.innerHTML = `
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
  <h3 style="margin:0;font-size:.95rem;font-weight:700;color:var(--clr-text,#111)">Áreas de la empresa</h3>
  <button id="ea-btn-nueva-area" style="padding:6px 14px;background:var(--clr-accent,#4f46e5);color:#fff;border:none;border-radius:7px;font-size:.83rem;font-weight:600;cursor:pointer">+ Nueva área</button>
</div>
<p style="margin:0 0 14px;font-size:.82rem;color:var(--clr-text-3,#666)">
  Las áreas definen los grupos funcionales de tu empresa. Cada área tiene una plantilla de permisos por módulo.
</p>
<div id="ea-areas-list">
  ${areas.length === 0 ? '<p style="color:var(--clr-text-3,#666);font-size:.87rem">No hay áreas configuradas aún.</p>' : ''}
  ${areas.map(a => `
    <div data-area-id="${a.id}" style="
      display:flex;align-items:center;gap:10px;
      padding:10px 14px;border:1px solid var(--clr-border,#e2e8f0);
      border-radius:9px;margin-bottom:6px;
    ">
      <div style="flex:1;font-size:.88rem;font-weight:600;color:var(--clr-text,#111)">${_esc(a.name)}</div>
      ${a.is_default ? '<span style="font-size:.73rem;color:var(--clr-text-3,#888);background:var(--clr-surface-2,#f5f5f5);border-radius:4px;padding:2px 7px">plantilla</span>' : ''}
      <button data-action="rename-area" data-id="${a.id}" data-name="${_esc(a.name)}"
        style="padding:4px 9px;border:1px solid var(--clr-border,#d1d5db);border-radius:6px;background:none;font-size:.77rem;cursor:pointer;color:var(--clr-text-2,#444)">Renombrar</button>
      <button data-action="delete-area" data-id="${a.id}" data-name="${_esc(a.name)}"
        style="padding:4px 9px;border:1px solid #fca5a5;border-radius:6px;background:none;font-size:.77rem;cursor:pointer;color:#b91c1c">Eliminar</button>
    </div>
  `).join('')}
</div>
<div id="ea-nueva-area-form" style="display:none;margin-top:14px;padding:14px;background:var(--clr-surface-2,#f8f8ff);border-radius:10px">
  <label style="display:block;font-size:.82rem;font-weight:600;color:var(--clr-text-2,#444);margin-bottom:4px">Nombre del área</label>
  <div style="display:flex;gap:8px">
    <input id="ea-nueva-area-input" type="text" placeholder="Ej: Control de Gestión"
      style="flex:1;padding:8px 10px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:7px;font-size:.87rem;background:var(--clr-input-bg,#fff);color:var(--clr-text,#111)">
    <button id="ea-nueva-area-save" style="padding:8px 14px;background:var(--clr-accent,#4f46e5);color:#fff;border:none;border-radius:7px;font-size:.87rem;font-weight:600;cursor:pointer">Guardar</button>
    <button id="ea-nueva-area-cancel" style="padding:8px 10px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:7px;background:none;font-size:.87rem;cursor:pointer;color:var(--clr-text,#111)">Cancelar</button>
  </div>
</div>`;

  container.querySelector('#ea-btn-nueva-area')?.addEventListener('click', () => {
    const form = container.querySelector('#ea-nueva-area-form');
    if (form) form.style.display = '';
    container.querySelector('#ea-nueva-area-input')?.focus();
  });

  container.querySelector('#ea-nueva-area-cancel')?.addEventListener('click', () => {
    const form = container.querySelector('#ea-nueva-area-form');
    if (form) form.style.display = 'none';
  });

  container.querySelector('#ea-nueva-area-save')?.addEventListener('click', async () => {
    const name = container.querySelector('#ea-nueva-area-input')?.value.trim();
    if (!name) return;
    try {
      const ord = areas.length + 1;
      await _insert('areas', { org_id: orgId, name, sort_order: ord, is_default: false });
      await _renderAreas(container);
    } catch (e) { alert(e.message); }
  });

  container.querySelectorAll('[data-action="rename-area"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id   = btn.dataset.id;
      const name = btn.dataset.name;
      const nuevo = prompt(`Nuevo nombre para "${name}":`, name);
      if (!nuevo || nuevo === name) return;
      try { await _patch('areas', id, { name: nuevo.trim() }); await _renderAreas(container); } catch (e) { alert(e.message); }
    });
  });

  container.querySelectorAll('[data-action="delete-area"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name;
      if (!confirm(`¿Eliminar el área "${name}"? Se eliminarán también sus permisos configurados.`)) return;
      try { await _delete('areas', btn.dataset.id); await _renderAreas(container); } catch (e) { alert(e.message); }
    });
  });
}

// ============================================================
// Tab: Permisos por área × módulo
// ============================================================
async function _renderPermisos(container) {
  const orgId = authState.empresaActual?.org_id;
  let areas = [];
  let permisos = [];
  try {
    [areas, permisos] = await Promise.all([
      _get('areas', { 'org_id': `eq.${orgId}`, 'order': 'sort_order.asc,name.asc' }),
      _get('permisos', { 'org_id': `eq.${orgId}`, 'project_id': 'is.null' }),
    ]);
  } catch {}

  // Mapa de permisos: area_id × modulo → {id, nivel}
  const permisoMap = {};
  permisos.forEach(p => {
    if (!permisoMap[p.area_id]) permisoMap[p.area_id] = {};
    permisoMap[p.area_id][p.modulo] = { id: p.id, nivel: p.nivel };
  });

  container.innerHTML = `
<div style="margin-bottom:14px">
  <h3 style="margin:0 0 4px;font-size:.95rem;font-weight:700;color:var(--clr-text,#111)">Permisos por área y módulo</h3>
  <p style="margin:0;font-size:.81rem;color:var(--clr-text-3,#666)">
    Define qué puede hacer cada área en cada módulo. Estos son los permisos de la empresa (plantilla base). Pueden ser sobreescritos por proyecto en los grupos.
  </p>
</div>
<div style="overflow-x:auto">
<table style="width:100%;border-collapse:collapse;font-size:.82rem;min-width:600px">
  <thead>
    <tr style="border-bottom:2px solid var(--clr-border,#e2e8f0)">
      <th style="text-align:left;padding:8px 10px;font-weight:700;color:var(--clr-text,#111);width:160px">Área</th>
      ${MODULOS.map(m => `<th style="text-align:center;padding:8px 4px;font-weight:600;color:var(--clr-text-2,#444);font-size:.77rem;white-space:nowrap">${m.label}</th>`).join('')}
    </tr>
  </thead>
  <tbody>
    ${areas.map(a => `
      <tr style="border-bottom:1px solid var(--clr-border,#f0f0f0)">
        <td style="padding:8px 10px;font-weight:600;color:var(--clr-text,#111);white-space:nowrap">${_esc(a.name)}</td>
        ${MODULOS.map(m => {
          const p = permisoMap[a.id]?.[m.key];
          const nivel = p?.nivel || 'sin_acceso';
          return `<td style="text-align:center;padding:6px 4px">
            <select data-area="${a.id}" data-modulo="${m.key}" data-perm-id="${p?.id || ''}"
              style="
                padding:3px 4px;border:1.5px solid var(--clr-border,#d1d5db);border-radius:5px;
                font-size:.75rem;cursor:pointer;background:var(--clr-surface,#fff);
                color:${NIVEL_COLOR[nivel]};font-weight:600;
              ">
              ${NIVELES.map(n => `<option value="${n}" ${n === nivel ? 'selected' : ''} style="color:${NIVEL_COLOR[n]}">${NIVEL_LABEL[n]}</option>`).join('')}
            </select>
          </td>`;
        }).join('')}
      </tr>
    `).join('')}
  </tbody>
</table>
</div>
<div style="margin-top:16px;display:flex;gap:10px">
  <button id="ea-permisos-save" style="padding:8px 18px;background:var(--clr-accent,#4f46e5);color:#fff;border:none;border-radius:7px;font-size:.87rem;font-weight:600;cursor:pointer">Guardar cambios</button>
  <span id="ea-permisos-msg" style="font-size:.83rem;align-self:center"></span>
</div>`;

  container.querySelector('#ea-permisos-save')?.addEventListener('click', async () => {
    const msgEl = container.querySelector('#ea-permisos-msg');
    const selects = container.querySelectorAll('select[data-area]');
    const ops = [];

    selects.forEach(sel => {
      const areaId  = sel.dataset.area;
      const modulo  = sel.dataset.modulo;
      const permId  = sel.dataset.permId;
      const nivel   = sel.value;
      ops.push({ areaId, modulo, permId, nivel });
    });

    if (msgEl) msgEl.textContent = 'Guardando…';
    let errCount = 0;
    for (const op of ops) {
      try {
        if (op.permId) {
          await _patch('permisos', op.permId, { nivel: op.nivel });
        } else {
          const rows = await _insert('permisos', {
            org_id: orgId, area_id: op.areaId, project_id: null,
            modulo: op.modulo, nivel: op.nivel,
          });
          // Actualizar data-perm-id en el select para futuros guardados
          const sel2 = container.querySelector(`select[data-area="${op.areaId}"][data-modulo="${op.modulo}"]`);
          if (sel2 && rows?.[0]?.id) sel2.dataset.permId = rows[0].id;
        }
      } catch { errCount++; }
    }
    if (msgEl) {
      msgEl.textContent = errCount ? `${errCount} errores al guardar` : '✓ Guardado';
      msgEl.style.color = errCount ? '#b91c1c' : '#16a34a';
    }
  });

  // Colorear selects al cambiar
  container.querySelectorAll('select[data-area]').forEach(sel => {
    sel.addEventListener('change', () => {
      sel.style.color = NIVEL_COLOR[sel.value] || '';
    });
  });
}

// ============================================================
// Tab: Proyectos (vista y gestión de miembros por proyecto)
// ============================================================
async function _renderProyectos(container) {
  const orgId = authState.empresaActual?.org_id;
  let proyectos = [];
  try {
    proyectos = await _get('projects', {
      'org_id': `eq.${orgId}`,
      'deleted_at': 'is.null',
      'order': 'name.asc',
      'select': 'id,name,code,status,start_date',
    });
  } catch {}

  container.innerHTML = `
<h3 style="margin:0 0 14px;font-size:.95rem;font-weight:700;color:var(--clr-text,#111)">Proyectos de la empresa</h3>
<p style="margin:0 0 12px;font-size:.81rem;color:var(--clr-text-3,#666)">
  Lista de proyectos registrados en esta empresa. Los proyectos se crean desde el panel principal con la empresa activa seleccionada.
</p>
<div style="overflow-x:auto">
<table style="width:100%;border-collapse:collapse;font-size:.83rem;min-width:400px">
  <thead>
    <tr style="border-bottom:2px solid var(--clr-border,#e2e8f0)">
      <th style="text-align:left;padding:7px 10px;font-weight:600;color:var(--clr-text-2,#444)">Proyecto</th>
      <th style="text-align:left;padding:7px 10px;font-weight:600;color:var(--clr-text-2,#444)">Código</th>
      <th style="text-align:left;padding:7px 10px;font-weight:600;color:var(--clr-text-2,#444)">Estado</th>
      <th style="text-align:left;padding:7px 10px;font-weight:600;color:var(--clr-text-2,#444)">Inicio</th>
    </tr>
  </thead>
  <tbody>
    ${proyectos.length === 0
      ? `<tr><td colspan="4" style="padding:14px 10px;color:var(--clr-text-3,#666)">No hay proyectos registrados en esta empresa aún. Crea uno desde el panel principal con esta empresa seleccionada.</td></tr>`
      : proyectos.map(p => `
        <tr style="border-bottom:1px solid var(--clr-border,#f0f0f0)">
          <td style="padding:7px 10px;font-weight:600;color:var(--clr-text,#111)">${_esc(p.name)}</td>
          <td style="padding:7px 10px;color:var(--clr-text-3,#666)">${_esc(p.code || '—')}</td>
          <td style="padding:7px 10px">
            <span style="
              font-size:.73rem;padding:2px 7px;border-radius:4px;
              background:${p.status === 'active' ? '#dcfce7' : '#f3f4f6'};
              color:${p.status === 'active' ? '#15803d' : '#6b7280'};
              font-weight:600;
            ">${p.status === 'active' ? 'Activo' : 'Inactivo'}</span>
          </td>
          <td style="padding:7px 10px;color:var(--clr-text-3,#666)">${p.start_date || '—'}</td>
        </tr>
      `).join('')}
  </tbody>
</table>
</div>`;
}

// ============================================================
// Tab: Auditoría
// ============================================================
async function _renderAuditoria(container) {
  const orgId = authState.empresaActual?.org_id;
  let rows = [];
  try {
    rows = await _get('auditoria', {
      'org_id': `eq.${orgId}`,
      'order':  'created_at.desc',
      'limit':  '100',
      'select': 'id,accion,tabla,registro_id,detalle,created_at,profiles(full_name)',
    });
  } catch {}

  container.innerHTML = `
<h3 style="margin:0 0 14px;font-size:.95rem;font-weight:700;color:var(--clr-text,#111)">Historial de auditoría</h3>
<div style="overflow-x:auto">
<table style="width:100%;border-collapse:collapse;font-size:.81rem;min-width:500px">
  <thead>
    <tr style="border-bottom:2px solid var(--clr-border,#e2e8f0)">
      <th style="text-align:left;padding:7px 10px;font-weight:600;color:var(--clr-text-2,#444);white-space:nowrap">Fecha/hora</th>
      <th style="text-align:left;padding:7px 10px;font-weight:600;color:var(--clr-text-2,#444)">Usuario</th>
      <th style="text-align:left;padding:7px 10px;font-weight:600;color:var(--clr-text-2,#444)">Acción</th>
      <th style="text-align:left;padding:7px 10px;font-weight:600;color:var(--clr-text-2,#444)">Detalle</th>
    </tr>
  </thead>
  <tbody>
    ${rows.length === 0 ? `<tr><td colspan="4" style="padding:14px 10px;color:var(--clr-text-3,#666)">Sin registros de auditoría aún.</td></tr>` : ''}
    ${rows.map(r => {
      const fecha = r.created_at ? new Date(r.created_at).toLocaleString('es-PE', { dateStyle:'short', timeStyle:'short' }) : '—';
      const usuario = r.profiles?.full_name || '—';
      const detalle = r.detalle ? JSON.stringify(r.detalle).substring(0, 80) : '';
      return `
        <tr style="border-bottom:1px solid var(--clr-border,#f0f0f0)">
          <td style="padding:7px 10px;white-space:nowrap;color:var(--clr-text-3,#666)">${fecha}</td>
          <td style="padding:7px 10px;color:var(--clr-text,#111)">${_esc(usuario)}</td>
          <td style="padding:7px 10px"><code style="background:var(--clr-surface-2,#f5f5f5);border-radius:4px;padding:1px 5px;font-size:.78rem">${_esc(r.accion)}</code></td>
          <td style="padding:7px 10px;color:var(--clr-text-3,#666);font-family:monospace;font-size:.77rem">${_esc(detalle)}</td>
        </tr>`;
    }).join('')}
  </tbody>
</table>
</div>`;
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
