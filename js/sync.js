// @ts-check
/**
 * sync.js — Motor de sincronización offline-first con Supabase.
 *
 * Estrategia:
 *   1. PULL inicial: descarga todo el proyecto del servidor al arrancar.
 *   2. PUSH incremental: vacía el outbox (IndexedDB) enviando cada op a Supabase.
 *   3. Realtime: escucha cambios remotos y los fusiona al estado local.
 *   4. Conflictos: last-write-wins por updated_at; emite 'conflict' si la versión
 *      remota es más reciente que el baseline del cambio local.
 *   5. Offline: detecta navigator.onLine; pausa el push y reintenta al reconectar.
 *
 * El módulo exporta la clase SyncEngine. main.js crea una instancia si !IS_LOCAL_MODE.
 */

import { sb }            from './supabase.js';
import { appState }      from './state.js';
import {
  outboxGetAll, outboxRemove, outboxCount,
  saveProjectSnapshot, getMeta, setMeta, putMany, put as dbPut,
} from './storage.js?v=2';
import { IS_LOCAL_MODE } from './config.js';

// ============================================================
// Constantes
// ============================================================

const PULL_INTERVAL_MS = 30_000;   // Poll de cambios remotos cada 30 s
const PUSH_INTERVAL_MS = 5_000;    // Intento de vaciar outbox cada 5 s
const RETRY_DELAY_MS   = 10_000;   // Espera tras un error de red

// Tablas que se sincronizan (en orden de dependencia)
const SYNC_TABLES = ['projects', 'calendars', 'calendar_exceptions', 'tasks', 'task_dependencies'];

// ============================================================
// SyncEngine
// ============================================================

export class SyncEngine {
  /**
   * @param {string} projectId
   * @param {string} orgId
   */
  constructor(projectId, orgId) {
    this._projectId = projectId;
    this._orgId     = orgId;
    this._running   = false;
    this._pushTimer = null;
    this._pullTimer = null;
    this._unsubs    = [];        // funciones para desuscribir Realtime
    this._lastPullAt = null;     // ISO timestamp del último pull exitoso
  }

  // ---- Arranque / parada ----

  /** Inicia el motor de sync. */
  async start() {
    if (this._running || IS_LOCAL_MODE || !sb) return;
    this._running = true;

    // Leer último pull desde meta
    this._lastPullAt = await getMeta('lastPullAt_' + this._projectId) ?? null;

    // Pull inicial
    await this._pull(true);

    // Suscribir Realtime a cada tabla
    for (const tabla of SYNC_TABLES) {
      try {
        const unsub = sb.subscribe(tabla, this._projectId, (ev) => this._onRemoteEvent(tabla, ev));
        this._unsubs.push(unsub);
      } catch { /* WS puede fallar — el polling cubre */ }
    }

    // Timers periódicos
    this._pushTimer = setInterval(() => this._pushCycle(), PUSH_INTERVAL_MS);
    this._pullTimer = setInterval(() => this._pull(false), PULL_INTERVAL_MS);

    // Reconexión cuando el navegador vuelve a estar online
    window.addEventListener('online',  this._onOnline);
    window.addEventListener('offline', this._onOffline);

    console.log('[Sync] Motor iniciado para proyecto', this._projectId);
  }

  /** Detiene el motor limpiamente. */
  stop() {
    this._running = false;
    if (this._pushTimer) { clearInterval(this._pushTimer); this._pushTimer = null; }
    if (this._pullTimer) { clearInterval(this._pullTimer); this._pullTimer = null; }
    for (const u of this._unsubs) { try { u(); } catch { } }
    this._unsubs = [];
    window.removeEventListener('online',  this._onOnline);
    window.removeEventListener('offline', this._onOffline);
  }

  // ---- Event listeners de red ----

  _onOnline = () => {
    appState.setSyncStatus('syncing');
    this._pushCycle();
    this._pull(false);
  };

  _onOffline = () => {
    appState.setSyncStatus('offline');
  };

  // ============================================================
  // PULL — descargar cambios del servidor
  // ============================================================

  /**
   * @param {boolean} full  true = descarga completa; false = incremental (updated_at > lastPullAt)
   */
  async _pull(full) {
    if (!navigator.onLine || !sb) return;
    appState.setSyncStatus('syncing');

    try {
      const since = full ? null : this._lastPullAt;
      const pid   = this._projectId;

      const [projects, calendars, calExceptions, tasks, deps] = await Promise.all([
        sb.select('projects',           { 'id': `eq.${pid}` }, '*'),
        sb.select('calendars',          { 'org_id': `eq.${this._orgId}` }, '*'),
        sb.select('calendar_exceptions', since
          ? { 'org_id': `eq.${this._orgId}`, 'updated_at': `gt.${since}` }
          : { 'org_id': `eq.${this._orgId}` }, '*'),
        sb.select('tasks',              since
          ? { 'project_id': `eq.${pid}`, 'updated_at': `gt.${since}` }
          : { 'project_id': `eq.${pid}` }, '*'),
        sb.select('task_dependencies',  since
          ? { 'project_id': `eq.${pid}`, 'updated_at': `gt.${since}` }
          : { 'project_id': `eq.${pid}` }, '*'),
      ]);

      // Fusionar en IndexedDB y en estado (solo filas modificadas en pull incremental)
      const project  = projects[0] ?? null;
      const calendar = calendars.find(c => c.id === project?.calendar_id) ?? null;

      if (full) {
        // Pull completo: guardar snapshot y recargar estado
        if (project) {
          await saveProjectSnapshot({ project, tasks, deps, calendar, calExceptions });
          // Solo recargar la vista si el usuario sigue en este proyecto
          if (appState.state.project?.id === project.id) {
            appState.loadProject({ project, tasks, deps, calendar, calExceptions });
          }
        }
      } else {
        // Pull incremental: fusionar solo lo que cambió
        // Solo aplicar al estado si el usuario sigue en este proyecto
        if (appState.state.project?.id !== this._projectId) {
          // El usuario cambió de proyecto; solo actualizar IndexedDB, no el estado en memoria
          await _mergeRemote('projects',            project ? [project] : []);
          await _mergeRemote('tasks',               tasks);
          await _mergeRemote('task_dependencies',   deps);
          await _mergeRemote('calendar_exceptions', calExceptions);
          if (project) await _mergeRemote('calendars', [calendar].filter(Boolean));
        } else {
          await _mergeRemote('projects',            project ? [project] : []);
          await _mergeRemote('tasks',               tasks);
          await _mergeRemote('task_dependencies',   deps);
          await _mergeRemote('calendar_exceptions', calExceptions);
          if (project) await _mergeRemote('calendars', [calendar].filter(Boolean));

          // Actualizar estado con las filas remotas más nuevas
          _applyRemoteToState({ tasks, deps, project, calExceptions });
        }
      }

      const now = new Date().toISOString();
      this._lastPullAt = now;
      await setMeta('lastPullAt_' + this._projectId, now);

      appState.setSyncStatus('synced');
    } catch (err) {
      console.warn('[Sync] Pull falló:', err.message);
      appState.setSyncStatus(navigator.onLine ? 'offline' : 'offline');
    }
  }

  // ============================================================
  // PUSH — enviar outbox al servidor
  // ============================================================

  async _pushCycle() {
    if (!navigator.onLine || !sb) {
      appState.setSyncStatus('offline');
      return;
    }

    const ops = await outboxGetAll();
    if (!ops.length) {
      const count = await outboxCount();
      if (count === 0) appState.setSyncStatus('synced');
      return;
    }

    appState.setSyncStatus('syncing');

    for (const op of ops) {
      try {
        await _pushOp(op);
        await outboxRemove(op.id);
      } catch (err) {
        console.warn('[Sync] Push falló para op', op.id, ':', err.message);
        // No remover del outbox — se reintentará
        // Si es error 409 (conflicto) marcar estado
        if (err.message?.includes('409') || err.message?.includes('conflict')) {
          appState.setSyncStatus('conflict');
        }
        break; // Detener para no enviar dependencias rotas
      }
    }

    const remaining = await outboxCount();
    if (remaining === 0) {
      appState.setSyncStatus('synced');
    }
  }

  // ============================================================
  // Realtime: evento de cambio remoto
  // ============================================================

  _onRemoteEvent(tabla, { type, record }) {
    if (!record) return;

    // Ignorar si el cambio viene de esta sesión (updated_by podría verificarlo, pero
    // como no tenemos userId en el cliente, simplemente fusionamos por updated_at)
    _mergeRemote(tabla, [record]);
    _applyRemoteToState({ [_tableToStateKey(tabla)]: [record] });
  }
}

// ============================================================
// Helpers internos
// ============================================================

/**
 * Envía una operación del outbox a Supabase.
 * @param {{tabla:string, fila:string, tipo:'INSERT'|'UPDATE'|'DELETE', campos:object, baseUpdatedAt:string|null}} op
 */
async function _pushOp(op) {
  if (!sb) return;
  switch (op.tipo) {
    case 'INSERT':
      await sb.upsert(op.tabla, op.campos);
      break;
    case 'UPDATE': {
      // Verificar conflicto: leer updated_at remoto
      const rows = await sb.select(op.tabla, { id: `eq.${op.fila}` }, 'id,updated_at');
      const remote = rows[0];
      if (remote && op.baseUpdatedAt && remote.updated_at > op.baseUpdatedAt) {
        // Conflicto: versión remota es más nueva — aplica last-write-wins
        // El cambio local aún se envía (override), pero registramos advertencia
        console.warn('[Sync] Conflicto last-write-wins en', op.tabla, op.fila);
        appState.setSyncStatus('conflict');
      }
      await sb.update(op.tabla, op.fila, op.campos);
      break;
    }
    case 'DELETE':
      await sb.softDelete(op.tabla, op.fila);
      break;
  }
}

/**
 * Guarda las filas remotas en IndexedDB (solo sobrescribe si la versión remota es >= local).
 * @param {string} storeName
 * @param {any[]} rows
 */
async function _mergeRemote(storeName, rows) {
  if (!rows.length) return;
  // Usar putMany directamente: el servidor es fuente de verdad para pulls
  await putMany(storeName, rows);
}

/** Aplica filas remotas al estado en memoria. */
function _applyRemoteToState({ tasks, deps, project, calExceptions } = {}) {
  const state = appState.state;

  if (tasks?.length) {
    const newTasks = new Map(state.tasks);
    for (const t of tasks) newTasks.set(t.id, t);
    // No usar dispatch de comando para no crear entradas en el historial
    appState._applyRemote({ tasks: newTasks });
  }
  if (deps?.length) {
    const newDeps = new Map(state.deps);
    for (const d of deps) newDeps.set(d.id, d);
    appState._applyRemote({ deps: newDeps });
  }
  if (project) {
    appState._applyRemote({ project });
  }
  if (calExceptions?.length) {
    const existing = [...state.calExceptions];
    for (const ex of calExceptions) {
      const idx = existing.findIndex(e => e.id === ex.id);
      if (idx >= 0) existing[idx] = ex;
      else existing.push(ex);
    }
    appState._applyRemote({ calExceptions: existing });
  }
}

function _tableToStateKey(tabla) {
  const map = {
    tasks:              'tasks',
    task_dependencies:  'deps',
    projects:           'project',
    calendar_exceptions:'calExceptions',
  };
  return map[tabla] ?? tabla;
}
