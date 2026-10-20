// @ts-check
/**
 * cpm.js — Motor CPM (Método del Camino Crítico).
 *
 * Convenciones (D1): índices enteros de día laborable, fin exclusivo.
 *   ES=0, duración 3 → EF=3.
 *   TF = LS − ES.  FF = min sobre sucesoras de la fórmula por tipo.
 *   D4: ES nunca < 0 → emite INICIO_RECORTADO.
 *   D5: tareas resumen = derivan de hijos; sin dependencias propias.
 *   D13: tareas 100% completadas → TF=null, critical=false, verde.
 */

/** @typedef {'FS'|'SS'|'FF'|'SF'} DepType */
/** @typedef {'ASAP'|'ALAP'|'SNET'|'SNLT'|'FNET'|'FNLT'|'MSO'|'MFO'} ConstraintKind */

/**
 * @typedef {Object} Task
 * @property {string} id
 * @property {string|null} parent_id
 * @property {'task'|'milestone'} type
 * @property {number} duration_days
 * @property {number} percent_complete
 * @property {string|null} actual_start  'YYYY-MM-DD'
 * @property {string|null} actual_finish 'YYYY-MM-DD'
 * @property {ConstraintKind} constraint_type
 * @property {string|null} constraint_date 'YYYY-MM-DD'
 * @property {string|null} deleted_at
 */

/**
 * @typedef {Object} Dep
 * @property {string} id
 * @property {string} pred_id
 * @property {string} succ_id
 * @property {DepType} type
 * @property {number} lag_days  negativo = adelanto
 * @property {string|null} deleted_at
 */

/**
 * @typedef {Object} CpmTaskResult
 * @property {string} id
 * @property {number|null} es
 * @property {number|null} ef
 * @property {number|null} ls
 * @property {number|null} lf
 * @property {number|null} tf
 * @property {number|null} ff
 * @property {boolean|null} is_critical
 * @property {boolean} is_summary
 * @property {boolean} is_complete
 */

/**
 * @typedef {Object} CpmWarning
 * @property {'INICIO_RECORTADO'|'FUERA_DE_SECUENCIA'|'CICLO'|'RESTRICCION_CONFLICTO'|'LAG_HIGH'|'LEAD'|'HARD_CONSTRAINT'|'NO_PRED'|'NO_SUCC'} code
 * @property {string} task_id
 * @property {string} [dep_id]
 * @property {string} [chain]
 */

/**
 * @typedef {Object} CpmResult
 * @property {Map<string, CpmTaskResult>} tasks
 * @property {CpmWarning[]} warnings
 * @property {number} projectDuration
 */

// ============================================================
// Detección de ciclos: DFS desde node_id usando el grafo actual
// ============================================================

/**
 * @param {string} startId
 * @param {Map<string, string[]>} succMap
 * @param {string[]} path
 * @returns {string[]|null} cadena del ciclo, o null
 */
function _findCycleFrom(startId, succMap, path) {
  const visited = new Set(path);
  const stack = [[startId, path.concat(startId)]];
  while (stack.length) {
    const [node, p] = stack.pop();
    for (const s of (succMap.get(node) || [])) {
      if (visited.has(s)) {
        const cycleStart = p.indexOf(s);
        return p.slice(cycleStart).concat(s);
      }
      stack.push([s, p.concat(s)]);
      visited.add(s);
    }
  }
  return null;
}

/**
 * Detecta si agregar pred→succ crearía un ciclo.
 * @param {string} predId
 * @param {string} succId
 * @param {Dep[]} existingDeps
 * @param {Map<string,string>} taskNames  id→name
 * @returns {{hasCycle:boolean, chain:string}}
 */
export function detectCycle(predId, succId, existingDeps, taskNames) {
  const succMap = /** @type {Map<string,string[]>} */ (new Map());
  for (const d of existingDeps) {
    if (d.deleted_at) continue;
    if (!succMap.has(d.pred_id)) succMap.set(d.pred_id, []);
    succMap.get(d.pred_id).push(d.succ_id);
  }
  // Añadir la nueva relación temporalmente
  if (!succMap.has(predId)) succMap.set(predId, []);
  succMap.get(predId).push(succId);

  // ¿Hay algún camino de succId de vuelta a predId?
  const visited = new Set([succId]);
  const queue = [succId];
  while (queue.length) {
    const node = queue.shift();
    for (const s of (succMap.get(node) || [])) {
      if (s === predId) {
        // Reconstruir cadena
        const chain = _buildChain(predId, succId, succMap, taskNames);
        return { hasCycle: true, chain };
      }
      if (!visited.has(s)) { visited.add(s); queue.push(s); }
    }
  }
  return { hasCycle: false, chain: '' };
}

/** @param {string} from @param {string} to @param {Map<string,string[]>} sm @param {Map<string,string>} names */
function _buildChain(from, to, sm, names) {
  const getName = (id) => names?.get(id) ?? id.slice(0, 8);
  const path = [getName(from)];
  const queue = [[to, [getName(from), getName(to)]]];
  while (queue.length) {
    const [node, p] = queue.shift();
    if (node === from) return p.join(' → ');
    for (const s of (sm.get(node) || [])) {
      queue.push([s, p.concat(getName(s))]);
    }
  }
  return `${getName(from)} → … → ${getName(from)}`;
}

// ============================================================
// Orden topológico (Kahn)
// ============================================================

/**
 * @param {string[]} leafIds  solo tareas hoja (sin hijos)
 * @param {Dep[]} deps
 * @returns {{order:string[], cyclic:string[]}}
 */
export function topologicalSort(leafIds, deps) {
  const ids = new Set(leafIds);
  const inDeg = new Map(leafIds.map(id => [id, 0]));
  const succ  = new Map(leafIds.map(id => [id, /** @type {string[]} */ ([])]));

  for (const d of deps) {
    if (d.deleted_at) continue;
    if (!ids.has(d.pred_id) || !ids.has(d.succ_id)) continue;
    inDeg.set(d.succ_id, (inDeg.get(d.succ_id) ?? 0) + 1);
    succ.get(d.pred_id).push(d.succ_id);
  }

  const queue = leafIds.filter(id => inDeg.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of succ.get(id) ?? []) {
      const deg = (inDeg.get(s) ?? 0) - 1;
      inDeg.set(s, deg);
      if (deg === 0) queue.push(s);
    }
  }
  const orderSet = new Set(order);
  const cyclic = leafIds.filter(id => !orderSet.has(id));
  return { order, cyclic };
}

// ============================================================
// Algoritmo principal
// ============================================================

/**
 * Calcula CPM completo.
 *
 * @param {Task[]} allTasks   (incluyendo resúmenes y eliminadas lógicamente)
 * @param {Dep[]} allDeps
 * @param {any} calendar      instancia de Calendar
 * @param {Date} projectStart
 * @param {number|null} dataDateIdx  índice de la fecha de corte (null = sin corte)
 * @param {number} nearThreshold  umbral "casi crítica" (default 5)
 * @returns {CpmResult}
 */
export function computeCPM(allTasks, allDeps, calendar, projectStart, dataDateIdx = null, nearThreshold = 5) {
  /** @type {CpmWarning[]} */
  const warnings = [];

  // Filtrar activos
  const tasks = allTasks.filter(t => !t.deleted_at);
  const deps  = allDeps.filter(d => !d.deleted_at);

  // Conjunto de IDs activos
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  // Detectar tareas resumen (tienen al menos un hijo)
  const parentIds = new Set(tasks.map(t => t.parent_id).filter(Boolean));
  const isSummary = (id) => parentIds.has(id);

  // Tareas hoja (no son resumen ni eliminadas)
  const leafTasks = tasks.filter(t => !isSummary(t.id));

  // Dependencias solo entre hojas activas
  const leafIds = new Set(leafTasks.map(t => t.id));
  const leafDeps = deps.filter(d => leafIds.has(d.pred_id) && leafIds.has(d.succ_id));

  // --- Advertencias de calidad DCMA (se emiten pero no bloquean) ---
  _emitQualityWarnings(leafTasks, leafDeps, warnings);

  // --- Orden topológico ---
  const { order, cyclic } = topologicalSort([...leafIds], leafDeps);
  for (const id of cyclic) {
    warnings.push({ code: 'CICLO', task_id: id });
  }

  // --- Resultados parciales (índices CPM por tarea) ---
  /** @type {Map<string, {es:number, ef:number, ls:number, lf:number, tf:number|null, ff:number|null, is_critical:boolean|null, is_complete:boolean, trunc:boolean, oos:boolean}>} */
  const res = new Map();

  // --- PASO ADELANTE ---
  for (const id of order) {
    const task = taskMap.get(id);
    if (!task) continue;
    const dur = task.type === 'milestone' ? 0 : Math.max(0, task.duration_days ?? 1);
    const isComplete = task.percent_complete >= 100;
    const remaining  = isComplete ? 0 : dur * (1 - (task.percent_complete ?? 0) / 100);

    // ES inicial
    let es = 0;
    let forceES = false;    // si ya está fijado por inicio real
    let oos = false;        // FUERA_DE_SECUENCIA

    // Inicio real conocido
    if (task.actual_start) {
      const actualIdx = calendar.dateToIdx(new Date(task.actual_start + 'T00:00:00'), projectStart);
      es = actualIdx;
      forceES = true;
    }

    // Acumular restricciones de predecesoras
    let minEF = 0; // para tipos FF y SF que fuerzan EF directamente

    const incomingDeps = leafDeps.filter(d => d.succ_id === id);
    for (const dep of incomingDeps) {
      const pred = res.get(dep.pred_id);
      if (!pred) continue;
      const lag = dep.lag_days ?? 0;

      let requiredES = null;
      let requiredEF = null;
      let wouldBeNeg = false;

      switch (dep.type) {
        case 'FS':
          requiredES = pred.ef + lag;
          if (requiredES < 0) wouldBeNeg = true;
          break;
        case 'SS':
          requiredES = pred.es + lag;
          if (requiredES < 0) wouldBeNeg = true;
          break;
        case 'FF':
          requiredEF = pred.ef + lag;
          requiredES = requiredEF - dur;
          if (requiredES < 0) wouldBeNeg = true;
          break;
        case 'SF':
          requiredEF = pred.es + lag;
          requiredES = requiredEF - dur;
          if (requiredES < 0) wouldBeNeg = true;
          break;
      }

      if (wouldBeNeg) {
        warnings.push({ code: 'INICIO_RECORTADO', task_id: id, dep_id: dep.id });
      }

      if (requiredES !== null) {
        if (!forceES) es = Math.max(es, Math.max(0, requiredES));
        // Verificar FUERA_DE_SECUENCIA para tareas con inicio real
        if (forceES && requiredES > es) oos = true;
      }
      if (requiredEF !== null) {
        minEF = Math.max(minEF, Math.max(0, requiredEF));
      }
    }

    // Aplicar lógica retenida si FUERA_DE_SECUENCIA
    if (oos && dataDateIdx !== null) {
      warnings.push({ code: 'FUERA_DE_SECUENCIA', task_id: id });
      // Recalcular ES = max de las predecesoras normalmente (sin forzar)
      let latestPredEF = 0;
      for (const dep of incomingDeps) {
        const pred = res.get(dep.pred_id);
        if (!pred) continue;
        const lag = dep.lag_days ?? 0;
        switch (dep.type) {
          case 'FS': latestPredEF = Math.max(latestPredEF, pred.ef + lag); break;
          case 'SS': latestPredEF = Math.max(latestPredEF, pred.es + lag); break;
          case 'FF': latestPredEF = Math.max(latestPredEF, pred.ef + lag - dur); break;
          case 'SF': latestPredEF = Math.max(latestPredEF, pred.es + lag - dur); break;
        }
      }
      es = Math.max(0, latestPredEF);
    }

    // Aplicar restricciones de la tarea
    let ef = Math.max(es + dur, minEF);

    if (task.constraint_date && task.constraint_type !== 'ASAP' && task.constraint_type !== 'ALAP') {
      const cIdx = calendar.dateToIdx(new Date(task.constraint_date + 'T00:00:00'), projectStart);
      switch (task.constraint_type) {
        case 'SNET': if (es < cIdx) { es = cIdx; ef = es + dur; } break;
        case 'MSO':  es = cIdx; ef = es + dur; break;
        case 'FNET': if (ef < cIdx) { ef = cIdx; es = ef - dur; if (es < 0) es = 0; } break;
        case 'MFO':  ef = cIdx; es = Math.max(0, ef - dur); break;
        // SNLT y FNLT afectan solo el paso atrás; ALAP también
      }
    }

    // D4: ES nunca < 0
    if (es < 0) { es = 0; warnings.push({ code: 'INICIO_RECORTADO', task_id: id }); }
    ef = es + dur;

    // Con fecha de corte: tareas no iniciadas no pueden empezar antes del corte
    if (dataDateIdx !== null && !forceES) {
      if (es < dataDateIdx && !isComplete) {
        es = Math.max(es, dataDateIdx);
        ef = es + remaining;
      }
    }

    // Si la tarea está en curso: EF = corte + restante
    if (dataDateIdx !== null && task.actual_start && !task.actual_finish && !isComplete) {
      const actualIdx = calendar.dateToIdx(new Date(task.actual_start + 'T00:00:00'), projectStart);
      if (!oos) {
        es = Math.max(es, actualIdx);
        ef = Math.max(dataDateIdx, es) + remaining;
      } else {
        // Lógica retenida: espera a que terminen predecesoras
        ef = es + remaining;
      }
    }

    // Completada: usar fechas reales si disponibles
    if (isComplete && task.actual_finish) {
      const startIdx  = task.actual_start
        ? calendar.dateToIdx(new Date(task.actual_start + 'T00:00:00'), projectStart) : es;
      const finishIdx = calendar.dateToIdx(new Date(task.actual_finish + 'T00:00:00'), projectStart) + 1;
      es = startIdx;
      ef = finishIdx;
    }

    res.set(id, { es, ef, ls: 0, lf: 0, tf: null, ff: null, is_critical: null, is_complete: isComplete, trunc: false, oos });
  }

  // Longitud del proyecto = máximo EF de tareas hoja no completadas
  const activeDurations = [...res.values()].filter(r => !r.is_complete);
  const projectDuration = activeDurations.length
    ? Math.max(...activeDurations.map(r => r.ef))
    : Math.max(...[...res.values()].map(r => r.ef), 0);

  // --- PASO ATRÁS ---
  // Procesar en orden inverso al topológico
  for (const id of [...order].reverse()) {
    const r = res.get(id);
    if (!r) continue;
    if (r.is_complete) { r.ls = r.es; r.lf = r.ef; r.tf = null; continue; }

    const task = taskMap.get(id);
    const dur = task ? (task.type === 'milestone' ? 0 : Math.max(0, task.duration_days ?? 1)) : 0;

    let lf = projectDuration;

    // Restricciones de la tarea que afectan la pasada atrás
    if (task?.constraint_date) {
      switch (task.constraint_type) {
        case 'SNLT': {
          const cIdx = calendar.dateToIdx(new Date(task.constraint_date + 'T00:00:00'), projectStart);
          lf = Math.min(lf, cIdx + dur);
          break;
        }
        case 'FNLT': {
          const cIdx = calendar.dateToIdx(new Date(task.constraint_date + 'T00:00:00'), projectStart);
          lf = Math.min(lf, cIdx);
          break;
        }
        case 'MSO': {
          const cIdx = calendar.dateToIdx(new Date(task.constraint_date + 'T00:00:00'), projectStart);
          lf = Math.min(lf, cIdx + dur);
          break;
        }
        case 'MFO': {
          const cIdx = calendar.dateToIdx(new Date(task.constraint_date + 'T00:00:00'), projectStart);
          lf = Math.min(lf, cIdx);
          break;
        }
      }
    }

    // Restricciones desde sucesoras
    for (const dep of leafDeps) {
      if (dep.pred_id !== id) continue;
      const succ = res.get(dep.succ_id);
      if (!succ) continue;
      const lag = dep.lag_days ?? 0;

      switch (dep.type) {
        case 'FS': lf = Math.min(lf, succ.ls - lag); break;
        case 'SS': {
          const lsMax = succ.ls - lag;
          // ls de pred queda limitado por lsMax; lf = ls + dur
          const newLF = lsMax + dur;
          lf = Math.min(lf, newLF);
          break;
        }
        case 'FF': lf = Math.min(lf, succ.lf - lag); break;
        case 'SF': {
          const lsMax = succ.lf - lag;
          const newLF = lsMax + dur;
          lf = Math.min(lf, newLF);
          break;
        }
      }
    }

    const ls = lf - dur;
    r.lf = lf;
    r.ls = ls;
    r.tf = ls - r.es;
  }

  // --- HOLGURA LIBRE ---
  for (const id of order) {
    const r = res.get(id);
    if (!r || r.is_complete) { if (r) r.ff = null; continue; }
    const outgoing = leafDeps.filter(d => d.pred_id === id);
    if (!outgoing.length) {
      r.ff = r.tf;
      continue;
    }
    let minFF = r.tf ?? 0;
    for (const dep of outgoing) {
      const succ = res.get(dep.succ_id);
      if (!succ) continue;
      const lag = dep.lag_days ?? 0;
      let ff;
      switch (dep.type) {
        case 'FS': ff = succ.es - lag - r.ef; break;
        case 'SS': ff = succ.es - lag - r.es; break;
        case 'FF': ff = succ.ef - lag - r.ef; break;
        case 'SF': ff = succ.ef - lag - r.es; break;
        default:   ff = r.tf ?? 0;
      }
      minFF = Math.min(minFF, ff);
    }
    r.ff = Math.min(r.tf ?? 0, minFF);
  }

  // --- CRITICIDAD ---
  for (const r of res.values()) {
    if (r.is_complete) { r.is_critical = false; continue; }
    r.is_critical = (r.tf ?? 0) <= 0;
  }

  // --- Derivar tareas resumen (bottom-up) ---
  /** @type {Map<string, CpmTaskResult>} */
  const final = new Map();

  // Primero copiar resultados de hojas
  for (const [id, r] of res) {
    final.set(id, {
      id, es: r.es, ef: r.ef, ls: r.ls, lf: r.lf,
      tf: r.tf, ff: r.ff, is_critical: r.is_critical,
      is_summary: false, is_complete: r.is_complete
    });
  }

  // Calcular resúmenes en post-order (hijos antes que padres)
  const summaryIds = tasks.filter(t => isSummary(t.id)).map(t => t.id);
  // Ordenar por profundidad descendente (los más profundos primero)
  const depth = (id) => {
    let d = 0, cur = taskMap.get(id)?.parent_id;
    while (cur) { d++; cur = taskMap.get(cur)?.parent_id; }
    return d;
  };
  summaryIds.sort((a, b) => depth(b) - depth(a));

  for (const sumId of summaryIds) {
    const children = tasks.filter(t => t.parent_id === sumId);
    const childResults = children.map(c => final.get(c.id)).filter(Boolean);
    if (!childResults.length) continue;

    const activeChildren = childResults.filter(c => !c.is_complete);
    const allComplete   = activeChildren.length === 0;

    const es = Math.min(...childResults.map(c => c.es ?? Infinity));
    const ef = Math.max(...childResults.map(c => c.ef ?? -Infinity));
    const ls = allComplete ? es : Math.min(...activeChildren.map(c => c.ls ?? Infinity));
    const lf = allComplete ? ef : Math.max(...activeChildren.map(c => c.lf ?? -Infinity));
    const tf = allComplete ? null : Math.min(...activeChildren.map(c => c.tf ?? 0));
    const is_critical = allComplete ? false : activeChildren.some(c => c.is_critical);

    final.set(sumId, {
      id: sumId, es, ef, ls, lf, tf, ff: null,
      is_critical, is_summary: true, is_complete: allComplete
    });
  }

  return { tasks: final, warnings, projectDuration };
}

// ============================================================
// Advertencias de calidad
// ============================================================

/** @param {Task[]} leafTasks @param {Dep[]} leafDeps @param {CpmWarning[]} out */
function _emitQualityWarnings(leafTasks, leafDeps, out) {
  const predOf  = new Map(leafTasks.map(t => [t.id, []]));
  const succOf  = new Map(leafTasks.map(t => [t.id, []]));
  const depLagThreshold = 10;

  for (const d of leafDeps) {
    predOf.get(d.succ_id)?.push(d);
    succOf.get(d.pred_id)?.push(d);

    if ((d.lag_days ?? 0) < 0) {
      out.push({ code: 'LEAD', task_id: d.pred_id, dep_id: d.id });
    } else if ((d.lag_days ?? 0) > depLagThreshold) {
      out.push({ code: 'LAG_HIGH', task_id: d.pred_id, dep_id: d.id });
    }
  }

  const startIds = leafTasks.filter(t => (predOf.get(t.id)?.length ?? 0) === 0).map(t => t.id);
  const endIds   = leafTasks.filter(t => (succOf.get(t.id)?.length ?? 0) === 0).map(t => t.id);

  // Si hay más de una tarea "inicio" o "fin", las extras tienen lógica faltante
  if (startIds.length > 1) {
    for (const id of startIds.slice(1)) out.push({ code: 'NO_PRED', task_id: id });
  }
  if (endIds.length > 1) {
    for (const id of endIds.slice(1)) out.push({ code: 'NO_SUCC', task_id: id });
  }

  // Restricciones rígidas
  for (const t of leafTasks) {
    if (['SNLT','FNLT','MSO','MFO'].includes(t.constraint_type)) {
      out.push({ code: 'HARD_CONSTRAINT', task_id: t.id });
    }
  }
}
