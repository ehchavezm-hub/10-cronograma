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
import { GANTT_ROW_H, GANTT_HDR_H } from './gantt-svg.js';
import { pageHfCss, REPORT_FONT_CSS, supportsPageMarginBoxes, FONTS_LINK } from './pdf-utils.js';

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
  const _hfD = new Date();
  const _hfDD = String(_hfD.getDate()).padStart(2,'0'), _hfMM = String(_hfD.getMonth()+1).padStart(2,'0'), _hfYY = _hfD.getFullYear();
  const _hfHH = String(_hfD.getHours()).padStart(2,'0'), _hfMi = String(_hfD.getMinutes()).padStart(2,'0');
  const _hfProj = (_wProj?.name ?? 'ECM Project').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const _hfEl = document.createElement('div');
  _hfEl.id = 'print-ecm-hf';
  _hfEl.innerHTML = `<div class="phf-hdr"><span>ECM Project V1.00.01</span><span>${_hfProj}</span><span>${_hfDD}-${_hfMM}-${_hfYY}, ${_hfHH}:${_hfMi}</span></div><div class="phf-ftr"><span>By EHCM</span><span>&#8212;</span><span>Tabla EDT</span></div>`;
  document.body.appendChild(_hfEl);
  const _footerStyle = document.createElement('style');
  _footerStyle.id = 'print-ecm-footer';
  _footerStyle.textContent = `@media print {
    .phf-hdr{font-family:'Urbanist',system-ui,sans-serif;position:fixed;top:0;left:0;right:0;height:26px;display:flex!important;align-items:center;justify-content:space-between;padding:0 10mm;border-bottom:0.5pt solid #CBD5E0;font-size:6pt;color:#4A5568;background:#fff;z-index:9999;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .phf-ftr{font-family:'Urbanist',system-ui,sans-serif;position:fixed;bottom:0;left:0;right:0;height:22px;display:flex!important;align-items:center;justify-content:space-between;padding:0 10mm;border-top:0.5pt solid #CBD5E0;font-size:6pt;color:#718096;background:#fff;z-index:9999;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    #app, #app * { font-family: 'Manrope', system-ui, sans-serif !important; }
    @page { margin: 10mm; }
  }
  #print-ecm-hf { display:none; }
  @media print { #print-ecm-hf { display:block; } }
  ${pageHfCss({ proj: _wProj?.name ?? 'ECM Project', date: `${_hfDD}-${_hfMM}-${_hfYY}, ${_hfHH}:${_hfMi}`, footRight: 'Tabla EDT' })}`;
  document.head.appendChild(_footerStyle);
  document.body.classList.add('printing');
  window.print();
  setTimeout(() => {
    document.title = origTitle;
    document.body.classList.remove('printing');
    document.getElementById('print-col-override')?.remove();
    document.getElementById('print-ecm-footer')?.remove();
    document.getElementById('print-ecm-hf')?.remove();
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
    const _gHH = String(_dG.getHours()).padStart(2,'0');
    const _gMi = String(_dG.getMinutes()).padStart(2,'0');
    const _gTitle    = `${project.name}-Gantt-${_gDD}${_gMM}${_gYY}`;   // = nombre del PDF (PROYECTO-Proceso-Fecha)
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
  ${FONTS_LINK}
  <title>${_esc(_gTitle)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body  { font-family: 'Segoe UI', system-ui, sans-serif; background:#f1f5f9; }
    .controls { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
                font-size: 12px; flex-wrap: wrap; background:#fff;
                border-bottom: 1px solid #e2e8f0; position: sticky; top:0; z-index:10; }
    .controls label { display: flex; align-items: center; gap: 5px; color: #64748b; }
    .controls input[type=number] { width: 46px; padding: 2px 4px; border: 1px solid #d1d5db;
                                   border-radius: 4px; font-size: 12px; text-align:center;
                                   background:#f8fafc; color:#374151; }
    .btn-c { border: 1px solid #d1d5db; border-radius: 5px; padding: 4px 10px;
             font-size: 12px; cursor: pointer; background: #fff; color: #374151; white-space:nowrap; }
    .btn-c:hover, .btn-c.active { background: #1976D2; color: #fff; border-color: #1976D2; }
    .btn-print { background: #1976D2; color: #fff; border: none; border-radius: 5px;
                 padding: 6px 16px; font-size: 13px; cursor: pointer; font-weight:600; }
    .btn-print:hover { background: #1565C0; }
    .sep { width: 1px; height: 20px; background: #e2e8f0; flex-shrink:0; }
    .lbl-sm { font-size:11px; color:#64748b; white-space:nowrap; }
    input[type=text].fn-inp { font-size:12px; padding:3px 8px; border:1px solid #d1d5db;
                border-radius:4px; background:#f8fafc; color:#374151; width:260px; }
    .preview { padding: 20px; display:flex; flex-direction:column; align-items:center; gap:16px; min-height:calc(100vh - 52px); }
    .page-tile { background:#fff; box-shadow:0 4px 14px rgba(0,0,0,.4); position:relative; flex-shrink:0; }
    .page-tile svg { display:block; }
    .page-foot { position:absolute; bottom:1mm; left:0; right:0;
                 display:flex; justify-content:space-between; font-size:6pt; color:#718096;
                 border-top:0.5pt solid #CBD5E0; padding-top:2px;
                 font-family:'Urbanist',system-ui,sans-serif; }
    .page-title { position:absolute; top:4.5mm; left:0; right:0; text-align:center;
                  font-family:'Urbanist',system-ui,sans-serif; font-size:14pt; font-weight:600; color:#1A365D; }
    .page-head { position:absolute; top:1mm; left:0; right:0;
                 display:flex; justify-content:space-between; font-size:6pt; color:#4A5568;
                 border-bottom:0.5pt solid #CBD5E0; padding-bottom:2px;
                 font-family:'Urbanist',system-ui,sans-serif; }
    @media print {
      body { background:#fff; }
      .controls { display:none !important; }
      .preview { padding:0; gap:0; background:#fff; min-height:0; }
      .page-tile { box-shadow:none; break-after:page; page-break-after:always; margin:0; }
      .page-tile:last-child { break-after:avoid; page-break-after:avoid; }
      .page-foot { display:flex !important; }
    }
    ${pageHfCss({ proj: project.name, date: `${_gDD}-${_gMM}-${_gYY}, ${_gHH}:${_gMi}` })}
    ${REPORT_FONT_CSS}
  </style>
</head><body>
  <div class="controls">
    <label>Papel: <select id="paper" onchange="autoPages();renderTiles()" title="Tamaño del papel del PDF">
      <option value="A0">A0</option><option value="A1">A1</option><option value="A2">A2</option><option value="A3">A3</option>
      <option value="A4" selected>A4</option><option value="A5">A5</option><option value="A6">A6</option>
    </select></label>
    <div class="sep"></div>
    <span class="lbl-sm">Orientaci&#243;n:</span>
    <button class="btn-c active" id="btn-land" onclick="setOrient('landscape')">&#x2B1B; Horizontal</button>
    <button class="btn-c" id="btn-port" onclick="setOrient('portrait')">&#x1F532; Vertical</button>
    <div class="sep"></div>
    <label title="Todo el diagrama en una sola hoja"><input type="checkbox" id="fit1" onchange="renderTiles()"> Todo en 1 hoja</label>
    <div class="sep"></div>
    <label title="Franjas horizontales en que se corta el diagrama (hojas una debajo de otra). Se calcula solo: cada hoja se llena con las actividades que caben">Hojas H: <input type="number" id="pg-rows" min="1" value="1" disabled></label>
    <label title="Columnas en que se corta el ancho del diagrama (define el tamaño del texto)">Hojas V: <input type="number" id="pg-cols" min="1" max="10" value="1" onchange="renderTiles()"></label>
    <div class="sep"></div>
    <span class="lbl-sm">&#x1F4C1; Archivo:</span>
    <input type="text" id="fn-inp" class="fn-inp" value="${_pdfFile}" title="Nombre sugerido del archivo PDF" oninput="document.title=this.value.replace(/\.pdf$/i,'')">
    <div class="sep"></div>
    <span class="lbl-sm">${today}</span>
    <div class="sep"></div>
    <button class="btn-c" onclick="window.close()">&#x2715; Cerrar</button>
    <button class="btn-print" id="btn-pdf" style="margin-left:auto" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
  </div>
  <div class="preview" id="preview"></div>

  <script>
    const SVG_W = ${_svgW};
    const SVG_H = ${_svgH};
    const SVG_INNER = ${JSON.stringify(_svgInner)};
    const PROJ_NAME = ${JSON.stringify(project.name)};
    const DATE_STR = "${_gDD}-${_gMM}-${_gYY}, ${_gHH}:${_gMi}";
    const TOTAL_PAGES_REF = { v: 1 };

    const HF_IN_MARGIN = ${supportsPageMarginBoxes()};  // encabezado/pie en el margen de la hoja (@page)
    const MIN_PT = 6, BASE_PX = 10;   // las etiquetas del dibujo (10px) se imprimen a 6pt o más

    let _orient = 'landscape';

    /** Tamaños de papel (mm, vertical). */
    const PAPERS = { A0: [841, 1189], A1: [594, 841], A2: [420, 594], A3: [297, 420],
                     A4: [210, 297], A5: [148, 210], A6: [105, 148] };

    /** Hoja (mm) y área útil: márgenes de 10mm, banda del título y, sin margin boxes, encabezado/pie. */
    function layout() {
      const isLand = _orient === 'landscape';
      const [pw, ph] = PAPERS[document.getElementById('paper').value] || PAPERS.A4;
      const W = isLand ? Math.max(pw, ph) : Math.min(pw, ph), H = isLand ? Math.min(pw, ph) : Math.max(pw, ph);
      const MARG = 10, top = HF_IN_MARGIN ? 9 : 12, bottom = HF_IN_MARGIN ? 0 : 5;
      return { W, H, MARG, top, bottom, availW: W - 2 * MARG, availH: H - 2 * MARG - top - bottom };
    }

    // Filas del Gantt: las hojas se cortan entre filas y cada hoja repite el encabezado (tabla + escala de tiempo)
    const ROW_H = ${GANTT_ROW_H}, HDR_H = ${GANTT_HDR_H};
    const ROWS = Math.max(1, Math.round((SVG_H - HDR_H) / ROW_H));

    /** Hojas V (columnas) necesarias para que el texto quede legible (≥ MIN_PT). Las Hojas H salen de las filas que caben. */
    function autoPages() {
      const L = layout(), mmPerPx = MIN_PT / BASE_PX * 25.4 / 72;
      document.getElementById('pg-cols').value = Math.min(10, Math.max(1, Math.ceil(SVG_W * mmPerPx / L.availW)));
    }

    /** SVG con una porción (viewBox) del Gantt, del tamaño exacto de esa porción escalada. */
    function slice(x, y, w, h, scale) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.setAttribute('viewBox', x + ' ' + y + ' ' + w + ' ' + h);
      el.setAttribute('width', (w * scale) + 'mm');
      el.setAttribute('height', (h * scale) + 'mm');
      el.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      el.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      el.setAttribute('preserveAspectRatio', 'xMinYMin meet');
      el.style.display = 'block';
      el.style.overflow = 'hidden';
      el.innerHTML = SVG_INNER;
      return el;
    }

    function setOrient(o) {
      _orient = o;
      document.getElementById('btn-land').classList.toggle('active', o === 'landscape');
      document.getElementById('btn-port').classList.toggle('active', o === 'portrait');
      autoPages();
      renderTiles();
    }

    function renderTiles() {
      const fit1 = document.getElementById('fit1').checked;
      const colsIn = document.getElementById('pg-cols');
      colsIn.disabled = fit1;
      const hPages = fit1 ? 1 : Math.max(1, Math.min(10, parseInt(colsIn.value) || 1));   // columnas (Hojas V)
      const { W, H, MARG, top, bottom, availW, availH } = layout();

      // La escala la fija el ancho (Hojas V). Cada hoja se llena con todas las filas que
      // caben y las siguientes pasan a la hoja de abajo: así salen las Hojas H.
      // "Todo en 1 hoja": el diagrama completo se reduce hasta caber en una sola hoja.
      const cellW = SVG_W / hPages;
      const scale = fit1 ? Math.min(availW / SVG_W, availH / SVG_H)
                         : Math.min(availW / cellW, availH / (HDR_H + ROW_H));
      const rowsPer = fit1 ? ROWS : Math.max(1, Math.floor((availH / scale - HDR_H) / ROW_H + 1e-6));
      const vPages = Math.ceil(ROWS / rowsPer);                                             // franjas (Hojas H)
      document.getElementById('pg-rows').value = vPages;
      if (fit1) colsIn.value = 1;
      const totalPages = hPages * vPages;
      TOTAL_PAGES_REF.v = totalPages;

      // @page CSS
      let ps = document.getElementById('_ps') || document.createElement('style');
      ps.id = '_ps';
      ps.textContent = '@page{size:' + W + 'mm ' + H + 'mm;margin:' + MARG + 'mm}';
      document.head.appendChild(ps);

      const preview = document.getElementById('preview');
      preview.innerHTML = '';
      let pageNum = 0;

      for (let j = 0; j < vPages; j++) {
        for (let i = 0; i < hPages; i++) {
          pageNum++;
          const vbX = i * cellW;
          const r0 = j * rowsPer, r1 = Math.min(ROWS, r0 + rowsPer);

          const tile = document.createElement('div');
          tile.className = 'page-tile';
          tile.style.width = availW + 'mm';
          tile.style.height = (availH + top + bottom) + 'mm';

          // Encabezado (columnas de la tabla + meses/días) y filas r0..r1 de esta hoja
          const hdr = slice(vbX, 0, cellW, HDR_H, scale);
          hdr.style.marginTop = top + 'mm';
          tile.appendChild(hdr);
          if (r1 > r0) tile.appendChild(slice(vbX, HDR_H + r0 * ROW_H, cellW, (r1 - r0) * ROW_H, scale));

          const ttl = document.createElement('div');
          ttl.className = 'page-title';
          ttl.style.top = HF_IN_MARGIN ? '0' : '4.5mm';
          ttl.textContent = 'Diagrama de Gantt';
          tile.appendChild(ttl);

          // Sin soporte de margin boxes: encabezado y pie dentro de la hoja, en bandas propias
          if (!HF_IN_MARGIN) {
            const head = document.createElement('div');
            head.className = 'page-head';
            head.innerHTML = '<span>ECM Project V1.00.01</span><span>' + PROJ_NAME + '</span><span>' + DATE_STR + '</span>';
            tile.appendChild(head);
            const foot = document.createElement('div');
            foot.className = 'page-foot';
            foot.innerHTML = '<span>By EHCM</span><span>&#8212;</span><span>P&aacute;gina ' + pageNum + ' de ' + totalPages + '</span>';
            tile.appendChild(foot);
          }

          preview.appendChild(tile);
        }
      }
    }

    autoPages();
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
