// @ts-check
/**
 * curva-s.js — Curva S de Avance (Planificado vs Real vs Proyectado).
 * Usa SVG para renderizar la curva acumulada de avance del proyecto.
 */

import { appState } from './state.js';
import { Calendar, isoToDate } from './calendar.js';

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

function _printToPdf(title, htmlContent) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; }
      h1 { font-size: 18px; margin-bottom: 16px; }
      @media print { body { margin: 0; } }
    </style>
  </head><body>${htmlContent}<script>window.print();window.close();<\/script></body></html>`);
  w.document.close();
}

export class CurvaSPanel {
  /** @param {HTMLElement} containerEl */
  constructor(containerEl) {
    this.el = containerEl;
    this._uid = Math.random().toString(36).slice(2, 8);
    this._build();
  }

  _build() {
    this.el.innerHTML = '';
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-ui)';

    const hdr = document.createElement('div');
    hdr.setAttribute('data-drag-handle', '');
    hdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--clr-border);flex-shrink:0';
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
    _printBtn.style.cssText = 'flex-shrink:0';
    _printBtn.addEventListener('click', () => {
      _printToPdf('Curva S de Avance', `<h1>Curva S de Avance</h1>${this._chartArea?.innerHTML ?? ''}`);
    });
    hdr.appendChild(_printBtn);
    this.el.appendChild(hdr);

    // Leyenda
    const legend = document.createElement('div');
    legend.style.cssText = 'display:flex;gap:16px;padding:8px 18px;flex-shrink:0;flex-wrap:wrap';
    legend.innerHTML = `
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--clr-text-2)">
        <div style="width:20px;height:3px;background:#1976D2;border-radius:2px"></div>Planificado</div>
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--clr-text-2)">
        <div style="width:20px;height:3px;background:#388E3C;border-radius:2px"></div>Real</div>
      <div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--clr-text-2)">
        <div style="width:20px;height:3px;background:#F57C00;border-radius:2px;border:none;background-image:repeating-linear-gradient(90deg,#F57C00 0,#F57C00 4px,transparent 4px,transparent 8px)"></div>Proyectado</div>`;
    this.el.appendChild(legend);

    this._chartArea = document.createElement('div');
    this._chartArea.style.cssText = 'flex:1;padding:8px 18px 18px;overflow:auto;min-height:0';
    this.el.appendChild(this._chartArea);

    this._ro = new ResizeObserver(() => this.refresh());
    this._ro.observe(this._chartArea);

    if (this.el.parentElement) _makeDraggable(this.el.parentElement, '[data-drag-handle]');
    this.refresh();
  }

  refresh() {
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

    // Construir series de datos — excluir resúmenes (type='summary' ó con hijos) e hitos
    const _parentIds = new Set([...tasks.values()].filter(t => !t.deleted_at && t.parent_id).map(t => t.parent_id));
    const taskArr = [...tasks.values()].filter(t => !t.deleted_at && t.type !== 'milestone' && t.type !== 'summary' && !_parentIds.has(t.id));
    if (!taskArr.length) {
      this._chartArea.innerHTML = '<p style="color:var(--clr-text-3);font-size:13px;padding:16px 0">No hay tareas para mostrar.</p>';
      return;
    }

    // Determinar rango de días
    let minDay = Infinity, maxDay = -Infinity;
    for (const t of taskArr) {
      const cpm = cpmResult.tasks?.get(t.id);
      if (!cpm) continue;
      minDay = Math.min(minDay, cpm.es);
      maxDay = Math.max(maxDay, cpm.ef);
    }
    if (!isFinite(minDay)) { this._chartArea.innerHTML = '<p style="color:var(--clr-text-3);font-size:13px">Sin datos CPM.</p>'; return; }

    const totalDays = maxDay - minDay;
    const step = Math.max(1, Math.ceil(totalDays / 50));  // max ~50 puntos
    const days = [];
    for (let d = minDay; d <= maxDay; d += step) days.push(d);
    if (days[days.length-1] !== maxDay) days.push(maxDay);

    const totalWeight = taskArr.reduce((s, t) => s + (t.dur || cpmResult.tasks?.get(t.id)?.dur || 1), 0);

    // Planificado: suma acumulada de días planificados hasta ese momento / total
    const planned = days.map(day => {
      let sum = 0;
      for (const t of taskArr) {
        const cpm = cpmResult.tasks?.get(t.id);
        if (!cpm) continue;
        const dur = cpm.ef - cpm.es || 1;
        const w = dur;
        if (cpm.ef <= day) sum += w;
        else if (cpm.es < day) sum += w * (day - cpm.es) / dur;
      }
      return (sum / totalWeight) * 100;
    });

    // Real: progreso ponderado por tiempo, no solo % instantáneo.
    // Tarea terminada (ef <= day): aporta w * pct.
    // Tarea en curso (es < day < ef): aporta w * pct * min(1, (day-es)/dur).
    const actual = days.map(day => {
      let sum = 0;
      for (const t of taskArr) {
        const cpm = cpmResult.tasks?.get(t.id);
        if (!cpm || cpm.es >= day) continue;
        const w = (cpm.ef - cpm.es) || 1;
        const pct = (t.percent_complete ?? 0) / 100;
        if (cpm.ef <= day) {
          sum += w * pct;
        } else {
          // tarea en curso: aportar proporcional al tiempo transcurrido
          const ratio = Math.min(1, (day - cpm.es) / w);
          sum += w * pct * ratio;
        }
      }
      return (sum / totalWeight) * 100;
    });

    // Proyectado: desde hoy, mantiene ritmo actual
    const today = new Date();
    today.setHours(0,0,0,0);
    let todayIdx = 0;
    {
      const d = new Date(startDate);
      while (d < today) {
        if (cal.isWorkingDay(d)) todayIdx++;
        d.setDate(d.getDate() + 1);
      }
    }
    const todayDayInRange = Math.max(minDay, Math.min(maxDay, todayIdx));
    const todayPos = days.findIndex(d => d >= todayDayInRange);
    const actualNow = todayPos >= 0 ? actual[todayPos] : actual[actual.length-1];
    const plannedNow = todayPos >= 0 ? planned[todayPos] : planned[planned.length-1];

    const projected = days.map((day, i) => {
      if (i <= (todayPos >= 0 ? todayPos : days.length-1)) return null;
      // Interpolar lineal desde punto actual
      const progress = (day - todayDayInRange) / Math.max(1, maxDay - todayDayInRange);
      return actualNow + (100 - actualNow) * progress;
    });

    this._renderSvg(days, planned, actual, projected, startDate, cal, minDay);
  }

  /**
   * @param {number[]} days
   * @param {number[]} planned
   * @param {number[]} actual
   * @param {(number|null)[]} projected
   * @param {Date} startDate
   * @param {Calendar} cal
   * @param {number} minDay
   */
  _renderSvg(days, planned, actual, projected, startDate, cal, minDay) {
    const W = this._chartArea.clientWidth || 600;
    const H = Math.max(200, Math.min(340, Math.round(W * 0.45)));
    const pad = { t: 12, r: 16, b: 38, l: 44 };
    const cw = W - pad.l - pad.r;
    const ch = H - pad.t - pad.b;

    const xOf = (i) => pad.l + (i / (days.length - 1)) * cw;
    const yOf = (v) => pad.t + ch - (v / 100) * ch;

    const pathLine = (series, filter = () => true) => {
      let d = '';
      for (let i = 0; i < series.length; i++) {
        const v = series[i];
        if (v === null || !filter(i)) continue;
        const x = xOf(i).toFixed(1);
        const y = yOf(v).toFixed(1);
        d += d ? `L${x},${y}` : `M${x},${y}`;
      }
      return d;
    };

    const fmtDate = (d) => cal.idxToDate(d, startDate).toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit' });

    // Etiquetas eje X — máximo ~6 etiquetas
    const xLabels = [];
    const step = Math.max(1, Math.floor(days.length / 6));
    for (let i = 0; i < days.length; i += step) xLabels.push(i);
    if (xLabels[xLabels.length-1] !== days.length-1) xLabels.push(days.length-1);

    // Etiquetas eje Y — 0%, 25%, 50%, 75%, 100%
    const yLabels = [0, 25, 50, 75, 100];

    // Área rellena planificado
    const areaPath = pathLine(planned) + `L${xOf(days.length-1).toFixed(1)},${yOf(0).toFixed(1)}L${xOf(0).toFixed(1)},${yOf(0).toFixed(1)}Z`;

    this._chartArea.innerHTML = `
      <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="overflow:visible;display:block">
        <defs>
          <linearGradient id="cs-grad-${this._uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#1976D2" stop-opacity="0.18"/>
            <stop offset="100%" stop-color="#1976D2" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        <!-- Fondo y cuadrícula -->
        <rect x="${pad.l}" y="${pad.t}" width="${cw}" height="${ch}" fill="var(--clr-surface-2,#f8f9fa)" rx="4"/>
        ${yLabels.map(v => `
          <line x1="${pad.l}" y1="${yOf(v).toFixed(1)}" x2="${pad.l+cw}" y2="${yOf(v).toFixed(1)}"
            stroke="var(--clr-border,#e0e0e0)" stroke-width="1" stroke-dasharray="3,3"/>
          <text x="${(pad.l-4).toFixed(1)}" y="${yOf(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle"
            font-size="10" fill="var(--clr-text-3,#999)">${v}%</text>`).join('')}
        ${xLabels.map(i => `
          <line x1="${xOf(i).toFixed(1)}" y1="${pad.t}" x2="${xOf(i).toFixed(1)}" y2="${pad.t+ch}"
            stroke="var(--clr-border,#e0e0e0)" stroke-width="1" stroke-dasharray="3,3"/>
          <text x="${xOf(i).toFixed(1)}" y="${(pad.t+ch+14).toFixed(1)}" text-anchor="middle"
            font-size="9" fill="var(--clr-text-3,#999)">${fmtDate(days[i])}</text>`).join('')}
        <!-- Área planificado -->
        <path d="${areaPath}" fill="url(#cs-grad-${this._uid})"/>
        <!-- Línea planificado -->
        <path d="${pathLine(planned)}" fill="none" stroke="#1976D2" stroke-width="2" stroke-linejoin="round"/>
        <!-- Línea real -->
        <path d="${pathLine(actual)}" fill="none" stroke="#388E3C" stroke-width="2.5" stroke-linejoin="round"/>
        <!-- Línea proyectado (punteado) -->
        <path d="${pathLine(projected, i => projected[i] !== null)}" fill="none" stroke="#F57C00"
          stroke-width="2" stroke-dasharray="6,4" stroke-linejoin="round"/>
        <!-- Ejes -->
        <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t+ch}" stroke="var(--clr-border,#ccc)" stroke-width="1.5"/>
        <line x1="${pad.l}" y1="${pad.t+ch}" x2="${pad.l+cw}" y2="${pad.t+ch}" stroke="var(--clr-border,#ccc)" stroke-width="1.5"/>
      </svg>`;
  }
}
