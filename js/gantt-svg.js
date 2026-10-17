// @ts-check
/**
 * gantt-svg.js — Exportador SVG del diagrama Gantt (para impresión/exportación).
 *
 * Genera un SVG estático autocontenido con:
 *   • Columna de nombres con indentación EDT
 *   • Barras de tarea (progreso, colores CPM, rombos de hito, corchetes de resumen)
 *   • Etiquetas sobre/junto a cada barra
 *   • Flechas de dependencia FS/SS/FF/SF
 *   • Bandas de fin de semana
 *   • Encabezado mes/semana
 *   • Línea de hoy
 */

const MESES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

const CLR = {
  critical:  '#D32F2F',
  done:      '#388E3C',
  near:      '#FB8C00',
  normal:    '#1976D2',
  milestone: '#F9A825',
  summary:   '#5C6BC0',
  arrow:     '#546E7A',
};

const PPD        = 16;   // px por día calendario
const ROW_H      = 30;
const HDR_H      = 52;   // dos filas: mes + semana/día
const BASE_NAME_W = 200; // columna de nombres (reducida si hay cols extra)
const BAR_PAD    = 7;    // espacio vertical dentro de la fila
const BAR_H      = ROW_H - BAR_PAD * 2;

/** Definiciones de columnas extra disponibles */
const EXTRA_COL_DEFS = {
  dur:    { label: 'Dur',    w: 44,  align: 'right'  },
  start:  { label: 'Inicio', w: 68,  align: 'center' },
  finish: { label: 'Fin',    w: 68,  align: 'center' },
  pct:    { label: '%',      w: 38,  align: 'right'  },
  tf:     { label: 'HT',     w: 38,  align: 'right'  },
};

function _fmtDate(date) {
  if (!date) return '';
  return `${date.getDate()}/${date.getMonth() + 1}/${String(date.getFullYear()).slice(2)}`;
}

/**
 * @param {{
 *   tasks: Map<string,any>,
 *   deps: Map<string,any>,
 *   cpmResult: any,
 *   calendar: any,
 *   projectStart: Date,
 *   rows: Array<{id:string,isSummary:boolean,depth:number}>,
 *   nearThreshold?: number,
 *   extraCols?: string[]
 * }} opts
 * @returns {string}
 */
export function renderGanttSvg({ tasks, deps, cpmResult, calendar, projectStart, rows, nearThreshold = 5, extraCols = [] }) {
  const activeCols = extraCols.map(id => ({ id, ...(EXTRA_COL_DEFS[id] ?? null) })).filter(c => c.label);
  const extraW  = activeCols.reduce((s, c) => s + c.w, 0);
  const NAME_W  = BASE_NAME_W + extraW;

  // Compute actual bar extent (left and right) across all visible rows
  let maxCalDay = cpmResult.projectDuration ?? 100;
  let minBarCalDay = Infinity;
  for (const { id } of rows) {
    const cpm = cpmResult.tasks.get(id);
    if (!cpm || cpm.ef == null || cpm.es == null) continue;
    const endD   = calendar.finishDate(cpm.ef, projectStart);
    const startD = calendar.idxToDate(cpm.es, projectStart);
    const endDay   = _daysFrom(endD, projectStart) + 1;
    const startDay = _daysFrom(startD, projectStart);
    if (endDay   > maxCalDay)    maxCalDay    = endDay;
    if (startDay < minBarCalDay) minBarCalDay = startDay;
  }
  if (!isFinite(minBarCalDay)) minBarCalDay = 0;

  const LEFT_PAD  = 5;  // días de margen antes de la primera barra
  const cropDays  = Math.max(0, minBarCalDay - LEFT_PAD);
  const cropOffset = cropDays * PPD;           // px a recortar por la izquierda

  const totalDays  = maxCalDay + 20;           // 20-day padding right
  const visibleDays = totalDays - cropDays;
  const totalW    = NAME_W + visibleDays * PPD;
  const totalH    = HDR_H + rows.length * ROW_H;

  // Mapa rowIndex por taskId para dibujar flechas
  const rowIdx = new Map(rows.map(({ id }, i) => [id, i]));

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg"
    width="${totalW}" height="${totalH}"
    viewBox="0 0 ${totalW} ${totalH}"
    font-family="'IBM Plex Sans','Segoe UI',system-ui,sans-serif"
    font-size="11">`);

  // ---- Defs ----
  out.push(`<defs>
    <clipPath id="gc-body"><rect x="${NAME_W}" y="${HDR_H}" width="${totalW - NAME_W}" height="${totalH - HDR_H}"/></clipPath>
    <clipPath id="gc-hdr"><rect x="${NAME_W}" y="0" width="${totalW - NAME_W}" height="${HDR_H}"/></clipPath>
    <clipPath id="gc-names"><rect x="0" y="${HDR_H}" width="${NAME_W - 4}" height="${totalH - HDR_H}"/></clipPath>
    <marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0,0 L0,6 L6,3 z" fill="${CLR.arrow}" opacity="0.8"/>
    </marker>
    <marker id="arr-red" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0,0 L0,6 L6,3 z" fill="${CLR.critical}" opacity="0.8"/>
    </marker>
  </defs>`);

  // ---- Fondo ----
  out.push(`<rect width="${totalW}" height="${totalH}" fill="#fff"/>`);

  // ---- Columna de nombres ----
  out.push(`<rect x="0" y="${HDR_H}" width="${NAME_W}" height="${totalH - HDR_H}" fill="#F8F9FA"/>`);
  out.push(`<rect x="0" y="0" width="${NAME_W}" height="${HDR_H}" fill="#F0F2F5"/>`);
  // Encabezado columna nombre
  out.push(`<text x="8" y="${HDR_H / 2 + 5}" fill="#455A64" font-weight="700" font-size="11">ACTIVIDAD</text>`);

  // Encabezados columnas extra
  let hx = BASE_NAME_W;
  for (const col of activeCols) {
    out.push(`<line x1="${hx}" y1="0" x2="${hx}" y2="${totalH}" stroke="#CFD8DC" stroke-width="0.5"/>`);
    out.push(`<text x="${hx + col.w / 2}" y="${HDR_H / 2 + 5}" text-anchor="middle" fill="#455A64" font-weight="700" font-size="10">${col.label}</text>`);
    hx += col.w;
  }
  out.push(`<line x1="${NAME_W}" y1="0" x2="${NAME_W}" y2="${totalH}" stroke="#CFD8DC" stroke-width="1"/>`);

  // Filas de nombres + datos extra
  out.push(`<g clip-path="url(#gc-names)">`);
  rows.forEach(({ id, depth, isSummary }, i) => {
    const task = tasks.get(id);
    if (!task) return;
    const y   = HDR_H + i * ROW_H;
    const ind = 8 + depth * 14;
    if (i % 2 === 0) out.push(`<rect x="0" y="${y}" width="${NAME_W}" height="${ROW_H}" fill="rgba(0,0,0,0.02)"/>`);
    out.push(`<line x1="0" y1="${y + ROW_H}" x2="${NAME_W}" y2="${y + ROW_H}" stroke="#E8EAED" stroke-width="0.5"/>`);
    const fill = isSummary ? '#263238' : '#37474F';
    const fw   = isSummary ? '600' : '400';
    out.push(`<text x="${ind}" y="${y + ROW_H / 2 + 4}" fill="${fill}" font-weight="${fw}" font-size="11">${_esc(task.name)}</text>`);

    // Celdas de columnas extra
    const cpm = cpmResult.tasks.get(id);
    let cx = BASE_NAME_W;
    for (const col of activeCols) {
      let val = '';
      if (col.id === 'dur')    val = task.type === 'milestone' ? '0' : String(task.duration_days ?? '');
      if (col.id === 'start'  && cpm?.es != null) val = _fmtDate(calendar.idxToDate(cpm.es, projectStart));
      if (col.id === 'finish' && cpm?.ef != null) val = _fmtDate(calendar.finishDate(cpm.ef, projectStart));
      if (col.id === 'pct')   val = `${task.percent_complete ?? 0}%`;
      if (col.id === 'tf'     && cpm?.tf != null) val = String(cpm.tf);
      const anchor = col.align === 'right' ? 'end' : col.align === 'center' ? 'middle' : 'start';
      const tx = col.align === 'right' ? cx + col.w - 4 : cx + col.w / 2;
      const clr = col.id === 'tf' && cpm?.is_critical ? '#D32F2F' : (col.id === 'tf' && (cpm?.tf ?? 99) <= 5 ? '#FB8C00' : '#546E7A');
      out.push(`<text x="${tx}" y="${y + ROW_H / 2 + 4}" text-anchor="${anchor}" fill="${clr}" font-size="10">${_esc(val)}</text>`);
      cx += col.w;
    }
  });
  out.push('</g>');

  // ---- Área de Gantt ----
  // Encabezado (meses y semanas)
  out.push(`<rect x="${NAME_W}" y="0" width="${totalW - NAME_W}" height="${HDR_H}" fill="#F0F2F5"/>`);
  out.push(`<line x1="${NAME_W}" y1="${HDR_H}" x2="${totalW}" y2="${HDR_H}" stroke="#B0BEC5" stroke-width="1"/>`);
  out.push(`<g clip-path="url(#gc-hdr)"><g transform="translate(${-cropOffset}, 0)">`);
  _drawHeader(out, NAME_W, HDR_H, PPD, projectStart, totalDays);
  out.push('</g></g>');

  // Grupo clippeado para todo el cuerpo — translate recorta el espacio vacío izquierdo
  out.push(`<g clip-path="url(#gc-body)"><g transform="translate(${-cropOffset}, 0)">`);

  // Bandas alternadas de fila
  rows.forEach((_, i) => {
    if (i % 2 === 0) return;
    const y = HDR_H + i * ROW_H;
    out.push(`<rect x="${NAME_W}" y="${y}" width="${totalW - NAME_W}" height="${ROW_H}" fill="rgba(0,0,0,0.018)"/>`);
  });

  // Bandas de fines de semana
  _drawWeekends(out, NAME_W, HDR_H, totalH, PPD, projectStart, totalDays);

  // Separadores de fila
  rows.forEach((_, i) => {
    const y = HDR_H + (i + 1) * ROW_H;
    out.push(`<line x1="${NAME_W}" y1="${y}" x2="${totalW}" y2="${y}" stroke="#ECEFF1" stroke-width="0.5"/>`);
  });

  // ---- Barras ----
  rows.forEach(({ id, isSummary }, i) => {
    const task = tasks.get(id);
    const cpm  = cpmResult.tasks.get(id);
    if (!task || !cpm || cpm.es == null) return;

    const color = _color(task, cpm, nearThreshold);
    const midY  = HDR_H + i * ROW_H + ROW_H / 2;
    const barY  = HDR_H + i * ROW_H + BAR_PAD;

    if (task.type === 'milestone') {
      const d  = calendar.idxToDate(cpm.es, projectStart);
      const cx = NAME_W + _daysFrom(d, projectStart) * PPD;
      const s  = BAR_H * 0.5;
      out.push(`<polygon points="${cx},${midY - s} ${cx + s},${midY} ${cx},${midY + s} ${cx - s},${midY}"
        fill="${color}" stroke="white" stroke-width="1"/>`);
      // Etiqueta
      out.push(`<text x="${cx + s + 4}" y="${midY + 4}" fill="${color}" font-weight="600">${_esc(task.name)}</text>`);
      return;
    }

    const startD  = calendar.idxToDate(cpm.es, projectStart);
    const endD    = calendar.finishDate(cpm.ef, projectStart);
    const x1 = NAME_W + _daysFrom(startD, projectStart) * PPD;
    const x2 = NAME_W + (_daysFrom(endD, projectStart) + 1) * PPD;
    const bw = Math.max(x2 - x1, 3);

    if (isSummary) {
      // Barra de resumen: banda central + triángulos en extremos
      const tH = Math.max(3, Math.round(BAR_H * 0.35));
      const tY = barY + (BAR_H - tH) / 2;
      const cap = Math.min(BAR_H, 9);
      out.push(`<rect x="${x1}" y="${tY}" width="${bw}" height="${tH}" fill="${color}"/>`);
      out.push(`<polygon points="${x1},${barY} ${x1},${barY + cap} ${x1 + cap * 0.6},${barY + cap}" fill="${color}"/>`);
      out.push(`<polygon points="${x1 + bw},${barY} ${x1 + bw},${barY + cap} ${x1 + bw - cap * 0.6},${barY + cap}" fill="${color}"/>`);
    } else {
      // Barra normal con progreso
      const pct = task.percent_complete ?? 0;
      out.push(`<rect x="${x1}" y="${barY}" width="${bw}" height="${BAR_H}" rx="3" fill="${color}22"/>`);
      if (pct > 0) {
        const pw = Math.max((pct / 100) * bw, 3);
        out.push(`<rect x="${x1}" y="${barY}" width="${pw}" height="${BAR_H}" rx="3" fill="${color}"/>`);
      }
      out.push(`<rect x="${x1}" y="${barY}" width="${bw}" height="${BAR_H}" rx="3" fill="none" stroke="${color}" stroke-width="1.5"/>`);
    }

    // ---- Etiqueta de la barra ----
    const labelText = _esc(task.name);
    const labelX    = x1 + bw + 5;              // siempre a la derecha de la barra
    const labelY    = midY + 4;
    out.push(`<text x="${labelX}" y="${labelY}" fill="${isSummary ? '#263238' : '#37474F'}"
      font-weight="${isSummary ? '600' : '400'}" font-size="10">${labelText}</text>`);
  });

  // ---- Flechas de dependencia ----
  out.push(`<g opacity="0.75">`);
  deps.forEach(dep => {
    if (dep.deleted_at) return;
    if (dep.type !== 'FS') return;   // solo FS por claridad; agregar otros si se desea
    const pi = rowIdx.get(dep.pred_id);
    const si = rowIdx.get(dep.succ_id);
    if (pi == null || si == null) return;

    const predCpm = cpmResult.tasks.get(dep.pred_id);
    const succCpm = cpmResult.tasks.get(dep.succ_id);
    if (!predCpm || !succCpm || predCpm.ef == null || succCpm.es == null) return;

    const predTask = tasks.get(dep.pred_id);
    const isOnCrit = predCpm.is_critical && succCpm.is_critical;
    const arrowClr = isOnCrit ? CLR.critical : CLR.arrow;
    const marker   = isOnCrit ? 'arr-red' : 'arr';

    const predEndDate = predTask?.type === 'milestone'
      ? calendar.idxToDate(predCpm.es, projectStart)
      : calendar.finishDate(predCpm.ef, projectStart);
    const succStartDate = calendar.idxToDate(succCpm.es, projectStart);

    const x1 = NAME_W + (_daysFrom(predEndDate, projectStart) + (predTask?.type === 'milestone' ? 0 : 1)) * PPD;
    const x2 = NAME_W + _daysFrom(succStartDate, projectStart) * PPD - 2;
    const y1 = HDR_H + pi * ROW_H + ROW_H / 2;
    const y2 = HDR_H + si * ROW_H + ROW_H / 2;

    // Flecha FS: salir por la derecha del predecesor → entrar por la izquierda del sucesor
    // El último segmento SIEMPRE va hacia la derecha (→) para que orient="auto" apunte →
    const OFF = 10;
    let pts;
    if (x2 >= x1 + OFF * 2) {
      // Caso normal: pred_fin ≤ succ_start con margen
      const mx = x1 + (x2 - x1) / 2;
      pts = `${x1},${y1} ${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    } else {
      // Caso overlap / sin margen: rodear por el lado con un U-turn que entra de izquierda
      const rx = x1 + OFF;                // desvío a la derecha del pred
      const lx = Math.min(x2 - OFF, x1 - OFF); // desvío a la izquierda del succ
      const mid = (y1 + y2) / 2;
      pts = `${x1},${y1} ${rx},${y1} ${rx},${mid} ${lx},${mid} ${lx},${y2} ${x2},${y2}`;
    }
    out.push(`<polyline points="${pts}"
      fill="none" stroke="${arrowClr}" stroke-width="1.5"
      marker-end="url(#${marker})" stroke-linecap="round" stroke-linejoin="round"/>`);
  });
  out.push('</g>');

  // Línea de hoy
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayX = NAME_W + _daysFrom(today, projectStart) * PPD;
  if (todayX >= NAME_W && todayX <= totalW) {
    out.push(`<line x1="${todayX}" y1="${HDR_H}" x2="${todayX}" y2="${totalH}"
      stroke="#1565C0" stroke-width="1.5" stroke-dasharray="6 3" opacity="0.55"/>`);
    out.push(`<text x="${todayX + 3}" y="${HDR_H - 4}" fill="#1565C0" font-size="9" font-weight="600">HOY</text>`);
  }

  out.push('</g></g>'); // fin transform + fin gc-body

  out.push('</svg>');
  return out.join('\n');
}

// ============================================================
// Helpers
// ============================================================

function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _daysFrom(date, start) {
  return Math.round((date.getTime() - start.getTime()) / 86400000);
}

function _color(task, cpm, near) {
  if (cpm.tf === null) return CLR.done;
  if (task.type === 'milestone') return CLR.milestone;
  if (cpm.is_summary) return CLR.summary;
  if (cpm.is_critical) return CLR.critical;
  if (cpm.tf >= 0 && cpm.tf <= near) return CLR.near;
  return CLR.normal;
}

/** Dibuja encabezado de dos niveles: mes arriba, semanas abajo */
function _drawHeader(out, offsetX, hdrH, ppd, start, totalDays) {
  const midH   = Math.round(hdrH / 2);
  const endDate = new Date(start.getTime() + totalDays * 86400000);

  // Nivel superior: meses
  let d = new Date(start.getFullYear(), start.getMonth(), 1);
  while (d <= endDate) {
    const x = offsetX + _daysFrom(d, start) * ppd;
    out.push(`<line x1="${x}" y1="0" x2="${x}" y2="${midH}" stroke="#CFD8DC"/>`);
    out.push(`<text x="${x + 5}" y="${midH / 2 + 5}" fill="#455A64" font-weight="700" font-size="11">
      ${MESES[d.getMonth()]} ${d.getFullYear()}
    </text>`);
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  }

  // Separador entre niveles
  out.push(`<line x1="${offsetX}" y1="${midH}" x2="${offsetX + totalDays * ppd}" y2="${midH}" stroke="#CFD8DC"/>`);

  // Nivel inferior: semanas (números de día si ppd >= 10)
  let w = new Date(start);
  // Retroceder al lunes anterior
  while (w.getDay() !== 1) w = new Date(w.getTime() - 86400000);
  while (w <= endDate) {
    const x = offsetX + _daysFrom(w, start) * ppd;
    if (x >= offsetX - ppd * 7) {
      out.push(`<line x1="${x}" y1="${midH}" x2="${x}" y2="${hdrH}" stroke="#E0E0E0"/>`);
      const wLabel = `${w.getDate()}`;
      out.push(`<text x="${x + 3}" y="${midH + (hdrH - midH) / 2 + 5}" fill="#78909C" font-size="9">${wLabel}</text>`);
    }
    w = new Date(w.getTime() + 7 * 86400000);
  }
}

function _drawWeekends(out, offsetX, hdrH, totalH, ppd, start, totalDays) {
  const end = new Date(start.getTime() + totalDays * 86400000);
  let d = new Date(start); d.setHours(0, 0, 0, 0);
  while (d <= end) {
    const dow = d.getDay();
    if (dow === 0 || dow === 6) {
      const x = offsetX + _daysFrom(d, start) * ppd;
      out.push(`<rect x="${x}" y="${hdrH}" width="${ppd}" height="${totalH - hdrH}" fill="rgba(0,0,0,0.035)"/>`);
    }
    d = new Date(d.getTime() + 86400000);
  }
}
