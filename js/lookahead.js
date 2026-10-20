// @ts-check
/**
 * lookahead.js — Vista Lookahead 3/6 semanas.
 * Filtra y presenta tareas programadas en las próximas semanas laborables.
 */

import { appState } from './state.js';
import { Calendar, isoToDate } from './calendar.js';

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

function _printToPdf(title, htmlContent) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; }
      h1 { font-size: 18px; margin-bottom: 16px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #ccc; padding: 6px 10px; font-size: 12px; }
      th { background: #f4f5f7; font-weight: 600; }
      @media print { body { margin: 0; } }
    </style>
  </head><body>${htmlContent}<script>window.print();window.close();<\/script></body></html>`);
  w.document.close();
}

const STATUS_LABEL = { todo: 'Pendiente', in_progress: 'En Curso', done: 'Completada', delayed: 'Atrasada' };
const STATUS_COLOR = { todo: '#757575', in_progress: '#1976D2', done: '#388E3C', delayed: '#D32F2F' };

export class LookaheadPanel {
  /** @param {HTMLElement} containerEl */
  constructor(containerEl) {
    this.el = containerEl;
    /** @type {3|6} */
    this._weeks = 3;
    this._build();
  }

  _build() {
    this.el.innerHTML = '';
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-ui)';

    // Header
    const hdr = document.createElement('div');
    hdr.setAttribute('data-drag-handle', '');
    hdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--clr-border);flex-shrink:0';
    hdr.innerHTML = `
      <span style="font-size:20px">📅</span>
      <div style="flex:1">
        <div style="font-size:var(--text-md,14px);font-weight:600;color:var(--clr-text)">Vista Lookahead</div>
        <div style="font-size:11px;color:var(--clr-text-3)">Tareas programadas en las próximas semanas</div>
      </div>
      <div style="display:flex;gap:4px">
        <button id="la-btn-3" class="btn btn-sm" style="padding:4px 12px;font-size:12px">3 semanas</button>
        <button id="la-btn-6" class="btn btn-sm" style="padding:4px 12px;font-size:12px">6 semanas</button>
        <button id="la-btn-print" class="btn btn-ghost btn-icon btn-sm" title="Imprimir PDF" style="font-size:15px">🖨</button>
      </div>`;
    this.el.appendChild(hdr);

    this._tbody = document.createElement('div');
    this._tbody.style.cssText = 'flex:1;overflow:auto;padding:12px 18px';
    this.el.appendChild(this._tbody);

    hdr.querySelector('#la-btn-3')?.addEventListener('click', () => { this._weeks = 3; this.refresh(); });
    hdr.querySelector('#la-btn-6')?.addEventListener('click', () => { this._weeks = 6; this.refresh(); });
    hdr.querySelector('#la-btn-print')?.addEventListener('click', () => {
      _printToPdf('Vista Lookahead', `<h1>Vista Lookahead — ${this._weeks} semanas</h1>${this._tbody?.innerHTML ?? ''}`);
    });
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
      exceptions: calExceptions ?? [],
    });
    const startDate = isoToDate(project.start_date || new Date().toISOString().slice(0,10));
    const today = new Date();
    today.setHours(0,0,0,0);

    // today working day index
    let todayIdx = 0;
    {
      const d = new Date(startDate);
      while (d < today) {
        if (cal.isWorkingDay(d)) todayIdx++;
        d.setDate(d.getDate() + 1);
      }
    }

    const daysPerWeek = Math.max(1, (calendar?.work_week ?? [1,2,3,4,5]).length);
    const horizonDays = this._weeks * daysPerWeek;
    const windowEnd = todayIdx + horizonDays;

    /** @type {Array<{task:object, cpm:object, status:string, pct:number, startDate:Date, endDate:Date}>} */
    const rows = [];

    for (const task of tasks.values()) {
      if (task.deleted_at || task.type === 'summary') continue;
      const cpm = cpmResult.tasks?.get(task.id);
      if (!cpm) continue;
      const pct = task.percent_complete ?? 0;
      // Tarea atrasada: ef ya pasó y no está completa — siempre incluir
      const isDelayed = pct < 100 && cpm.ef <= todayIdx;
      // Tarea en ventana lookahead: [es, ef) ∩ [todayIdx, windowEnd)
      const inWindow = cpm.ef > todayIdx && cpm.es < windowEnd;
      if (!isDelayed && !inWindow) continue;

      let status = pct >= 100 ? 'done' : isDelayed ? 'delayed' : pct > 0 ? 'in_progress' : 'todo';

      const sDate = cal.idxToDate(cpm.es, startDate);
      const eDate = cal.idxToDate(Math.max(cpm.es, cpm.ef - 1), startDate);
      rows.push({ task, cpm, status, pct, startDate: sDate, endDate: eDate });
    }

    rows.sort((a, b) => a.cpm.es - b.cpm.es || a.cpm.ef - b.cpm.ef);

    const fmtDate = d => d.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });

    if (!rows.length) {
      this._tbody.innerHTML = `<p style="color:var(--clr-text-3);font-size:13px;padding:16px 0">No hay tareas programadas en las próximas ${this._weeks} semanas.</p>`;
      return;
    }

    // Botones toggle activo
    this.el.querySelector('#la-btn-3')?.setAttribute('style', `padding:4px 12px;font-size:12px;background:${this._weeks===3?'var(--clr-primary)':'var(--clr-surface-2)'};color:${this._weeks===3?'#fff':'var(--clr-text)'}`);
    this.el.querySelector('#la-btn-6')?.setAttribute('style', `padding:4px 12px;font-size:12px;background:${this._weeks===6?'var(--clr-primary)':'var(--clr-surface-2)'};color:${this._weeks===6?'#fff':'var(--clr-text)'}`);

    this._tbody.innerHTML = `
      <p style="font-size:12px;color:var(--clr-text-3);margin:0 0 10px">${rows.length} tarea(s) en las próximas <strong>${this._weeks} semanas</strong></p>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="background:var(--clr-surface-2,#f4f5f7);color:var(--clr-text-2)">
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
