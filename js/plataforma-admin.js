// @ts-check
/**
 * plataforma-admin.js — Panel de Administración de Plataforma ECM Project.
 * Muestra la jerarquía completa: propietarios, empresas, proyectos y administradores.
 * Visible solo para usuarios con platform_role = 'propietario' o 'co_propietario'.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { authState } from './auth.js?v=180';

const REST = `${SUPABASE_URL}/rest/v1`;

function _hdrs() {
  const token = authState.session?.access_token;
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
  };
}

function _esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function _get(tabla, params = {}) {
  const qs = new URLSearchParams({ select: '*', ...params });
  try {
    const res = await fetch(`${REST}/${tabla}?${qs}`, { headers: _hdrs() });
    if (!res.ok) return [];
    return await res.json();
  } catch { return []; }
}

async function _loadData() {
  const [perfiles, orgs, membresias, proyectos, grupomems] = await Promise.all([
    _get('profiles', { 'platform_role': 'in.(propietario,co_propietario)', 'select': 'id,full_name,email,platform_role' }),
    _get('organizations', { 'deleted_at': 'is.null', 'select': 'id,name,slug,status' }),
    _get('org_memberships', { 'active': 'eq.true', 'select': 'id,org_id,user_id,empresa_role' }),
    _get('projects', { 'deleted_at': 'is.null', 'select': 'id,org_id,name,code,status' }),
    _get('group_memberships', { 'group_role': 'eq.administrador', 'select': 'id,org_id,project_id,user_id,group_role' }),
  ]);

  // Obtener todos los user_ids únicos para cargar nombres
  const allUserIds = new Set([
    ...membresias.map(m => m.user_id),
    ...grupomems.map(g => g.user_id),
    ...perfiles.map(p => p.id),
  ]);

  const idList = [...allUserIds].join(',');
  let todosPerfiles = perfiles;
  if (idList) {
    const extra = await _get('profiles', { 'id': `in.(${idList})`, 'select': 'id,full_name,email,platform_role' });
    const map = new Map(todosPerfiles.map(p => [p.id, p]));
    extra.forEach(p => { if (!map.has(p.id)) map.set(p.id, p); });
    todosPerfiles = [...map.values()];
  }

  const perfilMap = new Map(todosPerfiles.map(p => [p.id, p]));

  return { perfiles, orgs, membresias, proyectos, grupomems, perfilMap };
}

function _rolBadge(rol) {
  const map = {
    propietario:   { label: 'Propietario',   bg: '#4f46e5', color: '#fff' },
    co_propietario:{ label: 'Co-propietario', bg: '#7c3aed', color: '#fff' },
    super_admin:   { label: 'Super Admin',    bg: '#0e7490', color: '#fff' },
    relevo:        { label: 'Relevo',         bg: '#0369a1', color: '#fff' },
    administrador: { label: 'Administrador',  bg: '#047857', color: '#fff' },
    miembro:       { label: 'Miembro',        bg: '#6b7280', color: '#fff' },
  };
  const r = map[rol] || { label: rol || '—', bg: '#d1d5db', color: '#374151' };
  return `<span style="display:inline-block;padding:1px 7px;border-radius:20px;font-size:10px;font-weight:700;background:${r.bg};color:${r.color};letter-spacing:.02em">${_esc(r.label)}</span>`;
}

function _personaRow(perfil, rolBadge = '') {
  if (!perfil) return '<span style="color:var(--clr-text-3,#aaa);font-size:.82rem">—</span>';
  const nombre = perfil.full_name || perfil.email || 'Sin nombre';
  const email  = perfil.email || '';
  return `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0">
      <div style="width:28px;height:28px;border-radius:50%;background:var(--clr-accent,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">
        ${_esc((nombre).substring(0,2).toUpperCase())}
      </div>
      <div style="min-width:0">
        <div style="font-weight:600;font-size:.82rem;color:var(--clr-text,#111)">${_esc(nombre)}</div>
        ${email ? `<div style="font-size:.72rem;color:var(--clr-text-3,#888)">${_esc(email)}</div>` : ''}
      </div>
      ${rolBadge}
    </div>`;
}

function _buildHTML(data) {
  const { perfiles, orgs, membresias, proyectos, grupomems, perfilMap } = data;

  // Propietarios de plataforma
  const propietarios = perfiles.filter(p => p.platform_role === 'propietario');
  const copropietarios = perfiles.filter(p => p.platform_role === 'co_propietario');

  const propHtml = [...propietarios, ...copropietarios].map(p =>
    _personaRow(p, _rolBadge(p.platform_role))
  ).join('') || '<div style="color:var(--clr-text-3,#aaa);font-size:.82rem">Sin propietarios registrados</div>';

  // Construir HTML de empresas
  const empresasHtml = orgs.map(org => {
    // Miembros de esta empresa
    const mems = membresias.filter(m => m.org_id === org.id);
    const superAdmins = mems.filter(m => m.empresa_role === 'super_admin')
      .map(m => _personaRow(perfilMap.get(m.user_id), _rolBadge('super_admin')));
    const relevos = mems.filter(m => m.empresa_role === 'relevo')
      .map(m => _personaRow(perfilMap.get(m.user_id), _rolBadge('relevo')));

    // Proyectos de esta empresa
    const proys = proyectos.filter(p => p.org_id === org.id);
    const proyHtml = proys.map(proy => {
      const admins = grupomems.filter(g => g.project_id === proy.id && g.org_id === org.id)
        .map(g => _personaRow(perfilMap.get(g.user_id), _rolBadge('administrador')));
      return `
        <div style="margin-top:8px;padding:10px 12px;background:var(--clr-surface,#fff);border:1px solid var(--clr-border,#e2e8f0);border-radius:8px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:14px">📋</span>
            <div>
              <span style="font-weight:600;font-size:.85rem;color:var(--clr-text,#111)">${_esc(proy.name)}</span>
              ${proy.code ? `<span style="font-size:.72rem;color:var(--clr-text-3,#888);margin-left:4px">[${_esc(proy.code)}]</span>` : ''}
            </div>
            <span style="margin-left:auto;font-size:.7rem;padding:1px 6px;border-radius:4px;background:${proy.status==='active'?'#dcfce7':'#f3f4f6'};color:${proy.status==='active'?'#166534':'#6b7280'}">${_esc(proy.status||'active')}</span>
          </div>
          ${admins.length
            ? `<div style="padding-left:12px;border-left:2px solid var(--clr-border,#e2e8f0)">${admins.join('')}</div>`
            : `<div style="padding-left:12px;color:var(--clr-text-3,#aaa);font-size:.78rem">Sin administradores asignados</div>`}
        </div>`;
    }).join('');

    const mTotal = mems.length;
    const pTotal = proys.length;

    return `
      <div style="margin-bottom:16px;border:1.5px solid var(--clr-border,#e2e8f0);border-radius:12px;overflow:hidden">
        <div style="padding:12px 16px;background:var(--clr-surface-2,#f8f8ff);display:flex;align-items:center;gap:10px;border-bottom:1px solid var(--clr-border,#e2e8f0)">
          <div style="width:34px;height:34px;border-radius:8px;background:var(--clr-accent,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.85rem;flex-shrink:0">
            ${_esc((org.name||'?').substring(0,2).toUpperCase())}
          </div>
          <div>
            <div style="font-weight:700;font-size:.92rem;color:var(--clr-text,#111)">${_esc(org.name)}</div>
            <div style="font-size:.72rem;color:var(--clr-text-3,#888)">${mTotal} miembro${mTotal!==1?'s':''} · ${pTotal} proyecto${pTotal!==1?'s':''}</div>
          </div>
        </div>
        <div style="padding:12px 16px">
          ${superAdmins.length || relevos.length ? `
            <div style="margin-bottom:10px">
              <div style="font-size:.72rem;font-weight:700;color:var(--clr-text-3,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Administración</div>
              ${superAdmins.join('')}
              ${relevos.join('')}
            </div>` : ''}
          ${proys.length ? `
            <div>
              <div style="font-size:.72rem;font-weight:700;color:var(--clr-text-3,#888);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">Proyectos</div>
              ${proyHtml}
            </div>` : `<div style="color:var(--clr-text-3,#aaa);font-size:.82rem">Sin proyectos</div>`}
        </div>
      </div>`;
  }).join('') || '<div style="color:var(--clr-text-3,#aaa);font-size:.88rem;padding:8px 0">Sin empresas registradas</div>';

  return { propHtml, empresasHtml, totalEmpresas: orgs.length, totalProyectos: proyectos.length };
}

export async function showPlataformaAdminPanel() {
  // Solo propietario / co_propietario
  const platRol = authState.perfil?.platform_role || '';
  if (!['propietario','co_propietario'].includes(platRol)) return;

  // Quitar panel anterior
  document.getElementById('dlg-plataforma-admin')?.remove();

  const dlg = document.createElement('dialog');
  dlg.id = 'dlg-plataforma-admin';
  dlg.style.cssText = 'padding:0;border:none;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.25);max-width:700px;width:94vw;max-height:90vh;overflow:hidden;display:flex;flex-direction:column;';

  dlg.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;font-family:var(--font-ui,system-ui)">
      <div style="padding:20px 24px 16px;border-bottom:1px solid var(--clr-border,#e2e8f0);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:var(--clr-surface,#fff)">
        <div>
          <h2 style="margin:0;font-size:1.1rem;font-weight:700;color:var(--clr-text,#111)">Administración de Plataforma</h2>
          <div style="font-size:.78rem;color:var(--clr-text-3,#888);margin-top:2px">Jerarquía completa del sistema ECM Project</div>
        </div>
        <button id="pa-close" style="width:30px;height:30px;border-radius:50%;border:1px solid var(--clr-border,#e2e8f0);background:var(--clr-surface-2,#f5f5f5);cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;color:var(--clr-text-2,#555)">&times;</button>
      </div>
      <div id="pa-body" style="overflow-y:auto;padding:20px 24px;background:var(--clr-surface,#fff);flex:1">
        <div style="display:flex;align-items:center;justify-content:center;padding:40px 0;color:var(--clr-text-3,#aaa)">
          <span style="font-size:.88rem">Cargando datos...</span>
        </div>
      </div>
    </div>`;

  document.body.appendChild(dlg);
  dlg.querySelector('#pa-close')?.addEventListener('click', () => dlg.close());
  dlg.showModal();

  try {
    const data = await _loadData();
    const { propHtml, empresasHtml, totalEmpresas, totalProyectos } = _buildHTML(data);

    const body = dlg.querySelector('#pa-body');
    if (!body) return;
    body.innerHTML = `
      <!-- Propietarios de plataforma -->
      <section style="margin-bottom:24px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span style="font-size:18px">👑</span>
          <h3 style="margin:0;font-size:.88rem;font-weight:700;color:var(--clr-text,#111);text-transform:uppercase;letter-spacing:.05em">Propietarios de Plataforma</h3>
        </div>
        <div style="padding:12px 14px;background:var(--clr-surface-2,#f8f8ff);border-radius:10px;border:1px solid var(--clr-border,#e2e8f0)">
          ${propHtml}
        </div>
      </section>

      <!-- Resumen -->
      <div style="display:flex;gap:10px;margin-bottom:20px">
        <div style="flex:1;padding:10px 14px;background:var(--clr-accent-light,#eef2ff);border-radius:8px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:var(--clr-accent,#4f46e5)">${totalEmpresas}</div>
          <div style="font-size:.72rem;color:var(--clr-text-3,#888);margin-top:1px">Empresa${totalEmpresas!==1?'s':''}</div>
        </div>
        <div style="flex:1;padding:10px 14px;background:#f0fdf4;border-radius:8px;text-align:center">
          <div style="font-size:1.4rem;font-weight:700;color:#166534">${totalProyectos}</div>
          <div style="font-size:.72rem;color:var(--clr-text-3,#888);margin-top:1px">Proyecto${totalProyectos!==1?'s':''}</div>
        </div>
      </div>

      <!-- Empresas -->
      <section>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
          <span style="font-size:18px">🏢</span>
          <h3 style="margin:0;font-size:.88rem;font-weight:700;color:var(--clr-text,#111);text-transform:uppercase;letter-spacing:.05em">Empresas y Proyectos</h3>
        </div>
        ${empresasHtml}
      </section>`;
  } catch (err) {
    const body = dlg.querySelector('#pa-body');
    if (body) body.innerHTML = `<div style="color:#b91c1c;font-size:.88rem;padding:12px">Error al cargar datos: ${_esc(err?.message||'Error desconocido')}</div>`;
  }
}
