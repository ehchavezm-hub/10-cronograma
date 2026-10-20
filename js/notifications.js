// @ts-check
/**
 * notifications.js — Alertas de tareas próximas a vencer o críticas.
 * Analiza el cronograma y genera notificaciones internas visibles en la toolbar.
 */

import { appState } from './state.js';
import { Calendar, isoToDate } from './calendar.js';

const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function _printToPdf(title, htmlContent) {
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; }
      h1 { font-size: 18px; margin-bottom: 16px; }
      @media print { body { margin: 0; } }
    </style>
  </head><body>${htmlContent}<script>window.print();window.close();<\/script></body></html>`);
  w.document.close();
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
    if (!cpm) continue;

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
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-ui)';

    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--clr-border);flex-shrink:0';
    hdr.innerHTML = `
      <span style="font-size:20px">🔔</span>
      <div style="flex:1">
        <div style="font-size:var(--text-md,14px);font-weight:600;color:var(--clr-text)">Notificaciones</div>
        <div style="font-size:11px;color:var(--clr-text-3)">Alertas de tareas críticas y próximas a vencer</div>
      </div>`;
    const _printBtn = document.createElement('button');
    _printBtn.innerHTML = '🖨';
    _printBtn.title = 'Imprimir PDF';
    _printBtn.className = 'btn btn-ghost btn-icon btn-sm';
    _printBtn.style.cssText = 'font-size:15px;flex-shrink:0';
    _printBtn.addEventListener('click', () => {
      _printToPdf('Notificaciones', `<h1>Notificaciones</h1>${this._body?.innerHTML ?? ''}`);
    });
    hdr.appendChild(_printBtn);
    this.el.appendChild(hdr);

    this._body = document.createElement('div');
    this._body.style.cssText = 'flex:1;overflow:auto;padding:12px 18px';
    this.el.appendChild(this._body);

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
