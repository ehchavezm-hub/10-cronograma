// @ts-check
/**
 * baseline-compare.js — Gestión del modo "Comparar con Línea Base".
 *
 * Activa/desactiva la doble barra en el Gantt cargando datos de una
 * línea base específica en appState.baselineData / appState.baselineMeta.
 *
 * La renderización ya está implementada en gantt-canvas.js (_drawBars).
 * Este módulo solo gestiona la carga y el estado.
 */

import { appState }      from './state.js';
import { listBaselines, loadBaselineData, getBaseline } from './baseline.js';

// ---- Estado interno ----

let _enabled = false;
let _activeBaselineId = /** @type {string|null} */ (null);
let _watchedProjectId = /** @type {string|null} */ (null);

// Reset comparison when the active project changes
appState.subscribe(state => {
  const pid = state.project?.id ?? null;
  if (pid !== _watchedProjectId) {
    _watchedProjectId = pid;
    if (_enabled) disableBaselineCompare();
  }
});

// ---- API pública ----

/** @returns {boolean} */
export function isBaselineCompareEnabled() {
  return _enabled;
}

/** @returns {string|null} ID de la línea base activa */
export function getActiveBaselineId() {
  return _activeBaselineId;
}

/**
 * Activa la comparación contra una línea base concreta.
 * @param {string} baselineId
 * @returns {Promise<void>}
 */
export async function enableBaselineCompare(baselineId) {
  const data = await loadBaselineData(baselineId);
  const meta = await getBaseline(baselineId);
  if (!meta) throw new Error('Línea base no encontrada: ' + baselineId);

  appState.setBaselineData(data);
  appState.setBaselineMeta({ id: meta.id, name: meta.name, isPrimary: !!meta.is_primary });

  _activeBaselineId = baselineId;
  _enabled = true;
}

/**
 * Desactiva la comparación (oculta la barra de línea base).
 */
export function disableBaselineCompare() {
  _enabled = false;
  _activeBaselineId = null;
  appState.setBaselineData(null);
  appState.setBaselineMeta(null);
}

/**
 * Alterna comparación: si está activa la desactiva, si no la activa con
 * la línea base especificada.
 * @param {string} baselineId
 * @returns {Promise<boolean>} nuevo estado (true = activo)
 */
export async function toggleBaselineCompare(baselineId) {
  if (_enabled && _activeBaselineId === baselineId) {
    disableBaselineCompare();
    return false;
  }
  await enableBaselineCompare(baselineId);
  return true;
}

/**
 * Devuelve la lista de líneas base del proyecto activo.
 * @returns {Promise<Array<{id:string, name:string, created_at:string, is_active:boolean, is_primary:boolean}>>}
 */
export async function getProjectBaselines() {
  const { project } = appState.state;
  if (!project) return [];
  return listBaselines(project.id);
}

/**
 * Devuelve los datos de línea base para una tarea específica.
 * @param {string} taskId
 * @returns {{es:number, ef:number, dur:number}|null}
 */
export function getBaselineBar(taskId) {
  if (!_enabled) return null;
  const data = appState.state.baselineData;
  if (!data) return null;
  return data.get(taskId) ?? null;
}
