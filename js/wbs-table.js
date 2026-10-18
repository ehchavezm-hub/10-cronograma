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
  { id: 'rownum', label: '#',          w: 36,   align: 'center', sortable: false },
  { id: 'wbs',    label: 'EDT',        w: 52,   align: 'center', sortable: false },
  { id: 'name',   label: 'NOMBRE DE LA ACTIVIDAD', w: 280,  align: 'left',   sortable: true  },
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
    /** @type {Set<string>} */
    this._selectedIds = new Set();
    this._lastClickedId = /** @type {string|null} */ (null);

    this._sortCol = /** @type {string|null} */ (null);
    this._sortDir = /** @type {'asc'|'desc'} */ ('asc');
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
    try { localStorage.setItem(COL_WIDTHS_KEY, JSON.stringify(widths)); } catch {}
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
        .wbs-row-selected { background: rgba(25,118,210,0.13) !important; outline: 1px solid rgba(25,118,210,0.35); outline-offset: -1px; }
        [data-theme="dark"] .wbs-row-selected,:root.dark .wbs-row-selected { background: rgba(100,160,255,0.18) !important; }
        #wbs-bulk-bar { display:none; align-items:center; gap:6px; padding:5px 12px; background:var(--clr-primary,#1976D2); color:#fff; font-size:12px; flex-shrink:0; border-bottom:1px solid rgba(0,0,0,.1); }
        .wbs-bulk-btn { padding:3px 10px; border:1px solid rgba(255,255,255,0.45); border-radius:5px; background:rgba(255,255,255,0.12); color:#fff; font-size:11px; cursor:pointer; white-space:nowrap; }
        .wbs-bulk-btn:hover { background:rgba(255,255,255,0.28); }
        .task-notes-icon { opacity:0.55;font-size:10px;cursor:pointer;vertical-align:middle;margin-left:3px;line-height:1; }
        .task-notes-icon:hover { opacity:1; }
        .sort-indicator { font-size:9px;margin-left:2px;color:var(--clr-primary,#1976D2); }
      `;
      document.head.appendChild(style);
    }

    const thHtml = COLS.map(c => {
      const w = this._colWidths[c.id] ?? c.w;
      const extra = c.blOnly ? ' col-bl' : '';
      const title = c.blOnly ? ` title="${c.id === 'bl_vi' ? 'Varianza inicio vs línea base' : c.id === 'bl_vf' ? 'Varianza fin vs línea base' : 'Varianza duración vs línea base'}"` : '';
      return `<th id="th-${c.id}" style="width:${w}px;min-width:${w}px" class="${c.sortable ? 'sortable' : ''}${extra}" data-col="${c.id}" scope="col"${title}>
        ${c.label}${c.sortable ? '<span class="sort-indicator"></span>' : ''}
        <span class="col-resizer" data-resizer="${c.id}" title="Arrastrar para redimensionar"></span>
      </th>`;
    }).join('');

    this._container.innerHTML = `
      <div id="wbs-bulk-bar">
        <span id="wbs-bulk-count" style="font-weight:600;margin-right:4px"></span>
        <button class="wbs-bulk-btn" data-bulk="edit" title="Editar campos en bloque para las filas seleccionadas">✏ Editar en bloque</button>
        <button class="wbs-bulk-btn" data-bulk="indent" title="Indentar todas las filas seleccionadas">→ Indentar</button>
        <button class="wbs-bulk-btn" data-bulk="outdent" title="Desindentar todas las filas seleccionadas">← Desindentar</button>
        <button class="wbs-bulk-btn" data-bulk="up" title="Mover filas seleccionadas hacia arriba">↑ Subir</button>
        <button class="wbs-bulk-btn" data-bulk="down" title="Mover filas seleccionadas hacia abajo">↓ Bajar</button>
        <span style="flex:1"></span>
        <button class="wbs-bulk-btn" data-bulk="clear" title="Limpiar selección múltiple (también: Esc)">✕ Limpiar</button>
      </div>
      <div class="wbs-scroll" id="wbs-scroll" role="grid" aria-label="Tabla de actividades EDT">
        <table class="wbs-table" id="wbs-tbl">
          <thead>
            <tr id="wbs-head-row">
              ${thHtml}
              <th style="width:44px;min-width:44px" scope="col" aria-label="Acciones"></th>
            </tr>
          </thead>
          <tbody id="wbs-body"></tbody>
        </table>
      </div>`;

    this._scroll   = this._container.querySelector('#wbs-scroll');
    this._body     = this._container.querySelector('#wbs-body');
    this._headRow  = this._container.querySelector('#wbs-head-row');
    this._bulkBar  = this._container.querySelector('#wbs-bulk-bar');
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

    // Double-click resizer to auto-fit column
    this._headRow.addEventListener('dblclick', e => {
      const resizer = /** @type {HTMLElement} */ (e.target).closest('.col-resizer');
      if (!resizer) return;
      const colId = /** @type {HTMLElement} */ (resizer).dataset.resizer;
      const th = this._headRow.querySelector(`th[data-col="${colId}"]`);
      if (!th) return;
      let maxW = th.querySelector('.col-resizer') ? (th.scrollWidth - 6) : th.scrollWidth;
      this._body.querySelectorAll(`td[data-col="${colId}"]`).forEach(td => {
        const w = /** @type {HTMLElement} */ (td).scrollWidth;
        if (w > maxW) maxW = w;
      });
      const newW = Math.max(40, maxW + 8);
      /** @type {HTMLElement} */ (th).style.width    = newW + 'px';
      /** @type {HTMLElement} */ (th).style.minWidth = newW + 'px';
      this._saveColWidths();
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

    // Bulk action bar
    this._container.addEventListener('click', e => {
      const btn = /** @type {HTMLElement|null} */ (e.target.closest('[data-bulk]'));
      if (btn) { e.stopPropagation(); this._handleBulkAction(btn.dataset.bulk); }
    });

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
    const allRows    = this._buildRows(tasks, expandedIds);
    const rows       = this._applyFilter(allRows);
    const sortedRows = this._sortCol ? this._applySort(rows) : rows;

    // Actualizar contador del filtro
    const countEl = document.getElementById('filter-bar-count');
    if (countEl) {
      if (this._filter === 'all') {
        const total = allRows.filter(r => !r.isSummary).length;
        countEl.textContent = total ? `${total} ${total === 1 ? 'tarea' : 'tareas'}` : '';
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
    const html = sortedRows.map(({ task, depth, isSummary }, rowIdx) => {
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
        ${this._renderCells(task, depth, isSummary, wbs, cpm, predMap, wbsCodes, cal, startDate, rowIdx + 1)}
        <td class="td-actions" style="width:44px;padding:0 4px;">
          ${!isDeleted ? `<button class="btn btn-icon btn-sm row-more-btn" data-id="${task.id}" aria-label="Opciones" title="Opciones">⋯</button>` : ''}
        </td>
      </tr>`;
    }).join('');

    // Filas fantasma para efecto cuadrícula (mínimo 12 filas visibles)
    const GHOST_MIN = 12;
    const ghosts = Math.max(0, GHOST_MIN - sortedRows.length);
    const ghostHtml = Array.from({ length: ghosts }, (_, i) =>
      `<tr data-ghost="${i}" class="ghost-row" title="Clic para agregar actividad" tabindex="-1">
        <td style="color:var(--clr-text-4,#ccc);text-align:center;font-size:var(--text-xs)">${sortedRows.length + i + 1}</td>
        <td colspan="14" style="color:var(--clr-text-4,#bbb);font-size:var(--text-xs);padding-left:8px">
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

    // Restaurar selección múltiple
    this._renderSelectionState();

    // Actualizar indicadores de orden en encabezados
    COLS.filter(c => c.sortable).forEach(c => {
      const th = this._headRow?.querySelector(`th[data-col="${c.id}"]`);
      const ind = th?.querySelector('.sort-indicator');
      if (ind) ind.textContent = this._sortCol === c.id ? (this._sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    });

    // Notificar al Gantt el orden de filas visibles
    document.dispatchEvent(new CustomEvent('gantt-rows-update', {
      detail: { rows: sortedRows.map(({ task, isSummary, depth }) => ({ id: task.id, isSummary, depth })) },
    }));
  }

  /** @returns {string} HTML de las celdas de una fila */
  _renderCells(task, depth, isSummary, wbs, cpm, predMap, wbsCodes, cal, startDate, rowNum = 0) {
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

    // % avance con barra visual
    const pct0 = task.percent_complete ?? 0;
    const pctBarColor = pct0 >= 100 ? '#16a34a' : (cpm?.is_critical ? '#dc2626' : 'var(--clr-primary,#1976D2)');
    const pctCell = isDeleted ? '' : `<div style="display:flex;align-items:center;gap:3px;justify-content:flex-end"><div style="width:28px;height:4px;background:var(--clr-border,#e5e7eb);border-radius:3px;overflow:hidden;flex-shrink:0" title="${pct0}% completado"><div style="width:${pct0}%;height:100%;background:${pctBarColor};border-radius:3px"></div></div><span style="font-size:var(--text-xs)">${pct0}%</span></div>`;

    // Indicador de notas
    const notesIcon = task.notes ? `<span class="task-notes-icon" title="${_esc((task.notes).slice(0, 120))}">📝</span>` : '';

    // Indicador de restricción
    const constraintSuffix = _constraintIcon(task.constraint_type, task.constraint_date);
    const constraintTip = task.constraint_date && task.constraint_type !== 'ASAP'
      ? ` (${task.constraint_type}: ${_fmtISO(task.constraint_date)})` : '';

    return `
      <td data-col="rownum" style="text-align:center;color:var(--clr-text-4,#aaa);font-size:var(--text-xs);user-select:none">${rowNum}</td>
      <td data-col="wbs" style="text-align:center;color:var(--clr-text-3);font-size:var(--text-xs);cursor:pointer" title="Clic para reubicar tarea (código EDT)">${wbs}</td>
      <td data-col="name" style="cursor:pointer" title="Clic para editar" class="${this._editingCell?.rowId === task.id && this._editingCell?.col === 'name' ? 'editing' : ''}">
        <div class="td-name">
          <span class="indent-spacer" style="width:${depth * INDENT_PX}px;display:inline-block"></span>
          <button class="expand-btn ${isSummary ? '' : 'empty'}" data-expand="${task.id}" aria-label="${appState.state.expandedIds.has(task.id) ? 'Colapsar' : 'Expandir'}">
            ${isSummary ? (appState.state.expandedIds.has(task.id) ? '▾' : '▸') : ''}
          </button>
          <span class="task-name-text ${isSummary ? 'summary' : ''} ${task.type === 'milestone' ? 'milestone' : ''}" title="${_esc(task.name)}">${_esc(task.name)}</span>${notesIcon}
        </div>
      </td>
      <td data-col="type" style="text-align:center${!isSummary ? ';cursor:pointer' : ''}" title="${!isSummary ? 'Clic para cambiar tipo' : ''}">${typeBadge}</td>
      <td data-col="dur"  style="text-align:right;cursor:${isSummary || task.type==='milestone'?'default':'pointer'}" title="${isSummary||task.type==='milestone'?'':'Clic para editar duración'}">${isSummary ? (cpm?.ef != null && cpm?.es != null ? (cpm.ef - cpm.es) + ' d' : '—') : task.duration_days + ' d'}</td>
      <td data-col="start"  style="text-align:center;font-size:var(--text-xs);cursor:${isSummary?'default':'pointer'}" title="${isSummary?'':'Clic para editar fecha inicio' + constraintTip}">${startStr}${constraintSuffix}</td>
      <td data-col="finish" style="text-align:center;font-size:var(--text-xs)">${finishStr}</td>
      <td data-col="pct"  style="padding:3px 6px">${pctCell}</td>
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
    // ---- Multi-select: Ctrl/Cmd+Click ----
    if ((e.ctrlKey || e.metaKey) && !e.target.closest('.expand-btn') && !e.target.closest('.row-more-btn')) {
      const mRow = e.target.closest('tr[data-id]');
      if (mRow) {
        e.preventDefault();
        const mid = mRow.dataset.id;
        if (this._selectedIds.has(mid)) this._selectedIds.delete(mid);
        else { this._selectedIds.add(mid); this._lastClickedId = mid; }
        this._renderSelectionState();
        return;
      }
    }
    // ---- Multi-select: Shift+Click (range) ----
    if (e.shiftKey && this._lastClickedId && !e.target.closest('.expand-btn') && !e.target.closest('.row-more-btn')) {
      const mRow = e.target.closest('tr[data-id]');
      if (mRow) {
        e.preventDefault();
        const allRows = [...this._body.querySelectorAll('tr[data-id]')];
        const lastIdx = allRows.findIndex(r => r.dataset.id === this._lastClickedId);
        const thisIdx = allRows.indexOf(mRow);
        if (lastIdx >= 0 && thisIdx >= 0) {
          const [s, e2] = [Math.min(lastIdx, thisIdx), Math.max(lastIdx, thisIdx)];
          for (let i = s; i <= e2; i++) this._selectedIds.add(allRows[i].dataset.id);
          this._renderSelectionState();
          return;
        }
      }
    }
    // Clic en icono de notas
    const notesIconEl = e.target.closest('.task-notes-icon');
    if (notesIconEl) {
      e.stopPropagation();
      const noteRow = notesIconEl.closest('tr[data-id]');
      if (noteRow) this._openNotesEdit(noteRow.dataset.id);
      return;
    }
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
      if (col === 'wbs' && task) {
        this._startEdit(id, col, cell);
        return;
      }
      if (col === 'type' && task && !this._isSummary(id)) {
        this._startEdit(id, col, cell);
        return;
      }
    }
    // Seleccionar fila (click simple: limpia multi-selección)
    if (row) {
      this._selectedIds.clear();
      this._lastClickedId = row.dataset.id;
      this._renderSelectionState();
      appState.selectTask(row.dataset.id);
    }
  }

  _onBodyDblClick(e) {
    const cell = e.target.closest('td[data-col]');
    const row  = e.target.closest('tr[data-id]');
    if (!cell || !row) return;
    const col  = cell.dataset.col;
    const id   = row.dataset.id;
    if (['name','dur','pct','start','wbs','type'].includes(col)) {
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
    if (e.key === 'Escape') {
      if (this._selectedIds.size > 0) { this._selectedIds.clear(); this._lastClickedId = null; this._renderSelectionState(); }
      else this._cancelEdit();
    }
    if (e.key === 'Delete' && !this._editingCell) {
      document.dispatchEvent(new CustomEvent('wbs-confirm-delete', { detail: { taskId: id, fn: () => this._deleteTask(id) } }));
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
    } else if (col === 'wbs') {
      const wbsCodes = _calcWbsCodes(appState.state.tasks);
      val = wbsCodes.get(rowId) ?? '';
    } else if (col === 'type') {
      // Select — flujo especial, retorno anticipado
      cell.classList.add('editing');
      cell.innerHTML = `<select class="inline-input" aria-label="Tipo de actividad" style="width:100%;box-sizing:border-box;font-size:var(--text-xs)">
        <option value="task" ${task.type === 'task' ? 'selected' : ''}>Tarea</option>
        <option value="milestone" ${task.type === 'milestone' ? 'selected' : ''}>Hito</option>
      </select>`;
      const sel = cell.querySelector('select');
      sel.focus();
      const commitSel = () => { if (!this._editingCell) return; this._commitEdit(rowId, 'type', sel.value); };
      sel.addEventListener('change', commitSel);
      sel.addEventListener('blur',   commitSel);
      sel.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); this._cancelEdit(); } });
      this._editingCell = { rowId, col: 'type', cell };
      return;
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
    } else if (col === 'wbs') {
      if (!rawVal.trim()) { this.render(); return; }
      const wbsCodes = _calcWbsCodes(appState.state.tasks);
      const wbsToId  = new Map([...wbsCodes.entries()].map(([id, wbs]) => [wbs, id]));
      const parts    = rawVal.trim().split('.');
      const pos      = parseInt(parts[parts.length - 1]);
      if (isNaN(pos) || pos < 1) { this.render(); return; }
      let newParentId = null;
      if (parts.length > 1) {
        const parentWbs = parts.slice(0, -1).join('.');
        newParentId = wbsToId.get(parentWbs) ?? null;
        if (!newParentId) { this.render(); return; }
      }
      if (newParentId === rowId) { this.render(); return; }
      // Evitar mover una tarea dentro de sus propios descendientes
      const isDescendant = (candidateId, ancestorId) => {
        let cur = appState.state.tasks.get(candidateId);
        while (cur?.parent_id) {
          if (cur.parent_id === ancestorId) return true;
          cur = appState.state.tasks.get(cur.parent_id);
        }
        return false;
      };
      if (newParentId && isDescendant(newParentId, rowId)) { this.render(); return; }
      const siblings = [...appState.state.tasks.values()]
        .filter(t => !t.deleted_at && t.id !== rowId && t.parent_id === newParentId)
        .sort((a, b) => a.sort_order - b.sort_order);
      let newSortOrder;
      if (!siblings.length)           newSortOrder = 1000;
      else if (pos <= 1)              newSortOrder = siblings[0].sort_order - 1;
      else if (pos > siblings.length) newSortOrder = siblings[siblings.length - 1].sort_order + 1;
      else                            newSortOrder = (siblings[pos - 2].sort_order + siblings[pos - 1].sort_order) / 2;
      appState.dispatch({ type: 'MOVE_TASK', payload: { id: rowId, newParentId, newSortOrder } });
      return;
    } else if (col === 'type') {
      if (!rawVal || rawVal === task.type) { this.render(); return; }
      const typeFields = { type: rawVal };
      if (rawVal === 'milestone') typeFields.duration_days = 0;
      appState.dispatch({ type: 'UPDATE_TASK', payload: { id: rowId, fields: typeFields } });
      return;
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

  // ---- Selección múltiple ----

  _renderSelectionState() {
    const n = this._selectedIds.size;
    this._body.querySelectorAll('tr[data-id]').forEach(tr => {
      tr.classList.toggle('wbs-row-selected', this._selectedIds.has(tr.dataset.id));
    });
    if (this._bulkBar) {
      this._bulkBar.style.display = n > 0 ? 'flex' : 'none';
      const cnt = this._bulkBar.querySelector('#wbs-bulk-count');
      if (cnt) cnt.textContent = `${n} fila${n !== 1 ? 's' : ''} seleccionada${n !== 1 ? 's' : ''}`;
    }
  }

  /** @param {string} action */
  _handleBulkAction(action) {
    const ids = [...this._selectedIds];
    if (!ids.length && action !== 'clear') return;
    switch (action) {
      case 'edit':    this._openBulkEdit(ids); break;
      case 'indent':  ids.forEach(id => this._indentTask(id));  break;
      case 'outdent': ids.forEach(id => this._outdentTask(id)); break;
      case 'up':      this._bulkMoveVertical(ids, -1); break;
      case 'down':    this._bulkMoveVertical(ids,  1); break;
      case 'clear':
        this._selectedIds.clear();
        this._lastClickedId = null;
        this._renderSelectionState();
        break;
    }
  }

  /** @param {string[]} ids */
  _openBulkEdit(ids) {
    const tasks = ids.map(id => appState.state.tasks.get(id)).filter(t => t && !t.deleted_at);
    if (!tasks.length) return;

    let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-bulk-edit'));
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'dlg-bulk-edit';
      dlg.style.cssText = 'border:none;border-radius:12px;padding:0;min-width:320px;max-width:420px;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden;background:var(--clr-surface);color:var(--clr-text)';
      document.body.appendChild(dlg);
      dlg.setAttribute('aria-modal', 'true');
      dlg.setAttribute('aria-labelledby', 'dlg-be-title');
    }
    dlg.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2)">
        <span id="dlg-be-title" style="font-weight:700;font-size:14px">✏️ Editar en bloque — ${tasks.length} tarea${tasks.length!==1?'s':''}</span>
        <button id="dlg-be-close" class="btn btn-icon btn-sm" aria-label="Cerrar">✕</button>
      </div>
      <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <p style="font-size:12px;color:var(--clr-text-3);margin:0">Deja vacío los campos que no deseas cambiar.</p>
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">% Avance
          <input id="dlg-be-pct" type="number" min="0" max="100" placeholder="— sin cambio —"
            style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:13px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Duración (días) <small style="font-weight:400;color:var(--clr-text-3)">(solo tareas hoja)</small>
          <input id="dlg-be-dur" type="number" min="1" placeholder="— sin cambio —"
            style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:13px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Tipo <small style="font-weight:400;color:var(--clr-text-3)">(solo tareas hoja)</small>
          <select id="dlg-be-type"
            style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:13px;background:var(--clr-surface-2);color:var(--clr-text)">
            <option value="">— sin cambio —</option>
            <option value="task">Tarea</option>
            <option value="milestone">Hito</option>
          </select>
        </label>
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--clr-border);background:var(--clr-surface-2);display:flex;gap:8px;justify-content:flex-end">
        <button id="dlg-be-cancel" class="btn btn-ghost btn-sm">Cancelar</button>
        <button id="dlg-be-ok" class="btn btn-primary btn-sm">Aplicar cambios</button>
      </div>`;

    const close = () => dlg.close();
    dlg.querySelector('#dlg-be-close').addEventListener('click', close, { once: true });
    dlg.querySelector('#dlg-be-cancel').addEventListener('click', close, { once: true });
    dlg.querySelector('#dlg-be-ok').addEventListener('click', () => {
      const pctRaw  = /** @type {HTMLInputElement} */ (dlg.querySelector('#dlg-be-pct')).value;
      const durRaw  = /** @type {HTMLInputElement} */ (dlg.querySelector('#dlg-be-dur')).value;
      const typeRaw = /** @type {HTMLSelectElement} */ (dlg.querySelector('#dlg-be-type')).value;
      let applied = 0;
      for (const task of tasks) {
        const isSummary = this._isSummary(task.id);
        const fields = {};
        if (pctRaw !== '') {
          const v = parseFloat(pctRaw);
          if (!isNaN(v) && v >= 0 && v <= 100) {
            fields.percent_complete = v;
            if (v === 100) fields.actual_finish = new Date().toISOString().slice(0, 10);
          }
        }
        if (durRaw !== '' && !isSummary && task.type !== 'milestone') {
          const v = parseFloat(durRaw);
          if (!isNaN(v) && v > 0) fields.duration_days = v;
        }
        if (typeRaw && !isSummary) {
          fields.type = typeRaw;
          if (typeRaw === 'milestone') fields.duration_days = 0;
        }
        if (Object.keys(fields).length) {
          appState.dispatch({ type: 'UPDATE_TASK', payload: { id: task.id, fields } });
          applied++;
        }
      }
      dlg.close();
      if (applied > 0 && this._ariaLive)
        this._ariaLive.textContent = `${applied} tarea${applied!==1?'s':''} actualizada${applied!==1?'s':''}`;
    }, { once: true });

    if (!dlg.open) dlg.showModal();
    setTimeout(() => /** @type {HTMLElement|null} */ (dlg.querySelector('#dlg-be-pct'))?.focus(), 50);
  }

  /**
   * Mueve las filas seleccionadas hacia arriba (dir=-1) o abajo (dir=1) dentro de su grupo padre.
   * @param {string[]} ids
   * @param {number} dir  -1 = subir, +1 = bajar
   */
  _bulkMoveVertical(ids, dir) {
    const allRows = [...this._body.querySelectorAll('tr[data-id]')];
    const visOrder = allRows.map(r => r.dataset.id);
    const selectedSet = new Set(ids);
    // Ordenar por posición visual; para subir proceso top→bottom, para bajar bottom→top
    const sorted = ids
      .map(id => ({ id, vi: visOrder.indexOf(id) }))
      .filter(x => x.vi >= 0)
      .sort((a, b) => dir < 0 ? a.vi - b.vi : b.vi - a.vi);

    for (const { id } of sorted) {
      const task = appState.state.tasks.get(id);
      if (!task) continue;
      const siblings = [...appState.state.tasks.values()]
        .filter(t => !t.deleted_at && t.parent_id === task.parent_id)
        .sort((a, b) => a.sort_order - b.sort_order);
      const idx = siblings.findIndex(t => t.id === id);
      if (idx < 0) continue;
      const neighbor = siblings[idx + dir];
      if (!neighbor || selectedSet.has(neighbor.id)) continue; // en el límite o vecino también seleccionado
      const newOrder = dir < 0 ? neighbor.sort_order - 0.5 : neighbor.sort_order + 0.5;
      appState.dispatch({ type: 'MOVE_TASK', payload: { id, newParentId: task.parent_id, newSortOrder: newOrder } });
    }
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

    const isMulti = this._selectedIds.size > 1 && this._selectedIds.has(taskId);
    const multiCount = isMulti ? this._selectedIds.size : 0;

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.setAttribute('role', 'menu');

    if (isMulti) {
      menu.innerHTML = `
        <div class="context-menu-item" style="font-size:11px;color:var(--clr-text-3);padding:4px 16px;cursor:default" role="none">
          ${multiCount} filas seleccionadas
        </div>
        <div class="context-menu-sep"></div>
        <div class="context-menu-item" data-action="bulk-edit"    role="menuitem" tabindex="0">✏️ Editar en bloque</div>
        <div class="context-menu-sep"></div>
        <div class="context-menu-item" data-action="bulk-indent"  role="menuitem" tabindex="0">→ Indentar todas</div>
        <div class="context-menu-item" data-action="bulk-outdent" role="menuitem" tabindex="0">← Desindentar todas</div>
        <div class="context-menu-item" data-action="bulk-up"      role="menuitem" tabindex="0">↑ Mover todas arriba</div>
        <div class="context-menu-item" data-action="bulk-down"    role="menuitem" tabindex="0">↓ Mover todas abajo</div>
        <div class="context-menu-sep"></div>
        <div class="context-menu-item danger" data-action="bulk-delete" role="menuitem" tabindex="0">🗑 Eliminar seleccionadas</div>`;
    } else {
      menu.innerHTML = `
        <div class="context-menu-item" data-action="edit" role="menuitem" tabindex="0">✏️ Editar nombre</div>
        <div class="context-menu-item" data-action="notes" role="menuitem" tabindex="0">📝 Editar notas</div>
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
    }

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
    // Bulk actions (multi-select context menu)
    if (action.startsWith('bulk-')) {
      const ids = [...this._selectedIds];
      switch (action) {
        case 'bulk-edit':   this._openBulkEdit(ids); break;
        case 'bulk-indent': ids.forEach(id => this._indentTask(id));  break;
        case 'bulk-outdent':ids.forEach(id => this._outdentTask(id)); break;
        case 'bulk-up':     this._bulkMoveVertical(ids, -1); break;
        case 'bulk-down':   this._bulkMoveVertical(ids,  1); break;
        case 'bulk-delete':
          document.dispatchEvent(new CustomEvent('wbs-confirm-delete', {
            detail: {
              taskId,
              msg: `¿Eliminar las ${ids.length} filas seleccionadas? Esta acción no se puede deshacer.`,
              fn: () => ids.forEach(id => this._deleteTask(id)),
            },
          }));
          break;
      }
      return;
    }
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
      case 'notes':
        this._openNotesEdit(taskId);
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
        document.dispatchEvent(new CustomEvent('wbs-confirm-delete', { detail: { taskId, fn: () => this._deleteTask(taskId) } }));
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
        const isSum      = tasks.some(t => t.parent_id === after.id);
        const isExpanded = appState.state.expandedIds.has(after.id);
        if (isSum && isExpanded) {
          // Resumen expandido: insertar como primer hijo para que aparezca
          // en la fila inmediata siguiente (visual row + 1)
          parent_id = after.id;
          const firstChild = tasks
            .filter(t => t.parent_id === after.id)
            .sort((a, b) => a.sort_order - b.sort_order)[0];
          sort_order = firstChild ? firstChild.sort_order - 1 : 1;
        } else {
          // Hoja o resumen colapsado: insertar como hermano inmediato
          parent_id = after.parent_id;
          const sibs = tasks
            .filter(t => t.parent_id === after.parent_id)
            .sort((a, b) => a.sort_order - b.sort_order);
          const afterIdx = sibs.findIndex(t => t.id === after.id);
          const nextSib  = sibs[afterIdx + 1];
          sort_order = nextSib
            ? (after.sort_order + nextSib.sort_order) / 2
            : after.sort_order + 1;
        }
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

  _toggleSort(col) {
    if (this._sortCol === col) {
      this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this._sortCol = col;
      this._sortDir = 'asc';
    }
    this.render();
  }

  /** @param {Array<{task:any,depth:number,isSummary:boolean}>} rows */
  _applySort(rows) {
    const cpmResult = appState.state.cpmResult;
    return [...rows].sort((a, b) => {
      const ca = cpmResult?.tasks instanceof Map ? cpmResult.tasks.get(a.task.id) : null;
      const cb = cpmResult?.tasks instanceof Map ? cpmResult.tasks.get(b.task.id) : null;
      let va, vb;
      switch (this._sortCol) {
        case 'name':   va = (a.task.name ?? '').toLowerCase(); vb = (b.task.name ?? '').toLowerCase(); break;
        case 'dur':    va = a.task.duration_days ?? 0;         vb = b.task.duration_days ?? 0;         break;
        case 'start':  va = ca?.es ?? Infinity;                vb = cb?.es ?? Infinity;                break;
        case 'finish': va = ca?.ef ?? Infinity;                vb = cb?.ef ?? Infinity;                break;
        case 'tf':     va = ca?.tf ?? Infinity;                vb = cb?.tf ?? Infinity;                break;
        case 'ff':     va = ca?.ff ?? Infinity;                vb = cb?.ff ?? Infinity;                break;
        default: return 0;
      }
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return this._sortDir === 'asc' ? cmp : -cmp;
    });
  }

  // ---- Notas ----

  _openNotesEdit(taskId) {
    const task = appState.state.tasks.get(taskId);
    if (!task) return;
    let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-notes-edit'));
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'dlg-notes-edit';
      dlg.style.cssText = 'border:none;border-radius:12px;padding:0;min-width:360px;max-width:500px;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden;background:var(--clr-surface);color:var(--clr-text)';
      document.body.appendChild(dlg);
      dlg.setAttribute('aria-modal', 'true');
      dlg.setAttribute('aria-labelledby', 'dlg-notes-title');
    }
    dlg.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2)">
        <span id="dlg-notes-title" style="font-weight:700;font-size:14px">📝 Notas — ${_esc(task.name)}</span>
        <button id="dlg-notes-close" class="btn btn-icon btn-sm" aria-label="Cerrar">✕</button>
      </div>
      <div style="padding:16px">
        <textarea id="dlg-notes-ta" rows="6" placeholder="Escribe tus notas aquí…"
          style="width:100%;box-sizing:border-box;padding:10px;border:1px solid var(--clr-border);border-radius:8px;font-size:13px;background:var(--clr-surface-2);color:var(--clr-text);resize:vertical;font-family:inherit">${_esc(task.notes ?? '')}</textarea>
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--clr-border);background:var(--clr-surface-2);display:flex;gap:8px;justify-content:flex-end">
        <button id="dlg-notes-cancel" class="btn btn-ghost btn-sm">Cancelar</button>
        <button id="dlg-notes-ok" class="btn btn-primary btn-sm">Guardar notas</button>
      </div>`;
    const close = () => dlg.close();
    dlg.querySelector('#dlg-notes-close').addEventListener('click', close, { once: true });
    dlg.querySelector('#dlg-notes-cancel').addEventListener('click', close, { once: true });
    dlg.querySelector('#dlg-notes-ok').addEventListener('click', () => {
      const notes = /** @type {HTMLTextAreaElement} */ (dlg.querySelector('#dlg-notes-ta')).value.trim() || null;
      appState.dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, fields: { notes } } });
      dlg.close();
    }, { once: true });
    if (!dlg.open) dlg.showModal();
    setTimeout(() => /** @type {HTMLElement|null} */ (dlg.querySelector('#dlg-notes-ta'))?.focus(), 50);
  }
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

/**
 * Retorna el icono correspondiente al tipo de restricción de la tarea.
 * @param {string} constraintType @param {string|null} constraintDate
 */
function _constraintIcon(constraintType, constraintDate) {
  if (!constraintDate || !constraintType || constraintType === 'ASAP') return '';
  const icons = { SNET: '📌', SNLT: '⛔', MSO: '⚓', MFO: '⚓', FNET: '📌', FNLT: '⛔' };
  return icons[constraintType] ? ` ${icons[constraintType]}` : '';
}

/** @param {HTMLElement} row @param {number} dir */
function _focusNext(row, dir) {
  const rows = [...row.closest('tbody').querySelectorAll('tr[data-id]')];
  const idx  = rows.indexOf(row);
  const next = rows[idx + dir];
  if (next) next.focus();
}
