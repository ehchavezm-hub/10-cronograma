// @ts-check
/**
 * evm.js — Valor Ganado (EVM) + Curva S.
 *
 * Métricas estándar ANSI/PMI:
 *   BAC, PV, EV, AC, SV, CV, SPI, CPI, EAC, ETC, TCPI, VAC
 *
 * La curva S se genera por fecha calendario: para cada día desde
 * inicio del proyecto hasta el fin calculado se acumula PV(t), EV(t), AC(t).
 *
 * Panel DOM con:
 *   • Tarjetas KPI (BAC, SV, CV, SPI, CPI, EAC, VAC)
 *   • Canvas con la curva S
 *   • Tabla detalle por tarea
 */

import { appState }      from './state.js';
import { isoToDate, Calendar } from './calendar.js';

// ============================================================
// Cálculo de métricas EVM
// ============================================================

/**
 * @typedef {{
 *   bac:number, pv:number, ev:number, ac:number,
 *   sv:number, cv:number, spi:number, cpi:number,
 *   eac:number, etc:number, tcpi:number, vac:number,
 *   pctComplete:number,
 *   tasks: EvmTask[],
 *   curve: CurvePoint[],
 * }} EvmResult
 *
 * @typedef {{id:string, name:string, bac:number, pv:number, ev:number, ac:number, sv:number, cv:number, spi:number, cpi:number}} EvmTask
 * @typedef {{date:Date, pv:number, ev:number, ac:number}} CurvePoint
 */

/**
 * Calcula las métricas EVM a partir del estado actual.
 * @returns {EvmResult|null}
 */
export function calcEvm() {
  const { project, tasks, cpmResult, calendar, calExceptions } = appState.state;
  if (!project || !cpmResult) return null;

  const calDef = calendar
    ? { work_week: calendar.work_week,
        exceptions: calExceptions.filter(e => !e.deleted_at)
          .map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };
  const cal       = new Calendar(calDef);
  const startDate = isoToDate(project.start_date);
  const _hasDataDate = !!project.data_date;
  const dataDate  = _hasDataDate ? isoToDate(project.data_date) : new Date();

  const cpmTasks  = cpmResult.tasks;
  const allTasks  = [...tasks.values()].filter(t => !t.deleted_at && t.type !== 'milestone');

  // Detectar tareas hoja (no resumen)
  const parentSet = new Set(allTasks.filter(t => t.parent_id).map(t => t.parent_id));
  const leafTasks = allTasks.filter(t => !parentSet.has(t.id));

  let bac = 0, pv = 0, ev = 0, ac = 0;
  const evmTasks = [];

  for (const task of leafTasks) {
    const cpm = cpmTasks.get(task.id);
    const taskBac = task.planned_cost ?? 0;
    const taskAc  = task.actual_cost  ?? 0;
    const pct     = (task.percent_complete ?? 0) / 100;

    // EV = BAC × %completado
    const taskEv = taskBac * pct;

    // PV = porción del BAC que debería estar completada a la data date
    let taskPv = 0;
    if (cpm && cpm.es != null && cpm.ef != null && taskBac > 0) {
      const taskStart  = cal.idxToDate(cpm.es, startDate);
      const taskFinish = cal.finishDate(cpm.ef, startDate);
      const dur        = Math.max(1, cpm.ef - cpm.es);
      const elapsed    = _clamp(
        (dataDate - taskStart) / (taskFinish - taskStart),
        0, 1
      );
      taskPv = taskBac * elapsed;
    } else if (cpm && cpm.ef != null) {
      // Hito o sin costo — si ya pasó la data date: PV = BAC
      const taskFinish = cal.finishDate(cpm.ef, startDate);
      taskPv = dataDate >= taskFinish ? taskBac : 0;
    }

    bac += taskBac;
    pv  += taskPv;
    ev  += taskEv;
    ac  += taskAc;

    const tSv = taskEv - taskPv;
    const tCv = taskEv - taskAc;
    evmTasks.push({
      id:   task.id,
      name: task.name,
      bac:  taskBac,
      pv:   taskPv,
      ev:   taskEv,
      ac:   taskAc,
      sv:   tSv,
      cv:   tCv,
      spi:  taskPv > 0 ? taskEv / taskPv : (taskEv > 0 ? 1 : 0),
      cpi:  taskAc > 0 ? taskEv / taskAc : (taskEv > 0 ? 1 : 0),
    });
  }

  const sv  = ev - pv;
  const cv  = ev - ac;
  const spi = pv > 0 ? ev / pv : (ev > 0 ? 1 : 0);
  const cpi = ac > 0 ? ev / ac : (ev > 0 ? 1 : 0);
  const eac = cpi > 0 ? bac / cpi : bac;
  const etc = eac - ac;
  const vac = bac - eac;
  const tcpi = (bac - ev) > 0 ? (bac - ev) / (bac - ac) : (bac > ev ? Infinity : 1);
  const pctComplete = bac > 0 ? (ev / bac) * 100 : 0;

  // Curva S
  const curve = _buildCurve(leafTasks, cpmTasks, cal, startDate, bac);

  return { bac, pv, ev, ac, sv, cv, spi, cpi, eac, etc, tcpi, vac, pctComplete, tasks: evmTasks, curve, hasDataDate: _hasDataDate };
}

/**
 * Construye series temporales PV/EV/AC acumulados por semana.
 * @param {any[]} leafTasks
 * @param {Map<string,any>} cpmTasks
 * @param {Calendar} cal
 * @param {Date} startDate
 * @param {number} bac
 * @returns {CurvePoint[]}
 */
function _buildCurve(leafTasks, cpmTasks, cal, startDate, bac) {
  if (!leafTasks.length || bac === 0) return [];

  // Rango: desde inicio proyecto hasta EF máximo + buffer
  let maxEf = 0;
  for (const t of leafTasks) {
    const c = cpmTasks.get(t.id);
    if (c?.ef != null && c.ef > maxEf) maxEf = c.ef;
  }

  const endDate = cal.finishDate(maxEf + 5, startDate);
  return _rebuildCurve(leafTasks, cpmTasks, cal, startDate, endDate);
}

function _rebuildCurve(leafTasks, cpmTasks, cal, startDate, endDate) {
  const points = [];
  let d = new Date(startDate);

  while (d <= endDate) {
    let cumPv = 0, cumEv = 0, cumAc = 0;

    for (const task of leafTasks) {
      const cpm     = cpmTasks.get(task.id);
      const taskBac = task.planned_cost ?? 0;
      if (!cpm || cpm.es == null || cpm.ef == null || taskBac === 0) continue;

      const taskStart  = cal.idxToDate(cpm.es, startDate);
      const taskFinish = cal.finishDate(cpm.ef, startDate);
      const dur        = Math.max(1, taskFinish.getTime() - taskStart.getTime());
      const elapsedPv  = _clamp((d.getTime() - taskStart.getTime()) / dur, 0, 1);
      cumPv += taskBac * elapsedPv;

      if (d >= taskFinish) {
        cumEv += taskBac * (task.percent_complete ?? 0) / 100;
        cumAc += task.actual_cost ?? 0;
      }
    }

    points.push({ date: new Date(d), pv: cumPv, ev: cumEv, ac: cumAc });
    d = new Date(d.getTime() + 7 * 86400000);
  }
  return points;
}

function _clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

// ============================================================
// Panel EVM — DOM
// ============================================================

export class EvmPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    this._container = container;
    this._canvas    = null;
    this._result    = null;
    container.innerHTML = _buildPanelHtml();
    this._canvas = /** @type {HTMLCanvasElement} */ (container.querySelector('#evm-curve-canvas'));

    container.querySelector('#evm-data-date-save')?.addEventListener('click', () => {
      const inp = /** @type {HTMLInputElement|null} */ (container.querySelector('#evm-data-date-input'));
      const val = inp?.value;
      if (!val) return;
      appState.dispatch({ type: 'UPDATE_PROJECT', payload: { fields: { data_date: val } } });
      this.refresh();
    });
  }

  /** Recalcula y re-renderiza el panel. */
  refresh() {
    this._result = calcEvm();
    this._render();
  }

  _render() {
    const r = this._result;
    if (!r) {
      this._container.querySelector('#evm-no-data').style.display = '';
      this._container.querySelector('#evm-content').style.display = 'none';
      return;
    }
    this._container.querySelector('#evm-no-data').style.display = 'none';
    this._container.querySelector('#evm-content').style.display = '';
    const warnEl = this._container.querySelector('#evm-no-date-warn');
    if (warnEl) warnEl.style.display = r.hasDataDate ? 'none' : 'flex';

    // KPIs
    _setKpi(this._container, 'bac',  r.bac,  'currency');
    _setKpi(this._container, 'pv',   r.pv,   'currency');
    _setKpi(this._container, 'ev',   r.ev,   'currency');
    _setKpi(this._container, 'ac',   r.ac,   'currency');
    _setKpi(this._container, 'sv',   r.sv,   'currency', r.sv >= 0 ? 'good' : 'bad');
    _setKpi(this._container, 'cv',   r.cv,   'currency', r.cv >= 0 ? 'good' : 'bad');
    _setKpi(this._container, 'spi',  r.spi,  'index',    r.spi >= 1 ? 'good' : r.spi >= 0.9 ? 'warn' : 'bad');
    _setKpi(this._container, 'cpi',  r.cpi,  'index',    r.cpi >= 1 ? 'good' : r.cpi >= 0.9 ? 'warn' : 'bad');
    _setKpi(this._container, 'eac',  r.eac,  'currency');
    _setKpi(this._container, 'vac',  r.vac,  'currency', r.vac >= 0 ? 'good' : 'bad');
    _setKpi(this._container, 'tcpi', r.tcpi, 'index',    r.tcpi <= 1.1 ? 'good' : 'bad');
    _setKpi(this._container, 'pct',  r.pctComplete, 'pct');

    // Curva S
    if (this._canvas && r.curve.length > 1) {
      this._drawCurve(r.curve, r.bac);
    }

    // Tabla detalle
    this._renderTable(r.tasks);
  }

  _drawCurve(curve, bac) {
    const canvas = this._canvas;
    const dpr    = window.devicePixelRatio || 1;
    const W      = canvas.parentElement.clientWidth || 600;
    const H      = 220;
    canvas.width  = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const PAD = { t: 16, r: 24, b: 40, l: 56 };
    const cW  = W - PAD.l - PAD.r;
    const cH  = H - PAD.t - PAD.b;

    const maxVal = bac > 0 ? bac * 1.05 : 1;
    const n      = curve.length;
    const xStep  = cW / Math.max(n - 1, 1);

    const xOf  = (i) => PAD.l + i * xStep;
    const yOf  = (v) => PAD.t + cH - (v / maxVal) * cH;

    // Grid horizontal
    ctx.strokeStyle = '#E0E0E0';
    ctx.lineWidth   = 0.5;
    for (let g = 0; g <= 4; g++) {
      const y = PAD.t + (cH * g / 4);
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
      // Label
      const val = maxVal * (1 - g / 4);
      ctx.fillStyle = '#9E9E9E';
      ctx.font      = '10px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(_fmtK(val), PAD.l - 4, y + 4);
    }

    // Labels eje X (cada ~6 puntos)
    const step = Math.max(1, Math.floor(n / 6));
    ctx.fillStyle = '#9E9E9E';
    ctx.font      = '10px system-ui';
    ctx.textAlign = 'center';
    for (let i = 0; i < n; i += step) {
      const x = xOf(i);
      const d = curve[i].date;
      ctx.fillText(`${d.getDate()}/${d.getMonth() + 1}`, x, H - PAD.b + 14);
    }

    // Líneas PV / EV / AC
    const lines = [
      { key: 'pv', color: '#1976D2', label: 'PV' },
      { key: 'ev', color: '#388E3C', label: 'EV' },
      { key: 'ac', color: '#F57C00', label: 'AC' },
    ];

    for (const { key, color } of lines) {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      curve.forEach((pt, i) => {
        const x = xOf(i);
        const y = yOf(pt[key]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Leyenda
    const LX = PAD.l + 4, LY = PAD.t + 4;
    lines.forEach(({ color, label }, i) => {
      const lx = LX + i * 64;
      ctx.fillStyle   = color;
      ctx.fillRect(lx, LY, 16, 3);
      ctx.fillStyle   = '#616161';
      ctx.font        = '11px system-ui';
      ctx.textAlign   = 'left';
      ctx.fillText(label, lx + 20, LY + 7);
    });
  }

  _renderTable(tasks) {
    const tbody = this._container.querySelector('#evm-detail-tbody');
    if (!tbody) return;
    if (!tasks.length) { tbody.innerHTML = '<tr class="evm-empty-row"><td colspan="9">Sin tareas con costo</td></tr>'; return; }

    tbody.innerHTML = tasks.map(t => `
      <tr>
        <td title="${_esc(t.id)}">${_esc(t.name)}</td>
        <td class="num">${_fmtC(t.bac)}</td>
        <td class="num">${_fmtC(t.pv)}</td>
        <td class="num">${_fmtC(t.ev)}</td>
        <td class="num">${_fmtC(t.ac)}</td>
        <td class="num ${t.sv >= 0 ? 'evm-good' : 'evm-bad'}">${_fmtC(t.sv)}</td>
        <td class="num ${t.cv >= 0 ? 'evm-good' : 'evm-bad'}">${_fmtC(t.cv)}</td>
        <td class="num ${t.spi >= 1 ? 'evm-good' : t.spi >= 0.9 ? 'evm-warn' : 'evm-bad'}">${isFinite(t.spi) ? t.spi.toFixed(2) : 'N/A'}</td>
        <td class="num ${t.cpi >= 1 ? 'evm-good' : t.cpi >= 0.9 ? 'evm-warn' : 'evm-bad'}">${isFinite(t.cpi) ? t.cpi.toFixed(2) : 'N/A'}</td>
      </tr>`).join('');
  }
}

// ============================================================
// Helpers DOM
// ============================================================

function _setKpi(container, key, val, fmt, cls = '') {
  const el = container.querySelector(`[data-kpi="${key}"]`);
  if (!el) return;
  el.textContent = fmt === 'currency' ? _fmtC(val)
    : fmt === 'index'  ? (isFinite(val) ? val.toFixed(2) : 'N/A')
    : fmt === 'pct'    ? val.toFixed(1) + '%'
    : String(val);
  el.className = 'kpi-value ' + cls;
}

function _fmtC(v) {
  if (v == null || !isFinite(v)) return '—';
  return new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN', maximumFractionDigits: 0 }).format(v);
}

function _fmtK(v) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return v.toFixed(0);
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _buildPanelHtml() {
  return `
<div class="evm-header">
  <h2 class="evm-title">📈 Valor Ganado (EVM)</h2>
  <button class="btn btn-ghost btn-sm no-print" id="btn-evm-close" aria-label="Cerrar panel EVM">✕</button>
</div>
<div id="evm-no-data" style="display:none;padding:32px;text-align:center;color:var(--clr-text-3)">
  No hay datos de CPM disponibles. Espere que se complete el cálculo.
</div>
<div id="evm-no-date-warn" style="display:none;padding:6px 16px;background:var(--clr-warn-bg,#fff3cd);color:var(--clr-warn-text,#856404);font-size:12px;border-bottom:1px solid var(--clr-warn-border,#ffc107);align-items:center;gap:8px;flex-wrap:wrap">
  <span>⚠️ El proyecto no tiene <strong>Fecha de datos</strong> configurada. PV se calcula con la fecha actual.</span>
  <label style="display:flex;align-items:center;gap:4px;margin-left:auto">
    <span>Establecer fecha:</span>
    <input id="evm-data-date-input" type="date" style="font-size:11px;padding:2px 4px;border:1px solid var(--clr-warn-border,#ffc107);border-radius:3px;background:var(--clr-surface,#fff);color:var(--clr-text,#333)">
    <button id="evm-data-date-save" style="font-size:11px;padding:2px 8px;background:var(--clr-warn-text,#856404);color:#fff;border:none;border-radius:3px;cursor:pointer">Guardar</button>
  </label>
</div>
<div id="evm-content">
  <!-- KPIs principales -->
  <div class="evm-kpi-grid">
    ${_kpiCard('BAC',  'bac',  'Presupuesto hasta conclusión')}
    ${_kpiCard('PV',   'pv',   'Valor planificado (a la fecha de datos)')}
    ${_kpiCard('EV',   'ev',   'Valor ganado')}
    ${_kpiCard('AC',   'ac',   'Costo real')}
    ${_kpiCard('SV',   'sv',   'Variación de cronograma (EV−PV)')}
    ${_kpiCard('CV',   'cv',   'Variación de costo (EV−AC)')}
    ${_kpiCard('SPI',  'spi',  'Índice de rendimiento del cronograma')}
    ${_kpiCard('CPI',  'cpi',  'Índice de rendimiento del costo')}
    ${_kpiCard('EAC',  'eac',  'Estimado a la conclusión')}
    ${_kpiCard('VAC',  'vac',  'Variación a la conclusión')}
    ${_kpiCard('TCPI', 'tcpi', 'Índice de rendimiento para completar')}
    ${_kpiCard('%',    'pct',  '% completado por costo')}
  </div>

  <!-- Curva S -->
  <div class="evm-section">
    <div class="evm-section-title">Curva S — PV / EV / AC acumulados</div>
    <div class="evm-curve-wrap">
      <canvas id="evm-curve-canvas"></canvas>
    </div>
  </div>

  <!-- Tabla detalle -->
  <div class="evm-section">
    <div class="evm-section-title">Detalle por actividad</div>
    <div class="evm-table-wrap">
      <table class="evm-table">
        <thead>
          <tr>
            <th>Actividad</th>
            <th class="num">BAC</th>
            <th class="num">PV</th>
            <th class="num">EV</th>
            <th class="num">AC</th>
            <th class="num">SV</th>
            <th class="num">CV</th>
            <th class="num">SPI</th>
            <th class="num">CPI</th>
          </tr>
        </thead>
        <tbody id="evm-detail-tbody"></tbody>
      </table>
    </div>
  </div>
</div>`;
}

function _kpiCard(label, key, title) {
  return `
  <div class="kpi-card" title="${_esc(title)}">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value" data-kpi="${key}">—</div>
  </div>`;
}
