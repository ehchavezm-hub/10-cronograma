// js/async-queue.js — Cola de tareas asíncronas para ECM Project
// Etapa 3: Plan Maestro — Arquitectura de procesamiento asíncrono

'use strict';

// ---------------------------------------------------------------------------
// 1. EventEmitter — mini, <50 lines
// ---------------------------------------------------------------------------

class EventEmitter {
  constructor() {
    this._listeners = Object.create(null);
  }

  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return this;
  }

  off(event, fn) {
    if (!this._listeners[event]) return this;
    this._listeners[event] = this._listeners[event].filter(h => h !== fn);
    return this;
  }

  emit(event, ...args) {
    const handlers = this._listeners[event];
    if (!handlers || handlers.length === 0) return false;
    for (const fn of handlers.slice()) {
      try { fn(...args); } catch (e) { console.error(`[EventEmitter] ${event} handler threw:`, e); }
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// 2. AsyncQueue — processes jobs one at a time (or configurable concurrency)
// ---------------------------------------------------------------------------

class AsyncQueue extends EventEmitter {
  /**
   * @param {{ concurrency?: number, name?: string }} opts
   */
  constructor({ concurrency = 1, name = 'queue' } = {}) {
    super();
    this._concurrency = Math.max(1, concurrency);
    this.name = name;
    this._pending = [];   // { jobFn, label, priority, resolve, reject }
    this._running = 0;
    this._paused = false;
  }

  /**
   * Add a job to the queue.
   * @param {() => Promise<any>} jobFn  — async function to run
   * @param {{ label?: string, priority?: number }} opts
   * @returns {Promise<any>}
   */
  enqueue(jobFn, { label = 'job', priority = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const job = { jobFn, label, priority, resolve, reject };
      // Insert in priority order (higher priority first)
      const idx = this._pending.findIndex(j => j.priority < priority);
      if (idx === -1) this._pending.push(job);
      else this._pending.splice(idx, 0, job);
      this._tick();
    });
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
    this._tick();
  }

  /** Discard all pending (not yet running) jobs. */
  clear() {
    const dropped = this._pending.splice(0);
    for (const job of dropped) {
      job.reject(new DOMException(`Queue "${this.name}" cleared`, 'AbortError'));
    }
  }

  /** Number of jobs waiting to run. */
  get size() { return this._pending.length; }

  /** Number of jobs currently executing. */
  get running() { return this._running; }

  // -- internal --------------------------------------------------------------

  _tick() {
    if (this._paused) return;
    while (this._running < this._concurrency && this._pending.length > 0) {
      this._run(this._pending.shift());
    }
  }

  async _run(job) {
    this._running++;
    this.emit('start', job);
    try {
      const result = await job.jobFn();
      this.emit('done', job, result);
      job.resolve(result);
    } catch (err) {
      this.emit('error', job, err);
      job.reject(err);
    } finally {
      this._running--;
      if (this._pending.length === 0 && this._running === 0) {
        this.emit('drain');
      }
      this._tick();
    }
  }
}

// ---------------------------------------------------------------------------
// 3. WorkerPool — round-robin pool for CPU-intensive tasks
// ---------------------------------------------------------------------------

class WorkerPool {
  /**
   * @param {{ workerScript: string, poolSize?: number }} opts
   */
  constructor({ workerScript, poolSize = 2 }) {
    if (!workerScript) throw new TypeError('WorkerPool requires workerScript');
    this._script = workerScript;
    this._poolSize = Math.max(1, poolSize);
    this._workers = [];      // lazily created Worker instances
    this._queues = [];       // per-worker pending { data, resolve, reject, id }
    this._msgId = 0;
    this._robin = 0;         // round-robin cursor
  }

  /**
   * Run data on the next available worker.
   * @param {any} data — transferable or structured-cloneable payload
   * @returns {Promise<any>}
   */
  run(data) {
    const workerIndex = this._robin % this._poolSize;
    this._robin++;

    // Lazily create worker
    if (!this._workers[workerIndex]) {
      this._workers[workerIndex] = new Worker(this._script, { type: 'module' });
      this._queues[workerIndex] = new Map();

      const worker = this._workers[workerIndex];
      const pending = this._queues[workerIndex];

      worker.addEventListener('message', ({ data: msg }) => {
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error));
        else entry.resolve(msg.result);
      });

      worker.addEventListener('error', (evt) => {
        // Reject all pending tasks on this worker
        for (const entry of pending.values()) {
          entry.reject(new Error(evt.message || 'Worker error'));
        }
        pending.clear();
      });
    }

    return new Promise((resolve, reject) => {
      const id = ++this._msgId;
      this._queues[workerIndex].set(id, { resolve, reject });
      this._workers[workerIndex].postMessage({ id, data });
    });
  }

  /** Terminate all workers immediately. */
  terminate() {
    for (let i = 0; i < this._workers.length; i++) {
      if (this._workers[i]) {
        // Reject pending tasks
        const pending = this._queues[i];
        if (pending) {
          for (const entry of pending.values()) {
            entry.reject(new DOMException('WorkerPool terminated', 'AbortError'));
          }
          pending.clear();
        }
        this._workers[i].terminate();
      }
    }
    this._workers = [];
    this._queues = [];
    this._robin = 0;
  }
}

// ---------------------------------------------------------------------------
// 4. Progress tracker
// ---------------------------------------------------------------------------

/**
 * Create a progress tracker for a batch operation.
 * @param {number} total        — total units of work
 * @param {(info: { done: number, total: number, pct: number, message: string }) => void} onProgress
 */
function createProgressTracker(total, onProgress) {
  let done = 0;
  let lastMessage = '';

  function notify(message = lastMessage) {
    lastMessage = message;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    try { onProgress({ done, total, pct, message }); } catch (_) {}
  }

  return {
    /** Advance counter by n (default 1) and fire onProgress. */
    tick(n = 1) {
      done = Math.min(total, done + n);
      notify();
    },
    /** Emit a status message without changing the counter. */
    report(msg) {
      notify(msg);
    },
    /** Reset to zero. */
    reset() {
      done = 0;
      notify('');
    },
    get done() { return done; },
    get total() { return total; },
    get pct() { return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0; },
  };
}

// ---------------------------------------------------------------------------
// 5. Debounced save helper
// ---------------------------------------------------------------------------

/**
 * Returns a debounced version of fn that fires at most once per `wait` ms.
 * The returned function also has a `.flush()` method for immediate execution.
 *
 * @param {Function} fn
 * @param {number} wait  — milliseconds (default 500)
 * @returns {Function & { flush: () => void }}
 */
function debouncedSave(fn, wait = 500) {
  let timer = null;
  let lastArgs = null;

  function debounced(...args) {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      fn(...a);
    }, wait);
  }

  debounced.flush = function () {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      if (a !== null) fn(...a);
    }
  };

  debounced.cancel = function () {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    lastArgs = null;
  };

  return debounced;
}

// ---------------------------------------------------------------------------
// 6. Exports
// ---------------------------------------------------------------------------

/** Singleton main queue for ECM Project background tasks. */
export const queue = new AsyncQueue({ concurrency: 1, name: 'ecm-main' });

export { AsyncQueue, WorkerPool, createProgressTracker, debouncedSave };
