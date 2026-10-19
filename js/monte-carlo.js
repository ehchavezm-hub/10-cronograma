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
    /** @type {string|null} */
    this._projectId = null;

    this._buildUI();
  }

  // ─── UI ────────────────────────────────────────────────────────────────────

  _buildUI() {
    this.el.innerHTML = '';
    this.el.className = 'mc-panel';

    // Encabezado
    const header = document.createElement('div');
    header.className = 'mc-header';
    header.innerHTML = '<span class="mc-title">Simulación Monte Carlo</span>';
    this.el.appendChild(header);

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
  onCpmUpdate(cpmResult, tasks) {
    this._cpmResult = cpmResult;
    this._tasks = tasks;
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

    const iterations = parseInt(this._itersSelect.value, 10);

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
      histTitle.textContent = 'Distribución de Fechas de Finalización';
      histSection.appendChild(histTitle);
      histSection.appendChild(this._buildHistogram(result.project_finishes, result.project_p80, idxFmt));
      area.appendChild(histSection);
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

  // ─── Histograma SVG ────────────────────────────────────────────────────────

  /**
   * Construye un SVG con el histograma de valores de project_finishes.
   * @param {number[]} sorted  valores ordenados
   * @param {number} p80
   * @param {(idx:number)=>string} fmt
   * @returns {SVGElement}
   */
  _buildHistogram(sorted, p80, fmt) {
    const W = 480, H = 160;
    const PAD = { top: 8, right: 12, bottom: 32, left: 36 };
    const inner_w = W - PAD.left - PAD.right;
    const inner_h = H - PAD.top - PAD.bottom;

    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const range = max - min || 1;

    const BINS = 30;
    const binW = range / BINS;
    const counts = new Array(BINS).fill(0);
    for (const v of sorted) {
      let b = Math.floor((v - min) / binW);
      if (b >= BINS) b = BINS - 1;
      counts[b]++;
    }
    const maxCount = Math.max(...counts, 1);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('class', 'mc-histogram');

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${PAD.left},${PAD.top})`);
    svg.appendChild(g);

    // Barras
    const bw = (inner_w / BINS) - 1;
    for (let i = 0; i < BINS; i++) {
      const bh = (counts[i] / maxCount) * inner_h;
      const x = (i / BINS) * inner_w;
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
    if (this._cpmResult && this._cpmResult.projectStart) {
      const ps = this._cpmResult.projectStart;
      if (ps instanceof Date) return ps;
      if (typeof ps === 'string') return isoToDate(ps);
    }
    return null;
  }

  /**
   * Obtiene el calendario actual.
   * @returns {import('./calendar.js').Calendar}
   */
  _getCalendar() {
    if (this._cpmResult && this._cpmResult.calendar) {
      return this._cpmResult.calendar;
    }
    return DEFAULT_CALENDAR;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Escapa HTML básico */
function _esc(s) {
  return String(s)
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
  overflow-y: auto;
  height: 100%;
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
  max-width: 480px;
  overflow: visible;
}

.mc-hist-bar {
  fill: var(--mc-hist-fill, #60a5fa);
  opacity: .85;
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
