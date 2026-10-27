// @ts-check
/**
 * plataforma-admin.js — Administración de Plataforma ECM Project.
 * Panel estilo enterprise: árbol navegador izquierdo + panel de detalle derecho.
 * Inspirado en GitLab Admin / Azure DevOps / Linear.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { authState } from './auth.js?v=181';

const REST = `${SUPABASE_URL}/rest/v1`;

function _hdrs() {
  const tok = authState.session?.access_token;
  return { 'Content-Type':'application/json', 'apikey': SUPABASE_ANON_KEY,
    ...(tok ? { 'Authorization': `Bearer ${tok}` } : {}) };
}
function _esc(s) {
  return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
async function _get(t, p={}) {
  const qs = new URLSearchParams({ select:'*', ...p });
  try { const r = await fetch(`${REST}/${t}?${qs}`,{headers:_hdrs()}); if(!r.ok)return[]; return r.json(); }
  catch { return []; }
}

async function _loadData() {
  const [propRows, orgs, mems, proyectos, grupomems] = await Promise.all([
    _get('profiles',        { 'platform_role':'in.(propietario,co_propietario)', 'select':'id,full_name,email,platform_role' }),
    _get('organizations',   { 'deleted_at':'is.null', 'select':'id,name,slug,status,created_at' }),
    _get('org_memberships', { 'active':'eq.true', 'select':'id,org_id,user_id,empresa_role' }),
    _get('projects',        { 'deleted_at':'is.null', 'select':'id,org_id,name,code,status,start_date' }),
    _get('group_memberships',{ 'group_role':'eq.administrador', 'select':'id,org_id,project_id,user_id' }),
  ]);
  const perfilMap = new Map(propRows.map(p=>[p.id,p]));
  const allIds = new Set([...mems.map(m=>m.user_id),...grupomems.map(g=>g.user_id)]);
  const restIds = [...allIds].filter(id=>!perfilMap.has(id));
  if (restIds.length) {
    const extra = await _get('profiles',{ 'id':`in.(${restIds.join(',')})`, 'select':'id,full_name,email,platform_role' });
    extra.forEach(p=>perfilMap.set(p.id,p));
  }
  return { propRows, orgs, mems, proyectos, grupomems, perfilMap };
}

/* ── helpers visuales ──────────────────────────────────────── */

const ROL = {
  propietario:    { label:'Propietario',    clr:'#b45309', bg:'#fef3c7' },
  co_propietario: { label:'Co-propietario', clr:'#7c3aed', bg:'#f5f3ff' },
  super_admin:    { label:'Super Admin',    clr:'#0369a1', bg:'#e0f2fe' },
  relevo:         { label:'Relevo',         clr:'#0e7490', bg:'#ecfeff' },
  administrador:  { label:'Administrador',  clr:'#047857', bg:'#dcfce7' },
};

function _badge(rol) {
  const m = ROL[rol]||{ label:rol||'—', clr:'#6b7280', bg:'#f3f4f6' };
  return `<span style="padding:2px 8px;border-radius:20px;font-size:.68rem;font-weight:700;color:${m.clr};background:${m.bg};border:1px solid ${m.clr}22;white-space:nowrap">${m.label}</span>`;
}

function _avatar(nombre, rol) {
  const m   = ROL[rol]||{ clr:'#6b7280' };
  const ini = (nombre||'?').trim().split(/\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase();
  return `<div style="width:32px;height:32px;border-radius:50%;background:${m.clr};color:#fff;display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:700;flex-shrink:0">${_esc(ini||'?')}</div>`;
}

function _personRow(perfil, rol, extra='') {
  const nombre = perfil?.full_name || perfil?.email?.split('@')[0] || '—';
  const email  = perfil?.email || '';
  return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:8px;background:var(--clr-surface,#fff);border:1px solid var(--clr-border,#e8e8f0)">
    ${_avatar(nombre,rol)}
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;font-size:.82rem;color:var(--clr-text,#111);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(nombre)}</div>
      ${email?`<div style="font-size:.7rem;color:var(--clr-text-3,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(email)}</div>`:''}
    </div>
    ${_badge(rol)}${extra}
  </div>`;
}

/* ── Árbol de navegación (izquierda) ───────────────────────── */

function _buildNav(data) {
  const { propRows, orgs, mems, proyectos } = data;
  let html = '';

  // Raíz plataforma
  html += `<div class="pa-nav-item pa-nav-root pa-nav-sel" data-key="platform" style="display:flex;align-items:center;gap:7px;padding:8px 12px;border-radius:8px;cursor:pointer;user-select:none;background:var(--pa-sel-bg,#eef2ff)">
    <span style="font-size:13px">⚙</span>
    <span style="flex:1;font-weight:700;font-size:.82rem;color:var(--pa-sel-clr,#4f46e5)">Plataforma</span>
    <span style="font-size:.68rem;color:var(--clr-text-3,#aaa)">${propRows.length}</span>
  </div>`;

  // Empresas
  orgs.forEach((org,oi) => {
    const proys = proyectos.filter(p=>p.org_id===org.id);
    const hasPrj = proys.length > 0;
    html += `<div class="pa-nav-group" data-orgidx="${oi}" style="margin-top:2px">
      <div class="pa-nav-item pa-nav-empresa" data-key="empresa-${org.id}" data-orgidx="${oi}"
        style="display:flex;align-items:center;gap:7px;padding:8px 12px;border-radius:8px;cursor:pointer;user-select:none">
        <span class="pa-nav-chevron" style="font-size:8px;color:var(--clr-text-3,#bbb);transition:transform .15s;transform:rotate(0deg);flex-shrink:0">${hasPrj?'▶':''}</span>
        <span style="font-size:13px">🏢</span>
        <span style="flex:1;font-weight:600;font-size:.82rem;color:var(--clr-text,#222);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(org.name)}</span>
        <span style="font-size:.68rem;color:var(--clr-text-3,#aaa)">${proys.length}</span>
      </div>
      <div class="pa-nav-proys" data-orgidx="${oi}" style="display:none;padding-left:16px">
        ${proys.map(p=>`
          <div class="pa-nav-item pa-nav-proyecto" data-key="proyecto-${p.id}"
            style="display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:8px;cursor:pointer;user-select:none">
            <span style="width:8px;flex-shrink:0"></span>
            <span style="font-size:12px">📋</span>
            <span style="flex:1;font-size:.78rem;color:var(--clr-text,#333);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${_esc(p.name)}">${_esc(p.name)}</span>
          </div>`).join('')}
      </div>
    </div>`;
  });
  return html;
}

/* ── Panel de detalle (derecha) ────────────────────────────── */

function _detailPlatform(data) {
  const { propRows } = data;
  const props = propRows.filter(p=>p.platform_role==='propietario');
  const coProps = propRows.filter(p=>p.platform_role==='co_propietario');
  return `
    <div class="pa-detail-header" style="padding:20px 24px 16px;border-bottom:1px solid var(--clr-border,#e2e8f0)">
      <div style="display:flex;align-items:center;gap:10px">
        <div style="width:36px;height:36px;border-radius:10px;background:#eef2ff;display:flex;align-items:center;justify-content:center;font-size:18px">⚙</div>
        <div>
          <h3 style="margin:0;font-size:1rem;font-weight:700;color:var(--clr-text,#111)">Plataforma</h3>
          <div style="font-size:.72rem;color:var(--clr-text-3,#888);margin-top:1px">${propRows.length} propietario${propRows.length!==1?'s':''} registrados</div>
        </div>
      </div>
    </div>
    <div style="padding:20px 24px;display:flex;flex-direction:column;gap:20px">
      ${props.length?`<div>
        <div style="font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Propietarios</div>
        <div style="display:flex;flex-direction:column;gap:6px">${props.map(p=>_personRow(p,'propietario')).join('')}</div>
      </div>`:''}
      ${coProps.length?`<div>
        <div style="font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Co-propietarios</div>
        <div style="display:flex;flex-direction:column;gap:6px">${coProps.map(p=>_personRow(p,'co_propietario')).join('')}</div>
      </div>`:''}
      ${!propRows.length?'<div style="color:var(--clr-text-3,#aaa);font-size:.85rem">Sin propietarios registrados</div>':''}
    </div>`;
}

function _detailEmpresa(org, data) {
  const { mems, proyectos, grupomems, perfilMap } = data;
  const orgMems  = mems.filter(m=>m.org_id===org.id);
  const admEmp   = orgMems.filter(m=>['super_admin','relevo'].includes(m.empresa_role));
  const miembros = orgMems.filter(m=>!['super_admin','relevo'].includes(m.empresa_role));
  const proys    = proyectos.filter(p=>p.org_id===org.id);
  const initials = (org.name||'?').substring(0,2).toUpperCase();

  const proysHtml = proys.map(proy => {
    const admins = grupomems.filter(g=>g.project_id===proy.id);
    return `<tr style="border-bottom:1px solid var(--clr-border,#f0f0f5)">
      <td style="padding:10px 12px;font-size:.82rem;font-weight:600;color:var(--clr-text,#111)">${_esc(proy.name)}</td>
      <td style="padding:10px 12px;font-size:.72rem;color:var(--clr-text-3,#888)">${_esc(proy.code||'—')}</td>
      <td style="padding:10px 12px">
        <span style="padding:2px 8px;border-radius:4px;font-size:.68rem;font-weight:600;background:${proy.status==='active'?'#dcfce7':'#f3f4f6'};color:${proy.status==='active'?'#166534':'#6b7280'}">${_esc(proy.status||'active')}</span>
      </td>
      <td style="padding:10px 12px">
        ${admins.length
          ? admins.map(g=>{const pf=perfilMap.get(g.user_id);return `<span style="font-size:.75rem;color:var(--clr-text,#333)">${_esc(pf?.full_name||pf?.email?.split('@')[0]||'—')}</span>`;}).join(', ')
          : `<span style="font-size:.72rem;color:var(--clr-text-3,#bbb)">Sin asignar</span>`}
      </td>
    </tr>`;
  }).join('');

  return `
    <div class="pa-detail-header" style="padding:20px 24px 16px;border-bottom:1px solid var(--clr-border,#e2e8f0)">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:40px;height:40px;border-radius:10px;background:var(--clr-accent,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-size:.9rem;font-weight:800;flex-shrink:0">${_esc(initials)}</div>
        <div style="flex:1;min-width:0">
          <h3 style="margin:0;font-size:1rem;font-weight:700;color:var(--clr-text,#111)">${_esc(org.name)}</h3>
          <div style="font-size:.72rem;color:var(--clr-text-3,#888);margin-top:1px">${orgMems.length} miembro${orgMems.length!==1?'s':''} · ${proys.length} proyecto${proys.length!==1?'s':''}</div>
        </div>
        <span style="padding:3px 10px;border-radius:6px;font-size:.7rem;font-weight:600;background:${org.status==='active'?'#dcfce7':'#f3f4f6'};color:${org.status==='active'?'#166534':'#6b7280'}">${_esc(org.status||'active')}</span>
      </div>
    </div>
    <div style="padding:20px 24px;display:flex;flex-direction:column;gap:22px">
      <!-- Admins empresa -->
      <div>
        <div style="font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Administración de empresa</div>
        ${admEmp.length
          ? `<div style="display:flex;flex-direction:column;gap:6px">${admEmp.map(m=>_personRow(perfilMap.get(m.user_id),m.empresa_role)).join('')}</div>`
          : '<div style="font-size:.78rem;color:var(--clr-text-3,#aaa)">Sin administradores asignados</div>'}
      </div>
      <!-- Proyectos tabla -->
      <div>
        <div style="font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Proyectos (${proys.length})</div>
        ${proys.length ? `
        <div style="border:1px solid var(--clr-border,#e2e8f0);border-radius:10px;overflow:hidden">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="background:var(--clr-surface-2,#f8f8ff)">
                <th style="padding:8px 12px;text-align:left;font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.04em">Nombre</th>
                <th style="padding:8px 12px;text-align:left;font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.04em">Código</th>
                <th style="padding:8px 12px;text-align:left;font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.04em">Estado</th>
                <th style="padding:8px 12px;text-align:left;font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.04em">Administrador</th>
              </tr>
            </thead>
            <tbody>${proysHtml}</tbody>
          </table>
        </div>` : '<div style="font-size:.78rem;color:var(--clr-text-3,#aaa)">Sin proyectos en esta empresa</div>'}
      </div>
      <!-- Miembros -->
      ${miembros.length?`<div>
        <div style="font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Miembros (${miembros.length})</div>
        <div style="display:flex;flex-direction:column;gap:6px">${miembros.map(m=>_personRow(perfilMap.get(m.user_id),m.empresa_role)).join('')}</div>
      </div>`:''}
    </div>`;
}

function _detailProyecto(proy, data) {
  const { grupomems, mems, perfilMap } = data;
  const admins  = grupomems.filter(g=>g.project_id===proy.id);
  const orgMems = mems.filter(m=>m.org_id===proy.org_id);

  return `
    <div class="pa-detail-header" style="padding:20px 24px 16px;border-bottom:1px solid var(--clr-border,#e2e8f0)">
      <div style="display:flex;align-items:center;gap:12px">
        <div style="width:36px;height:36px;border-radius:10px;background:#dcfce7;display:flex;align-items:center;justify-content:center;font-size:18px">📋</div>
        <div style="flex:1;min-width:0">
          <h3 style="margin:0;font-size:1rem;font-weight:700;color:var(--clr-text,#111)">${_esc(proy.name)}</h3>
          <div style="font-size:.72rem;color:var(--clr-text-3,#888);margin-top:1px">
            ${proy.code?`Código: ${_esc(proy.code)} · `:''}${admins.length} administrador${admins.length!==1?'es':''}
          </div>
        </div>
        <span style="padding:3px 10px;border-radius:6px;font-size:.7rem;font-weight:600;background:${proy.status==='active'?'#dcfce7':'#f3f4f6'};color:${proy.status==='active'?'#166534':'#6b7280'}">${_esc(proy.status||'active')}</span>
      </div>
    </div>
    <div style="padding:20px 24px;display:flex;flex-direction:column;gap:20px">
      <div>
        <div style="font-size:.7rem;font-weight:700;color:var(--clr-text-3,#999);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Administradores del proyecto</div>
        ${admins.length
          ? `<div style="display:flex;flex-direction:column;gap:6px">${admins.map(g=>_personRow(perfilMap.get(g.user_id),'administrador')).join('')}</div>`
          : '<div style="font-size:.78rem;color:var(--clr-text-3,#aaa)">Sin administrador asignado</div>'}
      </div>
    </div>`;
}

/* ── Vista stats top-level ─────────────────────────────────── */

function _statsBar(data) {
  const { propRows, orgs, mems, proyectos } = data;
  const items = [
    { icon:'👑', label:'Propietarios', val: propRows.length,                clr:'#b45309', bg:'#fef3c7' },
    { icon:'🏢', label:'Empresas',     val: orgs.length,                    clr:'#0369a1', bg:'#e0f2fe' },
    { icon:'📋', label:'Proyectos',    val: proyectos.length,               clr:'#047857', bg:'#dcfce7' },
    { icon:'👥', label:'Miembros',     val: new Set(mems.map(m=>m.user_id)).size, clr:'#6d28d9', bg:'#ede9fe' },
  ];
  return items.map(it=>`
    <div style="flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--clr-surface,#fff);border:1px solid var(--clr-border,#e2e8f0);border-radius:10px">
      <div style="width:34px;height:34px;border-radius:8px;background:${it.bg};display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">${it.icon}</div>
      <div>
        <div style="font-size:1.2rem;font-weight:800;color:var(--clr-text,#111);line-height:1">${it.val}</div>
        <div style="font-size:.68rem;color:var(--clr-text-3,#999);margin-top:2px">${it.label}</div>
      </div>
    </div>`).join('');
}

/* ── Diálogo principal ─────────────────────────────────────── */

export async function showPlataformaAdminPanel() {
  const platRol = authState.perfil?.platform_role || '';
  const empRol  = authState.empresaActual?.empresa_role || '';
  if (!['propietario','co_propietario'].includes(platRol) && empRol !== 'super_admin') return;

  document.getElementById('dlg-plataforma-admin')?.remove();

  const dlg = document.createElement('dialog');
  dlg.id = 'dlg-plataforma-admin';
  dlg.style.cssText = [
    'border:none;border-radius:14px;padding:0;',
    'width:96vw;max-width:1100px;height:92vh;',
    'box-shadow:0 24px 80px rgba(0,0,0,.28);',
    'overflow:hidden;position:fixed;top:4vh;margin:0;',
    'left:max(0px,calc(50vw - 550px));z-index:99999',
  ].join('');
  dlg.setAttribute('aria-modal','true');

  dlg.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;font-family:var(--font-ui,system-ui)">

      <!-- Top bar -->
      <div style="display:flex;align-items:center;gap:12px;padding:0 18px;height:52px;background:var(--clr-accent,#4f46e5);flex-shrink:0">
        <span style="font-size:16px">⚙</span>
        <span style="font-size:.95rem;font-weight:700;color:#fff;flex:1">Administración de Plataforma</span>
        <input id="pa-search" type="search" placeholder="Buscar..." style="width:200px;padding:5px 10px;border:1px solid rgba(255,255,255,.3);border-radius:7px;background:rgba(255,255,255,.12);color:#fff;font-size:.78rem;outline:none;placeholder-color:rgba(255,255,255,.6)">
        <button id="pa-reload" title="Recargar" style="width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;flex-shrink:0">↻</button>
        <button id="pa-close" title="Cerrar" style="width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0">&times;</button>
      </div>

      <!-- Stats bar -->
      <div id="pa-stats" style="display:flex;gap:10px;padding:12px 16px;background:var(--clr-bg,#f4f6fb);border-bottom:1px solid var(--clr-border,#e2e8f0);flex-shrink:0"></div>

      <!-- Body -->
      <div style="display:flex;flex:1;overflow:hidden;background:var(--clr-bg,#f4f6fb)">

        <!-- Sidebar nav -->
        <div id="pa-nav" style="width:240px;flex-shrink:0;overflow-y:auto;padding:10px 8px;background:var(--clr-surface,#fff);border-right:1px solid var(--clr-border,#e2e8f0)">
          <div style="padding:4px 8px 6px;font-size:.65rem;font-weight:700;color:var(--clr-text-3,#bbb);text-transform:uppercase;letter-spacing:.07em">Jerarquía</div>
          <div id="pa-nav-tree" style="display:flex;flex-direction:column;gap:1px">
            <div style="padding:8px;color:var(--clr-text-3,#aaa);font-size:.78rem">Cargando...</div>
          </div>
        </div>

        <!-- Detail panel -->
        <div id="pa-detail" style="flex:1;overflow-y:auto;background:var(--clr-surface,#fff)">
          <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--clr-text-3,#aaa)">
            <div style="text-align:center"><div style="font-size:2.5rem">⏳</div><div style="margin-top:8px;font-size:.88rem">Cargando...</div></div>
          </div>
        </div>
      </div>
    </div>`;

  document.body.appendChild(dlg);

  const navTree  = /** @type {HTMLElement} */(dlg.querySelector('#pa-nav-tree'));
  const detail   = /** @type {HTMLElement} */(dlg.querySelector('#pa-detail'));
  const statsEl  = /** @type {HTMLElement} */(dlg.querySelector('#pa-stats'));
  let _data = null;

  // Paleta variables para ítem seleccionado
  const styleTag = document.createElement('style');
  styleTag.textContent = `.pa-nav-item{--pa-sel-bg:var(--clr-accent-light,#eef2ff);--pa-sel-clr:var(--clr-accent,#4f46e5)}.pa-nav-item:hover{background:var(--clr-surface-2,#f4f4ff)}.pa-nav-sel{background:var(--pa-sel-bg)!important}.pa-nav-sel span:not([style*="font-size:.68"]):not([style*="font-size:8"]):not([style*="font-size:13"]):not([style*="font-size:12"]){color:var(--pa-sel-clr)!important}`;
  dlg.appendChild(styleTag);

  function _selectNode(key, render) {
    dlg.querySelectorAll('.pa-nav-item').forEach(el => el.classList.remove('pa-nav-sel'));
    dlg.querySelector(`[data-key="${key}"]`)?.classList.add('pa-nav-sel');
    detail.innerHTML = render;
  }

  function _bindNav() {
    if (!_data) return;

    navTree.querySelectorAll('.pa-nav-item').forEach(el => {
      el.addEventListener('click', () => {
        const key = el.getAttribute('data-key') || '';
        if (key === 'platform') {
          _selectNode('platform', _detailPlatform(_data));
        } else if (key.startsWith('empresa-')) {
          const orgId = key.replace('empresa-','');
          const org = _data.orgs.find(o=>o.id===orgId);
          if (org) _selectNode(key, _detailEmpresa(org, _data));
          // Toggle proyectos
          const oi = el.closest('.pa-nav-group')?.getAttribute('data-orgidx');
          const proys = navTree.querySelector(`.pa-nav-proys[data-orgidx="${oi}"]`);
          const chev  = /** @type {HTMLElement|null} */(el.querySelector('.pa-nav-chevron'));
          if (proys && /** @type {HTMLElement} */(proys).style.display === 'none') {
            /** @type {HTMLElement} */(proys).style.display = 'block';
            if (chev) chev.style.transform = 'rotate(90deg)';
          } else if (proys) {
            /** @type {HTMLElement} */(proys).style.display = 'none';
            if (chev) chev.style.transform = 'rotate(0deg)';
          }
        } else if (key.startsWith('proyecto-')) {
          const pId = key.replace('proyecto-','');
          const proy = _data.proyectos.find(p=>p.id===pId);
          if (proy) _selectNode(key, _detailProyecto(proy, _data));
        }
      });
    });
  }

  // Búsqueda en nav
  dlg.querySelector('#pa-search')?.addEventListener('input', e => {
    const q = /** @type {HTMLInputElement} */(e.target).value.trim().toLowerCase();
    navTree.querySelectorAll('.pa-nav-item').forEach(el => {
      /** @type {HTMLElement} */(el).style.display =
        !q || (el.textContent||'').toLowerCase().includes(q) ? '' : 'none';
    });
    navTree.querySelectorAll('.pa-nav-proys').forEach(el => {
      const any = [...el.querySelectorAll('.pa-nav-item')].some(i => /** @type {HTMLElement} */(i).style.display !== 'none');
      /** @type {HTMLElement} */(el).style.display = q && any ? 'block' : (q?'none':'none');
    });
  });

  dlg.querySelector('#pa-close')?.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  async function _render() {
    navTree.innerHTML = '<div style="padding:8px;color:var(--clr-text-3,#aaa);font-size:.78rem">Cargando...</div>';
    detail.innerHTML  = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--clr-text-3,#aaa)"><div style="text-align:center"><div style="font-size:2rem">⏳</div><div style="margin-top:8px;font-size:.88rem">Cargando...</div></div></div>';
    try {
      _data = await _loadData();
      statsEl.innerHTML = _statsBar(_data);
      navTree.innerHTML = _buildNav(_data);
      _bindNav();
      // Selección inicial: plataforma
      _selectNode('platform', _detailPlatform(_data));
    } catch (err) {
      detail.innerHTML = `<div style="color:#b91c1c;padding:20px;font-size:.88rem">Error: ${_esc(err?.message||'desconocido')}</div>`;
    }
  }

  dlg.showModal();
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
