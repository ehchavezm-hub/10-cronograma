// @ts-check
/**
 * plataforma-admin.js — Pantalla de Administración de Plataforma ECM Project.
 * Pantalla completa con jerarquía: propietarios → empresas → proyectos → administradores.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { authState } from './auth.js?v=181';

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
  const [propietarioRows, orgs, membresias, proyectos, grupomems] = await Promise.all([
    _get('profiles', { 'platform_role': 'in.(propietario,co_propietario)', 'select': 'id,full_name,email,platform_role' }),
    _get('organizations', { 'deleted_at': 'is.null', 'select': 'id,name,slug,status,created_at' }),
    _get('org_memberships', { 'active': 'eq.true', 'select': 'id,org_id,user_id,empresa_role' }),
    _get('projects', { 'deleted_at': 'is.null', 'select': 'id,org_id,name,code,status,start_date' }),
    _get('group_memberships', { 'group_role': 'eq.administrador', 'select': 'id,org_id,project_id,user_id' }),
  ]);

  let perfilMap = new Map(propietarioRows.map(p => [p.id, p]));
  const allIds = new Set([...membresias.map(m => m.user_id), ...grupomems.map(g => g.user_id)]);
  const restIds = [...allIds].filter(id => !perfilMap.has(id));
  if (restIds.length) {
    const extra = await _get('profiles', { 'id': `in.(${restIds.join(',')})`, 'select': 'id,full_name,email,platform_role' });
    extra.forEach(p => perfilMap.set(p.id, p));
  }

  return { propietarioRows, orgs, membresias, proyectos, grupomems, perfilMap };
}

const ROL_META = {
  propietario:    { label:'Propietario',    color:'#4f46e5', bg:'#eef2ff' },
  co_propietario: { label:'Co-propietario', color:'#7c3aed', bg:'#f5f3ff' },
  super_admin:    { label:'Super Admin',    color:'#0369a1', bg:'#e0f2fe' },
  relevo:         { label:'Relevo',         color:'#0e7490', bg:'#ecfeff' },
  administrador:  { label:'Administrador',  color:'#047857', bg:'#dcfce7' },
};

function _badge(rol) {
  const m = ROL_META[rol] || { label: rol||'—', color:'#6b7280', bg:'#f3f4f6' };
  return `<span style="display:inline-block;padding:1px 8px;border-radius:20px;font-size:10px;font-weight:700;color:${m.color};background:${m.bg};border:1px solid ${m.color}30">${_esc(m.label)}</span>`;
}

function _persona(perfil, rol) {
  if (!perfil) return '';
  const nombre = perfil.full_name || perfil.email?.split('@')[0] || 'Sin nombre';
  const email  = perfil.email || '';
  const meta   = ROL_META[rol] || { color:'#6b7280' };
  const init   = nombre.trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase() || '??';
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;background:var(--clr-surface,#fff);border:1px solid var(--clr-border,#e8e8f0)">
      <div style="width:30px;height:30px;border-radius:50%;background:${meta.color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0">${_esc(init)}</div>
      <div style="min-width:0;flex:1">
        <div style="font-weight:600;font-size:.83rem;color:var(--clr-text,#111);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(nombre)}</div>
        ${email ? `<div style="font-size:.72rem;color:var(--clr-text-3,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(email)}</div>` : ''}
      </div>
      ${_badge(rol)}
    </div>`;
}

function _buildContent(data) {
  const { propietarioRows, orgs, membresias, proyectos, grupomems, perfilMap } = data;

  const propietarios = propietarioRows.filter(p => p.platform_role === 'propietario');
  const coProps      = propietarioRows.filter(p => p.platform_role === 'co_propietario');

  const plataformaHtml = `
    <section id="pa-sec-plataforma">
      <h3 style="margin:0 0 12px;font-size:.78rem;font-weight:700;color:var(--clr-text-3,#888);text-transform:uppercase;letter-spacing:.06em">Propietarios de Plataforma</h3>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${propietarios.map(p => _persona(p, 'propietario')).join('')}
        ${coProps.map(p => _persona(p, 'co_propietario')).join('')}
        ${!propietarios.length && !coProps.length ? '<div style="font-size:.83rem;color:var(--clr-text-3,#aaa);padding:8px 0">Sin propietarios registrados en la plataforma</div>' : ''}
      </div>
    </section>`;

  const empresasSecs = orgs.map(org => {
    const mems    = membresias.filter(m => m.org_id === org.id);
    const admEmp  = mems.filter(m => ['super_admin','relevo'].includes(m.empresa_role));
    const proys   = proyectos.filter(p => p.org_id === org.id);

    const adminHtml = admEmp.map(m => _persona(perfilMap.get(m.user_id), m.empresa_role)).join('')
      || '<div style="font-size:.78rem;color:var(--clr-text-3,#aaa);padding:2px 0">Sin administradores de empresa</div>';

    const proysHtml = proys.map(proy => {
      const admins = grupomems.filter(g => g.project_id === proy.id);
      return `
        <div style="padding:10px 12px;background:var(--clr-surface-2,#f8f8ff);border-radius:8px;border:1px solid var(--clr-border,#e8e8f0)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:${admins.length ? 8 : 0}px">
            <span style="font-size:14px;flex-shrink:0">📋</span>
            <span style="font-weight:600;font-size:.83rem;color:var(--clr-text,#111);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(proy.name)}</span>
            ${proy.code ? `<span style="font-size:.72rem;color:var(--clr-text-3,#888)">[${_esc(proy.code)}]</span>` : ''}
            <span style="font-size:.7rem;padding:1px 6px;border-radius:4px;background:${proy.status==='active'?'#dcfce7':'#f3f4f6'};color:${proy.status==='active'?'#166534':'#6b7280'};font-weight:600;flex-shrink:0">${_esc(proy.status||'active')}</span>
          </div>
          ${admins.length
            ? `<div style="padding-left:14px;border-left:2px solid var(--clr-border,#e2e8f0);display:flex;flex-direction:column;gap:5px">${admins.map(g => _persona(perfilMap.get(g.user_id), 'administrador')).join('')}</div>`
            : '<div style="padding-left:14px;font-size:.75rem;color:var(--clr-text-3,#aaa)">Sin administrador asignado</div>'}
        </div>`;
    }).join('');

    const initials = (org.name||'?').substring(0,2).toUpperCase();
    return `
      <section id="pa-sec-org-${_esc(org.id)}" style="margin-bottom:24px;scroll-margin-top:16px">
        <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--clr-accent-light,#eef2ff);border-radius:10px 10px 0 0;border:1.5px solid var(--clr-accent,#4f46e5);border-bottom:none">
          <div style="width:36px;height:36px;border-radius:8px;background:var(--clr-accent,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:.85rem;flex-shrink:0">${_esc(initials)}</div>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:.95rem;color:var(--clr-text,#111)">${_esc(org.name)}</div>
            <div style="font-size:.72rem;color:var(--clr-text-3,#888)">${mems.length} miembro${mems.length!==1?'s':''} · ${proys.length} proyecto${proys.length!==1?'s':''}</div>
          </div>
          <span style="font-size:.72rem;padding:2px 8px;border-radius:4px;background:${org.status==='active'?'#dcfce7':'#f3f4f6'};color:${org.status==='active'?'#166534':'#6b7280'};font-weight:600">${_esc(org.status||'active')}</span>
        </div>
        <div style="padding:14px 16px;background:var(--clr-surface,#fff);border:1.5px solid var(--clr-accent,#4f46e5);border-top:1px solid var(--clr-border,#e2e8f0);border-radius:0 0 10px 10px">
          <div style="margin-bottom:${proys.length ? 14 : 0}px">
            <div style="font-size:.72rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Administración de empresa</div>
            <div style="display:flex;flex-direction:column;gap:5px">${adminHtml}</div>
          </div>
          ${proys.length ? `
          <div>
            <div style="font-size:.72rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Proyectos</div>
            <div style="display:flex;flex-direction:column;gap:8px">${proysHtml}</div>
          </div>` : '<div style="font-size:.8rem;color:var(--clr-text-3,#aaa)">Sin proyectos en esta empresa</div>'}
        </div>
      </section>`;
  }).join('');

  const stats = {
    empresas: orgs.length,
    proyectos: proyectos.length,
    usuarios: new Set(membresias.map(m=>m.user_id)).size,
  };

  return { plataformaHtml, empresasSecs, orgs, stats };
}

export async function showPlataformaAdminPanel() {
  const platRol = authState.perfil?.platform_role || '';
  const empRol  = authState.empresaActual?.empresa_role || '';
  if (!['propietario','co_propietario'].includes(platRol) && empRol !== 'super_admin') return;

  document.getElementById('dlg-plataforma-admin')?.remove();

  const dlg = document.createElement('dialog');
  dlg.id = 'dlg-plataforma-admin';
  dlg.style.cssText = [
    'border:none;border-radius:16px;padding:0;',
    'width:96vw;max-width:1200px;height:92vh;',
    'box-shadow:0 24px 80px rgba(0,0,0,.28);',
    'overflow:hidden;position:fixed;top:4vh;margin:0;',
    'left:max(0px,calc(50vw - 600px));z-index:99999',
  ].join('');
  dlg.setAttribute('aria-modal','true');
  dlg.setAttribute('aria-labelledby','pa-dlg-title');

  dlg.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;font-family:var(--font-ui,system-ui);background:var(--clr-bg,#f4f6fb)">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:14px;padding:14px 22px;background:var(--clr-accent,#4f46e5);flex-shrink:0">
        <div style="width:34px;height:34px;border-radius:8px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0">⚙</div>
        <div style="flex:1;min-width:0">
          <h2 id="pa-dlg-title" style="margin:0;font-size:.98rem;font-weight:700;color:#fff">Administración de Plataforma</h2>
          <div style="font-size:.72rem;color:rgba(255,255,255,.75);margin-top:1px">ECM Project — Jerarquía completa del sistema</div>
        </div>
        <div id="pa-stats" style="display:flex;gap:10px;margin-right:6px"></div>
        <button id="pa-reload" title="Recargar datos" style="width:30px;height:30px;border-radius:7px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center">↻</button>
        <button id="pa-close" title="Cerrar" style="width:30px;height:30px;border-radius:7px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center">&times;</button>
      </div>
      <!-- Body -->
      <div style="display:flex;flex:1;overflow:hidden">
        <!-- Nav lateral -->
        <div id="pa-nav" style="width:200px;flex-shrink:0;overflow-y:auto;padding:14px 0;background:var(--clr-surface,#fff);border-right:1px solid var(--clr-border,#e2e8f0)">
          <div style="padding:0 12px 6px;font-size:.68rem;font-weight:700;color:var(--clr-text-3,#aaa);text-transform:uppercase;letter-spacing:.06em">Secciones</div>
          <button class="pa-nav-btn" data-target="pa-sec-plataforma" style="display:flex;align-items:center;gap:7px;width:100%;padding:8px 14px;border:none;background:var(--clr-accent-light,#eef2ff);cursor:pointer;font-size:.82rem;font-weight:600;color:var(--clr-accent,#4f46e5);text-align:left;border-left:3px solid var(--clr-accent,#4f46e5)"><span>👑</span>Propietarios</button>
          <div id="pa-nav-orgs" style="margin-top:10px">
            <div style="padding:4px 14px 2px;font-size:.68rem;font-weight:700;color:var(--clr-text-3,#aaa);text-transform:uppercase;letter-spacing:.06em">Empresas</div>
            <div style="padding:6px 14px;font-size:.78rem;color:var(--clr-text-3,#aaa)">Cargando...</div>
          </div>
        </div>
        <!-- Contenido -->
        <div id="pa-content" style="flex:1;overflow-y:auto;padding:22px 28px">
          <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--clr-text-3,#aaa)">
            <div style="text-align:center"><div style="font-size:2rem">⏳</div><div style="font-size:.88rem;margin-top:8px">Cargando datos de plataforma...</div></div>
          </div>
        </div>
      </div>
    </div>`;

  document.body.appendChild(dlg);

  dlg.querySelector('#pa-close')?.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  // Navegación interna
  dlg.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */(e.target)?.closest?.('.pa-nav-btn');
    if (!btn) return;
    const targetId = btn.getAttribute('data-target');
    if (!targetId) return;
    dlg.querySelectorAll('.pa-nav-btn').forEach(b => {
      const active = b === btn;
      /** @type {HTMLButtonElement} */(b).style.background = active ? 'var(--clr-accent-light,#eef2ff)' : 'none';
      /** @type {HTMLButtonElement} */(b).style.color = active ? 'var(--clr-accent,#4f46e5)' : 'var(--clr-text,#333)';
      /** @type {HTMLButtonElement} */(b).style.fontWeight = active ? '600' : '400';
      /** @type {HTMLButtonElement} */(b).style.borderLeft = active ? '3px solid var(--clr-accent,#4f46e5)' : '3px solid transparent';
    });
    dlg.querySelector('#' + targetId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  dlg.showModal();

  async function _render() {
    const content = /** @type {HTMLElement|null} */(dlg.querySelector('#pa-content'));
    const navOrgs = dlg.querySelector('#pa-nav-orgs');
    const statsEl = dlg.querySelector('#pa-stats');
    if (!content) return;

    try {
      const data = await _loadData();
      const { plataformaHtml, empresasSecs, orgs, stats } = _buildContent(data);

      if (statsEl) {
        statsEl.innerHTML = [
          [stats.empresas, 'empresa' + (stats.empresas!==1?'s':'')],
          [stats.proyectos, 'proyecto' + (stats.proyectos!==1?'s':'')],
          [stats.usuarios, 'usuario' + (stats.usuarios!==1?'s':'')],
        ].map(([v, l]) => `
          <div style="text-align:center;background:rgba(255,255,255,.14);padding:4px 10px;border-radius:7px">
            <div style="font-size:1rem;font-weight:700;color:#fff">${v}</div>
            <div style="font-size:.62rem;color:rgba(255,255,255,.8);white-space:nowrap">${l}</div>
          </div>`).join('');
      }

      content.innerHTML = `
        <div style="max-width:800px;margin:0 auto">
          <div style="margin-bottom:28px">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
              <span style="font-size:20px">👑</span>
              <h3 style="margin:0;font-size:.95rem;font-weight:700;color:var(--clr-text,#111)">Propietarios de Plataforma</h3>
            </div>
            ${plataformaHtml}
          </div>
          <div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
              <span style="font-size:20px">🏢</span>
              <h3 style="margin:0;font-size:.95rem;font-weight:700;color:var(--clr-text,#111)">Empresas y Proyectos</h3>
            </div>
            ${empresasSecs || '<div style="color:var(--clr-text-3,#aaa);font-size:.88rem">Sin empresas registradas</div>'}
          </div>
        </div>`;

      if (navOrgs) {
        navOrgs.innerHTML = `<div style="padding:4px 14px 4px;font-size:.68rem;font-weight:700;color:var(--clr-text-3,#aaa);text-transform:uppercase;letter-spacing:.06em">Empresas</div>` +
          (orgs.length
            ? orgs.map(org => `
              <button class="pa-nav-btn" data-target="pa-sec-org-${_esc(org.id)}" style="display:flex;align-items:center;gap:7px;width:100%;padding:7px 14px;border:none;background:none;cursor:pointer;font-size:.8rem;color:var(--clr-text,#333);text-align:left;border-left:3px solid transparent;overflow:hidden">
                <span style="flex-shrink:0">🏢</span>
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${_esc(org.name)}</span>
              </button>`).join('')
            : '<div style="padding:4px 14px;font-size:.78rem;color:var(--clr-text-3,#aaa)">Sin empresas</div>');

        navOrgs.querySelectorAll('.pa-nav-btn').forEach(btn => {
          btn.addEventListener('mouseenter', () => { /** @type {HTMLButtonElement} */(btn).style.background = 'var(--clr-surface-2,#f0f0ff)'; });
          btn.addEventListener('mouseleave', () => { if (!btn.getAttribute('style')?.includes('accent-light')) /** @type {HTMLButtonElement} */(btn).style.background = 'none'; });
        });
      }

    } catch (err) {
      content.innerHTML = `<div style="color:#b91c1c;padding:20px;font-size:.88rem">Error al cargar: ${_esc(err?.message||'desconocido')}</div>`;
    }
  }

  await _render();
  dlg.querySelector('#pa-reload')?.addEventListener('click', _render);
}

export function updateAdminSectionVisibility() {
  const platRol = authState.perfil?.platform_role || '';
  const empRol  = authState.empresaActual?.empresa_role || '';
  const visible = ['propietario','co_propietario'].includes(platRol) || empRol === 'super_admin';
  const section = document.getElementById('admin-section');
  if (section) section.style.display = visible ? '' : 'none';
}
