// @ts-check
/**
 * dcma.js — Motor de verificación DCMA 14 puntos + panel de visualización.
 *
 * Referencias:
 *   • DCMA 14-Point Schedule Assessment (DCMA-EA PAM 200.1)
 *   • GAO Schedule Assessment Guide (GAO-16-89G)
 *
 * Los umbrales por defecto siguen los criterios DCMA estándar:
 *   - Lead: 0%    - Lag > umbral: 0%   - Float alto: ≤ 5%
 *   - Float neg: 0%  - Duración alta: ≤ 5%  - Restr. duras: ≤ 5%
 */

import { appState }  from './state.js';
import { t }         from './i18n.js';
import { calcEvm }   from './evm.js';

// ============================================================
// Umbrales DCMA (configurables vía proyecto en Fase 5)
// ============================================================
const TH = {
  LAG_MAX_DAYS:    5,    // lag > N días = alerta
  FLOAT_HIGH_DAYS: 44,   // TF > N días = flotamiento alto
  DUR_HIGH_DAYS:   44,   // duración > N días = duración excesiva
  NONFS_PCT:       10,   // % dependencias no-FS aceptable
  CONSTRAINT_PCT:  5,    // % restricciones duras aceptable
  FLOAT_HIGH_PCT:  5,    // % tareas flotamiento alto aceptable
  DUR_HIGH_PCT:    5,    // % tareas duración alta aceptable
  CPLI_MIN:        0.95, // CPLI mínimo aceptable
};

// ============================================================
// Tipos
// ============================================================

/**
 * @typedef {{
 *   id: string,
 *   point: number,
 *   name: string,
 *   description: string,
 *   metric: string,
 *   value: number,
 *   target: number,
 *   pass: boolean,
 *   count: number,
 *   total: number,
 *   taskIds: string[],
 *   na: boolean,
 *   naReason?: string,
 * }} DcmaCheck
 */

/**
 * @typedef {{
 *   checks: DcmaCheck[],
 *   score: number,
 *   passed: number,
 *   total: number,
 *   dataDate: string|null,
 * }} DcmaReport
 */

// ============================================================
// Motor de verificación
// ============================================================

/**
 * Ejecuta los 14 puntos DCMA.
 *
 * @param {{
 *   tasks: Map<string,any>,
 *   deps: Map<string,any>,
 *   cpmResult: import('./cpm.js').CpmResult|null,
 *   taskResources?: any[],
 *   nearThreshold?: number,
 *   dataDate?: string|null,
 * }} opts
 * @returns {DcmaReport}
 */
export function runDcmaChecks({ tasks, deps, cpmResult, taskResources = [], nearThreshold = 5, dataDate = null }) {
  const activeTasks = [...tasks.values()].filter(t => !t.deleted_at);
  const activeDeps  = [...deps.values()].filter(d => !d.deleted_at);

  // Identificar tareas resumen (tienen hijos)
  const parentIds = new Set(activeTasks.map(t => t.parent_id).filter(Boolean));
  const leafTasks = activeTasks.filter(t => !parentIds.has(t.id));
  const cpmTasks  = cpmResult?.tasks ?? new Map();

  // Tareas hoja con resultados CPM
  const leafWithCpm = leafTasks.filter(t => cpmTasks.has(t.id));

  const checks = /** @type {DcmaCheck[]} */ ([]);

  // ---- 1. Lógica faltante: sin predecesoras ----
  {
    const noPred = new Set(activeDeps.map(d => d.succ_id));
    const affected = leafTasks.filter(t => !noPred.has(t.id) && t.type !== 'milestone');
    checks.push(_check(1,
      'Lógica faltante (sin pred.)',
      'Tareas hoja sin ninguna predecesora (excluye el inicio del proyecto)',
      '% tareas sin pred.', '%',
      affected.length, leafTasks.length, 0,
      affected.map(t => t.id)));
  }

  // ---- 2. Lógica faltante: sin sucesoras ----
  {
    const noSucc = new Set(activeDeps.map(d => d.pred_id));
    const affected = leafTasks.filter(t => !noSucc.has(t.id) && t.type !== 'milestone');
    checks.push(_check(2,
      'Lógica faltante (sin suc.)',
      'Tareas hoja sin ninguna sucesora (excluye el fin del proyecto)',
      '% tareas sin suc.', '%',
      affected.length, leafTasks.length, 0,
      affected.map(t => t.id)));
  }

  // ---- 3. Adelantos (leads) ----
  {
    const withLead = activeDeps.filter(d => d.lag_days < 0);
    const taskIds  = [...new Set([...withLead.map(d => d.pred_id), ...withLead.map(d => d.succ_id)])];
    checks.push(_check(3,
      'Adelantos (leads)',
      'Dependencias con tiempo de adelanto negativo (lag < 0)',
      '% dep. con lead', '%',
      withLead.length, activeDeps.length, 0,
      taskIds));
  }

  // ---- 4. Retrasos excesivos (lags) ----
  {
    const withLag  = activeDeps.filter(d => d.lag_days > TH.LAG_MAX_DAYS);
    const taskIds  = [...new Set([...withLag.map(d => d.pred_id), ...withLag.map(d => d.succ_id)])];
    checks.push(_check(4,
      `Retrasos excesivos (lag > ${TH.LAG_MAX_DAYS} d)`,
      'Dependencias con lag superior al umbral permitido',
      '% dep. con lag alto', '%',
      withLag.length, activeDeps.length, 0,
      taskIds));
  }

  // ---- 5. Tipos de relación (no-FS) ----
  {
    const nonFS   = activeDeps.filter(d => d.type !== 'FS');
    const pct     = activeDeps.length ? (nonFS.length / activeDeps.length) * 100 : 0;
    const taskIds = [...new Set([...nonFS.map(d => d.pred_id), ...nonFS.map(d => d.succ_id)])];
    const check   = _check(5,
      'Tipos de relación (no-FS)',
      `Porcentaje de relaciones que no son Fin-Inicio. Meta: ≤ ${TH.NONFS_PCT}%`,
      '% dep. no-FS', '%',
      nonFS.length, activeDeps.length, TH.NONFS_PCT / 100,
      taskIds);
    check.value = pct;
    check.pass  = pct <= TH.NONFS_PCT;
    checks.push(check);
  }

  // ---- 6. Restricciones duras ----
  {
    const SOFT = ['ASAP', 'ALAP', ''];
    const hard = leafTasks.filter(t => !SOFT.includes(t.constraint_type ?? 'ASAP'));
    const pct  = leafTasks.length ? (hard.length / leafTasks.length) * 100 : 0;
    const check = _check(6,
      'Restricciones duras',
      `Tareas con restricción diferente de ASAP/ALAP. Meta: ≤ ${TH.CONSTRAINT_PCT}%`,
      '% tareas con restricción', '%',
      hard.length, leafTasks.length, TH.CONSTRAINT_PCT / 100,
      hard.map(t => t.id));
    check.value = pct;
    check.pass  = pct <= TH.CONSTRAINT_PCT;
    checks.push(check);
  }

  // ---- 7. Flotamiento alto ----
  {
    const highTF = leafWithCpm.filter(t => {
      const c = cpmTasks.get(t.id);
      return c && c.tf !== null && c.tf > TH.FLOAT_HIGH_DAYS;
    });
    const pct   = leafWithCpm.length ? (highTF.length / leafWithCpm.length) * 100 : 0;
    const check = _check(7,
      `Flotamiento alto (TF > ${TH.FLOAT_HIGH_DAYS} d)`,
      'Tareas con holgura total excesiva (posible problema de lógica)',
      '% tareas TF alto', '%',
      highTF.length, leafWithCpm.length, TH.FLOAT_HIGH_PCT / 100,
      highTF.map(t => t.id));
    check.value = pct;
    check.pass  = pct <= TH.FLOAT_HIGH_PCT;
    checks.push(check);
  }

  // ---- 8. Flotamiento negativo ----
  {
    const negTF  = leafWithCpm.filter(t => {
      const c = cpmTasks.get(t.id);
      return c && c.tf !== null && c.tf < 0;
    });
    checks.push(_check(8,
      'Flotamiento negativo (TF < 0)',
      'Tareas con holgura negativa — el proyecto está atrasado respecto a sus restricciones',
      '% tareas TF negativo', '%',
      negTF.length, leafWithCpm.length, 0,
      negTF.map(t => t.id)));
  }

  // ---- 9. Duraciones excesivas ----
  {
    const longDur = leafTasks.filter(t => t.type !== 'milestone' && t.duration_days > TH.DUR_HIGH_DAYS);
    const pct     = leafTasks.filter(t => t.type !== 'milestone').length;
    const check   = _check(9,
      `Duraciones excesivas (> ${TH.DUR_HIGH_DAYS} d)`,
      'Actividades con duración superior al umbral (pueden necesitar descomposición)',
      '% tareas duración alta', '%',
      longDur.length, pct, TH.DUR_HIGH_PCT / 100,
      longDur.map(t => t.id));
    check.value = pct ? (longDur.length / pct) * 100 : 0;
    check.pass  = check.value <= TH.DUR_HIGH_PCT;
    checks.push(check);
  }

  // ---- 10. Fechas inválidas ----
  {
    const today   = new Date(); today.setHours(0,0,0,0);
    const invalid = activeTasks.filter(t => {
      if (t.actual_start  && new Date(t.actual_start  + 'T00:00:00') > today) return true;
      if (t.actual_finish && new Date(t.actual_finish + 'T00:00:00') > today) return true;
      return false;
    });
    checks.push(_check(10,
      'Fechas reales inválidas',
      'Tareas con fecha real de inicio o fin posterior a hoy',
      '% tareas con fecha inválida', '%',
      invalid.length, activeTasks.length, 0,
      invalid.map(t => t.id)));
  }

  // ---- 11. Recursos no asignados ----
  {
    const assignedTaskIds = new Set(taskResources.filter(tr => !tr.deleted_at).map(tr => tr.task_id));
    if (assignedTaskIds.size > 0 || taskResources.length > 0) {
      const unassigned = leafTasks.filter(t => t.type !== 'milestone' && !assignedTaskIds.has(t.id));
      checks.push(_check(11,
        'Recursos asignados',
        'Tareas hoja sin ningún recurso asignado',
        '% tareas sin recurso', '%',
        unassigned.length, leafTasks.filter(t => t.type !== 'milestone').length, 0,
        unassigned.map(t => t.id)));
    } else {
      checks.push({
        id: 'check-11', point: 11,
        name: 'Recursos asignados',
        description: 'No hay asignaciones de recursos en el proyecto.',
        metric: '% tareas sin recurso', value: 0, target: 0,
        pass: true, count: 0, total: 0, taskIds: [], na: true,
        naReason: 'Sin asignaciones de recursos',
      });
    }
  }

  // ---- 12. Tareas retrasadas (vs. fecha de corte) ----
  if (dataDate && cpmResult) {
    const ddDate   = new Date(dataDate + 'T00:00:00');
    const missed   = leafWithCpm.filter(t => {
      const c = cpmTasks.get(t.id);
      if (!c || t.percent_complete >= 100) return false;
      // Si el EF esperado (según CPM) ya pasó la data date y no está completo
      // Usamos comparación de fecha
      return c.tf !== null && c.tf < 0 && t.percent_complete < 100;
    });
    checks.push(_check(12,
      'Tareas retrasadas (vs. corte)',
      'Tareas que debieron completarse antes de la fecha de corte pero no lo hicieron',
      '% tareas retrasadas', '%',
      missed.length, leafWithCpm.length, 0,
      missed.map(t => t.id)));
  } else {
    checks.push({
      id: 'missed', point: 12,
      name: 'Tareas retrasadas (vs. corte)',
      description: 'Requiere definir fecha de corte (data date) en el proyecto.',
      metric: '% tareas retrasadas', value: 0, target: 0,
      pass: true, count: 0, total: 0, taskIds: [], na: true,
      naReason: 'Sin fecha de corte definida',
    });
  }

  // ---- 13. CPLI (Critical Path Length Index) ----
  {
    if (cpmResult && cpmResult.projectDuration > 0) {
      const critTasks = leafWithCpm.filter(t => cpmTasks.get(t.id)?.is_critical);
      const maxLF     = critTasks.length
        ? Math.max(...critTasks.map(t => cpmTasks.get(t.id)?.lf ?? 0))
        : cpmResult.projectDuration;
      const minTF     = critTasks.length
        ? Math.min(...critTasks.map(t => cpmTasks.get(t.id)?.tf ?? 0))
        : 0;
      // CPLI = (CPL + TF_crítico) / CPL — si TF=0 entonces CPLI=1
      const cpli = maxLF > 0 ? (maxLF + Math.max(0, minTF)) / maxLF : 1;
      const check = {
        id: 'cpli', point: 13,
        name: 'CPLI (Índice de Longitud de Ruta Crítica)',
        description: `Índice de salud de la ruta crítica. Meta: ≥ ${TH.CPLI_MIN}`,
        metric: 'CPLI', value: Math.round(cpli * 1000) / 1000, target: TH.CPLI_MIN,
        pass: cpli >= TH.CPLI_MIN,
        count: critTasks.length, total: leafWithCpm.length,
        taskIds: critTasks.filter(t => cpmTasks.get(t.id)?.tf < 0).map(t => t.id),
        na: false,
      };
      checks.push(check);
    } else {
      checks.push({
        id: 'cpli', point: 13,
        name: 'CPLI', description: 'Requiere resultado CPM válido.',
        metric: 'CPLI', value: 0, target: TH.CPLI_MIN,
        pass: true, count: 0, total: 0, taskIds: [], na: true,
        naReason: 'Sin resultados CPM',
      });
    }
  }

  // ---- 14. SPI (Schedule Performance Index) ----
  {
    const evm = calcEvm();
    if (evm && evm.bac > 0) {
      const spi = evm.spi;
      checks.push({
        id: 'spi', point: 14,
        name: 'SPI (Índice de Desempeño del Cronograma)',
        description: 'Ratio EVM del desempeño del cronograma. SPI ≥ 1 = adelantado; < 1 = retrasado.',
        metric: 'SPI', value: Math.round(spi * 1000) / 1000, target: 1,
        pass: spi >= 1,
        count: evm.evmTasks?.filter(t => t.spi < 1).length ?? 0,
        total: evm.evmTasks?.length ?? 0,
        taskIds: evm.evmTasks?.filter(t => t.spi < 1).map(t => t.id) ?? [],
        na: false,
      });
    } else {
      checks.push({
        id: 'spi', point: 14,
        name: 'SPI (Índice de Desempeño del Cronograma)',
        description: 'Requiere costos planificados (BAC > 0) y resultados CPM.',
        metric: 'SPI', value: 0, target: 1,
        pass: true, count: 0, total: 0, taskIds: [], na: true,
        naReason: 'Sin costos planificados o CPM pendiente',
      });
    }
  }

  // ---- Puntuación general ----
  const applicable = checks.filter(c => !c.na);
  const passed     = applicable.filter(c => c.pass).length;
  const score      = applicable.length ? Math.round((passed / applicable.length) * 100) : 100;

  return { checks, score, passed, total: applicable.length, dataDate };
}

/** Construye un DcmaCheck genérico de tipo porcentaje. */
function _check(point, name, description, metric, unit, count, total, targetPct, taskIds) {
  const pct  = total ? (count / total) * 100 : 0;
  const pass = targetPct === 0 ? count === 0 : pct <= targetPct * 100;
  return {
    id: `check-${point}`,
    point, name, description, metric,
    value: Math.round(pct * 10) / 10,
    target: targetPct === 0 ? 0 : targetPct * 100,
    pass, count, total, taskIds,
    na: false,
  };
}

// ============================================================
// Panel de visualización DCMA
// ============================================================

export class DcmaPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    this._container = container;
    this._report    = null;
    this._selected  = null;

    this._container.innerHTML = `
      <div class="dcma-wrap">
        <div class="dcma-header">
          <div class="dcma-title">
            <span class="dcma-icon">✅</span>
            <h2>Evaluación DCMA 14 Puntos</h2>
          </div>
          <div class="dcma-meta" id="dcma-meta">—</div>
        </div>
        <div class="dcma-body">
          <div class="dcma-gauge-col">
            <canvas id="dcma-gauge" width="140" height="140" aria-label="Puntuación de salud del cronograma"></canvas>
            <div class="dcma-score-label" id="dcma-score-label">—</div>
            <div class="dcma-score-sub" id="dcma-score-sub">puntos aprobados</div>
          </div>
          <div class="dcma-checks-col">
            <table class="dcma-table" id="dcma-table" role="grid">
              <thead>
                <tr>
                  <th style="width:28px">#</th>
                  <th>Verificación</th>
                  <th style="width:72px;text-align:right">Métrica</th>
                  <th style="width:72px;text-align:right">Meta</th>
                  <th style="width:64px;text-align:center">Tareas</th>
                  <th style="width:60px;text-align:center">Estado</th>
                </tr>
              </thead>
              <tbody id="dcma-rows"></tbody>
            </table>
          </div>
        </div>
        <div class="dcma-tasks-section" id="dcma-tasks-section" hidden>
          <h3 id="dcma-tasks-title">Tareas afectadas</h3>
          <div class="dcma-tasks-list" id="dcma-tasks-list"></div>
        </div>
      </div>`;

    this._gauge   = /** @type {HTMLCanvasElement} */ (this._container.querySelector('#dcma-gauge'));
    this._rowsEl  = /** @type {HTMLElement}        */ (this._container.querySelector('#dcma-rows'));
    this._metaEl  = /** @type {HTMLElement}        */ (this._container.querySelector('#dcma-meta'));
    this._scoreEl = /** @type {HTMLElement}        */ (this._container.querySelector('#dcma-score-label'));
    this._subEl   = /** @type {HTMLElement}        */ (this._container.querySelector('#dcma-score-sub'));
    this._taskSec = /** @type {HTMLElement}        */ (this._container.querySelector('#dcma-tasks-section'));
    this._taskTitle = /** @type {HTMLElement}      */ (this._container.querySelector('#dcma-tasks-title'));
    this._taskList  = /** @type {HTMLElement}      */ (this._container.querySelector('#dcma-tasks-list'));

    this._rowsEl.addEventListener('click', e => {
      const tr = /** @type {HTMLElement} */ (e.target.closest('tr[data-check-id]'));
      if (tr) this._selectCheck(tr.dataset.checkId);
    });

    appState.subscribe((_s, keys) => {
      if (!keys || keys.includes('all') || keys.some(k =>
        ['tasks','deps','cpmResult','project'].includes(k))) {
        this.refresh();
      }
    });

    this.refresh();
  }

  async refresh() {
    const { tasks, deps, cpmResult, project } = appState.state;
    if (!project) return;

    let taskResources = [];
    try {
      const { getByIndex } = await import('./storage.js?v=4');
      taskResources = await getByIndex('task_resources', 'project_id', project.id);
    } catch { /* sin recursos */ }

    this._report = runDcmaChecks({
      tasks, deps, cpmResult, taskResources,
      nearThreshold: appState.state.nearThreshold,
      dataDate: project.data_date ?? null,
    });
    this._render();
  }

  _render() {
    const r = this._report;
    if (!r) return;

    // Meta
    this._metaEl.textContent = `${r.passed} / ${r.total} verificaciones aprobadas`;

    // Score
    this._scoreEl.textContent = `${r.score}%`;
    this._subEl.textContent   = `${r.passed} de ${r.total} puntos`;

    // Gauge
    this._drawGauge(r.score);

    // Filas
    this._rowsEl.innerHTML = r.checks.map(c => {
      const cls     = c.na ? 'dcma-na' : c.pass ? 'dcma-pass' : 'dcma-fail';
      const badge   = c.na ? '<span class="dcma-badge dcma-badge-na">N/A</span>'
                    : c.pass ? '<span class="dcma-badge dcma-badge-pass">✓</span>'
                    : '<span class="dcma-badge dcma-badge-fail">✗</span>';
      const isIndex = c.id === 'cpli' || c.id === 'spi';
      const metric  = c.na ? '—' : (isIndex ? c.value.toFixed(3) : `${c.value.toFixed(1)}%`);
      const target  = c.na ? '—' : (isIndex ? `≥ ${c.target}` : `≤ ${c.target === 0 ? '0' : c.target + '%'}`);
      const cnt     = c.na ? '—' : (c.count > 0 ? `<span class="dcma-count">${c.count}</span>` : '0');
      return `<tr data-check-id="${c.id}" class="${cls} ${this._selected === c.id ? 'selected' : ''}" title="${_esc(c.description)}">
        <td class="dcma-point">${c.point}</td>
        <td class="dcma-name">${_esc(c.name)} <span class="dcma-info-icon" title="${_esc(c.description)}" aria-label="Más información" style="cursor:help;color:var(--clr-text-3,#888);font-size:10px;vertical-align:middle">ℹ</span></td>
        <td class="dcma-val" style="text-align:right">${metric}</td>
        <td class="dcma-tgt" style="text-align:right">${target}</td>
        <td style="text-align:center">${cnt}</td>
        <td style="text-align:center">${badge}</td>
      </tr>`;
    }).join('');

    // Si hay selección activa, re-renderizar tarea list
    if (this._selected) this._selectCheck(this._selected);
  }

  _drawGauge(score) {
    const canvas = this._gauge;
    const ctx    = canvas.getContext('2d');
    const cx     = canvas.width / 2;
    const cy     = canvas.height / 2 + 10;
    const r      = 54;
    const start  = Math.PI * 0.75;
    const end    = Math.PI * 2.25;
    const angle  = start + (end - start) * (score / 100);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Fondo del arco
    ctx.beginPath(); ctx.arc(cx, cy, r, start, end);
    ctx.strokeStyle = '#E0E0E0'; ctx.lineWidth = 14; ctx.lineCap = 'round';
    ctx.stroke();

    // Arco del valor
    const color = score >= 80 ? '#388E3C' : score >= 60 ? '#FB8C00' : '#D32F2F';
    ctx.beginPath(); ctx.arc(cx, cy, r, start, angle);
    ctx.strokeStyle = color; ctx.lineWidth = 14; ctx.lineCap = 'round';
    ctx.stroke();

    // Texto del porcentaje
    ctx.fillStyle = color;
    ctx.font = 'bold 28px "Urbanist", system-ui';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(`${score}%`, cx, cy - 8);

    // Etiqueta
    const label = score >= 80 ? 'BUENO' : score >= 60 ? 'REGULAR' : 'CRÍTICO';
    ctx.fillStyle = '#78909C';
    ctx.font = '600 11px "Urbanist", system-ui';
    ctx.fillText(label, cx, cy + 18);
  }

  _selectCheck(checkId) {
    this._selected = checkId;
    // Actualizar clases de filas
    this._rowsEl.querySelectorAll('tr[data-check-id]').forEach(tr => {
      tr.classList.toggle('selected', tr.dataset.checkId === checkId);
    });

    const check = this._report?.checks.find(c => c.id === checkId);
    if (!check || check.taskIds.length === 0 || check.na) {
      this._taskSec.hidden = true;
      return;
    }

    this._taskSec.hidden = false;
    this._taskTitle.textContent = `${check.name} — ${check.count} tarea(s) afectada(s)`;

    const { tasks, cpmResult } = appState.state;
    this._taskList.innerHTML = check.taskIds.slice(0, 50).map(id => {
      const task = tasks.get(id);
      if (!task) return '';
      const cpm  = cpmResult?.tasks.get(id);
      const tf   = cpm?.tf != null ? ` · HT: ${cpm.tf} d` : '';
      const pct  = task.percent_complete != null ? ` · ${task.percent_complete}%` : '';
      return `<div class="dcma-task-item" title="${_esc(task.name)}"
        onclick="(function(){const e=document.dispatchEvent(new CustomEvent('dcma-select-task',{detail:{id:'${id}'}}));})()">
        <span class="dcma-task-icon">${task.type === 'milestone' ? '◆' : '▸'}</span>
        <span class="dcma-task-name">${_esc(task.name)}</span>
        <span class="dcma-task-meta">${task.duration_days} d${pct}${tf}</span>
      </div>`;
    }).join('');

    if (check.taskIds.length > 50) {
      this._taskList.insertAdjacentHTML('beforeend',
        `<div style="color:var(--clr-text-3);font-size:var(--text-xs);padding:4px 0">…y ${check.taskIds.length - 50} más</div>`);
    }
  }
}

function _esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
