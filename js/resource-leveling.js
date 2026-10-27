// @ts-check
/**
 * resource-leveling.js — Detección y nivelación de recursos sobreasignados.
 *
 * Pure computation module — no imports, no side effects.
 * Trabaja con índices de días laborables del CPM.
 */

/**
 * @typedef {{ id: string, name: string, max_units: number }} Resource
 * @typedef {{ id: string, task_id: string, resource_id: string, units: number }} TaskResource
 * @typedef {{ es: number, ef: number, ls: number, lf: number, tf: number, dur: number }} CpmTask
 */

/**
 * Detecta sobreasignación de recursos por día.
 * @param {object[]} tasks
 * @param {Map<string, CpmTask>} cpmTasks
 * @param {Resource[]} resources
 * @param {TaskResource[]} taskResources
 * @returns {{ overloaded: Array<{resource: Resource, day: number, load: number, capacity: number, taskIds: string[]}> }}
 */
/** Solo mano de obra y equipos tienen capacidad diaria; materiales y costos no se nivelan. */
function _withCapacity(resources, taskResources) {
  const res = resources.filter(r => r.type !== 'material' && r.type !== 'cost');
  const ids = new Set(res.map(r => r.id));
  return { res, trs: taskResources.filter(tr => ids.has(tr.resource_id)) };
}

export function detectOverAllocation(tasks, cpmTasks, resources, taskResources) {
  ({ res: resources, trs: taskResources } = _withCapacity(resources, taskResources));
  if (!cpmTasks || !resources.length || !taskResources.length) return { overloaded: [] };

  const resMap = new Map(resources.map(r => [r.id, r]));
  // resourceId → day → { load, taskIds }
  /** @type {Map<string, Map<number, { load: number, taskIds: string[] }>>} */
  const timeline = new Map();

  const taskMap = new Map(tasks.map(t => [t.id, t]));

  for (const tr of taskResources) {
    const cpm = cpmTasks.get(tr.task_id);
    if (!cpm) continue;
    const task = taskMap.get(tr.task_id);
    if (task?.type === 'summary' || cpm?.is_summary) continue;
    const units = tr.units || 1;

    if (!timeline.has(tr.resource_id)) timeline.set(tr.resource_id, new Map());
    const dayMap = /** @type {Map<number, { load: number, taskIds: string[] }>} */ (timeline.get(tr.resource_id));

    for (let day = cpm.es; day < cpm.ef; day++) {
      if (!dayMap.has(day)) dayMap.set(day, { load: 0, taskIds: [] });
      const entry = /** @type {{ load: number, taskIds: string[] }} */ (dayMap.get(day));
      entry.load += units;
      entry.taskIds.push(tr.task_id);
    }
  }

  /** @type {Array<{resource: Resource, day: number, load: number, capacity: number, taskIds: string[]}>} */
  const overloaded = [];

  for (const [resId, dayMap] of timeline) {
    const res = resMap.get(resId);
    if (!res) continue;
    for (const [day, entry] of dayMap) {
      if (entry.load > res.max_units + 0.001) {
        overloaded.push({ resource: res, day, load: entry.load, capacity: res.max_units, taskIds: [...entry.taskIds] });
      }
    }
  }

  overloaded.sort((a, b) => a.day - b.day || a.resource.name.localeCompare(b.resource.name));
  return { overloaded };
}

/**
 * Nivela recursos retrasando tareas menos críticas.
 * Retorna sugerencias de retraso (días) — NO modifica appState.
 * @param {object[]} tasks
 * @param {Map<string, CpmTask>} cpmTasks
 * @param {Resource[]} resources
 * @param {TaskResource[]} taskResources
 * @returns {{ taskId: string, delayDays: number }[]}
 */
export function levelResources(tasks, cpmTasks, resources, taskResources) {
  ({ res: resources, trs: taskResources } = _withCapacity(resources, taskResources));
  if (!cpmTasks || !resources.length || !taskResources.length) return [];

  const resMap = new Map(resources.map(r => [r.id, r]));

  // Agrupar task_resources por tarea
  /** @type {Map<string, { resourceId: string, units: number }[]>} */
  const taskRes = new Map();
  for (const tr of taskResources) {
    if (!taskRes.has(tr.task_id)) taskRes.set(tr.task_id, []);
    taskRes.get(tr.task_id)?.push({ resourceId: tr.resource_id, units: tr.units || 1 });
  }

  // Filtrar tareas no-summary con CPM y recursos
  const workTasks = tasks
    .filter(t => t.type !== 'summary' && !cpmTasks.get(t.id)?.is_summary && cpmTasks.has(t.id) && taskRes.has(t.id) && (t.percent_complete ?? 0) < 100)
    .map(t => {
      const cpm = /** @type {CpmTask} */ (cpmTasks.get(t.id));
      return { id: t.id, es: cpm.es, ef: cpm.ef, dur: cpm.ef - cpm.es, tf: cpm.tf ?? 0 };
    })
    .sort((a, b) => a.es - b.es || b.tf - a.tf); // mismo inicio → más holgura primero

  // Timeline: resourceId → day → carga actual
  /** @type {Map<string, Map<number, number>>} */
  const load = new Map();
  const getLoad = (resId, day) => load.get(resId)?.get(day) ?? 0;
  const addLoad = (resId, day, units) => {
    if (!load.has(resId)) load.set(resId, new Map());
    const m = /** @type {Map<number, number>} */ (load.get(resId));
    m.set(day, (m.get(day) ?? 0) + units);
  };

  /** @type {{ taskId: string, delayDays: number }[]} */
  const delays = [];

  for (const t of workTasks) {
    const ress = taskRes.get(t.id) ?? [];

    // Encontrar el primer día donde esta tarea cabe sin sobrepasar capacidad
    let startDay = t.es;
    const maxSearch = t.es + (t.tf || 0) + t.dur + 1000;

    while (startDay < maxSearch) {
      let fits = true;
      for (const { resourceId, units } of ress) {
        const res = resMap.get(resourceId);
        if (!res) continue;
        for (let day = startDay; day < startDay + t.dur; day++) {
          if (getLoad(resourceId, day) + units > res.max_units + 0.001) {
            fits = false;
            break;
          }
        }
        if (!fits) break;
      }
      if (fits) break;
      startDay++;
    }

    // Registrar uso
    for (const { resourceId, units } of ress) {
      for (let day = startDay; day < startDay + t.dur; day++) {
        addLoad(resourceId, day, units);
      }
    }

    if (startDay !== t.es) {
      delays.push({ taskId: t.id, delayDays: startDay - t.es });
    }
  }

  return delays;
}

/**
 * Resumen de utilización de recursos.
 * @param {object[]} tasks
 * @param {Map<string, CpmTask>} cpmTasks
 * @param {Resource[]} resources
 * @param {TaskResource[]} taskResources
 * @returns {{ resource: Resource, maxLoad: number, avgLoad: number, overloadedDays: number }[]}
 */
/** Alias for backwards compatibility with main.js import */
export const detectConflicts = detectOverAllocation;

export function getResourceUtilization(tasks, cpmTasks, resources, taskResources) {
  if (!cpmTasks || !resources.length) return [];

  const resMap = new Map(resources.map(r => [r.id, r]));
  /** @type {Map<string, Map<number, number>>} */
  const timeline = new Map();

  const taskMapU = new Map(tasks.map(t => [t.id, t]));

  for (const tr of taskResources) {
    const cpm = cpmTasks.get(tr.task_id);
    if (!cpm) continue;
    const task = taskMapU.get(tr.task_id);
    if (task?.type === 'summary' || cpm?.is_summary) continue;

    if (!timeline.has(tr.resource_id)) timeline.set(tr.resource_id, new Map());
    const dayMap = /** @type {Map<number, number>} */ (timeline.get(tr.resource_id));
    const units = tr.units || 1;
    for (let day = cpm.es; day < cpm.ef; day++) {
      dayMap.set(day, (dayMap.get(day) ?? 0) + units);
    }
  }

  return resources.map(res => {
    const dayMap = timeline.get(res.id);
    if (!dayMap || dayMap.size === 0) return { resource: res, maxLoad: 0, avgLoad: 0, overloadedDays: 0 };
    const loads = [...dayMap.values()];
    const maxLoad = Math.max(...loads);
    const avgLoad = loads.reduce((s, v) => s + v, 0) / loads.length;
    const overloadedDays = loads.filter(v => v > res.max_units + 0.001).length;
    return { resource: res, maxLoad, avgLoad, overloadedDays };
  });
}
