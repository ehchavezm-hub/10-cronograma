// @ts-check
/**
 * curva-s.js — Curva S de Avance (Planificado vs Real vs Proyectado vs Línea Base).
 * Usa SVG para renderizar la curva acumulada de avance del proyecto.
 */

import { appState } from './state.js';
import { pageHfCss, REPORT_TITLE_CSS, REPORT_FONT_CSS, PAPER_SELECT_HTML, PAPER_JS, FONTS_LINK } from './pdf-utils.js';
import { Calendar, isoToDate } from './calendar.js';
import { listBaselines, loadBaselineData } from './baseline.js';

function _makeDraggable(dialog, handleSelector) {
  const handle = handleSelector ? dialog.querySelector(handleSelector) : dialog;
  if (!handle) return;
  let startX, startY, startLeft, startTop;
  handle.style.cursor = 'move';
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (/** @type {HTMLElement} */ (e.target).closest('button,input,select,textarea,a')) return;
    e.preventDefault();
    const rect = dialog.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    dialog.style.transform = 'none';
    dialog.style.position = 'fixed';
    dialog.style.margin = '0';
    dialog.style.left = startLeft + 'px';
    dialog.style.top = startTop + 'px';
    const onMove = mv => {
      dialog.style.left = (startLeft + mv.clientX - startX) + 'px';
      dialog.style.top  = (startTop  + mv.clientY - startY) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/** Genera SVG como string con dimensiones fijas para impresión */
function _buildSvgString(W, H, days, planned, actual, projected, baseline, vis, fmtDate) {
  const pad = { t: 16, r: 16, b: 42, l: 48 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  const uid = Math.random().toString(36).slice(2, 8);

  const xOf = (i) => pad.l + (i / Math.max(1, days.length - 1)) * cw;
  const yOf = (v) => pad.t + ch - (v / 100) * ch;

  const pathLine = (series, filter) => {
    let d = '';
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v === null || v === undefined) continue;
      if (filter && !filter(i)) continue;
      const x = xOf(i).toFixed(1);
      const y = yOf(v).toFixed(1);
      d += d ? `L${x},${y}` : `M${x},${y}`;
    }
    return d;
  };

  const xLabels = [];
  const xStep = Math.max(1, Math.floor(days.length / 6));
  for (let i = 0; i < days.length; i += xStep) xLabels.push(i);
  if (xLabels[xLabels.length - 1] !== days.length - 1) xLabels.push(days.length - 1);

  const yLabels = [0, 25, 50, 75, 100];
  const areaPath = vis.planned
    ? pathLine(planned) + `L${xOf(days.length-1).toFixed(1)},${yOf(0).toFixed(1)}L${xOf(0).toFixed(1)},${yOf(0).toFixed(1)}Z`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="cs-grad-${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#1976D2" stop-opacity="0.18"/>
        <stop offset="100%" stop-color="#1976D2" stop-opacity="0.02"/>
      </linearGradient>
    </defs>
    <rect x="${pad.l}" y="${pad.t}" width="${cw}" height="${ch}" fill="#f8f9fa" rx="4"/>
    ${yLabels.map(v => `
      <line x1="${pad.l}" y1="${yOf(v).toFixed(1)}" x2="${pad.l+cw}" y2="${yOf(v).toFixed(1)}" stroke="#e0e0e0" stroke-width="1" stroke-dasharray="3,3"/>
      <text x="${(pad.l-4).toFixed(1)}" y="${yOf(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle" font-size="10" fill="#999" font-family="Arial">${v}%</text>`).join('')}
    ${xLabels.map(i => `
      <line x1="${xOf(i).toFixed(1)}" y1="${pad.t}" x2="${xOf(i).toFixed(1)}" y2="${pad.t+ch}" stroke="#e0e0e0" stroke-width="1" stroke-dasharray="3,3"/>
      <text x="${xOf(i).toFixed(1)}" y="${(pad.t+ch+14).toFixed(1)}" text-anchor="middle" font-size="9" fill="#999" font-family="Arial">${fmtDate(days[i])}</text>`).join('')}
    ${vis.planned && areaPath ? `<path d="${areaPath}" fill="url(#cs-grad-${uid})"/>` : ''}
    ${vis.planned ? `<path d="${pathLine(planned)}" fill="none" stroke="#1976D2" stroke-width="2" stroke-linejoin="round"/>` : ''}
    ${vis.actual ? `<path d="${pathLine(actual)}" fill="none" stroke="#388E3C" stroke-width="2.5" stroke-linejoin="round"/>` : ''}
    ${vis.projected ? `<path d="${pathLine(projected, i => projected[i] !== null)}" fill="none" stroke="#F57C00" stroke-width="2" stroke-dasharray="6,4" stroke-linejoin="round"/>` : ''}
    ${vis.baseline && baseline ? `<path d="${pathLine(baseline)}" fill="none" stroke="#7B1FA2" stroke-width="2" stroke-dasharray="4,2" stroke-linejoin="round"/>` : ''}
    <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t+ch}" stroke="#ccc" stroke-width="1.5"/>
    <line x1="${pad.l}" y1="${pad.t+ch}" x2="${pad.l+cw}" y2="${pad.t+ch}" stroke="#ccc" stroke-width="1.5"/>
  </svg>`;
}

export class CurvaSPanel {
  /** @param {HTMLElement} containerEl */
  constructor(containerEl) {
    this.el = containerEl;
    this._uid = Math.random().toString(36).slice(2, 8);
    /** @type {{planned:boolean, actual:boolean, projected:boolean, baseline:boolean}} */
    this._vis = { planned: true, actual: true, projected: true, baseline: false };
    /** @type {string|null} */
    this._selectedBaselineId = null;
    /** @type {Array<{id:string, name:string}>} */
    this._baselines = [];
    // cached series for print
    /** @type {{days:number[], planned:number[], actual:number[], projected:(number|null)[], baseline:(number[])|null, startDate:Date, cal:any, minDay:number}|null} */
    this._lastData = null;
    this._build();
  }

  _build() {
    this.el.innerHTML = '';
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-ui);position:relative';

    // Header
    const hdr = document.createElement('div');
    hdr.setAttribute('data-drag-handle', '');
    hdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 18px;padding-right:44px;border-bottom:1px solid var(--clr-border);flex-shrink:0';
    hdr.innerHTML = `
      <span style="font-size:20px">📈</span>
      <div style="flex:1">
        <div style="font-size:var(--text-md,14px);font-weight:600;color:var(--clr-text)">Curva S de Avance</div>
        <div style="font-size:11px;color:var(--clr-text-3)">Planificado vs Real vs Proyectado</div>
      </div>`;
    const _printBtn = document.createElement('button');
    _printBtn.innerHTML = '🖨 Imprimir';
    _printBtn.title = 'Imprimir PDF';
    _printBtn.className = 'btn btn-ghost btn-sm';
    _printBtn.style.cssText = 'flex-shrink:0;margin-right:36px';
    _printBtn.addEventListener('click', () => this._print());
    hdr.appendChild(_printBtn);
    this.el.appendChild(hdr);
    const _closeBtn = document.createElement('button');
    _closeBtn.id = 'btn-curva-s-close';
    _closeBtn.className = 'btn btn-ghost btn-icon btn-sm';
    _closeBtn.title = 'Cerrar';
    _closeBtn.setAttribute('aria-label', 'Cerrar');
    _closeBtn.textContent = '✕';
    _closeBtn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:20;font-size:16px;width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:50%';
    _closeBtn.addEventListener('click', () => {
      const p = document.getElementById('panel-curva-s');
      if (p) p.style.display = 'none';
    });
    this.el.appendChild(_closeBtn);

    // Opciones de vista (toggles)
    this._ctrlRow = document.createElement('div');
    this._ctrlRow.style.cssText = 'display:flex;gap:6px;padding:8px 18px;flex-shrink:0;flex-wrap:wrap;align-items:center;border-bottom:1px solid var(--clr-border)';
    this._ctrlRow.innerHTML = `
      <span style="font-size:11px;color:var(--clr-text-3);font-weight:600;margin-right:4px">Vista:</span>
      <button data-vis="planned"  class="cs-tog active" style="font-size:11px;padding:3px 10px;border-radius:12px;border:1px solid #1976D2;background:#1976D2;color:#fff;cursor:pointer">Planificado</button>
      <button data-vis="actual"   class="cs-tog active" style="font-size:11px;padding:3px 10px;border-radius:12px;border:1px solid #388E3C;background:#388E3C;color:#fff;cursor:pointer">Real</button>
      <button data-vis="projected" class="cs-tog active" style="font-size:11px;padding:3px 10px;border-radius:12px;border:1px solid #F57C00;background:#F57C00;color:#fff;cursor:pointer">Proyectado</button>
      <button data-vis="baseline" class="cs-tog" style="font-size:11px;padding:3px 10px;border-radius:12px;border:1px solid #7B1FA2;background:transparent;color:#7B1FA2;cursor:pointer">Línea Base</button>
      <select id="cs-bl-select" style="font-size:11px;padding:3px 8px;border-radius:6px;border:1px solid var(--clr-border);background:var(--clr-surface);color:var(--clr-text);display:none">
        <option value="">— Seleccionar línea base —</option>
      </select>`;
    this.el.appendChild(this._ctrlRow);

    // Leyenda
    this._legend = document.createElement('div');
    this._legend.style.cssText = 'display:flex;gap:16px;padding:6px 18px;flex-shrink:0;flex-wrap:wrap';
    this._updateLegend();
    this.el.appendChild(this._legend);

    this._chartArea = document.createElement('div');
    this._chartArea.style.cssText = 'flex:1;padding:8px 18px 18px;overflow:auto;min-height:0';
    this.el.appendChild(this._chartArea);

    // Toggle listeners
    this._ctrlRow.querySelectorAll('.cs-tog').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = /** @type {HTMLElement} */ (btn).dataset.vis;
        if (!key) return;
        this._vis[key] = !this._vis[key];
        const colors = { planned:'#1976D2', actual:'#388E3C', projected:'#F57C00', baseline:'#7B1FA2' };
        const clr = colors[key] || '#999';
        if (this._vis[key]) {
          btn.style.background = clr;
          btn.style.color = '#fff';
          btn.classList.add('active');
        } else {
          btn.style.background = 'transparent';
          btn.style.color = clr;
          btn.classList.remove('active');
        }
        // show/hide baseline selector
        const sel = /** @type {HTMLSelectElement|null} */ (this._ctrlRow.querySelector('#cs-bl-select'));
        if (sel) sel.style.display = this._vis.baseline ? '' : 'none';
        this._updateLegend();
        this.refresh();
      });
    });

    // Baseline selector
    const blSel = /** @type {HTMLSelectElement|null} */ (this._ctrlRow.querySelector('#cs-bl-select'));
    if (blSel) {
      blSel.addEventListener('change', () => {
        this._selectedBaselineId = blSel.value || null;
        this.refresh();
      });
    }

    this._ro = new ResizeObserver(() => this.refresh());
    this._ro.observe(this._chartArea);

    if (this.el.parentElement) _makeDraggable(this.el.parentElement, '[data-drag-handle]');
    this._loadBaselines().then(() => this.refresh());
  }

  _updateLegend() {
    const items = [
      { key: 'planned',   color: '#1976D2', label: 'Planificado', dash: false },
      { key: 'actual',    color: '#388E3C', label: 'Real',         dash: false },
      { key: 'projected', color: '#F57C00', label: 'Proyectado',   dash: true },
      { key: 'baseline',  color: '#7B1FA2', label: 'Línea Base',   dash: true },
    ];
    this._legend.innerHTML = items
      .filter(it => this._vis[it.key])
      .map(it => `<div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--clr-text-2)">
        <div style="width:20px;height:3px;border-radius:2px;background:${it.dash ? 'none' : it.color};${it.dash ? `background-image:repeating-linear-gradient(90deg,${it.color} 0,${it.color} 4px,transparent 4px,transparent 8px)` : ''}"></div>${it.label}</div>`)
      .join('');
  }

  async _loadBaselines() {
    const { project } = appState.state;
    if (!project) return;
    try {
      this._baselines = await listBaselines(project.id);
    } catch (_) { this._baselines = []; }
    const sel = /** @type {HTMLSelectElement|null} */ (this._ctrlRow?.querySelector('#cs-bl-select'));
    if (!sel) return;
    // Repopulate
    sel.innerHTML = '<option value="">— Seleccionar línea base —</option>';
    for (const bl of this._baselines) {
      const opt = document.createElement('option');
      opt.value = bl.id;
      opt.textContent = bl.name;
      sel.appendChild(opt);
    }
    if (this._selectedBaselineId) sel.value = this._selectedBaselineId;
  }

  async refresh() {
    const { project, tasks, cpmResult, calendar, calExceptions } = appState.state;

    if (!project || !cpmResult) {
      this._chartArea.innerHTML = '<p style="color:var(--clr-text-3);font-size:13px;padding:16px 0">Abre un proyecto con CPM calculado para ver la Curva S.</p>';
      return;
    }

    const cal = new Calendar({
      work_week: calendar?.work_week ?? [1,2,3,4,5],
      exceptions: calExceptions ?? [],
    });
    const startDate = isoToDate(project.start_date || new Date().toISOString().slice(0,10));

    // Construir series de datos — excluir resúmenes e hitos
    const _parentIds = new Set([...tasks.values()].filter(t => !t.deleted_at && t.parent_id).map(t => t.parent_id));
    const taskArr = [...tasks.values()].filter(t => !t.deleted_at && t.type !== 'milestone' && t.type !== 'summary' && !_parentIds.has(t.id));
    if (!taskArr.length) {
      this._chartArea.innerHTML = '<p style="color:var(--clr-text-3);font-size:13px;padding:16px 0">No hay tareas para mostrar.</p>';
      return;
    }

    // Rango de días
    let minDay = Infinity, maxDay = -Infinity;
    for (const t of taskArr) {
      const cpm = cpmResult.tasks?.get(t.id);
      if (!cpm) continue;
      minDay = Math.min(minDay, cpm.es);
      maxDay = Math.max(maxDay, cpm.ef);
    }
    if (!isFinite(minDay)) { this._chartArea.innerHTML = '<p style="color:var(--clr-text-3);font-size:13px">Sin datos CPM.</p>'; return; }

    // Cargar línea base si se seleccionó
    /** @type {Map<string,{es:number,ef:number,dur:number}>|null} */
    let blData = null;
    if (this._vis.baseline && this._selectedBaselineId) {
      try { blData = await loadBaselineData(this._selectedBaselineId); } catch (_) {}
      // Extender rango con la línea base
      if (blData) {
        for (const [, b] of blData) {
          minDay = Math.min(minDay, b.es);
          maxDay = Math.max(maxDay, b.ef);
        }
      }
    }

    const totalDays = maxDay - minDay;
    const step = Math.max(1, Math.ceil(totalDays / 50));
    const days = [];
    for (let d = minDay; d <= maxDay; d += step) days.push(d);
    if (days[days.length-1] !== maxDay) days.push(maxDay);

    // Mismo peso que las series (ef - es): con otro peso la curva superaba el 100%
    const totalWeight = taskArr.reduce((s, t) => {
      const cpm = cpmResult.tasks?.get(t.id);
      return cpm ? s + ((cpm.ef - cpm.es) || 1) : s;
    }, 0) || 1;

    // Planificado
    const planned = days.map(day => {
      let sum = 0;
      for (const t of taskArr) {
        const cpm = cpmResult.tasks?.get(t.id);
        if (!cpm) continue;
        const dur = cpm.ef - cpm.es || 1;
        if (cpm.ef <= day) sum += dur;
        else if (cpm.es < day) sum += dur * (day - cpm.es) / dur;
      }
      return (sum / totalWeight) * 100;
    });

    // Real
    const actual = days.map(day => {
      let sum = 0;
      for (const t of taskArr) {
        const cpm = cpmResult.tasks?.get(t.id);
        if (!cpm || cpm.es >= day) continue;
        const w = (cpm.ef - cpm.es) || 1;
        const pct = (t.percent_complete ?? 0) / 100;
        if (cpm.ef <= day) sum += w * pct;
        else sum += w * pct * Math.min(1, (day - cpm.es) / w);
      }
      return (sum / totalWeight) * 100;
    });

    // Proyectado
    const today = new Date();
    today.setHours(0,0,0,0);
    let todayIdx = 0;
    { const d = new Date(startDate); while (d < today) { if (cal.isWorkingDay(d)) todayIdx++; d.setDate(d.getDate()+1); } }
    const todayDayInRange = Math.max(minDay, Math.min(maxDay, todayIdx));
    const todayPos = days.findIndex(d => d >= todayDayInRange);
    const actualNow = todayPos >= 0 ? actual[todayPos] : actual[actual.length-1];
    const projected = days.map((day, i) => {
      if (i <= (todayPos >= 0 ? todayPos : days.length-1)) return null;
      const progress = (day - todayDayInRange) / Math.max(1, maxDay - todayDayInRange);
      return actualNow + (100 - actualNow) * progress;
    });

    // Línea base series
    /** @type {number[]|null} */
    let baselineSeries = null;
    if (blData && this._vis.baseline) {
      const blWeight = [...blData.values()].reduce((s, b) => s + ((b.ef - b.es) || 1), 0) || totalWeight;
      baselineSeries = days.map(day => {
        let sum = 0;
        for (const [, b] of blData) {
          const dur = b.ef - b.es || 1;
          if (b.ef <= day) sum += dur;
          else if (b.es < day) sum += dur * (day - b.es) / dur;
        }
        return (sum / blWeight) * 100;
      });
    }

    this._lastData = { days, planned, actual, projected, baseline: baselineSeries, startDate, cal, minDay };
    this._renderSvg(days, planned, actual, projected, baselineSeries, startDate, cal, minDay);
  }

  /**
   * @param {number[]} days
   * @param {number[]} planned
   * @param {number[]} actual
   * @param {(number|null)[]} projected
   * @param {number[]|null} baseline
   * @param {Date} startDate
   * @param {Calendar} cal
   * @param {number} minDay
   */
  _renderSvg(days, planned, actual, projected, baseline, startDate, cal, minDay) {
    const W = this._chartArea.clientWidth || 600;
    const H = Math.max(200, Math.min(340, Math.round(W * 0.45)));
    const fmtDate = (d) => cal.idxToDate(d, startDate).toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit' });
    this._chartArea.innerHTML = _buildSvgString(W, H, days, planned, actual, projected, baseline, this._vis, fmtDate);
  }

  _print() {
    const d = this._lastData;
    if (!d) { return; }
    const fmtDate = (day) => d.cal.idxToDate(day, d.startDate).toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });

    const svgStr = _buildSvgString(760, 340, d.days, d.planned, d.actual, d.projected, d.baseline, this._vis, (day) =>
      d.cal.idxToDate(day, d.startDate).toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit' }));

    // Tabla resumen: muestra puntos cada 10% aprox
    const step = Math.max(1, Math.floor(d.days.length / 10));
    const idxs = [];
    for (let i = 0; i < d.days.length; i += step) idxs.push(i);
    if (idxs[idxs.length-1] !== d.days.length-1) idxs.push(d.days.length-1);

    const cols = [
      { key: 'planned',   label: 'Planificado', show: this._vis.planned },
      { key: 'actual',    label: 'Real',         show: this._vis.actual },
      { key: 'projected', label: 'Proyectado',   show: this._vis.projected },
      { key: 'baseline',  label: 'Línea Base',   show: this._vis.baseline && !!d.baseline },
    ].filter(c => c.show);

    const tableHtml = `<table style="width:100%;border-collapse:collapse;font-size:11px;margin-top:16px">
      <thead><tr style="background:#f4f5f7">
        <th style="border:1px solid #ccc;padding:5px 8px;text-align:left">Fecha</th>
        ${cols.map(c => `<th style="border:1px solid #ccc;padding:5px 8px;text-align:center">${c.label}</th>`).join('')}
      </tr></thead>
      <tbody>${idxs.map((i, ri) => `<tr style="background:${ri%2===0?'#fff':'#f9f9f9'}">
        <td style="border:1px solid #ccc;padding:4px 8px">${fmtDate(d.days[i])}</td>
        ${cols.map(c => {
          const series = c.key === 'baseline' ? d.baseline : d[c.key];
          const v = series ? series[i] : null;
          return `<td style="border:1px solid #ccc;padding:4px 8px;text-align:center">${v != null ? v.toFixed(1)+'%' : '—'}</td>`;
        }).join('')}
      </tr>`).join('')}
      </tbody></table>`;

    const _proj = appState.state.project?.name ?? 'ECM Project';
    const _dt = new Date(), _dd = String(_dt.getDate()).padStart(2,'0'), _dmm = String(_dt.getMonth()+1).padStart(2,'0'), _dyy = _dt.getFullYear(), _dthh = String(_dt.getHours()).padStart(2,'0'), _dtmi = String(_dt.getMinutes()).padStart(2,'0');
    const _projEsc = _proj.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const _title = `${_proj}-Curva S-${_dd}${_dmm}${_dyy}`;
    const w = window.open('', '_blank', 'width=1100,height=880');
    if (!w) return;
    w.document.write(`<!DOCTYPE html><html><head>
      <meta charset="utf-8">
      ${FONTS_LINK}
      <title>${_title}</title>
      <style>
        *{box-sizing:border-box}
        body{font-family:Arial,sans-serif;margin:0;padding:0;background:#f1f5f9}
        .print-header,.print-footer{font-family:'Urbanist',system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
        .print-header{position:fixed;top:0;left:0;right:0;height:26px;display:none;align-items:center;justify-content:space-between;padding:0 10mm;border-bottom:0.5pt solid #CBD5E0;font-size:6pt;color:#4A5568;background:#fff;z-index:9999}
        .print-footer{position:fixed;bottom:0;left:0;right:0;height:22px;display:none;align-items:center;justify-content:space-between;padding:0 10mm;border-top:0.5pt solid #CBD5E0;font-size:6pt;color:#718096;background:#fff;z-index:9999}
        ${REPORT_TITLE_CSS}
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
        .a4{background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.4);padding:14mm 15mm;width:var(--pw,210mm);min-height:var(--ph,297mm);overflow:hidden}
        .tb select{font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;background:#fff;color:#374151}
        h1{font-size:18px;margin:0 0 8px}p{font-size:12px;color:#666;margin:0 0 12px}
        table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:5px 8px;font-size:11px}th{background:#f4f5f7;font-weight:600}
        svg{max-width:100%;height:auto}
        @media print{body{background:#fff}.tb{display:none!important}.pv{padding:0;min-height:0}.a4{box-shadow:none;width:100%;min-height:0;padding:1.5mm 0 0!important}.print-header,.print-footer{display:flex!important}@page{margin:10mm}}
        ${pageHfCss({ proj: _proj, date: `${_dd}-${_dmm}-${_dyy}, ${_dthh}:${_dtmi}` })}
  ${REPORT_FONT_CSS}
      </style>
    </head><body>
    <div class="tb">
      ${PAPER_SELECT_HTML}
      <span class="lbl">Orientaci&#243;n:</span>
      <button id="bp" class="act" onclick="setOri('portrait')">&#x1F4C4; Vertical</button>
      <button id="bl" onclick="setOri('landscape')">&#x1F5C2; Horizontal</button>
      <div class="sep"></div>
      <span class="lbl">&#x1F4C1; Archivo:</span>
      <input type="text" id="fn" value="${_title}.pdf" title="Nombre sugerido del archivo PDF" oninput="document.title=this.value.replace(/\\.pdf$/i,'')">
      <div class="sep"></div>
      <button onclick="window.close()">&#x2715; Cerrar</button>
      <button class="pri" style="margin-left:auto" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
    </div>
    <div class="pv">
      <div class="a4" id="a4">
<div class="print-header"><span>ECM Project V1.00.01</span><span>${_projEsc}</span><span>${_dd}-${_dmm}-${_dyy}, ${_dthh}:${_dtmi}</span></div>
<div class="print-footer"><span>By EHCM</span><span>&#8212;</span><span>P&aacute;gina <span id="phf-cur">1</span> de <span id="phf-tot">1</span></span></div>
<div class="print-title">Curva S de Avance</div>
<div class="print-subtitle">Curvas activas: ${cols.map(c => c.label).join(', ')}</div>
        ${svgStr}
        ${tableHtml}
      </div>
    </div>
    <script>
      (function(){function _u(){var h=document.getElementById('a4');if(!h)return;var t=Math.max(1,Math.ceil(h.scrollHeight/1120));var el=document.getElementById('phf-tot');if(el)el.textContent=t;}window.addEventListener('beforeprint',_u);_u();})();
      document.title=${JSON.stringify(_title)};
      ${PAPER_JS}
      var _ori='portrait';
      function setOri(o){
        if(o)_ori=o; o=_ori;
        var sz=paperSize(o), a=document.getElementById('a4');
        a.style.setProperty('--pw',sz[0]+'mm'); a.style.setProperty('--ph',sz[1]+'mm');
        a.classList.toggle('land',o==='landscape');
        document.getElementById('bp').classList.toggle('act',o==='portrait');
        document.getElementById('bl').classList.toggle('act',o==='landscape');
        var s=document.getElementById('_ps')||document.createElement('style');
        s.id='_ps';s.textContent='@page{size:'+sz[0]+'mm '+sz[1]+'mm}';document.head.appendChild(s);
      }
      setOri('portrait');
    <\/script>
    </body></html>`);
    w.document.close();
  }
}
