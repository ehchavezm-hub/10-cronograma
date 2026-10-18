// @ts-check
/**
 * wbs-table.js — Tabla WBS (EDT) editable con inline editing.
 *
 * Renderiza las tareas en una tabla HTML con jerarquía, columnas CPM,
 * alertas, y soporte de teclado completo.
 * No modifica el estado directamente: envía comandos via appState.dispatch().
 */

import { appState } from './state.js';
import { t } from './i18n.js';
import { fmtDate, isoToDate, Calendar } from './calendar.js';

// ============================================================
// Constantes de columnas
// ============================================================

const COLS = [
  { id: 'wbs',    label: 'EDT',        w: 52,   align: 'center', sortable: false },
  { id: 'name',   label: 'Nombre',     w: 240,  align: 'left',   sortable: true  },
  { id: 'type',   label: 'Tipo',       w: 64,   align: 'center', sortable: false },
  { id: 'dur',    label: 'Dur (d)',    w: 58,   align: 'right',  sortable: true  },
  { id: 'start',  label: 'Inicio',     w: 82,   align: 'center', sortable: true  },
  { id: 'finish', label: 'Fin',        w: 82,   align: 'center', sortable: true  },
  { id: 'pct',    label: '%',          w: 48,   align: 'right',  sortable: false },
  { id: 'tf',     label: 'HT',         w: 46,   align: 'right',  sortable: true  },
  { id: 'ff',     label: 'HL',         w: 46,   align: 'right',  sortable: true  },
  { id: 'bl_vi',  label: 'ΔI (d)',     w: 54,   align: 'right',  sortable: false, blOnly: true },
  { id: 'bl_vf',  label: 'ΔF (d)',     w: 54,   align: 'right',  sortable: false, blOnly: true },
  { id: 'bl_vd',  label: 'ΔD (d)',     w: 48,   align: 'right',  sortable: false, blOnly: true },
  { id: 'pred',   label: 'Pred.',      w: 72,   align: 'left',   sortable: false },
  { id: 'alerts', label: 'Alertas',    w: 90,   align: 'left',   sortable: false },
];

const COL_WIDTHS_KEY = 'wbs-col-widths-v2';

const INDENT_PX = 12;

// ============================================================
// Clase principal
// ============================================================

export class WbsTable {
  /** @param {HTMLElement} container */
  constructor(container) {
    this._container = container;
    this._editingCell = null;  // {rowId, col}
    this._ctxMenu = null;
    this._colWidths = this._loadColWidths();
    /** @type {'all'|'critical'|'progress'} */
    this._filter = 'all';

    this._buildDOM();
    this._attachEvents();
    this._attachColResizers();
    appState.subscribe((state, keys) => this._onStateChange(state, keys));
    // Render inmediato con el estado actual (evita quedarse en placeholder si
    // loadProject() disparó ['all'] antes de que WbsTable existiera)
    this._onStateChange(appState.state, ['all']);
  }

  _loadColWidths() {
    try {
      const saved = JSON.parse(localStorage.getItem(COL_WIDTHS_KEY) || 'null');
      if (saved && typeof saved === 'object') return saved;
    } catch {}
    return {};
  }

  _saveColWidths() {
    const widths = {};
    COLS.forEach(c => {
      const th = this._headRow?.querySelector(`th[data-col="${c.id}"]`);
      if (th) widths[c.id] = th.offsetWidth;
    });
    localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(widths));
    this._colWidths = widths;
  }

  // ---- Construcción del DOM ----
  _buildDOM() {
    if (!document.getElementById('wbs-resizer-style')) {
      const style = document.createElement('style');
      style.id = 'wbs-resizer-style';
      style.textContent = `
        .wbs-table { table-layout: fixed; }
        .wbs-table th { position: relative; overflow: hidden; white-space: nowrap; }
        .col-resizer {
          position: absolute; top: 0; right: 0;
          width: 6px; height: 100%;
          cursor: col-resize;
          z-index: 2;
          user-select: none;
        }
        .col-resizer::after {
          content: '';
          position: absolute; top: 20%; right: 2px;
          width: 2px; height: 60%;
          background: var(--clr-border);
          border-radius: 1px;
          transition: background 0.15s;
        }
        .col-resizer:hover::after,
        .col-resizer.resizing::after { background: var(--clr-primary, #1976D2); }
        .wbs-table td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        body.col-resizing { cursor: col-resize !important; user-select: none !important; }
        .col-bl { display: none; }
        .wbs-table.has-baseline .col-bl { display: table-cell; }
        .bl-var-pos { color: #dc2626; font-weight: 600; }
        .bl-var-neg { color: #16a34a; font-weight: 600; }
        .bl-var-zero { color: var(--clr-text-3); }
      `;
      document.head.appendChild(style);
    }

    const thHtml = COLS.map(c => {
      const w = this._colWidths[c.id] ?? c.w;
      const extra = c.blOnly ? ' col-bl' : '';
      const title = c.blOnly ? ` title="${c.id === 'bl_vi' ? 'Varianza inicio vs línea base' : c.id === 'bl_vf' ? 'Varianza fin vs línea base' : 'Varianza duración vs línea base'}"` : '';
      return `<th id="th-${c.id}" style="width:${w}px;min-width:${w}px" class="${c.sortable ? 'sortable' : ''}${extra}" data-col="${c.id}" scope="col"${title}>
        ${c.label}
        <span class="col-resizer" data-resizer="${c.id}" title="Arrastrar para redimensionar"></span>
      </th>`;
    }).join('');

    this._container.innerHTML = `
      <div class="wbs-scroll" id="wbs-scroll" role="grid" aria-label="Tabla de actividades EDT">
        <table class="wbs-table" id="wbs-tbl">
          <thead>
            <tr id="wbs-head-row">
              ${thHtml}
              <th style="width:44px;min-width:44px" scope="col"></th>
            </tr>
          </thead>
          <tbody id="wbs-body"></tbody>
        </table>
      </div>`;

    this._scroll  = this._container.querySelector('#wbs-scroll');
    this._body    = this._container.querySelector('#wbs-body');
    this._headRow = this._container.querySelector('#wbs-head-row');
  }

  _attachColResizers() {
    this._headRow.addEventListener('mousedown', e => {
      const resizer = e.target.closest('.col-resizer');
      if (!resizer) return;
      const colId = resizer.dataset.resizer;
      const th = this._headRow.querySelector(`th[data-col="${colId}"]`);
      if (!th) return;

      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const startW = th.offsetWidth;
      resizer.classList.add('resizing');
      document.body.classList.add('col-resizing');

      const onMove = ev => {
        const newW = Math.max(36, startW + (ev.clientX - startX));
        th.style.width    = newW + 'px';
        th.style.minWidth = newW + 'px';
      };

      const onUp = () => {
        resizer.classList.remove('resizing');
        document.body.classList.remove('col-resizing');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        this._saveColWidths();
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  _attachEvents() {
    // Click en cabecera para ordenar
    this._headRow.addEventListener('click', e => {
      const th = e.target.closest('th[data-col]');
      if (th?.classList.contains('sortable')) this._toggleSort(th.dataset.col);
    });

    // Delegación de eventos en el cuerpo
    this._body.addEventListener('click',       e => this._onBodyClick(e));
    this._body.addEventListener('dblclick',    e => this._onBodyDblClick(e));
    this._body.addEventListener('contextmenu', e => this._onContextMenu(e));
    this._body.addEventListener('keydown',     e => this._onKeyDown(e));

    // Cerrar ctx-menu al hacer clic fuera
    document.addEventListener('click', e => {
      if (this._ctxMenu && !this._ctxMenu.contains(e.target)) this._closeCtxMenu();
    });

    // Aria-live
    this._ariaLive = document.getElementById('aria-live');

    // Sincronizar scroll vertical con el Gantt
    this._scroll.addEventListener('scroll', () => {
      document.dispatchEvent(new CustomEvent('wbs-scroll-y', {
        detail: { scrollY: this._scroll.scrollTop },
      }));
    });
  }

  // ---- Filtros ----

  /**
   * Cambia el filtro activo y re-renderiza.
   * @param {'all'|'critical'|'progress'} filter
   */
  setFilter(filter) {
    this._filter = filter;
    this.render();
  }

  /**
   * Aplica el filtro activo a una lista de rows ya construida.
   * Para `critical`, también retiene los ancestros de tareas críticas
   * para que el árbol sea coherente.
   * @param {Array<{task:any, depth:number, isSummary:boolean}>} rows
   * @returns {Array<{task:any, depth:number, isSummary:boolean}>}
   */
  _applyFilter(rows) {
    if (this._filter === 'all') return rows;

    const { cpmResult } = appState.state;

    if (this._filter === 'critical') {
      if (!cpmResult) return rows;  // CPM aún no disponible → mostrar todas
      const cpmTasks = cpmResult.tasks;

      // IDs de tareas hoja críticas
      const criticalIds = new Set(
        rows.filter(r => !r.isSummary && cpmTasks.get(r.task.id)?.is_critical).map(r => r.task.id)
      );
      if (criticalIds.size === 0) return rows;

      // Para cada tarea crítica, incluir todos sus ancestros
      const keepIds = new Set(criticalIds);
      const idToTask = new Map(rows.map(r => [r.task.id, r.task]));
      for (const id of criticalIds) {
        let parentId = idToTask.get(id)?.parent_id;
        while (parentId) {
          keepIds.add(parentId);
          parentId = idToTask.get(parentId)?.parent_id;
        }
      }
      return rows.filter(r => keepIds.has(r.task.id));
    }

    if (this._filter === 'progress') {
      // Tareas en progreso: pct > 0 y pct < 100, más sus ancestros
      const inProgressIds = new Set(
        rows.filter(r => {
          const pct = r.task.percent_complete ?? 0;
          return !r.isSummary && pct > 0 && pct < 100;
        }).map(r => r.task.id)
      );
      if (inProgressIds.size === 0) return rows;

      const keepIds = new Set(inProgressIds);
      const idToTask = new Map(rows.map(r => [r.task.id, r.task]));
      for (const id of inProgressIds) {
        let parentId = idToTask.get(id)?.parent_id;
        while (parentId) {
          keepIds.add(parentId);
          parentId = idToTask.get(parentId)?.parent_id;
        }
      }
      return rows.filter(r => keepIds.has(r.task.id));
    }

    return rows;
  }

  // ---- Renderizado ----

  render() {
    const { tasks, deps, cpmResult, expandedIds, selectedTaskId, project } = appState.state;
    if (!project) { this._body.innerHTML = ''; return; }

    // Obtener instancia de Calendar para fechas
    const cal = this._getCalendar();
    const startDate = project.start_date ? isoToDate(project.start_date) : new Date();

    // Construir árbol ordenado y aplicar filtro activo
    const allRows = this._buildRows(tasks, expandedIds);
    const rows    = this._applyFilter(allRows);

    // Actualizar contador del filtro
    const countEl = document.getElementById('filter-bar-count');
    if (countEl) {
      if (this._filter === 'all') {
        countEl.textContent = '';
      } else {
        const leaf = rows.filter(r => !r.isSummary).length;
        const total = allRows.filter(r => !r.isSummary).length;
        countEl.textContent = `${leaf} de ${total} tareas`;
      }
    }

    // Calcular códigos WBS
    const wbsCodes = _calcWbsCodes(tasks);

    // Obtener índice de dependencias para columna Pred.
    const predMap = _buildPredMap(deps);

    // Renderizar filas
    const html = rows.map(({ task, depth, isSummary }) => {
      const cpm   = cpmResult?.tasks instanceof Map ? cpmResult.tasks.get(task.id) : null;
      const wbs   = wbsCodes.get(task.id) ?? '';
      const isSelected = task.id === selectedTaskId;
      const isDeleted  = !!task.deleted_at;
      const isComplete = task.percent_complete >= 100;

      const classes = [
        isSelected ? 'selected' : '',
        isDeleted  ? 'deleted'  : '',
        isSummary  ? 'summary-row' : '',
      ].filter(Boolean).join(' ');

      return `<tr data-id="${task.id}" data-depth="${depth}" tabindex="0" class="${classes}" aria-selected="${isSelected}" role="row">
        ${this._renderCells(task, depth, isSummary, wbs, cpm, predMap, wbsCodes, cal, startDate)}
        <td class="td-actions" style="width:44px;padding:0 4px;">
          ${!isDeleted ? `<button class="btn btn-icon btn-sm row-more-btn" data-id="${task.id}" aria-label="Opciones" title="Opciones">⋯</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    // Filas fantasma para efecto cuadrícula (mínimo 12 filas visibles)
    const GHOST_MIN = 12;
    const ghosts = Math.max(0, GHOST_MIN - rows.length);
    const ghostHtml = Array.from({ length: ghosts }, (_, i) =>
      `<tr data-ghost="${i}" class="ghost-row" title="Clic para agregar actividad" tabindex="-1">
        <td style="color:var(--clr-text-4,#ccc);text-align:center;font-size:var(--text-xs)">${rows.length + i + 1}</td>
        <td colspan="12" style="color:var(--clr-text-4,#bbb);font-size:var(--text-xs);padding-left:8px">
          ${i === 0 ? '＋ Clic para agregar actividad…' : ''}
        </td>
        <td></td>
      </tr>`
    ).join('');

    this._body.innerHTML = html + ghostHtml;

    // Sync aria-rowcount and aria-rowindex for ARIA grid pattern
    const grid = document.getElementById('wbs-scroll');
    if (grid) grid.setAttribute('aria-rowcount', String(rows.length));
    this._body.querySelectorAll('tr[data-id]').forEach((tr, i) => tr.setAttribute('aria-rowindex', String(i + 1)));

    // Notificar al Gantt el orden de filas visibles
    document.dispatchEvent(new CustomEvent('gantt-rows-update', {
      detail: { rows: rows.map(({ task, isSummary, depth }) => ({ id: task.id, isSummary, depth })) },
    }));
  }

  /** @returns {string} HTML de las celdas de una fila */
  _renderCells(task, depth, isSummary, wbs, cpm, predMap, wbsCodes, cal, startDate) {
    const isDeleted  = !!task.deleted_at;
    const isComplete = (task.percent_complete ?? 0) >= 100;

    // Fechas desde CPM
    let startStr = '—', finishStr = '—';
    let tfStr = '—', ffStr = '—', tfClass = 'tf-na';

    if (cpm && !isComplete) {
      if (cpm.es != null) startStr  = fmtDate(cal.idxToDate(cpm.es, startDate));
      if (cpm.ef != null) finishStr = fmtDate(cal.finishDate(cpm.ef, startDate));
      if (cpm.tf != null) {
        tfStr = cpm.tf + ' d';
        tfClass = cpm.tf < 0 ? 'tf-neg' : cpm.tf === 0 ? 'tf-zero' : 'tf-pos';
      }
      if (cpm.ff != null) ffStr = cpm.ff + ' d';
    } else if (isComplete) {
      if (task.actual_start)  startStr  = _fmtISO(task.actual_start);
      if (task.actual_finish) finishStr = _fmtISO(task.actual_finish);
      tfStr = '—'; tfClass = 'tf-na';
    }

    // Predecesoras (formato: "3FS", "3FS+2", "4SS")
    const predDeps = predMap.get(task.id) ?? [];
    const preds = predDeps.map(d => {
      const predWbs = wbsCodes.get(d.pred_id) ?? '?';
      const lag = d.lag ?? d.lag_days ?? 0;
      return `${predWbs}${d.type}${lag !== 0 ? (lag > 0 ? '+' + lag : lag) : ''}`;
    }).join(', ');

    // Alertas
    const alerts = this._renderAlerts(task.id, cpm);

    // Tipo badge
    const typeLabel = isSummary ? t('taskType_summary')
      : task.type === 'milestone' ? t('taskType_milestone') : t('taskType_task');
    const typeBadge = isSummary
      ? `<span class="badge badge-normal" style="font-size:10px">${typeLabel}</span>`
      : task.type === 'milestone'
        ? `<span class="badge badge-milestone" style="font-size:10px">▸ ${typeLabel}</span>`
        : `<span style="color:var(--clr-text-3);font-size:var(--text-xs)">${typeLabel}</span>`;

    // % avance
    const pctStr = isDeleted ? '' : `${task.percent_complete ?? 0}%`;

    return `
      <td data-col="wbs" style="text-align:center;color:var(--clr-text-3);font-size:var(--text-xs)">${wbs}</td>
      <td data-col="name" style="cursor:pointer" title="Clic para editar" class="${this._editingCell?.rowId === task.id && this._editingCell?.col === 'name' ? 'editing' : ''}">
        <div class="td-name">
          <span class="indent-spacer" style="width:${depth * INDENT_PX}px;display:inline-block"></span>
          <button class="expand-btn ${isSummary ? '' : 'empty'}" data-expand="${task.id}" aria-label="${appState.state.expandedIds.has(task.id) ? 'Colapsar' : 'Expandir'}">
            ${isSummary ? (appState.state.expandedIds.has(task.id) ? '▾' : '▸') : ''}
          </button>
          <span class="task-name-text ${isSummary ? 'summary' : ''} ${task.type === 'milestone' ? 'milestone' : ''}" title="${_esc(task.name)}">${_esc(task.name)}</span>
        </div>
      </td>
      <td data-col="type" style="text-align:center">${typeBadge}</td>
      <td data-col="dur"  style="text-align:right;cursor:${isSummary || task.type==='milestone'?'default':'pointer'}" title="${isSummary||task.type==='milestone'?'':'Clic para editar duración'}">${isSummary ? (cpm?.ef != null && cpm?.es != null ? (cpm.ef - cpm.es) + ' d' : '—') : task.duration_days + ' d'}</td>
      <td data-col="start"  style="text-align:center;font-size:var(--text-xs);cursor:${isSummary?'default':'pointer'}" title="${isSummary?'':'Clic para editar fecha inicio'}">${startStr}${task.constraint_date && task.constraint_type==='SNET' ? ' 📌' : ''}</td>
      <td data-col="finish" style="text-align:center;font-size:var(--text-xs)">${finishStr}</td>
      <td data-col="pct"  style="text-align:right">${pctStr}</td>
      <td data-col="tf"   style="text-align:right" class="${tfClass}">${tfStr}</td>
      <td data-col="ff"   style="text-align:right;color:var(--clr-text-2)">${ffStr}</td>
      ${this._renderBlVarianceCells(task.id, cpm, isSummary)}
      <td data-col="pred" style="font-size:var(--text-xs);color:var(--clr-text-3);cursor:pointer" title="Clic para editar predecesoras (ej: 3FS, 4SS+2)">${preds}</td>
      <td data-col="alerts">${alerts}</td>`;
  }

  /** @returns {string} */
  _renderAlerts(taskId, cpm) {
    const { warnings } = appState.state.cpmResult ?? { warnings: [] };
    const taskWarns = (warnings ?? []).filter(w => w.task_id === taskId);
    if (!taskWarns.length) return '';
    return `<div class="alert-icons" role="list">` +
      taskWarns.slice(0, 3).map(w => {
        const isError = ['CICLO', 'FUERA_DE_SECUENCIA'].includes(w.code);
        const icon = isError ? '⚠' : '●';
        const tip  = t('warn_' + w.code) || w.code;
        return `<span class="alert-icon ${isError ? 'error' : 'warn'}" role="listitem" aria-label="${tip}" data-tooltip="${tip}">${icon}</span>`;
      }).join('') +
      (taskWarns.length > 3 ? `<span class="alert-icon warn" aria-label="+${taskWarns.length - 3} más">+${taskWarns.length - 3}</span>` : '') +
      `</div>`;
  }

  /** @returns {string} 3 celdas de varianza línea base (bl_vi, bl_vf, bl_vd) */
  _renderBlVarianceCells(taskId, cpm, isSummary) {
    const { baselineData } = appState.state;
    if (!baselineData || isSummary) {
      return `
        <td data-col="bl_vi" class="col-bl" style="text-align:right">—</td>
        <td data-col="bl_vf" class="col-bl" style="text-align:right">—</td>
        <td data-col="bl_vd" class="col-bl" style="text-align:right">—</td>`;
    }

    const bl = baselineData.get(taskId);
    if (!bl || !cpm || cpm.es == null) {
      return `
        <td data-col="bl_vi" class="col-bl" style="text-align:right">—</td>
        <td data-col="bl_vf" class="col-bl" style="text-align:right">—</td>
        <td data-col="bl_vd" class="col-bl" style="text-align:right">—</td>`;
    }

    const vi = cpm.es  - bl.es;
    const vf = cpm.ef  - bl.ef;
    const vd = (cpm.dur ?? (cpm.ef - cpm.es + 1)) - bl.dur;

    const fmt = (v) => {
      const cls  = v > 0 ? 'bl-var-pos' : v < 0 ? 'bl-var-neg' : 'bl-var-zero';
      const sign = v > 0 ? '+' : '';
      const tip  = v > 0 ? 'Atrasado vs línea base' : v < 0 ? 'Adelantado vs línea base' : 'En línea con la base';
      return `<span class="${cls}" title="${tip}">${sign}${v}</span>`;
    };

    return `
      <td data-col="bl_vi" class="col-bl" style="text-align:right;font-size:var(--text-xs)">${fmt(vi)}</td>
      <td data-col="bl_vf" class="col-bl" style="text-align:right;font-size:var(--text-xs)">${fmt(vf)}</td>
      <td data-col="bl_vd" class="col-bl" style="text-align:right;font-size:var(--text-xs)">${fmt(vd)}</td>`;
  }

  // ---- Construcción de lista ordenada de filas ----

  /** @param {Map<string,any>} tasks @param {Set<string>} expandedIds @returns {Array<{task:any,depth:number,isSummary:boolean}>} */
  _buildRows(tasks, expandedIds) {
    const activeTasks = [...tasks.values()].filter(t => !t.deleted_at);
    const parentIds   = new Set(activeTasks.map(t => t.parent_id).filter(Boolean));
    const isSummary   = id => parentIds.has(id);

    const childrenOf = new Map(activeTasks.map(t => [t.id, []]));
    const roots = [];
    for (const t of activeTasks) {
      if (!t.parent_id) roots.push(t);
      else childrenOf.get(t.parent_id)?.push(t);
    }
    for (const [, children] of childrenOf) children.sort((a, b) => a.sort_order - b.sort_order);
    roots.sort((a, b) => a.sort_order - b.sort_order);

    const rows = [];
    const walk = (task, depth) => {
      const summ = isSummary(task.id);
      rows.push({ task, depth, isSummary: summ });
      if (summ && expandedIds.has(task.id)) {
        for (const child of (childrenOf.get(task.id) ?? [])) walk(child, depth + 1);
      }
    };
    for (const r of roots) walk(r, 0);
    return rows;
  }

  // ---- Obtener Calendar desde el estado ----
  _getCalendar() {
    const { calendar, calExceptions } = appState.state;
    if (!calendar) return new Calendar({ work_week: [1,2,3,4,5] });
    return new Calendar({
      work_week: calendar.work_week,
      exceptions: calExceptions.filter(e => !e.deleted_at).map(e => ({ on_date: e.on_date, is_working: e.is_working })),
    });
  }

  // ---- Eventos ----

  _onStateChange(state, keys) {
    if (!keys || keys.includes('all') || keys.some(k => ['tasks','deps','cpmResult','expandedIds','selectedTaskId','project','baselineData'].includes(k))) {
      // Toggle clase has-baseline en el <table>
      const tbl = this._container.querySelector('#wbs-tbl');
      if (tbl) tbl.classList.toggle('has-baseline', !!state.baselineData);
      this.render();
    }
  }

  _onBodyClick(e) {
    // Expandir/colapsar
    const expandBtn = e.target.closest('[data-expand]');
    if (expandBtn) {
      appState.toggleExpand(expandBtn.dataset.expand);
      return;
    }
    // Botón de opciones
    const moreBtn = e.target.closest('.row-more-btn');
    if (moreBtn) {
      e.stopPropagation();
      this._openCtxMenu(moreBtn.dataset.id, e.clientX, e.clientY);
      return;
    }
    // Fila fantasma → crear tarea nueva y editar
    const ghostRow = e.target.closest('tr[data-ghost]');
    if (ghostRow) {
      document.dispatchEvent(new CustomEvent('wbs-add-task', { detail: { type: 'task' } }));
      return;
    }
    // Clic en celda editable → editar directamente
    const cell = e.target.closest('td[data-col]');
    const row  = e.target.closest('tr[data-id]');
    if (cell && row && !e.target.closest('.expand-btn')) {
      const col = cell.dataset.col;
      const id  = row.dataset.id;
      const task = appState.state.tasks.get(id);
      if (['name','pct'].includes(col)) {
        this._startEdit(id, col, cell);
        return;
      }
      if (col === 'dur' && task && task.type !== 'milestone' && !this._isSummary(id)) {
        this._startEdit(id, col, cell);
        return;
      }
      if (col === 'start' && task && !this._isSummary(id)) {
        this._startEdit(id, col, cell);
        return;
      }
      if (col === 'pred' && task) {
        this._startEdit(id, col, cell);
        return;
      }
    }
    // Seleccionar fila
    if (row) {
      appState.selectTask(row.dataset.id);
    }
  }

  _onBodyDblClick(e) {
    const cell = e.target.closest('td[data-col]');
    const row  = e.target.closest('tr[data-id]');
    if (!cell || !row) return;
    const col  = cell.dataset.col;
    const id   = row.dataset.id;
    if (['name','dur','pct','start'].includes(col)) {
      this._startEdit(id, col, cell);
    }
  }

  _isSummary(id) {
    const tasks = [...appState.state.tasks.values()].filter(t => !t.deleted_at);
    return tasks.some(t => t.parent_id === id && !t.deleted_at);
  }

  _onKeyDown(e) {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const id = row.dataset.id;

    // Tab → siguiente celda editable (simplificado: siguiente fila)
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      const firstCell = row.querySelector('td[data-col="name"]');
      if (firstCell) this._startEdit(id, 'name', firstCell);
    }
    if (e.key === 'Escape') this._cancelEdit();
    if (e.key === 'Delete' && !this._editingCell) {
      if (confirm(t('confirmDelete'))) this._deleteTask(id);
    }
    // Indentación con Tab/Shift+Tab
    if (e.key === 'Tab' && !this._editingCell) {
      e.preventDefault();
      e.shiftKey ? this._outdentTask(id) : this._indentTask(id);
    }
    // Arriba/Abajo
    if (e.key === 'ArrowDown') { e.preventDefault(); _focusNext(row, 1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); _focusNext(row, -1); }
  }

  _onContextMenu(e) {
    e.preventDefault();
    const row = e.target.closest('tr[data-id]');
    if (row) this._openCtxMenu(row.dataset.id, e.clientX, e.clientY);
  }

  // ---- Edición en línea ----

  _startEdit(rowId, col, cell) {
    this._cancelEdit();
    // cancelEdit may have re-rendered the DOM; re-find the cell
    const freshRow = this._body.querySelector(`tr[data-id="${rowId}"]`);
    if (freshRow) cell = freshRow.querySelector(`td[data-col="${col}"]`);
    if (!cell) return;
    const task = appState.state.tasks.get(rowId);
    if (!task) return;

    let val = '';
    let inputType = 'text';

    if (col === 'name') {
      val = task.name;
    } else if (col === 'dur') {
      val = String(task.duration_days);
    } else if (col === 'pct') {
      val = String(task.percent_complete);
    } else if (col === 'pred') {
      // Build current pred string from deps
      const wbsCodes = _calcWbsCodes(appState.state.tasks);
      const predDeps = [...(appState.state.deps.values?.() ?? appState.state.deps)]
        .filter(d => !d.deleted_at && d.succ_id === rowId);
      val = predDeps.map(d => {
        const predWbs = wbsCodes.get(d.pred_id) ?? '?';
        const lag = d.lag ?? d.lag_days ?? 0;
        return `${predWbs}${d.type}${lag !== 0 ? (lag > 0 ? '+' + lag : lag) : ''}`;
      }).join(', ');
    } else if (col === 'start') {
      inputType = 'date';
      // Use constraint_date if set, otherwise use CPM early start
      if (task.constraint_date) {
        val = task.constraint_date;
      } else {
        const project  = appState.state.project;
        const cal      = this._getCalendar();
        const projStart = project?.start_date ? isoToDate(project.start_date) : new Date();
        const cpm      = appState.state.cpmResult?.tasks instanceof Map
          ? appState.state.cpmResult.tasks.get(rowId) : null;
        if (cpm?.es != null) {
          const d = cal.idxToDate(cpm.es, projStart);
          val = d.toISOString().slice(0, 10);
        } else {
          val = project?.start_date ?? new Date().toISOString().slice(0, 10);
        }
      }
    }

    cell.classList.add('editing');
    cell.innerHTML = `<input class="inline-input" type="${inputType}" value="${_esc(val)}" aria-label="${_esc(col)}" style="width:100%;box-sizing:border-box">`;
    const input = cell.querySelector('input');
    input.focus();
    if (inputType === 'text') input.select();

    const commit = () => {
      if (!this._editingCell) return; // guard: prevent double-commit from blur triggered by re-render
      const newVal = input.value.trim();
      this._commitEdit(rowId, col, newVal);
    };
    input.addEventListener('blur',   commit);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); this._cancelEdit(); }
    });

    this._editingCell = { rowId, col, cell };
  }

  async _commitEdit(rowId, col, rawVal) {
    this._editingCell = null;
    const task = appState.state.tasks.get(rowId);
    if (!task) { this.render(); return; }

    const fields = {};
    if (col === 'name') {
      if (!rawVal) { this.render(); return; }
      fields.name = rawVal;
    } else if (col === 'dur') {
      const v = parseFloat(rawVal);
      if (isNaN(v) || v <= 0) { this.render(); return; }
      if (task.type === 'milestone') { this.render(); return; }
      fields.duration_days = v;
    } else if (col === 'pct') {
      const v = parseFloat(rawVal);
      if (isNaN(v) || v < 0 || v > 100) { this.render(); return; }
      fields.percent_complete = v;
      if (v === 100) fields.actual_finish = fields.actual_finish ?? new Date().toISOString().slice(0, 10);
    } else if (col === 'pred') {
      const wbsCodes = _calcWbsCodes(appState.state.tasks);
      const wbsToId  = new Map([...wbsCodes.entries()].map(([id, wbs]) => [wbs, id]));
      const newPreds = _parsePredStr(rawVal, wbsToId);
      const currentDeps = [...(appState.state.deps.values?.() ?? appState.state.deps)]
        .filter(d => !d.deleted_at && d.succ_id === rowId);
      // Remove deps not in new set
      for (const dep of currentDeps) {
        const kept = newPreds.some(p => p.predId === dep.pred_id && p.type === dep.type);
        if (!kept) appState.dispatch({ type: 'REMOVE_DEP', payload: { id: dep.id } });
      }
      // Add or update deps
      for (const p of newPreds) {
        const existing = currentDeps.find(d => d.pred_id === p.predId && d.type === p.type);
        // Comparar lag_days directamente (no el fallback a 'lag')
        const currentLagDays = existing ? (existing.lag_days ?? 0) : null;
        if (!existing) {
          appState.dispatch({ type: 'ADD_DEP', payload: { dep: {
            id: crypto.randomUUID(),
            project_id: appState.state.project?.id ?? '',
            pred_id: p.predId, succ_id: rowId,
            type: p.type, lag_days: p.lag,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
          }}});
        } else if (currentLagDays !== p.lag) {
          // Lag cambió: reemplazar la dep para actualizar lag_days
          // Guardar la dep vieja con deleted_at antes de dispatch (onPersist la busca por ID)
          const { put: dbPutSt } = await import('./storage.js?v=4');
          await dbPutSt('task_dependencies', { ...existing, deleted_at: new Date().toISOString() });
          appState.dispatch({ type: 'REMOVE_DEP', payload: { id: existing.id } });
          appState.dispatch({ type: 'ADD_DEP', payload: { dep: {
            id: crypto.randomUUID(),
            project_id: appState.state.project?.id ?? '',
            pred_id: p.predId, succ_id: rowId,
            type: p.type, lag_days: p.lag,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            deleted_at: null,
          }}});
        }
      }
      return;
    } else if (col === 'start') {
      if (rawVal) {
        fields.constraint_type = 'SNET';
        fields.constraint_date = rawVal;
      }
    }

    if (Object.keys(fields).length) {
      appState.dispatch({ type: 'UPDATE_TASK', payload: { id: rowId, fields } });
    } else {
      this.render();
    }
  }

  _cancelEdit() {
    if (!this._editingCell) return;
    this._editingCell = null;
    this.render();
  }

  // ---- Operaciones de tarea ----

  _deleteTask(id) {
    appState.dispatch({ type: 'REMOVE_TASK', payload: { id } });
    if (this._ariaLive) this._ariaLive.textContent = 'Tarea eliminada.';
  }

  _indentTask(id) {
    const tasks = [...appState.state.tasks.values()].filter(t => !t.deleted_at);
    const task  = tasks.find(t => t.id === id);
    if (!task) return;
    // Buscar el hermano inmediatamente anterior (mismo parent, menor sort_order)
    const siblings = tasks.filter(t => t.parent_id === task.parent_id && t.id !== id).sort((a, b) => a.sort_order - b.sort_order);
    const prevSibling = siblings.filter(s => s.sort_order < task.sort_order).pop();
    if (!prevSibling) return;
    if (prevSibling.type === 'milestone') return;
    appState.dispatch({ type: 'MOVE_TASK', payload: { id, newParentId: prevSibling.id, newSortOrder: task.sort_order } });
    appState.state.expandedIds.add(prevSibling.id);
  }

  _outdentTask(id) {
    const tasks = [...appState.state.tasks.values()].filter(t => !t.deleted_at);
    const task  = tasks.find(t => t.id === id);
    if (!task || !task.parent_id) return;
    const parent = tasks.find(t => t.id === task.parent_id);
    if (!parent) return;
    appState.dispatch({ type: 'MOVE_TASK', payload: { id, newParentId: parent.parent_id ?? null, newSortOrder: parent.sort_order + 0.5 } });
  }

  // ---- Menú contextual ----

  _openCtxMenu(taskId, x, y) {
    this._closeCtxMenu();
    const task = appState.state.tasks.get(taskId);
    if (!task) return;

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div class="context-menu-item" data-action="edit" role="menuitem" tabindex="0">✏️ Editar nombre</div>
      <div class="context-menu-item" data-action="detail" role="menuitem" tabindex="0">🔍 Ver detalles</div>
      <div class="context-menu-sep"></div>
      <div class="context-menu-item" data-action="add-after" role="menuitem" tabindex="0">➕ Agregar tarea debajo</div>
      <div class="context-menu-item" data-action="add-child" role="menuitem" tabindex="0">↳ Agregar subtarea</div>
      <div class="context-menu-item" data-action="milestone" role="menuitem" tabindex="0">◆ Agregar hito debajo</div>
      <div class="context-menu-sep"></div>
      <div class="context-menu-item" data-action="indent" role="menuitem" tabindex="0">→ Indentar</div>
      <div class="context-menu-item" data-action="outdent" role="menuitem" tabindex="0">← Desindentar</div>
      <div class="context-menu-sep"></div>
      <div class="context-menu-item danger" data-action="delete" role="menuitem" tabindex="0">🗑 Eliminar</div>`;

    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    document.body.appendChild(menu);
    this._ctxMenu = menu;

    menu.addEventListener('click', e => {
      const item = e.target.closest('[data-action]');
      if (!item) return;
      this._handleCtxAction(item.dataset.action, taskId);
      this._closeCtxMenu();
    });
    menu.addEventListener('keydown', e => {
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const idx = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.stopPropagation(); this._closeCtxMenu(); }
      else if (e.key === 'ArrowDown') { items[(idx + 1) % items.length]?.focus(); e.preventDefault(); }
      else if (e.key === 'ArrowUp')   { items[(idx - 1 + items.length) % items.length]?.focus(); e.preventDefault(); }
      else if (e.key === 'Enter' || e.key === ' ') {
        const item = document.activeElement?.closest('[data-action]');
        if (item) { this._handleCtxAction(item.dataset.action, taskId); this._closeCtxMenu(); e.preventDefault(); }
      }
    });
    // Asegurar que el menú no salga de la pantalla
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth)   menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top  = (y - rect.height) + 'px';
    // Mover foco al primer ítem
    requestAnimationFrame(() => menu.querySelector('[role="menuitem"]')?.focus());
  }

  _closeCtxMenu() {
    if (this._ctxMenu) { this._ctxMenu.remove(); this._ctxMenu = null; }
  }

  _handleCtxAction(action, taskId) {
    const task = appState.state.tasks.get(taskId);
    if (!task) return;
    switch (action) {
      case 'edit':
        appState.selectTask(taskId);
        setTimeout(() => {
          const row = this._body.querySelector(`tr[data-id="${taskId}"]`);
          const cell = row?.querySelector('td[data-col="name"]');
          if (cell) this._startEdit(taskId, 'name', cell);
        }, 50);
        break;
      case 'detail':
        document.dispatchEvent(new CustomEvent('open-task-detail', { detail: { taskId } }));
        break;
      case 'add-after':
        this._addTask({ afterId: taskId, type: 'task' });
        break;
      case 'add-child':
        this._addTask({ parentId: taskId, type: 'task' });
        break;
      case 'milestone':
        this._addTask({ afterId: taskId, type: 'milestone' });
        break;
      case 'indent':  this._indentTask(taskId);  break;
      case 'outdent': this._outdentTask(taskId); break;
      case 'delete':
        if (confirm(t('confirmDelete'))) this._deleteTask(taskId);
        break;
    }
  }

  // ---- Agregar tarea ----

  addTaskAfterSelected(type = 'task') {
    const sel = appState.state.selectedTaskId;
    const task = sel ? appState.state.tasks.get(sel) : null;
    this._addTask({ afterId: task?.id ?? null, type });
  }

  _addTask({ afterId, parentId, type }) {
    const proj = appState.state.project;
    if (!proj) return;
    const tasks = [...appState.state.tasks.values()].filter(t => !t.deleted_at);

    let parent_id = parentId ?? null;
    let sort_order = 1000;

    if (afterId) {
      const after = tasks.find(t => t.id === afterId);
      if (after) {
        parent_id  = after.parent_id;
        sort_order = after.sort_order + 1;
      }
    } else if (parentId) {
      const siblings = tasks.filter(t => t.parent_id === parentId).sort((a, b) => a.sort_order - b.sort_order);
      sort_order = siblings.length ? siblings[siblings.length - 1].sort_order + 1 : 1;
    }

    const id = crypto.randomUUID();
    const task = {
      id,
      org_id:          proj.org_id ?? 'local',
      project_id:      proj.id,
      parent_id,
      sort_order,
      name:            type === 'milestone' ? 'Nuevo hito' : 'Nueva tarea',
      type,
      duration_days:   type === 'milestone' ? 0 : 1,
      work_hours:      0,
      percent_complete: 0,
      actual_start:    null,
      actual_finish:   null,
      constraint_type: 'ASAP',
      constraint_date: null,
      planned_cost:    0,
      actual_cost:     0,
      notes:           null,
      created_at:      new Date().toISOString(),
      updated_at:      new Date().toISOString(),
      deleted_at:      null,
    };
    const ok = appState.dispatch({ type: 'ADD_TASK', payload: { task } });
    if (ok) {
      appState.selectTask(id);
      if (this._ariaLive) this._ariaLive.textContent = 'Tarea creada.';
      // Dar foco a la nueva fila para editar nombre
      setTimeout(() => {
        const row  = this._body.querySelector(`tr[data-id="${id}"]`);
        const cell = row?.querySelector('td[data-col="name"]');
        if (cell) this._startEdit(id, 'name', cell);
      }, 80);
    }
    return id;
  }

  // ---- Sort ----
  _toggleSort(col) { /* futuro */ }
}

// ============================================================
// Utilidades
// ============================================================

/** @param {string} s @returns {string} */
function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/** @param {string} iso @returns {string} dd/mm/aaaa */
function _fmtISO(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

/** Calcula mapa id→código WBS (ej. "1.2.3") */
function _calcWbsCodes(tasks) {
  const activeTasks = [...tasks.values()].filter(t => !t.deleted_at);
  const childrenOf = new Map(activeTasks.map(t => [t.id, []]));
  const roots = [];
  for (const t of activeTasks) {
    if (!t.parent_id) roots.push(t);
    else childrenOf.get(t.parent_id)?.push(t);
  }
  for (const [, ch] of childrenOf) ch.sort((a, b) => a.sort_order - b.sort_order);
  roots.sort((a, b) => a.sort_order - b.sort_order);

  const codes = new Map();
  const assign = (task, prefix) => {
    codes.set(task.id, prefix);
    const ch = childrenOf.get(task.id) ?? [];
    ch.forEach((c, i) => assign(c, prefix + '.' + (i + 1)));
  };
  roots.forEach((r, i) => assign(r, String(i + 1)));
  return codes;
}

/**
 * Parsea una cadena de predecesoras tipo "3FS, 4SS+2, 5" en un array de deps.
 * Formato por ítem: WBS[tipo][±lag] — ej. "3", "3FS", "3.1FS+2", "4SS-1"
 * @param {string} str
 * @param {Map<string,string>} wbsToId  wbs_code → task_id
 */
function _parsePredStr(str, wbsToId) {
  if (!str.trim()) return [];
  return str.split(',').flatMap(part => {
    part = part.trim();
    if (!part) return [];
    const m = part.match(/^([0-9]+(?:\.[0-9]+)*)(FS|SS|FF|SF)?([+-]\d+)?$/i);
    if (!m) return [];
    const wbs    = m[1];
    const type   = (m[2] || 'FS').toUpperCase();
    const lag    = m[3] ? parseInt(m[3]) : 0;
    const predId = wbsToId.get(wbs);
    if (!predId) return [];
    return [{ predId, type, lag }];
  });
}

/** Construye mapa succId → [deps que la apuntan como sucesor] */
function _buildPredMap(deps) {
  const map = new Map();
  for (const d of deps.values?.() ?? deps) {
    if (d.deleted_at) continue;
    if (!map.has(d.succ_id)) map.set(d.succ_id, []);
    map.get(d.succ_id).push(d);
  }
  return map;
}

/** @param {HTMLElement} row @param {number} dir */
function _focusNext(row, dir) {
  const rows = [...row.closest('tbody').querySelectorAll('tr[data-id]')];
  const idx  = rows.indexOf(row);
  const next = rows[idx + dir];
  if (next) next.focus();
}
