// @ts-check
/**
 * monte-carlo.js — Análisis de riesgo de cronograma via simulación Monte Carlo.
 * Ejecuta N iteraciones en un Web Worker, muestreando duraciones con distribución PERT.
 */

import { fmtDate, isoToDate, DEFAULT_CALENDAR } from './calendar.js';

const WORKER_PATH = './js/workers/monte-carlo.worker.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Convierte un índice de día laborable a Date usando el calendario del proyecto.
 * @param {number} idx
 * @param {import('./calendar.js').Calendar} calendar
 * @param {Date} projectStart
 * @returns {Date}
 */
function idxToDate(idx, calendar, projectStart) {
  return calendar.idxToDate(idx, projectStart);
}

// ─── Clase principal ──────────────────────────────────────────────────────────

export class MonteCarloPanel {
  /**
   * @param {HTMLElement} containerEl  Elemento DOM donde se renderiza el panel
   */
  constructor(containerEl) {
    /** @type {HTMLElement} */
    this.el = containerEl;
    /** @type {Worker|null} */
    this._worker = null;
    /** @type {object|null} cpmResult actual */
    this._cpmResult = null;
    /** @type {Map<string,object>} tasks actuales */
    this._tasks = new Map();
    /** @type {object|null} last simulation result */
    this._lastResult = null;
    /** @type {boolean} */
    this._visible = false;
    /** @type {HTMLInputElement|null} */
    this._itersInput = null;
    /** @type {string|null} */
    this._projectId = null;
    /** @type {object|null} */
    this._project = null;
    /** @type {import('./calendar.js').Calendar|null} */
    this._calendar = null;

    this._buildUI();
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  _buildUI() {
    this.el.innerHTML = '';
    this.el.className = 'mc-panel';

    // Caja informativa teórica — colapsable
    const infoBox = document.createElement('details');
    infoBox.className = 'mc-info-box';
    infoBox.innerHTML = `<summary class="mc-info-summary">ℹ️ ¿Qué es el Análisis de Monte Carlo?</summary>
      <div class="mc-info-body">
        <p>El <strong>Análisis de Monte Carlo</strong> es una técnica estadística que simula miles de escenarios posibles del proyecto variando aleatoriamente la duración de cada tarea dentro de sus rangos de incertidumbre (optimista, más probable y pesimista).</p>
        <p><strong>¿Cómo funciona?</strong></p>
        <ul>
          <li>Cada iteración sortea duraciones aleatorias para todas las tareas usando la distribución PERT.</li>
          <li>Se calcula la duración total del proyecto para ese escenario.</li>
          <li>Tras miles de iteraciones se obtiene la distribución de probabilidad de la fecha de finalización.</li>
        </ul>
        <p><strong>Percentiles:</strong> P50 = hay 50% de probabilidad de terminar en esa fecha o antes. P80 y P90 son los valores recomendados para contratos y buffers de contingencia.</p>
        <p><em>Si las tareas no tienen estimaciones de tres puntos, se aplica una variación estándar del ±10% sobre la duración determinista.</em></p>
      </div>`;
    this.el.appendChild(infoBox);

    // Formulario de control
    const form = document.createElement('div');
    form.className = 'mc-form';

    // Selector de iteraciones
    const itersLabel = document.createElement('label');
    itersLabel.className = 'mc-label';
    itersLabel.textContent = 'Iteraciones:';

    this._itersSelect = document.createElement('select');
    this._itersSelect.className = 'mc-select';
    for (const n of [1000, 3000, 5000, 10000]) {
      const opt = document.createElement('option');
      opt.value = String(n);
      opt.textContent = n.toLocaleString();
      if (n === 1000) opt.selected = true;
      this._itersSelect.appendChild(opt);
    }
    itersLabel.appendChild(this._itersSelect);
    form.appendChild(itersLabel);

    // Input personalizado de iteraciones
    const customLabel = document.createElement('label');
    customLabel.className = 'mc-label';
    customLabel.title = 'O ingresa un número personalizado (100 – 50,000)';
    const customSpan = document.createElement('span');
    customSpan.textContent = 'o ingresa:';
    this._itersInput = document.createElement('input');
    this._itersInput.type = 'number';
    this._itersInput.className = 'mc-iters-input';
    this._itersInput.min = '100';
    this._itersInput.max = '50000';
    this._itersInput.step = '100';
    this._itersInput.placeholder = 'ej: 2000';
    this._itersInput.setAttribute('aria-label', 'Número personalizado de iteraciones');
    customLabel.appendChild(customSpan);
    customLabel.appendChild(this._itersInput);
    form.appendChild(customLabel);

    // Botón ejecutar
    this._runBtn = document.createElement('button');
    this._runBtn.className = 'mc-run-btn';
    this._runBtn.textContent = 'Ejecutar';
    this._runBtn.addEventListener('click', () => this._runSimulation());
    form.appendChild(this._runBtn);

    this.el.appendChild(form);

    // Barra de progreso (oculta por defecto)
    this._progressWrap = document.createElement('div');
    this._progressWrap.className = 'mc-progress-wrap mc-hidden';
    this._progressBar = document.createElement('div');
    this._progressBar.className = 'mc-progress-bar';
    this._progressBar.style.width = '0%';
    this._progressWrap.appendChild(this._progressBar);
    this._progressLabel = document.createElement('span');
    this._progressLabel.className = 'mc-progress-label';
    this._progressLabel.textContent = '0%';
    this._progressWrap.appendChild(this._progressLabel);
    this.el.appendChild(this._progressWrap);

    // Área de resultados
    this._resultsArea = document.createElement('div');
    this._resultsArea.className = 'mc-results';
    this.el.appendChild(this._resultsArea);

    // Inyectar estilos si no existen
    if (!document.getElementById('mc-styles')) {
      const style = document.createElement('style');
      style.id = 'mc-styles';
      style.textContent = MC_CSS;
      document.head.appendChild(style);
    }
  }

  // ─── API pública ───────────────────────────────────────────────────────────

  /**
   * Actualiza el panel con un nuevo resultado CPM y lista de tareas.
   * @param {object|null} cpmResult
   * @param {Map<string,object>} tasks
   */
  onCpmUpdate(cpmResult, tasks, project, calendar) {
    this._cpmResult = cpmResult;
    this._tasks = tasks;
    this._project = project ?? null;
    this._calendar = calendar ?? null;
    // Limpiar resultado anterior si los datos cambiaron
    if (this._lastResult) {
      this._lastResult = null;
      this._resultsArea.innerHTML = '<p class="mc-stale">Datos del proyecto actualizados. Vuelva a ejecutar la simulación.</p>';
    }
  }

  /**
   * Carga el estado del proyecto por ID (para uso futuro con storage).
   * @param {string} projectId
   */
  async refresh(projectId) {
    this._projectId = projectId;
  }

  /**
   * Muestra u oculta el panel.
   * @param {boolean} v
   */
  setVisible(v) {
    this._visible = v;
    this.el.style.display = v ? '' : 'none';
  }

  // ─── Simulación ────────────────────────────────────────────────────────────

  async _runSimulation() {
    if (!this._cpmResult || !this._tasks || this._tasks.size === 0) {
      this._showError('No hay datos CPM disponibles. Calcule el cronograma primero.');
      return;
    }

    const customVal = this._itersInput ? parseInt(this._itersInput.value, 10) : NaN;
    const iterations = (!isNaN(customVal) && customVal >= 100 && customVal <= 50000)
      ? customVal
      : parseInt(this._itersSelect.value, 10);

    // Preparar datos para el worker
    const tasksArr = [];
    for (const [, task] of this._tasks) {
      if (task.deleted_at) continue;
      const cpmTask = this._cpmResult.tasks?.get(task.id);
      if (!cpmTask) continue;

      // Three-point estimates (campos opcionales en la tarea)
      let three_point = null;
      const o = task.optimistic_dur;
      const m = task.most_likely_dur;
      const p = task.pessimistic_dur;
      if (o != null && m != null && p != null) {
        three_point = { optimistic: o, most_likely: m, pessimistic: p };
      }

      tasksArr.push({
        id: task.id,
        es: cpmTask.es ?? 0,
        ef: cpmTask.ef ?? (cpmTask.es ?? 0) + (task.duration_days ?? 0),
        dur: task.duration_days ?? 0,
        is_critical: cpmTask.is_critical ?? false,
        three_point,
      });
    }

    if (tasksArr.length === 0) {
      this._showError('No hay tareas con datos CPM calculados.');
      return;
    }

    // Dependencias
    const depsArr = [];
    if (this._cpmResult.deps) {
      for (const dep of this._cpmResult.deps) {
        depsArr.push({
          predecessor_id: dep.pred_id ?? dep.predecessor_id,
          successor_id: dep.succ_id ?? dep.successor_id,
          type: dep.type ?? 'FS',
          lag: dep.lag_days ?? dep.lag ?? 0,
        });
      }
    }

    // Calendario
    const calendar_def = { work_week: [1, 2, 3, 4, 5], exceptions: [] };
    if (this._cpmResult.calendarDef) {
      Object.assign(calendar_def, this._cpmResult.calendarDef);
    }

    // Mostrar progreso, deshabilitar botón
    this._runBtn.disabled = true;
    this._runBtn.textContent = 'Ejecutando…';
    this._progressWrap.classList.remove('mc-hidden');
    this._setProgress(0);
    this._resultsArea.innerHTML = '';

    // Terminar worker anterior si existe
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }

    try {
      await new Promise((resolve, reject) => {
        const worker = new Worker(WORKER_PATH);
        this._worker = worker;

        worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === 'progress') {
            this._setProgress(msg.percent);
          } else if (msg.type === 'result') {
            this._worker = null;
            worker.terminate();
            this._lastResult = msg;
            this._renderResults(msg);
            resolve(undefined);
          }
        };

        worker.onerror = (err) => {
          this._worker = null;
          worker.terminate();
          reject(new Error(err.message || 'Worker error'));
        };

        worker.postMessage({
          tasks: tasksArr,
          deps: depsArr,
          calendar_def,
          iterations,
          seed: Date.now(),
        });
      });
    } catch (err) {
      this._showError('Error en la simulación: ' + (err.message || err));
    } finally {
      this._runBtn.disabled = false;
      this._runBtn.textContent = 'Ejecutar';
      this._progressWrap.classList.add('mc-hidden');
    }
  }

  // ─── Render resultados ─────────────────────────────────────────────────────

  /**
   * @param {object} result  resultado del worker
   */
  _renderResults(result) {
    const area = this._resultsArea;
    area.innerHTML = '';

    // Obtener inicio del proyecto para convertir índices a fechas
    const projectStart = this._getProjectStart();
    const calendar = this._getCalendar();

    /**
     * Convierte índice → fecha formateada dd/mm/yyyy
     * @param {number} idx
     * @returns {string}
     */
    const idxFmt = (idx) => {
      if (!projectStart || !calendar) return String(Math.round(idx));
      try {
        const d = idxToDate(Math.round(idx), calendar, projectStart);
        return fmtDate(d);
      } catch {
        return String(Math.round(idx));
      }
    };

    // ── Sección: fechas de finalización del proyecto ───────────────────────
    const projSection = document.createElement('div');
    projSection.className = 'mc-section';

    const projTitle = document.createElement('h3');
    projTitle.className = 'mc-section-title';
    projTitle.textContent = 'Fecha de Finalización del Proyecto';
    projSection.appendChild(projTitle);

    const projGrid = document.createElement('div');
    projGrid.className = 'mc-kpi-grid';
    for (const [label, val] of [
      ['P50', result.project_p50],
      ['P80', result.project_p80],
      ['P90', result.project_p90],
    ]) {
      const card = document.createElement('div');
      card.className = 'mc-kpi-card';
      const lbl = document.createElement('span');
      lbl.className = 'mc-kpi-label';
      lbl.textContent = label;
      const num = document.createElement('span');
      num.className = 'mc-kpi-value';
      num.textContent = idxFmt(val);
      card.appendChild(lbl);
      card.appendChild(num);
      projGrid.appendChild(card);
    }
    projSection.appendChild(projGrid);
    area.appendChild(projSection);

    // ── Histograma de finalización del proyecto ────────────────────────────
    if (result.project_finishes && result.project_finishes.length > 0) {
      const histSection = document.createElement('div');
      histSection.className = 'mc-section';
      const histTitle = document.createElement('h3');
      histTitle.className = 'mc-section-title';
      histTitle.textContent = 'Histograma de fechas de término';
      histSection.appendChild(histTitle);
      histSection.appendChild(this._buildHistogram(result.project_finishes, result.project_p80, idxFmt));
      area.appendChild(histSection);
    }

    // ── Curva S de probabilidad de cumplimiento ───────────────────────────
    if (result.project_finishes && result.project_finishes.length > 0) {
      const scurveSection = document.createElement('div');
      scurveSection.className = 'mc-section';
      const scurveTitle = document.createElement('h3');
      scurveTitle.className = 'mc-section-title';
      scurveTitle.textContent = 'Curva S de probabilidad de cumplimiento';
      scurveSection.appendChild(scurveTitle);
      scurveSection.appendChild(this._buildSCurve(
        result.project_finishes, result.project_p50, result.project_p80, result.project_p90, idxFmt));
      area.appendChild(scurveSection);
    }

    // ── Tornado chart de sensibilidad ─────────────────────────────────────
    if (result.results && result.results.length > 0) {
      const tornSection = document.createElement('div');
      tornSection.className = 'mc-section';
      const tornTitle = document.createElement('h3');
      tornTitle.className = 'mc-section-title';
      tornTitle.textContent = 'Tornado: sensibilidad de tareas (Top 10 por σ)';
      tornSection.appendChild(tornTitle);
      tornSection.appendChild(this._buildTornado(result.results));
      area.appendChild(tornSection);
    }

    // ── Diagrama de dispersión (timeline vs incertidumbre) ────────────────
    if (result.results && result.results.length > 1) {
      const scatSection = document.createElement('div');
      scatSection.className = 'mc-section';
      const scatTitle = document.createElement('h3');
      scatTitle.className = 'mc-section-title';
      scatTitle.textContent = 'Dispersión: cronograma vs incertidumbre por tarea';
      scatSection.appendChild(scatTitle);
      scatSection.appendChild(this._buildScatter(result.results));
      area.appendChild(scatSection);
    }

    // ── Tabla resumen por percentil (tareas ruta crítica) ─────────────────
    if (result.results && result.results.length > 0) {
      const ptSection = document.createElement('div');
      ptSection.className = 'mc-section';
      const ptTitle = document.createElement('h3');
      ptTitle.className = 'mc-section-title';
      ptTitle.textContent = 'Tabla resumen por percentil (ruta crítica)';
      ptSection.appendChild(ptTitle);
      ptSection.appendChild(this._buildPercentileTable(result.results, idxFmt));
      area.appendChild(ptSection);
    }

    // ── Tabla: top 10 tareas más riesgosas (spread P80-P50) ───────────────
    if (result.results && result.results.length > 0) {
      const riskSection = document.createElement('div');
      riskSection.className = 'mc-section';
      const riskTitle = document.createElement('h3');
      riskTitle.className = 'mc-section-title';
      riskTitle.textContent = 'Top 10 Tareas con Mayor Incertidumbre (spread P80−P50)';
      riskSection.appendChild(riskTitle);

      // Filtrar tareas que tienen three_point, ordenar por spread
      const withSpread = result.results
        .map(r => ({
          ...r,
          spread: r.p80 - r.p50,
          name: this._getTaskName(r.id),
        }))
        .filter(r => r.spread > 0)
        .sort((a, b) => b.spread - a.spread)
        .slice(0, 10);

      if (withSpread.length === 0) {
        const msg = document.createElement('p');
        msg.className = 'mc-note';
        msg.textContent = 'No hay tareas con estimados de tres puntos configurados.';
        riskSection.appendChild(msg);
      } else {
        const table = document.createElement('table');
        table.className = 'mc-risk-table';
        table.innerHTML = `
          <thead>
            <tr>
              <th>Tarea</th>
              <th>P50</th>
              <th>P80</th>
              <th>Spread (días)</th>
            </tr>
          </thead>`;
        const tbody = document.createElement('tbody');
        for (const r of withSpread) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td class="mc-task-name">${_esc(r.name)}</td>
            <td>${idxFmt(r.p50)}</td>
            <td>${idxFmt(r.p80)}</td>
            <td class="mc-spread">${r.spread.toFixed(1)}</td>`;
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        riskSection.appendChild(table);
      }

      area.appendChild(riskSection);
    }
  }

  // ─── Curva S SVG ──────────────────────────────────────────────────────────

  /**
   * Curva S de probabilidad acumulada de finalización.
   * @param {number[]} sorted  valores ordenados (project_finishes)
   * @param {number} p50
   * @param {number} p80
   * @param {number} p90
   * @param {(idx:number)=>string} fmt
   * @returns {SVGElement}
   */
  _buildSCurve(sorted, p50, p80, p90, fmt) {
    const W = Math.max(300, (this._resultsArea?.clientWidth || 700) - 32);
    const H = Math.max(140, Math.round(W * 0.32));
    const PAD = { top: 14, right: 16, bottom: 32, left: 38 };
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    const n = sorted.length;
    const min = sorted[0];
    const max = sorted[n - 1];
    const range = max - min || 1;

    // Calcular std para rango de display de la curva S
    const _sm = sorted.reduce((s, v) => s + v, 0) / n;
    const _sv = sorted.reduce((s, v) => s + (v - _sm) ** 2, 0) / n;
    const _ss = Math.max(Math.sqrt(_sv), 2);
    const dispMin = Math.min(min, _sm - 3 * _ss);
    const dispMax = Math.max(max, _sm + 3 * _ss);
    const dispRange = Math.max(dispMax - dispMin, 10);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('class', 'mc-histogram');

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${PAD.left},${PAD.top})`);
    svg.appendChild(g);

    // Y grid lines + labels
    for (const pct of [0, 25, 50, 75, 100]) {
      const y = ih * (1 - pct / 100);
      const gl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      gl.setAttribute('x1', '0'); gl.setAttribute('y1', String(y));
      gl.setAttribute('x2', String(iw)); gl.setAttribute('y2', String(y));
      gl.setAttribute('class', 'mc-hist-axis'); gl.setAttribute('opacity', '0.25');
      g.appendChild(gl);
      const tl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tl.setAttribute('x', '-3'); tl.setAttribute('y', String(y));
      tl.setAttribute('text-anchor', 'end'); tl.setAttribute('dominant-baseline', 'middle');
      tl.setAttribute('class', 'mc-hist-tick');
      tl.textContent = pct + '%';
      g.appendChild(tl);
    }

    // S-curve polyline (sample CDF)
    const STEPS = Math.min(n, 300);
    let pathD = '';
    for (let i = 0; i <= STEPS; i++) {
      const frac = i / STEPS;
      const val = sorted[Math.min(Math.floor(frac * n), n - 1)];
      const x = ((val - dispMin) / dispRange) * iw;
      const y = ih * (1 - frac);
      pathD += i === 0 ? `M${x.toFixed(1)},${y.toFixed(1)}` : ` L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    const curvePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    curvePath.setAttribute('d', pathD);
    curvePath.setAttribute('fill', 'none');
    curvePath.setAttribute('stroke', 'var(--mc-accent, #2563eb)');
    curvePath.setAttribute('stroke-width', '2');
    curvePath.setAttribute('stroke-linejoin', 'round');
    g.appendChild(curvePath);

    // P50 / P80 / P90 vertical lines
    const pLines = [['P50', p50, '#16a34a'], ['P80', p80, '#dc2626'], ['P90', p90, '#7c3aed']];
    pLines.forEach(([label, val, color], li) => {
      const vx = ((val - dispMin) / dispRange) * iw;
      if (vx < 0 || vx > iw) return;
      const vl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      vl.setAttribute('x1', String(vx)); vl.setAttribute('y1', '0');
      vl.setAttribute('x2', String(vx)); vl.setAttribute('y2', String(ih));
      vl.setAttribute('stroke', color); vl.setAttribute('stroke-width', '1.5');
      vl.setAttribute('stroke-dasharray', '4 2');
      g.appendChild(vl);
      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', String(vx + 3)); lbl.setAttribute('y', String(8 + li * 12));
      lbl.setAttribute('fill', color); lbl.setAttribute('font-size', '10');
      lbl.setAttribute('font-weight', 'bold');
      lbl.textContent = label;
      g.appendChild(lbl);
    });

    // X axis
    const axG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    axG.setAttribute('transform', `translate(0,${ih})`);
    const axLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    axLine.setAttribute('x1', '0'); axLine.setAttribute('y1', '0');
    axLine.setAttribute('x2', String(iw)); axLine.setAttribute('y2', '0');
    axLine.setAttribute('class', 'mc-hist-axis');
    axG.appendChild(axLine);
    [[0, dispMin], [iw, dispMax]].forEach(([pos, val]) => {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', String(pos)); t.setAttribute('y', '14');
      t.setAttribute('text-anchor', pos === 0 ? 'start' : 'end');
      t.setAttribute('class', 'mc-hist-tick');
      t.textContent = fmt(val);
      axG.appendChild(t);
    });
    g.appendChild(axG);

    return /** @type {any} */ (svg);
  }

  // ─── Tornado chart SVG ────────────────────────────────────────────────────

  /**
   * Tornado chart: top 10 tareas por sensibilidad (correlación con fin del proyecto).
   * @param {Array<{id:string,std:number,mean:number,p50:number,p80:number,p90:number,sensitivity?:number}>} results
   * @returns {Element}
   */
  _buildTornado(results) {
    const top10 = [...results]
      .map(r => ({ ...r, name: this._getTaskName(r.id), sens: r.sensitivity ?? Math.min(1, r.std / 5) }))
      .filter(r => r.sens > 0.001)
      .sort((a, b) => b.sens - a.sens)
      .slice(0, 10);

    if (top10.length === 0) {
      const p = document.createElement('p');
      p.className = 'mc-note';
      p.textContent = 'No hay datos de sensibilidad disponibles. Ejecute la simulación primero.';
      return p;
    }

    const ROW_H = 28;
    const PAD = { top: 24, right: 60, bottom: 8, left: 160 };
    const W = Math.max(380, (this._resultsArea?.clientWidth || 700) - 32);
    const barArea = W - PAD.left - PAD.right;
    const H = PAD.top + top10.length * ROW_H + PAD.bottom;
    const maxSens = top10[0].sens;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('class', 'mc-histogram');

    // Título del eje
    const axisLbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    axisLbl.setAttribute('x', String(PAD.left + barArea / 2));
    axisLbl.setAttribute('y', '14');
    axisLbl.setAttribute('text-anchor', 'middle');
    axisLbl.setAttribute('class', 'mc-hist-tick');
    axisLbl.setAttribute('font-size', '10');
    axisLbl.textContent = 'Correlación con fecha fin del proyecto';
    svg.appendChild(axisLbl);

    top10.forEach((r, i) => {
      const y = PAD.top + i * ROW_H;
      const bw = (r.sens / maxSens) * barArea;
      const isCrit = this._cpmResult?.tasks?.get(r.id)?.is_critical;

      if (i % 2 === 1) {
        const stripe = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        stripe.setAttribute('x', '0'); stripe.setAttribute('y', String(y));
        stripe.setAttribute('width', String(W)); stripe.setAttribute('height', String(ROW_H));
        stripe.setAttribute('fill', 'var(--mc-kpi-bg, #f3f4f6)'); stripe.setAttribute('opacity', '0.45');
        svg.appendChild(stripe);
      }

      const bar = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bar.setAttribute('x', String(PAD.left)); bar.setAttribute('y', String(y + 4));
      bar.setAttribute('width', String(Math.max(3, bw))); bar.setAttribute('height', String(ROW_H - 8));
      bar.setAttribute('fill', isCrit ? '#dc2626' : 'var(--mc-accent, #2563eb)');
      bar.setAttribute('opacity', '0.78');
      svg.appendChild(bar);

      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', String(PAD.left - 6)); lbl.setAttribute('y', String(y + ROW_H / 2));
      lbl.setAttribute('text-anchor', 'end'); lbl.setAttribute('dominant-baseline', 'middle');
      lbl.setAttribute('class', 'mc-hist-tick'); lbl.setAttribute('font-size', '10');
      const name = r.name;
      lbl.textContent = name.length > 22 ? name.slice(0, 22) + '…' : name;
      svg.appendChild(lbl);

      const val = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      val.setAttribute('x', String(PAD.left + bw + 4)); val.setAttribute('y', String(y + ROW_H / 2));
      val.setAttribute('dominant-baseline', 'middle'); val.setAttribute('class', 'mc-hist-tick');
      val.setAttribute('font-size', '10');
      val.textContent = (r.sens * 100).toFixed(0) + '%';
      svg.appendChild(val);
    });

    return /** @type {any} */ (svg);
  }

  // ─── Diagrama de dispersión SVG ───────────────────────────────────────────

  /**
   * Scatter: X = media de finalización, Y = desviación estándar, por tarea.
   * @param {Array<{id:string,mean:number,std:number}>} results
   * @returns {Element}
   */
  _buildScatter(results) {
    const data = results.filter(r => r.mean > 0 || r.std > 0);
    if (data.length < 2) {
      const p = document.createElement('p');
      p.className = 'mc-note';
      p.textContent = 'Datos insuficientes para el diagrama de dispersión.';
      return p;
    }

    const W = Math.max(300, (this._resultsArea?.clientWidth || 700) - 32);
    const H = Math.max(150, Math.round(W * 0.38));
    const PAD = { top: 14, right: 20, bottom: 36, left: 44 };
    const iw = W - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;

    const means = data.map(r => r.mean);
    const stds  = data.map(r => r.std);
    const minX = Math.min(...means), maxX = Math.max(...means);
    const maxY  = Math.max(...stds) * 1.15 || 1;
    const rangeX = maxX - minX || 1;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('class', 'mc-histogram');

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${PAD.left},${PAD.top})`);
    svg.appendChild(g);

    // Grid lines
    for (let i = 0; i <= 4; i++) {
      const y = ih * (i / 4);
      const gl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      gl.setAttribute('x1', '0'); gl.setAttribute('y1', String(y));
      gl.setAttribute('x2', String(iw)); gl.setAttribute('y2', String(y));
      gl.setAttribute('class', 'mc-hist-axis'); gl.setAttribute('opacity', '0.2');
      g.appendChild(gl);
      const yVal = maxY * (1 - i / 4);
      const tl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tl.setAttribute('x', '-3'); tl.setAttribute('y', String(y));
      tl.setAttribute('text-anchor', 'end'); tl.setAttribute('dominant-baseline', 'middle');
      tl.setAttribute('class', 'mc-hist-tick'); tl.setAttribute('font-size', '9');
      tl.textContent = yVal.toFixed(1);
      g.appendChild(tl);
    }

    // Dots
    for (const r of data) {
      const cx = ((r.mean - minX) / rangeX) * iw;
      const cy = ih - (r.std / maxY) * ih;
      const cpmTask = this._cpmResult?.tasks?.get(r.id);
      const isCrit = cpmTask?.is_critical;

      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(cx.toFixed(1)));
      dot.setAttribute('cy', String(cy.toFixed(1)));
      dot.setAttribute('r', '5');
      dot.setAttribute('fill', isCrit ? '#dc2626' : 'var(--mc-accent, #2563eb)');
      dot.setAttribute('opacity', '0.7');

      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${this._getTaskName(r.id)}: μ=${r.mean.toFixed(1)}d  σ=${r.std.toFixed(1)}d`;
      dot.appendChild(title);
      g.appendChild(dot);
    }

    // Línea de regresión lineal
    if (data.length >= 3) {
      const n2 = data.length;
      let sx2 = 0, sy2 = 0, sxy2 = 0, sx22 = 0;
      for (const r of data) { sx2 += r.mean; sy2 += r.std; sxy2 += r.mean * r.std; sx22 += r.mean * r.mean; }
      const denom = n2 * sx22 - sx2 * sx2;
      if (Math.abs(denom) > 1e-9) {
        const slope = (n2 * sxy2 - sx2 * sy2) / denom;
        const intercept = (sy2 - slope * sx2) / n2;
        const yAtMin = slope * minX + intercept;
        const yAtMax = slope * maxX + intercept;
        const rx1 = 0, ry1 = ih - (yAtMin / maxY) * ih;
        const rx2 = iw, ry2 = ih - (yAtMax / maxY) * ih;
        const regLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        regLine.setAttribute('x1', String(rx1)); regLine.setAttribute('y1', String(ry1));
        regLine.setAttribute('x2', String(rx2)); regLine.setAttribute('y2', String(ry2));
        regLine.setAttribute('stroke', '#f59e0b'); regLine.setAttribute('stroke-width', '2');
        regLine.setAttribute('stroke-dasharray', '5 3'); regLine.setAttribute('opacity', '0.9');
        g.appendChild(regLine);
      }
    }

    // Axes
    const axX = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    axX.setAttribute('x1', '0'); axX.setAttribute('y1', String(ih));
    axX.setAttribute('x2', String(iw)); axX.setAttribute('y2', String(ih));
    axX.setAttribute('class', 'mc-hist-axis');
    g.appendChild(axX);
    const axY = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    axY.setAttribute('x1', '0'); axY.setAttribute('y1', '0');
    axY.setAttribute('x2', '0'); axY.setAttribute('y2', String(ih));
    axY.setAttribute('class', 'mc-hist-axis');
    g.appendChild(axY);

    // X axis labels
    const axG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    axG.setAttribute('transform', `translate(0,${ih})`);
    [[0, minX], [iw, maxX]].forEach(([pos, val]) => {
      const tt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      tt.setAttribute('x', String(pos)); tt.setAttribute('y', '14');
      tt.setAttribute('text-anchor', pos === 0 ? 'start' : 'end');
      tt.setAttribute('class', 'mc-hist-tick');
      tt.textContent = Math.round(val) + 'd';
      axG.appendChild(tt);
    });
    g.appendChild(axG);

    // Y axis label
    const yLbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    yLbl.setAttribute('transform', `translate(-32,${ih / 2}) rotate(-90)`);
    yLbl.setAttribute('text-anchor', 'middle'); yLbl.setAttribute('class', 'mc-hist-tick');
    yLbl.setAttribute('font-size', '9'); yLbl.textContent = 'σ (días)';
    g.appendChild(yLbl);

    // X axis label
    const xLbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    xLbl.setAttribute('x', String(iw / 2)); xLbl.setAttribute('y', String(ih + 28));
    xLbl.setAttribute('text-anchor', 'middle'); xLbl.setAttribute('class', 'mc-hist-tick');
    xLbl.setAttribute('font-size', '9'); xLbl.textContent = 'Día de finalización (media)';
    g.appendChild(xLbl);

    // Legend
    [['#dc2626', 'Crítica'], ['var(--mc-accent, #2563eb)', 'No crítica'], ['#f59e0b', 'Tendencia']].forEach(([color, label], i) => {
      const lx = 10 + i * 100, ly = ih + 28;
      if (label === 'Tendencia') {
        const seg = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        seg.setAttribute('x1', String(lx - 5)); seg.setAttribute('y1', String(ly));
        seg.setAttribute('x2', String(lx + 5)); seg.setAttribute('y2', String(ly));
        seg.setAttribute('stroke', color); seg.setAttribute('stroke-width', '2');
        seg.setAttribute('stroke-dasharray', '3 2');
        g.appendChild(seg);
      } else {
        const dot2 = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot2.setAttribute('cx', String(lx)); dot2.setAttribute('cy', String(ly));
        dot2.setAttribute('r', '4'); dot2.setAttribute('fill', color); dot2.setAttribute('opacity', '0.75');
        g.appendChild(dot2);
      }
      const lt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lt.setAttribute('x', String(lx + 8)); lt.setAttribute('y', String(ly));
      lt.setAttribute('dominant-baseline', 'middle'); lt.setAttribute('class', 'mc-hist-tick');
      lt.setAttribute('font-size', '9'); lt.textContent = label;
      g.appendChild(lt);
    });

    return /** @type {any} */ (svg);
  }

  // ─── Tabla resumen por percentil ─────────────────────────────────────────

  /**
   * Tabla P50/P80/P90/σ para tareas en ruta crítica (o top por σ si no hay críticas).
   * @param {Array<{id:string,p50:number,p80:number,p90:number,mean:number,std:number}>} results
   * @param {(idx:number)=>string} idxFmt
   * @returns {HTMLElement}
   */
  _buildPercentileTable(results, idxFmt) {
    // Prefer critical path tasks; fall back to top-std tasks
    const critResults = results
      .filter(r => this._cpmResult?.tasks?.get(r.id)?.is_critical)
      .sort((a, b) => a.mean - b.mean)
      .slice(0, 20);

    const rows = critResults.length > 0
      ? critResults
      : [...results].sort((a, b) => b.std - a.std).slice(0, 10);

    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'mc-note';
      p.textContent = 'No hay datos de tareas disponibles.';
      return p;
    }

    const table = document.createElement('table');
    table.className = 'mc-risk-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Tarea</th>
          <th>P50</th>
          <th>P80</th>
          <th>P90</th>
          <th>σ (días)</th>
        </tr>
      </thead>`;
    const tbody = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mc-task-name">${_esc(this._getTaskName(r.id))}</td>
        <td>${idxFmt(r.p50)}</td>
        <td>${idxFmt(r.p80)}</td>
        <td>${idxFmt(r.p90)}</td>
        <td class="mc-spread">${r.std.toFixed(1)}</td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  // ─── Histograma SVG ────────────────────────────────────────────────────────

  /**
   * Construye un SVG con el histograma de valores de project_finishes.
   * @param {number[]} sorted  valores ordenados
   * @param {number} p80
   * @param {(idx:number)=>string} fmt
   * @returns {SVGElement}
   */
  _buildHistogram(sorted, p80, fmt) {
    const W = Math.max(300, (this._resultsArea?.clientWidth || 480) - 32);
    const H = Math.max(140, Math.round(W * 0.35));
    const PAD = { top: 8, right: 12, bottom: 32, left: 36 };
    const inner_w = W - PAD.left - PAD.right;
    const inner_h = H - PAD.top - PAD.bottom;

    const dataMin = sorted[0];
    const dataMax = sorted[sorted.length - 1];
    const _n = sorted.length;
    const _mean = sorted.reduce((s, v) => s + v, 0) / _n;

    const BINS = 20;
    // Usar rango real de los datos, con mínimo de BINS días para que siempre haya al menos 20 barras
    const dataRange = dataMax - dataMin;
    const minSpan = Math.max(dataRange, BINS);
    const center = _mean;
    const min = Math.min(dataMin, center - minSpan / 2);
    const max = Math.max(dataMax, min + minSpan);
    const range = max - min;

    const binW = range / BINS;
    const counts = new Array(BINS).fill(0);
    for (const v of sorted) {
      let b = Math.floor((v - min) / binW);
      b = Math.max(0, Math.min(BINS - 1, b));
      counts[b]++;
    }
    const maxCount = Math.max(...counts, 1);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', String(W));
    svg.setAttribute('class', 'mc-histogram');

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${PAD.left},${PAD.top})`);
    svg.appendChild(g);

    // Barras — siempre 20 barras; vacías se renderizan como ghost de 2px
    const bw = (inner_w / BINS) - 1;
    for (let i = 0; i < BINS; i++) {
      const bh = counts[i] > 0 ? Math.max(2, (counts[i] / maxCount) * inner_h) : 0;
      const x = (i / BINS) * inner_w;
      // Ghost bar para bins vacíos — visible pero tenue
      if (counts[i] === 0) {
        const ghostH = Math.max(6, Math.round(inner_h * 0.07));
        const ghost = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        ghost.setAttribute('x', String(x));
        ghost.setAttribute('y', String(inner_h - ghostH));
        ghost.setAttribute('width', String(Math.max(bw, 1)));
        ghost.setAttribute('height', String(ghostH));
        ghost.setAttribute('class', 'mc-hist-bar-ghost');
        g.appendChild(ghost);
        continue;
      }
      const y = inner_h - bh;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(Math.max(bw, 1)));
      rect.setAttribute('height', String(bh));
      rect.setAttribute('class', 'mc-hist-bar');
      g.appendChild(rect);
    }

    // Línea P80
    const p80x = ((p80 - min) / range) * inner_w;
    if (p80x >= 0 && p80x <= inner_w) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(p80x));
      line.setAttribute('y1', '0');
      line.setAttribute('x2', String(p80x));
      line.setAttribute('y2', String(inner_h));
      line.setAttribute('class', 'mc-hist-p80');
      g.appendChild(line);

      const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      lbl.setAttribute('x', String(p80x + 3));
      lbl.setAttribute('y', '10');
      lbl.setAttribute('class', 'mc-hist-p80-lbl');
      lbl.textContent = 'P80';
      g.appendChild(lbl);
    }

    // Eje X: etiquetas min y max
    const axisG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    axisG.setAttribute('transform', `translate(0,${inner_h})`);

    const lineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    lineEl.setAttribute('x1', '0');
    lineEl.setAttribute('y1', '0');
    lineEl.setAttribute('x2', String(inner_w));
    lineEl.setAttribute('y2', '0');
    lineEl.setAttribute('class', 'mc-hist-axis');
    axisG.appendChild(lineEl);

    for (const [pos, val] of [[0, min], [inner_w, max]]) {
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('x', String(pos));
      t.setAttribute('y', '14');
      t.setAttribute('text-anchor', pos === 0 ? 'start' : 'end');
      t.setAttribute('class', 'mc-hist-tick');
      t.textContent = fmt(val);
      axisG.appendChild(t);
    }

    g.appendChild(axisG);

    return /** @type {any} */ (svg);
  }

  // ─── Utilidades internas ───────────────────────────────────────────────────

  /** @param {number} pct */
  _setProgress(pct) {
    this._progressBar.style.width = pct + '%';
    this._progressLabel.textContent = pct + '%';
  }

  /** @param {string} msg */
  _showError(msg) {
    this._resultsArea.innerHTML = `<p class="mc-error">${_esc(msg)}</p>`;
  }

  /**
   * Obtiene el nombre de una tarea por su id.
   * @param {string} id
   * @returns {string}
   */
  _getTaskName(id) {
    const t = this._tasks.get(id);
    return t ? (t.name ?? id) : id;
  }

  /**
   * Obtiene el inicio del proyecto como Date.
   * @returns {Date|null}
   */
  _getProjectStart() {
    if (this._project?.start_date) return isoToDate(this._project.start_date);
    return null;
  }

  /**
   * Obtiene el calendario actual.
   * @returns {import('./calendar.js').Calendar}
   */
  _getCalendar() {
    return this._calendar ?? DEFAULT_CALENDAR;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Escapa HTML básico */
function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── CSS ──────────────────────────────────────────────────────────────────────

const MC_CSS = `
.mc-panel {
  font-family: inherit;
  padding: 12px 16px;
  box-sizing: border-box;
  background: var(--mc-bg, #fff);
  color: var(--mc-fg, #222);
  border-left: 1px solid var(--mc-border, #ddd);
}

.mc-info-box {
  margin-bottom: 12px;
  border: 1px solid var(--mc-border, #ddd);
  border-radius: 6px;
  overflow: hidden;
  background: var(--mc-surface, #f5f7ff);
}
.mc-info-summary {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--mc-accent, #2563eb);
  cursor: pointer;
  user-select: none;
  list-style: none;
}
.mc-info-summary::-webkit-details-marker { display: none; }
.mc-info-body {
  padding: 10px 14px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--mc-fg, #444);
  border-top: 1px solid var(--mc-border, #ddd);
}
.mc-info-body p { margin: 0 0 8px; }
.mc-info-body ul { margin: 0 0 8px; padding-left: 18px; }
.mc-info-body li { margin-bottom: 4px; }

.mc-iters-input {
  font-size: 13px;
  padding: 3px 6px;
  border: 1px solid var(--mc-border, #ccc);
  border-radius: 4px;
  background: var(--mc-input-bg, #f9f9f9);
  color: inherit;
  width: 90px;
}

.mc-header {
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}

.mc-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  opacity: .75;
}

.mc-form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.mc-label {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.mc-select {
  font-size: 13px;
  padding: 3px 6px;
  border: 1px solid var(--mc-border, #ccc);
  border-radius: 4px;
  background: var(--mc-input-bg, #f9f9f9);
  color: inherit;
  cursor: pointer;
}

.mc-run-btn {
  font-size: 13px;
  padding: 4px 14px;
  border: none;
  border-radius: 4px;
  background: var(--mc-accent, #2563eb);
  color: #fff;
  cursor: pointer;
  transition: opacity .15s;
}
.mc-run-btn:disabled {
  opacity: .55;
  cursor: default;
}
.mc-run-btn:hover:not(:disabled) {
  opacity: .88;
}

.mc-progress-wrap {
  position: relative;
  height: 16px;
  background: var(--mc-track, #e5e7eb);
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 10px;
}
.mc-hidden { display: none !important; }

.mc-progress-bar {
  height: 100%;
  background: var(--mc-accent, #2563eb);
  transition: width .1s linear;
  border-radius: 8px;
}

.mc-progress-label {
  position: absolute;
  right: 8px;
  top: 0;
  font-size: 11px;
  line-height: 16px;
  color: var(--mc-fg, #444);
}

.mc-results { margin-top: 4px; }

.mc-section { margin-bottom: 18px; }

.mc-section-title {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--mc-border, #e5e7eb);
}

.mc-kpi-grid {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.mc-kpi-card {
  flex: 1 1 90px;
  background: var(--mc-kpi-bg, #f3f4f6);
  border-radius: 6px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.mc-kpi-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: .05em;
  opacity: .65;
  text-transform: uppercase;
}

.mc-kpi-value {
  font-size: 14px;
  font-weight: 600;
}

.mc-histogram {
  display: block;
  width: 100%;
  max-width: 100%;
  overflow: visible;
}

.mc-hist-bar {
  fill: var(--mc-hist-fill, #60a5fa);
  opacity: .85;
}

.mc-hist-bar-ghost {
  fill: var(--mc-border, #d1d5db);
  opacity: .5;
}

.mc-hist-p80 {
  stroke: var(--mc-p80-color, #dc2626);
  stroke-width: 1.5;
  stroke-dasharray: 4 2;
}

.mc-hist-p80-lbl {
  fill: var(--mc-p80-color, #dc2626);
  font-size: 10px;
  font-weight: 600;
}

.mc-hist-axis {
  stroke: var(--mc-fg, #aaa);
  stroke-width: 1;
}

.mc-hist-tick {
  fill: var(--mc-fg, #666);
  font-size: 10px;
}

.mc-risk-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.mc-risk-table th, .mc-risk-table td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--mc-border, #e5e7eb);
  text-align: left;
}

.mc-risk-table th {
  font-weight: 600;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: .03em;
  opacity: .7;
}

.mc-risk-table td.mc-spread {
  font-weight: 600;
  color: var(--mc-warn, #b45309);
  text-align: right;
}

.mc-task-name {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mc-error {
  color: var(--mc-error, #dc2626);
  font-size: 13px;
  padding: 8px 0;
}

.mc-stale, .mc-note {
  font-size: 13px;
  opacity: .7;
  font-style: italic;
}

@media (prefers-color-scheme: dark) {
  .mc-panel {
    --mc-bg: #1e1e2e;
    --mc-fg: #cdd6f4;
    --mc-border: #45475a;
    --mc-input-bg: #313244;
    --mc-accent: #89b4fa;
    --mc-track: #45475a;
    --mc-kpi-bg: #313244;
    --mc-hist-fill: #89b4fa;
    --mc-p80-color: #f38ba8;
    --mc-warn: #fab387;
    --mc-error: #f38ba8;
  }
}
`;
