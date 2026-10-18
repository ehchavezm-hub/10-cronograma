// @ts-check
/**
 * resource-histogram.js — Histograma de Recursos
 * Estilo MS Project / Primavera P6 · Tema Bloomberg Dark
 */

import { appState }  from './state.js';
import { Calendar }  from './calendar.js';
import { getAll }    from './storage.js';

const CLR_BG        = '#111111';
const CLR_SURFACE   = '#1A1A1A';
const CLR_TEXT      = '#FFFFFF';
const CLR_DIM       = '#AAAAAA';
const CLR_ACCENT    = '#FFA028';
const CLR_OVER      = '#E53935';
const CLR_GRID      = '#333333';
const CLR_BORDER    = '#555555';

const PALETTE = [
  '#FFA028', '#4FC3F7', '#81C784', '#CE93D8',
  '#F06292', '#FFB74D', '#4DB6AC', '#7986CB',
  '#A1887F', '#90A4AE',
];

export class ResourceHistogramPanel {
  /** @param {HTMLElement} el */
  constructor(el) {
    this._el       = el;
    this._canvas   = null;
    this._ctx      = null;
    this._resObs   = null;
    this._groupBy  = 'week';
    this._filterRes = null;
    this._data     = null;
    this._build();
  }

  _build() {
    this._el.innerHTML = `
<div class="rh-wrap">
  <div class="rh-header">
    <div class="rh-title-area">
      <span class="rh-icon">📊</span>
      <div>
        <h2 class="rh-heading">Histograma de Recursos</h2>
        <p class="rh-meta">Carga de trabajo por período · Estilo MS Project / P6</p>
      </div>
    </div>
    <div class="rh-controls">
      <label class="rh-lbl" for="rh-groupby">Período</label>
      <select id="rh-groupby" class="rh-sel">
        <option value="week">Semana</option>
        <option value="month">Mes</option>
      </select>
      <label class="rh-lbl" for="rh-resource">Recurso</label>
      <select id="rh-resource" class="rh-sel">
        <option value="">Todos</option>
      </select>
    </div>
    <button id="btn-rh-close" class="rh-close" title="Cerrar histograma" aria-label="Cerrar histograma">✕</button>
  </div>
  <div id="rh-body" class="rh-body">
    <div id="rh-loading" class="rh-loading">
      <div class="rh-spinner"></div><span>Calculando histograma…</span>
    </div>
    <div id="rh-empty" class="rh-empty" style="display:none">
      <div class="rh-empty-icon">📋</div>
      <p class="rh-empty-msg">No hay recursos asignados en este proyecto.</p>
      <p class="rh-empty-hint">Asigne recursos a las actividades usando el botón <strong>👥 Recursos</strong> en la barra de filtros.</p>
    </div>
    <div id="rh-chart-wrap" class="rh-chart-wrap" style="display:none">
      <div id="rh-chart-area" class="rh-chart-area">
        <canvas id="rh-canvas" class="rh-canvas"></canvas>
      </div>
      <div id="rh-legend" class="rh-legend"></div>
    </div>
  </div>
</div>`;

    this._el.querySelector('#rh-groupby')?.addEventListener('change', (e) => {
      this._groupBy = /** @type {HTMLSelectElement} */ (e.target).value;
      this._render();
    });
    this._el.querySelector('#rh-resource')?.addEventListener('change', (e) => {
      this._filterRes = /** @type {HTMLSelectElement} */ (e.target).value || null;
      this._render();
    });
    this._el.querySelector('#btn-rh-close')?.addEventListener('click', () => {
      this._el.classList.remove('open');
      const btn = document.getElementById('btn-resource-histogram');
      if (btn) {
        btn.removeAttribute('aria-pressed');
        btn.style.background = '';
        btn.style.color      = '';
      }
    });

    // Resize observer — re-render when chart area size changes
    const chartArea = this._el.querySelector('#rh-chart-area');
    if (chartArea && window.ResizeObserver) {
      this._resObs = new ResizeObserver(() => { if (this._data) this._render(); });
      this._resObs.observe(chartArea);
    }
  }

  async refresh() {
    const loading  = /** @type {HTMLElement} */ (this._el.querySelector('#rh-loading'));
    const empty    = /** @type {HTMLElement} */ (this._el.querySelector('#rh-empty'));
    const chartWrap = /** @type {HTMLElement} */ (this._el.querySelector('#rh-chart-wrap'));

    if (loading)    { loading.style.display = 'flex';  loading.innerHTML = '<div class="rh-spinner"></div><span>Calculando histograma…</span>'; }
    if (empty)       empty.style.display    = 'none';
    if (chartWrap)   chartWrap.style.display = 'none';

    try {
      this._data = await this._computeData();
    } catch (err) {
      console.error('[ResourceHistogram]', err);
      if (loading) { loading.style.display = 'flex'; loading.textContent = 'Error al calcular histograma.'; }
      return;
    }

    if (loading) loading.style.display = 'none';

    if (!this._data || !this._data.resources.length) {
      if (empty) empty.style.display = 'flex';
      return;
    }

    this._populateResSelect(this._data.resources);
    if (chartWrap) chartWrap.style.display = 'flex';
    this._render();
  }

  _populateResSelect(resources) {
    const sel = /** @type {HTMLSelectElement|null} */ (this._el.querySelector('#rh-resource'));
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">Todos</option>';
    for (const r of resources) {
      const opt = document.createElement('option');
      opt.value       = r.id;
      opt.textContent = r.name;
      sel.appendChild(opt);
    }
    if (resources.some(r => r.id === cur)) sel.value = cur;
  }

  async _computeData() {
    const state   = appState.state;
    const cpm     = state.cpmResult;
    const project = state.project;
    const cal0    = state.calendar;

    if (!project || !cpm?.tasks) return null;

    const startDate   = new Date(project.start_date + 'T00:00:00');
    const cal         = new Calendar({
      work_week:  cal0?.work_week  ?? [1,2,3,4,5],
      exceptions: (cal0?.exceptions ?? []).map(
        ex => ({ on_date: ex.on_date, is_working: ex.is_working })
      ),
    });
    const hoursPerDay = cal0?.hours_per_day ?? 8;

    const [resources, allTaskRes] = await Promise.all([
      getAll('resources').then(r => r.filter(x => !x.deleted_at && x.type === 'work')),
      getAll('task_resources').then(r => r.filter(x => !x.deleted_at)),
    ]);

    if (!resources.length) return null;

    const resMap   = new Map(resources.map(r => [r.id, r]));
    const taskRes  = allTaskRes.filter(tr => resMap.has(tr.resource_id));
    if (!taskRes.length) return null;

    // Determine max working-day index needed
    let maxIdx = 0;
    for (const tr of taskRes) {
      const ct = cpm.tasks.get(tr.task_id);
      if (!ct) continue;
      if (ct.ef > maxIdx) maxIdx = ct.ef;
    }
    if (maxIdx <= 0) return null;

    // Build working-day-index → Date cache in O(maxIdx)
    const wdDates = _buildDateCache(cal, startDate, maxIdx);

    // Period helpers
    const _key = (/** @type {Date} */ d) => {
      if (this._groupBy === 'month') {
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      }
      const mon = _monday(d);
      return `${mon.getFullYear()}-W${String(_isoWeek(mon)).padStart(2,'0')}`;
    };
    const _label = (key, /** @type {Date} */ d) => {
      if (this._groupBy === 'month') {
        const [y,m] = key.split('-');
        const names = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
        return `${names[+m-1]} ${y}`;
      }
      const mon = _monday(d);
      return `${String(mon.getDate()).padStart(2,'0')}/${String(mon.getMonth()+1).padStart(2,'0')}`;
    };
    const _startOfPeriod = (/** @type {Date} */ d) => {
      if (this._groupBy === 'month') return new Date(d.getFullYear(), d.getMonth(), 1);
      return _monday(d);
    };

    /**
     * @type {Map<string, {
     *   label: string,
     *   sortKey: Date,
     *   byResource: Map<string, number>,
     *   daysSet: Set<string>
     * }>}
     */
    const buckets = new Map();

    for (const tr of taskRes) {
      const ct = cpm.tasks.get(tr.task_id);
      if (!ct || ct.es >= ct.ef) continue;
      const units     = tr.units ?? 100;
      const dailyHrs  = (units / 100) * hoursPerDay;
      const resId     = tr.resource_id;

      for (let idx = ct.es; idx < ct.ef; idx++) {
        const date = wdDates[idx];
        if (!date) continue;
        const k = _key(date);
        if (!buckets.has(k)) {
          buckets.set(k, {
            label:     _label(k, date),
            sortKey:   _startOfPeriod(date),
            byResource: new Map(),
            daysSet:   new Set(),
          });
        }
        const b = /** @type {NonNullable<ReturnType<typeof buckets.get>>} */ (buckets.get(k));
        b.byResource.set(resId, (b.byResource.get(resId) ?? 0) + dailyHrs);
        b.daysSet.add(_isoDate(date) + '|' + resId);
      }
    }

    if (!buckets.size) return null;

    // Sort periods chronologically
    const periods = [...buckets.entries()]
      .sort((a, b) => a[1].sortKey.getTime() - b[1].sortKey.getTime())
      .map(([key, val]) => ({ key, ...val }));

    return { resources, resMap, periods, hoursPerDay };
  }

  _render() {
    if (!this._data) return;
    const { resources, periods, hoursPerDay } = this._data;

    let activeRes = resources;
    if (this._filterRes) activeRes = resources.filter(r => r.id === this._filterRes);

    this._buildLegend(activeRes, resources);

    const chartArea = /** @type {HTMLElement|null} */ (this._el.querySelector('#rh-chart-area'));
    const canvas    = /** @type {HTMLCanvasElement|null} */ (this._el.querySelector('#rh-canvas'));
    if (!chartArea || !canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const W   = Math.max(chartArea.clientWidth,  400);
    const H   = Math.max(chartArea.clientHeight, 320);

    canvas.width        = W * dpr;
    canvas.height       = H * dpr;
    canvas.style.width  = W + 'px';
    canvas.style.height = H + 'px';

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Layout
    const PL = 56, PR = 16, PT = 28, PB = 52;
    const cW = W - PL - PR;
    const cH = H - PT - PB;

    // Find max stacked height
    let yMax = 0;
    for (const p of periods) {
      let total = 0;
      for (const r of activeRes) total += p.byResource.get(r.id) ?? 0;
      if (total > yMax) yMax = total;
    }
    yMax = _niceMax(yMax * 1.2 || 10);

    // Background
    ctx.fillStyle = CLR_BG;
    ctx.fillRect(0, 0, W, H);

    // Chart surface
    ctx.fillStyle = CLR_SURFACE;
    ctx.fillRect(PL, PT, cW, cH);

    // Grid + Y labels
    const STEPS = 5;
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= STEPS; i++) {
      const y = PT + cH - (i / STEPS) * cH;
      ctx.strokeStyle = CLR_GRID;
      ctx.lineWidth   = 0.5;
      ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL + cW, y); ctx.stroke();
      const val = (i / STEPS) * yMax;
      ctx.fillStyle  = CLR_DIM;
      ctx.font       = '10px Calibri,Arial';
      ctx.textAlign  = 'right';
      ctx.fillText(_fmt(val) + 'h', PL - 4, y);
    }

    if (!periods.length) {
      ctx.fillStyle = CLR_DIM; ctx.font = '13px Calibri,Arial'; ctx.textAlign = 'center';
      ctx.fillText('Sin datos en el período seleccionado', W / 2, H / 2);
      return;
    }

    // Bars
    const bGrpW = cW / periods.length;
    const bPad  = Math.max(1, bGrpW * 0.10);
    const bW    = Math.max(1, bGrpW - bPad * 2);

    for (let pi = 0; pi < periods.length; pi++) {
      const p  = periods[pi];
      const bx = PL + pi * bGrpW + bPad;
      let   by = PT + cH;

      for (const r of activeRes) {
        const hrs = p.byResource.get(r.id) ?? 0;
        if (hrs <= 0) continue;
        const bh = (hrs / yMax) * cH;
        const ci = resources.indexOf(r);
        ctx.fillStyle = PALETTE[ci % PALETTE.length];
        ctx.fillRect(bx, by - bh, bW, bh);
        by -= bh;
      }

      // X label
      ctx.fillStyle    = CLR_DIM;
      ctx.font         = '9px Calibri,Arial';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(p.label, PL + pi * bGrpW + bGrpW / 2, PT + cH + 5);
    }

    // Overallocation line — capacity per period
    if (activeRes.length > 0) {
      // Compute average working days per period from actual data
      const avgDays = periods.reduce((sum, p) => {
        const uniqueDays = new Set([...p.daysSet].map(s => s.split('|')[0]));
        return sum + uniqueDays.size;
      }, 0) / periods.length;
      const wdPerPeriod = Math.round(avgDays) || (this._groupBy === 'week' ? 5 : 22);

      const totalCapacity = activeRes.reduce(
        (sum, r) => sum + (r.max_units ?? 100) / 100 * hoursPerDay * wdPerPeriod,
        0
      );

      if (totalCapacity > 0 && totalCapacity <= yMax) {
        const lineY = PT + cH - (totalCapacity / yMax) * cH;
        ctx.strokeStyle = CLR_OVER;
        ctx.lineWidth   = 1.5;
        ctx.setLineDash([5, 4]);
        ctx.beginPath(); ctx.moveTo(PL, lineY); ctx.lineTo(PL + cW, lineY); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle    = CLR_OVER;
        ctx.font         = '10px Calibri,Arial';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText('Capacidad máx.', PL + 4, lineY - 2);
      }
    }

    // Axes
    ctx.strokeStyle = CLR_BORDER;
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(PL, PT); ctx.lineTo(PL, PT + cH); ctx.lineTo(PL + cW, PT + cH);
    ctx.stroke();

    // Y-axis title
    ctx.save();
    ctx.translate(12, PT + cH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle  = CLR_DIM;
    ctx.font       = '10px Calibri,Arial';
    ctx.textAlign  = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Horas', 0, 0);
    ctx.restore();
  }

  _buildLegend(activeRes, allRes) {
    const legend = this._el.querySelector('#rh-legend');
    if (!legend) return;
    legend.innerHTML = activeRes.map(r => {
      const ci    = allRes.indexOf(r);
      const color = PALETTE[ci % PALETTE.length];
      const over  = (r.max_units ?? 100);
      return `<div class="rh-leg-item">
        <span class="rh-leg-dot" style="background:${color}"></span>
        <span class="rh-leg-name">${_esc(r.name)}</span>
        <span class="rh-leg-cap">máx. ${over}%</span>
      </div>`;
    }).join('');
  }

  destroy() {
    this._resObs?.disconnect();
    this._resObs = null;
  }
}

// ---- Helpers ----

function _buildDateCache(cal, startDate, maxIdx) {
  const arr = new Array(maxIdx + 1);
  let d = cal.nextWorkingDay(new Date(startDate.getTime()));
  arr[0] = new Date(d.getTime());
  for (let i = 1; i <= maxIdx; i++) {
    d = new Date(d.getTime() + 86400000);
    while (!cal.isWorkingDay(d)) d = new Date(d.getTime() + 86400000);
    arr[i] = new Date(d.getTime());
  }
  return arr;
}

function _monday(date) {
  const d   = new Date(date.getTime());
  const day = d.getDay();
  const off = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + off);
  d.setHours(0, 0, 0, 0);
  return d;
}

function _isoWeek(monDate) {
  const d = new Date(Date.UTC(monDate.getFullYear(), monDate.getMonth(), monDate.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - y0.getTime()) / 86400000) + 1) / 7);
}

function _isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _niceMax(v) {
  if (v <= 0) return 10;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f   = v / exp;
  if (f <= 1) return exp;
  if (f <= 2) return 2  * exp;
  if (f <= 5) return 5  * exp;
  return 10 * exp;
}

function _fmt(v) {
  if (v >= 1000) return (v / 1000).toFixed(1) + 'k';
  return Math.round(v).toString();
}

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
