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

/** Lee la selección de columnas guardada (para tabla EDT y SVG Gantt). */
export function getPrintCols() {
  try {
    const saved = localStorage.getItem('print-cols');
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return ['wbs', 'name', 'dur', 'start', 'finish', 'pct', 'tf'];
}

/** Guarda la selección de columnas. */
export function setPrintCols(cols) {
  localStorage.setItem('print-cols', JSON.stringify(cols));
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

  import('./gantt-svg.js?v=2').then(({ renderGanttSvg }) => {
    const cal       = new Calendar(calDef);
    const startDate = isoToDate(project.start_date);

    const savedCols = getPrintCols();
    const ganttExtraCols = ['dur','start','finish','pct','tf'].filter(c => savedCols.includes(c));
    const svgStr = renderGanttSvg({
      tasks, deps, cpmResult, calendar: cal,
      projectStart: startDate, rows,
      nearThreshold: appState.state.nearThreshold ?? 5,
      extraCols: ganttExtraCols,
    });

    const today   = new Date().toLocaleDateString('es-PE');
    const html    = `<!doctype html>
<html lang="es"><head>
  <meta charset="UTF-8">
  <title>Gantt — ${_esc(project.name)}</title>
  <style>
    @page { size: A3 landscape; margin: 15mm; }
    body  { margin: 0; font-family: 'Segoe UI', system-ui, sans-serif; }
    .header { display: flex; justify-content: space-between; align-items: center;
              padding: 0 0 8px; border-bottom: 2px solid #1976D2; margin-bottom: 12px; }
    .proj-name { font-size: 16px; font-weight: 700; color: #1976D2; }
    .meta      { font-size: 11px; color: #78909C; }
    svg { max-width: 100%; height: auto; }
  </style>
</head><body>
  <div class="header">
    <div class="proj-name">${_esc(project.name)}</div>
    <div class="meta">Generado: ${today} · v7 Gantt</div>
  </div>
  ${svgStr}
  <script>window.onload = () => { window.print(); }<\/script>
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
