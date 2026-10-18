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
  try { localStorage.setItem('wbs-col-visibility', JSON.stringify(cols)); } catch { /* ignore */ }
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
  // Vaciar title temporalmente para que el browser no muestre "Cronogramas" en la cabecera de impresión
  const origTitle = document.title;
  const _wProj = appState.state.project;
  document.title = _wProj ? `${_wProj.name} — Tabla EDT` : 'Tabla EDT';
  const _footerStyle = document.createElement('style');
  _footerStyle.id = 'print-ecm-footer';
  _footerStyle.textContent = `@media print {
    #app::after {
      content: "ECM Project v1.0.0 | © 2026 E. Chávez";
      display: block;
      font-size: 7pt;
      color: #9E9E9E;
      text-align: center;
      margin-top: 4mm;
      border-top: 1px solid #E0E0E0;
      padding-top: 3px;
    }
    .wbs-table, .wbs-table th, .wbs-table td { font-family: 'Arial Narrow', Arial, sans-serif !important; }
  }`;
  document.head.appendChild(_footerStyle);
  document.body.classList.add('printing');
  window.print();
  setTimeout(() => {
    document.title = origTitle;
    document.body.classList.remove('printing');
    document.getElementById('print-col-override')?.remove();
    document.getElementById('print-ecm-footer')?.remove();
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
    document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'No hay resultados CPM disponibles aún. Espere que se complete el cálculo.', type: 'warn' } }));
    return;
  }

  const calDef = calendar
    ? { work_week: calendar.work_week,
        exceptions: calExceptions.filter(e => !e.deleted_at)
          .map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };

  import('./gantt-svg.js').then(({ renderGanttSvg }) => {
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

    const _dG = new Date();
    const today   = _dG.toLocaleDateString('es-PE');
    const _gDateStr = `${String(_dG.getDate()).padStart(2,'0')}-${String(_dG.getMonth()+1).padStart(2,'0')}-${_dG.getFullYear()}`;
    const _gTitle = `${project.name} - Gantt - ${_gDateStr}`;
    const html    = `<!doctype html>
<html lang="es"><head>
  <meta charset="UTF-8">
  <title>${_gTitle}</title>
  <style id="page-style">@page { size: landscape; margin: 10mm 10mm 15mm; }</style>
  <style>
    * { box-sizing: border-box; }
    body  { margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, sans-serif; }
    .header { display: flex; align-items: center; padding: 0 0 6px;
              border-bottom: 2px solid #1976D2; margin-bottom: 8px; }
    .proj-name { font-size: 16px; font-weight: 700; color: #1976D2; }
    .gantt-frame { border: 0.25px solid #546E7A; display: inline-block; width: 100%; }
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
    @media print { .controls { display: none !important; }
      footer.ecm-footer { display: block; position: fixed; bottom: 0; left: 0; right: 0;
        font-size: 7pt; color: #9E9E9E; text-align: center;
        border-top: 1px solid #E0E0E0; padding-top: 3px; padding-bottom: 2px;
        background: white; }
    }
    footer.ecm-footer { display: none; }
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
  </div>
  <div class="gantt-frame">
    ${svgStr}
  </div>
  <footer class="ecm-footer">ECM Project v1.0.0 | &#169; 2026 E. Ch&#225;vez</footer>
  <script>
    const zoom = document.getElementById('zoom');
    const zoomVal = document.getElementById('zoom-val');
    const svg = document.querySelector('svg');
    zoom.addEventListener('input', () => {
      zoomVal.textContent = zoom.value + '%';
      svg.style.width = zoom.value + '%';
    });
    function setOrient(o) {
      document.getElementById('page-style').textContent = '@page { size: ' + o + '; margin: 10mm 10mm 15mm; }';
      document.getElementById('btn-land').classList.toggle('active', o === 'landscape');
      document.getElementById('btn-port').classList.toggle('active', o === 'portrait');
    }
  <\/script>
</body></html>`;

    const win = window.open('', '_blank', 'width=1200,height=800');
    if (!win) { document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.', type: 'warn' } })); return; }
    win.document.write(html);
    win.document.close();
  });
}

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
