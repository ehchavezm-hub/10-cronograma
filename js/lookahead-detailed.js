// @ts-check
/**
 * lookahead-detailed.js — Sistema de Planificación Lookahead Detallado (Last Planner System)
 *
 * Módulo: LookaheadDetailedPanel
 * Tabs:
 *   1. Planificación  — Tareas agrupadas por semana según el cronograma CPM
 *   2. Cumplimiento   — PPC (Plan Percent Complete) semanal con checkboxes y causas
 *   3. Restricciones  — Gestión de impedimentos (CRUD), por proyecto
 *   4. Dashboard      — Historial PPC (gráfico de barras) + resúmenes
 */

import { appState } from './state.js';
import { Calendar, isoToDate } from './calendar.js';

// ============================================================
// Helpers ISO week
// ============================================================

/** Retorna 'YYYY-WNN' para una fecha dada (ISO 8601, semana empieza en lunes). */
function _getWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2,'0')}`;
}

/** Lunes de una semana dada por clave 'YYYY-WNN'. */
function _weekStart(weekKey) {
  const [year, wn] = weekKey.split('-W').map(Number);
  const jan4 = new Date(year, 0, 4);
  const mon = new Date(jan4);
  mon.setDate(jan4.getDate() - ((jan4.getDay() || 7) - 1) + (wn - 1) * 7);
  return mon;
}

/** Domingo de una semana dada. */
function _weekEnd(weekKey) {
  const s = _weekStart(weekKey);
  const e = new Date(s);
  e.setDate(s.getDate() + 6);
  return e;
}

/** Suma n semanas a una clave 'YYYY-WNN'. */
function _addWeeks(weekKey, n) {
  const s = _weekStart(weekKey);
  s.setDate(s.getDate() + n * 7);
  return _getWeekKey(s);
}

/** Formato DD/MM/YYYY. */
function _fmtDate(d) {
  return d.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });
}

/** Label semana: "Sem N · DD/MM – DD/MM". */
function _weekLabel(weekKey, idx) {
  const s = _weekStart(weekKey);
  const e = _weekEnd(weekKey);
  const [yr, wn] = weekKey.split('-W');
  const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
  return `Sem ${idx + 1} · ${fmt(s)}–${fmt(e)} (${yr})`;
}

const _esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ============================================================
// Persistencia localStorage
// ============================================================

const LS_PPC   = 'ecm-lad-ppc';
const LS_REST  = 'ecm-lad-rest';
const LS_PLAN  = 'ecm-lad-plan';

function _getPPC() {
  try { return JSON.parse(localStorage.getItem(LS_PPC) || '{}'); } catch { return {}; }
}
function _savePPC(data) {
  try { localStorage.setItem(LS_PPC, JSON.stringify(data)); } catch { /* ignore */ }
}
function _getRest(projId) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_REST) || '{}');
    return all[projId] ?? [];
  } catch { return []; }
}
function _saveRest(projId, list) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_REST) || '{}');
    all[projId] = list;
    localStorage.setItem(LS_REST, JSON.stringify(all));
  } catch { /* ignore */ }
}

/** Retorna actividades manuales LPS para un proyecto: { weekKey: [{id,name,responsible,unit,qty}] } */
function _getPlan(projId) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_PLAN) || '{}');
    return all[projId] ?? {};
  } catch { return {}; }
}
function _savePlan(projId, planData) {
  try {
    const all = JSON.parse(localStorage.getItem(LS_PLAN) || '{}');
    all[projId] = planData;
    localStorage.setItem(LS_PLAN, JSON.stringify(all));
  } catch { /* ignore */ }
}

function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ============================================================
// Draggable helper
// ============================================================

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

// ============================================================
// Print helper
// ============================================================

function _printToPdf(moduleName, htmlContent) {
  const _proj = appState.state.project?.name ?? 'ECM Project';
  const _d = new Date();
  const _dd = String(_d.getDate()).padStart(2,'0');
  const _mm = String(_d.getMonth()+1).padStart(2,'0');
  const _yy = _d.getFullYear();
  const title = `${_proj} - ${moduleName} - ${_dd}/${_mm}/${_yy}`;
  const w = window.open('', '_blank', 'width=1100,height=800');
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <title>${_esc(title)}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 20px; font-size: 12px; }
      h1 { font-size: 16px; color: #1976D2; margin-bottom: 4px; }
      h2 { font-size: 13px; color: #37474F; margin: 16px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
      table { border-collapse: collapse; width: 100%; margin-bottom: 12px; }
      th, td { border: 1px solid #ccc; padding: 5px 8px; }
      th { background: #f4f5f7; font-weight: 600; }
      .badge { display: inline-block; border-radius: 10px; padding: 1px 7px; font-size: 11px; font-weight: 600; }
      @media print { body { margin: 0; } }
    </style>
  </head><body>
    <h1>${_esc(title)}</h1>
    <p style="font-size:11px;color:#888;margin:0 0 14px">${new Date().toLocaleString('es-PE')}</p>
    ${htmlContent}
    <script>window.print(); window.close();<\/script>
  </body></html>`);
  w.document.close();
}

// ============================================================
// CAUSAS de incumplimiento
// ============================================================

const CAUSAS = [
  'Mala planificación',
  'Pre-requisito / trabajo previo',
  'Problema de diseño / planos',
  'Inspección no aprobada',
  'Mano de obra no disponible',
  'Materiales no disponibles',
  'Equipos / herramientas no disponibles',
  'Contratos / órdenes de cambio',
  'Submittals / aprobaciones pendientes',
  'Condiciones climáticas',
  'Me olvidé',
  'Sin actualización / Info. faltante',
  'Permisos / autorizaciones faltantes',
  'Condición no prevista',
  'Otras causas',
];

// ============================================================
// LookaheadDetailedPanel
// ============================================================

export class LookaheadDetailedPanel {
  /** @param {HTMLElement} containerEl */
  constructor(containerEl) {
    this.el = containerEl;
    this._weeks  = 6;
    this._tab    = 'planning';
    this._compWeekKey = null;
    this._refWeekKey  = _getWeekKey(new Date());
    this._build();
  }

  _build() {
    this.el.innerHTML = '';
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-ui,system-ui)';

    const hdr = document.createElement('div');
    hdr.setAttribute('data-drag-handle', '');
    hdr.className = 'lad-header';
    hdr.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;min-width:0">
        <span style="font-size:20px;flex-shrink:0">📋</span>
        <div style="min-width:0">
          <div style="font-size:14px;font-weight:700;color:var(--clr-text)">Last Planner System® (LPS)</div>
          <div style="font-size:11px;color:var(--clr-text-3)">LookAhead de 6 semanas — Estándar LCI 2023</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        <label style="font-size:12px;color:var(--clr-text-2);white-space:nowrap">Semanas:
          <select id="lad-weeks-sel" style="margin-left:4px;padding:3px 6px;border:1px solid var(--clr-border);border-radius:4px;background:var(--clr-surface);color:var(--clr-text);font-size:12px">
            ${[1,2,3,4,5,6,7,8].map(n => `<option value="${n}"${n===6?' selected':''}>${n}</option>`).join('')}
          </select>
        </label>
        <button id="lad-btn-print" class="btn btn-ghost btn-sm" title="Imprimir PDF" style="font-size:12px">🖨 PDF</button>
      </div>`;
    this.el.appendChild(hdr);

    const tabBar = document.createElement('div');
    tabBar.className = 'lad-tabbar';
    tabBar.innerHTML = `
      <button class="lad-tab lad-tab-active" data-tab="planning">📅 LookAhead (6 Semanas)</button>
      <button class="lad-tab" data-tab="compliance">📋 Plan Semanal (WWP)</button>
      <button class="lad-tab" data-tab="restrictions">🚧 Log de Restricciones</button>
      <button class="lad-tab" data-tab="dashboard">📊 Métricas LPS / PPC</button>`;
    this.el.appendChild(tabBar);

    this._body = document.createElement('div');
    this._body.className = 'lad-body';
    this.el.appendChild(this._body);

    tabBar.querySelectorAll('.lad-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this._tab = btn.getAttribute('data-tab');
        tabBar.querySelectorAll('.lad-tab').forEach(b => b.classList.toggle('lad-tab-active', b === btn));
        this._render();
      });
    });
    hdr.querySelector('#lad-weeks-sel').addEventListener('change', e => {
      this._weeks = parseInt(e.target.value);
      this._render();
    });
    hdr.querySelector('#lad-btn-print').addEventListener('click', () => this._print());

    if (this.el.parentElement) _makeDraggable(this.el.parentElement, '[data-drag-handle]');
    this._render();
  }

  refresh() { this._render(); }

  _render() {
    switch (this._tab) {
      case 'planning':     this._renderPlanning(); break;
      case 'compliance':   this._renderCompliance(); break;
      case 'restrictions': this._renderRestrictions(); break;
      case 'dashboard':    this._renderDashboard(); break;
    }
  }

  _getWeekGroups() {
    const { project, tasks, cpmResult, calendar, calExceptions } = appState.state;
    if (!project || !cpmResult) return null;

    const cal = new Calendar({
      work_week: calendar?.work_week ?? [1,2,3,4,5],
      exceptions: calExceptions ?? [],
    });
    const startDate = isoToDate(project.start_date || new Date().toISOString().slice(0,10));

    const groups = new Map();
    for (let i = 0; i < this._weeks; i++) {
      const wk = _addWeeks(this._refWeekKey, i);
      groups.set(wk, []);
    }

    for (const task of tasks.values()) {
      if (task.deleted_at || task.type === 'summary') continue;
      const cpm = cpmResult.tasks?.get(task.id);
      if (!cpm || cpm.is_summary) continue;

      const sDate = cal.idxToDate(cpm.es, startDate);
      const eDate = cal.idxToDate(Math.max(cpm.es, cpm.ef - 1), startDate);
      const pct   = task.percent_complete ?? 0;

      for (const [wk] of groups) {
        const wStart = _weekStart(wk);
        const wEnd   = _weekEnd(wk);
        wEnd.setHours(23,59,59,999);
        if (sDate <= wEnd && eDate >= wStart) {
          groups.get(wk).push({ task, cpm, startDate: sDate, endDate: eDate, pct });
        }
      }
    }

    for (const [, arr] of groups) arr.sort((a,b) => a.cpm.es - b.cpm.es);
    return groups;
  }

  _renderPlanning() {
    const { project } = appState.state;
    if (!project) {
      this._body.innerHTML = '<p class="lad-empty">Abre un proyecto primero.</p>';
      return;
    }

    const planData  = _getPlan(project.id);
    const cpmGroups = this._getWeekGroups();

    let html = '';
    let totalManual = 0;

    const INP_CSS = 'padding:4px 8px;border:1px solid var(--clr-border);border-radius:4px;background:var(--clr-surface);color:var(--clr-text);font-size:12px;width:100%';

    for (let idx = 0; idx < this._weeks; idx++) {
      const wk      = _addWeeks(this._refWeekKey, idx);
      const label   = _weekLabel(wk, idx);
      const manual  = planData[wk] ?? [];
      const cpmRows = cpmGroups?.get(wk) ?? [];
      totalManual  += manual.length;

      const manualRows = manual.map((act, i) => `
        <tr class="${i%2===0?'':'lad-row-alt'}" data-act-id="${act.id}" data-wk="${wk}">
          <td style="padding:5px 8px;width:22px;text-align:center">
            <span class="lad-badge" style="background:#1976D222;color:#1976D2;font-size:10px">LPS</span>
          </td>
          <td class="lad-code" style="font-size:11px;color:var(--clr-text-3);white-space:nowrap">${_esc(act.code || '—')}</td>
          <td class="lad-name" title="${_esc(act.name)}">${_esc(act.name)}</td>
          <td class="lad-date" style="color:var(--clr-text-2)">${_esc(act.responsible || '—')}</td>
          <td class="lad-date" style="color:var(--clr-text-2)">${_esc(act.unit || '—')}</td>
          <td class="lad-num" style="text-align:center">${_esc(act.qty != null ? act.qty : '—')}</td>
          <td style="white-space:nowrap;padding:5px 6px">
            <button class="btn btn-ghost btn-sm lad-edit-act" data-act-id="${act.id}" data-wk="${wk}" title="Editar" style="font-size:11px;padding:2px 6px">✏</button>
            <button class="btn btn-ghost btn-sm lad-del-act" data-act-id="${act.id}" data-wk="${wk}" title="Eliminar" style="font-size:11px;padding:2px 6px;color:#D32F2F">✕</button>
          </td>
        </tr>`).join('');

      const cpmSection = cpmRows.length > 0 ? `
        <tr><td colspan="7" style="padding:4px 8px;background:var(--clr-surface-2);font-size:11px;color:var(--clr-text-3);font-weight:600">
          📌 Del cronograma maestro (${cpmRows.length} tarea${cpmRows.length!==1?'s':''})
        </td></tr>
        ${cpmRows.map((r,i) => {
          const status = r.pct >= 100 ? 'done' : r.cpm.tf === 0 ? 'critical' : r.pct > 0 ? 'progress' : 'todo';
          const sc = { done:'#388E3C', critical:'#D32F2F', progress:'#1976D2', todo:'#757575' }[status];
          const sl = { done:'Completada', critical:'Crítica', progress:'En Curso', todo:'Pendiente' }[status];
          return `<tr class="${i%2===0?'':'lad-row-alt'}" style="opacity:.85">
            <td style="padding:5px 8px;text-align:center">
              <span class="lad-badge" style="background:${sc}22;color:${sc};font-size:10px">CPM</span>
            </td>
            <td class="lad-code" style="font-size:11px;color:var(--clr-text-3)">${_esc(r.task.wbs_code||'—')}</td>
            <td class="lad-name" title="${_esc(r.task.name)}">${_esc(r.task.name)}</td>
            <td class="lad-date">${_fmtDate(r.startDate)}</td>
            <td class="lad-date">${_fmtDate(r.endDate)}</td>
            <td class="lad-num" style="text-align:center">${r.pct}%</td>
            <td style="padding:5px 6px"><span class="lad-badge" style="background:${sc}22;color:${sc}">${sl}</span></td>
          </tr>`;
        }).join('')}` : '';

      html += `
        <div class="lad-week-block" data-wk="${wk}">
          <div class="lad-week-title">
            <span>${_esc(label)}</span>
            <div style="display:flex;align-items:center;gap:6px">
              <span class="lad-week-count">${manual.length} actividad${manual.length!==1?'es':''} LPS</span>
              <label class="btn btn-ghost btn-sm" title="Importar actividades desde Excel / CSV" style="font-size:11px;padding:3px 9px;cursor:pointer;display:flex;align-items:center;gap:4px">
                📥 XLS
                <input type="file" class="lad-xls-input" data-wk="${wk}" accept=".xlsx,.xls,.csv" style="display:none">
              </label>
              <button class="btn btn-primary btn-sm lad-add-act" data-wk="${wk}" style="font-size:11px;padding:3px 10px">+ Agregar</button>
            </div>
          </div>
          <div class="lad-add-form" data-wk="${wk}" style="display:none;padding:8px 12px;background:var(--clr-surface-2);border-bottom:1px solid var(--clr-border)">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
              <label style="font-size:12px;display:flex;flex-direction:column;gap:3px;flex:0 0 90px">
                Código <input class="lad-inp-code" placeholder="COD-001" style="${INP_CSS}">
              </label>
              <label style="font-size:12px;display:flex;flex-direction:column;gap:3px;flex:2;min-width:160px">
                Actividad <input class="lad-inp-name" placeholder="Descripción de la actividad" style="${INP_CSS}">
              </label>
              <label style="font-size:12px;display:flex;flex-direction:column;gap:3px;flex:1;min-width:100px">
                Responsable <input class="lad-inp-resp" placeholder="Nombre" style="${INP_CSS}">
              </label>
              <label style="font-size:12px;display:flex;flex-direction:column;gap:3px;flex:0 0 75px">
                Unidad <input class="lad-inp-unit" placeholder="m², m³…" style="${INP_CSS}">
              </label>
              <label style="font-size:12px;display:flex;flex-direction:column;gap:3px;flex:0 0 75px">
                Metrado <input class="lad-inp-qty" type="number" placeholder="0" style="${INP_CSS}">
              </label>
              <div style="display:flex;gap:4px;padding-bottom:1px">
                <button class="btn btn-primary btn-sm lad-save-act" data-wk="${wk}" style="font-size:12px">💾 Guardar</button>
                <button class="btn btn-ghost btn-sm lad-cancel-act" data-wk="${wk}" style="font-size:12px">Cancelar</button>
              </div>
            </div>
          </div>
          ${manual.length === 0 && cpmRows.length === 0
            ? `<p class="lad-empty-week">Sin actividades registradas. Usa "+ Agregar" o "📥 XLS" para planificar esta semana.</p>`
            : `<table class="lad-table">
              <thead><tr>
                <th style="width:44px">Origen</th>
                <th style="width:80px">Código</th>
                <th>Actividad</th>
                <th>Responsable / Inicio</th>
                <th>Unidad / Fin</th>
                <th style="text-align:center">Metrado / %</th>
                <th style="text-align:center;width:70px">Acciones</th>
              </tr></thead>
              <tbody>
                ${manualRows}
                ${cpmSection}
              </tbody>
            </table>`}
        </div>`;
    }

    this._body.innerHTML = `
      <div class="lad-info-bar">
        <span>📅 LookAhead: <strong>${this._weeks}</strong> semana${this._weeks!==1?'s':''} — desde ${_fmtDate(_weekStart(this._refWeekKey))} <span style="font-size:10px;color:var(--clr-text-3);margin-left:4px">(CAN occur — LCI §7)</span></span>
        <span>${totalManual} actividad${totalManual!==1?'es':''} LPS planificada${totalManual!==1?'s':''}</span>
      </div>
      ${html}`;

    // Wire events
    this._body.querySelectorAll('.lad-add-act').forEach(btn => {
      btn.addEventListener('click', () => {
        const wk   = btn.getAttribute('data-wk');
        const form = this._body.querySelector(`.lad-add-form[data-wk="${wk}"]`);
        if (form) { form.style.display = form.style.display === 'none' ? 'block' : 'none'; }
        /** @type {HTMLInputElement|null} */ (form?.querySelector('.lad-inp-name'))?.focus();
      });
    });

    this._body.querySelectorAll('.lad-cancel-act').forEach(btn => {
      btn.addEventListener('click', () => {
        const form = this._body.querySelector(`.lad-add-form[data-wk="${btn.getAttribute('data-wk')}"]`);
        if (form) form.style.display = 'none';
      });
    });

    this._body.querySelectorAll('.lad-save-act').forEach(btn => {
      btn.addEventListener('click', () => {
        const wk   = btn.getAttribute('data-wk');
        const form = this._body.querySelector(`.lad-add-form[data-wk="${wk}"]`);
        if (!form) return;
        const codeInp = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-code'));
        const nameInp = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-name'));
        const respInp = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-resp'));
        const unitInp = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-unit'));
        const qtyInp  = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-qty'));
        const name = nameInp?.value.trim();
        if (!name) { nameInp?.focus(); return; }
        const plan = _getPlan(project.id);
        if (!plan[wk]) plan[wk] = [];
        const editId = btn.getAttribute('data-edit-id');
        if (editId) {
          const ex = plan[wk].find(a => a.id === editId);
          if (ex) {
            ex.code = codeInp?.value.trim() || '';
            ex.name = name;
            ex.responsible = respInp?.value.trim() || '';
            ex.unit = unitInp?.value.trim() || '';
            ex.qty = qtyInp?.value ? parseFloat(qtyInp.value) : null;
          }
        } else {
          plan[wk].push({ id: _genId(), code: codeInp?.value.trim() || '', name, responsible: respInp?.value.trim() || '', unit: unitInp?.value.trim() || '', qty: qtyInp?.value ? parseFloat(qtyInp.value) : null });
        }
        _savePlan(project.id, plan);
        document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'Actividad guardada.', type: 'success' } }));
        this._renderPlanning();
      });
    });

    this._body.querySelectorAll('.lad-del-act').forEach(btn => {
      btn.addEventListener('click', () => {
        const actId = btn.getAttribute('data-act-id');
        const wk    = btn.getAttribute('data-wk');
        const plan  = _getPlan(project.id);
        if (plan[wk]) plan[wk] = plan[wk].filter(a => a.id !== actId);
        _savePlan(project.id, plan);
        document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'Actividad eliminada.', type: 'info' } }));
        this._renderPlanning();
      });
    });

    this._body.querySelectorAll('.lad-edit-act').forEach(btn => {
      btn.addEventListener('click', () => {
        const actId = btn.getAttribute('data-act-id');
        const wk    = btn.getAttribute('data-wk');
        const plan  = _getPlan(project.id);
        const act   = plan[wk]?.find(a => a.id === actId);
        if (!act) return;
        const form = this._body.querySelector(`.lad-add-form[data-wk="${wk}"]`);
        if (!form) return;
        form.style.display = 'block';
        const codeInp = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-code'));
        const nameInp = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-name'));
        const respInp = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-resp'));
        const unitInp = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-unit'));
        const qtyInp  = /** @type {HTMLInputElement} */ (form.querySelector('.lad-inp-qty'));
        if (codeInp) codeInp.value = act.code || '';
        if (nameInp) nameInp.value = act.name;
        if (respInp) respInp.value = act.responsible || '';
        if (unitInp) unitInp.value = act.unit || '';
        if (qtyInp)  qtyInp.value  = act.qty != null ? String(act.qty) : '';
        const saveBtn = /** @type {HTMLButtonElement|null} */ (form.querySelector('.lad-save-act'));
        if (saveBtn) saveBtn.setAttribute('data-edit-id', actId);
        nameInp?.focus();
      });
    });

    this._body.querySelectorAll('.lad-xls-input').forEach(input => {
      input.addEventListener('change', e => {
        const wk   = input.getAttribute('data-wk');
        const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
        if (file && wk) this._importXlsForWeek(wk, file, project.id);
        /** @type {HTMLInputElement} */ (input).value = '';
      });
    });
  }

  /** Carga SheetJS dinámicamente si no está disponible. */
  _loadXlsx() {
    if (/** @type {any} */ (window).XLSX) return Promise.resolve(/** @type {any} */ (window).XLSX);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      s.onload = () => resolve(/** @type {any} */ (window).XLSX);
      s.onerror = () => reject(new Error('No se pudo cargar la librería de Excel.'));
      document.head.appendChild(s);
    });
  }

  /** Parsea CSV simple separado por coma o punto y coma. */
  _parseCsv(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim());
    if (!lines.length) return [];
    const sep = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
    return lines.slice(1).map(line => {
      const cols = line.split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
      /** @type {Record<string,string>} */
      const obj = {};
      headers.forEach((h, i) => { obj[h] = cols[i] ?? ''; });
      return obj;
    });
  }

  /** Importa actividades desde un archivo Excel o CSV para una semana. */
  async _importXlsForWeek(wk, file, projId) {
    /** @param {Record<string,string>[]} rows */
    const _process = (rows) => {
      if (!rows.length) {
        document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'El archivo está vacío o no tiene filas de datos.', type: 'warn' } }));
        return;
      }
      const plan = _getPlan(projId);
      if (!plan[wk]) plan[wk] = [];
      let count = 0;
      for (const row of rows) {
        const get = (...names) => {
          for (const n of names) {
            const k = Object.keys(row).find(k => k.toLowerCase().trim() === n);
            if (k !== undefined && row[k] !== '') return String(row[k]).trim();
          }
          return '';
        };
        const name = get('actividad','activity','descripción','descripcion','nombre','name','tarea','task');
        if (!name) continue;
        const qtyStr = get('metrado','cantidad','qty','quantity','amount');
        const qty = qtyStr ? parseFloat(qtyStr) : null;
        plan[wk].push({
          id: _genId(),
          code: get('código','codigo','code','cod','id','item'),
          name,
          responsible: get('responsable','responsible','resp'),
          unit: get('unidad','unit','und','medida'),
          qty: !isNaN(/** @type {any} */ (qty)) ? qty : null,
        });
        count++;
      }
      _savePlan(projId, plan);
      document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: `${count} actividad${count!==1?'es':''} importada${count!==1?'s':''} correctamente.`, type: 'success' } }));
      this._renderPlanning();
    };

    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'csv') {
        const text = await file.text();
        _process(this._parseCsv(text));
      } else {
        const XLSX = await this._loadXlsx();
        const buf  = await file.arrayBuffer();
        const wb   = XLSX.read(buf, { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
        _process(rows);
      }
    } catch (err) {
      console.error('Error al importar XLS:', err);
      document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'Error al leer el archivo. Verifique que sea .xlsx, .xls o .csv válido.', type: 'error' } }));
    }
  }

  /** Importa restricciones desde un archivo Excel o CSV. */
  async _importXlsForRestrictions(file, projId) {
    /** @param {Record<string,string>[]} rows */
    const _process = (rows) => {
      if (!rows.length) {
        document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'El archivo está vacío o no tiene filas de datos.', type: 'warn' } }));
        return;
      }
      const rests = _getRest(projId);
      let count = 0;
      for (const row of rows) {
        const get = (...names) => {
          for (const n of names) {
            const k = Object.keys(row).find(k => k.toLowerCase().trim() === n);
            if (k !== undefined && row[k] !== '') return String(row[k]).trim();
          }
          return '';
        };
        const desc = get('descripción','descripcion','description','descripcion','desc','restricción','restriccion');
        if (!desc) continue;
        const dueDateRaw = get('fecha_limite','fecha límite','fecha limite','due_date','duedate','fecha');
        let dueDate = null;
        if (dueDateRaw) {
          // Accept DD/MM/YYYY or YYYY-MM-DD
          const dmyMatch = dueDateRaw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if (dmyMatch) {
            dueDate = `${dmyMatch[3]}-${dmyMatch[2].padStart(2,'0')}-${dmyMatch[1].padStart(2,'0')}`;
          } else if (/^\d{4}-\d{2}-\d{2}$/.test(dueDateRaw)) {
            dueDate = dueDateRaw;
          }
        }
        const rawReqDate = get('fecha_requerida','fecha requerida','required_date','fecha_need_resolution');
        let requiredDate = null;
        if (rawReqDate) {
          const dmyM = rawReqDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if (dmyM) requiredDate = `${dmyM[3]}-${dmyM[2].padStart(2,'0')}-${dmyM[1].padStart(2,'0')}`;
          else if (/^\d{4}-\d{2}-\d{2}$/.test(rawReqDate)) requiredDate = rawReqDate;
        }
        const rawPromDate = get('fecha_prometida','fecha prometida','promised_date');
        let promisedDate = null;
        if (rawPromDate) {
          const dmyM2 = rawPromDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if (dmyM2) promisedDate = `${dmyM2[3]}-${dmyM2[2].padStart(2,'0')}-${dmyM2[1].padStart(2,'0')}`;
          else if (/^\d{4}-\d{2}-\d{2}$/.test(rawPromDate)) promisedDate = rawPromDate;
        }
        const rawStatus = get('estado','status').toLowerCase();
        const status = (rawStatus.includes('levant') || rawStatus === 'cleared' || rawStatus.includes('resuel'))
          ? 'cleared' : (rawStatus.includes('proceso') || rawStatus.includes('progress')) ? 'in-progress' : 'pending';
        const rawIdentDate = get('fecha_identificada','fecha identificada','date_identified','fecha_id');
        let dateIdentified = null;
        if (rawIdentDate) {
          const dmyMi = rawIdentDate.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if (dmyMi) dateIdentified = `${dmyMi[3]}-${dmyMi[2].padStart(2,'0')}-${dmyMi[1].padStart(2,'0')}`;
          else if (/^\d{4}-\d{2}-\d{2}$/.test(rawIdentDate)) dateIdentified = rawIdentDate;
        }
        rests.push({
          id:                `rest-${_genId()}`,
          desc,
          type:              get('tipo','type','tipo_restriccion') || null,
          taskId:            null,
          responsible:       get('responsable','responsible','resp') || null,
          responsibleCompany: get('empresa','company','area','área','empresa_area') || null,
          rfiNumber:         get('rfi','numero_rfi','rfi_number') || null,
          dateIdentified,
          requiredDate:      requiredDate ?? dueDate,
          dueDate:           requiredDate ?? dueDate,
          promisedDate,
          effectiveDate:     null,
          status,
          comments:          get('observaciones','comentarios','comments','notas') || null,
          createdAt:         new Date().toISOString(),
          updatedAt:         new Date().toISOString(),
        });
        count++;
      }
      _saveRest(projId, rests);
      document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: `${count} restricción${count!==1?'es':''} importada${count!==1?'s':''} correctamente.`, type: 'success' } }));
      this._renderRestrictions();
    };

    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ext === 'csv') {
        const text = await file.text();
        _process(this._parseCsv(text));
      } else {
        const XLSX = await this._loadXlsx();
        const buf  = await file.arrayBuffer();
        const wb   = XLSX.read(buf, { type: 'array' });
        const ws   = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
        _process(rows);
      }
    } catch (err) {
      console.error('Error al importar restricciones XLS:', err);
      document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'Error al leer el archivo. Verifique que sea .xlsx, .xls o .csv válido.', type: 'error' } }));
    }
  }

  _renderCompliance() {
    const { project } = appState.state;
    if (!project) {
      this._body.innerHTML = '<p class="lad-empty">Abre un proyecto primero.</p>';
      return;
    }
    if (!this._compWeekKey) this._compWeekKey = _addWeeks(this._refWeekKey, -1);

    const allPpc   = _getPPC();
    const projPpc  = allPpc[project.id] ?? {};

    // Generar opciones: semana anterior y semanas planificadas
    const weekOpts = [];
    for (let i = -(this._weeks); i <= 0; i++) {
      const wk = _addWeeks(this._refWeekKey, i);
      weekOpts.push(wk);
    }
    if (!weekOpts.includes(this._compWeekKey)) this._compWeekKey = weekOpts[weekOpts.length - 1];

    const weekData   = projPpc[this._compWeekKey] ?? { tasks: {}, reasons: {} };

    // Actividades LPS manuales
    const planData   = _getPlan(project.id);
    const manualActs = planData[this._compWeekKey] ?? [];

    // Tareas CPM en esa semana (como referencia)
    const cpmTasks = this._getWeekGroupForKey(this._compWeekKey);

    // Total planificado = manual + cpm
    const totalPlanned = manualActs.length + cpmTasks.length;

    // Completados según PPC guardado
    const completedManual = manualActs.filter(a => !!weekData.tasks['lps-' + a.id]).length;
    const completedCpm    = cpmTasks.filter(r => !!weekData.tasks['cpm-' + r.task.id]).length;
    const totalCompleted  = completedManual + completedCpm;
    const ppc = totalPlanned > 0 ? Math.round((totalCompleted / totalPlanned) * 100) : null;
    const ppcColor = ppc === null ? '#757575' : ppc >= 75 ? '#388E3C' : ppc >= 60 ? '#F57C00' : '#D32F2F';

    let html = `
      <div style="background:var(--clr-surface-2,var(--clr-surface));border-left:3px solid #1976D2;padding:6px 12px;margin-bottom:6px;font-size:11px;color:var(--clr-text-2)">
        <strong style="color:#1976D2">WWP — Plan de Trabajo Semanal (WILL occur)</strong> &nbsp;·&nbsp; Compromiso de actividades que se ejecutarán esta semana &nbsp;·&nbsp; Meta PPC: <strong>75–90%</strong> (LCI §11)
      </div>
      <div class="lad-info-bar">
        <div style="display:flex;align-items:center;gap:12px">
          <label style="font-size:12px;color:var(--clr-text-2)">Semana:
            <select id="lad-comp-week" style="margin-left:6px;padding:3px 8px;border:1px solid var(--clr-border);border-radius:4px;background:var(--clr-surface);color:var(--clr-text);font-size:12px">
              ${weekOpts.map(wk => `<option value="${wk}"${wk===this._compWeekKey?' selected':''}>${_weekLabel(wk, weekOpts.indexOf(wk))}</option>`).join('')}
            </select>
          </label>
        </div>
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span id="lad-comp-planned">Planificadas: <strong>${totalPlanned}</strong></span>
          <span id="lad-comp-completed">Completadas: <strong>${totalCompleted}</strong></span>
          <span id="lad-comp-ppc">PPC: <strong style="font-size:15px;color:${ppcColor}">${ppc !== null ? ppc + '%' : 'N/A'}</strong></span>
          <label class="btn btn-ghost btn-sm" title="Importar actividades desde Excel / CSV" style="font-size:11px;padding:3px 9px;cursor:pointer;display:flex;align-items:center;gap:4px">
            📥 XLS
            <input type="file" id="lad-comp-xls-input" accept=".xlsx,.xls,.csv" style="display:none">
          </label>
          <button id="lad-save-ppc" class="btn btn-primary btn-sm" style="font-size:12px">💾 Guardar PPC</button>
        </div>
      </div>`;

    if (totalPlanned === 0) {
      html += '<p class="lad-empty">No hay actividades planificadas para esta semana. Usa "📥 XLS" para importar o registra actividades en la pestaña "Planificación".</p>';
    } else {
      const manualRows = manualActs.map((act, i) => {
        const itemId = 'lps-' + act.id;
        const done   = !!weekData.tasks[itemId];
        const reason = weekData.reasons[itemId] ?? '';
        return `<tr class="${i%2===0?'':'lad-row-alt'}">
          <td style="text-align:center">
            <input type="checkbox" class="lad-comp-chk" data-id="${itemId}" ${done?'checked':''} style="width:16px;height:16px;cursor:pointer">
          </td>
          <td style="padding:5px 8px;text-align:center">
            <span class="lad-badge" style="background:#1976D222;color:#1976D2;font-size:10px">LPS</span>
          </td>
          <td class="lad-code" style="font-size:11px;color:var(--clr-text-3);white-space:nowrap">${_esc(act.code || '—')}</td>
          <td class="lad-name" title="${_esc(act.name)}">${_esc(act.name)}</td>
          <td class="lad-date">${_esc(act.responsible || '—')}</td>
          <td class="lad-date">${_esc(act.unit || '—')}${act.qty != null ? ' · ' + act.qty : ''}</td>
          <td>
            <select class="lad-reason-sel" data-id="${itemId}" ${done?'disabled':''} style="font-size:11px;padding:2px 4px;border:1px solid var(--clr-border);border-radius:4px;background:var(--clr-surface);color:var(--clr-text);width:100%">
              <option value="">— Sin causa —</option>
              ${CAUSAS.map(c => `<option value="${c}"${reason===c?' selected':''}>${c}</option>`).join('')}
            </select>
          </td>
        </tr>`;
      }).join('');

      const cpmRows = cpmTasks.map((r, i) => {
        const itemId = 'cpm-' + r.task.id;
        const done   = !!weekData.tasks[itemId];
        const reason = weekData.reasons[itemId] ?? '';
        const status = r.pct >= 100 ? 'done' : r.cpm.tf === 0 ? 'critical' : r.pct > 0 ? 'progress' : 'todo';
        const statusColor = { done:'#388E3C', critical:'#D32F2F', progress:'#1976D2', todo:'#757575' }[status];
        const statusLabel = { done:'Completada', critical:'Crítica', progress:'En Curso', todo:'Pendiente' }[status];
        return `<tr class="${i%2===0?'':'lad-row-alt'}">
          <td style="text-align:center">
            <input type="checkbox" class="lad-comp-chk" data-id="${itemId}" ${done?'checked':''} style="width:16px;height:16px;cursor:pointer">
          </td>
          <td style="padding:5px 8px;text-align:center">
            <span class="lad-badge" style="background:${statusColor}22;color:${statusColor};font-size:10px">CPM</span>
          </td>
          <td class="lad-code" style="font-size:11px;color:var(--clr-text-3)">${_esc(r.task.wbs_code || '—')}</td>
          <td class="lad-name" title="${_esc(r.task.name)}">${_esc(r.task.name)}</td>
          <td class="lad-date">${_fmtDate(r.startDate)}</td>
          <td class="lad-date">${r.pct}%</td>
          <td>
            <select class="lad-reason-sel" data-id="${itemId}" ${done?'disabled':''} style="font-size:11px;padding:2px 4px;border:1px solid var(--clr-border);border-radius:4px;background:var(--clr-surface);color:var(--clr-text);width:100%">
              <option value="">— Sin causa —</option>
              ${CAUSAS.map(c => `<option value="${c}"${reason===c?' selected':''}>${c}</option>`).join('')}
            </select>
          </td>
        </tr>`;
      }).join('');

      const cpmHeader = cpmTasks.length > 0 ? `
        <tr><td colspan="7" style="padding:4px 8px;background:var(--clr-surface-2);font-size:11px;color:var(--clr-text-3);font-weight:600">
          📌 Del cronograma maestro (referencia)
        </td></tr>` : '';

      html += `<table class="lad-table">
        <thead><tr>
          <th style="width:38px;text-align:center">✓</th>
          <th style="width:50px">Origen</th>
          <th style="width:80px">Código</th>
          <th>Actividad</th>
          <th>Responsable / Inicio</th>
          <th>Unidad / %</th>
          <th>Causa incumplimiento</th>
        </tr></thead>
        <tbody>
          ${manualRows}
          ${cpmHeader}
          ${cpmRows}
        </tbody>
      </table>`;
    }

    this._body.innerHTML = html;

    this._body.querySelector('#lad-comp-week')?.addEventListener('change', e => {
      this._compWeekKey = /** @type {HTMLSelectElement} */ (e.target).value;
      this._renderCompliance();
    });

    this._body.querySelectorAll('.lad-comp-chk').forEach(chk => {
      chk.addEventListener('change', () => {
        const id = chk.getAttribute('data-id');
        const reasonSel = this._body.querySelector(`.lad-reason-sel[data-id="${id}"]`);
        if (reasonSel) /** @type {HTMLSelectElement} */ (reasonSel).disabled = /** @type {HTMLInputElement} */ (chk).checked;
        this._updatePpcDisplay();
      });
    });

    this._body.querySelector('#lad-save-ppc')?.addEventListener('click', () => {
      const allPpc2 = _getPPC();
      if (!allPpc2[project.id]) allPpc2[project.id] = {};
      const newWeekData = { tasks: {}, reasons: {}, saved: true, savedAt: new Date().toISOString() };
      this._body.querySelectorAll('.lad-comp-chk').forEach(chk => {
        const id = /** @type {HTMLInputElement} */ (chk).getAttribute('data-id');
        newWeekData.tasks[id] = /** @type {HTMLInputElement} */ (chk).checked;
      });
      this._body.querySelectorAll('.lad-reason-sel').forEach(sel => {
        const id = sel.getAttribute('data-id');
        if (/** @type {HTMLSelectElement} */ (sel).value) newWeekData.reasons[id] = /** @type {HTMLSelectElement} */ (sel).value;
      });
      allPpc2[project.id][this._compWeekKey] = newWeekData;
      _savePPC(allPpc2);
      document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'PPC guardado correctamente.', type: 'success' } }));
      this._renderCompliance();
    });

    const compXlsInput = /** @type {HTMLInputElement|null} */ (this._body.querySelector('#lad-comp-xls-input'));
    if (compXlsInput) {
      compXlsInput.addEventListener('change', e => {
        const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
        if (file) this._importXlsForWeek(this._compWeekKey, file, project.id);
        compXlsInput.value = '';
      });
    }
  }

  _getWeekGroupForKey(weekKey) {
    const { project, tasks, cpmResult, calendar, calExceptions } = appState.state;
    if (!project || !cpmResult) return [];
    const cal = new Calendar({
      work_week: calendar?.work_week ?? [1,2,3,4,5],
      exceptions: calExceptions ?? [],
    });
    const startDate = isoToDate(project.start_date || new Date().toISOString().slice(0,10));
    const wStart = _weekStart(weekKey);
    const wEnd   = _weekEnd(weekKey);
    wEnd.setHours(23,59,59,999);
    const result = [];
    for (const task of tasks.values()) {
      if (task.deleted_at || task.type === 'summary') continue;
      const cpm = cpmResult.tasks?.get(task.id);
      if (!cpm || cpm.is_summary) continue;
      const sDate = cal.idxToDate(cpm.es, startDate);
      const eDate = cal.idxToDate(Math.max(cpm.es, cpm.ef - 1), startDate);
      if (sDate <= wEnd && eDate >= wStart) {
        result.push({ task, cpm, startDate: sDate, endDate: eDate, pct: task.percent_complete ?? 0 });
      }
    }
    result.sort((a,b) => a.cpm.es - b.cpm.es);
    return result;
  }

  _updatePpcDisplay() {
    const chks = this._body.querySelectorAll('.lad-comp-chk');
    let completed = 0, planned = chks.length;
    chks.forEach(c => { if (/** @type {HTMLInputElement} */ (c).checked) completed++; });
    const ppc = planned > 0 ? Math.round((completed/planned)*100) : null;
    const ppcColor = ppc === null ? '#757575' : ppc >= 75 ? '#388E3C' : ppc >= 60 ? '#F57C00' : '#D32F2F';
    const sp = this._body.querySelector('#lad-comp-planned');
    const sc = this._body.querySelector('#lad-comp-completed');
    const sv = this._body.querySelector('#lad-comp-ppc');
    if (sp) sp.innerHTML = `Planificadas: <strong>${planned}</strong>`;
    if (sc) sc.innerHTML = `Completadas: <strong>${completed}</strong>`;
    if (sv) sv.innerHTML = `PPC: <strong style="font-size:15px;color:${ppcColor}">${ppc !== null ? ppc + '%' : 'N/A'}</strong>`;
  }

  _renderRestrictions() {
    const { project } = appState.state;
    if (!project) { this._body.innerHTML = '<p class="lad-empty">Abre un proyecto primero.</p>'; return; }

    const rests = _getRest(project.id);

    this._body.innerHTML = `
      <div class="lad-info-bar">
        <span>🚧 <strong>${rests.length}</strong> restricción(es) registrada(s)</span>
        <div style="display:flex;align-items:center;gap:8px">
          <label class="btn btn-ghost btn-sm" title="Importar restricciones desde Excel / CSV" style="font-size:11px;padding:3px 9px;cursor:pointer;display:flex;align-items:center;gap:4px">
            📥 XLS
            <input type="file" id="lad-rest-xls-input" accept=".xlsx,.xls,.csv" style="display:none">
          </label>
          <button id="lad-add-rest" class="btn btn-primary btn-sm" style="font-size:12px">+ Nueva restricción</button>
        </div>
      </div>
      ${rests.length === 0
        ? `<p class="lad-empty">No hay restricciones registradas. Usa "+ Nueva restricción" para agregar.</p>`
        : `<table class="lad-table">
          <thead><tr>
            <th>Descripción</th>
            <th>Tipo</th>
            <th>Empresa / Área</th>
            <th>Responsable</th>
            <th>F. Identificada</th>
            <th>F. Requerida</th>
            <th>F. Prometida</th>
            <th>F. Efectiva</th>
            <th>Estado</th>
            <th style="text-align:center">Acciones</th>
          </tr></thead>
          <tbody>
            ${rests.map((r,i) => {
              const statusLabel = r.status === 'cleared' ? 'Levantada' : r.status === 'in-progress' ? 'En proceso' : 'Pendiente';
              const statusColor = r.status === 'cleared' ? '#388E3C' : r.status === 'in-progress' ? '#F57C00' : '#D32F2F';
              const toggleIcon = r.status === 'cleared' ? '🔓' : r.status === 'in-progress' ? '⏳' : '🔒';
              const toggleTitle = r.status === 'cleared' ? 'Marcar pendiente' : r.status === 'in-progress' ? 'Marcar levantada' : 'Marcar en proceso';
              return `<tr class="${i%2===0?'':'lad-row-alt'}">
                <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(r.desc)}">${_esc(r.desc)}</td>
                <td style="font-size:11px">${_esc(r.type ?? '-')}</td>
                <td style="font-size:11px">${_esc(r.responsibleCompany ?? '-')}</td>
                <td>${_esc(r.responsible ?? '-')}</td>
                <td class="lad-date">${r.dateIdentified ? _fmtDate(new Date(r.dateIdentified + 'T12:00:00')) : '-'}</td>
                <td class="lad-date">${(r.requiredDate||r.dueDate) ? _fmtDate(new Date((r.requiredDate||r.dueDate) + 'T12:00:00')) : '-'}</td>
                <td class="lad-date">${r.promisedDate ? _fmtDate(new Date(r.promisedDate + 'T12:00:00')) : '-'}</td>
                <td class="lad-date">${r.effectiveDate ? _fmtDate(new Date(r.effectiveDate + 'T12:00:00')) : '-'}</td>
                <td>
                  <span class="lad-badge" style="background:${statusColor}22;color:${statusColor}">${statusLabel}</span>
                </td>
                <td style="text-align:center;white-space:nowrap">
                  <button class="lad-btn-icon lad-rest-toggle" data-idx="${i}" title="${toggleTitle}">
                    ${toggleIcon}
                  </button>
                  <button class="lad-btn-icon lad-rest-edit" data-idx="${i}" title="Editar">✏️</button>
                  <button class="lad-btn-icon lad-rest-del" data-idx="${i}" title="Eliminar" style="color:#D32F2F">🗑</button>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`}`;

    this._body.querySelector('#lad-add-rest')?.addEventListener('click', () => {
      this._openRestForm(null, rests, project.id, updatedRests => {
        _saveRest(project.id, updatedRests);
        this._renderRestrictions();
      });
    });

    this._body.querySelectorAll('.lad-rest-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'));
        const s = rests[idx].status;
        rests[idx].status = s === 'pending' ? 'in-progress' : s === 'in-progress' ? 'cleared' : 'pending';
        _saveRest(project.id, rests);
        this._renderRestrictions();
      });
    });

    this._body.querySelectorAll('.lad-rest-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'));
        this._openRestForm(idx, rests, project.id, updatedRests => {
          _saveRest(project.id, updatedRests);
          this._renderRestrictions();
        });
      });
    });

    this._body.querySelectorAll('.lad-rest-del').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'));
        if (!confirm('¿Eliminar esta restricción?')) return;
        rests.splice(idx, 1);
        _saveRest(project.id, rests);
        this._renderRestrictions();
      });
    });

    const restXlsInput = /** @type {HTMLInputElement|null} */ (this._body.querySelector('#lad-rest-xls-input'));
    if (restXlsInput) {
      restXlsInput.addEventListener('change', e => {
        const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
        if (file) this._importXlsForRestrictions(file, project.id);
        restXlsInput.value = '';
      });
    }
  }

  _getTaskName(taskId) {
    if (!taskId) return '-';
    const task = appState.state.tasks?.get(taskId);
    return task ? task.name : `(${taskId.slice(0,8)}…)`;
  }

  _openRestForm(editIdx, rests, projId, onSave) {
    const existing = editIdx !== null ? rests[editIdx] : null;
    const tasks = appState.state.tasks;

    const overlay = document.createElement('div');
    overlay.className = 'lad-form-overlay';
    overlay.innerHTML = `
      <div class="lad-form-modal">
        <div class="lad-form-header">
          <span>${existing ? '✏️ Editar Restricción' : '➕ Nueva Restricción'}</span>
          <button id="lad-form-close" class="btn btn-ghost btn-icon btn-sm">✕</button>
        </div>
        <div class="lad-form-body">
          <label class="lad-label">Descripción *
            <textarea id="lad-f-desc" rows="3" class="lad-input" placeholder="Describe la restricción...">${_esc(existing?.desc ?? '')}</textarea>
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="lad-label">Tipo de restricción
              <select id="lad-f-type" class="lad-input">
                <option value="">— Seleccionar —</option>
                ${['Pre-requisito','Materiales','Mano de Obra','Equipos','Diseño / Planos','Permisos','Submittals','Contratos / CO','Otros'].map(t =>
                  `<option value="${t}"${existing?.type===t?' selected':''}>${t}</option>`
                ).join('')}
              </select>
            </label>
            <label class="lad-label">Tarea vinculada
              <select id="lad-f-task" class="lad-input">
                <option value="">— Ninguna —</option>
                ${tasks ? [...tasks.values()].filter(t => !t.deleted_at && t.type !== 'summary').map(t =>
                  `<option value="${t.id}"${t.id===existing?.taskId?' selected':''}>${_esc((t.wbs_code?t.wbs_code+' – ':'')+t.name)}</option>`
                ).join('') : ''}
              </select>
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="lad-label">Responsable
              <input id="lad-f-resp" type="text" class="lad-input" placeholder="Nombre del responsable" value="${_esc(existing?.responsible ?? '')}">
            </label>
            <label class="lad-label">Empresa / Área Funcional
              <input id="lad-f-company" type="text" class="lad-input" placeholder="Empresa o área responsable" value="${_esc(existing?.responsibleCompany ?? '')}">
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="lad-label">Número RFI (opcional)
              <input id="lad-f-rfi" type="text" class="lad-input" placeholder="N° RFI" value="${_esc(existing?.rfiNumber ?? '')}">
            </label>
            <label class="lad-label">Estado
              <select id="lad-f-status" class="lad-input">
                <option value="pending"${(!existing||existing.status==='pending')?' selected':''}>Pendiente</option>
                <option value="in-progress"${existing?.status==='in-progress'?' selected':''}>En proceso</option>
                <option value="cleared"${existing?.status==='cleared'?' selected':''}>Levantada</option>
              </select>
            </label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
            <label class="lad-label">F. Identificada
              <input id="lad-f-identified" type="date" class="lad-input" value="${existing?.dateIdentified ?? ''}">
            </label>
            <label class="lad-label">F. Requerida
              <input id="lad-f-required" type="date" class="lad-input" value="${existing?.requiredDate ?? existing?.dueDate ?? ''}">
            </label>
            <label class="lad-label">F. Prometida
              <input id="lad-f-promised" type="date" class="lad-input" value="${existing?.promisedDate ?? ''}">
            </label>
            <label class="lad-label">F. Efectiva
              <input id="lad-f-effective" type="date" class="lad-input" value="${existing?.effectiveDate ?? ''}">
            </label>
          </div>
          <label class="lad-label">Observaciones / Comentarios
            <textarea id="lad-f-comments" rows="2" class="lad-input" placeholder="Notas adicionales...">${_esc(existing?.comments ?? '')}</textarea>
          </label>
        </div>
        <div class="lad-form-footer">
          <button id="lad-form-cancel" class="btn btn-ghost btn-sm">Cancelar</button>
          <button id="lad-form-save" class="btn btn-primary btn-sm">Guardar</button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector('#lad-form-close')?.addEventListener('click', close);
    overlay.querySelector('#lad-form-cancel')?.addEventListener('click', close);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

    overlay.querySelector('#lad-form-save')?.addEventListener('click', () => {
      const desc = overlay.querySelector('#lad-f-desc').value.trim();
      if (!desc) { alert('La descripción es obligatoria.'); return; }
      const requiredDate = overlay.querySelector('#lad-f-required').value || null;
      const entry = {
        id:                existing?.id ?? `rest-${Date.now()}`,
        desc,
        type:              overlay.querySelector('#lad-f-type').value || null,
        taskId:            overlay.querySelector('#lad-f-task').value || null,
        responsible:       overlay.querySelector('#lad-f-resp').value.trim() || null,
        responsibleCompany: overlay.querySelector('#lad-f-company').value.trim() || null,
        rfiNumber:         overlay.querySelector('#lad-f-rfi').value.trim() || null,
        dateIdentified:    overlay.querySelector('#lad-f-identified').value || null,
        requiredDate,
        dueDate:           requiredDate,
        promisedDate:      overlay.querySelector('#lad-f-promised').value || null,
        effectiveDate:     overlay.querySelector('#lad-f-effective').value || null,
        status:            overlay.querySelector('#lad-f-status').value,
        comments:          overlay.querySelector('#lad-f-comments').value.trim() || null,
        createdAt:         existing?.createdAt ?? new Date().toISOString(),
        updatedAt:         new Date().toISOString(),
      };
      if (editIdx !== null) rests[editIdx] = entry;
      else rests.push(entry);
      close();
      onSave(rests);
    });
  }

  _renderDashboard() {
    const { project, cpmResult } = appState.state;
    if (!project) { this._body.innerHTML = '<p class="lad-empty">Abre un proyecto primero.</p>'; return; }

    const allPpc  = _getPPC();
    const projPpc = allPpc[project.id] ?? {};
    const rests   = _getRest(project.id);
    const planData = _getPlan(project.id);

    const histLen = Math.max(this._weeks, 4);
    const history = [];
    for (let i = -(histLen - 1); i <= 0; i++) {
      const wk         = _addWeeks(this._refWeekKey, i);
      const wData      = projPpc[wk];
      const cpmTasks   = this._getWeekGroupForKey(wk);
      const manualActs = planData[wk] ?? [];
      const planned    = cpmTasks.length + manualActs.length;
      let completed = 0;
      if (wData) {
        cpmTasks.forEach(r => { if (wData.tasks?.['cpm-' + r.task.id]) completed++; });
        manualActs.forEach(a => { if (wData.tasks?.['lps-' + a.id]) completed++; });
      }
      const ppc = planned > 0 && wData?.saved ? Math.round((completed/planned)*100) : null;
      history.push({ wk, planned, completed, ppc, label: `S${i + histLen}` });
    }

    const groups = cpmResult ? this._getWeekGroups() : null;
    let totalPlanned = 0, totalDone = 0, totalCrit = 0, totalDelayed = 0;
    // Count LPS manual activities in lookahead window
    for (let i = 0; i < this._weeks; i++) {
      const wk = _addWeeks(this._refWeekKey, i);
      totalPlanned += (planData[wk] ?? []).length;
    }
    if (groups) {
      for (const [, rows] of groups) {
        for (const r of rows) {
          totalPlanned++;
          if (r.pct >= 100) totalDone++;
          if (r.cpm.tf === 0) totalCrit++;
          const today = new Date(); today.setHours(0,0,0,0);
          if (r.pct < 100 && r.endDate < today) totalDelayed++;
        }
      }
    }

    const restPending = rests.filter(r => r.status !== 'cleared').length;
    const restCleared = rests.filter(r => r.status === 'cleared').length;

    const validPpc = history.filter(h => h.ppc !== null).map(h => h.ppc);
    const avgPpc   = validPpc.length > 0 ? Math.round(validPpc.reduce((a,b)=>a+b,0)/validPpc.length) : null;

    const chartW = 520, chartH = 160, barW = Math.floor((chartW - 40) / history.length) - 4;
    const chartBars = history.map((h, i) => {
      const x = 40 + i * ((chartW - 40) / history.length) + 2;
      const val = h.ppc ?? 0;
      const barH = h.ppc !== null ? Math.max(4, Math.round((val / 100) * (chartH - 40))) : 0;
      const y = chartH - 20 - barH;
      const color = h.ppc === null ? '#CFD8DC' : h.ppc >= 75 ? '#388E3C' : h.ppc >= 60 ? '#F57C00' : '#D32F2F';
      return `
        <rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" rx="2">
          <title>${h.label}: ${h.ppc !== null ? h.ppc + '%' : 'Sin datos'}</title>
        </rect>
        ${h.ppc !== null ? `<text x="${x + barW/2}" y="${y - 3}" text-anchor="middle" font-size="9" fill="${color}" font-weight="600">${h.ppc}%</text>` : ''}
        <text x="${x + barW/2}" y="${chartH - 5}" text-anchor="middle" font-size="9" fill="#78909C">${h.label}</text>`;
    }).join('');
    const refY75 = chartH - 20 - Math.round((75/100) * (chartH - 40));
    const refY90 = chartH - 20 - Math.round((90/100) * (chartH - 40));

    const chart = `
      <svg width="100%" viewBox="0 0 ${chartW} ${chartH}" style="max-width:${chartW}px;display:block">
        <rect x="40" y="${refY90}" width="${chartW - 40}" height="${refY75 - refY90}" fill="#388E3C" opacity="0.07"/>
        <line x1="40" y1="${refY75}" x2="${chartW}" y2="${refY75}" stroke="#F57C00" stroke-dasharray="4,3" stroke-width="1.5"/>
        <text x="${chartW - 4}" y="${refY75 - 3}" text-anchor="end" font-size="9" fill="#F57C00">75% (meta LCI)</text>
        <line x1="40" y1="${refY90}" x2="${chartW}" y2="${refY90}" stroke="#388E3C" stroke-dasharray="4,3" stroke-width="1.5"/>
        <text x="${chartW - 4}" y="${refY90 - 3}" text-anchor="end" font-size="9" fill="#388E3C">90% (óptimo LCI)</text>
        ${chartBars}
        <line x1="40" y1="0" x2="40" y2="${chartH - 20}" stroke="#CFD8DC" stroke-width="1"/>
        <line x1="40" y1="${chartH - 20}" x2="${chartW}" y2="${chartH - 20}" stroke="#CFD8DC" stroke-width="1"/>
      </svg>`;

    const avgColor = avgPpc === null ? '#757575' : avgPpc >= 75 ? '#388E3C' : avgPpc >= 60 ? '#F57C00' : '#D32F2F';

    this._body.innerHTML = `
      <div class="lad-dash-grid">
        <div class="lad-kpi-card">
          <div class="lad-kpi-val" style="color:${avgColor}">${avgPpc !== null ? avgPpc + '%' : 'N/A'}</div>
          <div class="lad-kpi-label">PPC Promedio</div>
          <div class="lad-kpi-sub">${validPpc.length} semana${validPpc.length!==1?'s':''} con datos</div>
        </div>
        <div class="lad-kpi-card">
          <div class="lad-kpi-val" style="color:#1976D2">${totalPlanned}</div>
          <div class="lad-kpi-label">Tareas en Lookahead</div>
          <div class="lad-kpi-sub">${this._weeks} semana${this._weeks!==1?'s':''} adelante</div>
        </div>
        <div class="lad-kpi-card">
          <div class="lad-kpi-val" style="color:#D32F2F">${totalCrit}</div>
          <div class="lad-kpi-label">Tareas Críticas</div>
          <div class="lad-kpi-sub">Holgura total = 0</div>
        </div>
        <div class="lad-kpi-card">
          <div class="lad-kpi-val" style="color:${restPending>0?'#D32F2F':'#388E3C'}">${restPending}</div>
          <div class="lad-kpi-label">Restricciones Pendientes</div>
          <div class="lad-kpi-sub">${restCleared} levantada${restCleared!==1?'s':''}</div>
        </div>
      </div>

      <div class="lad-chart-section">
        <div class="lad-section-title">Historial PPC — Últimas ${histLen} semanas</div>
        ${chart}
        <div style="display:flex;gap:16px;margin-top:8px;font-size:11px;color:var(--clr-text-3)">
          <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#388E3C;border-radius:2px;display:inline-block"></span>≥ 75%</span>
          <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#F57C00;border-radius:2px;display:inline-block"></span>60–74%</span>
          <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#D32F2F;border-radius:2px;display:inline-block"></span>&lt;60%</span>
          <span style="display:flex;align-items:center;gap:4px"><span style="width:10px;height:10px;background:#CFD8DC;border-radius:2px;display:inline-block"></span>Sin datos</span>
        </div>
        <div style="overflow-x:auto;margin-top:12px">
          <table class="lad-table" style="font-size:11px;min-width:480px">
            <thead><tr>
              <th style="text-align:center">Semana #</th>
              <th>Fin de Semana</th>
              <th style="text-align:center"># Planificadas</th>
              <th style="text-align:center"># Completadas</th>
              <th style="text-align:center">PPC</th>
              <th style="text-align:center">Promedio</th>
              <th style="text-align:center">No Completadas</th>
            </tr></thead>
            <tbody>
              ${(() => {
                let runSum = 0, runCnt = 0;
                return history.map((h, i) => {
                  if (h.ppc !== null) { runSum += h.ppc; runCnt++; }
                  const runAvg = runCnt > 0 ? Math.round(runSum / runCnt) : null;
                  const ppcColor = h.ppc === null ? '#757575' : h.ppc >= 75 ? '#388E3C' : h.ppc >= 60 ? '#F57C00' : '#D32F2F';
                  const wEnd = _weekEnd(_addWeeks(this._refWeekKey, i - (histLen - 1)));
                  return `<tr class="${i%2===0?'':'lad-row-alt'}">
                    <td style="text-align:center">${h.label}</td>
                    <td>${_fmtDate(wEnd)}</td>
                    <td style="text-align:center">${h.planned}</td>
                    <td style="text-align:center">${h.completed}</td>
                    <td style="text-align:center;font-weight:700;color:${ppcColor}">${h.ppc !== null ? h.ppc + '%' : '—'}</td>
                    <td style="text-align:center;color:${runAvg !== null ? (runAvg >= 75 ? '#388E3C' : runAvg >= 60 ? '#F57C00' : '#D32F2F') : '#757575'}">${runAvg !== null ? runAvg + '%' : '—'}</td>
                    <td style="text-align:center">${h.ppc !== null ? h.planned - h.completed : '—'}</td>
                  </tr>`;
                }).join('');
              })()}
            </tbody>
          </table>
        </div>
      </div>

      <div class="lad-section-title" style="margin-top:16px">Resumen tareas — Lookahead actual</div>
      <div class="lad-dash-row">
        <div class="lad-stat"><span>${totalPlanned}</span><small>Planificadas</small></div>
        <div class="lad-stat"><span style="color:#388E3C">${totalDone}</span><small>Completadas</small></div>
        <div class="lad-stat"><span style="color:#D32F2F">${totalDelayed}</span><small>Atrasadas</small></div>
        <div class="lad-stat"><span style="color:${totalPlanned-totalDone-totalDelayed>0?'#1976D2':'#757575'}">${Math.max(0,totalPlanned-totalDone-totalDelayed)}</span><small>En progreso/pendiente</small></div>
      </div>

      ${rests.length > 0 ? `
      <div class="lad-section-title" style="margin-top:16px">Últimas restricciones</div>
      <table class="lad-table">
        <thead><tr><th>Descripción</th><th>Tipo</th><th>Responsable</th><th>F. Identificada</th><th>F. Requerida</th><th>Estado</th></tr></thead>
        <tbody>
          ${rests.slice(0,5).map((r,i) => {
            const statusLabel = r.status === 'cleared' ? 'Levantada' : r.status === 'in-progress' ? 'En proceso' : 'Pendiente';
            const statusColor = r.status === 'cleared' ? '#388E3C' : r.status === 'in-progress' ? '#F57C00' : '#D32F2F';
            return `<tr class="${i%2===0?'':'lad-row-alt'}">
              <td>${_esc(r.desc)}</td>
              <td style="font-size:11px">${_esc(r.type ?? '-')}</td>
              <td>${_esc(r.responsible ?? '-')}</td>
              <td class="lad-date">${r.dateIdentified ? _fmtDate(new Date(r.dateIdentified + 'T12:00:00')) : '-'}</td>
              <td class="lad-date">${(r.requiredDate||r.dueDate) ? _fmtDate(new Date((r.requiredDate||r.dueDate) + 'T12:00:00')) : '-'}</td>
              <td><span class="lad-badge" style="background:${statusColor}22;color:${statusColor}">${statusLabel}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : ''}`;
  }

  _print() {
    switch (this._tab) {
      case 'planning':     this._printPlanning(); break;
      case 'compliance':   this._printCompliance(); break;
      case 'restrictions': this._printRestrictions(); break;
      case 'dashboard':    this._printDashboard(); break;
    }
  }

  _printPlanning() {
    const { project } = appState.state;
    if (!project) return;
    const planData  = _getPlan(project.id);
    const cpmGroups = this._getWeekGroups();
    let html = `<h1>Lookahead Detallado — Planificación ${this._weeks} semanas</h1>`;
    for (let idx = 0; idx < this._weeks; idx++) {
      const wk      = _addWeeks(this._refWeekKey, idx);
      const manual  = planData[wk] ?? [];
      const cpmRows = cpmGroups?.get(wk) ?? [];
      html += `<h2>${_weekLabel(wk, idx)}</h2>`;
      if (!manual.length && !cpmRows.length) { html += '<p>Sin actividades.</p>'; continue; }
      html += `<table><thead><tr><th>Origen</th><th>Actividad</th><th>Responsable</th><th>Unidad</th><th>Metrado</th></tr></thead><tbody>`;
      for (const a of manual) {
        html += `<tr><td>LPS</td><td>${_esc(a.name)}</td><td>${_esc(a.responsible||'-')}</td><td>${_esc(a.unit||'-')}</td><td>${a.qty!=null?a.qty:'-'}</td></tr>`;
      }
      for (const r of cpmRows) {
        const status = r.pct >= 100 ? 'Completada' : r.cpm.tf === 0 ? 'Crítica' : r.pct > 0 ? 'En Curso' : 'Pendiente';
        html += `<tr><td>CPM</td><td>${_esc(r.task.name)}</td><td>${_fmtDate(r.startDate)}–${_fmtDate(r.endDate)}</td><td>${r.pct}%</td><td>${status}</td></tr>`;
      }
      html += `</tbody></table>`;
    }
    _printToPdf('Lookahead - Planificación', html);
  }

  _printCompliance() {
    const { project } = appState.state;
    if (!project || !this._compWeekKey) return;
    const allPpc  = _getPPC();
    const projPpc = allPpc[project.id] ?? {};
    const weekData   = projPpc[this._compWeekKey] ?? { tasks:{}, reasons:{} };
    const planData   = _getPlan(project.id);
    const manualActs = planData[this._compWeekKey] ?? [];
    const cpmTasks   = this._getWeekGroupForKey(this._compWeekKey);
    const totalPlanned = manualActs.length + cpmTasks.length;
    let completed = 0;
    manualActs.forEach(a => { if (weekData.tasks?.['lps-' + a.id]) completed++; });
    cpmTasks.forEach(r  => { if (weekData.tasks?.['cpm-' + r.task.id]) completed++; });
    const ppc = totalPlanned > 0 ? Math.round((completed/totalPlanned)*100) : null;
    let html = `<h1>Lookahead — Cumplimiento PPC</h1>
      <p>Semana: ${_weekLabel(this._compWeekKey, 0)} | Planificadas: ${totalPlanned} | Completadas: ${completed} | PPC: ${ppc !== null ? ppc + '%' : 'N/A'}</p>
      <table><thead><tr><th>Origen</th><th>Actividad</th><th>Detalle</th><th>¿Completada?</th><th>Causa</th></tr></thead><tbody>`;
    for (const a of manualActs) {
      const id = 'lps-' + a.id;
      const done = !!weekData.tasks[id];
      html += `<tr><td>LPS</td><td>${_esc(a.name)}</td><td>${_esc(a.responsible||'-')}</td><td>${done?'Sí':'No'}</td><td>${done?'-':_esc(weekData.reasons[id]||'-')}</td></tr>`;
    }
    for (const r of cpmTasks) {
      const id = 'cpm-' + r.task.id;
      const done = !!weekData.tasks[id];
      html += `<tr><td>CPM</td><td>${_esc(r.task.name)}</td><td>${_fmtDate(r.startDate)}–${_fmtDate(r.endDate)}</td><td>${done?'Sí':'No'}</td><td>${done?'-':_esc(weekData.reasons[id]||'-')}</td></tr>`;
    }
    html += `</tbody></table>`;
    _printToPdf('Lookahead - Cumplimiento PPC', html);
  }

  _printRestrictions() {
    const { project } = appState.state;
    if (!project) return;
    const rests = _getRest(project.id);
    let html = `<h1>Lookahead — Restricciones</h1>
      <p>${rests.length} restricción(es)</p>
      <table><thead><tr><th>Descripción</th><th>Tipo</th><th>Empresa/Área</th><th>Responsable</th><th>F. Identificada</th><th>F. Requerida</th><th>F. Prometida</th><th>F. Efectiva</th><th>Estado</th></tr></thead><tbody>`;
    for (const r of rests) {
      const sl = r.status === 'cleared' ? 'Levantada' : r.status === 'in-progress' ? 'En proceso' : 'Pendiente';
      html += `<tr><td>${_esc(r.desc)}</td><td>${_esc(r.type??'-')}</td><td>${_esc(r.responsibleCompany??'-')}</td><td>${_esc(r.responsible??'-')}</td><td>${r.dateIdentified?_fmtDate(new Date(r.dateIdentified+'T12:00:00')):'-'}</td><td>${(r.requiredDate||r.dueDate)?_fmtDate(new Date((r.requiredDate||r.dueDate)+'T12:00:00')):'-'}</td><td>${r.promisedDate?_fmtDate(new Date(r.promisedDate+'T12:00:00')):'-'}</td><td>${r.effectiveDate?_fmtDate(new Date(r.effectiveDate+'T12:00:00')):'-'}</td><td>${sl}</td></tr>`;
    }
    html += `</tbody></table>`;
    _printToPdf('Lookahead - Restricciones', html);
  }

  _printDashboard() {
    const { project } = appState.state;
    if (!project) return;
    const allPpc   = _getPPC();
    const projPpc  = allPpc[project.id] ?? {};
    const planData = _getPlan(project.id);
    const histLen  = Math.max(this._weeks, 4);
    let html = `<h1>Lookahead — Dashboard</h1><table><thead><tr><th>Semana</th><th>Planificadas</th><th>Completadas</th><th>PPC</th></tr></thead><tbody>`;
    for (let i = -(histLen-1); i <= 0; i++) {
      const wk         = _addWeeks(this._refWeekKey, i);
      const wData      = projPpc[wk];
      const cpmTasks   = this._getWeekGroupForKey(wk);
      const manualActs = planData[wk] ?? [];
      const planned    = cpmTasks.length + manualActs.length;
      let completed = 0;
      if (wData) {
        cpmTasks.forEach(r => { if (wData.tasks?.['cpm-' + r.task.id]) completed++; });
        manualActs.forEach(a => { if (wData.tasks?.['lps-' + a.id]) completed++; });
      }
      const ppc = planned > 0 && wData?.saved ? Math.round((completed/planned)*100) + '%' : 'Sin datos';
      html += `<tr><td>${_weekLabel(wk, i + histLen - 1)}</td><td>${planned}</td><td>${planned>0&&wData?.saved?completed:'-'}</td><td>${ppc}</td></tr>`;
    }
    html += `</tbody></table>`;
    const rests = _getRest(project.id);
    html += `<h2>Restricciones (${rests.length})</h2><table><thead><tr><th>Descripción</th><th>Tipo</th><th>Responsable</th><th>F. Identificada</th><th>Estado</th></tr></thead><tbody>`;
    for (const r of rests) html += `<tr><td>${_esc(r.desc)}</td><td>${_esc(r.type??'-')}</td><td>${_esc(r.responsible??'-')}</td><td>${r.dateIdentified?_fmtDate(new Date(r.dateIdentified+'T12:00:00')):'-'}</td><td>${r.status==='cleared'?'Levantada':r.status==='in-progress'?'En proceso':'Pendiente'}</td></tr>`;
    html += `</tbody></table>`;
    _printToPdf('Lookahead - Dashboard', html);
  }
}
