// @ts-check
/**
 * print.js — Preparación de impresión del cronograma.
 *
 * Expone dos funciones:
 *   • printWbsTable()  — imprime la tabla EDT completa (A4 paisaje)
 *   • printGantt(rows) — abre ventana con SVG vectorial del Gantt listo para imprimir
 */

import { appState }      from './state.js';
import { isoToDate, Calendar, fmtDate } from './calendar.js';
import { exportSvg }     from './io.js';

// ============================================================
// Imprimir tabla EDT
// ============================================================

/** Columnas disponibles para la tabla EDT */
const ALL_PRINT_COLS = ['wbs','name','type','dur','start','finish','pct','tf','ff','pred'];

const _DEFAULT_COLS = ['wbs','name','type','dur','start','finish','pct','tf','pred','alerts'];

/** Lee la selección de columnas guardada (comparte clave con el menú Columnas web). */
export function getPrintCols() {
  try {
    const saved = localStorage.getItem('wbs-col-visibility');
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  // Primera vez: guardar el default para que futuras lecturas lo encuentren
  try { localStorage.setItem('wbs-col-visibility', JSON.stringify(_DEFAULT_COLS)); } catch { /* ignore */ }
  return _DEFAULT_COLS;
}

/** Guarda la selección de columnas. */
export function setPrintCols(cols) {
  localStorage.setItem('wbs-col-visibility', JSON.stringify(cols));
}

/** Imprime la tabla EDT completa mostrando solo las columnas seleccionadas. */
export function printWbsTable() {
  const selected = new Set(getPrintCols());
  // Ocultar columnas no seleccionadas añadiendo una regla CSS temporal
  const style = document.createElement('style');
  style.id = 'print-col-override';
  const hidden = ALL_PRINT_COLS.filter(c => !selected.has(c));
  if (hidden.length) {
    style.textContent = `@media print { ${hidden.map(c =>
      `.wbs-table th[data-col="${c}"], .wbs-table td[data-col="${c}"] { display: none !important; }`
    ).join(' ')} }`;
    document.head.appendChild(style);
  }
  document.body.classList.add('printing');
  window.print();
  setTimeout(() => {
    document.body.classList.remove('printing');
    document.getElementById('print-col-override')?.remove();
  }, 1000);
}

// ============================================================
// Imprimir Gantt (ventana con SVG)
// ============================================================

/**
 * Abre una ventana de impresión con el diagrama Gantt en SVG vectorial.
 * @param {Array<{id:string,isSummary:boolean,depth:number}>} rows
 */
export function printGantt(rows) {
  const { project, tasks, deps, cpmResult, calendar, calExceptions } = appState.state;
  if (!project || !cpmResult) {
    alert('No hay resultados CPM disponibles aún. Espere que se complete el cálculo.');
    return;
  }

  const calDef = calendar
    ? { work_week: calendar.work_week,
        exceptions: calExceptions.filter(e => !e.deleted_at)
          .map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };

  const { renderGanttSvg } = /** @type {any} */ ({ renderGanttSvg: null });

  import('./gantt-svg.js?v=6').then(({ renderGanttSvg }) => {
    const cal       = new Calendar(calDef);
    const startDate = isoToDate(project.start_date);

    const savedCols = getPrintCols();
    // Todas las columnas extra soportadas por gantt-svg (en orden de aparición)
    const ALL_EXTRA = ['wbs','type','dur','start','finish','pct','tf','ff','pred'];
    const ganttExtraCols = ALL_EXTRA.filter(c => savedCols.includes(c));

    // Etiquetas de barras: leer la misma selección que usa el canvas
    let barLabels = ['name'];
    try { barLabels = JSON.parse(localStorage.getItem('gantt-bar-labels') || '["name"]'); } catch { /* ignore */ }

    const svgStr = renderGanttSvg({
      tasks, deps, cpmResult, calendar: cal,
      projectStart: startDate, rows,
      nearThreshold: appState.state.nearThreshold ?? 5,
      extraCols: ganttExtraCols,
      barLabels,
    });

    const today   = new Date().toLocaleDateString('es-PE');
    const html    = `<!doctype html>
<html lang="es"><head>
  <meta charset="UTF-8">
  <title>Gantt — ${_esc(project.name)}</title>
  <style id="page-style">@page { size: landscape; margin: 10mm; }</style>
  <style>
    * { box-sizing: border-box; }
    body  { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; }
    .header { display: flex; justify-content: space-between; align-items: center;
              padding: 0 0 8px; border-bottom: 2px solid #1976D2; margin-bottom: 10px; }
    .proj-name { font-size: 16px; font-weight: 700; color: #1976D2; }
    .meta      { font-size: 11px; color: #78909C; }
    svg { width: var(--gantt-zoom, 100%); max-width: none; height: auto; display: block; }
    .controls { display: flex; align-items: center; gap: 12px; padding: 8px 0 10px;
                font-family: 'Segoe UI', system-ui, sans-serif; font-size: 12px; flex-wrap: wrap; }
    .controls label { display: flex; align-items: center; gap: 6px; color: #455A64; }
    .controls input[type=range] { width: 120px; accent-color: #1976D2; }
    .btn-c { border: 1px solid #90A4AE; border-radius: 6px; padding: 5px 13px;
             font-size: 12px; cursor: pointer; background: #fff; color: #455A64; }
    .btn-c:hover, .btn-c.active { background: #1976D2; color: #fff; border-color: #1976D2; }
    .btn-print { background: #1976D2; color: #fff; border: none; border-radius: 6px;
                 padding: 6px 16px; font-size: 13px; cursor: pointer; }
    .btn-print:hover { background: #1565C0; }
    .sep { width: 1px; height: 22px; background: #CFD8DC; }
    @media print { .controls { display: none !important; } }
  </style>
</head><body>
  <div class="controls">
    <label>Zoom:
      <input type="range" id="zoom" min="30" max="300" value="100" step="5">
      <span id="zoom-val" style="min-width:40px">100%</span>
    </label>
    <div class="sep"></div>
    <span style="color:#78909C">Orientación:</span>
    <button class="btn-c active" id="btn-land" onclick="setOrient('landscape')">⬛ Horizontal</button>
    <button class="btn-c" id="btn-port" onclick="setOrient('portrait')">🔲 Vertical</button>
    <div class="sep"></div>
    <button class="btn-print" onclick="window.print()">🖨 Imprimir</button>
    <span style="color:#78909C;font-size:11px">${today}</span>
  </div>
  <div class="header">
    <div class="proj-name">${_esc(project.name)}</div>
    <div class="meta">v9 Gantt — autoajuste + columnas configurables</div>
  </div>
  ${svgStr}
  <script>
    const zoom = document.getElementById('zoom');
    const zoomVal = document.getElementById('zoom-val');
    const svg = document.querySelector('svg');
    zoom.addEventListener('input', () => {
      zoomVal.textContent = zoom.value + '%';
      svg.style.width = zoom.value + '%';
    });
    function setOrient(o) {
      document.getElementById('page-style').textContent = '@page { size: ' + o + '; margin: 10mm; }';
      document.getElementById('btn-land').classList.toggle('active', o === 'landscape');
      document.getElementById('btn-port').classList.toggle('active', o === 'portrait');
    }
  <\/script>
</body></html>`;

    const win = window.open('', '_blank', 'width=1200,height=800');
    if (!win) { alert('El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.'); return; }
    win.document.write(html);
    win.document.close();
  });
}

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
