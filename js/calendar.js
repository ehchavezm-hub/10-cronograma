// @ts-check
/**
 * calendar.js — Conversión entre índices de días laborables y fechas de calendario.
 *
 * Convención D1: índices enteros, fin exclusivo.
 *   idxToDate(0, start) = start (primer día laborable)
 *   idxToDate(3, start) = cuarto día laborable desde start
 *   finishDate(ef) = idxToDate(ef - 1)  → fin inclusivo para pantalla
 *
 * D3: un solo calendario por proyecto.
 * D4: ES nunca < 0.
 */

/**
 * @typedef {Object} CalendarDef
 * @property {number[]} work_week  - días laborables: 0=Dom, 1=Lun … 6=Sáb
 * @property {Array<{on_date:string, is_working:boolean}>} [exceptions]
 */

export class Calendar {
  /** @param {CalendarDef} def */
  constructor(def) {
    this.workDays = new Set(def.work_week ?? [1, 2, 3, 4, 5]);
    /** @type {Map<string, boolean>} */
    this.exceptions = new Map();
    for (const ex of def.exceptions ?? []) {
      this.exceptions.set(ex.on_date, ex.is_working);
    }
    /** @type {Map<string, boolean>} cache */
    this._cache = new Map();
  }

  /**
   * ¿Es día laborable?
   * @param {Date} date
   */
  isWorkingDay(date) {
    const key = _isoDate(date);
    if (this._cache.has(key)) return /** @type {boolean} */ (this._cache.get(key));
    const exVal = this.exceptions.get(key);
    const result = exVal !== undefined ? exVal : this.workDays.has(date.getDay());
    this._cache.set(key, result);
    return result;
  }

  /**
   * Primer día laborable a partir de `date` (inclusive).
   * @param {Date} date
   * @returns {Date}
   */
  nextWorkingDay(date) {
    let d = new Date(date.getTime());
    while (!this.isWorkingDay(d)) {
      d = _addDays(d, 1);
    }
    return d;
  }

  /**
   * Convierte índice laborable → Date.
   * idx=0 → start_date (debe ser laborable; si no, se avanza al siguiente).
   * @param {number} idx
   * @param {Date} startDate
   * @returns {Date}
   */
  idxToDate(idx, startDate) {
    let base = this.nextWorkingDay(new Date(startDate.getTime()));
    if (idx <= 0) return new Date(base.getTime());
    let count = 0;
    let d = _addDays(base, 1);
    while (count < idx) {
      if (this.isWorkingDay(d)) count++;
      if (count < idx) d = _addDays(d, 1);
    }
    return d;
  }

  /**
   * Convierte Date → índice laborable relativo a startDate.
   * @param {Date} date
   * @param {Date} startDate
   * @returns {number}
   */
  dateToIdx(date, startDate) {
    const base = this.nextWorkingDay(new Date(startDate.getTime()));
    const target = new Date(date.getTime());
    if (target <= base) return 0;
    let count = 0;
    let d = _addDays(base, 1);
    while (d <= target) {
      if (this.isWorkingDay(d)) count++;
      d = _addDays(d, 1);
    }
    return count;
  }

  /**
   * finishDate(ef) = idxToDate(ef − 1) — fin inclusivo para mostrar en pantalla.
   * Para hito con ES=0 devuelve start (inicio del día 0).
   * @param {number} ef
   * @param {Date} startDate
   * @returns {Date}
   */
  finishDate(ef, startDate) {
    if (ef <= 0) return this.nextWorkingDay(new Date(startDate.getTime()));
    return this.idxToDate(ef - 1, startDate);
  }

  /**
   * Suma n días laborables a partir de `date` (exclusive).
   * @param {Date} from
   * @param {number} n
   * @returns {Date}
   */
  addWorkDays(from, n) {
    if (n === 0) return new Date(from.getTime());
    const step = n > 0 ? 1 : -1;
    let remaining = Math.abs(n);
    let d = _addDays(from, step);
    while (remaining > 0) {
      if (this.isWorkingDay(d)) remaining--;
      if (remaining > 0) d = _addDays(d, step);
    }
    return d;
  }
}

/** Calendario por defecto (Lun–Vie sin excepciones). */
export const DEFAULT_CALENDAR = new Calendar({ work_week: [1, 2, 3, 4, 5] });

// ---------- utilidades internas ----------

/** @param {Date} d @returns {string} 'YYYY-MM-DD' */
export function _isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** @param {Date} d @param {number} n @returns {Date} */
function _addDays(d, n) {
  return new Date(d.getTime() + n * 86_400_000);
}

/**
 * Formatea un Date como dd/mm/aaaa (zona local).
 * @param {Date|null|undefined} d
 * @returns {string}
 */
export function fmtDate(d) {
  if (!d) return '—';
  const day   = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year  = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/**
 * Parsea dd/mm/aaaa → Date local a medianoche.
 * @param {string} s
 * @returns {Date|null}
 */
export function parseDate(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  // también acepta YYYY-MM-DD
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return new Date(+m2[1], +m2[2] - 1, +m2[3]);
  return null;
}

/**
 * Convierte 'YYYY-MM-DD' → Date (medianoche local).
 * @param {string} iso
 * @returns {Date}
 */
export function isoToDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}
