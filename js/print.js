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
// Imprimir Gantt (ventana con SVG)
// ============================================================

/**
 * Abre una ventana de vista previa del Gantt con botón para guardar PDF via jsPDF.
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

    const html = `<!doctype html>
<html lang="es"><head>
  <meta charset="UTF-8">
  <title>${_esc(_gTitle)}</title>
  <style>
    * { box-sizing: border-box; }
    body  { margin: 0; padding: 0; font-family: 'Segoe UI', system-ui, sans-serif; background:#f5f7fa; }
    .controls { display: flex; align-items: center; gap: 10px; padding: 8px 12px;
                font-size: 12px; flex-wrap: wrap; background:#fff;
                border-bottom: 1px solid #CFD8DC; position: sticky; top:0; z-index:10; }
    .controls label { display: flex; align-items: center; gap: 5px; color: #455A64; }
    .controls input[type=range] { width: 100px; accent-color: #1976D2; }
    .controls input[type=number] { width: 46px; padding: 2px 4px; border: 1px solid #90A4AE;
                                   border-radius: 4px; font-size: 12px; text-align:center; }
    .btn-c { border: 1px solid #90A4AE; border-radius: 6px; padding: 4px 11px;
             font-size: 12px; cursor: pointer; background: #fff; color: #455A64; }
    .btn-c:hover, .btn-c.active { background: #1976D2; color: #fff; border-color: #1976D2; }
    .btn-print { background: #1976D2; color: #fff; border: none; border-radius: 6px;
                 padding: 6px 16px; font-size: 13px; cursor: pointer; font-weight:600; }
    .btn-print:hover { background: #1565C0; }
    .btn-print:disabled { background: #90A4AE; cursor: not-allowed; }
    .sep { width: 1px; height: 20px; background: #CFD8DC; flex-shrink:0; }
    .lbl-sm { font-size:11px; color:#78909C; }
    .header { display: flex; align-items: center; padding: 6px 12px 4px;
              border-bottom: 2px solid #1976D2; background:#fff; }
    .proj-name { font-size: 15px; font-weight: 700; color: #1976D2; }
    .gantt-frame { border: 0.25px solid #546E7A; display: block; overflow: auto;
                   margin: 8px 12px; background:#fff; }
    svg { display: block; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"><\/script>
</head><body>
  <div class="controls">
    <label>Zoom:
      <input type="range" id="zoom" min="30" max="300" value="100" step="5">
      <span id="zoom-val" style="min-width:38px">100%</span>
    </label>
    <div class="sep"></div>
    <span class="lbl-sm">Orientación:</span>
    <button class="btn-c active" id="btn-land" onclick="setPdfOrient('landscape')">⬛ Horizontal</button>
    <button class="btn-c" id="btn-port" onclick="setPdfOrient('portrait')">🔲 Vertical</button>
    <div class="sep"></div>
    <label>Hojas H: <input type="number" id="h-pages" min="1" max="10" value="1"></label>
    <label>Hojas V: <input type="number" id="v-pages" min="1" max="10" value="1"></label>
    <div class="sep"></div>
    <span class="lbl-sm">&#x1F4C1; Archivo:</span>
    <input type="text" id="fn-inp" value="${_pdfFile}" title="Nombre del archivo PDF" style="width:280px;padding:2px 6px;border:1px solid #90A4AE;border-radius:4px;font-size:12px">
    <div class="sep"></div>
    <button class="btn-print" id="btn-pdf" onclick="_savePdf()">🖨 Guardar PDF</button>
    <span class="lbl-sm">${today}</span>
  </div>
  <div class="header">
    <div class="proj-name">${_projLabel}</div>
  </div>
  <div class="gantt-frame" id="gantt-wrap">
    ${svgStr}
  </div>
  <script>
    const _PDF_FILENAME = ${JSON.stringify(_pdfFile)};
    const _PROJ_NAME    = ${JSON.stringify(project.name)};
    let   _pdfOrient    = 'landscape';

    const zoomEl  = document.getElementById('zoom');
    const zoomVal = document.getElementById('zoom-val');
    const svgEl   = document.querySelector('#gantt-wrap svg');
    if (zoomEl && svgEl) {
      zoomEl.addEventListener('input', () => {
        zoomVal.textContent = zoomEl.value + '%';
        svgEl.style.width  = zoomEl.value + '%';
        svgEl.style.height = 'auto';
      });
    }

    function setPdfOrient(o) {
      _pdfOrient = o;
      document.getElementById('btn-land').classList.toggle('active', o === 'landscape');
      document.getElementById('btn-port').classList.toggle('active', o === 'portrait');
    }

    async function _savePdf() {
      const btn = document.getElementById('btn-pdf');
      if (!window.jspdf) { alert('Librería PDF no disponible. Verifique su conexión e intente de nuevo.'); return; }
      if (btn) { btn.disabled = true; btn.textContent = '⏳ Generando…'; }

      const hPages = Math.max(1, Math.min(10, parseInt(document.getElementById('h-pages').value) || 1));
      const vPages = Math.max(1, Math.min(10, parseInt(document.getElementById('v-pages').value) || 1));

      try {
        const { jsPDF } = window.jspdf;
        const svg = document.querySelector('#gantt-wrap svg');
        if (!svg) throw new Error('SVG no encontrado');

        const svgW = parseFloat(svg.getAttribute('width'))  || svg.viewBox.baseVal.width  || svg.getBoundingClientRect().width;
        const svgH = parseFloat(svg.getAttribute('height')) || svg.viewBox.baseVal.height || svg.getBoundingClientRect().height;
        if (!svgW || !svgH) throw new Error('Dimensiones SVG inválidas');

        const isLand    = _pdfOrient === 'landscape';
        const MARG      = 10;
        const RENDER_DPI = 600;
        const MM2PX     = RENDER_DPI / 25.4;
        const A4w_mm    = isLand ? 297 : 210;
        const A4h_mm    = isLand ? 210 : 297;
        const availW_mm = A4w_mm - 2 * MARG;
        const availH_mm = A4h_mm - 2 * MARG - 7;
        const tileW_px  = Math.round(availW_mm * MM2PX);
        const tileH_px  = Math.round(availH_mm * MM2PX);

        const cellW = svgW / hPages;
        const cellH = svgH / vPages;

        const doc = new jsPDF({ orientation: _pdfOrient, unit: 'mm', format: 'a4' });
        const totalPages = hPages * vPages;
        let pageNum = 0;

        for (let j = 0; j < vPages; j++) {
          for (let i = 0; i < hPages; i++) {
            if (pageNum > 0) doc.addPage();

            const pw = doc.internal.pageSize.getWidth();
            const ph = doc.internal.pageSize.getHeight();

            const clone = svg.cloneNode(true);
            clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
            clone.setAttribute('viewBox', i * cellW + ' ' + j * cellH + ' ' + cellW + ' ' + cellH);
            clone.setAttribute('width', String(tileW_px));
            clone.setAttribute('height', String(tileH_px));

            const svgBlob = new Blob([new XMLSerializer().serializeToString(clone)],
                                     { type: 'image/svg+xml;charset=utf-8' });
            const svgUrl = URL.createObjectURL(svgBlob);

            const tileCanvas = document.createElement('canvas');
            tileCanvas.width  = tileW_px;
            tileCanvas.height = tileH_px;
            const ctx = tileCanvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, tileW_px, tileH_px);

            await new Promise((res, rej) => {
              const img = new Image();
              img.onload = () => { ctx.drawImage(img, 0, 0, tileW_px, tileH_px); URL.revokeObjectURL(svgUrl); res(); };
              img.onerror = () => { URL.revokeObjectURL(svgUrl); rej(new Error('Error en tile ' + (pageNum + 1))); };
              img.src = svgUrl;
            });

            doc.addImage(tileCanvas.toDataURL('image/png', 0.85), 'PNG', MARG, MARG, availW_mm, availH_mm);

            doc.setFont('helvetica', 'normal');
            doc.setFontSize(7);
            doc.setTextColor(120, 120, 120);
            doc.text(_PROJ_NAME, MARG, ph - 4);
            doc.text('ECM Project', pw / 2, ph - 4, { align: 'center' });
            doc.text((pageNum + 1) + ' / ' + totalPages, pw - MARG, ph - 4, { align: 'right' });
            doc.setDrawColor(200, 200, 200);
            doc.setLineWidth(0.2);
            doc.line(MARG, ph - 7, pw - MARG, ph - 7);

            pageNum++;
          }
        }

        const _fnVal = (document.getElementById('fn-inp')?.value || '').trim() || _PDF_FILENAME;
        if (window.ecmIsElectron && typeof window.ecmSavePdf === 'function') {
          window.ecmSavePdf(doc.output('datauristring').split(',')[1], _fnVal);
        } else {
          doc.save(_fnVal);
        }
      } catch (err) {
        alert('Error al generar PDF: ' + err.message);
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🖨 Guardar PDF'; }
      }
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
