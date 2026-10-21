// js/cache.js — Multi-level cache L1(memory) + L2(localStorage)
// Etapa 2: Plan Maestro ECM Project
//
// Architecture:
//   L1 — Memory (Map): fast, session-only, lost on page reload
//   L2 — localStorage: persistent, survives refresh, ~5 MB limit
//   L3 — Network (Supabase REST): actual source of truth, called by callers

// ---------------------------------------------------------------------------
// TTL configuration
// ---------------------------------------------------------------------------

/** TTL constants (milliseconds) for each data type. Re-exported so other
 *  modules can pass the right value to cacheSet() without hardcoding numbers.
 */
export const CACHE_TTL = {
  wbs:       5  * 60 * 1000,   // 5 min  — WBS changes often during editing
  deps:      5  * 60 * 1000,   // 5 min
  resources: 10 * 60 * 1000,   // 10 min
  baselines: 15 * 60 * 1000,   // 15 min — baselines rarely change
  projects:  2  * 60 * 1000,   // 2 min  — project list refreshes more often
};

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** L1 in-memory cache.
 *  Each entry: { data: any, exp: number } where exp = Date.now() + ttlMs.
 */
const _l1 = new Map();

/** Prefix applied to every L2 localStorage key managed by this module. */
const L2_PREFIX = 'ecm-cache:';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the current epoch time in milliseconds.
 * @returns {number}
 */
function _now() {
  return Date.now();
}

/**
 * Builds a full localStorage key from a logical cache key.
 * @param {string} key
 * @returns {string}
 */
function _l2Key(key) {
  return L2_PREFIX + key;
}

/**
 * Read and parse one L2 entry. Returns the parsed object or null on any error,
 * including JSON parse failures, missing key, or quota issues.
 * @param {string} key  Logical cache key (no prefix).
 * @returns {{ data: any, exp: number } | null}
 */
function _l2Read(key) {
  try {
    const raw = localStorage.getItem(_l2Key(key));
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Write one entry to L2. Silently swallows errors (e.g. QuotaExceededError).
 * @param {string} key   Logical cache key (no prefix).
 * @param {{ data: any, exp: number }} entry
 */
function _l2Write(key, entry) {
  try {
    localStorage.setItem(_l2Key(key), JSON.stringify(entry));
  } catch (_) {
    // localStorage unavailable or quota exceeded — degrade gracefully
  }
}

/**
 * Delete one entry from L2. Silently swallows errors.
 * @param {string} key  Logical cache key (no prefix).
 */
function _l2Delete(key) {
  try {
    localStorage.removeItem(_l2Key(key));
  } catch (_) {
    // ignore
  }
}

/**
 * Returns all logical cache keys currently stored in L2
 * (i.e. localStorage keys that start with the ECM prefix, with the prefix
 * stripped off so they match the logical key space).
 * @returns {string[]}
 */
function _l2AllKeys() {
  try {
    return Object.keys(localStorage)
      .filter(k => k.startsWith(L2_PREFIX))
      .map(k => k.slice(L2_PREFIX.length));
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve a value from the cache.
 *
 * Checks L1 (memory) first, then L2 (localStorage). If a valid (non-expired)
 * entry is found in L2 but not in L1 it is promoted back to L1.
 *
 * Returns `null` when the key is absent or the cached entry has expired.
 *
 * @param {string} key  Logical cache key, e.g. `"project:42:wbs"`.
 * @returns {any | null}
 */
export function cacheGet(key) {
  const now = _now();

  // --- L1 ---
  const l1Entry = _l1.get(key);
  if (l1Entry !== undefined) {
    if (l1Entry.exp > now) {
      return l1Entry.data;
    }
    // expired — evict
    _l1.delete(key);
  }

  // --- L2 ---
  const l2Entry = _l2Read(key);
  if (l2Entry !== null) {
    if (l2Entry.exp > now) {
      // promote to L1 with the remaining TTL
      _l1.set(key, { data: l2Entry.data, exp: l2Entry.exp });
      return l2Entry.data;
    }
    // expired — evict from L2
    _l2Delete(key);
  }

  return null;
}

/**
 * Store a value in both L1 (memory) and L2 (localStorage).
 *
 * @param {string} key    Logical cache key, e.g. `"project:42:wbs"`.
 * @param {any}    data   The value to cache (must be JSON-serialisable for L2).
 * @param {number} ttlMs  Time-to-live in milliseconds. Use {@link CACHE_TTL}.
 */
export function cacheSet(key, data, ttlMs) {
  const exp = _now() + ttlMs;
  const entry = { data, exp };

  // L1
  _l1.set(key, entry);

  // L2
  _l2Write(key, entry);
}

/**
 * Remove a single key from both L1 and L2.
 *
 * @param {string} key  Logical cache key to invalidate.
 */
export function cacheInvalidate(key) {
  _l1.delete(key);
  _l2Delete(key);
}

/**
 * Invalidate all cache entries that belong to a specific project.
 *
 * Removes every key matching the pattern `project:{projectId}:*` from both
 * L1 and L2.
 *
 * @param {string|number} projectId  The project identifier.
 */
export function cacheInvalidateProject(projectId) {
  const prefix = `project:${projectId}:`;

  // L1 — iterate the Map
  for (const key of _l1.keys()) {
    if (key.startsWith(prefix)) {
      _l1.delete(key);
    }
  }

  // L2 — iterate localStorage keys
  for (const key of _l2AllKeys()) {
    if (key.startsWith(prefix)) {
      _l2Delete(key);
    }
  }
}

/**
 * Invalidate all cache entries that belong to a specific organisation.
 *
 * Removes every key matching the pattern `org:{orgId}:*` from both L1 and L2.
 *
 * @param {string|number} orgId  The organisation identifier.
 */
export function cacheInvalidateOrg(orgId) {
  const prefix = `org:${orgId}:`;

  // L1
  for (const key of _l1.keys()) {
    if (key.startsWith(prefix)) {
      _l1.delete(key);
    }
  }

  // L2
  for (const key of _l2AllKeys()) {
    if (key.startsWith(prefix)) {
      _l2Delete(key);
    }
  }
}

/**
 * Nuclear option: remove **all** ECM cache entries from L1 and L2.
 *
 * L2 keys are identified by the `ecm-cache:` prefix, so unrelated
 * localStorage keys are left untouched.
 */
export function cacheClearAll() {
  // L1 — clear everything
  _l1.clear();

  // L2 — remove only ECM-prefixed keys
  for (const key of _l2AllKeys()) {
    _l2Delete(key);
  }
}

/**
 * Return basic statistics about the current cache state, useful for debugging
 * and DevTools inspection.
 *
 * @returns {{ l1Size: number, l2Size: number, l2Keys: string[] }}
 *   - `l1Size`  Number of entries currently held in L1 memory (includes expired
 *               entries that have not yet been lazily evicted).
 *   - `l2Size`  Number of ECM keys currently in localStorage.
 *   - `l2Keys`  Array of logical (prefix-stripped) L2 keys.
 */
export function cacheStats() {
  const l2Keys = _l2AllKeys();
  return {
    l1Size: _l1.size,
    l2Size: l2Keys.length,
    l2Keys,
  };
}
