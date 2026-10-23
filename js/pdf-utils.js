// @ts-check
/**
 * pdf-utils.js — Utilidades compartidas de impresión PDF.
 * Exporta: printToPdf(moduleName, htmlContent)
 * Incluye _getCssVarsInline() y CSS completo para todos los paneles.
 */

import { appState } from './state.js';

/** Extrae todas las variables CSS custom de :root */
function _getCssVarsInline() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const seen = new Set(), vars = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (/** @type {CSSStyleRule} */ (rule).selectorText === ':root') {
            for (const p of /** @type {CSSStyleRule} */ (rule).style) {
              if (p.startsWith('--') && !seen.has(p)) {
                seen.add(p);
                vars.push(`${p}:${cs.getPropertyValue(p)}`);
              }
            }
          }
        }
      } catch (_e) { /* cross-origin */ }
    }
    return vars.length ? `:root{${vars.join(';')}}` : '';
  } catch (_e) { return ''; }
}

/** Chromium ≥ 131 (Chrome/Edge actuales, Electron ≥ 34) soporta @page margin boxes. */
export function supportsPageMarginBoxes() {
  const m = /Chrom(?:e|ium)\/(\d+)/.exec(navigator.userAgent);
  return !!m && Number(m[1]) >= 131;
}

/** Literal de cadena CSS seguro para content:"..." dentro de <style>. */
function _cssStr(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3c ').replace(/[\r\n]+/g, ' ') + '"';
}

/**
 * Encabezado/pie estándar en el área de margen de la página (fuera del contenido)
 * mediante @page margin boxes. Si el navegador las soporta, oculta en impresión
 * los encabezados/pies fijos (.print-header/.print-footer/.phf-hdr/.phf-ftr), que
 * se dibujan dentro del área de contenido. Si no las soporta devuelve '' y se
 * mantienen los fijos como respaldo.
 * @param {{ proj:string, date:string, footRight?:string }} o
 *   footRight: texto del pie derecho; por defecto "Página X de Y".
 */
export function pageHfCss({ proj, date, footRight }) {
  if (!supportsPageMarginBoxes()) return '';
  const box = "font-family:'Urbanist',system-ui,sans-serif;font-size:6pt;";
  const top = box + 'color:#4A5568;vertical-align:bottom;padding-bottom:0.8mm;border-bottom:0.5pt solid #CBD5E0;';
  const bot = box + 'color:#718096;vertical-align:top;padding-top:0.8mm;border-top:0.5pt solid #CBD5E0;';
  const right = footRight != null ? _cssStr(footRight) : '"P\\E1 gina " counter(page) " de " counter(pages)';
  return `
  @page{margin:10mm;
    @top-left{content:"ECM Project V1.00.01";${top}text-align:left}
    @top-center{content:${_cssStr(proj)};${top}text-align:center}
    @top-right{content:${_cssStr(date)};${top}text-align:right}
    @bottom-left{content:"By EHCM";${bot}text-align:left}
    @bottom-center{content:"\\2014";${bot}text-align:center}
    @bottom-right{content:${right};${bot}text-align:right}
  }
  @media print{.print-header,.print-footer,.phf-hdr,.phf-ftr{display:none!important}}`;
}

/** Estilo único del título de reporte (14pt centrado) y del subtítulo opcional (10pt). */
export const REPORT_TITLE_CSS =
  ".print-title{font-family:'Manrope',system-ui,sans-serif;font-size:14pt;font-weight:600;color:#1A365D;text-align:center;margin:0 0 4mm}" +
  ".print-subtitle{font-family:'Manrope',system-ui,sans-serif;font-size:10pt;font-weight:500;color:#4A5568;text-align:center;margin:-2mm 0 4mm}";

/**
 * Tipografía de los reportes: todo el contenido (textos, tablas, gráficos SVG, Gantt…)
 * en Manrope; encabezados y pies de página en Urbanist.
 */
export const REPORT_FONT_CSS =
  "body,body *{font-family:'Manrope',system-ui,sans-serif!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}" +
  ".print-header,.print-header *,.print-footer,.print-footer *,.phf-hdr,.phf-hdr *,.phf-ftr,.phf-ftr *," +
  ".page-head,.page-head *,.page-foot,.page-foot *{font-family:'Urbanist',system-ui,sans-serif!important}" +
  // Texto invisible en Urbanist: obliga a descargar la fuente que usan los márgenes de página (@page)
  "body::after{content:'ECM Project By EHCM 0123456789';font-family:'Urbanist',system-ui,sans-serif;font-size:6pt;" +
  "position:absolute;left:0;top:0;visibility:hidden;pointer-events:none}";

/**
 * Normaliza el contenido de un reporte para que cumpla la norma de PDFs:
 *   • un solo título: se eliminan h1–h3 que repiten el título del reporte;
 *     el primer h1 distinto pasa a subtítulo y los demás h1 a h2;
 *   • sin controles de la app: se quitan botones y los campos se muestran como texto.
 * @param {string} title  Título del reporte (el de .print-title)
 * @param {string} html   Contenido HTML del reporte
 * @returns {string}
 */
export function normalizeReportBody(title, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const root = tpl.content;
  const key = (/** @type {string} */ s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const tk = key(title);
  const text = (/** @type {string} */ s) => tpl.ownerDocument.createTextNode(s);

  let subtitleDone = false;
  root.querySelectorAll('h1,h2,h3').forEach(h => {
    if (key(h.textContent ?? '') === tk) { h.remove(); return; }
    if (h.tagName !== 'H1') return;
    if (!subtitleDone) {
      const d = tpl.ownerDocument.createElement('div');
      d.className = 'print-subtitle';
      d.textContent = (h.textContent ?? '').trim();
      h.replaceWith(d);
      subtitleDone = true;
    } else {
      const h2 = tpl.ownerDocument.createElement('h2');
      h2.innerHTML = h.innerHTML;
      h.replaceWith(h2);
    }
  });

  root.querySelectorAll('button,[role="button"],input[type="hidden"],input[type="file"]').forEach(el => el.remove());
  root.querySelectorAll('select').forEach(s => {
    const opt = s.querySelector('option[selected]') ?? s.querySelector('option');
    s.replaceWith(text(opt?.textContent?.trim() ?? ''));
  });
  root.querySelectorAll('input').forEach(i => {
    const t = (i.getAttribute('type') ?? 'text').toLowerCase();
    if (t === 'checkbox' || t === 'radio') i.replaceWith(text(i.hasAttribute('checked') ? '☑ ' : '☐ '));
    else i.replaceWith(text(i.getAttribute('value') ?? ''));
  });
  root.querySelectorAll('textarea').forEach(t => t.replaceWith(text(t.textContent ?? '')));

  const out = tpl.ownerDocument.createElement('div');
  out.appendChild(root.cloneNode(true));
  return out.innerHTML;
}

/**
 * Abre una ventana de vista previa PDF con CSS completo de la aplicación.
 * @param {string} moduleName
 * @param {string} htmlContent
 */
export function printToPdf(moduleName, htmlContent) {
  const _proj = appState.state.project?.name ?? 'ECM Project';
  const _d = new Date();
  const _dd = String(_d.getDate()).padStart(2,'0');
  const _mm = String(_d.getMonth()+1).padStart(2,'0');
  const _yy = _d.getFullYear();
  const _hh = String(_d.getHours()).padStart(2,'0');
  const _mi = String(_d.getMinutes()).padStart(2,'0');
  const _projEsc = _proj.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const _modEsc = moduleName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const title = `${_proj}-${moduleName}-${_dd}${_mm}${_yy}`;
  const _appCssVars = _getCssVarsInline();

  const w = window.open('', '_blank', 'width=1100,height=880');
  if (!w) {
    document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.', type: 'warn' } }));
    return;
  }

  w.document.write(`<!DOCTYPE html><html><head>
<meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Urbanist:wght@400;500;600&family=Manrope:wght@400;500;600;700;800&display=swap">
<title>${title}</title>
<style>
  ${_appCssVars}
  *{box-sizing:border-box}
  body{font-family:Arial,sans-serif;margin:0;padding:0;background:#f1f5f9;color:#1f2937}
  .tb{background:#fff;padding:8px 14px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;position:sticky;top:0;z-index:100;border-bottom:1px solid #e2e8f0}
  .tb button{padding:5px 11px;border:1px solid #d1d5db;border-radius:5px;cursor:pointer;font-size:12px;background:#fff;color:#374151;white-space:nowrap}
  .tb button.pri{background:#1976d2;color:#fff;border-color:#1976d2;font-weight:600;font-size:13px;padding:6px 16px}
  .tb button.pri:hover{background:#1565c0}
  .tb button.act{background:#e3f2fd;color:#1565c0;border-color:#90caf9;font-weight:600}
  .tb button:hover:not(.pri){background:#f8fafc}
  .tb .sep{width:1px;height:20px;background:#e2e8f0;flex-shrink:0}
  .tb .lbl{font-size:11px;color:#64748b;white-space:nowrap}
  .tb input[type=text]{font-size:12px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#f8fafc;color:#374151;width:300px}
  .pv{padding:20px;display:flex;flex-direction:column;align-items:center;gap:16px;min-height:calc(100vh - 52px)}
  .a4{background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.4);padding:14mm 15mm;width:210mm;min-height:297mm;overflow:hidden}
  .a4.land{width:297mm;min-height:210mm}
  h1{font-size:18px;margin-bottom:16px;color:#1f2937}
  h2{font-size:14px;margin:14px 0 6px;color:#1f2937}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #ccc;padding:6px 10px;font-size:12px}
  th{background:#f4f5f7;font-weight:600}
  svg{max-width:100%;height:auto}img{max-width:100%}

  /* Ocultar elementos de UI de la app */
  .no-print,.evm-header,.btn-evm-close,.btn-evm-print,
  [id$="-close"],[id$="-print"],[data-drag-handle] > button,
  .expand-btn,.task-notes-icon,.sort-indicator,.indent-spacer,
  .panel-header-btn,.close-btn,.print-btn { display:none !important; }

  /* ---- KPI cards (EVM y otros paneles) ---- */
  .evm-kpi-grid { display:grid;grid-template-columns:repeat(6,1fr);gap:6px;padding:8px 0 6px; }  /* 12 indicadores EVM en 2 filas de 6 */
  .kpi-card { background:#F5F5F5;border:1px solid #d1d5db;border-radius:6px;padding:6px;text-align:center; }
  .kpi-value { font-size:12px;font-weight:700;color:#1976D2; }  /* mismo tamaño que el contenido (tablas 12px) */
  .kpi-label { font-size:10px;color:#5b6270;margin-top:2px; }

  /* Colores semafóricos KPI (EVM: good/warn/bad) */
  .kpi-value.good { color:#388E3C !important; }
  .kpi-value.warn { color:#FB8C00 !important; }
  .kpi-value.bad  { color:#D32F2F !important; }

  /* Colores EVM tabla (evm-good / evm-warn / evm-bad) */
  .evm-good { color:#388E3C !important;font-weight:600; }
  .evm-warn { color:#FB8C00 !important;font-weight:600; }
  .evm-bad  { color:#D32F2F !important;font-weight:600; }

  /* Tabla EVM */
  .evm-table { width:100%;border-collapse:collapse; }
  .evm-table th { background:#F5F5F5;font-weight:600;padding:6px 10px;border:1px solid #d1d5db;font-size:11px; }
  .evm-table td { padding:5px 10px;border:1px solid #d1d5db;font-size:11px; }
  .evm-table td.num { text-align:right;font-family:monospace; }
  .evm-empty-row td { text-align:center;color:#9e9e9e;padding:16px; }

  /* Aviso fecha de datos (ocultar en print) */
  #evm-no-date-warn { display:none !important; }

  /* DCMA badges */
  .dcma-badge-pass,.badge-pass { background:#e8f5e9;color:#388E3C;border:1px solid #4caf50;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600;display:inline-block; }
  .dcma-badge-fail,.badge-fail { background:#fdecea;color:#D32F2F;border:1px solid #f44336;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600;display:inline-block; }
  .dcma-pass { color:#388E3C;font-weight:600; }
  .dcma-fail { color:#D32F2F;font-weight:600; }

  /* Badges genéricos */
  .badge { display:inline-block;border-radius:10px;padding:2px 8px;font-size:11px;font-weight:600; }
  .badge-critical { background:#fdecea;color:#D32F2F; }
  .badge-near     { background:#fff3e0;color:#FB8C00; }
  .badge-done     { background:#e8f5e9;color:#388E3C; }
  .badge-normal   { background:#e3f2fd;color:#1976D2; }
  .badge-milestone { background:#f3e5f5;color:#7B1FA2; }

  /* Tags de estado */
  .tag { display:inline-block;border-radius:10px;padding:2px 8px;font-size:9pt;font-weight:600; }
  .tag-done { background:#E8F5E9;color:#388E3C; }
  .tag-prog { background:#E3F2FD;color:#1976D2; }
  .tag-todo { background:#F5F5F5;color:#757575; }
  .tag-crit { background:#FFEBEE;color:#D32F2F; }

  /* Registro de Riesgos */
  .risk-high   { color:#D32F2F;font-weight:600; }
  .risk-medium { color:#FB8C00;font-weight:600; }
  .risk-low    { color:#388E3C;font-weight:600; }

  /* Alertas */
  .alert-critical { color:#D32F2F;font-weight:600; }
  .alert-warn     { color:#FB8C00;font-weight:600; }
  .alert-info     { color:#1976D2; }

  /* Histograma / Recursos — filas */
  .res-over  { color:#D32F2F;font-weight:600; }
  .res-ok    { color:#388E3C; }
  .res-near  { color:#FB8C00;font-weight:600; }

  /* Lookahead */
  .lookahead-critical { color:#D32F2F;font-weight:600; }
  .lookahead-near     { color:#FB8C00; }
  .lookahead-done     { color:#388E3C; }

  /* Holguras */
  .tf-neg  { color:#D32F2F !important;font-weight:600; }
  .tf-zero { color:#FB8C00 !important; }

  .print-header,.print-footer{font-family:'Urbanist',system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .print-header{position:fixed;top:0;left:0;right:0;height:26px;display:none;align-items:center;justify-content:space-between;padding:0 10mm;border-bottom:0.5pt solid #CBD5E0;font-size:6pt;color:#4A5568;background:#fff;z-index:9999}
  .print-footer{position:fixed;bottom:0;left:0;right:0;height:22px;display:none;align-items:center;justify-content:space-between;padding:0 10mm;border-top:0.5pt solid #CBD5E0;font-size:6pt;color:#718096;background:#fff;z-index:9999}
  ${REPORT_TITLE_CSS}
  @media print{
    body{background:#fff}
    .tb{display:none!important}
    .pv{padding:0;min-height:0}
    .a4{box-shadow:none;width:100%;min-height:0;padding:1.5mm 0 0!important}
    .print-header,.print-footer{display:flex!important}
    @page{margin:10mm}
  }
  ${pageHfCss({ proj: _proj, date: `${_dd}-${_mm}-${_yy}, ${_hh}:${_mi}` })}
  ${REPORT_FONT_CSS}
</style>
</head><body>
<div class="tb">
  <button class="pri" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
  <div class="sep"></div>
  <span class="lbl">Orientaci&#243;n:</span>
  <button id="bp" class="act" onclick="setOri('portrait')">&#x1F4C4; Vertical</button>
  <button id="bl" onclick="setOri('landscape')">&#x1F5C2; Horizontal</button>
  <div class="sep"></div>
  <span class="lbl">&#x1F4C1; Archivo:</span>
  <input type="text" id="fn" value="${title}.pdf" title="Nombre sugerido del archivo PDF">
  <div class="sep"></div>
  <button onclick="window.close()">&#x2715; Cerrar</button>
</div>
<div class="pv">
  <div class="a4" id="a4">
<div class="print-header"><span>ECM Project V1.00.01</span><span>${_projEsc}</span><span>${_dd}-${_mm}-${_yy}, ${_hh}:${_mi}</span></div>
<div class="print-footer"><span>By EHCM</span><span>&#8212;</span><span>P&aacute;gina <span id="phf-cur">1</span> de <span id="phf-tot">1</span></span></div>
<div class="print-title">${_modEsc}</div>
${normalizeReportBody(moduleName, htmlContent)}</div>
</div>
<script>
  (function(){function _u(){var h=document.getElementById('a4');if(!h)return;var t=Math.max(1,Math.ceil(h.scrollHeight/1120));var el=document.getElementById('phf-tot');if(el)el.textContent=t;}window.addEventListener('beforeprint',_u);_u();})();
  document.title=${JSON.stringify(title)};
  function setOri(o){
    document.getElementById('a4').classList.toggle('land',o==='landscape');
    document.getElementById('bp').classList.toggle('act',o==='portrait');
    document.getElementById('bl').classList.toggle('act',o==='landscape');
    var s=document.getElementById('_ps')||document.createElement('style');
    s.id='_ps';s.textContent='@page{size:A4 '+o+'}';document.head.appendChild(s);
  }
  setOri('portrait');
<\/script>
</body></html>`);
  w.document.close();
}

/**
 * Contexto 2D mínimo que registra el dibujo como SVG vectorial (para el PDF).
 * Implementa las operaciones que usan los gráficos de los reportes (Histograma, EVM, DCMA).
 */
export class SvgCtx {
  /** @param {number} w @param {number} h */
  constructor(w, h) {
    this.w = w; this.h = h;
    this.fillStyle = '#000'; this.strokeStyle = '#000'; this.lineWidth = 1; this.lineJoin = 'miter'; this.lineCap = 'butt';
    this.font = '10px sans-serif'; this.textAlign = 'start'; this.textBaseline = 'alphabetic';
    this._dash = []; this._tf = ''; this._clip = ''; this._path = ''; this._stack = [];
    this._defs = []; this._out = []; this._clipN = 0;
  }
  setLineDash(d) { this._dash = d.slice(); }
  scale() {}
  clearRect() {}
  save() { this._stack.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, lineWidth: this.lineWidth,
    lineJoin: this.lineJoin, font: this.font, textAlign: this.textAlign, textBaseline: this.textBaseline,
    dash: this._dash, tf: this._tf, clip: this._clip }); }
  restore() { const st = this._stack.pop(); if (!st) return;
    Object.assign(this, { fillStyle: st.fillStyle, strokeStyle: st.strokeStyle, lineWidth: st.lineWidth, lineJoin: st.lineJoin,
      font: st.font, textAlign: st.textAlign, textBaseline: st.textBaseline });
    this._dash = st.dash; this._tf = st.tf; this._clip = st.clip; }
  translate(x, y) { this._tf += ` translate(${_n(x)} ${_n(y)})`; }
  rotate(a) { this._tf += ` rotate(${_n(a * 180 / Math.PI)})`; }
  beginPath() { this._path = ''; }
  moveTo(x, y) { this._path += `M${_n(x)} ${_n(y)}`; }
  lineTo(x, y) { this._path += `L${_n(x)} ${_n(y)}`; }
  rect(x, y, w, h) { this._path += `M${_n(x)} ${_n(y)}h${_n(w)}v${_n(h)}h${_n(-w)}Z`; }
  arc(x, y, r, a0, a1) {
    if (Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6) {
      this._path += `M${_n(x - r)} ${_n(y)}a${_n(r)} ${_n(r)} 0 1 0 ${_n(2 * r)} 0a${_n(r)} ${_n(r)} 0 1 0 ${_n(-2 * r)} 0Z`;
    } else {
      const sx = x + r * Math.cos(a0), sy = y + r * Math.sin(a0), ex = x + r * Math.cos(a1), ey = y + r * Math.sin(a1);
      this._path += `M${_n(sx)} ${_n(sy)}A${_n(r)} ${_n(r)} 0 ${(a1 - a0) > Math.PI ? 1 : 0} 1 ${_n(ex)} ${_n(ey)}`;
    }
  }
  clip() {
    const id = `svgclip${++this._clipN}`;
    this._defs.push(`<clipPath id="${id}"><path d="${this._path}"${this._tf ? ` transform="${this._tf.trim()}"` : ''}/></clipPath>`);
    this._clip = id;
  }
  _attrs() {
    return (this._tf ? ` transform="${this._tf.trim()}"` : '') + (this._clip ? ` clip-path="url(#${this._clip})"` : '');
  }
  fill() { if (this._path) this._out.push(`<path d="${this._path}" fill="${this.fillStyle}"${this._attrs()}/>`); }
  stroke() {
    if (!this._path) return;
    const dash = this._dash.length ? ` stroke-dasharray="${this._dash.join(' ')}"` : '';
    this._out.push(`<path d="${this._path}" fill="none" stroke="${this.strokeStyle}" stroke-width="${this.lineWidth}" stroke-linejoin="${this.lineJoin}" stroke-linecap="${this.lineCap}"${dash}${this._attrs()}/>`);
  }
  fillRect(x, y, w, h) { this._out.push(`<rect x="${_n(x)}" y="${_n(y)}" width="${_n(w)}" height="${_n(h)}" fill="${this.fillStyle}"${this._attrs()}/>`); }
  fillText(t, x, y) {
    const m = /^(?:(\w+)\s+)?(\d+(?:\.\d+)?)px\s+(.+)$/.exec(this.font) || [];
    const weight = m[1] || 'normal', size = m[2] || '10', family = (m[3] || 'sans-serif').replace(/"/g, "'");
    const anchor = { center: 'middle', right: 'end', end: 'end' }[this.textAlign] || 'start';
    const base = { middle: 'middle', top: 'hanging', bottom: 'text-after-edge' }[this.textBaseline] || 'alphabetic';
    this._out.push(`<text x="${_n(x)}" y="${_n(y)}" font-size="${size}" font-weight="${weight}" font-family="${family}" fill="${this.fillStyle}" text-anchor="${anchor}" dominant-baseline="${base}"${this._attrs()}>${String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
  }
  toSvg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${this.w} ${this.h}" width="100%" style="display:block;max-width:100%;height:auto">` +
      `<defs>${this._defs.join('')}</defs>${this._out.join('')}</svg>`;
  }
}

function _n(/** @type {number} */ v) { return Math.round(v * 100) / 100; }
