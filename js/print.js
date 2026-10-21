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
const ALL_PRINT_COLS = ['wbs','name','type','dur','start','finish','pct','tf','ff','pred','alerts'];

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
  const _wD = new Date(), _wDD = String(_wD.getDate()).padStart(2,'0'), _wMM = String(_wD.getMonth()+1).padStart(2,'0'), _wYY = _wD.getFullYear();
  document.title = _wProj ? `${_wProj.name}-Tabla EDT-${_wDD}${_wMM}${_wYY}` : 'Tabla EDT';
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
// Imprimir Gantt (ventana con SVG vectorial + window.print)
// ============================================================

/**
 * Abre una ventana de vista previa del Gantt con botón para guardar PDF via window.print.
 * Los SVG se dividen en tiles usando viewBox para cortar el contenido sin rasterizar.
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
        exceptions: (calExceptions ?? []).filter(e => !e.deleted_at)
          .map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };

  import('./gantt-svg.js').then(({ renderGanttSvg }) => {
    const cal       = new Calendar(calDef);
    const startDate = isoToDate(project.start_date || new Date().toISOString().slice(0,10));

    const savedCols = getPrintCols();
    const ALL_EXTRA = ['wbs','type','dur','start','finish','pct','tf','ff','pred'];
    const ganttExtraCols = ALL_EXTRA.filter(c => savedCols.includes(c));

    let barLabels = ['name'];
    try { barLabels = JSON.parse(localStorage.getItem('gantt-bar-labels') || '["name"]'); } catch { /* ignore */ }

    const svgStr = renderGanttSvg({
      tasks, deps, cpmResult, calendar: cal,
      projectStart: startDate, rows,
      nearThreshold: appState.state.nearThreshold ?? 5,
      extraCols: ganttExtraCols,
      barLabels,
    });

    const _dG  = new Date();
    const _gDD = String(_dG.getDate()).padStart(2,'0');
    const _gMM = String(_dG.getMonth()+1).padStart(2,'0');
    const _gYY = _dG.getFullYear();
    const today      = _dG.toLocaleDateString('es-PE');
    const _gTitle    = `${project.name} - Gantt - ${_gDD}/${_gMM}/${_gYY}`;
    const _pdfFile   = `${project.name}-Gantt-${_gDD}${_gMM}${_gYY}.pdf`;
    const _projLabel = _esc(project.name);

    // Extraer atributos del SVG raíz para obtener dimensiones reales
    const _svgWMatch = svgStr.match(/\swidth="([^"]+)"/);
    const _svgHMatch = svgStr.match(/\sheight="([^"]+)"/);
    const _svgW = _svgWMatch ? parseFloat(_svgWMatch[1]) : 1200;
    const _svgH = _svgHMatch ? parseFloat(_svgHMatch[1]) : 800;

    // Extraer el contenido interior del SVG (sin la etiqueta <svg>...</svg>)
    // para re-usarlo en cada tile con diferente viewBox
    const _svgInnerMatch = svgStr.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/);
    const _svgInner = _svgInnerMatch ? _svgInnerMatch[1] : svgStr;

    const html = `<!doctype html>
<html lang="es"><head>
  <meta charset="UTF-8">
  <title>${_esc(_gTitle)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body  { font-family: 'Segoe UI', system-ui, sans-serif; background:#cfd8dc; }
    .controls { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
                font-size: 12px; flex-wrap: wrap; background:#263238;
                border-bottom: 2px solid #37474f; position: sticky; top:0; z-index:10; }
    .controls label { display: flex; align-items: center; gap: 5px; color: #90a4ae; }
    .controls input[type=number] { width: 46px; padding: 2px 4px; border: 1px solid #546e7a;
                                   border-radius: 4px; font-size: 12px; text-align:center;
                                   background:#37474f; color:#ecf0f1; }
    .btn-c { border: 1px solid #546e7a; border-radius: 4px; padding: 4px 10px;
             font-size: 12px; cursor: pointer; background: #37474f; color: #ecf0f1; white-space:nowrap; }
    .btn-c:hover, .btn-c.active { background: #1976D2; color: #fff; border-color: #1976D2; }
    .btn-print { background: #1976D2; color: #fff; border: none; border-radius: 4px;
                 padding: 6px 16px; font-size: 13px; cursor: pointer; font-weight:600; }
    .btn-print:hover { background: #1565C0; }
    .sep { width: 1px; height: 20px; background: #546e7a; flex-shrink:0; }
    .lbl-sm { font-size:11px; color:#78909C; white-space:nowrap; }
    input[type=text].fn-inp { font-size:12px; padding:3px 8px; border:1px solid #546e7a;
                border-radius:3px; background:#37474f; color:#ecf0f1; width:260px; }
    .preview { padding: 20px; display:flex; flex-direction:column; align-items:center; gap:16px; min-height:calc(100vh - 52px); }
    .page-tile { background:#fff; box-shadow:0 4px 14px rgba(0,0,0,.4); position:relative; flex-shrink:0; }
    .page-tile svg { display:block; }
    .page-foot { position:absolute; bottom:4mm; left:10mm; right:10mm;
                 display:flex; justify-content:space-between; font-size:7pt; color:#9e9e9e;
                 border-top:1px solid #e0e0e0; padding-top:2px; }
    @media print {
      body { background:#fff; }
      .controls { display:none !important; }
      .preview { padding:0; gap:0; background:#fff; min-height:0; }
      .page-tile { box-shadow:none; break-after:page; page-break-after:always; margin:0; }
      .page-tile:last-child { break-after:avoid; page-break-after:avoid; }
      .page-foot { display:flex !important; }
    }
  </style>
</head><body>
  <div class="controls">
    <button class="btn-print" id="btn-pdf" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
    <div class="sep"></div>
    <span class="lbl-sm">Orientaci&#243;n:</span>
    <button class="btn-c active" id="btn-land" onclick="setOrient('landscape')">&#x2B1B; Horizontal</button>
    <button class="btn-c" id="btn-port" onclick="setOrient('portrait')">&#x1F532; Vertical</button>
    <div class="sep"></div>
    <label>Hojas H: <input type="number" id="h-pages" min="1" max="10" value="1" onchange="renderTiles()"></label>
    <label>Hojas V: <input type="number" id="v-pages" min="1" max="10" value="1" onchange="renderTiles()"></label>
    <div class="sep"></div>
    <span class="lbl-sm">&#x1F4C1; Archivo:</span>
    <input type="text" id="fn-inp" class="fn-inp" value="${_pdfFile}" title="Nombre sugerido del archivo PDF">
    <div class="sep"></div>
    <span class="lbl-sm">${today}</span>
    <div class="sep"></div>
    <button class="btn-c" onclick="window.close()">&#x2715; Cerrar</button>
  </div>
  <div class="preview" id="preview"></div>

  <script>
    const SVG_W = ${_svgW};
    const SVG_H = ${_svgH};
    const SVG_INNER = ${JSON.stringify(_svgInner)};
    const PROJ_NAME = ${JSON.stringify(project.name)};
    const TOTAL_PAGES_REF = { v: 1 };

    let _orient = 'landscape';

    function setOrient(o) {
      _orient = o;
      document.getElementById('btn-land').classList.toggle('active', o === 'landscape');
      document.getElementById('btn-port').classList.toggle('active', o === 'portrait');
      renderTiles();
    }

    function renderTiles() {
      const hPages = Math.max(1, Math.min(10, parseInt(document.getElementById('h-pages').value) || 1));
      const vPages = Math.max(1, Math.min(10, parseInt(document.getElementById('v-pages').value) || 1));
      const isLand = _orient === 'landscape';
      const MARG = 10; // mm
      const A4w = isLand ? 297 : 210;
      const A4h = isLand ? 210 : 297;
      const availW = A4w - 2 * MARG; // mm
      const availH = A4h - 2 * MARG - 8; // mm (8mm reservado para footer)

      const cellW = SVG_W / hPages;
      const cellH = SVG_H / vPages;
      const totalPages = hPages * vPages;
      TOTAL_PAGES_REF.v = totalPages;

      // @page CSS
      let ps = document.getElementById('_ps') || document.createElement('style');
      ps.id = '_ps';
      ps.textContent = '@page{size:A4 ' + _orient + ';margin:' + MARG + 'mm ' + MARG + 'mm ' + (MARG+8) + 'mm ' + MARG + 'mm}';
      document.head.appendChild(ps);

      const preview = document.getElementById('preview');
      preview.innerHTML = '';
      let pageNum = 0;

      for (let j = 0; j < vPages; j++) {
        for (let i = 0; i < hPages; i++) {
          pageNum++;
          const vbX = i * cellW;
          const vbY = j * cellH;

          const tile = document.createElement('div');
          tile.className = 'page-tile';
          tile.style.width = availW + 'mm';
          tile.style.height = (availH + 8) + 'mm';

          const svgEl = document.createElementNS('http://www.w3.org/2000/svg','svg');
          svgEl.setAttribute('viewBox', vbX + ' ' + vbY + ' ' + cellW + ' ' + cellH);
          svgEl.setAttribute('width', availW + 'mm');
          svgEl.setAttribute('height', availH + 'mm');
          svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
          svgEl.setAttribute('preserveAspectRatio', 'xMinYMin meet');
          svgEl.innerHTML = SVG_INNER;
          tile.appendChild(svgEl);

          // Footer por tile
          const foot = document.createElement('div');
          foot.className = 'page-foot';
          foot.innerHTML = '<span>' + PROJ_NAME + '</span><span>ECM Project</span><span>' + pageNum + ' / ' + totalPages + '</span>';
          tile.appendChild(foot);

          preview.appendChild(tile);
        }
      }
    }

    renderTiles();
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
