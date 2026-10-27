/**
 * connectivity.js — Verificador de conectividad lógica del cronograma.
 * Comprueba que cada actividad tenga al menos una predecesora Y una sucesora.
 */

// ── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
.conn-panel{position:absolute;inset:0;background:var(--clr-bg,#f9fafb);z-index:30;display:flex;flex-direction:column;overflow:hidden}
.conn-panel[hidden]{display:none!important}
.conn-header{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--clr-surface,#fff);border-bottom:1px solid var(--clr-border,#e5e7eb);flex-shrink:0}
.conn-title{font-size:15px;font-weight:700;color:var(--clr-text-1,#111827);flex:1;display:flex;align-items:center;gap:8px}
.conn-icon{font-size:18px}
.conn-meta{font-size:12px;color:var(--clr-text-3,#6b7280);font-family:var(--font-ui,system-ui)}
.conn-close{font-size:13px;padding:4px 10px}
.conn-summary{display:flex;gap:10px;padding:10px 16px;background:var(--clr-surface,#fff);border-bottom:1px solid var(--clr-border-2,#e5e7eb);flex-shrink:0;flex-wrap:wrap}
.conn-chip{display:flex;align-items:center;gap:6px;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;border:1px solid var(--clr-border,#e5e7eb);background:var(--clr-bg,#f9fafb);cursor:pointer;transition:background .15s}
.conn-chip.active{background:var(--clr-primary,#4f46e5);color:#fff;border-color:var(--clr-primary,#4f46e5)}
.conn-chip-ok{color:#2e7d32}
.conn-chip-warn{color:#b45309}
.conn-chip-err{color:#c62828}
.conn-chip.active .conn-chip-ok,.conn-chip.active .conn-chip-warn,.conn-chip.active .conn-chip-err{color:#fff}
.conn-body{flex:1;overflow:auto;padding:12px 16px}
.conn-table{width:100%;border-collapse:collapse;font-size:12px;font-family:var(--font-ui,system-ui)}
.conn-table th{position:sticky;top:0;background:var(--clr-surface,#fff);padding:6px 8px;text-align:left;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--clr-text-3,#6b7280);border-bottom:2px solid var(--clr-border,#e5e7eb);white-space:nowrap;z-index:2}
.conn-table td{padding:5px 8px;border-bottom:1px solid var(--clr-border-2,#e5e7eb);vertical-align:middle}
.conn-table tr:hover td{background:var(--clr-hover,rgba(0,0,0,.03))}
.conn-row-err td{background:rgba(239,68,68,.05)!important}
.conn-row-warn td{background:rgba(245,158,11,.05)!important}
.conn-badge-ok{display:inline-flex;align-items:center;gap:3px;color:#2e7d32;font-weight:600}
.conn-badge-miss{display:inline-flex;align-items:center;gap:3px;color:#c62828;font-weight:600;background:rgba(239,68,68,.1);border-radius:4px;padding:1px 6px}
.conn-links{font-size:11px;color:var(--clr-text-2,#374151);max-width:180px}
.conn-link-item{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conn-status-ok{color:#2e7d32;font-weight:700}
.conn-status-err{color:#c62828;font-weight:700}
.conn-status-warn{color:#b45309;font-weight:700}
.conn-print-btn{font-size:12px;padding:4px 10px}
.conn-row-num{color:var(--clr-text-3,#9ca3af);font-variant-numeric:tabular-nums}
.conn-empty{padding:40px;text-align:center;color:var(--clr-text-3,#9ca3af);font-size:13px}
.conn-filter-bar{display:flex;align-items:center;gap:8px;padding:8px 16px;background:var(--clr-surface,#fff);border-bottom:1px solid var(--clr-border-2,#e5e7eb);flex-shrink:0}
.conn-filter-label{font-size:12px;color:var(--clr-text-3,#6b7280);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.conn-search{flex:1;max-width:260px;font-size:12px;padding:4px 8px;border:1px solid var(--clr-border,#e5e7eb);border-radius:6px;background:var(--clr-bg,#f9fafb);color:var(--clr-text-1,#111827)}
`;

/**
 * @param {Map<string,any>} tasks
 * @param {Map<string,any>} deps
 * @returns {{ rows: ConnRow[], total: number, ok: number, noPred: number, noSucc: number, both: number }}
 */
export function analyzeConnectivity(tasks, deps) {
  const activeTasks = [...tasks.values()].filter(t => !t.deleted_at);
  const activeDeps  = [...deps.values()].filter(d => !d.deleted_at);

  // Índices: predecesoras de una tarea (succ_id → lista de pred_id)
  // sucesoras de una tarea (pred_id → lista de succ_id)
  /** @type {Map<string, {id:string, type:string, lag:number, pred_name:string}[]>} */
  const predMap = new Map();
  /** @type {Map<string, {id:string, type:string, lag:number, succ_name:string}[]>} */
  const succMap = new Map();

  for (const d of activeDeps) {
    const predTask = tasks.get(d.pred_id);
    const succTask = tasks.get(d.succ_id);
    if (!predTask || !succTask) continue;

    if (!predMap.has(d.succ_id)) predMap.set(d.succ_id, []);
    predMap.get(d.succ_id).push({ id: d.pred_id, type: d.type ?? 'FS', lag: d.lag_days ?? 0, pred_name: predTask.name ?? '' });

    if (!succMap.has(d.pred_id)) succMap.set(d.pred_id, []);
    succMap.get(d.pred_id).push({ id: d.succ_id, type: d.type ?? 'FS', lag: d.lag_days ?? 0, succ_name: succTask.name ?? '' });
  }

  // Identificar summaries
  const parentIds = new Set(activeTasks.map(t => t.parent_id).filter(Boolean));

  // Ordenar por WBS
  const sorted = [...activeTasks].sort((a, b) => _wbsSort(a.wbs ?? '', b.wbs ?? ''));

  let ok = 0, noPred = 0, noSucc = 0, both = 0;

  /** @type {ConnRow[]} */
  const rows = sorted.map((t, i) => {
    const isSummary = parentIds.has(t.id);
    const preds = predMap.get(t.id) ?? [];
    const succs = succMap.get(t.id) ?? [];
    const hasPred = preds.length > 0;
    const hasSucc = succs.length > 0;

    let status;
    if (isSummary) {
      status = 'summary';
    } else if (hasPred && hasSucc) {
      status = 'ok'; ok++;
    } else if (!hasPred && !hasSucc) {
      status = 'both'; both++;
    } else if (!hasPred) {
      status = 'noPred'; noPred++;
    } else {
      status = 'noSucc'; noSucc++;
    }

    return { num: i + 1, id: t.id, wbs: t.wbs ?? '', name: t.name ?? '', type: t.type ?? 'task', isSummary, preds, succs, hasPred, hasSucc, status };
  });

  return { rows, total: activeTasks.length, ok, noPred, noSucc, both };
}

/**
 * @typedef {{ num:number, id:string, wbs:string, name:string, type:string, isSummary:boolean,
 *   preds:{id:string,type:string,lag:number,pred_name:string}[],
 *   succs:{id:string,type:string,lag:number,succ_name:string}[],
 *   hasPred:boolean, hasSucc:boolean, status:string }} ConnRow
 */

function _wbsSort(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ── Panel visual ─────────────────────────────────────────────────────────────
export class ConnectivityPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    this._el = container;
    this._filter = 'all'; // all | issues | noPred | noSucc | both
    this._search = '';
    this._result = null;
    this._inject();
  }

  _inject() {
    if (!document.getElementById('conn-style')) {
      const s = document.createElement('style');
      s.id = 'conn-style';
      s.textContent = CSS;
      document.head.appendChild(s);
    }

    this._el.innerHTML = `
<div class="conn-panel" hidden>
  <div class="conn-header">
    <div class="conn-title">
      <span class="conn-icon">🔗</span>
      Verificación de Conectividad
    </div>
    <span class="conn-meta" id="conn-meta">—</span>
    <button class="btn btn-ghost btn-sm conn-print-btn" id="conn-print-btn" title="Imprimir reporte" aria-label="Imprimir reporte de conectividad">🖨 Imprimir</button>
    <button class="btn btn-ghost btn-sm conn-close" id="conn-close-btn" aria-label="Cerrar" title="Cerrar">✕ Cerrar</button>
  </div>
  <div class="conn-summary" id="conn-summary"></div>
  <div class="conn-filter-bar">
    <span class="conn-filter-label">Buscar:</span>
    <input class="conn-search" id="conn-search" type="search" placeholder="Nombre o EDT…" aria-label="Buscar actividad">
  </div>
  <div class="conn-body">
    <table class="conn-table" id="conn-table">
      <thead>
        <tr>
          <th style="width:36px">#</th>
          <th style="width:64px">EDT</th>
          <th>Nombre de la actividad</th>
          <th style="width:72px">Tipo</th>
          <th style="width:80px;text-align:center">¿Pred.?</th>
          <th style="width:190px">Predecesoras</th>
          <th style="width:80px;text-align:center">¿Suc.?</th>
          <th style="width:190px">Sucesoras</th>
          <th style="width:90px;text-align:center">Estado</th>
        </tr>
      </thead>
      <tbody id="conn-tbody"></tbody>
    </table>
  </div>
</div>`;

    const panel = this._el.querySelector('.conn-panel');
    this._panel = panel;
    this._tbody = this._el.querySelector('#conn-tbody');
    this._metaEl = this._el.querySelector('#conn-meta');
    this._summaryEl = this._el.querySelector('#conn-summary');
    this._searchEl = this._el.querySelector('#conn-search');

    this._el.querySelector('#conn-close-btn')?.addEventListener('click', () => {
      panel.hidden = true;
      document.dispatchEvent(new CustomEvent('connectivity-closed'));
    });

    this._el.querySelector('#conn-print-btn')?.addEventListener('click', () => {
      window.print();
    });

    this._searchEl?.addEventListener('input', () => {
      this._search = this._searchEl.value.toLowerCase().trim();
      this._renderRows();
    });

    this._summaryEl?.addEventListener('click', e => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      this._filter = chip.dataset.filter;
      this._renderSummary();
      this._renderRows();
    });
  }

  /**
   * @param {{ tasks: Map<string,any>, deps: Map<string,any>, projectName?: string }} opts
   */
  refresh({ tasks, deps, projectName = '' } = {}) {
    if (!tasks || !deps) return;
    this._result = analyzeConnectivity(tasks, deps);
    this._metaEl.textContent = projectName || '';
    this._renderSummary();
    this._renderRows();
    this._panel.hidden = false;
  }

  _renderSummary() {
    if (!this._result) return;
    const { total, ok, noPred, noSucc, both } = this._result;
    const issues = noPred + noSucc + both;
    const f = this._filter;

    const chips = [
      { filter: 'all',    label: `Todas (${total})`,               cls: '' },
      { filter: 'ok',     label: `✅ OK (${ok})`,                  cls: 'conn-chip-ok' },
      { filter: 'issues', label: `⚠ Con problemas (${issues})`,   cls: issues > 0 ? 'conn-chip-warn' : '' },
      { filter: 'noPred', label: `← Sin pred. (${noPred})`,        cls: noPred > 0 ? 'conn-chip-err' : '' },
      { filter: 'noSucc', label: `→ Sin suc. (${noSucc})`,         cls: noSucc > 0 ? 'conn-chip-err' : '' },
      { filter: 'both',   label: `✕ Sin ambas (${both})`,          cls: both > 0 ? 'conn-chip-err' : '' },
    ];

    this._summaryEl.innerHTML = chips.map(c => `
      <button class="conn-chip ${c.cls} ${f === c.filter ? 'active' : ''}" data-filter="${c.filter}" aria-pressed="${f === c.filter}">
        <span>${c.label}</span>
      </button>`).join('');
  }

  _renderRows() {
    if (!this._result) return;
    const { rows } = this._result;
    const filter = this._filter;
    const search = this._search;

    const visible = rows.filter(r => {
      if (filter === 'ok'     && r.status !== 'ok')     return false;
      if (filter === 'issues' && !['noPred','noSucc','both'].includes(r.status)) return false;
      if (filter === 'noPred' && r.status !== 'noPred') return false;
      if (filter === 'noSucc' && r.status !== 'noSucc') return false;
      if (filter === 'both'   && r.status !== 'both')   return false;
      if (search) {
        const hay = (r.name + ' ' + r.wbs).toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    if (!visible.length) {
      this._tbody.innerHTML = `<tr><td colspan="9" class="conn-empty">Sin resultados para este filtro.</td></tr>`;
      return;
    }

    this._tbody.innerHTML = visible.map(r => {
      const rowCls = r.status === 'both' ? 'conn-row-err' : (r.status === 'noPred' || r.status === 'noSucc') ? 'conn-row-warn' : '';
      const typeLbl = r.type === 'milestone' ? 'Hito' : r.isSummary ? 'Resumen' : 'Tarea';
      const nameLbl = r.isSummary ? `<strong>${_esc(r.name)}</strong>` : _esc(r.name);

      const predBadge = r.isSummary ? '<span style="color:var(--clr-text-3)">—</span>'
        : r.hasPred ? `<span class="conn-badge-ok">✅ ${r.preds.length}</span>`
        : `<span class="conn-badge-miss">❌ ninguna</span>`;

      const succBadge = r.isSummary ? '<span style="color:var(--clr-text-3)">—</span>'
        : r.hasSucc ? `<span class="conn-badge-ok">✅ ${r.succs.length}</span>`
        : `<span class="conn-badge-miss">❌ ninguna</span>`;

      const predLinks = r.preds.length
        ? `<div class="conn-links">${r.preds.map(p => `<div class="conn-link-item" title="${_esc(p.pred_name)}">${_esc(p.type)} · ${_esc(p.pred_name)}</div>`).join('')}</div>`
        : '';

      const succLinks = r.succs.length
        ? `<div class="conn-links">${r.succs.map(s => `<div class="conn-link-item" title="${_esc(s.succ_name)}">${_esc(s.type)} · ${_esc(s.succ_name)}</div>`).join('')}</div>`
        : '';

      let statusLbl;
      if (r.isSummary) {
        statusLbl = `<span style="color:var(--clr-text-3)">—</span>`;
      } else if (r.status === 'ok') {
        statusLbl = `<span class="conn-status-ok">✅ OK</span>`;
      } else if (r.status === 'both') {
        statusLbl = `<span class="conn-status-err">❌ Aislada</span>`;
      } else if (r.status === 'noPred') {
        statusLbl = `<span class="conn-status-warn">⚠ Sin pred.</span>`;
      } else {
        statusLbl = `<span class="conn-status-warn">⚠ Sin suc.</span>`;
      }

      return `<tr class="${rowCls}">
        <td class="conn-row-num" style="text-align:center">${r.num}</td>
        <td style="font-family:var(--font-mono,monospace);font-size:11px">${_esc(r.wbs)}</td>
        <td>${nameLbl}</td>
        <td style="text-align:center;font-size:11px">${typeLbl}</td>
        <td style="text-align:center">${predBadge}</td>
        <td>${predLinks}</td>
        <td style="text-align:center">${succBadge}</td>
        <td>${succLinks}</td>
        <td style="text-align:center">${statusLbl}</td>
      </tr>`;
    }).join('');
  }

  get isOpen() {
    return this._panel && !this._panel.hidden;
  }

  close() {
    if (this._panel) this._panel.hidden = true;
  }
}

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
