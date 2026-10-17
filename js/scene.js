// @ts-check
/**
 * scene.js — Modelo de viewport del diagrama Gantt (sin DOM).
 *
 * GanttScene gestiona la geometría: zoom, desplazamiento, mapeo
 * índice de día laborable ↔ coordenada X, y lista de filas visibles.
 */

export class GanttScene {
  constructor() {
    /** @type {number} Píxeles por día calendario (zoom) */
    this.pixPerDay = 14;
    /** @type {number} Altura de fila (px) — debe coincidir con --row-h */
    this.rowHeight = 32;
    /** @type {number} Altura del encabezado de tiempo (px) */
    this.headerHeight = 44;
    /** @type {number} Desplazamiento horizontal (px desde el inicio del proyecto) */
    this.scrollX = 0;
    /** @type {number} Desplazamiento vertical (px, sincronizado con tabla WBS) */
    this.scrollY = 0;

    /** @type {Date|null} Fecha de inicio del proyecto */
    this.projectStart = null;
    /** @type {import('./calendar.js').Calendar|null} */
    this.calendar = null;

    /**
     * Filas visibles en el mismo orden que la tabla WBS.
     * @type {Array<{id:string, isSummary:boolean, depth:number}>}
     */
    this.rows = [];

    /** @type {import('./cpm.js').CpmResult|null} */
    this.cpmResult = null;
  }

  /**
   * Convierte un índice de día laborable → coordenada X en el canvas
   * (ya descontando scrollX).
   */
  idxToX(idx) {
    if (!this.calendar || !this.projectStart) return 0;
    const date = this.calendar.idxToDate(idx, this.projectStart);
    return this._dateToXAbs(date) - this.scrollX;
  }

  /**
   * Convierte una Date → X absoluta sin restar scrollX.
   * Usa días calendario (no laborables) para el eje X.
   */
  _dateToXAbs(date) {
    const calDays = (date.getTime() - this.projectStart.getTime()) / 86400000;
    return calDays * this.pixPerDay;
  }

  /** Convierte coordenada Y del canvas → índice de fila */
  yToRowIndex(y) {
    return Math.floor((y - this.headerHeight + this.scrollY) / this.rowHeight);
  }

  /** Convierte índice de fila → Y del borde superior de la barra */
  rowToY(index) {
    return this.headerHeight + index * this.rowHeight - this.scrollY;
  }

  /** Número aproximado de días calendario del proyecto */
  get totalCalendarDays() {
    if (!this.cpmResult) return 365;
    return Math.ceil(this.cpmResult.projectDuration * 1.6) + 60;
  }

  /** Ancho total del canvas virtual (px) */
  get totalWidth() {
    return Math.max(this.totalCalendarDays * this.pixPerDay, 400);
  }

  /** Altura total del área de barras (sin encabezado, px) */
  get totalHeight() {
    return this.rows.length * this.rowHeight;
  }

  /** Limitar scrollX al rango válido dado el ancho del viewport */
  clampScrollX(viewportWidth) {
    const max = Math.max(0, this.totalWidth - viewportWidth);
    this.scrollX = Math.max(0, Math.min(this.scrollX, max));
  }

  /** Limitar scrollY al rango válido dado el alto del viewport */
  clampScrollY(viewportHeight) {
    const max = Math.max(0, this.totalHeight - (viewportHeight - this.headerHeight));
    this.scrollY = Math.max(0, Math.min(this.scrollY, max));
  }
}
