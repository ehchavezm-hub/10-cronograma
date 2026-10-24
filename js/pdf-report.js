// @ts-check
/**
 * pdf-report.js — Exportación de informe ejecutivo en PDF.
 * Usa la API de impresión del navegador con estilos específicos.
 * Captura: portada, EDT, KPIs y Gantt SVG.
 */

import { appState } from './state.js';
import { Calendar, isoToDate } from './calendar.js';
import { pageHfCss, REPORT_TITLE_CSS, REPORT_FONT_CSS, PAPER_SELECT_HTML, PAPER_JS } from './pdf-utils.js';

const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

/**
 * Genera y abre el diálogo de impresión del informe ejecutivo.
 */
export function generatePdfReport() {
  const { project, tasks, cpmResult, calendar, calExceptions } = appState.state;

  if (!project) {
    return { ok: false, error: 'Abre un proyecto primero.' };
  }

  const cal = new Calendar({
    work_week: calendar?.work_week ?? [1,2,3,4,5],
    exceptions: calExceptions ?? [],
  });
  const startDate = isoToDate(project.start_date || new Date().toISOString().slice(0,10));
  const fmtDate = /** @param {number} d */ d => cal.idxToDate(d, startDate)
    .toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });

  const taskArr = [...(tasks?.values() ?? [])].filter(t => !t.deleted_at);
  const _pdfParentIds = new Set(taskArr.filter(t => t.parent_id).map(t => t.parent_id));
  const nonSummary = taskArr.filter(t => t.type !== 'summary' && !_pdfParentIds.has(t.id));

  // KPIs básicos
  const totalTasks = nonSummary.length;
  const doneTasks = nonSummary.filter(t => (t.percent_complete ?? 0) >= 100).length;
  const inProgress = nonSummary.filter(t => (t.percent_complete ?? 0) > 0 && (t.percent_complete ?? 0) < 100).length;
  const pctAvg = totalTasks ? Math.round(nonSummary.reduce((s, t) => s + (t.percent_complete ?? 0), 0) / totalTasks) : 0;

  // Ruta crítica
  const criticalTasks = nonSummary.filter(t => (cpmResult?.tasks?.get(t.id)?.tf ?? null) !== null && (cpmResult?.tasks?.get(t.id)?.tf ?? 1) <= 0);

  // Fecha fin (máx ef)
  let maxEf = 0;
  for (const t of nonSummary) {
    const cpm = cpmResult?.tasks?.get(t.id);
    if (cpm && cpm.ef > maxEf) maxEf = cpm.ef;
  }

  const generatedAt = new Date().toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const _rpD = new Date(); const _rpDD = String(_rpD.getDate()).padStart(2,'0'); const _rpMM = String(_rpD.getMonth()+1).padStart(2,'0'); const _rpYY = _rpD.getFullYear();
  const _rpHH = String(_rpD.getHours()).padStart(2,'0'); const _rpMi = String(_rpD.getMinutes()).padStart(2,'0');
  const _rpProjEsc = _esc(project.name);
  const _rpTitle = `${project.name}-Informe Ejecutivo-${_rpDD}${_rpMM}${_rpYY}`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Urbanist:wght@400;500;600&family=Manrope:wght@400;500;600;700;800&display=swap">
<title>${_esc(_rpTitle)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11pt; color: #212121; background: #fff; }
  @page { size: A4; margin: 10mm; }
  .print-header { font-family:'Urbanist',system-ui,sans-serif; position:fixed; top:0; left:0; right:0; height:26px; display:none; align-items:center; justify-content:space-between; padding:0 10mm; border-bottom:0.5pt solid #CBD5E0; font-size:6pt; color:#4A5568; background:#fff; z-index:9999; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .print-footer { font-family:'Urbanist',system-ui,sans-serif; position:fixed; bottom:0; left:0; right:0; height:22px; display:none; align-items:center; justify-content:space-between; padding:0 10mm; border-top:0.5pt solid #CBD5E0; font-size:6pt; color:#718096; background:#fff; z-index:9999; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  ${REPORT_TITLE_CSS}
  @media print { body { font-size: 10pt; } .tb { display:none !important; } }
  .tb { display:flex; align-items:center; gap:7px; padding:8px 14px; margin:0 0 12px; background:#fff; border-bottom:1px solid #e2e8f0; position:sticky; top:0; z-index:100; }
  .tb button { padding:5px 11px; border:1px solid #d1d5db; border-radius:5px; cursor:pointer; font-size:12px; background:#fff; color:#374151; }
  .tb button.pri { background:#1976d2; color:#fff; border-color:#1976d2; font-weight:600; font-size:13px; padding:6px 16px; }
  .tb button.act { background:#e3f2fd; color:#1565c0; border-color:#90caf9; font-weight:600; }
  .tb .lbl { font-size:11px; color:#64748b; } .tb .sep { width:1px; height:20px; background:#e2e8f0; }
  .tb select { font-size:12px; padding:3px 6px; border:1px solid #d1d5db; border-radius:4px; background:#fff; color:#374151; }

  .cover { min-height: 90vh; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 40px; border-bottom: 4px solid #1976D2; }
  .cover-logo { font-size: 48pt; margin-bottom: 16px; }
  .cover-title { font-size: 22pt; font-weight: 700; color: #1976D2; margin-bottom: 8px; }
  .cover-project { font-size: 16pt; font-weight: 600; color: #212121; margin-bottom: 6px; }
  .cover-meta { font-size: 10pt; color: #757575; margin-top: 12px; }

  h2 { font-size: 13pt; font-weight: 700; color: #1976D2; margin: 24px 0 10px; border-bottom: 2px solid #E3F2FD; padding-bottom: 4px; }
  h3 { font-size: 11pt; font-weight: 600; color: #424242; margin: 16px 0 8px; }

  .kpi-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin-bottom: 16px; }
  .kpi-card { background: #F5F5F5; border-radius: 6px; padding: 8px 6px; text-align: center; }
  .kpi-value { font-size: 10pt; font-weight: 700; color: #1976D2; }  /* mismo tamaño que el contenido */
  .kpi-label { font-size: 8pt; color: #757575; margin-top: 2px; }

  table { width: 100%; border-collapse: collapse; font-size: 9.5pt; margin-bottom: 16px; }
  th { background: #1976D2; color: #fff; padding: 7px 10px; text-align: left; font-weight: 600; }
  td { padding: 6px 10px; border: 1px solid #E0E0E0; }
  tr:nth-child(even) td { background: #FAFAFA; }
  .tag { display: inline-block; border-radius: 10px; padding: 2px 8px; font-size: 9pt; font-weight: 600; }
  .tag-done { background: #E8F5E9; color: #388E3C; }
  .tag-prog { background: #E3F2FD; color: #1976D2; }
  .tag-todo { background: #F5F5F5; color: #757575; }
  .tag-crit { background: #FFEBEE; color: #D32F2F; }
  .bar-wrap { display: inline-flex; align-items: center; gap: 6px; }
  .bar-bg { width: 60px; height: 7px; background: #E0E0E0; border-radius: 3px; overflow: hidden; display: inline-block; }
  .bar-fill { height: 100%; background: #1976D2; border-radius: 3px; }
  .footer { margin-top: 30px; font-size: 6pt; color: #9E9E9E; text-align: center; border-top: 1px solid #E0E0E0; padding-top: 10px; }
  @media print { .print-header, .print-footer { display:flex !important; } }
  .page-break { page-break-before: always; }
  ${pageHfCss({ proj: project.name, date: `${_rpDD}-${_rpMM}-${_rpYY}, ${_rpHH}:${_rpMi}` })}
  ${REPORT_FONT_CSS}
</style>
</head>
<body>
<div class="tb">
  ${PAPER_SELECT_HTML}
  <span class="lbl">Orientaci&#243;n:</span>
  <button id="bp" class="act" onclick="setOri('portrait')">&#x1F4C4; Vertical</button>
  <button id="bl" onclick="setOri('landscape')">&#x1F5C2; Horizontal</button>
  <div class="sep"></div>
  <button onclick="window.close()">&#x2715; Cerrar</button>
  <button class="pri" style="margin-left:auto" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
</div>
<script>
  ${PAPER_JS}
  var _ori='portrait';
  function setOri(o){
    if(o)_ori=o; o=_ori;
    var sz=paperSize(o);
    document.getElementById('bp').classList.toggle('act',o==='portrait');
    document.getElementById('bl').classList.toggle('act',o==='landscape');
    var s=document.getElementById('_ps')||document.createElement('style');
    s.id='_ps';s.textContent='@page{size:'+sz[0]+'mm '+sz[1]+'mm}';document.head.appendChild(s);
  }
<\/script>
<div class="print-header"><span>ECM Project V1.00.01</span><span>${_rpProjEsc}</span><span>${_rpDD}-${_rpMM}-${_rpYY}, ${_rpHH}:${_rpMi}</span></div>
<div class="print-footer"><span>By EHCM</span><span>&#8212;</span><span>P&aacute;gina <span id="phf-cur">1</span> de <span id="phf-tot">1</span></span></div>

<div class="print-title">Informe Ejecutivo</div>
<div class="print-subtitle">Generado el ${generatedAt} · Inicio: ${_esc(project.start_date ?? '-')}</div>

<!-- RESUMEN EJECUTIVO -->
<h2>Resumen Ejecutivo</h2>
<div class="kpi-grid">
  <div class="kpi-card">
    <div class="kpi-value">${totalTasks}</div>
    <div class="kpi-label">Total Tareas</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-value" style="color:#388E3C">${doneTasks}</div>
    <div class="kpi-label">Completadas</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-value" style="color:#F57C00">${inProgress}</div>
    <div class="kpi-label">En Curso</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-value">${pctAvg}%</div>
    <div class="kpi-label">Avance Promedio</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-value" style="color:#1976D2">${cpmResult && maxEf ? fmtDate(maxEf - 1) : '-'}</div>
    <div class="kpi-label">Fin Proyectado</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-value" style="color:#D32F2F">${criticalTasks.length}</div>
    <div class="kpi-label">Tareas Críticas</div>
  </div>
</div>

<!-- EDT -->
<h2>EDT — Estructura de Desglose del Trabajo</h2>
<table>
  <thead><tr>
    <th style="width:42%">Tarea</th>
    <th style="width:11%">Inicio</th>
    <th style="width:11%">Fin</th>
    <th style="width:8%">Dur</th>
    <th style="width:14%">Avance</th>
    <th style="width:14%">Estado</th>
  </tr></thead>
  <tbody>
    ${taskArr.map(t => {
      const cpm = cpmResult?.tasks?.get(t.id);
      const pct = t.percent_complete ?? 0;
      const isSummary = t.type === 'summary' || _pdfParentIds.has(t.id);
      const isCrit = !isSummary && cpm?.tf === 0;
      const statusTag = pct >= 100
        ? '<span class="tag tag-done">Completada</span>'
        : pct > 0
          ? '<span class="tag tag-prog">En Curso</span>'
          : '<span class="tag tag-todo">Pendiente</span>';
      return `<tr>
        <td style="${isSummary?'font-weight:600;':''}${isCrit?'color:#D32F2F;':''}">
          ${_esc(t.name)}
        </td>
        <td>${cpm ? fmtDate(cpm.es) : '-'}</td>
        <td>${cpm ? fmtDate(Math.max(cpm.es, cpm.ef - 1)) : '-'}</td>
        <td>${cpm ? (cpm.ef - cpm.es) + 'd' : '-'}</td>
        <td>
          ${isSummary ? '' : `<div class="bar-wrap">
            <div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div>
            <span>${pct}%</span>
          </div>`}
        </td>
        <td>${isSummary ? '' : statusTag}</td>
      </tr>`;
    }).join('')}
  </tbody>
</table>

${criticalTasks.length ? `
<h2>Ruta Crítica</h2>
<table>
  <thead><tr>
    <th>Tarea crítica</th><th>Inicio</th><th>Fin</th><th>Duración</th><th>Avance</th>
  </tr></thead>
  <tbody>
    ${criticalTasks.map(t => {
      const cpm = cpmResult?.tasks?.get(t.id);
      return `<tr>
        <td style="color:#D32F2F;font-weight:600">${_esc(t.name)}</td>
        <td>${cpm ? fmtDate(cpm.es) : '-'}</td>
        <td>${cpm ? fmtDate(Math.max(cpm.es, cpm.ef - 1)) : '-'}</td>
        <td>${cpm ? (cpm.ef - cpm.es) + 'd' : '-'}</td>
        <td>${t.percent_complete ?? 0}%</td>
      </tr>`;
    }).join('')}
  </tbody>
</table>` : ''}

<div class="footer">
  ECM Project — Informe generado automáticamente el ${generatedAt}
</div>
</body>
</html>`;

  // Abrir en nueva ventana e imprimir
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) return { ok: false, error: 'Popup bloqueado. Permita ventanas emergentes para generar el PDF.' };
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => {
    (function(){var h=win.document.body;if(!h)return;var t=Math.max(1,Math.ceil(h.scrollHeight/1120));var el=win.document.getElementById('phf-tot');if(el)el.textContent=t;})();
  }, 600);
  return { ok: true };
}
