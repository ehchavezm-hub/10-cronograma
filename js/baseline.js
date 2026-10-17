// @ts-check
/**
 * baseline.js — Gestión de líneas base (baselines).
 *
 * Inspirado en MS Project (hasta 11 baselines, doble barra, columnas varianza)
 * y Primavera P6 (línea base primaria, semáforo de desvío, BL columns).
 *
 * Esquema IndexedDB:
 *   baselines      { id, project_id, name, created_at, is_active, is_primary }
 *   baseline_tasks { id, baseline_id, task_id, es, ef, dur }
 */

import { put, getAll, remove } from './storage.js?v=4';
import { appState } from './state.js';

// ---- Guardar línea base ----

/**
 * Guarda una nueva línea base con los datos CPM actuales.
 * @param {string} name — Nombre de la línea base
 * @returns {Promise<string>} — ID de la línea base creada
 */
export async function saveBaseline(name) {
  const { project, cpmResult } = appState.state;
  if (!project) throw new Error('No hay proyecto activo');
  if (!cpmResult) throw new Error('CPM no calculado aún');

  const baselineId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Registro principal
  await put('baselines', {
    id:         baselineId,
    project_id: project.id,
    name:       name.trim() || `Línea base ${now.slice(0, 10)}`,
    created_at: now,
    is_active:  true,
    is_primary: false,
  });

  // Guardar ES/EF por tarea desde el resultado CPM
  const taskRows = [];
  for (const [taskId, cpm] of cpmResult.tasks) {
    if (cpm.es == null) continue;
    taskRows.push({
      id:          crypto.randomUUID(),
      baseline_id: baselineId,
      task_id:     taskId,
      es:          cpm.es,
      ef:          cpm.ef,
      dur:         cpm.dur,
    });
  }

  for (const row of taskRows) await put('baseline_tasks', row);

  return baselineId;
}

// ---- Listar líneas base del proyecto ----

/**
 * @param {string} projectId
 * @returns {Promise<Array<{id:string, name:string, created_at:string, is_active:boolean}>>}
 */
export async function listBaselines(projectId) {
  const all = await getAll('baselines');
  return all
    .filter(b => b.project_id === projectId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// ---- Cargar datos de una línea base ----

/**
 * @param {string} baselineId
 * @returns {Promise<Map<string, {es:number, ef:number, dur:number}>>}
 */
export async function loadBaselineData(baselineId) {
  const all = await getAll('baseline_tasks');
  const map = new Map();
  for (const row of all) {
    if (row.baseline_id === baselineId) {
      map.set(row.task_id, { es: row.es, ef: row.ef, dur: row.dur });
    }
  }
  return map;
}

// ---- Eliminar línea base ----

/** @param {string} baselineId */
export async function deleteBaseline(baselineId) {
  await remove('baselines', baselineId);
  // Eliminar las tareas asociadas
  const all = await getAll('baseline_tasks');
  for (const row of all) {
    if (row.baseline_id === baselineId) await remove('baseline_tasks', row.id);
  }
}

// ---- Línea base primaria (P6: Primary Baseline) ----

/**
 * Designa una línea base como primaria (plan aprobado oficial).
 * Solo puede haber una por proyecto.
 * @param {string} projectId
 * @param {string} baselineId  — null para desmarcar todas
 */
export async function setPrimaryBaseline(projectId, baselineId) {
  const all = await getAll('baselines');
  for (const b of all) {
    if (b.project_id !== projectId) continue;
    if (b.is_primary !== (b.id === baselineId)) {
      await put('baselines', { ...b, is_primary: b.id === baselineId });
    }
  }
}

/**
 * Obtiene una línea base por ID.
 * @param {string} baselineId
 * @returns {Promise<{id:string, name:string, created_at:string, is_active:boolean, is_primary:boolean}|null>}
 */
export async function getBaseline(baselineId) {
  const all = await getAll('baselines');
  return all.find(b => b.id === baselineId) ?? null;
}
