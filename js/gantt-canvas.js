// @ts-check
/**
 * gantt-canvas.js — Renderizador Gantt sobre Canvas 2D.
 *
 * Dibuja: eje de tiempo, bandas de fin de semana, barras de tareas,
 * diamantes de hitos, barras de resumen, flechas de dependencias,
 * línea de hoy y línea de fecha de corte.
 * Pan con arrastrar + zoom con Ctrl+rueda.
 */

import { appState }   from './state.js';
import { GanttScene } from './scene.js';
import { fmtDate }    from './calendar.js';

const _esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ---- Paleta de colores (coincide con css/tokens.css) ----
// Bar colors never change (per project requirement); layout colors are theme-aware at render time.
const C = {
  critical:   '#D32F2F',
  done:       '#388E3C',
  near:       '#FB8C00',
  normal:     '#1976D2',
  milestone:  '#F9A825',
  summary:    '#5C6BC0',
  weekend:    'rgba(0,0,0,0.04)',
  today:      '#1565C0',
  dataDate:   '#E65100',
  hdrBg:      '#F8F9FA',
  hdrLine:    '#E0E0E0',
  rowOdd:     'rgba(0,0,0,0.018)',
  gridLine:   'rgba(0,0,0,0.07)',
  text:       '#37474F',
  textLight:  '#78909C',
  arrow:      '#78909C',
  arrowCrit:  '#E57373',
  selGlow:    'rgba(25,118,210,0.35)',
};

function _themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const g  = (v, fb) => cs.getPropertyValue(v).trim() || fb;
  return {
    hdrBg:     g('--clr-surface',  C.hdrBg),
    hdrLine:   g('--clr-border',   C.hdrLine),
    text:      g('--clr-text',     C.text),
    textLight: g('--clr-text-3',   C.textLight),
    arrow:     g('--clr-text-3',   C.arrow),
    bgBody:    g('--clr-bg',       '#FFFFFF'),
  };
}

const MESES_CORTO = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

export class GanttCanvas {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {GanttScene} scene
   */
  constructor(canvas, scene) {
    this._canvas  = canvas;
    this._scene   = scene;
    this._ctx     = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    this._raf     = null;
    this._dirty   = true;
    this._dpr     = window.devicePixelRatio || 1;

    // Estado de pan
    this._panning = false;
    this._panStart = { x: 0, y: 0, sx: 0, sy: 0 };

    // Propiedades visibles en las barras Gantt
    this._barLabels   = new Set(['name']);

    // Modo enlace FS interactivo
    this._linkMode    = false;
    this._pendingPred = null;  // {id, x, y} — primer clic (fin de barra)
    this._hoverHandle = null;  // {id, side:'end'|'start', x, y} — handle bajo el mouse
    this._mousePos    = { x: 0, y: 0 }; // posición actual del mouse

    // Tooltip flotante
    this._tooltip = this._createTooltip();

    this._bindEvents();
    this._initResizeObserver();
    // Primer resize tras construcción
    requestAnimationFrame(() => this._resize());
  }

  // ============================================================
  // Tamaño y resize
  // ============================================================

  _initResizeObserver() {
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this._canvas.parentElement);
  }

  _resize() {
    const parent = this._canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    this._dpr = dpr;
    this._canvas.style.width  = w + 'px';
    this._canvas.style.height = h + 'px';
    this._canvas.width  = Math.round(w * dpr);
    this._canvas.height = Math.round(h * dpr);
    // Re-escalar cada vez (el scale se resetea al cambiar width/height)
    this._ctx.scale(dpr, dpr);
    this.requestRender();
  }

  // ============================================================
  // Eventos de interacción
  // ============================================================

  _bindEvents() {
    const c = this._canvas;
    c.addEventListener('mousedown',  e => this._onDown(e));
    c.addEventListener('mousemove',  e => this._onMove(e));
    c.addEventListener('mouseup',    e => this._onUp(e));
    c.addEventListener('mouseleave', e => this._onLeave(e));
    c.addEventListener('wheel',      e => this._onWheel(e), { passive: false });
    c.addEventListener('click',      e => this._onClick(e));

    // Cancelar modo enlace con Escape
    this._onKeyDown = (e) => {
      if (e.key === 'Escape' && this._linkMode) {
        this._pendingPred = null;
        this.requestRender();
      }
    };
    document.addEventListener('keydown', this._onKeyDown);

    // Sincronizar scrollY desde la tabla WBS
    this._onWbsScrollY = /** @type {any} */ ((e) => {
      this._scene.scrollY = e.detail.scrollY;
      this.requestRender();
    });
    document.addEventListener('wbs-scroll-y', this._onWbsScrollY);
  }

  destroy() {
    document.removeEventListener('keydown', this._onKeyDown);
    document.removeEventListener('wbs-scroll-y', this._onWbsScrollY);
    this._ro?.disconnect();
  }

  _onDown(e) {
    if (e.button !== 0) return;
    if (this._linkMode) return; // en modo enlace no se hace pan
    this._panning = true;
    this._panStart = {
      x: e.clientX, y: e.clientY,
      sx: this._scene.scrollX, sy: this._scene.scrollY,
    };
    this._canvas.style.cursor = 'grabbing';
  }

  _onMove(e) {
    const rect = this._canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    this._mousePos = { x: cx, y: cy };

    if (this._linkMode) {
      this._hoverHandle = this._getBarHandleAt(cx, cy);
      const cur = this._hoverHandle ? 'crosshair' : (this._pendingPred ? 'crosshair' : 'default');
      this._canvas.style.cursor = cur;
      this.requestRender();
      return;
    }

    if (this._panning) {
      const dx = e.clientX - this._panStart.x;
      const dy = e.clientY - this._panStart.y;
      this._scene.scrollX = this._panStart.sx - dx;
      this._scene.scrollY = this._panStart.sy - dy;
      this._scene.clampScrollX(this._canvas.clientWidth);
      this._scene.clampScrollY(this._canvas.clientHeight);
      document.dispatchEvent(new CustomEvent('gantt-scroll-y', { detail: { scrollY: this._scene.scrollY } }));
      this._hideTooltip();
      this.requestRender();
      return;
    }

    // Tooltip al pasar sobre una barra
    const barId = this._getBarAt(cx, cy);
    if (barId) {
      const state = appState.state;
      const task  = state.tasks.get(barId);
      const cpm   = this._scene.cpmResult?.tasks.get(barId);
      const cal   = this._scene.calendar;
      const ps    = this._scene.projectStart;
      if (task && cpm && cal && ps) {
        const fmt = (/** @type {Date} */ d) => d.toLocaleDateString('es-PE', { day:'2-digit', month:'short', year:'numeric' });
        let lines = `<strong>${_esc(task.name)}</strong>`;
        if (task.type === 'milestone') {
          const d = cal.idxToDate(cpm.es, ps);
          lines += `\nFecha: ${fmt(d)}`;
        } else {
          if (cpm.es != null) lines += `\nInicio: ${fmt(cal.idxToDate(cpm.es, ps))}`;
          if (cpm.ef != null) lines += `\nFin: ${fmt(cal.finishDate(cpm.ef, ps))}`;
          if (cpm.es != null && cpm.ef != null) lines += `\nDuración: ${cpm.ef - cpm.es} d`;
          if (cpm.tf != null) lines += `\nFloat: ${cpm.tf} d`;
          if (task.percent_complete != null) lines += `\nAvance: ${task.percent_complete}%`;

          // Comparativa línea base (P6 style: BL Inicio / BL Fin / Δ días)
          const blData = appState.state.baselineData;
          if (blData) {
            const bl = blData.get(barId);
            if (bl != null) {
              const blMeta = appState.state.baselineMeta;
              const blLabel = blMeta?.name ? _esc(blMeta.name) : 'Línea base';
              lines += `\n─── ${blLabel} ───`;
              if (bl.es != null) lines += `\nBL Inicio: ${fmt(cal.idxToDate(bl.es, ps))}`;
              if (bl.ef != null) lines += `\nBL Fin: ${fmt(cal.finishDate(bl.ef, ps))}`;
              if (bl.dur != null) lines += `\nBL Duración: ${bl.dur} d`;
              // Varianza (días laborables)
              if (cpm.es != null && bl.es != null) {
                const vi = cpm.es - bl.es;
                const icon = vi > 3 ? '🔴' : vi > 0 ? '🟡' : vi < 0 ? '🟢' : '🟢';
                lines += `\n${icon} ΔInicio: ${vi > 0 ? '+' : ''}${vi} d`;
              }
              if (cpm.ef != null && bl.ef != null) {
                const vf = cpm.ef - bl.ef;
                const icon = vf > 3 ? '🔴' : vf > 0 ? '🟡' : vf < 0 ? '🟢' : '🟢';
                lines += `\n${icon} ΔFin: ${vf > 0 ? '+' : ''}${vf} d`;
              }
            }
          }
        }
        this._showTooltip(lines, e.clientX, e.clientY);
      }
    } else {
      this._hideTooltip();
    }
  }

  _onUp(_e) {
    this._panning = false;
    this._canvas.style.cursor = this._linkMode ? 'crosshair' : 'grab';
  }

  _onLeave(_e) {
    this._panning = false;
    this._hoverHandle = null;
    if (this._linkMode) this.requestRender();
    this._canvas.style.cursor = 'grab';
    this._hideTooltip();
  }

  // ---- Tooltip flotante ----

  _createTooltip() {
    const el = document.createElement('div');
    el.id = 'gantt-bar-tooltip';
    el.setAttribute('role', 'tooltip');
    el.style.cssText = [
      'position:fixed',
      'z-index:200',
      'display:none',
      'pointer-events:none',
      'background:var(--clr-surface,#fff)',
      'border:1px solid var(--clr-border,#e5e7eb)',
      'border-radius:var(--radius-sm,4px)',
      'box-shadow:var(--shadow-md,0 4px 12px rgba(0,0,0,.15))',
      'padding:6px 10px',
      'font-family:var(--font-ui,sans-serif)',
      'font-size:var(--text-xs,11px)',
      'color:var(--clr-text,#111)',
      'max-width:260px',
      'line-height:1.5',
      'white-space:pre-wrap',
      'word-break:break-word',
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  _showTooltip(html, clientX, clientY) {
    const el = this._tooltip;
    el.innerHTML = html;
    el.style.display = 'block';
    // Position near cursor, flipping if near right/bottom edge
    const margin = 12;
    const W = window.innerWidth, H = window.innerHeight;
    let left = clientX + margin;
    let top  = clientY + margin;
    requestAnimationFrame(() => {
      const tw = el.offsetWidth, th = el.offsetHeight;
      if (left + tw > W - 8) left = clientX - tw - margin;
      if (top  + th > H - 8) top  = clientY - th - margin;
      el.style.left = Math.max(4, left) + 'px';
      el.style.top  = Math.max(4, top)  + 'px';
    });
  }

  _hideTooltip() {
    this._tooltip.style.display = 'none';
  }

  /** Hit-test: devuelve el task.id de la barra bajo (cx,cy) en coordenadas canvas, o null */
  _getBarAt(cx, cy) {
    const scene = this._scene;
    const { rows, headerHeight, rowHeight, scrollY, cpmResult, calendar, projectStart } = scene;
    if (!cpmResult || !calendar || !projectStart || cy < headerHeight) return null;
    const state = appState.state;
    const W = this._canvas.clientWidth;

    for (let i = 0; i < rows.length; i++) {
      const rowY = headerHeight + i * rowHeight - scrollY;
      if (cy < rowY || cy > rowY + rowHeight) continue;

      const row  = rows[i];
      const task = state.tasks.get(row.id);
      const cpm  = cpmResult.tasks.get(row.id);
      if (!task || !cpm || cpm.es == null) continue;

      if (task.type === 'milestone') {
        const d  = calendar.idxToDate(cpm.es, projectStart);
        const mx = scene._dateToXAbs(d) - scene.scrollX;
        const half = rowHeight * 0.4;
        if (Math.abs(cx - mx) <= half && Math.abs(cy - (rowY + rowHeight / 2)) <= half) return row.id;
        continue;
      }

      const startD = calendar.idxToDate(cpm.es, projectStart);
      const endD   = calendar.finishDate(cpm.ef, projectStart);
      const x1 = scene._dateToXAbs(startD) - scene.scrollX;
      const x2 = scene._dateToXAbs(endD)   - scene.scrollX + scene.pixPerDay;
      const cx1 = Math.max(0, Math.min(W, x1));
      const cx2 = Math.max(0, Math.min(W, x2));
      if (cx >= cx1 - 2 && cx <= cx2 + 2) return row.id;
    }
    return null;
  }

  _onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Zoom centrado en el cursor
      const rect  = this._canvas.getBoundingClientRect();
      const mx    = e.clientX - rect.left;
      const xAbs  = mx + this._scene.scrollX; // posición absoluta bajo el cursor
      const factor = e.deltaY < 0 ? 1.12 : 0.88;
      const newPpd = Math.max(2, Math.min(80, this._scene.pixPerDay * factor));
      const scale  = newPpd / this._scene.pixPerDay;
      this._scene.pixPerDay = newPpd;
      this._scene.scrollX   = xAbs * scale - mx;
      this._scene.clampScrollX(this._canvas.clientWidth);
    } else if (Math.abs(e.shiftKey ? e.deltaY : e.deltaX) > 0 || !e.shiftKey) {
      this._scene.scrollX += e.shiftKey ? e.deltaY : (e.deltaX || e.deltaY);
      this._scene.clampScrollX(this._canvas.clientWidth);
    }
    this.requestRender();
  }

  _onClick(e) {
    if (this._panning) return;
    const rect = this._canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (this._linkMode) {
      this._handleLinkClick(cx, cy);
      return;
    }

    const ri = this._scene.yToRowIndex(cy);
    if (ri >= 0 && ri < this._scene.rows.length) {
      appState.selectTask(this._scene.rows[ri].id);
    }
  }

  _handleLinkClick(cx, cy) {
    const handle = this._getBarHandleAt(cx, cy);

    if (!this._pendingPred) {
      // Primer clic: debe ser el FIN de una barra (extremo derecho)
      if (handle && handle.side === 'end') {
        this._pendingPred = { id: handle.id, x: handle.x, y: handle.y };
        this.requestRender();
      }
    } else {
      // Segundo clic: debe ser el INICIO de otra barra (extremo izquierdo)
      if (handle && handle.side === 'start' && handle.id !== this._pendingPred.id) {
        const predId = this._pendingPred.id;
        const succId = handle.id;
        this._pendingPred = null;
        this.requestRender();
        // Crear dependencia FS
        document.dispatchEvent(new CustomEvent('gantt-add-dep', {
          detail: { predId, succId, type: 'FS', lag: 0 },
        }));
      } else if (!handle || handle.id !== this._pendingPred.id) {
        // Clic en espacio vacío o misma tarea → cancelar
        this._pendingPred = null;
        this.requestRender();
      }
    }
  }

  // Devuelve el handle (inicio o fin de barra) más cercano al punto (cx, cy)
  _getBarHandleAt(cx, cy) {
    const scene  = this._scene;
    const { rows, headerHeight, rowHeight, scrollY, cpmResult, calendar, projectStart } = scene;
    if (!cpmResult || !calendar || !projectStart) return null;
    const state = appState.state;
    const HIT = 16;
    const W   = this._canvas.clientWidth;

    for (let i = 0; i < rows.length; i++) {
      const rowY = headerHeight + i * rowHeight - scrollY;
      if (cy < rowY - 4 || cy > rowY + rowHeight + 4) continue;

      const row  = rows[i];
      const task = state.tasks.get(row.id);
      const cpm  = cpmResult.tasks.get(row.id);
      if (!task || !cpm || cpm.es == null) continue;

      const midY = rowY + rowHeight / 2;

      if (task.type === 'milestone') {
        const d = calendar.idxToDate(cpm.es, projectStart);
        const mx = Math.max(HIT, Math.min(W - HIT, scene._dateToXAbs(d) - scene.scrollX));
        if (Math.abs(cx - mx) <= HIT) return { id: row.id, side: 'end', x: mx, y: midY };
        continue;
      }

      const startD = calendar.idxToDate(cpm.es, projectStart);
      const endD   = calendar.finishDate(cpm.ef, projectStart);
      const x1raw = scene._dateToXAbs(startD) - scene.scrollX;
      const x2raw = scene._dateToXAbs(endD)   - scene.scrollX + scene.pixPerDay;
      // Clamp handles to visible canvas area so off-screen bar edges are still clickable
      const x1 = Math.max(2, Math.min(W - 2, x1raw));
      const x2 = Math.max(2, Math.min(W - 2, x2raw));

      if (Math.abs(cx - x2) <= HIT) return { id: row.id, side: 'end',   x: x2raw, y: midY };
      if (Math.abs(cx - x1) <= HIT) return { id: row.id, side: 'start', x: x1raw, y: midY };
    }
    return null;
  }

  // ============================================================
  // API pública: modo enlace
  // ============================================================

  /** @param {boolean} on */
  setLinkMode(on) {
    this._linkMode    = on;
    this._pendingPred = null;
    this._hoverHandle = null;
    this._canvas.style.cursor = on ? 'crosshair' : 'grab';
    this.requestRender();
  }

  // ============================================================
  // API pública
  // ============================================================

  requestRender() {
    this._dirty = true;
    if (!this._raf) {
      this._raf = requestAnimationFrame(() => {
        this._raf = null;
        if (this._dirty) { this._dirty = false; this._draw(); }
      });
    }
  }

  /** Actualizar filas visibles (llamado desde wbs-table) */
  updateRows(rows) {
    this._scene.rows = rows;
    this.requestRender();
  }

  /** Definir qué propiedades se muestran en las barras Gantt */
  setBarLabels(labels) {
    this._barLabels = new Set(labels);
    this.requestRender();
  }

  /** Ajustar zoom para que las barras ocupen el 95% del canvas */
  fitToView() {
    const W = this._canvas.clientWidth;
    if (W === 0) return;

    const { rows, cpmResult, calendar, projectStart } = this._scene;

    if (!cpmResult || !calendar || !projectStart || !rows.length) {
      const days = this._scene.totalCalendarDays;
      if (days <= 0) return;
      this._scene.pixPerDay = Math.max(2, Math.min(80, W / days));
      this._scene.scrollX   = 0;
      this.requestRender();
      return;
    }

    // Calcular extensión real de las barras en días calendario
    let minCalDay = Infinity, maxCalDay = -Infinity;
    for (const { id } of rows) {
      const cpm = cpmResult.tasks.get(id);
      if (!cpm || cpm.es == null || cpm.ef == null) continue;
      const startDate = calendar.idxToDate(cpm.es, projectStart);
      const endDate   = calendar.finishDate(cpm.ef, projectStart);
      const s = (startDate.getTime() - projectStart.getTime()) / 86400000;
      const e = (endDate.getTime()   - projectStart.getTime()) / 86400000 + 1;
      if (s < minCalDay) minCalDay = s;
      if (e > maxCalDay) maxCalDay = e;
    }

    if (!isFinite(minCalDay) || maxCalDay <= minCalDay) {
      const days = this._scene.totalCalendarDays;
      if (days <= 0) return;
      this._scene.pixPerDay = Math.max(2, Math.min(80, W / days));
      this._scene.scrollX   = 0;
      this.requestRender();
      return;
    }

    const barSpan   = maxCalDay - minCalDay;
    const MARGIN    = 0.025;          // 2.5% margen a cada lado → 95% para barras
    const pixPerDay = Math.max(2, Math.min(80, (W * (1 - 2 * MARGIN)) / barSpan));
    const scrollX   = minCalDay * pixPerDay - W * MARGIN;

    this._scene.pixPerDay = pixPerDay;
    this._scene.scrollX   = Math.max(0, scrollX);
    this.requestRender();
  }

  /** Ampliar zoom un paso (~20%) centrado en el canvas */
  zoomIn() {
    const W = this._canvas.clientWidth;
    const cx = W / 2 + this._scene.scrollX;
    const newPpd = Math.min(80, this._scene.pixPerDay * 1.2);
    const scale  = newPpd / this._scene.pixPerDay;
    this._scene.pixPerDay = newPpd;
    this._scene.scrollX   = cx * scale - W / 2;
    this._scene.clampScrollX(W);
    this.requestRender();
  }

  /** Reducir zoom un paso (~20%) centrado en el canvas */
  zoomOut() {
    const W = this._canvas.clientWidth;
    const cx = W / 2 + this._scene.scrollX;
    const newPpd = Math.max(2, this._scene.pixPerDay / 1.2);
    const scale  = newPpd / this._scene.pixPerDay;
    this._scene.pixPerDay = newPpd;
    this._scene.scrollX   = Math.max(0, cx * scale - W / 2);
    this._scene.clampScrollX(W);
    this.requestRender();
  }

  // ============================================================
  // Ciclo de dibujo principal
  // ============================================================

  _draw() {
    const ctx   = this._ctx;
    const W     = this._canvas.clientWidth;
    const H     = this._canvas.clientHeight;
    if (W === 0 || H === 0) return;

    const { headerHeight, scrollX, scrollY, projectStart } = this._scene;

    ctx.clearRect(0, 0, W, H);

    this._TC = _themeColors();

    // Fondo del cuerpo
    ctx.fillStyle = this._TC.bgBody;
    ctx.fillRect(0, headerHeight, W, H - headerHeight);

    if (!projectStart) {
      this._drawPlaceholder(W, H);
      return;
    }

    this._drawWeekendBands(W, H);
    this._drawRowBands(W, H);
    this._drawTodayLine(H);
    this._drawDataDateLine(H);
    this._drawArrows(W, H);
    this._drawBars(W, H);
    if (this._linkMode) this._drawLinkOverlay(W, H);
    this._drawHeader(W);

    // Notify histogram panel of current viewport for date-axis alignment
    if (this._scene.projectStart) {
      document.dispatchEvent(new CustomEvent('gantt-viewport', {
        detail: {
          pixPerDay:    this._scene.pixPerDay,
          scrollX:      this._scene.scrollX,
          projectStart: this._scene.projectStart,
        }
      }));
    }
  }

  _drawPlaceholder(W, H) {
    const ctx = this._ctx;
    ctx.fillStyle = this._TC?.textLight ?? C.textLight;
    ctx.font = '14px "Urbanist", system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Cargando proyecto…', W / 2, H / 2);
    ctx.textAlign = 'left';
  }

  // ============================================================
  // Encabezado de tiempo (meses + semanas/días)
  // ============================================================

  _drawHeader(W) {
    const ctx = this._ctx;
    const { headerHeight } = this._scene;
    const midH = headerHeight / 2;

    // Fondo
    ctx.fillStyle = this._TC?.hdrBg ?? C.hdrBg;
    ctx.fillRect(0, 0, W, headerHeight);

    // Borde inferior
    ctx.strokeStyle = this._TC?.hdrLine ?? C.hdrLine;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, headerHeight); ctx.lineTo(W, headerHeight); ctx.stroke();
    // Divisor entre meses y semanas
    ctx.beginPath(); ctx.moveTo(0, midH); ctx.lineTo(W, midH); ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, headerHeight);
    ctx.clip();
    this._drawMonthRow(W, midH);
    this._drawWeekRow(W, midH, headerHeight);
    ctx.restore();
  }

  _drawMonthRow(W, midH) {
    const ctx = this._ctx;
    const { pixPerDay, scrollX, projectStart } = this._scene;
    const msPerDay = 86400000;

    const leftDate  = new Date(projectStart.getTime() + (scrollX / pixPerDay) * msPerDay);
    const rightDate = new Date(projectStart.getTime() + ((scrollX + W) / pixPerDay) * msPerDay);

    let d = new Date(leftDate.getFullYear(), leftDate.getMonth(), 1);

    ctx.font = '600 11px "Urbanist", system-ui';
    ctx.fillStyle = this._TC?.text ?? C.text;
    ctx.textBaseline = 'middle';

    while (d <= rightDate) {
      const x0 = this._scene._dateToXAbs(d) - scrollX;
      const d1 = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const x1 = this._scene._dateToXAbs(d1) - scrollX;

      ctx.strokeStyle = this._TC?.hdrLine ?? C.hdrLine;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0, midH); ctx.stroke();

      const label = `${MESES_CORTO[d.getMonth()]} ${d.getFullYear()}`;
      const lx = Math.max(x0 + 4, 4);
      if ((x1 - Math.max(x0, 0)) > 22) {
        ctx.fillText(label, lx, midH / 2);
      }
      d = d1;
    }
  }

  _drawWeekRow(W, midH, headerHeight) {
    const ctx = this._ctx;
    const { pixPerDay, scrollX, projectStart } = this._scene;
    const msPerDay  = 86400000;
    const weekPx    = pixPerDay * 7;
    if (weekPx < 12) return;

    const leftDate  = new Date(projectStart.getTime() + (scrollX / pixPerDay) * msPerDay);
    const rightDate = new Date(projectStart.getTime() + ((scrollX + W) / pixPerDay) * msPerDay);

    // Retroceder al lunes anterior
    let d = new Date(leftDate);
    d.setHours(0,0,0,0);
    const dow = d.getDay();
    d.setDate(d.getDate() - ((dow + 6) % 7));

    ctx.font = '10px "IBM Plex Sans", monospace';
    ctx.fillStyle = this._TC?.textLight ?? C.textLight;
    ctx.textBaseline = 'middle';
    const rowH = headerHeight - midH;
    const cy   = midH + rowH / 2;

    while (d <= rightDate) {
      const x = this._scene._dateToXAbs(d) - scrollX;
      ctx.strokeStyle = this._TC?.hdrLine ?? C.hdrLine; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(x, midH); ctx.lineTo(x, headerHeight); ctx.stroke();

      if (weekPx >= 28) {
        const label = pixPerDay >= 18 ? String(d.getDate()) : 'S' + _isoWeek(d);
        ctx.fillText(label, x + 3, cy);
      }
      d = new Date(d.getTime() + 7 * msPerDay);
    }
  }

  // ============================================================
  // Bandas y grid
  // ============================================================

  _drawWeekendBands(W, H) {
    const ctx = this._ctx;
    const { pixPerDay, scrollX, headerHeight, projectStart } = this._scene;
    if (!projectStart || pixPerDay < 2) return;

    const msPerDay  = 86400000;
    const leftDate  = new Date(projectStart.getTime() + (scrollX / pixPerDay) * msPerDay);
    const rightDate = new Date(projectStart.getTime() + ((scrollX + W) / pixPerDay) * msPerDay);

    let d = new Date(leftDate);
    d.setHours(0,0,0,0);

    ctx.fillStyle = C.weekend;
    while (d <= rightDate) {
      const dow = d.getDay();
      if (dow === 0 || dow === 6) {
        const x = this._scene._dateToXAbs(d) - scrollX;
        ctx.fillRect(x, headerHeight, pixPerDay + 0.5, H - headerHeight);
      }
      d = new Date(d.getTime() + msPerDay);
    }
  }

  _drawRowBands(W, H) {
    const ctx = this._ctx;
    const { headerHeight, rowHeight, scrollY, rows } = this._scene;
    const startRow = Math.floor(scrollY / rowHeight);
    const endRow   = Math.min(rows.length, startRow + Math.ceil((H - headerHeight) / rowHeight) + 2);

    ctx.strokeStyle = C.gridLine;
    ctx.lineWidth   = 0.5;

    for (let i = startRow; i < endRow; i++) {
      const y = headerHeight + i * rowHeight - scrollY;
      if (y > H) break;
      if (i % 2 === 0) { ctx.fillStyle = C.rowOdd; ctx.fillRect(0, y, W, rowHeight); }
      ctx.beginPath(); ctx.moveTo(0, y + rowHeight); ctx.lineTo(W, y + rowHeight); ctx.stroke();
    }
  }

  // ============================================================
  // Líneas de referencia
  // ============================================================

  _drawTodayLine(H) {
    const { projectStart, scrollX, headerHeight } = this._scene;
    if (!projectStart) return;
    const today = new Date(); today.setHours(0,0,0,0);
    const x = this._scene._dateToXAbs(today) - scrollX;
    if (x < 0 || x > this._canvas.clientWidth) return;

    const ctx = this._ctx;
    ctx.save();
    ctx.strokeStyle = C.today;
    ctx.lineWidth   = 1.5;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(x, headerHeight); ctx.lineTo(x, H); ctx.stroke();
    ctx.restore();
  }

  _drawDataDateLine(H) {
    const proj = appState.state.project;
    if (!proj?.data_date) return;
    const { projectStart, scrollX, headerHeight } = this._scene;
    if (!projectStart) return;

    const dd = new Date(proj.data_date + 'T00:00:00');
    const x  = this._scene._dateToXAbs(dd) - scrollX;
    if (x < 0 || x > this._canvas.clientWidth) return;

    const ctx = this._ctx;
    ctx.save();
    ctx.strokeStyle = C.dataDate;
    ctx.lineWidth   = 2;
    ctx.globalAlpha = 0.7;
    ctx.setLineDash([7, 3]);
    ctx.beginPath(); ctx.moveTo(x, headerHeight); ctx.lineTo(x, H); ctx.stroke();
    ctx.restore();
  }

  // ============================================================
  // Barras de tareas
  // ============================================================

  _barColor(task, cpm) {
    if (!cpm) return C.normal;
    if ((task.percent_complete ?? 0) >= 100) return C.done;
    if (task.type === 'milestone') return C.milestone;
    if (cpm.is_summary) return C.summary;
    if (cpm.is_critical) return C.critical;
    const near = appState.state.nearThreshold ?? 5;
    if (cpm.tf != null && cpm.tf >= 0 && cpm.tf <= near) return C.near;
    return C.normal;
  }

  _drawBars(W, H) {
    const ctx    = this._ctx;
    const scene  = this._scene;
    const { rows, headerHeight, rowHeight, scrollY, cpmResult, calendar, projectStart } = scene;
    if (!cpmResult || !calendar || !projectStart) return;

    const state      = appState.state;
    const selectedId = state.selectedTaskId;

    rows.forEach((row, i) => {
      const y0 = headerHeight + i * rowHeight - scrollY;
      if (y0 + rowHeight < headerHeight || y0 > H) return;

      const task = state.tasks.get(row.id);
      const cpm  = cpmResult.tasks.get(row.id);
      if (!task || !cpm) return;

      const color    = this._barColor(task, cpm);
      const selected = task.id === selectedId;

      // ---- Línea base (doble barra: estilo MS Project + P6) ----
      const baselineData = state.baselineData;
      if (baselineData && !row.isSummary && task.type !== 'milestone') {
        const bl = baselineData.get(row.id);
        if (bl != null) {
          const blStart = calendar.idxToDate(bl.es, projectStart);
          const blEnd   = calendar.finishDate(bl.ef, projectStart);
          const bx1 = scene._dateToXAbs(blStart) - scene.scrollX;
          const bx2 = scene._dateToXAbs(blEnd)   - scene.scrollX + scene.pixPerDay;
          if (bx2 > 0 && bx1 < W) {
            const blW  = Math.max(bx2 - bx1, 3);
            // Barra base: parte inferior de la fila (estilo MS Project doble barra)
            const blH  = Math.max(5, Math.round(rowHeight * 0.25));
            const blY  = y0 + rowHeight - blH - 2;
            ctx.save();
            // Relleno sólido índigo (P6: color distinto al bar actual)
            ctx.globalAlpha = 0.72;
            ctx.fillStyle   = '#6366f1';
            _roundRect(ctx, bx1, blY, blW, blH, 2);
            ctx.fill();
            // Borde más oscuro para contraste
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = '#4338ca';
            ctx.lineWidth   = 1;
            _roundRect(ctx, bx1, blY, blW, blH, 2);
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      if (task.type === 'milestone') {
        this._drawMilestone(ctx, cpm.es, y0, rowHeight, color, selected, scene);
        return;
      }

      const startDate = calendar.idxToDate(cpm.es, projectStart);
      const endDate   = calendar.finishDate(cpm.ef, projectStart);
      const x1 = scene._dateToXAbs(startDate) - scene.scrollX;
      const x2 = scene._dateToXAbs(endDate)   - scene.scrollX + scene.pixPerDay;
      const barW = Math.max(x2 - x1, 2);

      if (x1 > W || x2 < 0) return; // fuera del viewport

      const pad  = row.isSummary ? 7 : 8;
      const barH = rowHeight - pad * 2;
      const barY = y0 + pad;

      if (row.isSummary) {
        this._drawSummaryBar(ctx, x1, x2, barY, barH, color, selected);
      } else {
        this._drawTaskBar(ctx, x1, barW, barY, barH, color, task.percent_complete ?? 0, selected);
      }

      // Etiqueta: dentro de la barra si cabe, o a la derecha si es angosta
      {
        const lbl = this._buildBarLabel(task, cpm, startDate, endDate);
        if (lbl) {
          if (barW > 32) {
            // Etiqueta dentro de la barra — color inteligente según avance
            const pct = task.percent_complete ?? 0;
            // Con avance >= 40%: fondo sólido → texto blanco; sin avance: fondo claro → texto de color
            const textClr   = pct >= 40 ? '#fff' : color;
            const shadowClr = pct >= 40 ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.85)';
            ctx.save();
            ctx.beginPath();
            ctx.rect(Math.max(0, x1 + 3), barY + 1, Math.min(barW - 6, W - Math.max(0, x1)), barH - 2);
            ctx.clip();
            ctx.font         = '500 10px "IBM Plex Sans", monospace';
            ctx.fillStyle    = textClr;
            ctx.textBaseline = 'middle';
            ctx.shadowColor  = shadowClr;
            ctx.shadowBlur   = 3;
            ctx.fillText(lbl, Math.max(x1 + 4, 4), barY + barH / 2, barW - 8);
            ctx.restore();
          } else {
            // Etiqueta a la derecha de la barra
            const labelX = x1 + barW + 4;
            if (labelX < W && labelX > 0) {
              ctx.save();
              ctx.font         = '500 10px "IBM Plex Sans", monospace';
              ctx.fillStyle    = this._TC?.text ?? C.text;
              ctx.textBaseline = 'middle';
              ctx.shadowBlur   = 0;
              ctx.fillText(lbl, labelX, barY + barH / 2, W - labelX - 4);
              ctx.restore();
            }
          }
        }
      }
    });
  }

  _drawTaskBar(ctx, x, w, y, h, color, pct, selected) {
    const r = 4;
    if (selected) { ctx.shadowColor = color; ctx.shadowBlur = 10; }

    // Fondo translúcido
    ctx.fillStyle = color + '22';
    _roundRect(ctx, x, y, w, h, r); ctx.fill();

    // Progreso con gradiente sutil
    if (pct > 0) {
      const pw = Math.min((pct / 100) * w, w);
      const grad = ctx.createLinearGradient(x, y, x, y + h);
      grad.addColorStop(0, color + 'EE');
      grad.addColorStop(0.45, color);
      grad.addColorStop(1, color + 'CC');
      ctx.fillStyle = grad;
      _roundRect(ctx, x, y, pw, h, r); ctx.fill();
    }

    // Borde
    ctx.strokeStyle = color;
    ctx.lineWidth   = selected ? 2 : 1;
    _roundRect(ctx, x, y, w, h, r); ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _drawSummaryBar(ctx, x1, x2, y, h, color, selected) {
    if (selected) { ctx.shadowColor = color; ctx.shadowBlur = 6; }
    const thinH = Math.max(2, Math.round(h * 0.35));
    const thinY = y + (h - thinH) / 2;
    const cap   = Math.min(h, 10);

    ctx.fillStyle = color;
    ctx.fillRect(x1, thinY, x2 - x1, thinH);

    // Triángulos en extremos
    ctx.beginPath();
    ctx.moveTo(x1, y); ctx.lineTo(x1, y + cap); ctx.lineTo(x1 + cap * 0.55, y + cap);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x2, y); ctx.lineTo(x2, y + cap); ctx.lineTo(x2 - cap * 0.55, y + cap);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
  }

  _drawMilestone(ctx, esIdx, rowY, rowH, color, selected, scene) {
    if (!scene.calendar || !scene.projectStart) return;
    const d = scene.calendar.idxToDate(esIdx, scene.projectStart);
    const x = scene._dateToXAbs(d) - scene.scrollX;
    const W = this._canvas.clientWidth;
    if (x < -20 || x > W + 20) return;

    const s  = Math.min(rowH * 0.42, 10);
    const cy = rowY + rowH / 2;

    if (selected) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, cy - s); ctx.lineTo(x + s, cy);
    ctx.lineTo(x, cy + s); ctx.lineTo(x - s, cy);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.shadowBlur = 0;
  }

  _buildBarLabel(task, cpm, startDate, endDate) {
    const bl    = this._barLabels;
    const parts = [];
    if (bl.has('name'))     parts.push(task.name);
    if (bl.has('pct'))      parts.push(`${task.percent_complete ?? 0}%`);
    if (bl.has('duration')) parts.push(`${task.duration_days ?? (cpm.ef - cpm.es)}d`);
    if (bl.has('start'))    parts.push(fmtDate(startDate));
    if (bl.has('finish'))   parts.push(fmtDate(endDate));
    if (bl.has('tf'))       parts.push(`HT:${cpm.tf}d`);
    return parts.join(' · ');
  }

  // ============================================================
  // Flechas de dependencias
  // ============================================================

  _drawArrows(W, H) {
    const ctx   = this._ctx;
    const scene = this._scene;
    const { rows, headerHeight, rowHeight, scrollY, cpmResult, calendar, projectStart } = scene;
    if (!cpmResult || !calendar || !projectStart) return;

    const state  = appState.state;
    const rowIdx = new Map(rows.map((r, i) => [r.id, i]));

    state.deps.forEach(dep => {
      if (dep.deleted_at) return;
      const predCpm = cpmResult.tasks.get(dep.pred_id);
      const succCpm = cpmResult.tasks.get(dep.succ_id);
      if (!predCpm || !succCpm) return;
      const pi = rowIdx.get(dep.pred_id);
      const si = rowIdx.get(dep.succ_id);
      if (pi == null || si == null) return;

      const py = headerHeight + pi * rowHeight - scrollY + rowHeight / 2;
      const sy = headerHeight + si * rowHeight - scrollY + rowHeight / 2;
      if (Math.max(py, sy) < headerHeight || Math.min(py, sy) > H) return;

      const predTask = state.tasks.get(dep.pred_id);
      const pFin  = predTask?.type === 'milestone'
        ? scene._dateToXAbs(calendar.idxToDate(predCpm.es, projectStart)) - scene.scrollX
        : scene._dateToXAbs(calendar.finishDate(predCpm.ef, projectStart)) - scene.scrollX + scene.pixPerDay;
      const pStart = scene._dateToXAbs(calendar.idxToDate(predCpm.es, projectStart)) - scene.scrollX;
      const sStart = scene._dateToXAbs(calendar.idxToDate(succCpm.es, projectStart)) - scene.scrollX;
      const sFin   = scene._dateToXAbs(calendar.finishDate(succCpm.ef, projectStart)) - scene.scrollX + scene.pixPerDay;

      const crit = predCpm.is_critical && succCpm.is_critical;
      ctx.strokeStyle = crit ? C.arrowCrit : (this._TC?.arrow ?? C.arrow);
      ctx.fillStyle   = ctx.strokeStyle;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([]);

      // Corredor horizontal para evitar cruzar barras: por el límite de fila del destino
      const corridorY = pi === si ? sy
        : si > pi
          ? headerHeight + si * rowHeight - scrollY       // arriba de la fila destino
          : headerHeight + (si + 1) * rowHeight - scrollY; // abajo de la fila destino

      switch (dep.type) {
        case 'FS': _arrowFS(ctx, pFin,   py, sStart, sy, corridorY); break;
        case 'SS': _arrowSS(ctx, pStart, py, sStart, sy); break;
        case 'FF': _arrowFF(ctx, pFin,   py, sFin,   sy); break;
        case 'SF': _arrowSF(ctx, pStart, py, sFin,   sy); break;
      }
    });
  }

  // ============================================================
  // Overlay del modo enlace
  // ============================================================

  _drawLinkOverlay(W, H) {
    const ctx   = this._ctx;
    const scene = this._scene;
    const { rows, headerHeight, rowHeight, scrollY, cpmResult, calendar, projectStart } = scene;
    if (!cpmResult || !calendar || !projectStart) return;

    // Dibujar una franja semitransparente para indicar que estamos en modo enlace
    ctx.save();
    ctx.fillStyle = 'rgba(25,118,210,0.05)';
    ctx.fillRect(0, headerHeight, W, H - headerHeight);

    // Instrucción
    const msg = this._pendingPred
      ? 'Clic en el INICIO de la barra destino  •  Esc para cancelar'
      : 'Clic en el FIN de la barra origen (extremo derecho)';
    ctx.font = '500 12px "Urbanist", system-ui';
    ctx.fillStyle = 'rgba(25,118,210,0.9)';
    ctx.textAlign = 'center';
    ctx.fillText(msg, W / 2, headerHeight + 18);
    ctx.textAlign = 'left';

    // Handles: círculos en los extremos de cada barra visible
    for (let i = 0; i < rows.length; i++) {
      const rowY = headerHeight + i * rowHeight - scrollY;
      if (rowY + rowHeight < headerHeight || rowY > H) continue;
      const row  = rows[i];
      const task = appState.state.tasks.get(row.id);
      const cpm  = cpmResult.tasks.get(row.id);
      if (!task || !cpm || cpm.es == null) continue;

      const midY = rowY + rowHeight / 2;
      const startD = calendar.idxToDate(cpm.es, projectStart);
      const endD   = task.type === 'milestone'
        ? startD
        : calendar.finishDate(cpm.ef, projectStart);
      const x1raw = scene._dateToXAbs(startD) - scene.scrollX;
      const x2raw = task.type === 'milestone' ? x1raw : scene._dateToXAbs(endD) - scene.scrollX + scene.pixPerDay;
      // Clamp to visible canvas so off-screen bar ends still show handles at the edge
      const x1 = Math.max(2, Math.min(W - 2, x1raw));
      const x2 = Math.max(2, Math.min(W - 2, x2raw));

      // handle fin (verde si es el pendingPred seleccionado)
      const isPendingPred = this._pendingPred?.id === row.id;
      const isHoverEnd    = this._hoverHandle?.id === row.id && this._hoverHandle?.side === 'end';
      const isHoverStart  = this._hoverHandle?.id === row.id && this._hoverHandle?.side === 'start';

      // Fin de barra → círculo de origen (verde)
      _drawHandle(ctx, x2, midY, isPendingPred ? '#1B5E20' : (isHoverEnd ? '#2E7D32' : '#81C784'), isPendingPred || isHoverEnd);
      // Inicio de barra → círculo de destino (azul), solo si hay pred pendiente
      if (this._pendingPred && row.id !== this._pendingPred.id) {
        _drawHandle(ctx, x1, midY, isHoverStart ? '#1565C0' : '#90CAF9', isHoverStart);
      }
    }

    // Línea elástica del pred al mouse
    if (this._pendingPred) {
      const { x: px, y: py } = this._pendingPred;
      const { x: mx, y: my } = this._mousePos;
      ctx.save();
      ctx.strokeStyle = '#1976D2';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(mx, my);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }
}

// ============================================================
// Helpers de dibujo (fuera de la clase)
// ============================================================

function _roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function _arrowHead(ctx, x, y, toLeft) {
  const s = 5;
  ctx.beginPath();
  if (toLeft) {
    ctx.moveTo(x, y); ctx.lineTo(x + s, y - s * 0.5); ctx.lineTo(x + s, y + s * 0.5);
  } else {
    ctx.moveTo(x, y); ctx.lineTo(x - s, y - s * 0.5); ctx.lineTo(x - s, y + s * 0.5);
  }
  ctx.closePath(); ctx.fill();
}

// Radius used for all bezier bevel corners
const _CR = 5;

function _qcurve(ctx, cx, cy, ex, ey) {
  ctx.quadraticCurveTo(cx, cy, ex, ey);
}

/**
 * Flecha FS ortogonal que NO cruza barras.
 * Ruta: salida derecha → baja/sube hasta corridorY (espacio entre filas) → derecha → baja/sube a y2.
 */
function _arrowFS(ctx, x1, y1, x2, y2, corridorY) {
  const off = 8, r = _CR;
  const dy1 = corridorY >= y1 ? 1 : -1;   // dirección y1 → corridorY
  const dy2 = y2 >= corridorY ? 1 : -1;   // dirección corridorY → y2

  ctx.beginPath();
  ctx.moveTo(x1, y1);

  if (x2 >= x1 + off * 2) {
    // Caso normal: salida derecha, baja a corredor, avanza derecha, baja a y2
    const ex = x1 + off;
    const en = x2 - off;
    const cr1 = Math.min(r, Math.abs(corridorY - y1) / 2, (en - ex) / 2 + 0.01);
    const cr2 = Math.min(r, Math.abs(y2 - corridorY) / 2, (en - ex) / 2 + 0.01);

    // → salida derecha
    ctx.lineTo(ex - cr1, y1);
    _qcurve(ctx, ex, y1, ex, y1 + dy1 * cr1);
    // ↓ hasta corredor
    ctx.lineTo(ex, corridorY - dy1 * cr1);
    _qcurve(ctx, ex, corridorY, ex + cr1, corridorY);
    // → avanza derecho por corredor
    ctx.lineTo(en - cr2, corridorY);
    _qcurve(ctx, en, corridorY, en, corridorY + dy2 * cr2);
    // ↓ hasta y2
    ctx.lineTo(en, y2 - dy2 * cr2);
    _qcurve(ctx, en, y2, en + cr2, y2);
    ctx.lineTo(x2, y2);
  } else {
    // Overlap/U-turn: pasa a la derecha de ambas barras, baja al corredor, entra al destino
    const mx  = Math.max(x1, x2) + off;
    const ix  = x2 - off;
    const cr1 = Math.min(r, Math.abs(corridorY - y1) / 2);
    const cr2 = Math.min(r, Math.abs(y2 - corridorY) / 2);

    ctx.lineTo(mx - cr1, y1);
    _qcurve(ctx, mx, y1, mx, y1 + dy1 * cr1);
    ctx.lineTo(mx, corridorY - dy1 * cr1);
    _qcurve(ctx, mx, corridorY, mx - cr1, corridorY);
    ctx.lineTo(ix + cr2, corridorY);
    _qcurve(ctx, ix, corridorY, ix, corridorY + dy2 * cr2);
    ctx.lineTo(ix, y2 - dy2 * cr2);
    _qcurve(ctx, ix, y2, ix + cr2, y2);
    ctx.lineTo(x2, y2);
  }

  ctx.stroke(); _arrowHead(ctx, x2, y2, false);
}

function _arrowSS(ctx, x1, y1, x2, y2) {
  const lx  = Math.min(x1, x2) - 9, r = _CR;
  const dy  = y2 >= y1 ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(lx + r, y1);
  _qcurve(ctx, lx, y1, lx, y1 + dy * r);
  ctx.lineTo(lx, y2 - dy * r);
  _qcurve(ctx, lx, y2, lx + r, y2);
  ctx.lineTo(x2, y2);
  ctx.stroke(); _arrowHead(ctx, x2, y2, false);
}

function _arrowFF(ctx, x1, y1, x2, y2) {
  const rx  = Math.max(x1, x2) + 9, r = _CR;
  const dy  = y2 >= y1 ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(rx - r, y1);
  _qcurve(ctx, rx, y1, rx, y1 + dy * r);
  ctx.lineTo(rx, y2 - dy * r);
  _qcurve(ctx, rx, y2, rx - r, y2);
  ctx.lineTo(x2, y2);
  ctx.stroke(); _arrowHead(ctx, x2, y2, true);
}

function _arrowSF(ctx, x1, y1, x2, y2) {
  const lx  = Math.min(x1, x2) - 9, r = _CR;
  const dy  = y2 >= y1 ? 1 : -1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(lx + r, y1);
  _qcurve(ctx, lx, y1, lx, y1 + dy * r);
  ctx.lineTo(lx, y2 - dy * r);
  _qcurve(ctx, lx, y2, lx + r, y2);
  ctx.lineTo(x2, y2);
  ctx.stroke(); _arrowHead(ctx, x2, y2, true);
}

function _drawHandle(ctx, x, y, color, large = false) {
  const r = large ? 6 : 4;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle   = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth   = 1.5;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function _isoWeek(d) {
  const tmp = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = tmp.getDay() || 7;
  tmp.setDate(tmp.getDate() + 4 - day);
  const y0 = new Date(tmp.getFullYear(), 0, 1);
  return Math.ceil(((tmp - y0) / 86400000 + 1) / 7);
}
