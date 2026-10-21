// @ts-check
/**
 * notifications.js — Alertas de tareas próximas a vencer o críticas.
 * Analiza el cronograma y genera notificaciones internas visibles en la toolbar.
 */

import { appState } from './state.js';
import { Calendar, isoToDate } from './calendar.js';
import { printToPdf } from './pdf-utils.js';

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


/**
 * @typedef {{ type: 'critical'|'upcoming'|'overdue', task: object, daysLeft: number }} Notification
 */

/** @type {{ key: string, idx: number } | null} */
let _todayCache = null;

/**
 * Genera las notificaciones para el proyecto activo.
 * @param {number} [horizonDays=7] días hacia adelante para alertas "próximas"
 * @returns {Notification[]}
 */
export function getNotifications(horizonDays = 7) {
  const { project, tasks, cpmResult, calendar, calExceptions } = appState.state;
  if (!project || !cpmResult) return [];

  const cal = new Calendar({
    work_week: calendar?.work_week ?? [1,2,3,4,5],
    exceptions: calExceptions ?? [],
  });
  const startDate = isoToDate(project.start_date || new Date().toISOString().slice(0,10));

  // today working day index — cached per project+date to avoid O(n_days) on every render
  const today = new Date();
  today.setHours(0,0,0,0);
  const cacheKey = project.id + '|' + today.toISOString().slice(0, 10);
  let todayIdx;
  if (_todayCache?.key === cacheKey) {
    todayIdx = _todayCache.idx;
  } else {
    todayIdx = 0;
    const d = new Date(startDate);
    while (d < today) {
      if (cal.isWorkingDay(d)) todayIdx++;
      d.setDate(d.getDate() + 1);
    }
    _todayCache = { key: cacheKey, idx: todayIdx };
  }

  /** @type {Notification[]} */
  const notes = [];

  for (const task of tasks.values()) {
    if (task.deleted_at || task.type === 'summary') continue;
    const pct = task.percent_complete ?? 0;
    if (pct >= 100) continue;

    const cpm = cpmResult.tasks?.get(task.id);
    if (!cpm || cpm.is_summary) continue;

    const daysLeft = cpm.ef - todayIdx;

    // Atrasada: ef ya pasó y no está completa
    if (daysLeft < 0) {
      notes.push({ type: 'overdue', task, daysLeft });
    }
    // Próxima a vencer: dentro del horizonte
    else if (daysLeft <= horizonDays) {
      notes.push({ type: 'upcoming', task, daysLeft });
    }
    // Crítica (tf = 0) pero no en las anteriores categorías
    else if (cpm.tf === 0) {
      notes.push({ type: 'critical', task, daysLeft });
    }
  }

  notes.sort((a, b) => a.daysLeft - b.daysLeft);
  return notes;
}

const TYPE_ICON   = { overdue: '🔴', upcoming: '🟡', critical: '🔷' };
const TYPE_LABEL  = { overdue: 'Atrasada', upcoming: 'Próxima', critical: 'Crítica' };
const TYPE_COLOR  = { overdue: '#D32F2F', upcoming: '#F57C00', critical: '#1565C0' };

export class NotificationsPanel {
  /** @param {HTMLElement} containerEl */
  constructor(containerEl) {
    this.el = containerEl;
    this._build();
  }

  _build() {
    this.el.innerHTML = '';
    this.el.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;font-family:var(--font-ui);position:relative';

    const hdr = document.createElement('div');
    hdr.setAttribute('data-drag-handle', '');
    hdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 18px;padding-right:44px;border-bottom:1px solid var(--clr-border);flex-shrink:0';
    hdr.innerHTML = `
      <span style="font-size:20px">🔔</span>
      <div style="flex:1">
        <div style="font-size:var(--text-md,14px);font-weight:600;color:var(--clr-text)">Alertas</div>
        <div style="font-size:11px;color:var(--clr-text-3)">Alertas de tareas críticas y próximas a vencer</div>
      </div>`;
    const _printBtn = document.createElement('button');
    _printBtn.innerHTML = '🖨 Imprimir';
    _printBtn.title = 'Imprimir PDF';
    _printBtn.className = 'btn btn-ghost btn-sm';
    _printBtn.style.cssText = 'flex-shrink:0;margin-right:36px';
    _printBtn.addEventListener('click', () => {
      const notes = getNotifications(7);
      const COLORS = { overdue:'#D32F2F', upcoming:'#F57C00', critical:'#1565C0' };
      const ICONS  = { overdue:'🔴', upcoming:'🟡', critical:'🔷' };
      const LABELS = { overdue:'Atrasada', upcoming:'Próxima', critical:'Crítica' };
      const _e = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const rows = notes.map((n, i) => `
        <tr style="background:${i%2===0?'#fff':'#f9f9f9'}">
          <td style="border:1px solid #ccc;padding:6px 10px">${ICONS[n.type]}</td>
          <td style="border:1px solid #ccc;padding:6px 10px;color:${COLORS[n.type]};font-weight:600">${LABELS[n.type]}</td>
          <td style="border:1px solid #ccc;padding:6px 10px">${_e(n.task.name)}</td>
          <td style="border:1px solid #ccc;padding:6px 10px;text-align:center">${n.task.percent_complete ?? 0}%</td>
          <td style="border:1px solid #ccc;padding:6px 10px;color:${COLORS[n.type]}">
            ${n.type==='overdue' ? `Atrasada ${Math.abs(n.daysLeft)} día(s)` : n.type==='upcoming' ? `Vence en ${n.daysLeft} día(s)` : 'Ruta crítica (holgura=0)'}
          </td>
        </tr>`).join('');
      const html = `<h1 style="font-size:16px;margin-bottom:4px">Alertas</h1>
        <p style="font-size:12px;color:#666;margin:0 0 12px">${notes.length} alerta(s) activa(s)</p>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f4f5f7">
            <th style="border:1px solid #ccc;padding:6px 8px;text-align:center">Tipo</th>
            <th style="border:1px solid #ccc;padding:6px 10px;text-align:left">Estado</th>
            <th style="border:1px solid #ccc;padding:6px 10px;text-align:left">Tarea</th>
            <th style="border:1px solid #ccc;padding:6px 8px;text-align:center">Avance</th>
            <th style="border:1px solid #ccc;padding:6px 10px;text-align:left">Detalle</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      printToPdf('Alertas', html);
    });
    hdr.appendChild(_printBtn);
    this.el.appendChild(hdr);
    const _closeBtn = document.createElement('button');
    _closeBtn.id = 'btn-notif-close';
    _closeBtn.className = 'btn btn-ghost btn-icon btn-sm';
    _closeBtn.title = 'Cerrar';
    _closeBtn.setAttribute('aria-label', 'Cerrar');
    _closeBtn.textContent = '✕';
    _closeBtn.style.cssText = 'position:absolute;top:8px;right:8px;z-index:20;font-size:16px;width:28px;height:28px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:50%';
    _closeBtn.addEventListener('click', () => {
      const p = document.getElementById('panel-notifications');
      if (p) p.style.display = 'none';
    });
    this.el.appendChild(_closeBtn);

    this._body = document.createElement('div');
    this._body.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;padding:12px 18px;min-height:0';
    this.el.appendChild(this._body);

    if (this.el.parentElement) _makeDraggable(this.el.parentElement, '[data-drag-handle]');
    this.refresh();
  }

  refresh() {
    const notes = getNotifications(7);

    if (!notes.length) {
      this._body.innerHTML = '<p style="color:var(--clr-text-3);font-size:13px;padding:16px 0;text-align:center">✅ Sin alertas activas. El cronograma está bajo control.</p>';
      return;
    }

    const countByType = notes.reduce((m, n) => { m[n.type] = (m[n.type]||0)+1; return m; }, /** @type {Record<string,number>} */ ({}));

    this._body.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
        ${Object.entries(countByType).map(([t, c]) => `
          <div style="display:inline-flex;align-items:center;gap:5px;background:${TYPE_COLOR[t]}18;color:${TYPE_COLOR[t]};border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600">
            ${TYPE_ICON[t]} ${c} ${TYPE_LABEL[t]}${c>1?'s':''}
          </div>`).join('')}
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${notes.map(n => `
          <div style="display:flex;align-items:flex-start;gap:10px;background:var(--clr-surface-2,#f8f9fa);border-left:3px solid ${TYPE_COLOR[n.type]};border-radius:6px;padding:10px 14px">
            <span style="font-size:18px;flex-shrink:0">${TYPE_ICON[n.type]}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;color:var(--clr-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_esc(n.task.name)}</div>
              <div style="font-size:11px;color:var(--clr-text-3);margin-top:3px">
                ${n.type==='overdue' ? `<span style="color:${TYPE_COLOR.overdue}">Atrasada ${Math.abs(n.daysLeft)} día(s) laborable(s)</span>`
                  : n.type==='upcoming' ? `<span style="color:${TYPE_COLOR.upcoming}">Vence en ${n.daysLeft} día(s) laborable(s)</span>`
                  : `<span style="color:${TYPE_COLOR.critical}">En ruta crítica (holgura = 0)</span>`}
                ${n.task.percent_complete != null ? ` · ${n.task.percent_complete}% completado` : ''}
              </div>
            </div>
          </div>`).join('')}
      </div>`;
  }
}

/**
 * Actualiza el badge de notificaciones en la toolbar.
 * @param {string} badgeId  id del elemento badge
 * @param {string} btnId    id del botón
 */
export function updateNotificationBadge(badgeId, btnId) {
  const notes = getNotifications(7);
  const badge = document.getElementById(badgeId);
  const btn   = document.getElementById(btnId);
  if (!badge || !btn) return;

  const count = notes.length;
  badge.textContent = count > 0 ? String(Math.min(count, 99)) : '';
  badge.style.display = count > 0 ? '' : 'none';

  const hasOverdue   = notes.some(n => n.type === 'overdue');
  const hasUpcoming  = notes.some(n => n.type === 'upcoming');
  badge.style.background = hasOverdue ? '#D32F2F' : hasUpcoming ? '#F57C00' : '#1565C0';
  btn.setAttribute('title', count > 0 ? `${count} alerta(s) de cronograma` : 'Sin alertas');
}
