// @ts-check
/**
 * lookahead.js — Vista Lookahead 3/6 semanas.
 * Filtra y presenta tareas programadas en las próximas semanas laborables.
 */

import { appState } from './state.js';
import { Calendar, isoToDate } from './calendar.js';
import { printToPdf } from './pdf-utils.js';
import { calcWbsCodes } from './gantt-svg.js';

/** @param {*} s */
const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function _makeDraggable(dialog, handleSelector) {
  const handle = handleSelector ? dialog.querySelector(handleSelector) : dialog;
  if (!handle) return;
  let startX, startY, startLeft, startTop;
  handle.style.cursor = 'move';
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    if (/** @type {HTMLElement} */ (e.target).closest('button,input,select,textarea,a')) return;
    e.preventDefault();
    const rect = dialog.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY;
    startLeft = rect.left; startTop = rect.top;
    dialog.style.transform = 'none';
    dialog.style.position = 'fixed';
    dialog.style.margin = '0';
    dialog.style.left = startLeft + 'px';
    dialog.style.top = startTop + 'px';
    const onMove = mv => {
      dialog.style.left = (startLeft + mv.clientX - startX) + 'px';
      dialog.style.top  = (startTop  + mv.clientY - startY) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}


const STATUS_LABEL = { todo: 'Pendiente', in_progress: 'En Curso', done: 'Completada', delayed: 'Atrasada' };
const STATUS_COLOR = { todo: '#757575', in_progress: '#1976D2', done: '#388E3C', delayed: '#D32F2F' };

export class LookaheadPanel {
  /** @param {HTMLElement} containerEl */
  constructor(containerEl) {
    this.el = containerEl;
    /** @type {number} */
    this._weeks = 3;
    /** @type {Date|null} null = usar hoy */
    this._refDate = null;
    /** @type {Array<any>} */
    this._rows = [];
    this._build();
  }

  _build() {
    this.el.innerHTML = '';
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-ui);position:relative';

    const todayIso = new Date().toISOString().slice(0, 10);

    // Header
    const hdr = document.createElement('div');
    hdr.setAttribute('data-drag-handle', '');
    hdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 18px;padding-right:44px;border-bottom:1px solid var(--clr-border);flex-shrink:0;flex-wrap:wrap';
    hdr.innerHTML = `
      <span style="font-size:20px">📅</span>
      <div style="flex:1;min-width:140px">
        <div style="font-size:var(--text-md,14px);font-weight:600;color:var(--clr-text)">Vista Lookahead</div>
        <div style="font-size:11px;color:var(--clr-text-3)">Lookahead según cronograma maestro</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <label style="font-size:12px;color:var(--clr-text-2);display:flex;align-items:center;gap:4px">
          <span style="white-space:nowrap">Desde:</span>
          <input id="la-input-date" type="date" value="${todayIso}"
            style="padding:3px 6px;border:1px solid var(--clr-border);border-radius:4px;background:var(--clr-surface);color:var(--clr-text);font-size:12px;cursor:pointer">
        </label>
        <div style="width:1px;height:20px;background:var(--clr-border)"></div>
        <button id="la-btn-3" class="btn btn-sm" style="padding:4px 12px;font-size:12px">3 sem.</button>
        <button id="la-btn-6" class="btn btn-sm" style="padding:4px 12px;font-size:12px">6 sem.</button>
        <label style="font-size:12px;color:var(--clr-text-2);display:flex;align-items:center;gap:4px">
          <span style="white-space:nowrap">Semanas:</span>
          <input id="la-input-custom" type="number" min="1" max="52" value="${this._weeks}"
            style="width:54px;padding:3px 6px;border:1px solid var(--clr-border);border-radius:4px;background:var(--clr-surface);color:var(--clr-text);font-size:12px">
        </label>
        <button id="la-btn-refresh" class="btn btn-primary btn-sm" title="Actualizar vista" style="padding:4px 12px;font-size:12px;flex-shrink:0">↺ Actualizar</button>
        <button id="la-btn-print" class="btn btn-ghost btn-sm" title="Imprimir PDF" style="margin-left:2px;margin-right:36px">🖨 Imprimir</button>
      </div>`;
    this.el.appendChild(hdr);

    this._tbody = document.createElement('div');
    this._tbody.style.cssText = 'flex:1;overflow:auto;padding:12px 18px';
    this.el.appendChild(this._tbody);

    const _applyAndRefresh = () => {
      const dateInp = /** @type {HTMLInputElement|null} */ (this.el.querySelector('#la-input-date'));
      const weeksInp = /** @type {HTMLInputElement|null} */ (this.el.querySelector('#la-input-custom'));
      if (dateInp?.value) this._refDate = new Date(dateInp.value + 'T00:00:00');
      const w = parseInt(weeksInp?.value ?? '');
      if (w >= 1 && w <= 52) this._weeks = w;
      this.refresh();
    };
    hdr.querySelector('#la-input-date')?.addEventListener('change', _applyAndRefresh);
    hdr.querySelector('#la-input-date')?.addEventListener('input', _applyAndRefresh);
    hdr.querySelector('#la-btn-3')?.addEventListener('click', () => {
      this._weeks = 3;
      const inp = /** @type {HTMLInputElement|null} */ (this.el.querySelector('#la-input-custom'));
      if (inp) inp.value = '3';
      this.refresh();
    });
    hdr.querySelector('#la-btn-6')?.addEventListener('click', () => {
      this._weeks = 6;
      const inp = /** @type {HTMLInputElement|null} */ (this.el.querySelector('#la-input-custom'));
      if (inp) inp.value = '6';
      this.refresh();
    });
    hdr.querySelector('#la-input-custom')?.addEventListener('change', _applyAndRefresh);
    hdr.querySelector('#la-input-custom')?.addEventListener('input', _applyAndRefresh);
    hdr.querySelector('#la-btn-refresh')?.addEventListener('click', _applyAndRefresh);
    hdr.querySelector('#la-btn-print')?.addEventListener('click', () => {
      const rows = this._rows ?? [];
      const fmtDate = d => d.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });
      const _esc2 = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const COLORS = { todo:'#757575', in_progress:'#1976D2', done:'#388E3C', delayed:'#D32F2F' };
      const LABELS = { todo:'Pendiente', in_progress:'En Curso', done:'Completada', delayed:'Atrasada' };
      const refDate = this._refDate ? new Date(this._refDate) : new Date();
      const fmtRef2 = refDate.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });
      const wbsCodes = calcWbsCodes(appState.state.tasks ?? new Map());
      const html = `<h1 style="font-size:16px;margin-bottom:4px">Vista Lookahead — ${this._weeks} semanas desde ${fmtRef2}</h1>
        <p style="font-size:12px;color:#666;margin:0 0 12px">${rows.length} tarea(s)</p>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f4f5f7">
            <th style="border:1px solid #ccc;padding:6px 8px;text-align:center">EDT</th>
            <th style="border:1px solid #ccc;padding:6px 10px;text-align:left">Tarea</th>
            <th style="border:1px solid #ccc;padding:6px 10px;text-align:left">Inicio</th>
            <th style="border:1px solid #ccc;padding:6px 10px;text-align:left">Fin</th>
            <th style="border:1px solid #ccc;padding:6px 8px;text-align:center">Avance</th>
            <th style="border:1px solid #ccc;padding:6px 10px;text-align:left">Estado</th>
            <th style="border:1px solid #ccc;padding:6px 8px;text-align:center">Holgura</th>
          </tr></thead>
          <tbody>${rows.map((r, i) => `
            <tr style="background:${i%2===0?'#fff':'#f9f9f9'}">
              <td style="border:1px solid #ccc;padding:6px 8px;text-align:center;white-space:nowrap">${_esc2(wbsCodes.get(r.task.id) ?? '')}</td>
              <td style="border:1px solid #ccc;padding:6px 10px">${_esc2(r.task.name)}</td>
              <td style="border:1px solid #ccc;padding:6px 10px;white-space:nowrap">${fmtDate(r.startDate)}</td>
              <td style="border:1px solid #ccc;padding:6px 10px;white-space:nowrap">${fmtDate(r.endDate)}</td>
              <td style="border:1px solid #ccc;padding:6px 8px;text-align:center">${r.pct}%</td>
              <td style="border:1px solid #ccc;padding:6px 10px">
                <span style="color:${COLORS[r.status]};font-weight:600">${LABELS[r.status]}</span>
              </td>
              <td style="border:1px solid #ccc;padding:6px 8px;text-align:center;color:${r.cpm.tf===0?'#D32F2F':'#333'};font-weight:${r.cpm.tf===0?'700':'400'}">${r.cpm.tf ?? '-'}</td>
            </tr>`).join('')}
          </tbody>
        </table>`;
      printToPdf('Vista Lookahead', html);
    });
    const _laCloseBtn = document.createElement('button');
    _laCloseBtn.className = 'btn btn-ghost btn-icon btn-sm';
    _laCloseBtn.title = 'Cerrar';
    _laCloseBtn.setAttribute('aria-label', 'Cerrar');
    _laCloseBtn.textContent = '✕';
    _laCloseBtn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:20;font-size:16px;width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:50%';
    _laCloseBtn.addEventListener('click', () => {
      const p = document.getElementById('panel-lookahead');
      if (p) p.style.display = 'none';
    });
    this.el.appendChild(_laCloseBtn);
    if (this.el.parentElement) _makeDraggable(this.el.parentElement, '[data-drag-handle]');
    this.refresh();
  }

  refresh() {
    const { project, tasks, cpmResult, calendar, calExceptions } = appState.state;
    if (!project || !cpmResult) {
      this._tbody.innerHTML = '<p style="color:var(--clr-text-3);font-size:13px;padding:16px 0">Abre un proyecto con CPM calculado para ver el lookahead.</p>';
      return;
    }

    const cal = new Calendar({
      work_week: calendar?.work_week ?? [1,2,3,4,5],
      exceptions: (calExceptions ?? []).filter(ex => !ex.deleted_at),
    });
    const startDate = isoToDate(project.start_date || new Date().toISOString().slice(0,10));
    const today = new Date();
    today.setHours(0,0,0,0);

    // refDate: fecha desde la cual inicia la ventana (puede ser elegida por el usuario)
    const refDate = this._refDate ? new Date(this._refDate) : new Date(today);
    refDate.setHours(0,0,0,0);

    // todayIdx: índice de día laboral de hoy (para clasificar "Atrasada")
    let todayIdx = 0;
    {
      const d = new Date(startDate);
      while (d < today) {
        if (cal.isWorkingDay(d)) todayIdx++;
        d.setDate(d.getDate() + 1);
      }
    }

    // refIdx: índice de día laboral de la fecha de inicio elegida
    let refIdx = 0;
    {
      const d = new Date(startDate);
      while (d < refDate) {
        if (cal.isWorkingDay(d)) refIdx++;
        d.setDate(d.getDate() + 1);
      }
    }

    const daysPerWeek = Math.max(1, (calendar?.work_week ?? [1,2,3,4,5]).length);
    const horizonDays = this._weeks * daysPerWeek;
    const windowEnd = refIdx + horizonDays;

    /** @type {Array<{task:object, cpm:object, status:string, pct:number, startDate:Date, endDate:Date}>} */
    const rows = [];

    for (const task of tasks.values()) {
      if (task.deleted_at || task.type === 'summary') continue;
      const cpm = cpmResult.tasks?.get(task.id);
      if (!cpm || cpm.is_summary) continue;
      const pct = task.percent_complete ?? 0;
      // Tarea en ventana: [es, ef) ∩ [refIdx, windowEnd)
      const inWindow = cpm.ef > refIdx && cpm.es < windowEnd;
      // Tarea atrasada respecto a HOY: ef antes de hoy y no completada
      const isDelayed = pct < 100 && cpm.ef <= todayIdx;
      if (!inWindow && !isDelayed) continue;

      const status = pct >= 100 ? 'done' : (pct < 100 && cpm.ef <= todayIdx) ? 'delayed' : pct > 0 ? 'in_progress' : 'todo';

      const sDate = cal.idxToDate(cpm.es, startDate);
      const eDate = cal.idxToDate(Math.max(cpm.es, cpm.ef - 1), startDate);
      rows.push({ task, cpm, status, pct, startDate: sDate, endDate: eDate });
    }

    rows.sort((a, b) => a.cpm.es - b.cpm.es || a.cpm.ef - b.cpm.ef);
    this._rows = rows;

    const fmtDate = d => d.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });
    const fmtRef = refDate.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });

    if (!rows.length) {
      this._tbody.innerHTML = `<p style="color:var(--clr-text-3);font-size:13px;padding:16px 0">No hay tareas programadas en las <strong>${this._weeks} semanas</strong> a partir del <strong>${fmtRef}</strong>.</p>`;
      return;
    }

    // Botones toggle activo
    this.el.querySelector('#la-btn-3')?.setAttribute('style', `padding:4px 12px;font-size:12px;background:${this._weeks===3?'var(--clr-primary)':'var(--clr-surface-2)'};color:${this._weeks===3?'#fff':'var(--clr-text)'}`);
    this.el.querySelector('#la-btn-6')?.setAttribute('style', `padding:4px 12px;font-size:12px;background:${this._weeks===6?'var(--clr-primary)':'var(--clr-surface-2)'};color:${this._weeks===6?'#fff':'var(--clr-text)'}`);

    const wbsCodes = calcWbsCodes(appState.state.tasks ?? new Map());
    this._tbody.innerHTML = `
      <p style="font-size:12px;color:var(--clr-text-3);margin:0 0 10px">${rows.length} tarea(s) en las próximas <strong>${this._weeks} semanas</strong> desde <strong>${fmtRef}</strong></p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="background:var(--clr-surface-2,#f4f5f7);color:var(--clr-text-2)">
            <th style="padding:7px 8px;text-align:center;font-weight:600;border-bottom:1px solid var(--clr-border)">EDT</th>
            <th style="padding:7px 10px;text-align:left;font-weight:600;border-bottom:1px solid var(--clr-border)">Tarea</th>
            <th style="padding:7px 10px;text-align:left;font-weight:600;border-bottom:1px solid var(--clr-border)">Inicio</th>
            <th style="padding:7px 10px;text-align:left;font-weight:600;border-bottom:1px solid var(--clr-border)">Fin</th>
            <th style="padding:7px 8px;text-align:center;font-weight:600;border-bottom:1px solid var(--clr-border)">Avance</th>
            <th style="padding:7px 10px;text-align:left;font-weight:600;border-bottom:1px solid var(--clr-border)">Estado</th>
            <th style="padding:7px 8px;text-align:center;font-weight:600;border-bottom:1px solid var(--clr-border)">Holgura</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr style="background:${i%2===0?'':'var(--clr-surface-2,#f4f5f7)'};border-bottom:1px solid var(--clr-border)">
              <td style="padding:7px 8px;text-align:center;color:var(--clr-text-3);white-space:nowrap">${_esc(wbsCodes.get(r.task.id) ?? '')}</td>
              <td style="padding:7px 10px;color:var(--clr-text);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(r.task.name)}">${_esc(r.task.name)}</td>
              <td style="padding:7px 10px;color:var(--clr-text-2);white-space:nowrap">${fmtDate(r.startDate)}</td>
              <td style="padding:7px 10px;color:var(--clr-text-2);white-space:nowrap">${fmtDate(r.endDate)}</td>
              <td style="padding:7px 8px;text-align:center">
                <div style="display:inline-flex;align-items:center;gap:6px">
                  <div style="width:60px;height:6px;background:var(--clr-border);border-radius:3px;overflow:hidden">
                    <div style="height:100%;width:${r.pct}%;background:${r.status==='done'?'#388E3C':'var(--clr-primary)'};transition:width .3s"></div>
                  </div>
                  <span style="color:var(--clr-text-2);font-size:11px">${r.pct}%</span>
                </div>
              </td>
              <td style="padding:7px 10px">
                <span style="background:${STATUS_COLOR[r.status]}22;color:${STATUS_COLOR[r.status]};border-radius:12px;padding:2px 8px;font-size:11px;font-weight:600">${STATUS_LABEL[r.status]}</span>
              </td>
              <td style="padding:7px 8px;text-align:center;color:${r.cpm.tf===0?'#D32F2F':'var(--clr-text-2)'};font-weight:${r.cpm.tf===0?'700':'400'}">${r.cpm.tf ?? '-'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }
}
