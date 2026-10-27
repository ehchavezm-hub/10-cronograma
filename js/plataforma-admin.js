// @ts-check
/**
 * plataforma-admin.js — Administración de Plataforma ECM Project.
 * Vista de árbol jerárquico colapsable: plataforma → empresas → proyectos → admins.
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

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function _get(tabla, params = {}) {
  const qs = new URLSearchParams({ select: '*', ...params });
  try {
    const r = await fetch(`${REST}/${tabla}?${qs}`, { headers: _hdrs() });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

async function _loadData() {
  const [propRows, orgs, mems, proyectos, grupomems] = await Promise.all([
    _get('profiles', { 'platform_role': 'in.(propietario,co_propietario)', 'select': 'id,full_name,email,platform_role' }),
    _get('organizations', { 'deleted_at': 'is.null', 'select': 'id,name,slug,status' }),
    _get('org_memberships', { 'active': 'eq.true', 'select': 'id,org_id,user_id,empresa_role' }),
    _get('projects', { 'deleted_at': 'is.null', 'select': 'id,org_id,name,code,status' }),
    _get('group_memberships', { 'group_role': 'eq.administrador', 'select': 'id,org_id,project_id,user_id' }),
  ]);

  const perfilMap = new Map(propRows.map(p => [p.id, p]));
  const allIds = new Set([...mems.map(m => m.user_id), ...grupomems.map(g => g.user_id)]);
  const restIds = [...allIds].filter(id => !perfilMap.has(id));
  if (restIds.length) {
    const extra = await _get('profiles', { 'id': `in.(${restIds.join(',')})`, 'select': 'id,full_name,email,platform_role' });
    extra.forEach(p => perfilMap.set(p.id, p));
  }
  return { propRows, orgs, mems, proyectos, grupomems, perfilMap };
}

function _nombre(perfil) {
  return perfil?.full_name || perfil?.email?.split('@')[0] || '—';
}

/* ── Nodos del árbol ─────────────────────────────────── */

const NIVEL = {
  plataforma: { icon: '⚙',  color: '#4f46e5', bg: '#eef2ff', label: 'Plataforma'   },
  propietario:{ icon: '👑', color: '#b45309', bg: '#fef3c7', label: 'Propietario'  },
  co_prop:    { icon: '🔑', color: '#7c3aed', bg: '#f5f3ff', label: 'Co-propietario'},
  empresa:    { icon: '🏢', color: '#0369a1', bg: '#e0f2fe', label: 'Empresa'      },
  proyecto:   { icon: '📋', color: '#047857', bg: '#dcfce7', label: 'Proyecto'     },
  superadmin: { icon: '🛡', color: '#0369a1', bg: '#e0f2fe', label: 'Super Admin'  },
  relevo:     { icon: '🔄', color: '#0e7490', bg: '#ecfeff', label: 'Relevo'       },
  admin:      { icon: '👤', color: '#047857', bg: '#dcfce7', label: 'Administrador'},
};

function _pill(tipo) {
  const m = NIVEL[tipo] || NIVEL.admin;
  return `<span style="font-size:.65rem;font-weight:700;padding:1px 7px;border-radius:20px;color:${m.color};background:${m.bg};border:1px solid ${m.color}22;white-space:nowrap">${m.label}</span>`;
}

function _nodeHtml({ id, depth, icon, label, sublabel, tipo, expanded = true, children = '' }) {
  const indent  = depth * 18;
  const m       = NIVEL[tipo] || NIVEL.admin;
  const hasKids = children !== '';
  const chevron = hasKids
    ? `<span class="pa-chevron" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;cursor:pointer;flex-shrink:0;color:${m.color};font-size:9px;transition:transform .15s;transform:${expanded?'rotate(90deg)':'rotate(0deg)'}">${'▶'}</span>`
    : `<span style="display:inline-block;width:16px;flex-shrink:0"></span>`;

  return `
    <div class="pa-node" data-id="${_esc(id)}" data-depth="${depth}" style="--node-color:${m.color}">
      <div class="pa-node-row" style="display:flex;align-items:center;gap:6px;padding:5px 8px 5px ${4+indent}px;border-radius:6px;cursor:${hasKids?'pointer':'default'};transition:background .12s" ${hasKids?'data-toggle="true"':''}>
        ${chevron}
        <span style="font-size:${14-depth}px;flex-shrink:0">${icon}</span>
        <span style="font-weight:${600-depth*50};font-size:${.9-depth*.04}rem;color:var(--clr-text,#111);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(label)}">${_esc(label)}</span>
        ${sublabel ? `<span style="font-size:.7rem;color:var(--clr-text-3,#999);margin-right:4px;flex-shrink:0">${_esc(sublabel)}</span>` : ''}
        ${_pill(tipo)}
      </div>
      ${hasKids ? `<div class="pa-children" style="display:${expanded?'block':'none'}">${children}</div>` : ''}
    </div>`;
}

function _buildTree(data) {
  const { propRows, orgs, mems, proyectos, grupomems, perfilMap } = data;

  // Personas de plataforma
  const propietarios  = propRows.filter(p => p.platform_role === 'propietario');
  const coProps       = propRows.filter(p => p.platform_role === 'co_propietario');
  const propKids      = [
    ...propietarios.map((p,i) => _nodeHtml({ id:`prop-${i}`, depth:2, icon:NIVEL.propietario.icon, label:_nombre(p), sublabel:p.email||'', tipo:'propietario' })),
    ...coProps.map((p,i)      => _nodeHtml({ id:`coprop-${i}`, depth:2, icon:NIVEL.co_prop.icon,   label:_nombre(p), sublabel:p.email||'', tipo:'co_prop' })),
  ].join('');

  const propietarioNode = _nodeHtml({
    id: 'node-propietario', depth: 1, icon: '👑',
    label: 'Propietarios de Plataforma',
    sublabel: `${propietarios.length+coProps.length} persona${propietarios.length+coProps.length!==1?'s':''}`,
    tipo: 'propietario', expanded: true, children: propKids,
  });

  // Empresas
  const empresaNodes = orgs.map((org, oi) => {
    const orgMems   = mems.filter(m => m.org_id === org.id);
    const admEmp    = orgMems.filter(m => ['super_admin','relevo'].includes(m.empresa_role));
    const proys     = proyectos.filter(p => p.org_id === org.id);

    // Admins de empresa como hijos directos
    const admEmpKids = admEmp.map((m, mi) => {
      const p = perfilMap.get(m.user_id);
      return _nodeHtml({ id:`admEmp-${oi}-${mi}`, depth:3, icon:NIVEL[m.empresa_role]?.icon||'🛡', label:_nombre(p), sublabel:p?.email||'', tipo: m.empresa_role === 'relevo' ? 'relevo' : 'superadmin' });
    }).join('');

    // Proyectos con sus admins
    const proyNodes = proys.map((proy, pi) => {
      const admins = grupomems.filter(g => g.project_id === proy.id);
      const adminKids = admins.map((g, gi) => {
        const pf = perfilMap.get(g.user_id);
        return _nodeHtml({ id:`adminProy-${oi}-${pi}-${gi}`, depth:4, icon:NIVEL.admin.icon, label:_nombre(pf), sublabel:pf?.email||'', tipo:'admin' });
      }).join('') || `<div style="padding:4px 4px 4px ${4+4*18}px;font-size:.73rem;color:var(--clr-text-3,#aaa)">Sin administrador asignado</div>`;

      return _nodeHtml({
        id:`proy-${oi}-${pi}`, depth:3, icon:NIVEL.proyecto.icon,
        label: proy.name,
        sublabel: proy.code || '',
        tipo: 'proyecto', expanded: false, children: adminKids,
      });
    }).join('') || `<div style="padding:4px 4px 4px ${4+3*18}px;font-size:.73rem;color:var(--clr-text-3,#aaa)">Sin proyectos</div>`;

    const empresaChildren = admEmpKids + proyNodes;

    return _nodeHtml({
      id:`empresa-${oi}`, depth:1, icon:NIVEL.empresa.icon,
      label: org.name,
      sublabel: `${proys.length} proy.`,
      tipo: 'empresa', expanded: false,
      children: empresaChildren || `<div style="padding:4px 4px 4px ${4+2*18}px;font-size:.73rem;color:var(--clr-text-3,#aaa)">Sin datos</div>`,
    });
  }).join('');

  const stats = { empresas: orgs.length, proyectos: proyectos.length, usuarios: new Set(mems.map(m=>m.user_id)).size };

  const rootChildren = propietarioNode + empresaNodes;

  const root = _nodeHtml({
    id:'root', depth:0, icon:NIVEL.plataforma.icon,
    label:'Administración', sublabel:'', tipo:'plataforma',
    expanded:true, children: rootChildren,
  });

  return { root, stats };
}

function _bindTree(container) {
  container.addEventListener('click', e => {
    const row = /** @type {HTMLElement} */(e.target)?.closest?.('[data-toggle="true"]');
    if (!row) return;
    const node     = row.closest('.pa-node');
    if (!node) return;
    const kids    = /** @type {HTMLElement|null} */(node.querySelector(':scope > .pa-children'));
    const chevron = /** @type {HTMLElement|null} */(row.querySelector('.pa-chevron'));
    if (!kids) return;
    const open = kids.style.display === 'none';
    kids.style.display = open ? 'block' : 'none';
    if (chevron) chevron.style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)';
  });

  container.addEventListener('mouseover', e => {
    const row = /** @type {HTMLElement} */(e.target)?.closest?.('.pa-node-row');
    if (row) /** @type {HTMLElement} */(row).style.background = 'var(--clr-surface-2,#f0f4ff)';
  });
  container.addEventListener('mouseout', e => {
    const row = /** @type {HTMLElement} */(e.target)?.closest?.('.pa-node-row');
    if (row) /** @type {HTMLElement} */(row).style.background = '';
  });
}

/* ── Diálogo principal ──────────────────────────────── */

export async function showPlataformaAdminPanel() {
  const platRol = authState.perfil?.platform_role || '';
  const empRol  = authState.empresaActual?.empresa_role || '';
  if (!['propietario','co_propietario'].includes(platRol) && empRol !== 'super_admin') return;

  document.getElementById('dlg-plataforma-admin')?.remove();

  const dlg = document.createElement('dialog');
  dlg.id = 'dlg-plataforma-admin';
  dlg.style.cssText = [
    'border:none;border-radius:16px;padding:0;',
    'width:96vw;max-width:960px;height:92vh;',
    'box-shadow:0 24px 80px rgba(0,0,0,.28);',
    'overflow:hidden;position:fixed;top:4vh;margin:0;',
    'left:max(0px,calc(50vw - 480px));z-index:99999',
  ].join('');
  dlg.setAttribute('aria-modal','true');
  dlg.setAttribute('aria-labelledby','pa-title');

  dlg.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%;font-family:var(--font-ui,system-ui);background:var(--clr-bg,#f4f6fb)">
      <!-- Header -->
      <div style="display:flex;align-items:center;gap:12px;padding:12px 18px;background:var(--clr-accent,#4f46e5);flex-shrink:0">
        <div style="width:32px;height:32px;border-radius:8px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:16px">⚙</div>
        <div style="flex:1;min-width:0">
          <h2 id="pa-title" style="margin:0;font-size:.95rem;font-weight:700;color:#fff">Administración de Plataforma</h2>
          <div style="font-size:.7rem;color:rgba(255,255,255,.75);margin-top:1px">ECM Project — Jerarquía del sistema</div>
        </div>
        <div id="pa-stats" style="display:flex;gap:8px"></div>
        <button id="pa-reload" title="Recargar" style="width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center">↻</button>
        <button id="pa-collapseAll" title="Contraer todo" style="width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center">⊟</button>
        <button id="pa-expandAll" title="Expandir todo" style="width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:11px;display:flex;align-items:center;justify-content:center">⊞</button>
        <button id="pa-close" title="Cerrar" style="width:28px;height:28px;border-radius:6px;border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.1);color:#fff;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center">&times;</button>
      </div>
      <!-- Buscador -->
      <div style="padding:10px 16px;background:var(--clr-surface,#fff);border-bottom:1px solid var(--clr-border,#e2e8f0);flex-shrink:0">
        <input id="pa-search" type="search" placeholder="Buscar empresa, proyecto o usuario..." style="width:100%;box-sizing:border-box;padding:6px 12px;border:1px solid var(--clr-border,#e2e8f0);border-radius:8px;font-size:.83rem;background:var(--clr-surface-2,#f8f8ff);color:var(--clr-text,#111);outline:none">
      </div>
      <!-- Árbol -->
      <div id="pa-tree" style="flex:1;overflow-y:auto;padding:14px 16px">
        <div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--clr-text-3,#aaa)">
          <div style="text-align:center"><div style="font-size:2rem">⏳</div><div style="font-size:.88rem;margin-top:8px">Cargando jerarquía...</div></div>
        </div>
      </div>
      <!-- Leyenda -->
      <div style="padding:8px 16px;background:var(--clr-surface,#fff);border-top:1px solid var(--clr-border,#e2e8f0);display:flex;gap:12px;flex-wrap:wrap;flex-shrink:0">
        ${Object.entries(NIVEL).filter(([k])=>!['plataforma'].includes(k)).map(([,m])=>
          `<span style="display:inline-flex;align-items:center;gap:4px;font-size:.7rem;color:var(--clr-text-3,#888)">${m.icon} <span style="color:${m.color};font-weight:600">${m.label}</span></span>`
        ).join('')}
      </div>
    </div>`;

  document.body.appendChild(dlg);

  dlg.querySelector('#pa-close')?.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  const treeEl = /** @type {HTMLElement} */(dlg.querySelector('#pa-tree'));

  function _setAllKids(open) {
    treeEl.querySelectorAll('.pa-children').forEach(el => {
      /** @type {HTMLElement} */(el).style.display = open ? 'block' : 'none';
    });
    treeEl.querySelectorAll('.pa-chevron').forEach(el => {
      /** @type {HTMLElement} */(el).style.transform = open ? 'rotate(90deg)' : 'rotate(0deg)';
    });
  }
  dlg.querySelector('#pa-expandAll')?.addEventListener('click', () => _setAllKids(true));
  dlg.querySelector('#pa-collapseAll')?.addEventListener('click', () => _setAllKids(false));

  // Búsqueda
  dlg.querySelector('#pa-search')?.addEventListener('input', e => {
    const q = /** @type {HTMLInputElement} */(e.target).value.trim().toLowerCase();
    treeEl.querySelectorAll('.pa-node').forEach(node => {
      const row = /** @type {HTMLElement} */(node.querySelector('.pa-node-row'));
      if (!q) { /** @type {HTMLElement} */(node).style.display = ''; if (row) row.style.background = ''; return; }
      const text = node.textContent?.toLowerCase() || '';
      const match = text.includes(q);
      /** @type {HTMLElement} */(node).style.display = match ? '' : 'none';
      if (row) row.style.background = match && q ? 'rgba(79,70,229,.07)' : '';
    });
  });

  async function _render() {
    treeEl.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--clr-text-3,#aaa)"><div style="text-align:center"><div style="font-size:2rem">⏳</div><div style="font-size:.88rem;margin-top:8px">Cargando jerarquía...</div></div></div>`;
    try {
      const data = await _loadData();
      const { root, stats } = _buildTree(data);

      const statsEl = dlg.querySelector('#pa-stats');
      if (statsEl) {
        statsEl.innerHTML = [
          [stats.empresas, 'empresa'],
          [stats.proyectos, 'proyecto'],
          [stats.usuarios, 'usuario'],
        ].map(([v, l]) => `<div style="text-align:center;background:rgba(255,255,255,.14);padding:3px 9px;border-radius:6px"><div style="font-size:.95rem;font-weight:700;color:#fff">${v}</div><div style="font-size:.6rem;color:rgba(255,255,255,.8)">${v!==1?l+'s':l}</div></div>`).join('');
      }

      treeEl.innerHTML = root;
      _bindTree(treeEl);
    } catch (err) {
      treeEl.innerHTML = `<div style="color:#b91c1c;padding:20px;font-size:.88rem">Error al cargar: ${_esc(err?.message||'desconocido')}</div>`;
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
