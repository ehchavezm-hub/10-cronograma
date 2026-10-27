// @ts-check
/**
 * demo-seed.js — Carga el proyecto DEMO completo en la base local.
 *
 * Se regenera (con fechas al día) cuando: no existe, fue eliminado, cambió
 * DEMO_VERSION o pasaron más de DEMO_MAX_AGE_DAYS desde la última vez.
 * Solo toca registros del DEMO; nunca los proyectos del usuario.
 */

import { buildDemoData, DEMO_VERSION, PROJ_ID, CAL_ID } from './demo-data.js?v=5';
import { listAllProjects, saveProjectSnapshot, getAll, put, putMany, remove, getMeta, setMeta,
  savePortfolio, saveProgram } from './storage.js';
import { seedChangeLog } from './change-log.js';

const DEMO_MAX_AGE_DAYS = 45;
const LS_KEYS = { plan: 'ecm-lad-plan', ppc: 'ecm-lad-ppc', rests: 'ecm-lad-rest', meta: 'ecm-lad-meta', standup: 'ecm-lad-standup' };

/** @param {string} key @param {any} value */
function _setForDemo(key, value) {
  try {
    const all = JSON.parse(localStorage.getItem(key) || '{}');
    all[PROJ_ID] = value;
    localStorage.setItem(key, JSON.stringify(all));
  } catch { /* almacenamiento no disponible */ }
}

/** @param {string} store @param {(r: any) => boolean} match */
async function _removeWhere(store, match) {
  const rows = await getAll(store).catch(() => []);
  await Promise.all(rows.filter(match).map(r => remove(store, r.id)));
}

/**
 * Garantiza que el DEMO exista y esté vigente. Devuelve el proyecto DEMO.
 * @returns {Promise<any>}
 */
export async function ensureDemoData() {
  const demo = buildDemoData();
  const all = await listAllProjects();
  const rec = all.find(p => p.id === PROJ_ID);
  const seed = await getMeta('demo-seed').catch(() => null);
  const ageDays = seed?.anchor ? (Date.now() - new Date(seed.anchor + 'T00:00:00').getTime()) / 86400000 : Infinity;
  const taskCount = rec ? (await getAll('tasks').catch(() => [])).filter(t => t.project_id === PROJ_ID && !t.deleted_at).length : 0;
  const stale = !rec || rec.deleted_at || seed?.version !== DEMO_VERSION || ageDays > DEMO_MAX_AGE_DAYS || taskCount !== demo.tasks.length;

  if (stale) {
    // Limpiar los registros anteriores del DEMO (las tareas y dependencias las reemplaza el snapshot)
    const blIds = new Set((await getAll('baselines').catch(() => [])).filter(b => b.project_id === PROJ_ID).map(b => b.id));
    await _removeWhere('baseline_tasks', r => blIds.has(r.baseline_id));
    await _removeWhere('baselines', r => r.project_id === PROJ_ID);
    await _removeWhere('calendar_exceptions', r => r.calendar_id === CAL_ID);
    await _removeWhere('task_resources', r => r.project_id === PROJ_ID);
    await _removeWhere('resources', r => r.project_id === PROJ_ID);
    await _removeWhere('risks', r => r.project_id === PROJ_ID);

    await saveProjectSnapshot(demo);
    await putMany('calendars', demo.calendars);
    await putMany('resources', demo.resources);
    await putMany('task_resources', demo.task_resources);
    await putMany('baselines', demo.baselines);
    await putMany('baseline_tasks', demo.baseline_tasks);
    await putMany('risks', demo.risks);
    await put('organizations', demo.organization);
    await savePortfolio(demo.portfolio);
    await saveProgram(demo.program);

    _setForDemo(LS_KEYS.plan, demo.lps.plan);
    _setForDemo(LS_KEYS.ppc, demo.lps.ppc);
    _setForDemo(LS_KEYS.rests, demo.lps.rests);
    _setForDemo(LS_KEYS.meta, demo.lps.meta);
    _setForDemo(LS_KEYS.standup, demo.lps.standup);

    await setMeta('demo-seed', { version: DEMO_VERSION, anchor: demo.project.settings.demo_anchor });
  }

  seedChangeLog(demo.changeLog, PROJ_ID);
  return demo.project;
}
