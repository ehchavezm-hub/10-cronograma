// monte-carlo.worker.js — Web Worker para simulación de riesgos Monte Carlo.
// NO usa ES module imports (contexto de worker clásico).
//
// Recibe: { tasks, deps, calendar_def, iterations, seed }
//   tasks: [{id, es, ef, dur, is_critical, three_point:{optimistic,most_likely,pessimistic}}]
//   deps:  [{predecessor_id, successor_id, type, lag}]
//   calendar_def: {work_week:number[], exceptions:[]}
//   iterations: number (1000–10000)
//   seed: number (opcional, para reproducibilidad)
//
// Emite durante la ejecución:
//   { type:'progress', percent }
// Emite al terminar:
//   { type:'result', results:[{id,p50,p80,p90,mean,std}], project_p50, project_p80, project_p90 }

// ─── Generador LCG (reproducible) ────────────────────────────────────────────
function makePrng(seed) {
  let s = (seed >>> 0) || 0x12345678;
  return function () {
    // Park-Miller LCG
    s = Math.imul(s, 1664525) + 1013904223;
    s >>>= 0;
    return s / 0x100000000;
  };
}

// ─── Distribución PERT / Beta (alpha=4, beta=4) ──────────────────────────────
// Usamos el método de aproximación de Box-Muller sobre Beta(4,4) centrada.
// Beta(4,4) tiene media=0.5, var=1/36.
// Aproximamos muestreando via suma de variables uniformes (método de Jöhnk
// generalizado simplificado): X = suma de 8 uniformes / 8.
// Esto da una Beta(4,4) aproximada satisfactoria para simulación de cronogramas.

/**
 * Muestrea de la distribución PERT.
 * @param {number} o  optimista
 * @param {number} m  más probable (moda)
 * @param {number} p  pesimista
 * @param {()=>number} rng  devuelve uniform[0,1)
 * @returns {number}
 */
function samplePERT(o, m, p, rng) {
  if (o === m && m === p) return o;

  // Media PERT clásica
  const mu = (o + 4 * m + p) / 6;
  // Desv. std PERT clásica
  const sigma = (p - o) / 6;
  if (sigma <= 0) return mu;

  // Beta(4,4): suma de 8 U[0,1) / 8 ≈ distribución simétrica centrada en 0.5
  // Para PERT ajustamos la moda: usamos la transformación estándar.
  // Parámetros de la beta generalizada a partir de (o, m, p):
  //   alpha = 1 + 4*(m-o)/(p-o)
  //   beta  = 1 + 4*(p-m)/(p-o)
  // Muestreo de Beta(alpha, beta) via método de Johnk: aceptar-rechazar sobre
  // pares (u^(1/alpha), v^(1/beta)) hasta u^alpha + v^beta <= 1.
  // Para alpha,beta >= 1 esto converge rápido (media de aceptación OK).

  const a = 1 + 4 * (m - o) / (p - o);
  const b = 1 + 4 * (p - m) / (p - o);

  let x;
  // Método de Johnk para Beta(a,b) cuando a,b en rango razonable (1-5)
  let attempts = 0;
  while (true) {
    const u = rng();
    const v = rng();
    const xa = Math.pow(u, 1 / a);
    const xb = Math.pow(v, 1 / b);
    const s = xa + xb;
    if (s <= 1) {
      x = xa / s;
      break;
    }
    attempts++;
    if (attempts > 500) {
      // Fallback a la media PERT
      x = (a - 1) / (a + b - 2);
      break;
    }
  }

  return o + x * (p - o);
}

// ─── Forward pass CPM simplificado ───────────────────────────────────────────
/**
 * Ejecuta el forward pass sobre las tareas con duraciones muestreadas.
 * Solo soporta FS (Finish-to-Start) con lag; tipos SS/FF/SF se ignoran (lag 0 FS).
 *
 * @param {Array<{id:string, es:number, dur:number}>} tasks
 * @param {Array<{predecessor_id:string, successor_id:string, type:string, lag:number}>} deps
 * @param {Map<string,number>} sampledDurs  id → duración muestreada
 * @returns {{ efMap: Map<string,number>, projectFinish: number }}
 */
function forwardPass(tasks, deps, sampledDurs) {
  // Construir mapa id → task info
  /** @type {Map<string,{es:number, dur:number}>} */
  const taskMap = new Map();
  for (const t of tasks) {
    taskMap.set(t.id, { es: t.es ?? 0, dur: sampledDurs.get(t.id) ?? t.dur });
  }

  // Construir lista de predecesores por sucesor
  /** @type {Map<string, Array<{predId:string, type:string, lag:number}>>} */
  const predMap = new Map();
  for (const d of deps) {
    if (!predMap.has(d.successor_id)) predMap.set(d.successor_id, []);
    predMap.get(d.successor_id).push({ predId: d.predecessor_id, type: d.type, lag: d.lag ?? 0 });
  }

  // Orden topológico (Kahn)
  /** @type {Map<string,number>} in-degree */
  const inDeg = new Map();
  /** @type {Map<string, string[]>} successors */
  const succMap = new Map();
  for (const t of tasks) {
    inDeg.set(t.id, 0);
    succMap.set(t.id, []);
  }
  for (const d of deps) {
    inDeg.set(d.successor_id, (inDeg.get(d.successor_id) ?? 0) + 1);
    const arr = succMap.get(d.predecessor_id);
    if (arr) arr.push(d.successor_id);
  }

  const queue = [];
  for (const [id, deg] of inDeg) {
    if (deg === 0) queue.push(id);
  }

  /** @type {Map<string,number>} EF por tarea */
  const efMap = new Map();
  // ES inicial desde el dato de la tarea
  const esMap = new Map();
  for (const t of tasks) esMap.set(t.id, t.es ?? 0);

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    const info = taskMap.get(id);
    if (!info) continue;

    const es = esMap.get(id) ?? 0;
    const ef = es + (sampledDurs.get(id) ?? info.dur);
    efMap.set(id, ef);

    // Actualizar ES de sucesores
    const preds = predMap; // ya reconstruido
    for (const succId of (succMap.get(id) ?? [])) {
      // encontrar la relación específica
      // Procesamos el EF de este pred sobre cada sucesor
      const succPreds = predMap.get(succId) ?? [];
      for (const rel of succPreds) {
        if (rel.predId !== id) continue;
        let minES;
        const type = rel.type ?? 'FS';
        if (type === 'FS') {
          minES = ef + rel.lag;
        } else if (type === 'SS') {
          minES = es + rel.lag;
        } else if (type === 'FF') {
          const succInfo = taskMap.get(succId);
          const succDur = succInfo ? (sampledDurs.get(succId) ?? succInfo.dur) : 0;
          minES = ef + rel.lag - succDur;
        } else if (type === 'SF') {
          const succInfo = taskMap.get(succId);
          const succDur = succInfo ? (sampledDurs.get(succId) ?? succInfo.dur) : 0;
          minES = es + rel.lag - succDur;
        } else {
          minES = ef + rel.lag;
        }
        if (minES < 0) minES = 0;
        const cur = esMap.get(succId) ?? 0;
        if (minES > cur) esMap.set(succId, minES);
      }

      const succDeg = (inDeg.get(succId) ?? 1) - 1;
      inDeg.set(succId, succDeg);
      if (succDeg === 0) queue.push(succId);
    }
  }

  // Cualquier tarea no procesada (ciclo) conserva su EF original
  for (const t of tasks) {
    if (!efMap.has(t.id)) {
      efMap.set(t.id, (esMap.get(t.id) ?? t.es ?? 0) + (sampledDurs.get(t.id) ?? t.dur));
    }
  }

  // Proyecto termina en el máximo EF de tareas sin sucesores
  const hasSucc = new Set();
  for (const d of deps) hasSucc.add(d.predecessor_id);

  let projectFinish = 0;
  for (const t of tasks) {
    if (!hasSucc.has(t.id)) {
      const ef = efMap.get(t.id) ?? 0;
      if (ef > projectFinish) projectFinish = ef;
    }
  }
  // Si todas tienen sucesores (raro), tomar el máximo global
  if (projectFinish === 0) {
    for (const ef of efMap.values()) {
      if (ef > projectFinish) projectFinish = ef;
    }
  }

  return { efMap, projectFinish };
}

// ─── Percentil (interpolación lineal) ────────────────────────────────────────
/**
 * @param {number[]} sorted  valores ordenados ascendente
 * @param {number} p  percentil 0–100
 * @returns {number}
 */
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

// ─── Estadísticas básicas ─────────────────────────────────────────────────────
function stats(arr) {
  const n = arr.length;
  if (n === 0) return { mean: 0, std: 0 };
  const mean = arr.reduce((s, v) => s + v, 0) / n;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

// ─── Handler principal ────────────────────────────────────────────────────────
self.onmessage = function (e) {
  const { tasks, deps, calendar_def, iterations = 1000, seed } = e.data;

  const rng = makePrng(seed);
  const N = Math.max(100, Math.min(20000, iterations));

  // Acumuladores: por tarea → array de EF muestreados
  /** @type {Map<string, number[]>} */
  const taskEFs = new Map();
  for (const t of tasks) taskEFs.set(t.id, []);

  /** @type {number[]} */
  const projectFinishes = [];

  const PROGRESS_EVERY = 100;

  for (let i = 0; i < N; i++) {
    // 1. Muestrear duración de cada tarea
    const sampledDurs = new Map();
    for (const t of tasks) {
      let dur;
      const tp = t.three_point;
      if (tp && tp.optimistic != null && tp.most_likely != null && tp.pessimistic != null) {
        dur = samplePERT(tp.optimistic, tp.most_likely, tp.pessimistic, rng);
        // Duración mínima = 0
        if (dur < 0) dur = 0;
      } else {
        dur = t.dur ?? 0;
      }
      sampledDurs.set(t.id, dur);
    }

    // 2. Forward pass
    const { efMap, projectFinish } = forwardPass(tasks, deps, sampledDurs);

    // 3. Acumular
    for (const t of tasks) {
      taskEFs.get(t.id).push(efMap.get(t.id) ?? 0);
    }
    projectFinishes.push(projectFinish);

    // 4. Progreso
    if ((i + 1) % PROGRESS_EVERY === 0 || i === N - 1) {
      self.postMessage({ type: 'progress', percent: Math.round(((i + 1) / N) * 100) });
    }
  }

  // 5. Calcular estadísticas por tarea
  const results = [];
  for (const t of tasks) {
    const arr = taskEFs.get(t.id) ?? [];
    const sorted = arr.slice().sort((a, b) => a - b);
    const { mean, std } = stats(arr);
    results.push({
      id: t.id,
      p50: percentile(sorted, 50),
      p80: percentile(sorted, 80),
      p90: percentile(sorted, 90),
      mean,
      std,
    });
  }

  // 6. Estadísticas del proyecto
  const pSorted = projectFinishes.slice().sort((a, b) => a - b);
  const { mean: pMean, std: pStd } = stats(projectFinishes);

  self.postMessage({
    type: 'result',
    results,
    project_p50: percentile(pSorted, 50),
    project_p80: percentile(pSorted, 80),
    project_p90: percentile(pSorted, 90),
    project_mean: pMean,
    project_std: pStd,
    project_finishes: pSorted,  // para el histograma
  });
};
