// @ts-check
/**
 * storage.js — Persistencia local con IndexedDB.
 *
 * Base: 'cronograma', versionada con onupgradeneeded.
 * Almacenes: organizations, memberships, projects, calendars,
 *   calendar_exceptions, tasks, task_dependencies, resources,
 *   task_resources, baselines, baseline_tasks, outbox, meta.
 *
 * El outbox tiene máximo 10 000 operaciones; superarlo bloquea
 * la escritura y muestra un aviso.
 */

const DB_NAME    = 'cronograma';
const DB_VERSION = 3;
const OUTBOX_LIMIT = 10_000;

const STORES = [
  'organizations', 'memberships', 'portfolios', 'programs', 'projects', 'calendars',
  'calendar_exceptions', 'tasks', 'task_dependencies', 'resources',
  'task_resources', 'baselines', 'baseline_tasks', 'outbox', 'meta',
];

/** @type {IDBDatabase|null} */
let _db = null;

/** @returns {Promise<IDBDatabase>} */
export async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db  = /** @type {IDBOpenDBRequest} */ (e.target).result;
      const tx  = /** @type {IDBVersionChangeEvent} */ (e).target['transaction'];
      for (const name of STORES) {
        let store;
        if (!db.objectStoreNames.contains(name)) {
          store = db.createObjectStore(name, { keyPath: 'id' });
        } else {
          store = tx.objectStore(name);
        }
        if (name === 'tasks') {
          if (!store.indexNames.contains('project_id')) store.createIndex('project_id', 'project_id', { unique: false });
          if (!store.indexNames.contains('updated_at')) store.createIndex('updated_at', 'updated_at', { unique: false });
        }
        if (name === 'task_dependencies') {
          if (!store.indexNames.contains('project_id')) store.createIndex('project_id', 'project_id', { unique: false });
        }
        if (name === 'task_resources') {
          if (!store.indexNames.contains('task_id'))    store.createIndex('task_id',    'task_id',    { unique: false });
          if (!store.indexNames.contains('project_id')) store.createIndex('project_id', 'project_id', { unique: false });
        }
      }
    };
    req.onsuccess = (e) => { _db = /** @type {IDBOpenDBRequest} */ (e.target).result; resolve(_db); };
    req.onerror   = (e) => reject(/** @type {IDBOpenDBRequest} */ (e.target).error);
  });
}

// ---- Helpers ----

/** @template T @param {IDBRequest<T>} req @returns {Promise<T>} */
function _req(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

/** @param {string} store @param {'readonly'|'readwrite'} mode @returns {Promise<IDBObjectStore>} */
async function _store(store, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(store, mode).objectStore(store);
}

// ---- CRUD genérico ----

/** @param {string} storeName @param {string} id @returns {Promise<any>} */
export async function getById(storeName, id) {
  const s = await _store(storeName);
  return _req(s.get(id));
}

/** @param {string} storeName @returns {Promise<any[]>} */
export async function getAll(storeName) {
  const s = await _store(storeName);
  return _req(s.getAll());
}

/** @param {string} storeName @param {string} indexName @param {IDBValidKey} key @returns {Promise<any[]>} */
export async function getByIndex(storeName, indexName, key) {
  const s = await _store(storeName);
  return _req(s.index(indexName).getAll(key));
}

/** @param {string} storeName @param {any} record @returns {Promise<IDBValidKey>} */
export async function put(storeName, record) {
  const s = await _store(storeName, 'readwrite');
  return _req(s.put(record));
}

/** @param {string} storeName @param {any[]} records @returns {Promise<void>} */
export async function putMany(storeName, records) {
  if (!records.length) return;
  const db   = await openDB();
  const tx   = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const r of records) store.put(r);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

/** @param {string} storeName @param {string} id @returns {Promise<void>} */
export async function remove(storeName, id) {
  const s = await _store(storeName, 'readwrite');
  return _req(s.delete(id));
}

// ---- Proyectos ----

/** @returns {Promise<any[]>} proyectos no eliminados */
export async function listProjects() {
  const all = await getAll('projects');
  return all.filter(p => !p.deleted_at);
}

/** @param {string} projectId */
export async function loadProject(projectId) {
  const [project, tasks, deps, calendars, calExceptions] = await Promise.all([
    getById('projects', projectId),
    getByIndex('tasks', 'project_id', projectId),
    getByIndex('task_dependencies', 'project_id', projectId),
    getAll('calendars'),
    getAll('calendar_exceptions'),
  ]);
  const calId = project?.calendar_id;
  const calendar = calId ? calendars.find(c => c.id === calId) ?? null : null;
  const calEx = calId ? calExceptions.filter(ex => ex.calendar_id === calId && !ex.deleted_at) : [];
  return { project, tasks, deps, calendar, calExceptions: calEx };
}

// ---- Outbox ----

/**
 * Añade una operación al outbox, compactando ediciones consecutivas de la misma fila.
 * @param {{id:string, tabla:string, fila:string, tipo:'INSERT'|'UPDATE'|'DELETE', campos:object, baseUpdatedAt:string|null}} op
 */
export async function outboxAdd(op) {
  const all = await getAll('outbox');
  if (all.length >= OUTBOX_LIMIT) throw new Error('OUTBOX_LIMIT');

  // Compactar: si ya existe una UPDATE para la misma (tabla, fila), fusionar campos
  if (op.tipo === 'UPDATE') {
    const prev = all.find(o => o.tabla === op.tabla && o.fila === op.fila && o.tipo === 'UPDATE');
    if (prev) {
      const merged = { ...prev, campos: { ...prev.campos, ...op.campos } };
      await put('outbox', merged);
      return;
    }
  }
  await put('outbox', op);
}

/** @returns {Promise<any[]>} */
export async function outboxGetAll() { return getAll('outbox'); }

/** @param {string} id */
export async function outboxRemove(id) { return remove('outbox', id); }

/** @returns {Promise<number>} */
export async function outboxCount() {
  const s = await _store('outbox');
  return _req(s.count());
}

// ---- Meta ----

/** @param {string} key @param {any} value */
export async function setMeta(key, value) { return put('meta', { id: key, value }); }

/** @param {string} key @returns {Promise<any>} */
export async function getMeta(key) {
  const r = await getById('meta', key);
  return r?.value;
}

// ---- Guardar snapshot local del proyecto ----

/**
 * Guarda todos los datos de un proyecto en IndexedDB de forma atómica.
 * Cuando se pasa un array de tareas/deps, primero borra los registros
 * anteriores de ese proyecto para evitar duplicados de sesiones pasadas.
 */
export async function saveProjectSnapshot({ project, tasks, deps, calendar, calExceptions }) {
  const db = await openDB();
  const tx = db.transaction(
    ['projects', 'tasks', 'task_dependencies', 'calendars', 'calendar_exceptions'],
    'readwrite'
  );

  if (project) {
    tx.objectStore('projects').put(project);

    // Borrar tareas y deps anteriores del proyecto para evitar duplicados
    const tasksStore = tx.objectStore('tasks');
    const depsStore  = tx.objectStore('task_dependencies');
    const projId = project.id;

    // Eliminar por índice project_id
    const taskReq = tasksStore.index('project_id').getAllKeys(projId);
    taskReq.onsuccess = () => {
      for (const k of taskReq.result) tasksStore.delete(k);
    };
    const depReq = depsStore.index('project_id').getAllKeys(projId);
    depReq.onsuccess = () => {
      for (const k of depReq.result) depsStore.delete(k);
    };
  }

  if (calendar) tx.objectStore('calendars').put(calendar);
  for (const t of tasks)  tx.objectStore('tasks').put(t);
  for (const d of deps)   tx.objectStore('task_dependencies').put(d);
  for (const e of (calExceptions ?? [])) tx.objectStore('calendar_exceptions').put(e);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

// ---- Portafolios ----

/** @returns {Promise<any[]>} */
export async function listPortfolios() {
  const all = await getAll('portfolios');
  return all.filter(p => !p.deleted_at);
}

/** @param {any} portfolio */
export async function savePortfolio(portfolio) { return put('portfolios', portfolio); }

/** @param {string} id */
export async function deletePortfolio(id) { return remove('portfolios', id); }

// ---- Programas ----

/** @returns {Promise<any[]>} */
export async function listPrograms() {
  const all = await getAll('programs');
  return all.filter(p => !p.deleted_at);
}

/** @param {any} program */
export async function saveProgram(program) { return put('programs', program); }

/** @param {string} id */
export async function deleteProgram(id) { return remove('programs', id); }

// ---- Jerarquía completa ----

/** Devuelve la jerarquía: portfolios, programs y projects con sus relaciones */
export async function loadHierarchy() {
  const [portfolios, programs, projects] = await Promise.all([
    listPortfolios(),
    listPrograms(),
    listProjects(),
  ]);
  return { portfolios, programs, projects };
}

/**
 * Elimina un proyecto y todas sus tareas/dependencias de IndexedDB.
 * @param {string} projectId
 */
export async function deleteProject(projectId) {
  const db = await openDB();
  const tx = db.transaction(
    ['projects', 'tasks', 'task_dependencies'],
    'readwrite'
  );
  tx.objectStore('projects').delete(projectId);

  const taskStore = tx.objectStore('tasks');
  const depStore  = tx.objectStore('task_dependencies');
  const taskReq   = taskStore.index('project_id').getAllKeys(projectId);
  const depReq    = depStore.index('project_id').getAllKeys(projectId);

  await Promise.all([
    new Promise((res, rej) => { taskReq.onsuccess = () => { taskReq.result.forEach(k => taskStore.delete(k)); res(null); }; taskReq.onerror = () => rej(taskReq.error); }),
    new Promise((res, rej) => { depReq.onsuccess = () => { depReq.result.forEach(k => depStore.delete(k)); res(null); }; depReq.onerror = () => rej(depReq.error); }),
  ]);

  return new Promise((res, rej) => { tx.oncomplete = () => res(undefined); tx.onerror = () => rej(tx.error); });
}
