// @ts-check
/**
 * state.js — Estado global de la aplicación.
 *
 * Patrón: estado inmutable + comandos con undo/redo (≥ 50 pasos).
 * La interfaz nunca modifica datos directamente; envía comandos.
 * Cada comando es reversible; deshacer un cmd ya sincronizado genera
 * una operación inversa nueva en la cola (no reescribe el historial).
 */

import { detectCycle } from './cpm.js';
import { t } from './i18n.js';

const MAX_UNDO = 50;

// ============================================================
// Estructura del estado
// ============================================================

/**
 * @typedef {Object} AppState
 * @property {Project|null}    project
 * @property {Map<string,Task>}  tasks
 * @property {Map<string,Dep>}   deps
 * @property {Calendar_|null}  calendar
 * @property {CalEx[]}         calExceptions
 * @property {CpmResult_|null} cpmResult
 * @property {boolean}         cpmDirty
 * @property {string|null}     selectedTaskId
 * @property {Set<string>}     expandedIds
 * @property {string}          syncStatus   'local'|'synced'|'syncing'|'offline'|'conflict'
 * @property {number}          outboxCount
 * @property {boolean}         autoCalc
 * @property {number}          nearThreshold
 * @property {Map<string,{es:number,ef:number,dur:number}>|null} baselineData
 * @property {{id:string,name:string,isPrimary:boolean}|null} baselineMeta
 */

/** @typedef {import('./calendar.js').Calendar} Calendar_ */
/** @typedef {{id:string,name:string,code:string,start_date:string,calendar_id:string|null,data_date:string|null,settings:object,org_id:string,deleted_at:string|null}} Project */
/** @typedef {import('./cpm.js').CpmResult} CpmResult_ */

// ---- Tipos de tareas y dependencias ----
/** @typedef {{id:string,org_id:string,project_id:string,parent_id:string|null,sort_order:number,name:string,type:'task'|'milestone'|'summary',duration_days:number,work_hours:number,percent_complete:number,actual_start:string|null,actual_finish:string|null,constraint_type:string,constraint_date:string|null,planned_cost:number,actual_cost:number,notes:string|null,deleted_at:string|null}} Task */
/** @typedef {{id:string,org_id:string,project_id:string,pred_id:string,succ_id:string,type:string,lag_days:number,deleted_at:string|null}} Dep */
/** @typedef {{id:string,org_id:string,project_id:string|null,name:string,work_week:number[],hours_per_day:number,deleted_at:string|null}} Calendar_ */
/** @typedef {{id:string,org_id:string,calendar_id:string,on_date:string,is_working:boolean,name:string|null,deleted_at:string|null}} CalEx */

// ============================================================
// Clase principal
// ============================================================

export class AppStateManager {
  constructor() {
    /** @type {AppState} */
    this._state = {
      project:       null,
      tasks:         new Map(),
      deps:          new Map(),
      calendar:      null,
      calExceptions: [],
      cpmResult:     null,
      cpmDirty:      true,
      selectedTaskId: null,
      expandedIds:   new Set(),
      syncStatus:    'local',
      outboxCount:   0,
      autoCalc:      true,
      nearThreshold: 5,
      /** @type {Map<string,{es:number,ef:number,dur:number}>|null} */
      baselineData:  null,
      /** @type {{id:string, name:string, isPrimary:boolean}|null} */
      baselineMeta:  null,
    };

    /** @type {Array<{cmd:Command, inverse:Command}>} */
    this._past   = [];
    /** @type {Array<{cmd:Command, inverse:Command}>} */
    this._future = [];

    /** @type {Set<Function>} */
    this._listeners = new Set();

    /** @type {Function|null} cpm runner (set by main.js) */
    this.onRequestCpm = null;

    /** @type {Function|null} storage flush */
    this.onPersist = null;
  }

  get state() { return this._state; }

  // ---- Suscripción ----
  /** @param {Function} fn */
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  _notify(changedKeys = []) {
    for (const fn of this._listeners) fn(this._state, changedKeys);
  }

  // ---- Dispatch ----
  /**
   * Ejecuta un comando y guarda su inverso para undo.
   * @param {Command} cmd
   * @returns {boolean} éxito
   */
  dispatch(cmd) {
    const result = this._exec(cmd);
    if (!result.ok) {
      console.warn('[state] dispatch rejected:', result.error);
      return false;
    }
    this._past.push({ cmd, inverse: result.inverse });
    if (this._past.length > MAX_UNDO) this._past.shift();
    this._future = [];    // nueva acción limpia el redo
    this._markDirty(cmd);
    this._notify(result.changed);
    if (this._state.autoCalc && this._state.cpmDirty) {
      this.onRequestCpm?.();
    }
    this.onPersist?.({ cmd, inverse: result.inverse });
    return true;
  }

  undo() {
    if (!this._past.length) return false;
    const { inverse, cmd } = this._past.pop();
    const result = this._exec(inverse);
    if (!result.ok) { this._past.push({ cmd, inverse }); return false; }
    this._future.push({ cmd: inverse, inverse: cmd });
    this._markDirty(inverse);
    this._notify(result.changed);
    if (this._state.autoCalc && this._state.cpmDirty) this.onRequestCpm?.();
    this.onPersist?.({ cmd: inverse, inverse: cmd, isUndo: true });
    return true;
  }

  redo() {
    if (!this._future.length) return false;
    const { cmd, inverse } = this._future.pop();
    const result = this._exec(cmd);
    if (!result.ok) { this._future.push({ cmd, inverse }); return false; }
    this._past.push({ cmd, inverse });
    this._markDirty(cmd);
    this._notify(result.changed);
    if (this._state.autoCalc && this._state.cpmDirty) this.onRequestCpm?.();
    this.onPersist?.({ cmd, inverse });
    return true;
  }

  get canUndo() { return this._past.length > 0; }
  get canRedo() { return this._future.length > 0; }

  // ---- Actualización del resultado CPM (desde worker) ----
  /** @param {any} result */
  setCpmResult(result) {
    this._state.cpmResult = result;
    this._state.cpmDirty  = false;
    this._notify(['cpmResult']);
  }

  // ---- Estado no histórico ----
  /** @param {string|null} id */
  selectTask(id) {
    this._state.selectedTaskId = id;
    this._notify(['selectedTaskId']);
  }

  /** @param {string} id */
  toggleExpand(id) {
    if (this._state.expandedIds.has(id)) this._state.expandedIds.delete(id);
    else this._state.expandedIds.add(id);
    this._notify(['expandedIds']);
  }

  /** @param {string} status */
  setSyncStatus(status) {
    this._state.syncStatus = status;
    this._notify(['syncStatus']);
  }

  /** @param {Map<string,{es:number,ef:number,dur:number}>|null} data */
  setBaselineData(data) {
    this._state.baselineData = data;
    this._notify(['baselineData']);
  }

  /** @param {{id:string, name:string, isPrimary:boolean}|null} meta */
  setBaselineMeta(meta) {
    this._state.baselineMeta = meta;
    this._notify(['baselineMeta']);
  }

  /** @param {boolean} v */
  setAutoCalc(v) {
    this._state.autoCalc = v;
    if (v && this._state.cpmDirty) this.onRequestCpm?.();
    this._notify(['autoCalc']);
  }

  // ---- Carga inicial (sin historial) ----
  /**
   * Carga un proyecto completo sin generar historial de undo.
   * @param {{project:Project, tasks:Task[], deps:Dep[], calendar:Calendar_|null, calExceptions:CalEx[]}} data
   */
  loadProject(data) {
    const s = this._state;
    s.project       = data.project;
    s.tasks         = new Map(data.tasks.map(t => [t.id, t]));
    s.deps          = new Map(data.deps.map(d => [d.id, d]));
    s.calendar      = data.calendar;
    s.calExceptions = data.calExceptions ?? [];
    s.cpmDirty      = true;
    s.cpmResult     = null;
    s.selectedTaskId = null;
    // Auto-expandir nivel 1
    s.expandedIds   = new Set(data.tasks.filter(t => !t.parent_id && !t.deleted_at).map(t => t.id));
    s.baselineData  = null;
    s.baselineMeta  = null;
    this._past   = [];
    this._future = [];
    this._notify(['all']);
    if (s.autoCalc) this.onRequestCpm?.();
  }

  /**
   * Aplica cambios remotos (del servidor) directamente al estado sin crear
   * entradas en el historial de undo. Usado por sync.js.
   * @param {Partial<AppState>} patch
   */
  _applyRemote(patch) {
    Object.assign(this._state, patch);
    const keys = Object.keys(patch);
    if (keys.some(k => ['tasks', 'deps', 'project', 'calendar', 'calExceptions'].includes(k))) {
      this._state.cpmDirty = true;
      if (this._state.autoCalc) this.onRequestCpm?.();
    }
    this._notify(keys);
  }

  // ============================================================
  // Ejecución de comandos
  // ============================================================

  /** @param {Command} cmd @returns {{ok:boolean, inverse:Command, changed:string[], error?:string}} */
  _exec(cmd) {
    switch (cmd.type) {
      case 'ADD_TASK':      return this._addTask(cmd);
      case 'UPDATE_TASK':   return this._updateTask(cmd);
      case 'REMOVE_TASK':   return this._removeTask(cmd);
      case 'RESTORE_TASK':  return this._restoreTask(cmd);
      case 'MOVE_TASK':     return this._moveTask(cmd);
      case 'ADD_DEP':       return this._addDep(cmd);
      case 'REMOVE_DEP':    return this._removeDep(cmd);
      case 'UPDATE_PROJECT': return this._updateProject(cmd);
      default:
        return { ok: false, inverse: cmd, changed: [], error: `Unknown command: ${cmd.type}` };
    }
  }

  _markDirty(cmd) {
    if (['ADD_TASK','UPDATE_TASK','REMOVE_TASK','MOVE_TASK','ADD_DEP','REMOVE_DEP'].includes(cmd.type)) {
      this._state.cpmDirty = true;
    }
  }

  // ---- ADD_TASK ----
  _addTask(cmd) {
    const { task } = cmd.payload;
    if (this._state.tasks.has(task.id)) return { ok: false, inverse: cmd, changed: [], error: 'Duplicate id' };

    // Validar: si hay parent_id, el padre debe existir
    if (task.parent_id) {
      const parent = this._state.tasks.get(task.parent_id);
      if (!parent || parent.deleted_at) return { ok: false, inverse: cmd, changed: [], error: 'Parent not found' };
      if (parent.type === 'milestone') return { ok: false, inverse: cmd, changed: [], error: t('milestoneHasChildren') };
    }

    this._state.tasks.set(task.id, { ...task });
    return {
      ok: true,
      inverse: { type: 'REMOVE_TASK', payload: { id: task.id } },
      changed: ['tasks'],
    };
  }

  // ---- UPDATE_TASK ----
  _updateTask(cmd) {
    const { id, fields } = cmd.payload;
    const existing = this._state.tasks.get(id);
    if (!existing) return { ok: false, inverse: cmd, changed: [], error: 'Task not found' };

    const prevFields = {};
    for (const k of Object.keys(fields)) prevFields[k] = existing[k];

    this._state.tasks.set(id, { ...existing, ...fields, ...(fields.updated_at ? {} : { updated_at: new Date().toISOString() }) });
    return {
      ok: true,
      inverse: { type: 'UPDATE_TASK', payload: { id, fields: prevFields } },
      changed: ['tasks'],
    };
  }

  // ---- REMOVE_TASK (borrado lógico) ----
  _removeTask(cmd) {
    const { id } = cmd.payload;
    const existing = this._state.tasks.get(id);
    if (!existing) return { ok: false, inverse: cmd, changed: [], error: 'Task not found' };

    const prevDeleted = existing.deleted_at;
    const now = new Date().toISOString();
    // Actualizar updated_at junto con deleted_at para que el merge local > remoto funcione
    this._state.tasks.set(id, { ...existing, deleted_at: now, updated_at: now });

    // También borrar lógicamente dependencias que la usen
    const affectedDeps = [];
    for (const [did, dep] of this._state.deps) {
      if (!dep.deleted_at && (dep.pred_id === id || dep.succ_id === id)) {
        this._state.deps.set(did, { ...dep, deleted_at: now, updated_at: now });
        affectedDeps.push(did);
      }
    }

    return {
      ok: true,
      inverse: {
        type: 'RESTORE_TASK',
        payload: { id, prevDeleted, affectedDeps }
      },
      changed: ['tasks', 'deps'],
    };
  }

  // ---- RESTORE_TASK (inverso de REMOVE_TASK, usado por undo) ----
  _restoreTask(cmd) {
    const { id, prevDeleted, affectedDeps } = cmd.payload;
    const existing = this._state.tasks.get(id);
    if (!existing) return { ok: false, inverse: cmd, changed: [], error: 'Task not found' };
    const now = new Date().toISOString();
    this._state.tasks.set(id, { ...existing, deleted_at: prevDeleted ?? null, updated_at: now });
    // Restaurar dependencias que fueron borradas junto con la tarea
    for (const did of (affectedDeps ?? [])) {
      const dep = this._state.deps.get(did);
      if (!dep) continue;
      const pred = this._state.tasks.get(dep.pred_id);
      const succ = this._state.tasks.get(dep.succ_id);
      if (pred && !pred.deleted_at && succ && !succ.deleted_at) {
        this._state.deps.set(did, { ...dep, deleted_at: null, updated_at: now });
      }
    }
    return {
      ok: true,
      inverse: { type: 'REMOVE_TASK', payload: { id } },
      changed: ['tasks', 'deps'],
    };
  }

  // ---- MOVE_TASK (re-parent o reordenar) ----
  _moveTask(cmd) {
    const { id, newParentId, newSortOrder } = cmd.payload;
    const existing = this._state.tasks.get(id);
    if (!existing) return { ok: false, inverse: cmd, changed: [], error: 'Task not found' };

    const prev = { parent_id: existing.parent_id, sort_order: existing.sort_order };
    this._state.tasks.set(id, { ...existing, parent_id: newParentId, sort_order: newSortOrder, updated_at: new Date().toISOString() });
    return {
      ok: true,
      inverse: { type: 'MOVE_TASK', payload: { id, newParentId: prev.parent_id, newSortOrder: prev.sort_order } },
      changed: ['tasks'],
    };
  }

  // ---- ADD_DEP ----
  _addDep(cmd) {
    const { dep } = cmd.payload;
    const taskMap_ = this._state.tasks;

    // Validaciones
    const pred = taskMap_.get(dep.pred_id);
    const succ = taskMap_.get(dep.succ_id);
    if (!pred || pred.deleted_at) return { ok: false, inverse: cmd, changed: [], error: 'Pred not found' };
    if (!succ || succ.deleted_at) return { ok: false, inverse: cmd, changed: [], error: 'Succ not found' };

    // Sin dependencias con tareas resumen
    const parentIds = new Set([...taskMap_.values()].filter(t => !t.deleted_at && t.parent_id).map(t => t.parent_id));
    if (parentIds.has(dep.pred_id) || parentIds.has(dep.succ_id)) {
      return { ok: false, inverse: cmd, changed: [], error: t('summaryHasDep') };
    }

    // Sin ciclos
    const taskNames = new Map([...taskMap_.values()].map(t => [t.id, t.name]));
    const { hasCycle, chain } = detectCycle(dep.pred_id, dep.succ_id, [...this._state.deps.values()], taskNames);
    if (hasCycle) return { ok: false, inverse: cmd, changed: [], error: t('cyclicDep', chain) };

    this._state.deps.set(dep.id, { ...dep });
    return {
      ok: true,
      inverse: { type: 'REMOVE_DEP', payload: { id: dep.id } },
      changed: ['deps'],
    };
  }

  // ---- REMOVE_DEP ----
  _removeDep(cmd) {
    const { id } = cmd.payload;
    const existing = this._state.deps.get(id);
    if (!existing) return { ok: false, inverse: cmd, changed: [], error: 'Dep not found' };
    this._state.deps.set(id, { ...existing, deleted_at: new Date().toISOString() });
    return {
      ok: true,
      inverse: { type: 'ADD_DEP', payload: { dep: existing } },
      changed: ['deps'],
    };
  }

  // ---- UPDATE_PROJECT ----
  _updateProject(cmd) {
    const { fields } = cmd.payload;
    if (!this._state.project) return { ok: false, inverse: cmd, changed: [], error: 'No project' };
    const prev = {};
    for (const k of Object.keys(fields)) prev[k] = this._state.project[k];
    this._state.project = { ...this._state.project, ...fields };
    return {
      ok: true,
      inverse: { type: 'UPDATE_PROJECT', payload: { fields: prev } },
      changed: ['project'],
    };
  }
}

/** @typedef {{type:string, payload:any}} Command */

// Singleton global
export const appState = new AppStateManager();
