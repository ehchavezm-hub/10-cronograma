// @ts-check
/**
 * main.js — Punto de entrada de la aplicación.
 * Detecta file://, inicializa módulos, carga datos demo en modo local.
 */

import { IS_LOCAL_MODE } from './config.js';
import { appState }      from './state.js';
import { WbsTable }      from './wbs-table.js';
import { GanttCanvas }   from './gantt-canvas.js';
import { GanttScene }    from './scene.js';
import { DcmaPanel }     from './dcma.js';
import { Calendar, isoToDate } from './calendar.js';
import { computeCPM }    from './cpm.js';
import { openDB, listProjects, listAllProjects, loadProject, saveProjectSnapshot, putMany, put as dbPut, getByIndex, getAll, remove as dbRemove,
         listPortfolios, savePortfolio, deletePortfolio, listPrograms, saveProgram, deleteProgram, loadHierarchy, outboxAdd } from './storage.js';
import { t }             from './i18n.js';
import { ensureDemoData } from './demo-seed.js';
import { exportJson, importJson, exportCsv, exportMspXml, exportSvg } from './io.js';
import { printWbsTable, printGantt, getPrintCols, setPrintCols } from './print.js';
import { SyncEngine }     from './sync.js';
import { EvmPanel }       from './evm.js';
import { ChangeLogPanel, logCommand } from './change-log.js';
import { ResourceHistogramPanel } from './resource-histogram.js';
import { saveBaseline, listBaselines, loadBaselineData, deleteBaseline, setPrimaryBaseline, getBaseline, renameBaseline } from './baseline.js';
import { parseXer } from './xer-import.js';
import { detectConflicts, levelResources } from './resource-leveling.js';
import { MonteCarloPanel } from './monte-carlo.js';
import { RiskRegisterPanel } from './risk-register.js';
import { toggleBaselineCompare, disableBaselineCompare, getProjectBaselines, isBaselineCompareEnabled, enableBaselineCompare, getActiveBaselineId } from './baseline-compare.js';
import { LookaheadPanel } from './lookahead.js';
import { LookaheadDetailedPanel } from './lookahead-detailed.js';
import { CurvaSPanel } from './curva-s.js';
import { NotificationsPanel, updateNotificationBadge } from './notifications.js';
import { WbsDictionaryPanel } from './wbs-dictionary.js';
import { generatePdfReport } from './pdf-report.js';
import { pageHfCss, REPORT_TITLE_CSS, REPORT_FONT_CSS, normalizeReportBody, supportsPageMarginBoxes, PAPER_SELECT_HTML, PAPER_JS, FONTS_LINK, installDesktopPrint } from './pdf-utils.js';
import { debouncedSave, queue } from './async-queue.js';
import { initReports } from './reports.js';
import { authInit, authState, showLoginModal, logout } from './auth.js?v=180';
import { showUsuariosPanel } from './usuarios.js';
import { showEmpresaAdminPanel } from './empresa-admin.js';

// Precargar Manrope: los gráficos canvas de los reportes (DCMA, EVM, Histograma) la usan
// y el canvas no dispara la descarga de la fuente por sí solo.
['400 10px "Manrope"', '600 11px "Manrope"', '700 28px "Manrope"'].forEach(f => document.fonts?.load(f).catch(() => {}));

// ============================================================
// Detectar file://
// ============================================================
if (location.protocol === 'file:') {
  const warn = document.getElementById('file-protocol-warning');
  if (warn) warn.classList.add('show');
  throw new Error('file:// protocol: modules are not supported. Use a local server.');
}

// ============================================================
// Web Worker CPM
// ============================================================
let _worker = null;
let _workerPending = false;

function _initWorker() {
  try {
    _worker = new Worker('./js/workers/cpm.worker.js', { type: 'module' });
    _worker.onmessage = (e) => {
      _workerPending = false;
      if (e.data.ok) {
        const result = e.data.result;
        result.tasks = new Map(result.tasks.map(t => [t.id, t]));
        appState.setCpmResult(result);
        _updateStatus();
        // Si el estado cambió mientras el worker procesaba, re-calcular
        if (appState.state.cpmDirty) _requestCpm();
      } else {
        console.error('[CPM worker]', e.data.error);
        _runCpmSync();
      }
    };
    _worker.onerror = (err) => {
      console.error('[CPM worker error]', err);
      _workerPending = false;  // desbloquear para que el siguiente request funcione
      _worker = null;
      _runCpmSync();           // calcular en hilo principal como fallback
    };
  } catch {
    _worker = null;
  }
}

function _requestCpm() {
  if (_workerPending) return;
  const { project, tasks, deps, calendar, calExceptions } = appState.state;
  if (!project) return;

  // Fallback a hoy si el proyecto no tiene fecha de inicio
  const startDate = project.start_date || new Date().toISOString().slice(0, 10);
  const dataDate  = project.data_date ?? null;

  const calDef = calendar
    ? { work_week: calendar.work_week,
        exceptions: (calExceptions ?? []).filter(e => !e.deleted_at).map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };

  const taskArr = [...tasks.values()];
  const depArr  = [...deps.values()];

  if (_worker) {
    _workerPending = true;
    _worker.postMessage({ tasks: taskArr, deps: depArr, calendarDef: calDef, projectStartISO: startDate, dataDateISO: dataDate, nearThreshold: appState.state.nearThreshold });
  } else {
    _runCpmSync();
  }
}

function _runCpmSync() {
  const { project, tasks, deps, calendar, calExceptions } = appState.state;
  if (!project) return;

  const calDef = calendar
    ? { work_week: calendar.work_week,
        exceptions: (calExceptions ?? []).filter(e => !e.deleted_at).map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };

  const cal = new Calendar(calDef);
  // Fallback a hoy si el proyecto no tiene fecha de inicio configurada
  const startIso = project.start_date || new Date().toISOString().slice(0, 10);
  const startDate = isoToDate(startIso);
  let dataDateIdx = null;
  if (project.data_date) {
    dataDateIdx = cal.dateToIdx(isoToDate(project.data_date), startDate);
  }

  try {
    const result = computeCPM([...tasks.values()], [...deps.values()], cal, startDate, dataDateIdx, appState.state.nearThreshold);
    appState.setCpmResult(result);
    _updateStatus();
  } catch (err) {
    console.error('[CPM sync error]', err);
  }
}

// ============================================================
// Persistencia de comandos
// ============================================================

appState.onPersist = async ({ cmd, isUndo }) => {
  // Registrar en historial de sesión (no registrar los undos)
  if (!isUndo) logCommand(cmd);
  const { project, tasks, deps } = appState.state;
  if (!project) return;
  try {
    // Guardar tareas y deps afectadas en IndexedDB + encolar en outbox
    if (cmd.type === 'ADD_TASK' || cmd.type === 'UPDATE_TASK' || cmd.type === 'REMOVE_TASK') {
      const id   = cmd.payload.task?.id ?? cmd.payload.id;
      const task = tasks.get(id);
      if (task) {
        await dbPut('tasks', task);
        if (!IS_LOCAL_MODE) {
          await outboxAdd({
            id:            crypto.randomUUID(),
            tabla:         'tasks',
            fila:          id,
            tipo:          cmd.type === 'ADD_TASK'    ? 'INSERT'
                         : cmd.type === 'REMOVE_TASK' ? 'DELETE' : 'UPDATE',
            campos:        task,
            baseUpdatedAt: task.updated_at ?? null,
          });
        }
      }
    }
    if (cmd.type === 'MOVE_TASK') {
      const { id } = cmd.payload;
      const task = tasks.get(id);
      if (task) {
        await dbPut('tasks', task);
        if (!IS_LOCAL_MODE) {
          await outboxAdd({
            id:            crypto.randomUUID(),
            tabla:         'tasks',
            fila:          id,
            tipo:          'UPDATE',
            campos:        task,
            baseUpdatedAt: task.updated_at ?? null,
          });
        }
      }
    }
    if (cmd.type === 'ADD_DEP' || cmd.type === 'REMOVE_DEP') {
      const depId = cmd.payload.dep?.id ?? cmd.payload.id;
      const dep   = deps.get(depId);
      if (dep) {
        await dbPut('task_dependencies', dep);
        if (!IS_LOCAL_MODE) {
          await outboxAdd({
            id:            crypto.randomUUID(),
            tabla:         'task_dependencies',
            fila:          depId,
            tipo:          cmd.type === 'ADD_DEP' ? 'INSERT' : 'DELETE',
            campos:        dep,
            baseUpdatedAt: dep.updated_at ?? null,
          });
        }
      }
    }
    if (cmd.type === 'UPDATE_PROJECT' && project) {
      await dbPut('projects', project);
      if (!IS_LOCAL_MODE) {
        await outboxAdd({
          id:            crypto.randomUUID(),
          tabla:         'projects',
          fila:          project.id,
          tipo:          'UPDATE',
          campos:        project,
          baseUpdatedAt: project.updated_at ?? null,
        });
      }
    }
  } catch (err) {
    if (err.message === 'OUTBOX_LIMIT') {
      _showToast(t('outboxWarning'), 'warn');
    }
  }
};

// ============================================================
// UI helpers
// ============================================================

let _toastTimeout = null;

/** Sync bar-label checkboxes to the given list of selected keys */
function _syncBarLabelsUI(labels) {
  const menu = document.getElementById('bar-labels-menu');
  if (!menu) return;
  const sel = new Set(labels);
  menu.querySelectorAll('input[type=checkbox]').forEach(/** @type {HTMLInputElement} */ (cb) => {
    cb.checked = sel.has(cb.value);
  });
}

const ALL_WBS_COLS = ['wbs','name','type','dur','start','finish','pct','tf','ff','pred','alerts'];
const DEFAULT_WBS_COLS = ['wbs','name','type','dur','start','finish','pct','tf','pred','alerts'];

/** Lee visibilidad de columnas WBS guardada. */
function _getWbsColVisibility() {
  try {
    const saved = JSON.parse(localStorage.getItem('wbs-col-visibility') || 'null');
    if (Array.isArray(saved)) return saved;
  } catch { /* ignore */ }
  return DEFAULT_WBS_COLS;
}

/**
 * Aplica visibilidad de columnas WBS inyectando una regla CSS.
 * @param {string[]} [visible]
 */
function _applyWbsColVisibility(visible) {
  if (!visible) visible = _getWbsColVisibility();
  const visSet = new Set(visible);
  const hidden = ALL_WBS_COLS.filter(c => c !== 'name' && !visSet.has(c));
  let style = document.getElementById('wbs-col-vis-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'wbs-col-vis-style';
    document.head.appendChild(style);
  }
  style.textContent = hidden.length
    ? hidden.map(c => `.wbs-table th[data-col="${c}"], .wbs-table td[data-col="${c}"] { display: none !important; }
@media print { .wbs-table th[data-col="${c}"], .wbs-table td[data-col="${c}"] { display: none !important; } }`).join('\n')
    : '';
  // Sincronizar checkboxes del menú
  const menu = document.getElementById('wbs-cols-menu');
  if (menu) {
    menu.querySelectorAll('input[type=checkbox]:not([disabled])').forEach(/** @type {HTMLInputElement} */ (cb) => {
      cb.checked = visSet.has(cb.value);
    });
  }
}

/** Diálogo de confirmación accesible (reemplaza confirm() nativo). @param {string} msg @param {()=>void} onConfirm */
function _confirmDialog(msg, onConfirm) {
  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-confirm-generic'));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-confirm-generic';
    dlg.setAttribute('role', 'alertdialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'dlg-confirm-generic-msg');
    dlg.style.cssText = 'padding:20px 24px;border-radius:8px;border:1px solid var(--clr-border);box-shadow:0 8px 24px rgba(0,0,0,.35);min-width:280px;max-width:360px;background:var(--clr-surface);color:var(--clr-text);font-family:var(--font-ui)';
    dlg.innerHTML = `<p id="dlg-confirm-generic-msg" style="margin:0 0 16px;font-size:14px;line-height:1.5"></p>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button id="dlg-confirm-generic-no"  class="btn btn-secondary btn-sm">Cancelar</button>
        <button id="dlg-confirm-generic-yes" class="btn btn-sm" style="background:var(--clr-danger,#e74c3c);color:#fff;border:none">Eliminar</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#dlg-confirm-generic-no')?.addEventListener('click', () => dlg?.close());
  }
  /** @type {HTMLElement|null} */ (dlg.querySelector('#dlg-confirm-generic-msg')).textContent = msg;
  const yesBtn = dlg.querySelector('#dlg-confirm-generic-yes');
  if (yesBtn) {
    const fresh = /** @type {HTMLElement} */ (yesBtn.cloneNode(true));
    yesBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => { dlg?.close(); onConfirm(); });
  }
  dlg.showModal();
}

/** @param {string} msg @param {'success'|'error'|'warn'|''} type */
function _showToast(msg, type = '') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ============================================================
// Panel de Detalle de Tarea + Recursos
// ============================================================

let _taskDetailPanel = null;
let _taskDetailTrigger = null;
let _taskDetailResources = [];

function _initTaskDetailPanel() {
  if (_taskDetailPanel) return;
  const panel = document.createElement('div');
  panel.id = 'task-detail-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'tdp-title');
  panel.style.cssText = `
    position:fixed;right:0;top:0;bottom:0;width:380px;max-width:100vw;
    background:var(--clr-surface);border-left:1px solid var(--clr-border);
    box-shadow:-4px 0 24px rgba(0,0,0,0.12);z-index:400;
    display:flex;flex-direction:column;transform:translateX(100%);
    transition:transform 0.22s cubic-bezier(.4,0,.2,1);overflow:hidden;
  `;
  panel.innerHTML = `
    <div id="tdp-header" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);flex-shrink:0">
      <span id="tdp-title" style="font-weight:700;font-size:14px">Detalle de actividad</span>
      <button id="tdp-close" class="btn btn-icon btn-sm" title="Cerrar" aria-label="Cerrar detalle">✕</button>
    </div>
    <div id="tdp-body" style="flex:1;overflow-y:auto;padding:16px"></div>
    <div id="tdp-footer" style="padding:12px 16px;border-top:1px solid var(--clr-border);display:flex;gap:8px;justify-content:flex-end;background:var(--clr-surface-2);flex-shrink:0">
      <button id="tdp-cancel" class="btn btn-ghost btn-sm">Cancelar</button>
      <button id="tdp-save"   class="btn btn-primary btn-sm">Guardar cambios</button>
    </div>`;
  document.body.appendChild(panel);
  _taskDetailPanel = panel;

  panel.querySelector('#tdp-close').addEventListener('click', _closeTaskDetail);
  panel.querySelector('#tdp-cancel').addEventListener('click', _closeTaskDetail);
  panel.querySelector('#tdp-save').addEventListener('click', _saveTaskDetail);
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); _closeTaskDetail(); }
  });
}

function _closeTaskDetail() {
  if (_taskDetailPanel) _taskDetailPanel.style.transform = 'translateX(100%)';
  _taskDetailTrigger?.focus();
  _taskDetailTrigger = null;
}

async function _openTaskDetail(taskId) {
  _initTaskDetailPanel();
  const task = appState.state.tasks.get(taskId);
  if (!task) return;

  _taskDetailPanel.dataset.taskId = taskId;
  const cpmTask = appState.state.cpmResult?.tasks?.get(taskId);
  const project = appState.state.project;
  const startIso = project?.start_date || new Date().toISOString().slice(0, 10);

  // Convertir índice de días laborables CPM a fecha usando el calendario del proyecto
  const _calState = appState.state.calendar;
  const _calDef = _calState
    ? { work_week: _calState.work_week, exceptions: (appState.state.calExceptions || []).filter(e => !e.deleted_at).map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };
  const _calObj = new Calendar(_calDef);
  const _startDate = isoToDate(startIso);

  const idxToDate = (idx) => {
    if (idx == null) return '—';
    try {
      const d = _calObj.idxToDate(idx, _startDate);
      return d.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });
    } catch { return String(idx) + 'd'; }
  };

  // addDays usa el mismo calendario
  const addDays = (n) => idxToDate(n);

  // Cargar recursos asignados
  let taskResources = [];
  let allResources = [];
  try {
    const { getAll, getByIndex } = await import('./storage.js');
    [allResources, taskResources] = await Promise.all([
      getAll('resources').then(r => r.filter(x => !x.deleted_at)),
      getByIndex('task_resources', 'task_id', taskId).then(r => r.filter(x => !x.deleted_at)),
    ]);
  } catch (e) { /* sin recursos */ }
  _taskDetailResources = taskResources;

  const constraintTypes = ['ASAP','ALAP','MSO','MFO','SNET','SNLT','FNET','FNLT'];
  const constraintLabels = { ASAP:'Lo antes posible', ALAP:'Lo más tarde posible',
    MSO:'Inicio no antes de', MFO:'Fin no antes de', SNET:'Inicio no antes de (SNET)',
    SNLT:'Inicio no después de', FNET:'Fin no antes de (FNET)', FNLT:'Fin no después de' };

  const resOpts = allResources.map(r =>
    `<option value="${r.id}">${_escHtml(r.name)}${r.role ? ' ('+_escHtml(r.role)+')' : ''}</option>`).join('');

  // Cálculo de costo estimado por recurso (inspirado en MS Project / P6)
  const _hpd = _calState?.hours_per_day ?? 8;
  const _taskDur = cpmTask?.dur ?? task.duration_days ?? 0;
  const _calcResCost = (units, res) => {
    if (!res || res.rate_per_hour == null) return null;
    const u = units ?? 100;
    if (res.type === 'work')     return (u / 100) * res.rate_per_hour * _taskDur * _hpd;
    if (res.type === 'cost')     return res.rate_per_hour;
    return u * res.rate_per_hour; // material, equipment: units × rate
  };
  const _fmtCost = v => v != null ? `S/ ${v.toLocaleString('es-PE', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—';

  let _totalResCost = 0;
  const resRows = taskResources.map(tr => {
    const res = allResources.find(r => r.id === tr.resource_id);
    const unitSuffix = res?.type === 'material' || res?.type === 'equipment'
      ? (res.unit_label ? ' ' + _escHtml(res.unit_label) : ' und')
      : ' %';
    const typeTag = { work: 'trabajo', material: 'material', equipment: 'equipo', cost: 'costo' };
    const cost = _calcResCost(tr.units, res);
    if (cost != null) _totalResCost += cost;
    return `<tr data-trid="${tr.id}">
      <td style="padding:4px 8px;font-size:12px">${_escHtml(res?.name ?? '—')}<br><span style="font-size:10px;color:var(--clr-text-3)">${typeTag[res?.type ?? 'work'] ?? ''}</span></td>
      <td style="padding:4px 8px;font-size:12px">${_escHtml(res?.role ?? '')}</td>
      <td style="padding:4px 8px;font-size:12px"><input type="number" class="tdp-res-units" data-trid="${tr.id}" value="${tr.units ?? 100}" min="1" max="100000" aria-label="Unidades asignadas" style="width:64px;padding:2px 6px;border:1px solid var(--clr-border);border-radius:4px;font-size:11px;background:var(--clr-surface);color:var(--clr-text)">${unitSuffix}</td>
      <td style="padding:4px 8px;font-size:11px;color:var(--clr-text-2);white-space:nowrap">${_fmtCost(cost)}</td>
      <td style="padding:4px 8px"><button class="btn btn-icon btn-sm tdp-res-remove" data-trid="${tr.id}" title="Quitar" aria-label="Quitar recurso" style="color:var(--clr-danger,#e74c3c);padding:0 6px">✕</button></td>
    </tr>`;
  }).join('');

  const body = document.getElementById('tdp-body');
  body.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:14px">

      <!-- Nombre -->
      <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Nombre
        <input id="tdp-name" type="text" value="${_escAttr(task.name)}" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:13px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
      </label>

      <!-- Tipo + Duración -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Tipo
          <select id="tdp-type" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text)">
            <option value="task" ${task.type==='task'?'selected':''}>Tarea</option>
            <option value="milestone" ${task.type==='milestone'?'selected':''}>Hito</option>
          </select>
        </label>
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Duración (días)
          <input id="tdp-dur" type="number" min="0" value="${task.duration_days ?? 0}" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
      </div>

      <!-- % Avance + Horas trabajo -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">% Avance
          <input id="tdp-pct" type="number" min="0" max="100" value="${task.percent_complete ?? 0}" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Horas trabajo
          <input id="tdp-hours" type="number" min="0" value="${task.work_hours ?? 0}" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
      </div>

      <!-- Fechas CPM (solo lectura) -->
      ${cpmTask ? `
      <div style="background:var(--clr-surface-2);border-radius:8px;padding:12px">
        <div style="font-size:11px;font-weight:700;color:var(--clr-text-3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">Fechas CPM</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;font-size:12px">
          <div><span style="color:var(--clr-text-3)">Inicio temprano:</span><br><strong>${addDays(cpmTask.es)}</strong></div>
          <div><span style="color:var(--clr-text-3)">Fin temprano:</span><br><strong>${addDays(cpmTask.ef)}</strong></div>
          <div><span style="color:var(--clr-text-3)">Inicio tardío:</span><br><strong>${addDays(cpmTask.ls)}</strong></div>
          <div><span style="color:var(--clr-text-3)">Fin tardío:</span><br><strong>${addDays(cpmTask.lf)}</strong></div>
          <div><span style="color:var(--clr-text-3)">Holgura total:</span><br><strong style="color:${(cpmTask.tf??0)===0?'var(--clr-danger,#e74c3c)':'var(--clr-text)'}">${cpmTask.tf ?? 0} d</strong></div>
          <div><span style="color:var(--clr-text-3)">Holgura libre:</span><br><strong>${cpmTask.ff ?? 0} d</strong></div>
        </div>
      </div>` : '<div style="font-size:12px;color:var(--clr-text-3)">CPM no calculado aún</div>'}

      <!-- Costos -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Costo planificado (S/)
          <input id="tdp-cost-plan" type="number" min="0" step="0.01" value="${task.planned_cost ?? 0}" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Costo real (S/)
          <input id="tdp-cost-real" type="number" min="0" step="0.01" value="${task.actual_cost ?? 0}" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
      </div>

      <!-- Restricción -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Restricción
          <select id="tdp-constraint" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:11px;background:var(--clr-surface-2);color:var(--clr-text)">
            ${constraintTypes.map(c => `<option value="${c}" ${task.constraint_type===c?'selected':''}>${constraintLabels[c]??c}</option>`).join('')}
          </select>
        </label>
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Fecha restricción
          <input id="tdp-constraint-date" type="date" value="${task.constraint_date ?? ''}" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
      </div>

      <!-- Fechas reales -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Inicio real
          <input id="tdp-actual-start" type="date" value="${task.actual_start ?? ''}" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
        <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Fin real
          <input id="tdp-actual-finish" type="date" value="${task.actual_finish ?? ''}" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
        </label>
      </div>

      <!-- Notas -->
      <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Notas
        <textarea id="tdp-notes" rows="3" style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text);resize:vertical;box-sizing:border-box;font-family:inherit">${_escHtml(task.notes ?? '')}</textarea>
      </label>

      <!-- Recursos asignados -->
      <div id="tdp-resources-section">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span style="font-size:12px;font-weight:700;color:var(--clr-text-2)">Recursos asignados</span>
          <button id="tdp-open-catalog" class="btn btn-ghost btn-sm" title="Gestionar catálogo global de recursos" aria-label="Gestionar catálogo global de recursos" style="font-size:11px;padding:3px 8px">📚 Catálogo</button>
        </div>
        <table id="tdp-res-table" style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:var(--clr-surface-2)">
              <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Recurso</th>
              <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Rol</th>
              <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Unidades</th>
              <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600" title="Costo estimado = Unidades × Tarifa × Duración">Costo est.</th>
              <th style="padding:4px 8px;width:32px"></th>
            </tr>
          </thead>
          <tbody id="tdp-res-body">${resRows || '<tr><td colspan="5" style="padding:8px;color:var(--clr-text-3);font-size:12px;text-align:center">Sin recursos asignados</td></tr>'}</tbody>
        </table>
        ${_totalResCost > 0 ? `
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:6px;padding:6px 8px;background:var(--clr-surface-2);border-radius:6px;font-size:12px">
          <span style="color:var(--clr-text-3)">Costo total recursos:</span>
          <span style="font-weight:700;color:var(--clr-text)">${_fmtCost(_totalResCost)}</span>
          <button id="tdp-use-res-cost" data-cost="${_totalResCost.toFixed(2)}" class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 8px" title="Copiar al campo Costo planificado" aria-label="Copiar al campo Costo planificado">↓ Usar como costo planificado</button>
        </div>` : ''}
        ${allResources.length ? `
        <div style="display:flex;gap:6px;margin-top:8px;align-items:center">
          <select id="tdp-res-select" style="flex:1;padding:6px 10px;border:1px solid var(--clr-border);border-radius:6px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text)">
            <option value="">— Seleccionar recurso —</option>
            ${resOpts}
          </select>
          <button id="tdp-res-add" class="btn btn-ghost btn-sm">＋ Asignar</button>
        </div>` : `
        <div style="margin-top:8px;font-size:12px;color:var(--clr-text-3)">
          No hay recursos definidos. <a href="#" id="tdp-open-resources" style="color:var(--clr-primary)">Gestionar recursos</a>
        </div>`}
      </div>

    </div>`;

  // Listeners para recursos — usar AbortController para limpiar en cada apertura
  if (_taskDetailPanel.__bodyAC) _taskDetailPanel.__bodyAC.abort();
  const _bodyAC = new AbortController();
  _taskDetailPanel.__bodyAC = _bodyAC;
  const _bSig = { signal: _bodyAC.signal };
  body.querySelector('#tdp-res-add')?.addEventListener('click', () => _tdpAddResource(taskId), _bSig);
  body.querySelector('#tdp-open-resources')?.addEventListener('click', (e) => { e.preventDefault(); _openResourceManager(); }, _bSig);
  body.querySelector('#tdp-open-catalog')?.addEventListener('click', () => _openResourceManager(), _bSig);
  body.querySelector('#tdp-use-res-cost')?.addEventListener('click', (e) => {
    const cost = /** @type {HTMLElement} */ (e.currentTarget).dataset.cost;
    const inp = /** @type {HTMLInputElement|null} */ (document.getElementById('tdp-cost-plan'));
    if (inp && cost) { inp.value = cost; _showToast('Costo planificado actualizado desde recursos', 'success'); }
  }, _bSig);
  body.addEventListener('click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).classList.contains('tdp-res-remove')) {
      const trid = /** @type {HTMLElement} */ (e.target).dataset.trid;
      /** @type {HTMLElement} */ (e.target).closest('tr')?.remove();
      _taskDetailPanel.dataset['removeRes'] = (_taskDetailPanel.dataset['removeRes'] || '') + trid + ',';
    }
  }, _bSig);

  _taskDetailTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  _taskDetailPanel.style.transform = 'translateX(0)';
  // Move focus into panel after transition
  setTimeout(() => {
    const first = _taskDetailPanel.querySelector('input, select, button');
    first?.focus();
  }, 240);
}

async function _tdpAddResource(taskId) {
  const sel = /** @type {HTMLSelectElement} */ (document.getElementById('tdp-res-select'));
  if (!sel?.value) return;
  const resId = sel.value;
  const { getAll } = await import('./storage.js');
  const allRes = await getAll('resources').then(r => r.filter(x => !x.deleted_at));
  const res = allRes.find(r => r.id === resId);
  if (!res) return;

  // Verificar que no esté ya asignado
  const tbody = document.getElementById('tdp-res-body');
  if (tbody?.querySelector(`tr[data-new-res="${resId}"]`) ||
      _taskDetailResources.some(tr => tr.resource_id === resId)) {
    _showToast('Este recurso ya está asignado a la actividad', 'warn'); return;
  }
  const trid = crypto.randomUUID();
  const tr = document.createElement('tr');
  tr.dataset.trid = trid;
  tr.dataset.newRes = resId;
  const newUnitSuffix = res.type === 'material' || res.type === 'equipment'
    ? (res.unit_label ? ' ' + res.unit_label : ' und') : ' %';
  const newTypeTag = { work: 'trabajo', material: 'material', equipment: 'equipo', cost: 'costo' };
  const _hpdNew = appState.state.calendar?.hours_per_day ?? 8;
  const _durNew = appState.state.tasks?.get(taskId)?.duration_days ?? 0;
  const _costNew = (() => {
    if (res.rate_per_hour == null) return null;
    if (res.type === 'work') return (100 / 100) * res.rate_per_hour * _durNew * _hpdNew;
    if (res.type === 'cost') return res.rate_per_hour;
    return 1 * res.rate_per_hour;
  })();
  const _fmtCostNew = v => v != null ? `S/ ${v.toLocaleString('es-PE', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—';
  tr.innerHTML = `
    <td style="padding:4px 8px;font-size:12px">${_escHtml(res.name)}<br><span style="font-size:10px;color:var(--clr-text-3)">${newTypeTag[res.type ?? 'work'] ?? ''}</span></td>
    <td style="padding:4px 8px;font-size:12px">${_escHtml(res.role ?? '')}</td>
    <td style="padding:4px 8px;font-size:12px"><input type="number" class="tdp-res-units" data-trid="${trid}" value="100" min="1" max="100000" aria-label="Unidades asignadas" style="width:64px;padding:2px 6px;border:1px solid var(--clr-border);border-radius:4px;font-size:11px;background:var(--clr-surface);color:var(--clr-text)">${_escHtml(newUnitSuffix)}</td>
    <td style="padding:4px 8px;font-size:11px;color:var(--clr-text-2);white-space:nowrap" class="tdp-cost-cell">${_fmtCostNew(_costNew)}</td>
    <td style="padding:4px 8px"><button class="btn btn-icon btn-sm tdp-res-remove" data-trid="${trid}" title="Quitar" aria-label="Quitar recurso" style="color:var(--clr-danger,#e74c3c);padding:0 6px">✕</button></td>`;
  if (tbody) {
    const empty = tbody.querySelector('td[colspan]');
    if (empty) empty.closest('tr')?.remove();
    tbody.appendChild(tr);
  }
  sel.value = '';
}

async function _saveTaskDetail() {
  const panel = _taskDetailPanel;
  if (!panel) return;
  const taskId = panel.dataset.taskId;
  if (!taskId) return;

  // Etapa 4: protección contra doble-clic
  const saveBtn = /** @type {HTMLButtonElement|null} */ (panel.querySelector('#tdp-save'));
  if (saveBtn?.disabled) return;
  if (saveBtn) saveBtn.disabled = true;

  try {
  const name   = /** @type {HTMLInputElement} */ (document.getElementById('tdp-name'))?.value?.trim();
  const type   = /** @type {HTMLSelectElement} */ (document.getElementById('tdp-type'))?.value;
  const dur    = parseInt(/** @type {HTMLInputElement} */ (document.getElementById('tdp-dur'))?.value ?? '0', 10);
  const pct    = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('tdp-pct'))?.value ?? '0');
  const hours  = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('tdp-hours'))?.value ?? '0');
  const costPlan = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('tdp-cost-plan'))?.value ?? '0');
  const costReal = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('tdp-cost-real'))?.value ?? '0');
  const constraint = /** @type {HTMLSelectElement} */ (document.getElementById('tdp-constraint'))?.value;
  const constraintDate = /** @type {HTMLInputElement} */ (document.getElementById('tdp-constraint-date'))?.value || null;
  const actualStart  = /** @type {HTMLInputElement} */ (document.getElementById('tdp-actual-start'))?.value || null;
  const actualFinish = /** @type {HTMLInputElement} */ (document.getElementById('tdp-actual-finish'))?.value || null;
  const notes  = /** @type {HTMLTextAreaElement} */ (document.getElementById('tdp-notes'))?.value || null;

  if (!name) { _showToast('El nombre no puede estar vacío', 'warn'); return; }

  appState.dispatch({ type: 'UPDATE_TASK', payload: { id: taskId, fields: {
    name, type, duration_days: isNaN(dur) ? 0 : dur,
    percent_complete: isNaN(pct) ? 0 : Math.min(100, Math.max(0, pct)),
    work_hours: isNaN(hours) ? 0 : hours,
    planned_cost: isNaN(costPlan) ? 0 : costPlan,
    actual_cost:  isNaN(costReal) ? 0 : costReal,
    constraint_type: constraint, constraint_date: constraintDate,
    actual_start: actualStart, actual_finish: actualFinish,
    notes,
  }}});

  // Persistir task_resources
  const proj = appState.state.project;
  if (proj) {
    const { getByIndex, put: dbPutSt, remove: dbRemoveSt } = await import('./storage.js');
    // Eliminar los marcados
    const toRemove = (panel.dataset['removeRes'] || '').split(',').filter(Boolean);
    await Promise.all(toRemove.map(trid => dbRemoveSt('task_resources', trid).catch(() => {})));
    panel.dataset['removeRes'] = '';

    // Agregar nuevos
    const newRows = document.querySelectorAll('#tdp-res-body tr[data-new-res]');
    const newRecs = [...newRows].map(row => {
      const r = /** @type {HTMLElement} */ (row);
      return {
        id: r.dataset.trid,
        project_id: proj.id,
        task_id: taskId,
        resource_id: r.dataset.newRes,
        units: parseFloat(/** @type {HTMLInputElement|null} */ (r.querySelector('.tdp-res-units'))?.value ?? '100') || 100,
        org_id: proj.org_id ?? null,
        deleted_at: null,
      };
    });
    await Promise.all(newRecs.map(rec => dbPutSt('task_resources', rec)));
    newRows.forEach(row => delete /** @type {HTMLElement} */ (row).dataset.newRes);

    // Actualizar unidades de los existentes (una sola consulta para todos)
    const unitInputs = document.querySelectorAll('#tdp-res-body .tdp-res-units:not([data-new-res])');
    if (unitInputs.length) {
      const existingAll = await getByIndex('task_resources', 'task_id', taskId).catch(() => []);
      await Promise.all([...unitInputs].map(inp => {
        const trid = /** @type {HTMLElement} */ (inp).dataset.trid;
        if (!trid) return;
        const rec = existingAll.find(x => x.id === trid);
        if (rec) { rec.units = parseFloat(/** @type {HTMLInputElement} */ (inp).value) || 100; return dbPutSt('task_resources', rec); }
      }).filter(Boolean));
    }
  }

  _showToast('Guardado', 'success');
  _closeTaskDetail();
  } finally {
    // Etapa 4: re-habilitar botón sea cual sea el resultado
    if (saveBtn) saveBtn.disabled = false;
  }
}

// ============================================================
// WBS helper — computa códigos EDT desde la jerarquía de tareas
// ============================================================

/** @param {Map<string,any>} tasks @returns {Map<string,string>} */
function _buildWbsMap(tasks) {
  if (!tasks?.size) return new Map();
  const byParent = /** @type {Map<string,any[]>} */ (new Map());
  for (const t of tasks.values()) {
    if (t.deleted_at) continue;
    const pid = t.parent_id ?? '__root__';
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(t);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const result = new Map();
  const walk = (parentId, prefix) => {
    (byParent.get(parentId) ?? []).forEach((t, i) => {
      const code = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      result.set(t.id, code);
      walk(t.id, code);
    });
  };
  walk('__root__', '');
  return result;
}

// ============================================================
// Gestor de Recursos (catálogo)
// ============================================================

async function _openResourceManager() {
  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-resources'));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-resources';
    dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:600px;max-width:96vw;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden;position:fixed;margin:0;top:80px;left:max(8px,calc(50vw - 300px));z-index:1000';
    document.body.appendChild(dlg);
    dlg.setAttribute('aria-labelledby', 'rm-dlg-title');
    dlg.setAttribute('aria-modal', 'true');
  }

  const { getAll } = await import('./storage.js');
  const [resources, allTaskRes] = await Promise.all([
    getAll('resources').then(r => r.filter(x => !x.deleted_at)),
    getAll('task_resources').then(r => r.filter(x => !x.deleted_at)).catch(() => []),
  ]);

  // Total units assigned per resource (for over-allocation indicator, P6 style)
  const _resUnitsMap = {};
  for (const tr of allTaskRes) {
    _resUnitsMap[tr.resource_id] = (_resUnitsMap[tr.resource_id] ?? 0) + (tr.units ?? 100);
  }
  // Count tasks per resource (for usage summary)
  const _resTaskCount = {};
  for (const tr of allTaskRes) {
    _resTaskCount[tr.resource_id] = (_resTaskCount[tr.resource_id] ?? 0) + 1;
  }

  const typeLabel = { work: 'Trabajo', material: 'Material', equipment: 'Equipo', cost: 'Costo fijo' };
  const typeBadgeColor = { work:'#1976D2', material:'#7B1FA2', equipment:'#E65100', cost:'#2E7D32' };
  const rows = resources.map(r => {
    const typ = r.type ?? 'work';
    const unitSuffix = typ === 'work' ? '/h' : (r.unit_label ? '/'+r.unit_label : '');
    const priceCell = r.rate_per_hour != null ? `S/ ${r.rate_per_hour}${unitSuffix}` : '—';
    const dispMax = typ === 'work' ? `${r.max_units ?? 100}%` : (r.unit_label ? r.unit_label : '—');
    // Over-allocation indicator (P6: red when assigned > max)
    const totalAssigned = _resUnitsMap[r.id] ?? 0;
    const maxU = r.max_units ?? 100;
    const taskCount = _resTaskCount[r.id] ?? 0;
    let overAllocCell = '';
    if (typ === 'work') {
      const isOver = totalAssigned > maxU;
      const color = isOver ? '#dc2626' : (totalAssigned > 0 ? '#16a34a' : 'var(--clr-text-3)');
      const icon = isOver ? '⚠️' : (totalAssigned > 0 ? '✓' : '');
      overAllocCell = `<span style="font-size:11px;color:${color}" title="${taskCount} actividad(es) asignadas, total ${totalAssigned}%${isOver?' — SOBREASIGNADO':''}">${icon} ${totalAssigned > 0 ? totalAssigned+'%' : '—'} <span style="font-size:10px;color:var(--clr-text-3)">(${taskCount})</span></span>`;
    } else {
      overAllocCell = `<span style="font-size:11px;color:var(--clr-text-3)">${taskCount > 0 ? taskCount+' act.' : '—'}</span>`;
    }
    return `<tr style="border-bottom:1px solid var(--clr-border)">
      <td style="padding:6px 10px;font-size:13px;font-weight:500">${_escHtml(r.name)}</td>
      <td style="padding:6px 10px"><span style="font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;color:#fff;background:${typeBadgeColor[typ]??'#607D8B'}">${typeLabel[typ]??typ}</span></td>
      <td style="padding:6px 10px;font-size:12px;color:var(--clr-text-3)">${_escHtml(r.role ?? '—')}</td>
      <td style="padding:6px 10px;font-size:12px;color:var(--clr-text-3)">${priceCell}</td>
      <td style="padding:6px 10px;font-size:12px;color:var(--clr-text-3)">${dispMax}</td>
      <td style="padding:6px 10px">${overAllocCell}</td>
      <td style="padding:5px 8px;white-space:nowrap">
        <button class="btn btn-sm rm-assign" data-rid="${r.id}" title="Asignar este recurso a actividades" aria-label="Asignar este recurso a actividades" style="font-size:11px;padding:3px 8px;background:#1976D2;color:#fff;border:none;border-radius:5px;cursor:pointer;margin-right:4px">▶ Asignar</button>
        <button class="btn btn-icon btn-sm rm-del" data-rid="${r.id}" title="Eliminar" aria-label="Eliminar recurso" style="color:var(--clr-danger,#e74c3c)">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--clr-text-3)">Sin recursos en el catálogo</td></tr>';

  // Build resource usage rows (P6: Resource Usage Sheet / MS Project: Resource Usage view)
  const _tasks = appState.state.tasks;
  const _wbsMap = _buildWbsMap(_tasks);
  const _usageRows = resources.map(r => {
    const assignments = allTaskRes.filter(tr => tr.resource_id === r.id);
    if (!assignments.length) return `
      <tr style="border-bottom:1px solid var(--clr-border)">
        <td style="padding:7px 10px;font-size:13px;font-weight:500">${_escHtml(r.name)}</td>
        <td style="padding:7px 10px;font-size:12px;color:var(--clr-text-3)" colspan="4">Sin asignaciones</td>
      </tr>`;
    const taskRows = assignments.map(tr => {
      const t = _tasks?.get(tr.task_id);
      const unitSufx = (r.type === 'material' || r.type === 'equipment') ? (r.unit_label ?? 'und') : '%';
      const cpm = appState.state.cpmResult?.tasks?.get(tr.task_id);
      const dur = t?.duration_days ?? cpm?.dur ?? '—';
      return `<tr style="background:var(--clr-surface-2)">
        <td style="padding:4px 10px 4px 28px;font-size:12px;color:var(--clr-text)">${_escHtml(t?.name ?? tr.task_id)}</td>
        <td style="padding:4px 10px;font-size:12px;color:var(--clr-text-2)">${tr.units ?? 100} ${_escHtml(unitSufx)}</td>
        <td style="padding:4px 10px;font-size:12px;color:var(--clr-text-3)">${dur !== '—' ? dur+' días' : '—'}</td>
        <td style="padding:4px 10px;font-size:12px;color:var(--clr-text-3)">${_escHtml(_wbsMap.get(tr.task_id) ?? '')}</td>
      </tr>`;
    }).join('');
    const totalU = assignments.reduce((s, tr) => s + (tr.units ?? 100), 0);
    const isOver = r.type === 'work' && totalU > (r.max_units ?? 100);
    return `
      <tr style="border-bottom:1px solid var(--clr-border);${isOver?'background:rgba(220,38,38,0.04)':''}">
        <td style="padding:7px 10px;font-size:13px;font-weight:600">${_escHtml(r.name)} ${isOver?'<span style="color:#dc2626;font-size:11px">⚠️ sobreasignado</span>':''}</td>
        <td style="padding:7px 10px;font-size:12px;color:var(--clr-text-3)">${assignments.length} actividad(es)</td>
        <td style="padding:7px 10px;font-size:12px;color:var(--clr-text-3)">${r.type === 'work' ? totalU + '% total' : ''}</td>
        <td style="padding:7px 10px"></td>
      </tr>${taskRows}`;
  }).join('') || '<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--clr-text-3)">Sin asignaciones en el proyecto</td></tr>';

  dlg.innerHTML = `
    <div id="dlg-res-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);cursor:move;user-select:none" title="Arrastrar para mover">
      <div style="flex:1;min-width:0">
        <div id="rm-dlg-title" style="font-weight:700;font-size:15px">Gestión de Recursos</div>
        <div style="font-size:11px;color:var(--clr-text-3);margin-top:2px">Catálogo, asignación y uso de recursos del proyecto</div>
        <div style="display:flex;gap:4px;margin-top:7px">
          <button id="rm-btn-import" class="btn btn-ghost btn-sm" title="Importar recursos desde archivo CSV" aria-label="Importar recursos CSV" style="font-size:11px;padding:3px 9px">⬆ Importar</button>
          <button id="rm-btn-export" class="btn btn-ghost btn-sm" title="Exportar catálogo de recursos a CSV" aria-label="Exportar recursos CSV" style="font-size:11px;padding:3px 9px">⬇ Exportar</button>
          <button id="rm-btn-print"  class="btn btn-ghost btn-sm" title="Imprimir catálogo de recursos" aria-label="Imprimir catálogo" style="font-size:11px;padding:3px 9px">🖨 Imprimir</button>
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:flex-start">
        <button id="btn-open-assign-dlg" class="btn btn-primary btn-sm" title="Asignar recursos a actividades (masivo)" aria-label="Asignar recursos a actividades" style="cursor:pointer">📌 Asignar Recursos</button>
        <button id="dlg-res-close" class="btn btn-icon btn-sm" style="cursor:default" aria-label="Cerrar gestión de recursos">✕</button>
      </div>
    </div>
    <!-- Tabs -->
    <div style="display:flex;gap:0;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2)">
      <button id="rm-tab-catalog" class="rm-tab" data-tab="catalog" style="padding:8px 18px;border:none;background:transparent;font-size:12px;font-weight:600;color:var(--clr-primary);border-bottom:2px solid var(--clr-primary);cursor:pointer">📋 Catálogo</button>
      <button id="rm-tab-usage" class="rm-tab" data-tab="usage" style="padding:8px 18px;border:none;background:transparent;font-size:12px;font-weight:600;color:var(--clr-text-3);border-bottom:2px solid transparent;cursor:pointer">📊 Uso de Recursos</button>
    </div>
    <!-- Tab: Catálogo -->
    <div id="rm-panel-catalog">
      <div style="padding:16px;max-height:42vh;overflow-y:auto">
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--clr-surface-2)">
            <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Nombre</th>
            <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Tipo</th>
            <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Rol</th>
            <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Precio/Ud.</th>
            <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600" title="Disponibilidad máxima (Trabajo) o Unidad de medida (Material/Equipo)">Unid./Disp.Máx</th>
            <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600" title="Total % asignado en el proyecto (⚠️ = sobreasignado)">Asignado</th>
            <th style="width:130px"></th>
          </tr></thead>
          <tbody id="rm-body">${rows}</tbody>
        </table>
      </div>
      <div style="padding:14px 16px;border-top:1px solid var(--clr-border);background:var(--clr-surface-2)">
        <div style="font-size:12px;font-weight:700;color:var(--clr-text-2);margin-bottom:10px">Agregar recurso al catálogo</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
          <input id="rm-name" type="text" placeholder="Nombre *" aria-label="Nombre del recurso (requerido)" style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
          <select id="rm-type" aria-label="Tipo de recurso" style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
            <option value="work">Trabajo (mano de obra)</option>
            <option value="material">Material</option>
            <option value="equipment">Equipo / Maquinaria</option>
            <option value="cost">Costo fijo</option>
          </select>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
          <input id="rm-role" type="text" placeholder="Rol / Especialidad" aria-label="Rol o especialidad del recurso" title="Ej: Ing. Civil, Operario, Albañil" style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
          <input id="rm-rate" type="number" min="0" step="0.01" placeholder="Precio/Unidad (S/)" aria-label="Precio por unidad (S/)" title="Tasa estándar. Para trabajo: S/h. Para material: S/unidad." style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
          <span id="rm-fields-extra" style="display:contents">
            <input id="rm-unit-label" type="text" placeholder="Unidad (m³, kg, und…)" aria-label="Unidad de medida" title="Unidad de medida — para material y equipo" style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
            <input id="rm-max-units" type="number" min="1" max="100000" step="1" placeholder="Disponib. máx (%)" aria-label="Disponibilidad máxima (%)" title="Disponibilidad máxima para recursos de trabajo (%). Ej: 100 = jornada completa, 50 = medio tiempo." style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text);display:none">
          </span>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button id="rm-add" class="btn btn-primary btn-sm">＋ Agregar al catálogo</button>
          <span id="rm-type-hint" style="font-size:11px;color:var(--clr-text-3)">Tipo Trabajo: define rol y disponibilidad máxima (%)</span>
        </div>
      </div>
    </div>
    <!-- Tab: Uso de Recursos -->
    <div id="rm-panel-usage" style="display:none;padding:16px;max-height:60vh;overflow-y:auto">
      <div style="font-size:11px;color:var(--clr-text-3);margin-bottom:10px">Vista de uso de recursos por actividad — similar a MS Project Resource Usage y P6 Resource Usage Sheet.</div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--clr-surface-2)">
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Recurso / Actividad</th>
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Unidades</th>
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Duración</th>
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">WBS</th>
        </tr></thead>
        <tbody>${_usageRows}</tbody>
      </table>
    </div>`;

  dlg.querySelector('#dlg-res-close').addEventListener('click', () => dlg.close());
  dlg.querySelector('#btn-open-assign-dlg').addEventListener('click', () => { dlg.close(); _openResourceAssign(); });

  // ---- Imprimir ----
  dlg.querySelector('#rm-btn-print')?.addEventListener('click', () => {
    const tbl = dlg.querySelector('#rm-panel-catalog table');
    _printToPdf('Catálogo de Recursos', `<h1>Catálogo de Recursos</h1>${tbl ? tbl.outerHTML : '<p>Sin datos</p>'}`);
  });

  // ---- Exportar CSV ----
  dlg.querySelector('#rm-btn-export')?.addEventListener('click', () => {
    const header = 'nombre,tipo,rol,precio,unidad,disponibilidad_max\n';
    const body = resources.map(r => [
      '"' + (r.name ?? '').replace(/"/g, '""') + '"',
      r.type ?? 'work',
      '"' + (r.role ?? '').replace(/"/g, '""') + '"',
      r.rate_per_hour ?? '',
      '"' + (r.unit_label ?? '').replace(/"/g, '""') + '"',
      r.max_units ?? '',
    ].join(',')).join('\n');
    const csv = '﻿' + header + body; // BOM for Excel UTF-8
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'recursos_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  });

  // ---- Importar CSV ----
  dlg.querySelector('#rm-btn-import')?.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.csv,text/csv';
    inp.addEventListener('change', async () => {
      const file = inp.files?.[0];
      if (!file) return;
      const text = await file.text();
      const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
      if (!lines.length) return;
      const start = lines[0].toLowerCase().startsWith('nombre') ? 1 : 0;
      const { put: dbPutRes } = await import('./storage.js');
      let count = 0;
      for (const line of lines.slice(start)) {
        const parts = line.split(',').map(p => p.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
        const [name, type, role, rateStr, unitLabel, maxStr] = parts;
        if (!name) continue;
        const typ = ['work', 'material', 'equipment', 'cost'].includes(type) ? type : 'work';
        await dbPutRes('resources', {
          id: crypto.randomUUID(), name, type: typ,
          role: role || null,
          rate_per_hour: rateStr ? (parseFloat(rateStr) || null) : null,
          unit_label: (typ === 'material' || typ === 'equipment') ? (unitLabel || null) : null,
          max_units: typ === 'work' ? (maxStr ? (parseFloat(maxStr) || 100) : 100) : null,
          org_id: null, deleted_at: null,
        });
        count++;
      }
      _showToast(`${count} recurso(s) importados correctamente`, 'success');
      dlg.close();
      _openResourceManager();
    });
    inp.click();
  });

  // ---- Tab switching ----
  dlg.querySelectorAll('.rm-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      dlg.querySelectorAll('.rm-tab').forEach(b => {
        const active = b.dataset.tab === tab;
        b.style.color = active ? 'var(--clr-primary)' : 'var(--clr-text-3)';
        b.style.borderBottom = active ? '2px solid var(--clr-primary)' : '2px solid transparent';
      });
      dlg.querySelector('#rm-panel-catalog').style.display = tab === 'catalog' ? '' : 'none';
      dlg.querySelector('#rm-panel-usage').style.display   = tab === 'usage'   ? '' : 'none';
    });
  });

  // ---- Mostrar/ocultar campos según tipo ----
  const _rmTypeChange = () => {
    const t = dlg.querySelector('#rm-type').value;
    const unitEl  = dlg.querySelector('#rm-unit-label');
    const maxEl   = dlg.querySelector('#rm-max-units');
    const roleEl  = dlg.querySelector('#rm-role');
    const hintEl  = dlg.querySelector('#rm-type-hint');
    const rateEl  = dlg.querySelector('#rm-rate');
    if (t === 'work') {
      unitEl.style.display = 'none';
      maxEl.style.display  = '';
      roleEl.placeholder   = 'Rol / Especialidad (Ej: Ing. Civil)';
      rateEl.placeholder   = 'Tasa estándar (S/h)';
      hintEl.textContent   = 'Tipo Trabajo: define rol y disponibilidad máxima (%)';
    } else if (t === 'material') {
      unitEl.style.display = '';
      maxEl.style.display  = 'none';
      roleEl.placeholder   = 'Proveedor / Marca (opcional)';
      rateEl.placeholder   = 'Precio/Unidad (S/)';
      hintEl.textContent   = 'Tipo Material: define unidad de medida (m³, kg, m², und…)';
    } else if (t === 'equipment') {
      unitEl.style.display = '';
      maxEl.style.display  = 'none';
      roleEl.placeholder   = 'Modelo / Marca (opcional)';
      rateEl.placeholder   = 'Tarifa (S/h o S/día)';
      hintEl.textContent   = 'Tipo Equipo: define unidad de alquiler (h, día, mes…)';
    } else {
      unitEl.style.display = 'none';
      maxEl.style.display  = 'none';
      roleEl.placeholder   = 'Categoría (opcional)';
      rateEl.placeholder   = 'Costo fijo (S/)';
      hintEl.textContent   = 'Tipo Costo fijo: monto total sin unidad de medida';
    }
  };
  dlg.querySelector('#rm-type').addEventListener('change', _rmTypeChange);
  _rmTypeChange(); // inicializar

  // ---- Drag-to-move ----
  { const hdr = dlg.querySelector('#dlg-res-hdr');
    let _ox = 0, _oy = 0, _drag = false;
    const onMove = e => {
      if (!_drag) return;
      dlg.style.left = Math.max(0, e.clientX - _ox) + 'px';
      dlg.style.top  = Math.max(0, e.clientY - _oy) + 'px';
    };
    const onUp = () => { _drag = false; hdr.style.cursor = 'move'; };
    hdr.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      const r = dlg.getBoundingClientRect();
      _ox = e.clientX - r.left; _oy = e.clientY - r.top;
      _drag = true; hdr.style.cursor = 'grabbing'; e.preventDefault();
    });
    if (dlg.__rmClean) dlg.__rmClean();
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    dlg.__rmClean = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    dlg.addEventListener('close', () => dlg.__rmClean?.(), { once: true });
  }
  dlg.querySelector('#rm-add').addEventListener('click', async () => {
    const name = /** @type {HTMLInputElement} */ (dlg.querySelector('#rm-name')).value.trim();
    if (!name) { _showToast('Nombre requerido', 'warn'); return; }
    const role       = /** @type {HTMLInputElement} */ (dlg.querySelector('#rm-role')).value.trim() || null;
    const rate       = parseFloat(/** @type {HTMLInputElement} */ (dlg.querySelector('#rm-rate')).value) || null;
    const type       = /** @type {HTMLSelectElement} */ (dlg.querySelector('#rm-type')).value;
    const unitLabel  = /** @type {HTMLInputElement} */ (dlg.querySelector('#rm-unit-label')).value.trim() || null;
    const maxUnitsRaw = /** @type {HTMLInputElement} */ (dlg.querySelector('#rm-max-units')).value;
    const maxUnits   = maxUnitsRaw ? parseFloat(maxUnitsRaw) : (type === 'work' ? 100 : null);
    const { put: dbPutSt } = await import('./storage.js');
    const rec = {
      id: crypto.randomUUID(), name, role, rate_per_hour: rate, type,
      unit_label: (type === 'material' || type === 'equipment') ? unitLabel : null,
      max_units:  type === 'work' ? (maxUnits ?? 100) : null,
      org_id: null, deleted_at: null,
    };
    await dbPutSt('resources', rec);
    _showToast('Recurso agregado al catálogo: ' + name, 'success');
    dlg.close();
    _openResourceManager(); // reabrir para mostrar la lista actualizada
  });
  dlg.addEventListener('click', async (e) => {
    const assignBtn = /** @type {HTMLElement} */ (e.target).closest('.rm-assign');
    if (assignBtn) { dlg.close(); _openResourceAssign(assignBtn.dataset.rid); return; }
    const btn = /** @type {HTMLElement} */ (e.target).closest('.rm-del');
    if (btn) {
      const rid = btn.dataset.rid;
      _confirmDialog('¿Eliminar este recurso? Esta acción no se puede deshacer.', async () => {
        const { remove: dbRemoveSt, getAll: dbGetAllSt } = await import('./storage.js');
        await dbRemoveSt('resources', rid);
        // Limpiar asignaciones huérfanas
        const taskRes = await dbGetAllSt('task_resources').catch(() => []);
        await Promise.all(taskRes.filter(tr => tr.resource_id === rid).map(tr => dbRemoveSt('task_resources', tr.id)));
        btn.closest('tr')?.remove();
        _showToast('Recurso eliminado', 'success');
      });
    }
  });

  if (!dlg.open) dlg.showModal();
}

// ============================================================
// Asignación masiva de recursos a actividades
// ============================================================

async function _openResourceAssign(preSelectedId = null) {
  const { getAll, getByIndex, put: dbPut, remove: dbRemove } = await import('./storage.js');
  const [resources, allTaskResRaw] = await Promise.all([
    getAll('resources').then(r => r.filter(x => !x.deleted_at)),
    getAll('task_resources').then(r => r.filter(x => !x.deleted_at)).catch(() => []),
  ]);
  if (!resources.length) {
    _showToast('Agrega recursos al catálogo primero', 'warn');
    _openResourceManager();
    return;
  }
  const tasks = [...(appState.state.tasks?.values() ?? [])].filter(t => !t.deleted_at && t.type !== 'milestone');
  if (!tasks.length) { _showToast('No hay actividades en el proyecto', 'warn'); return; }

  // Build lookup: existingAssign[rid][tid] = units (for current assignment badges)
  const existingAssign = {};
  for (const tr of allTaskResRaw) {
    if (!existingAssign[tr.resource_id]) existingAssign[tr.resource_id] = {};
    existingAssign[tr.resource_id][tr.task_id] = tr.units ?? 100;
  }

  let dlg = document.getElementById('dlg-res-assign');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-res-assign';
    dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:min(860px,98vw);max-width:98vw;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden;position:fixed;margin:0;top:60px;left:clamp(4px,calc(50vw - 430px),calc(100vw - min(860px,98vw) - 4px));z-index:1100';
    document.body.appendChild(dlg);
    dlg.setAttribute('aria-labelledby', 'ra-dlg-title');
    dlg.setAttribute('aria-modal', 'true');
  }

  const typeLabel = { work:'Trabajo', material:'Material', equipment:'Equipo', cost:'Costo' };
  const typeBadge = { work:'#1976D2', material:'#7B1FA2', equipment:'#E65100', cost:'#2E7D32' };

  const resItems = resources.map(r => {
    const assignedCount = Object.keys(existingAssign[r.id] ?? {}).length;
    return `<label class="ra-res-item" data-rid="${r.id}" style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;border-radius:6px;margin-bottom:2px;border:1px solid transparent">
      <input type="radio" name="ra-res" value="${r.id}" style="accent-color:#1976D2">
      <span style="flex:1;font-size:12px;font-weight:500">${_escHtml(r.name)}</span>
      ${assignedCount > 0 ? `<span style="font-size:10px;color:var(--clr-text-3)">${assignedCount}</span>` : ''}
      <span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;color:#fff;background:${typeBadge[r.type??'work']??'#607D8B'}">${typeLabel[r.type??'work']??r.type}</span>
    </label>`;
  }).join('');

  const _raWbsMap = _buildWbsMap(appState.state.tasks);
  const taskItems = tasks.map(t =>
    `<label class="ra-task-item" data-tid="${t.id}" style="display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;border-radius:5px;margin-bottom:1px">
      <input type="checkbox" class="ra-task-cb" value="${t.id}" style="accent-color:#1976D2">
      <span style="font-size:11px;color:var(--clr-text-3);min-width:32px">${_escHtml(_raWbsMap.get(t.id)??'')}</span>
      <span style="font-size:12px;flex:1">${_escHtml(t.name)}</span>
      <span class="ra-cur-badge" data-tid="${t.id}" style="display:none;font-size:10px;padding:1px 6px;border-radius:4px;background:#e0f2fe;color:#0369a1;white-space:nowrap"></span>
    </label>`).join('');

  dlg.innerHTML = `
    <div id="dlg-ra-hdr" data-drag-handle style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);cursor:move;user-select:none">
      <div>
        <div id="ra-dlg-title" style="font-weight:700;font-size:15px">📌 Asignar Recursos a Actividades</div>
        <div style="font-size:11px;color:var(--clr-text-3);margin-top:2px">Selecciona un recurso y las actividades. Puedes filtrar y seleccionar todo.</div>
      </div>
      <div style="display:flex;gap:4px;align-items:center">
        <button id="dlg-ra-print" class="btn btn-ghost btn-sm" aria-label="Imprimir" title="Imprimir">🖨 Imprimir</button>
        <button id="dlg-ra-close" class="btn btn-icon btn-sm" aria-label="Cerrar asignación de recursos">✕</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:260px 1fr;gap:0;height:420px;overflow:hidden">
      <!-- Panel izquierdo: Recursos -->
      <div style="border-right:1px solid var(--clr-border);display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:8px 10px;font-size:11px;font-weight:700;color:var(--clr-text-3);background:var(--clr-surface-2);border-bottom:1px solid var(--clr-border)">
          RECURSOS — elige uno
        </div>
        <div style="overflow-y:auto;padding:6px 8px;flex:1">${resItems}</div>
      </div>
      <!-- Panel derecho: Actividades -->
      <div style="display:flex;flex-direction:column;overflow:hidden">
        <div style="padding:8px 10px;background:var(--clr-surface-2);border-bottom:1px solid var(--clr-border);display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;font-weight:700;color:var(--clr-text-3)">ACTIVIDADES</span>
          <input id="ra-filter" type="text" placeholder="Filtrar por nombre…" aria-label="Filtrar actividades por nombre" style="flex:1;padding:4px 8px;border:1px solid var(--clr-border);border-radius:6px;font-size:11px;background:var(--clr-surface);color:var(--clr-text)">
          <label style="font-size:11px;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap">
            <input type="checkbox" id="ra-sel-all" style="accent-color:#1976D2"> Sel. todo
          </label>
          <span id="ra-count" style="font-size:11px;color:var(--clr-text-3);white-space:nowrap">0 sel.</span>
        </div>
        <div id="ra-task-list" style="overflow-y:auto;padding:6px 8px;flex:1">${taskItems}</div>
      </div>
    </div>
    <!-- Barra de acción -->
    <div style="padding:12px 16px;border-top:1px solid var(--clr-border);background:var(--clr-surface-2);display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <label style="font-size:12px;display:flex;align-items:center;gap:6px">
        Unidades/Disponib.:
        <input id="ra-units" type="number" min="1" max="100000" step="1" value="100" style="width:70px;padding:5px 8px;border:1px solid var(--clr-border);border-radius:6px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
        <span id="ra-unit-suffix" style="color:var(--clr-text-3);font-size:11px">%</span>
      </label>
      <button id="ra-btn-assign" class="btn btn-primary btn-sm" disabled>✓ Asignar a seleccionadas</button>
      <button id="ra-btn-remove" class="btn btn-secondary btn-sm" disabled>✕ Quitar de seleccionadas</button>
      <span style="flex:1"></span>
      <span id="ra-status" style="font-size:11px;color:var(--clr-text-3)"></span>
    </div>`;

  dlg.querySelector('#dlg-ra-close').addEventListener('click', () => dlg.close());
  dlg.querySelector('#dlg-ra-print')?.addEventListener('click', () => {
    const resChecked = dlg.querySelector('input[name="ra-res"]:checked');
    const resName = resChecked ? (resChecked.closest('label')?.textContent?.trim() ?? resChecked.value) : '—';
    const taskRows = [...dlg.querySelectorAll('.ra-task-cb')].map(cb => {
      const lbl = cb.closest('label');
      const name = lbl ? lbl.textContent.trim().replace(/^[\s​]+|[\s​]+$/g,'') : cb.value;
      return `<tr><td style="text-align:center;color:${cb.checked?'#1976d2':'#aaa'}">${cb.checked?'✓':'○'}</td><td>${_escHtml(name)}</td></tr>`;
    }).join('');
    const html = `<h1>Asignación de Recursos</h1><p style="margin:0 0 14px;font-size:13px;color:#555">Recurso seleccionado: <strong>${_escHtml(resName)}</strong></p>
      <table><thead><tr><th>Asignado</th><th>Actividad</th></tr></thead><tbody>${taskRows || '<tr><td colspan="2" style="text-align:center;color:#999">Sin actividades</td></tr>'}</tbody></table>`;
    _printToPdf('Asignación de Recursos', html);
  });

  _makeDraggable(dlg, '[data-drag-handle]');

  const _getSelectedRes = () => dlg.querySelector('input[name="ra-res"]:checked')?.value ?? null;
  const _getSelectedTasks = () => [...dlg.querySelectorAll('.ra-task-cb:checked')].map(cb => cb.value);
  const _updateCount = () => {
    const n = _getSelectedTasks().length;
    dlg.querySelector('#ra-count').textContent = n + ' sel.';
    const hasRes = !!_getSelectedRes();
    dlg.querySelector('#ra-btn-assign').disabled = !(hasRes && n > 0);
    dlg.querySelector('#ra-btn-remove').disabled = !(hasRes && n > 0);
  };

  // Update assignment badges for a given resource
  const _updateBadges = (rid) => {
    const assignments = rid ? (existingAssign[rid] ?? {}) : {};
    dlg.querySelectorAll('.ra-cur-badge').forEach(badge => {
      const tid = badge.dataset.tid;
      if (tid && assignments[tid] != null) {
        badge.textContent = 'ya: ' + assignments[tid] + (resources.find(r=>r.id===rid)?.type==='work' ? '%' : '');
        badge.style.display = '';
      } else {
        badge.style.display = 'none';
      }
    });
  };

  // Resaltar recurso seleccionado
  dlg.querySelectorAll('input[name="ra-res"]').forEach(rb => {
    rb.addEventListener('change', () => {
      dlg.querySelectorAll('.ra-res-item').forEach(el => el.style.background = '');
      const sel = dlg.querySelector('input[name="ra-res"]:checked');
      if (sel) sel.closest('.ra-res-item').style.background = 'rgba(25,118,210,0.08)';
      const res = resources.find(r => r.id === sel?.value);
      dlg.querySelector('#ra-unit-suffix').textContent =
        res?.type === 'work' ? '%' : (res?.unit_label ?? 'und');
      _updateBadges(sel?.value ?? null);
      _updateCount();
    });
  });

  // Pre-seleccionar recurso si se abrió desde el botón "Asignar" de una fila
  if (preSelectedId) {
    const rb = /** @type {HTMLInputElement|null} */ (dlg.querySelector(`input[name="ra-res"][value="${preSelectedId}"]`));
    if (rb) {
      rb.checked = true;
      rb.dispatchEvent(new Event('change'));
      rb.closest('.ra-res-item')?.scrollIntoView({ block: 'nearest' });
    }
  }

  // Filtro de actividades
  dlg.querySelector('#ra-filter').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    dlg.querySelectorAll('.ra-task-item').forEach(el => {
      el.style.display = el.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  // Seleccionar todo (solo los visibles)
  dlg.querySelector('#ra-sel-all').addEventListener('change', e => {
    dlg.querySelectorAll('.ra-task-item').forEach(el => {
      if (el.style.display !== 'none') {
        el.querySelector('.ra-task-cb').checked = e.target.checked;
      }
    });
    _updateCount();
  });

  dlg.querySelector('#ra-task-list').addEventListener('change', e => {
    if (e.target.classList.contains('ra-task-cb')) _updateCount();
  });

  // Asignar
  dlg.querySelector('#ra-btn-assign').addEventListener('click', async () => {
    const rid = _getSelectedRes();
    const tids = _getSelectedTasks();
    if (!rid || !tids.length) return;
    const units = parseFloat(dlg.querySelector('#ra-units').value) || 100;
    const statusEl = dlg.querySelector('#ra-status');
    statusEl.textContent = 'Asignando…';
    await Promise.all(tids.map(async tid => {
      const existing = await getByIndex('task_resources', 'task_id', tid)
        .then(r => r.find(x => !x.deleted_at && x.resource_id === rid)).catch(() => null);
      if (existing) { existing.units = units; await dbPut('task_resources', existing); }
      else await dbPut('task_resources', { id: crypto.randomUUID(), task_id: tid, resource_id: rid, units, deleted_at: null });
    }));
    const count = tids.length;
    statusEl.textContent = `✓ ${count} actividades asignadas`;
    _showToast(`Recurso asignado a ${count} actividades`, 'success');
  });

  // Quitar asignaciones
  dlg.querySelector('#ra-btn-remove').addEventListener('click', async () => {
    const rid = _getSelectedRes();
    const tids = _getSelectedTasks();
    if (!rid || !tids.length) return;
    const statusEl = dlg.querySelector('#ra-status');
    statusEl.textContent = 'Quitando…';
    const removals = await Promise.all(tids.map(async tid => {
      const existing = await getByIndex('task_resources', 'task_id', tid)
        .then(r => r.find(x => !x.deleted_at && x.resource_id === rid)).catch(() => null);
      if (existing) { await dbRemove('task_resources', existing.id); return true; }
      return false;
    }));
    const count = removals.filter(Boolean).length;
    statusEl.textContent = count ? `✓ Quitado de ${count} actividades` : 'Sin asignación previa';
    if (count) _showToast(`Recurso quitado de ${count} actividades`, 'success');
  });

  if (!dlg.open) dlg.showModal();
}

// ============================================================
// Editor de Calendario del proyecto
// ============================================================

async function _openCalendarEditor() {
  const proj = appState.state.project;
  if (!proj) { _showToast('No hay proyecto activo', 'warn'); return; }

  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-calendar'));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-calendar';
    dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:600px;max-width:96vw;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'dlg-cal-title');
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  }

  const cal    = appState.state.calendar;
  const calEx  = (appState.state.calExceptions ?? []).filter(e => !e.deleted_at);
  const ww     = cal?.work_week ?? [1, 2, 3, 4, 5];
  const hpd    = cal?.hours_per_day ?? 8;

  const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const dayCbs   = dayNames.map((n, i) =>
    `<label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;padding:4px 8px;border:1px solid var(--clr-border);border-radius:6px;background:${ww.includes(i)?'rgba(25,118,210,0.08)':''}">
      <input type="checkbox" class="cal-day-cb" value="${i}" ${ww.includes(i) ? 'checked' : ''} style="accent-color:var(--clr-primary)">
      ${n}
    </label>`).join('');

  const exRows = calEx.map(ex =>
    `<tr data-exid="${_escAttr(ex.id)}">
      <td style="padding:4px 8px;font-size:12px">${_escHtml(ex.on_date)}</td>
      <td style="padding:4px 8px;font-size:12px">${_escHtml(ex.name || '—')}</td>
      <td style="padding:4px 8px;font-size:12px">${ex.is_working ? 'Laborable' : 'No laborable'}</td>
      <td style="padding:4px 8px"><button class="btn btn-icon btn-sm cal-del-ex" data-exid="${_escAttr(ex.id)}" title="Eliminar excepción" aria-label="Eliminar excepción" style="color:var(--clr-danger,#e74c3c);padding:0 6px">✕</button></td>
    </tr>`).join('') || '<tr id="cal-ex-empty"><td colspan="4" style="padding:8px;text-align:center;color:var(--clr-text-3);font-size:12px">Sin excepciones registradas</td></tr>';

  dlg.innerHTML = `
    <div data-drag-handle style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);cursor:move">
      <span id="dlg-cal-title" style="font-weight:700;font-size:15px">🗓 Calendario del proyecto</span>
      <div style="display:flex;gap:4px;align-items:center">
        <button id="dlg-cal-print" class="btn btn-ghost btn-sm" aria-label="Imprimir calendario" title="Imprimir">🖨 Imprimir</button>
        <button id="dlg-cal-close" class="btn btn-icon btn-sm" aria-label="Cerrar calendario">✕</button>
      </div>
    </div>
    <div style="padding:16px;display:flex;flex-direction:column;gap:14px;max-height:68vh;overflow-y:auto">
      <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Nombre del calendario
        <input id="cal-name" type="text" value="${_escAttr(cal?.name ?? 'Calendario del proyecto')}"
          style="margin-top:4px;width:100%;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:13px;background:var(--clr-surface-2);color:var(--clr-text);box-sizing:border-box">
      </label>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--clr-text-2);margin-bottom:8px">Días laborables</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${dayCbs}</div>
      </div>
      <label style="font-size:12px;font-weight:600;color:var(--clr-text-2)">Horas por día laborable
        <input id="cal-hours" type="number" min="1" max="24" value="${hpd}"
          style="margin-top:4px;width:100px;padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:13px;background:var(--clr-surface-2);color:var(--clr-text)">
      </label>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--clr-text-2);margin-bottom:8px">Excepciones (festivos / días especiales)</div>
        <table style="width:100%;border-collapse:collapse">
          <thead><tr style="background:var(--clr-surface-2)">
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Fecha</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Descripción</th>
            <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Tipo</th>
            <th style="width:36px"></th>
          </tr></thead>
          <tbody id="cal-ex-body">${exRows}</tbody>
        </table>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap">
          <input id="cal-ex-date" type="date" aria-label="Fecha de excepción" style="padding:6px 10px;border:1px solid var(--clr-border);border-radius:6px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text)">
          <input id="cal-ex-name" type="text" aria-label="Descripción de excepción" placeholder="Descripción (ej: Año Nuevo)" style="flex:1;min-width:120px;padding:6px 10px;border:1px solid var(--clr-border);border-radius:6px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text)">
          <select id="cal-ex-type" aria-label="Tipo de excepción" style="padding:6px 10px;border:1px solid var(--clr-border);border-radius:6px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text)">
            <option value="false">No laborable</option>
            <option value="true">Laborable</option>
          </select>
          <button id="cal-add-ex" class="btn btn-ghost btn-sm">＋ Agregar</button>
        </div>
      </div>
    </div>
    <div style="padding:12px 16px;border-top:1px solid var(--clr-border);background:var(--clr-surface-2);display:flex;gap:8px;justify-content:flex-end">
      <button id="dlg-cal-cancel" class="btn btn-ghost btn-sm">Cancelar</button>
      <button id="dlg-cal-save" class="btn btn-primary btn-sm">Guardar calendario</button>
    </div>`;

  const body       = /** @type {HTMLElement} */ (dlg.querySelector('#cal-ex-body'));
  const _newExIds  = new Set(); // IDs de excepciones nuevas (no guardadas aún)
  const _delExIds  = new Set(); // IDs de excepciones existentes a borrar

  dlg.querySelector('#dlg-cal-close')?.addEventListener('click', () => dlg.close());
  dlg.querySelector('#dlg-cal-cancel')?.addEventListener('click', () => dlg.close());
  dlg.querySelector('#dlg-cal-print')?.addEventListener('click', () => {
    const nameVal = /** @type {HTMLInputElement} */ (dlg.querySelector('#cal-name'))?.value || 'Calendario';
    const dayNames2 = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    const checkedDays = [.../** @type {NodeListOf<HTMLInputElement>} */ (dlg.querySelectorAll('.cal-day-cb:checked'))].map(cb => dayNames2[parseInt(cb.value)]).join(', ');
    const hoursVal = /** @type {HTMLInputElement} */ (dlg.querySelector('#cal-hours'))?.value || '8';
    const exTrs = [.../** @type {NodeListOf<HTMLElement>} */ (dlg.querySelectorAll('#cal-ex-body tr'))].filter(tr => !tr.id);
    const exHtml = exTrs.map(tr => {
      const tds = tr.querySelectorAll('td');
      return `<tr style="border-bottom:1px solid #eee">
        <td style="padding:6px 10px">${tds[0]?.textContent||''}</td>
        <td style="padding:6px 10px">${tds[1]?.textContent||''}</td>
        <td style="padding:6px 10px">${tds[2]?.textContent||''}</td>
      </tr>`;
    }).join('');
    const html = `
      <h1 style="font-size:18px;margin-bottom:12px">Calendario del proyecto</h1>
      <table style="margin-bottom:20px;font-size:13px;border-collapse:collapse">
        <tr><td style="padding:5px 16px 5px 0;font-weight:600;color:#555">Nombre:</td><td style="padding:5px 0">${nameVal}</td></tr>
        <tr><td style="padding:5px 16px 5px 0;font-weight:600;color:#555">Días laborables:</td><td style="padding:5px 0">${checkedDays}</td></tr>
        <tr><td style="padding:5px 16px 5px 0;font-weight:600;color:#555">Horas por día:</td><td style="padding:5px 0">${hoursVal} h</td></tr>
      </table>
      <h2 style="font-size:15px;margin-bottom:10px">Excepciones (festivos / días especiales)</h2>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:#f5f5f5">
          <th style="padding:7px 10px;text-align:left;border-bottom:2px solid #ddd">Fecha</th>
          <th style="padding:7px 10px;text-align:left;border-bottom:2px solid #ddd">Descripción</th>
          <th style="padding:7px 10px;text-align:left;border-bottom:2px solid #ddd">Tipo</th>
        </tr></thead>
        <tbody>${exHtml || '<tr><td colspan="3" style="padding:8px 10px;color:#999;text-align:center">Sin excepciones registradas</td></tr>'}</tbody>
      </table>`;
    _printToPdf('Calendario del proyecto', html);
  });
  _makeDraggable(dlg, '[data-drag-handle]');

  // Eliminar excepción del listado
  body.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('.cal-del-ex');
    if (!btn) return;
    const exid = /** @type {HTMLElement} */ (btn).dataset.exid;
    if (_newExIds.has(exid)) {
      _newExIds.delete(exid);
    } else {
      _delExIds.add(exid);
    }
    /** @type {HTMLElement} */ (btn).closest('tr')?.remove();
    if (!body.querySelector('tr')) {
      body.innerHTML = '<tr id="cal-ex-empty"><td colspan="4" style="padding:8px;text-align:center;color:var(--clr-text-3);font-size:12px">Sin excepciones registradas</td></tr>';
    }
  });

  // Agregar excepción al listado
  dlg.querySelector('#cal-add-ex')?.addEventListener('click', () => {
    const dateEl = /** @type {HTMLInputElement} */ (dlg.querySelector('#cal-ex-date'));
    const nameEl = /** @type {HTMLInputElement} */ (dlg.querySelector('#cal-ex-name'));
    const typeEl = /** @type {HTMLSelectElement} */ (dlg.querySelector('#cal-ex-type'));
    const date   = dateEl.value;
    if (!date) { _showToast('Selecciona una fecha', 'warn'); return; }
    const name      = nameEl.value.trim() || null;
    const isWorking = typeEl.value === 'true';
    const newId     = crypto.randomUUID();
    _newExIds.add(newId);

    const emptyRow = body.querySelector('#cal-ex-empty');
    if (emptyRow) emptyRow.remove();
    const tr = document.createElement('tr');
    tr.dataset.exid      = newId;
    tr.dataset.date      = date;
    tr.dataset.name      = name ?? '';
    tr.dataset.isWorking = String(isWorking);
    tr.innerHTML = `
      <td style="padding:4px 8px;font-size:12px">${date}</td>
      <td style="padding:4px 8px;font-size:12px">${_escHtml(name || '—')}</td>
      <td style="padding:4px 8px;font-size:12px">${isWorking ? 'Laborable' : 'No laborable'}</td>
      <td style="padding:4px 8px"><button class="btn btn-icon btn-sm cal-del-ex" data-exid="${newId}" title="Eliminar excepción" aria-label="Eliminar excepción" style="color:var(--clr-danger,#e74c3c);padding:0 6px">✕</button></td>`;
    body.appendChild(tr);
    dateEl.value = '';
    nameEl.value = '';
  });

  // Guardar cambios
  dlg.querySelector('#dlg-cal-save')?.addEventListener('click', async () => {
    const nameVal  = /** @type {HTMLInputElement} */ (dlg.querySelector('#cal-name'))?.value.trim() || 'Calendario';
    const hours    = parseFloat(/** @type {HTMLInputElement} */ (dlg.querySelector('#cal-hours'))?.value ?? '8') || 8;
    const workDays = [.../** @type {NodeListOf<HTMLInputElement>} */ (dlg.querySelectorAll('.cal-day-cb:checked'))].map(cb => parseInt(cb.value));
    if (!workDays.length) { _showToast('Selecciona al menos un día laborable', 'warn'); return; }

    const now    = new Date().toISOString();
    const orgId  = proj.org_id ?? null;
    const isNew  = !cal?.id;
    const calId  = cal?.id ?? crypto.randomUUID();

    const updatedCal = {
      id: calId, org_id: orgId, project_id: proj.id,
      name: nameVal, work_week: workDays, hours_per_day: hours,
      created_at: cal?.created_at ?? now, updated_at: now, deleted_at: null,
    };

    const { put: dbPutSt } = await import('./storage.js');

    // Guardar calendario
    await dbPutSt('calendars', updatedCal);
    if (!IS_LOCAL_MODE) {
      await outboxAdd({ id: crypto.randomUUID(), tabla: 'calendars', fila: calId,
        tipo: isNew ? 'INSERT' : 'UPDATE', campos: updatedCal, baseUpdatedAt: cal?.updated_at ?? null });
    }

    // Eliminar excepciones marcadas
    let updatedCalExceptions = [...(appState.state.calExceptions ?? [])];
    for (const exid of _delExIds) {
      const ex = updatedCalExceptions.find(e => e.id === exid);
      if (ex) {
        const del = { ...ex, deleted_at: now };
        await dbPutSt('calendar_exceptions', del);
        if (!IS_LOCAL_MODE) {
          await outboxAdd({ id: crypto.randomUUID(), tabla: 'calendar_exceptions', fila: exid,
            tipo: 'DELETE', campos: del, baseUpdatedAt: ex.updated_at ?? null });
        }
        updatedCalExceptions = updatedCalExceptions.map(e => e.id === exid ? del : e);
      }
    }

    // Agregar excepciones nuevas
    const newExceptions = [];
    for (const exid of _newExIds) {
      const tr = /** @type {HTMLElement|null} */ (body.querySelector(`tr[data-exid="${exid}"]`));
      if (!tr) continue;
      const newEx = {
        id: exid, org_id: orgId, calendar_id: calId,
        on_date: tr.dataset.date ?? '', is_working: tr.dataset.isWorking === 'true',
        name: tr.dataset.name || null,
        created_at: now, updated_at: now, deleted_at: null,
      };
      await dbPutSt('calendar_exceptions', newEx);
      newExceptions.push(newEx);
      if (!IS_LOCAL_MODE) {
        await outboxAdd({ id: crypto.randomUUID(), tabla: 'calendar_exceptions', fila: exid,
          tipo: 'INSERT', campos: newEx, baseUpdatedAt: null });
      }
    }

    // Actualizar estado en memoria — deshabilitar auto-calc temporalmente para
    // evitar doble ejecución CPM (una por dispatch y otra por _applyRemote)
    const finalExceptions = [...updatedCalExceptions.filter(e => !e.deleted_at), ...newExceptions];
    const _prevAutoCalc = appState.state.autoCalc;
    appState.setAutoCalc(false);
    if (!proj.calendar_id || proj.calendar_id !== calId) {
      appState.dispatch({ type: 'UPDATE_PROJECT', payload: { fields: { calendar_id: calId } } });
    }
    appState._applyRemote({ calendar: updatedCal, calExceptions: finalExceptions });
    appState.setAutoCalc(_prevAutoCalc); // dispara CPM una sola vez si autoCalc estaba activo

    _showToast('Calendario guardado', 'success');
    dlg.close();
  });

  dlg.showModal();
}

async function _openCalendarManager() {
  const proj = appState.state.project;
  if (!proj) { _showToast('No hay proyecto activo', 'warn'); return; }

  const { getAll: _getAllSt, put: _putSt, remove: _removeSt } = await import('./storage.js');

  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-cal-manager'));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-cal-manager';
    dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:640px;max-width:96vw;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  }

  async function _refreshCalList() {
    const allCals = (await _getAllSt('calendars')).filter(c => !c.deleted_at && (c.org_id === proj.org_id || c.project_id === proj.id));
    const listBody = dlg.querySelector('#cal-mgr-list');
    if (!listBody) return;
    if (!allCals.length) {
      listBody.innerHTML = '<p style="color:var(--clr-text-3);font-size:13px;padding:12px 0">Sin calendarios. Crea uno nuevo.</p>';
      return;
    }
    listBody.innerHTML = allCals.map(c => {
      const isActive = c.id === proj.calendar_id;
      return `<div class="cal-mgr-row" style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid var(--clr-border-2);${isActive?'background:var(--clr-primary-subtle,#eef2ff);border-radius:4px;':''}">
        <span style="flex:1;font-size:13px;color:var(--clr-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escHtml(c.name)}${isActive?' <span style="font-size:10px;color:var(--clr-primary)">▶ activo</span>':''}</span>
        <span style="font-size:11px;color:var(--clr-text-3);white-space:nowrap">${(c.work_week||[1,2,3,4,5]).length} días/sem · ${c.hours_per_day||8}h</span>
        ${!isActive?`<button class="btn btn-ghost btn-sm" data-cal-use="${_escAttr(c.id)}" title="Usar este calendario para el proyecto" style="font-size:12px;padding:0 6px">📌</button>`:''}
        <button class="btn btn-ghost btn-sm" data-cal-edit="${_escAttr(c.id)}" title="Editar" style="font-size:13px;padding:0 5px">✏</button>
        ${!isActive?`<button class="btn btn-ghost btn-sm" data-cal-del="${_escAttr(c.id)}" title="Eliminar" style="font-size:13px;padding:0 5px">🗑</button>`:''}
      </div>`;
    }).join('');

    listBody.querySelectorAll('[data-cal-use]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const cid = /** @type {HTMLElement} */ (btn).dataset.calUse;
        appState.dispatch({ type: 'UPDATE_PROJECT', payload: { fields: { calendar_id: cid } } });
        _showToast('Calendario actualizado', 'success');
        await _refreshCalList();
      });
    });

    listBody.querySelectorAll('[data-cal-edit]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const cid = /** @type {HTMLElement} */ (btn).dataset.calEdit;
        // Set project calendar_id temporarily to the selected one, open editor, then restore if needed
        const prevCalId = proj.calendar_id;
        if (cid !== prevCalId) {
          appState.dispatch({ type: 'UPDATE_PROJECT', payload: { fields: { calendar_id: cid } } });
        }
        dlg.close();
        await _openCalendarEditor();
      });
    });

    listBody.querySelectorAll('[data-cal-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const cid = /** @type {HTMLElement} */ (btn).dataset.calDel;
        if (!confirm('¿Eliminar este calendario?')) return;
        await _removeSt('calendars', cid);
        _showToast('Calendario eliminado', 'success');
        await _refreshCalList();
      });
    });
  }

  dlg.innerHTML = `
    <div data-drag-handle style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);cursor:move;flex-shrink:0">
      <span style="font-size:20px">🗓</span>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:700;color:var(--clr-text)">Gestión de Calendarios</div>
        <div style="font-size:11px;color:var(--clr-text-3)">Agregar, editar o eliminar calendarios del proyecto</div>
      </div>
      <button id="cal-mgr-new" class="btn btn-primary btn-sm">+ Nuevo</button>
      <button id="cal-mgr-print" class="btn btn-ghost btn-sm" title="Imprimir calendarios" style="font-size:14px;padding:0 6px">🖨</button>
      <button id="cal-mgr-close" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">✕</button>
    </div>
    <div id="cal-mgr-list" style="padding:12px 18px;min-height:80px;max-height:60vh;overflow-y:auto"></div>`;

  _makeDraggable(dlg, '[data-drag-handle]');
  dlg.querySelector('#cal-mgr-close')?.addEventListener('click', () => dlg.close());
  dlg.querySelector('#cal-mgr-print')?.addEventListener('click', async () => {
    const allCals = (await _getAllSt('calendars')).filter(c => !c.deleted_at && (c.org_id === proj.org_id || c.project_id === proj.id));
    const DAYS = ['','Lun','Mar','Mié','Jue','Vie','Sáb','Dom'];
    const rows = allCals.map(c => {
      const dias = (c.work_week || [1,2,3,4,5]).map(d => DAYS[d] || d).join(', ');
      const active = c.id === proj.calendar_id ? '<span style="color:#1976d2;font-weight:700"> ▶ activo</span>' : '';
      const excs = (c.exceptions || []).length;
      return `<tr>
        <td style="font-weight:${c.id===proj.calendar_id?'700':'400'}">${_escHtml(c.name)}${active}</td>
        <td>${dias}</td>
        <td style="text-align:center">${c.hours_per_day || 8}h</td>
        <td style="text-align:center">${(c.work_week||[1,2,3,4,5]).length} días/sem</td>
        <td style="text-align:center">${excs}</td>
      </tr>`;
    }).join('');
    const html = `<h1 style="color:#1976d2;font-size:16px;margin-bottom:12px">Gestión de Calendarios</h1>
<p style="font-size:11px;color:#64748b;margin-bottom:14px">Proyecto: <strong>${_escHtml(proj.name)}</strong></p>
<table style="border-collapse:collapse;width:100%;font-size:12px">
  <thead><tr>
    <th style="background:#1976d2;color:#fff;padding:7px 10px;text-align:left">Nombre</th>
    <th style="background:#1976d2;color:#fff;padding:7px 10px;text-align:left">Días laborables</th>
    <th style="background:#1976d2;color:#fff;padding:7px 10px;text-align:center">Horas/día</th>
    <th style="background:#1976d2;color:#fff;padding:7px 10px;text-align:center">Días/sem</th>
    <th style="background:#1976d2;color:#fff;padding:7px 10px;text-align:center">Excepciones</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
    _printToPdf('Calendarios', html);
  });
  dlg.querySelector('#cal-mgr-new')?.addEventListener('click', async () => {
    dlg.close();
    // Create a new calendar by clearing calendar_id so editor creates a new one
    const tempProj = appState.state.project;
    if (tempProj) appState.dispatch({ type: 'UPDATE_PROJECT', payload: { fields: { calendar_id: null } } });
    await _openCalendarEditor();
  });

  await _refreshCalList();
  dlg.showModal();
}

function _updateStatus() {
  const dot  = document.querySelector('#statusbar .status-dot');
  const text = document.querySelector('#statusbar .status-text');
  const { syncStatus, cpmResult } = appState.state;
  if (dot) { dot.className = 'status-dot ' + syncStatus; }
  if (text) {
    const labels = {
      local:    t('localMode'),
      synced:   t('synced'),
      syncing:  t('syncing'),
      offline:  t('offline'),
      conflict: t('conflict') ?? 'Conflicto',
    };
    text.textContent = labels[syncStatus] ?? syncStatus;
  }
  // Duración del proyecto
  const durEl = document.getElementById('project-duration');
  if (durEl && cpmResult) {
    durEl.textContent = `${cpmResult.projectDuration ?? 0} d`;
  }
  // Badge de notificaciones
  updateNotificationBadge('notif-badge', 'btn-notifications');
}

function _updateUndoRedoBtns() {
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) undoBtn.disabled = !appState.canUndo;
  if (redoBtn) redoBtn.disabled = !appState.canRedo;
}

// ============================================================
// Cargar proyecto
// ============================================================

async function _ensureDemoData() {
  // Proyecto DEMO completo con fechas al día (ver demo-seed.js)
  return ensureDemoData();
}

async function _loadProject(projectId) {
  // Parar el engine anterior para que no sobreescriba la vista del nuevo proyecto
  if (_syncEngine) {
    _syncEngine.stop();
    _syncEngine = null;
  }

  const data = await loadProject(projectId);
  if (!data.project) throw new Error(t('projectNotFound'));
  appState.loadProject(data);
  _ganttFitPending = true;
  // Solo guardar en localStorage IDs con formato UUID (no IDs cortos del org chart como prj-09)
  const _isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId);
  if (_isUUID) { try { localStorage.setItem('last-project-id', projectId); } catch { /* ignore */ } }
  history.replaceState(null, '', location.pathname + '?p=' + encodeURIComponent(projectId));
  _renderProjectList();

  // Mostrar barra de filtros al tener proyecto cargado
  const filterBar = document.getElementById('gantt-filter-bar');
  if (filterBar) filterBar.style.display = 'flex';

  // Resetear filtro al cambiar de proyecto
  if (_wbsTable) {
    _wbsTable.setFilter('all');
    document.querySelectorAll('#gantt-filter-bar .filter-btn').forEach(b => {
      const isAll = /** @type {HTMLElement} */ (b).dataset.filter === 'all';
      b.classList.toggle('active', isAll);
      b.setAttribute('aria-pressed', String(isAll));
    });
  }
  if (!data.project.start_date) {
    _showToast('Sin fecha de inicio — edita el proyecto para configurarla', 'warn');
  }

  // Resetear línea base activa al cambiar de proyecto
  _activeBaselineId   = null;
  _activeBaselineName = '';
  appState.setBaselineData(null);
  appState.setBaselineMeta(null);

  // Auto-cargar línea base primaria si existe (P6: auto-load primary baseline)
  try {
    const baselines = await listBaselines(projectId);
    const primary = baselines.find(b => b.is_primary);
    if (primary) {
      const blData = await loadBaselineData(primary.id);
      appState.setBaselineData(blData);
      appState.setBaselineMeta({ id: primary.id, name: primary.name, isPrimary: true });
      _activeBaselineId   = primary.id;
      _activeBaselineName = primary.name;
    }
  } catch (e) { console.warn('[baseline] Error al cargar línea base primaria:', e); }

  // Arrancar engine de sync para el nuevo proyecto (solo modo Supabase)
  if (!IS_LOCAL_MODE && data.project) {
    _syncEngine = new SyncEngine(data.project.id, data.project.org_id);
    _syncEngine.start().catch(err => {
      console.warn('[Sync] No se pudo iniciar:', err.message);
    });
  }
}

// ============================================================
// Lista de proyectos en el explorador
// ============================================================

async function _renderProjectList() {
  const list = document.getElementById('explorer-list');
  if (!list) return;
  let { portfolios, programs, projects } = await loadHierarchy();
  const currentId = appState.state.project?.id;

  // Filtrar por empresa activa (modo Supabase)
  const orgId = authState.empresaActual?.org_id;
  if (!IS_LOCAL_MODE && orgId) {
    projects   = projects.filter(p => !p.org_id || p.org_id === orgId);
    portfolios = portfolios.filter(pf => !pf.org_id || pf.org_id === orgId);
    programs   = programs.filter(pg => !pg.org_id || pg.org_id === orgId);
  }

  // Estado de colapso persistido en localStorage
  let collapsed = new Set();
  try { collapsed = new Set(JSON.parse(localStorage.getItem('explorer-collapsed') || '[]')); } catch { /* ignore */ }

  const rows = [];

  const rootProjects = projects.filter(p => !p.settings?.portfolio_id && !p.settings?.program_id);
  const rootPrograms = programs.filter(p => !p.portfolio_id);

  function _projItem(p, indent = 0) {
    return `<div class="explorer-item ${p.id === currentId ? 'active' : ''}" data-project-id="${p.id}"
      role="button" tabindex="0" title="${_escAttr(p.name)}" style="padding-left:${8 + indent * 16}px">
      <span class="item-icon" aria-hidden="true">📋</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${_escHtml(p.name)}</span>
    </div>`;
  }

  function _progItem(prog, indent = 0) {
    const progProjects = projects.filter(p => p.settings?.program_id === prog.id);
    const gid = 'prog-' + prog.id;
    const isCol = collapsed.has(gid);
    const childHtml = progProjects.length
      ? progProjects.map(p => _projItem(p, indent + 1)).join('')
      : `<div style="padding:3px 8px 3px ${24 + indent * 16}px;font-size:11px;color:var(--clr-text-3);font-style:italic">Sin proyectos</div>`;
    return `<div class="explorer-group">
      <div class="explorer-section-title has-toggle" style="padding-left:${4 + indent * 16}px">
        <button class="btn btn-ghost explorer-toggle" data-exptoggle="${gid}"
          aria-expanded="${isCol ? 'false' : 'true'}" aria-label="${isCol ? 'Expandir' : 'Colapsar'} ${_escAttr(prog.name)}"
          title="${isCol ? 'Expandir' : 'Colapsar'}">${isCol ? '▶' : '▼'}</button>
        <span aria-hidden="true">📦</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escHtml(prog.name)} <span style="font-size:10px;opacity:0.6">(${progProjects.length})</span></span>
        ${prog.code ? `<span style="font-size:10px;opacity:0.55;flex-shrink:0">${_escHtml(prog.code)}</span>` : ''}
      </div>
      <div data-expchildren="${gid}" style="${isCol ? 'display:none' : ''}">
        ${childHtml}
      </div>
    </div>`;
  }

  // Portafolios
  portfolios.forEach(pf => {
    const pfPrograms = programs.filter(p => p.portfolio_id === pf.id);
    const pfProjects = projects.filter(p => p.settings?.portfolio_id === pf.id && !p.settings?.program_id);
    const gid = 'pf-' + pf.id;
    const isCol = collapsed.has(gid);
    const childHtml = [
      ...pfPrograms.map(prog => _progItem(prog, 1)),
      ...pfProjects.map(p => _projItem(p, 1)),
    ].join('') || `<div style="padding:3px 8px 3px 24px;font-size:11px;color:var(--clr-text-3);font-style:italic">Sin contenido</div>`;
    rows.push(`<div class="explorer-group">
      <div class="explorer-section-title has-toggle" style="padding-left:4px">
        <button class="btn btn-ghost explorer-toggle" data-exptoggle="${gid}"
          aria-expanded="${isCol ? 'false' : 'true'}" aria-label="${isCol ? 'Expandir' : 'Colapsar'} ${_escAttr(pf.name)}"
          title="${isCol ? 'Expandir' : 'Colapsar'}">${isCol ? '▶' : '▼'}</button>
        <span aria-hidden="true">🗂</span>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escHtml(pf.name)} <span style="font-size:10px;opacity:0.6">(${pfPrograms.reduce((s, g) => s + projects.filter(p => p.settings?.program_id === g.id).length, 0) + pfProjects.length})</span></span>
        ${pf.code ? `<span style="font-size:10px;opacity:0.55;flex-shrink:0">${_escHtml(pf.code)}</span>` : ''}
      </div>
      <div data-expchildren="${gid}" style="${isCol ? 'display:none' : ''}">
        ${childHtml}
      </div>
    </div>`);
  });

  // Programas raíz (sin portafolio)
  rootPrograms.forEach(prog => rows.push(_progItem(prog, 0)));

  // Proyectos raíz
  rootProjects.forEach(p => rows.push(_projItem(p, 0)));

  list.innerHTML = rows.join('');

  // Empresa badge en el explorador
  let empresaBadge = document.getElementById('explorer-empresa-badge');
  if (!empresaBadge) {
    empresaBadge = document.createElement('div');
    empresaBadge.id = 'explorer-empresa-badge';
    empresaBadge.style.cssText = 'padding:4px 8px 0;font-size:10px;color:var(--clr-text-3,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    list.parentElement?.insertBefore(empresaBadge, list);
  }
  if (!IS_LOCAL_MODE && authState.empresaActual) {
    empresaBadge.textContent = '🏢 ' + (authState.empresaActual.org_name || '');
    empresaBadge.style.display = '';
  } else {
    empresaBadge.style.display = 'none';
  }

  // Recovery button when no projects visible
  if (projects.length === 0) {
    const recoveryBtn = document.createElement('div');
    recoveryBtn.style.cssText = 'padding:12px 8px;text-align:center';
    recoveryBtn.innerHTML = `<p style="font-size:11px;color:var(--clr-text-3);margin-bottom:8px">No hay proyectos visibles</p>
      <button id="btn-recover-projects" class="btn btn-sm" style="font-size:11px;background:var(--clr-surface-2,#f8f9fa);border:1px solid var(--clr-border);border-radius:6px;padding:4px 12px;cursor:pointer">🗂 Recuperar eliminados</button>`;
    list.appendChild(recoveryBtn);
    document.getElementById('btn-recover-projects')?.addEventListener('click', () => _showProjectRecovery());
  }

  // Toggle colapsar / expandir
  list.querySelectorAll('[data-exptoggle]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const gid = /** @type {HTMLElement} */ (btn).dataset.exptoggle;
      const childEl = list.querySelector(`[data-expchildren="${gid}"]`);
      if (!childEl) return;
      const nowCollapsing = /** @type {HTMLElement} */ (childEl).style.display !== 'none';
      /** @type {HTMLElement} */ (childEl).style.display = nowCollapsing ? 'none' : '';
      btn.textContent = nowCollapsing ? '▶' : '▼';
      btn.title = nowCollapsing ? 'Expandir' : 'Colapsar';
      btn.setAttribute('aria-expanded', nowCollapsing ? 'false' : 'true');
      if (nowCollapsing) collapsed.add(gid); else collapsed.delete(gid);
      try { localStorage.setItem('explorer-collapsed', JSON.stringify([...collapsed])); } catch { /* ignore */ }
    });
  });

  // Click en proyecto → cargar
  list.querySelectorAll('[data-project-id]').forEach(el => {
    const _activate = async (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('[data-exptoggle]')) return;
      const pid = /** @type {HTMLElement} */ (el).dataset.projectId;
      if (pid && pid !== appState.state.project?.id) {
        try {
          await _loadProject(pid);
          _showToast('Proyecto cargado: ' + (appState.state.project?.name ?? ''), 'success');
        } catch (err) {
          _showToast('Error al cargar proyecto: ' + err.message, 'error');
        }
      }
    };
    el.addEventListener('click', _activate);
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _activate(e); }
    });
  });
}

async function _deleteProject(projectId) {
  // Soft delete: mark deleted_at so project can be recovered
  const proj = await (async () => {
    const all = await listAllProjects();
    return all.find(p => p.id === projectId);
  })();
  if (!proj) return;
  await dbPut('projects', { ...proj, deleted_at: new Date().toISOString() });
  // If this was the active project, clear it
  if (appState.state.project?.id === projectId) {
    appState._applyRemote({ project: null, tasks: new Map(), deps: new Map(), cpmResult: null, cpmDirty: false });
  }
  // Clear last-project-id from localStorage if it matches the deleted project
  try {
    if (localStorage.getItem('last-project-id') === projectId) localStorage.removeItem('last-project-id');
  } catch (_e) { /* ignore */ }
  // Limpiar parámetro ?p= de la URL para evitar que init() intente recargar el proyecto borrado
  try {
    const _pUrl = new URLSearchParams(location.search).get('p');
    if (_pUrl === projectId) history.replaceState(null, '', location.pathname);
  } catch (_e) { /* ignore */ }
}

async function _showProjectRecovery() {
  const all = await listAllProjects();
  const deleted = all.filter(p => p.deleted_at);

  const existing = document.getElementById('dlg-project-recovery');
  if (existing) existing.remove();

  const dlg = document.createElement('dialog');
  dlg.id = 'dlg-project-recovery';
  dlg.style.cssText = 'border:none;border-radius:12px;padding:0;max-width:580px;width:95vw;box-shadow:0 8px 40px rgba(0,0,0,.25);background:var(--clr-surface);color:var(--clr-text)';
  dlg.innerHTML = `
    <div data-drag-handle style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--clr-border);cursor:move;user-select:none;background:var(--clr-surface-2,#f8f9fa);border-radius:12px 12px 0 0">
      <span style="font-size:20px">🗂</span>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:600">Recuperar proyectos eliminados</div>
        <div style="font-size:11px;color:var(--clr-text-3)">${deleted.length} proyecto(s) en papelera</div>
      </div>
      <button id="dlg-recovery-close" class="btn btn-ghost btn-icon btn-sm">✕</button>
    </div>
    <div style="padding:16px 18px;max-height:55vh;overflow-y:auto">
      ${deleted.length === 0
        ? '<p style="color:var(--clr-text-3);text-align:center;padding:16px 0">No hay proyectos eliminados para recuperar.</p>'
        : deleted.map(p => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--clr-border)">
            <span style="font-size:16px">📋</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escHtml(p.name)}</div>
              <div style="font-size:11px;color:var(--clr-text-3)">Eliminado: ${new Date(p.deleted_at).toLocaleDateString('es-PE')}</div>
            </div>
            <button class="btn btn-sm btn-primary" data-restore-id="${_escAttr(p.id)}" title="Recuperar proyecto">Recuperar</button>
            <button class="btn btn-sm btn-danger" data-purge-id="${_escAttr(p.id)}" title="Eliminar definitivamente" style="background:var(--clr-danger,#e74c3c);color:#fff;border:none">Borrar</button>
          </div>`).join('')}
    </div>
    <div style="border-top:2px solid var(--clr-border);padding:14px 18px;background:var(--clr-surface-2,#f8f9fa);border-radius:0 0 12px 12px">
      <div style="font-size:13px;font-weight:600;margin-bottom:8px">🔄 Restaurar estructura de proyectos</div>
      <div style="font-size:11px;color:var(--clr-text-3);margin-bottom:10px">
        Recrea portafolios, programas y proyectos: Plantas Industriales, Edificaciones, Infraestructura, Personal, BIM, Gerencia Técnica y más.
      </div>
      <button id="btn-restore-projects" class="btn btn-primary btn-sm" style="width:100%">⚡ Restaurar proyectos ahora</button>
      <div id="restore-projects-log" style="display:none;margin-top:8px;font-size:11px;font-family:monospace;background:#0f172a;color:#94a3b8;border-radius:6px;padding:10px;max-height:100px;overflow-y:auto"></div>
    </div>`;

  document.body.appendChild(dlg);
  _makeDraggable(dlg, '[data-drag-handle]');

  dlg.querySelector('#dlg-recovery-close')?.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  dlg.querySelectorAll('[data-restore-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = /** @type {HTMLElement} */ (btn).dataset.restoreId;
      const proj = all.find(p => p.id === id);
      if (!proj) return;
      const { deleted_at, ...restored } = proj;
      await dbPut('projects', restored);
      _showToast('Proyecto recuperado: ' + proj.name, 'success');
      dlg.close();
      dlg.remove();
      await _renderProjectList();
    });
  });

  dlg.querySelectorAll('[data-purge-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = /** @type {HTMLElement} */ (btn).dataset.purgeId;
      if (!confirm('¿Eliminar definitivamente este proyecto? Esta acción no se puede deshacer.')) return;
      const [tasks, deps, taskResources] = await Promise.all([
        getByIndex('tasks', 'project_id', id),
        getByIndex('task_dependencies', 'project_id', id),
        getByIndex('task_resources', 'project_id', id),
      ]);
      await Promise.all([
        ...tasks.map(t  => dbRemove('tasks', t.id)),
        ...deps.map(d   => dbRemove('task_dependencies', d.id)),
        ...taskResources.map(tr => dbRemove('task_resources', tr.id)),
      ]);
      await dbRemove('projects', id);
      _showToast('Proyecto eliminado definitivamente', 'info');
      dlg.close();
      dlg.remove();
    });
  });

  // ── Restaurar datos de proyectos ──
  dlg.querySelector('#btn-restore-projects')?.addEventListener('click', async () => {
    const logEl = /** @type {HTMLElement} */ (dlg.querySelector('#restore-projects-log'));
    const btnEl = /** @type {HTMLButtonElement} */ (dlg.querySelector('#btn-restore-projects'));
    if (!logEl || !btnEl) return;
    logEl.style.display = 'block';
    btnEl.disabled = true;
    const log = (msg, color='#94a3b8') => { logEl.innerHTML += `<span style="color:${color}">${msg}</span>\n`; logEl.scrollTop = 99999; };

    const NOW2 = new Date().toISOString();
    const ORG2 = '00000000-0000-0000-0000-000000000001';
    const pfData = [
      { id:'pf-01', org_id:ORG2, name:'Plantas Industriales', description:'Proyectos de plantas de procesamiento, energía y manufactura.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pf-02', org_id:ORG2, name:'Edificaciones',         description:'Edificios corporativos, residenciales y públicos.',           created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pf-03', org_id:ORG2, name:'Infraestructura',       description:'Vialidad, obras hidráulicas, puentes y túneles.',             created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pf-04', org_id:ORG2, name:'Personal',              description:'Gestión de personal, salud ocupacional y cirugía.',           created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pf-05', org_id:ORG2, name:'BIM',                   description:'Modelado BIM, coordinación digital y tecnología.',            created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pf-06', org_id:ORG2, name:'Gerencia Técnica',      description:'Gestión técnica, ingeniería, calidad y procesos.',            created_at:NOW2, updated_at:NOW2, deleted_at:null },
    ];
    const pgData = [
      { id:'pg-01', org_id:ORG2, portfolio_id:'pf-01', name:'Procesamiento de Minerales',      description:'Plantas mineras.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-02', org_id:ORG2, portfolio_id:'pf-01', name:'Plantas de Energía',              description:'Termoeléctricas y subestaciones.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-03', org_id:ORG2, portfolio_id:'pf-01', name:'Plantas Químicas e Industriales', description:'Fertilizantes y manufactura.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-04', org_id:ORG2, portfolio_id:'pf-02', name:'Edificios Corporativos',          description:'Torres y sedes empresariales.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-05', org_id:ORG2, portfolio_id:'pf-02', name:'Edificios Residenciales',         description:'Condominios y edificios de vivienda.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-06', org_id:ORG2, portfolio_id:'pf-02', name:'Edificios Públicos',              description:'Ministerios, universidades, gobierno.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-07', org_id:ORG2, portfolio_id:'pf-03', name:'Vialidad y Carreteras',           description:'Carreteras, autopistas y pavimentación.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-08', org_id:ORG2, portfolio_id:'pf-03', name:'Obras Hidráulicas',               description:'Presas, irrigaciones y agua.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-09', org_id:ORG2, portfolio_id:'pf-03', name:'Puentes y Túneles',               description:'Estructuras especiales de conectividad.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-10', org_id:ORG2, portfolio_id:'pf-04', name:'Salud Ocupacional',               description:'Hospitales, salud y bienestar del personal.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-11', org_id:ORG2, portfolio_id:'pf-04', name:'Cirugía y Equipamiento',          description:'Equipamiento quirúrgico y quirófanos especializados.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-12', org_id:ORG2, portfolio_id:'pf-05', name:'Modelado BIM',                    description:'Proyectos con metodología BIM.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-13', org_id:ORG2, portfolio_id:'pf-05', name:'Coordinación Digital',            description:'Coordinación multidisciplinaria digital.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-14', org_id:ORG2, portfolio_id:'pf-06', name:'Control de Calidad',              description:'Gestión de calidad y auditorías técnicas.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
      { id:'pg-15', org_id:ORG2, portfolio_id:'pf-06', name:'Ingeniería y Diseño',             description:'Proyectos de ingeniería, diseño y consultoría.', created_at:NOW2, updated_at:NOW2, deleted_at:null },
    ];
    const mkProj = (id, pgId, code, name, start, budget, currency='USD') => ({
      id, org_id:ORG2, program_id:pgId, code, name,
      sponsor_id:null, start_date:start, actual_start_date:null, actual_finish_date:null,
      data_date:null, calendar_id:'cal-default-001', budget, currency,
      is_template:false, settings:{}, created_at:NOW2, updated_at:NOW2, deleted_at:null,
    });
    const prjData = [
      mkProj('prj-01','pg-01','PI-2024-001','Planta Concentradora Norte',         '2024-03-01', 42000000),
      mkProj('prj-02','pg-01','PI-2024-002','Ampliación Planta Toquepala',        '2024-06-15', 28500000),
      mkProj('prj-03','pg-02','PE-2024-001','Subestación Eléctrica 220kV',        '2024-04-01', 18000000),
      mkProj('prj-04','pg-02','PE-2025-001','Planta de Gas Natural Licuado',      '2025-01-10', 65000000),
      mkProj('prj-05','pg-03','PQ-2024-001','Planta de Fertilizantes Ica',        '2024-07-01', 31000000),
      mkProj('prj-06','pg-04','EC-2024-001','Torre Corporativa San Isidro',       '2024-05-01', 55000000,'PEN'),
      mkProj('prj-07','pg-04','EC-2025-001','Sede Central Lima',                  '2025-03-01', 38000000,'PEN'),
      mkProj('prj-08','pg-05','ER-2024-001','Condominio Las Magnolias',           '2024-02-01', 22000000,'PEN'),
      mkProj('prj-09','pg-05','ER-2025-001','Edificio Residencial El Golf',       '2025-06-01', 19500000,'PEN'),
      mkProj('prj-10','pg-06','EP-2024-001','Hospital Regional Cajamarca',        '2024-08-01', 95000000,'PEN'),
      mkProj('prj-11','pg-07','IV-2024-001','Carretera Longitudinal Sierra Km120','2024-01-15', 87000000,'PEN'),
      mkProj('prj-12','pg-07','IV-2024-002','Pavimentación Av. Industrial Piura', '2024-09-01', 12000000,'PEN'),
      mkProj('prj-13','pg-08','IH-2024-001','Presa Derivadora Río Majes',         '2024-03-15',145000000,'PEN'),
      mkProj('prj-14','pg-09','IP-2025-001','Puente Vehicular Río Rímac',         '2025-02-01', 34000000,'PEN'),
      mkProj('prj-15','pg-10','SH-2024-001','Hospital Rebagliati — Oncología',    '2024-06-01', 78000000,'PEN'),
      mkProj('prj-16','pg-11','SC-2024-001','Equipamiento Quirófanos HN Dos de Mayo','2024-10-01',14500000,'PEN'),
      mkProj('prj-17','pg-11','SC-2025-001','Sala de Cirugía Robótica INEN',      '2025-04-01', 21000000,'PEN'),
      mkProj('prj-18','pg-12','BIM-2024-001','Modelo BIM Integrado Torre S.Isidro','2024-05-01',1200000,'PEN'),
      mkProj('prj-19','pg-14','GT-2024-001','Sistema de Gestión de Calidad ISO',  '2024-02-01',  850000,'PEN'),
      mkProj('prj-20','pg-15','GT-2024-002','Ingeniería de Valor — Proyectos Minería','2024-05-01',1500000,'PEN'),
    ];
    const calData = {
      id:'cal-default-001', org_id:ORG2, name:'Calendario Laboral (Lun–Vie)',
      work_week:[1,2,3,4,5], hours_per_day:8, shift_label:'Diurno',
      shift_start:'07:00', shift_end:'17:00', created_at:NOW2, updated_at:NOW2, deleted_at:null,
    };

    try {
      const { openDB: openIDB } = await import('./storage.js');
      const db2 = await openIDB();

      const putBatch = (store, records) => new Promise((res, rej) => {
        const tx = db2.transaction(store, 'readwrite');
        const st = tx.objectStore(store);
        for (const r of records) st.put(r);
        tx.oncomplete = () => res(records.length);
        tx.onerror = () => rej(tx.error);
      });
      const putMissing = async (store, records) => {
        const existingKeys = await new Promise((res, rej) => {
          const req = db2.transaction(store, 'readonly').objectStore(store).getAllKeys();
          req.onsuccess = () => res(new Set(req.result));
          req.onerror = () => rej(req.error);
        });
        const missing = records.filter(r => !existingKeys.has(r.id));
        if (!missing.length) return 0;
        return putBatch(store, missing);
      };

      await putBatch('calendars',  [calData]);
      log('✓ Calendario laboral registrado', '#22c55e');
      const _pfIns = await putMissing('portfolios', pfData);
      log(`✓ ${_pfIns} portafolios nuevos insertados (${pfData.length} total)`, '#22c55e');
      const _pgIns = await putMissing('programs',   pgData);
      log(`✓ ${_pgIns} programas nuevos insertados (${pgData.length} total)`, '#22c55e');
      const _prIns = await putMissing('projects',   prjData);
      log(`✓ ${_prIns} proyectos nuevos insertados (${prjData.length} total)`, '#22c55e');
      log('✅ Restauración completada', '#22c55e');

      dlg.close();
      dlg.remove();
      await _renderProjectList();
      _showToast('Estructura restaurada: ' + pfData.length + ' portafolios, ' + prjData.length + ' proyectos', 'success');
    } catch (err) {
      log('❌ Error: ' + err.message, '#ef4444');
      btnEl.disabled = false;
    }
  });

  dlg.showModal();
}

function _escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function _escAttr(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ============================================================
// Crear nuevo elemento (portafolio / programa / proyecto)
// ============================================================

function _bindNewProject() {
  document.getElementById('btn-recover-projects-hdr')?.addEventListener('click', () => _showProjectRecovery());

  const btn    = document.getElementById('btn-new-project');
  const dlg    = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-new-item'));
  if (dlg) _makeDraggable(dlg, '[data-drag-handle]');
  document.getElementById('btn-ni-print')?.addEventListener('click', () => {
    const formEl = document.getElementById('form-new-item');
    _printToPdf('Nuevo Elemento', `<h1>Nuevo Elemento</h1>${formEl?.innerHTML ?? ''}`);
  });
  const form   = document.getElementById('form-new-item');
  const cancel = document.getElementById('btn-ni-cancel');
  const submitBtn = document.getElementById('btn-ni-submit');

  // Fecha de hoy por defecto
  const startInput = /** @type {HTMLInputElement|null} */ (document.getElementById('ni-start'));
  if (startInput) startInput.value = new Date().toISOString().slice(0, 10);

  // Selector de tipo: actualizar apariencia y visibilidad de campos
  function _updateTypeUI() {
    const type = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="ni-type"]:checked'))?.value ?? 'project';
    document.querySelectorAll('.ni-type-btn').forEach(btn => {
      const forType = /** @type {HTMLElement} */ (btn).dataset.for;
      const active  = forType === type;
      /** @type {HTMLElement} */ (btn).style.borderColor  = active ? 'var(--clr-primary,#1976D2)' : 'var(--clr-border,#ddd)';
      /** @type {HTMLElement} */ (btn).style.background   = active ? 'rgba(25,118,210,0.08)' : '';
      /** @type {HTMLElement} */ (btn).style.color        = active ? 'var(--clr-primary,#1976D2)' : '';
    });
    const parentRow = document.getElementById('ni-parent-row');
    const dateRow   = document.getElementById('ni-date-row');
    const dateInput = document.getElementById('ni-start');
    if (parentRow) parentRow.style.display = type === 'portfolio' ? 'none' : 'block';
    if (dateRow)   dateRow.style.display   = type === 'project'   ? 'block' : 'none';
    if (dateInput) /** @type {HTMLInputElement} */ (dateInput).required = type === 'project';
    if (submitBtn) submitBtn.textContent = type === 'portfolio' ? 'Crear portafolio' : type === 'program' ? 'Crear programa' : 'Crear proyecto';
    _loadParentOptions(type);
  }

  // Cargar opciones del select "Pertenece a"
  async function _loadParentOptions(type) {
    const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ni-parent'));
    if (!sel) return;
    sel.innerHTML = '<option value="">— Sin asignar (nivel raíz) —</option>';
    if (type === 'portfolio') return;
    const { portfolios, programs } = await loadHierarchy();
    if (type === 'program') {
      portfolios.forEach(p => {
        const opt = document.createElement('option');
        opt.value = 'portfolio:' + p.id;
        opt.textContent = '🗂 ' + p.name;
        sel.appendChild(opt);
      });
    } else {
      // proyecto puede ir en portafolio o programa
      portfolios.forEach(p => {
        const opt = document.createElement('option');
        opt.value = 'portfolio:' + p.id;
        opt.textContent = '🗂 ' + p.name;
        sel.appendChild(opt);
      });
      programs.forEach(p => {
        const opt = document.createElement('option');
        opt.value = 'program:' + p.id;
        opt.textContent = '📦 ' + p.name;
        sel.appendChild(opt);
      });
    }
  }

  document.querySelectorAll('input[name="ni-type"]').forEach(r =>
    r.addEventListener('change', _updateTypeUI));

  btn?.addEventListener('click', async () => {
    _updateTypeUI();
    document.getElementById('ni-name')?.focus();
    dlg?.showModal();
  });

  cancel?.addEventListener('click', () => dlg?.close());
  dlg?.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Etapa 4: protección contra doble-envío del formulario
    const submitBtn = /** @type {HTMLButtonElement|null} */ (form?.querySelector('[type="submit"]'));
    if (submitBtn?.disabled) return;
    if (submitBtn) submitBtn.disabled = true;

    const type   = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="ni-type"]:checked'))?.value ?? 'project';
    const name   = /** @type {HTMLInputElement} */ (document.getElementById('ni-name')).value.trim();
    const code   = /** @type {HTMLInputElement} */ (document.getElementById('ni-code')).value.trim();
    const start  = /** @type {HTMLInputElement} */ (document.getElementById('ni-start')).value;
    const parentVal = /** @type {HTMLSelectElement} */ (document.getElementById('ni-parent'))?.value ?? '';

    if (!name) { if (submitBtn) submitBtn.disabled = false; return; }
    if (type === 'project' && !start) { if (submitBtn) submitBtn.disabled = false; return; }

    const id  = crypto.randomUUID();
    const now = new Date().toISOString();

    // Parsear padre
    let portfolio_id = null, program_id = null;
    if (parentVal.startsWith('portfolio:')) portfolio_id = parentVal.slice(10);
    if (parentVal.startsWith('program:'))   program_id   = parentVal.slice(8);

    try {
      if (type === 'portfolio') {
        await savePortfolio({ id, name, code: code || null, settings: {}, created_at: now, updated_at: now, deleted_at: null });
        _showToast('Portafolio creado: ' + name, 'success');
      } else if (type === 'program') {
        await saveProgram({ id, name, code: code || null, portfolio_id, settings: {}, created_at: now, updated_at: now, deleted_at: null });
        _showToast('Programa creado: ' + name, 'success');
      } else {
        const newProject = {
          id, org_id: authState.empresaActual?.org_id || null,
          code: code || null, name, start_date: start,
          data_date: null, status: 'active', is_template: false,
          settings: { portfolio_id, program_id },
          created_at: now, updated_at: now, deleted_at: null,
        };
        await saveProjectSnapshot({ project: newProject, tasks: [], deps: [], calendar: null, calExceptions: [] });
        await _loadProject(id);
        _showToast('Proyecto creado: ' + name, 'success');
      }
      dlg?.close();
      _clearNewItemForm();
      await _renderProjectList();
    } catch (err) {
      _showToast('Error al crear: ' + err.message, 'error');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

function _clearNewItemForm() {
  const fields = ['ni-name','ni-code'];
  fields.forEach(id => { const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id)); if (el) el.value = ''; });
  const startEl = /** @type {HTMLInputElement|null} */ (document.getElementById('ni-start'));
  if (startEl) startEl.value = new Date().toISOString().slice(0, 10);
  const typeProject = /** @type {HTMLInputElement|null} */ (document.getElementById('ni-type-project'));
  if (typeProject) typeProject.checked = true;
}

// ============================================================
// Inicialización
// ============================================================

let _wbsTable       = null;
let _ganttScene     = null;
let _ganttCanvas    = null;
let _dcmaPanel      = null;
let _evmPanel       = null;
let _changeLogPanel = null;
let _rhPanel        = null;
let _syncEngine     = null;
let _ganttFitPending = false; // true tras cargar proyecto → auto-ajusta al primer CPM
let _activeBaselineId   = null;
let _activeBaselineName = '';

async function init() {
  try {
    await openDB();
    _initWorker();

    appState.onRequestCpm = _requestCpm;

    // ---- Cargar proyecto ----
    // Siempre restaurar demo al inicio (garantiza que no desaparezca)
    await _ensureDemoData();
    let _lastProjId = null;
    try { _lastProjId = localStorage.getItem('last-project-id'); } catch {}
    const projectId = new URLSearchParams(location.search).get('p') || _lastProjId;
    if (projectId) {
      try {
        await _loadProject(projectId);
      } catch {
        const demoProj = await _ensureDemoData();
        if (demoProj) {
          await _loadProject(demoProj.id);
          // Informar al usuario que el proyecto anterior no se encontró
          setTimeout(() => {
            _showToast('⚠ Proyecto anterior no encontrado. Usa Exportar → Importar JSON para restaurar desde un respaldo.', 'warn');
          }, 1500);
        }
      }
    } else {
      const demoProj = await _ensureDemoData();
      if (demoProj) await _loadProject(demoProj.id);
    }

    // ---- Inicializar tabla WBS ----
    const wbsPanel = document.getElementById('wbs-panel');
    if (wbsPanel) {
      _wbsTable = new WbsTable(wbsPanel);
    }

    // ---- Filtros del Gantt ----
    document.querySelectorAll('#gantt-filter-bar .filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const filter = /** @type {HTMLElement} */ (btn).dataset.filter ?? 'all';
        _wbsTable?.setFilter(filter);
        document.querySelectorAll('#gantt-filter-bar .filter-btn').forEach(b => {
          b.classList.toggle('active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
      });
    });

    // ---- Inicializar Gantt Canvas ----
    const ganttCanvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById('gantt-canvas'));
    if (ganttCanvas) {
      _ganttScene  = new GanttScene();
      _ganttCanvas = new GanttCanvas(ganttCanvas, _ganttScene);

      // Restaurar etiquetas de barras desde localStorage
      try {
        const saved = JSON.parse(localStorage.getItem('gantt-bar-labels') || '["name"]');
        _ganttCanvas.setBarLabels(saved);
        _syncBarLabelsUI(saved);
      } catch (_) { /* ignore */ }

      // Restaurar columnas visibles de la tabla EDT desde localStorage
      _applyWbsColVisibility();

      // Alimentar la escena con los datos del proyecto
      _syncGanttScene();

      // Actualizar escena cuando cambia el estado relevante
      appState.subscribe((_state, keys) => {
        if (!keys || keys.includes('all') || keys.some(k =>
          ['project','tasks','deps','cpmResult','calendar','calExceptions'].includes(k))) {
          _syncGanttScene();
        }
        if (!keys || keys.includes('all') || keys.some(k =>
          ['cpmResult','tasks','deps','selectedTaskId'].includes(k))) {
          // Auto-ajustar al primer resultado CPM tras cargar proyecto
          if (_ganttFitPending && (keys?.includes('cpmResult') || keys?.includes('all'))) {
            _ganttFitPending = false;
            requestAnimationFrame(() => _ganttCanvas?.fitToView());
          } else {
            _ganttCanvas?.requestRender();
          }
        }
      });

      // Recibir filas visibles de la tabla WBS
      document.addEventListener('gantt-rows-update', /** @type {any} */ (e) => {
        _ganttCanvas?.updateRows(e.detail.rows);
      });

      // Fila fantasma → crear tarea nueva
      document.addEventListener('wbs-add-task', /** @type {any} */ (e) => {
        _wbsTable?.addTaskAfterSelected(e.detail?.type ?? 'task');
      });

      // Sincronizar scroll: Gantt → tabla WBS
      document.addEventListener('gantt-scroll-y', /** @type {any} */ (e) => {
        const scroll = document.getElementById('wbs-scroll');
        if (scroll) scroll.scrollTop = e.detail.scrollY;
      });
    }

    // ---- Actualizar nombre del proyecto ----
    const nameEl = document.getElementById('project-name-display');
    if (nameEl && appState.state.project) {
      nameEl.textContent = appState.state.project.name;
    }

    // ---- Mostrar badge modo local ----
    if (IS_LOCAL_MODE) {
      const badge = document.getElementById('sync-mode-badge');
      if (badge) { badge.textContent = t('localMode'); badge.style.display = ''; }
    }

    // ---- Suscribir actualizaciones de estado ----
    appState.subscribe((_state, keys) => {
      _updateUndoRedoBtns();
      _updateStatus();
    });

    _updateUndoRedoBtns();
    _updateStatus();

    // ---- Inicializar panel DCMA ----
    const dcmaEl = document.getElementById('dcma-panel');
    if (dcmaEl) {
      _dcmaPanel = new DcmaPanel(dcmaEl);
    }

    // Escuchar selección de tarea desde el panel DCMA
    document.addEventListener('dcma-select-task', /** @type {any} */ (e) => {
      appState.selectTask(e.detail.id);
    });

    // Abrir panel de detalle de tarea
    document.addEventListener('open-task-detail', (/** @type {any} */ e) => {
      _openTaskDetail(e.detail.taskId);
    });

    // Confirmación accesible de borrado de tarea (reemplaza confirm() nativo)
    document.addEventListener('wbs-confirm-delete', (/** @type {any} */ e) => {
      _confirmDialog(t('confirmDelete'), e.detail.fn);
    });

    // Toast global — permite a print.js y otros módulos mostrar mensajes sin importar _showToast
    document.addEventListener('show-toast', (/** @type {any} */ e) => {
      _showToast(e.detail.msg, e.detail.type ?? '');
    });

    // Re-calcular CPM después de actualizaciones remotas (sync.js)
    // Etapa 3: debounce para evitar múltiples cálculos CPM durante ediciones rápidas
    const _debouncedCpm = debouncedSave(() => _requestCpm(), 200);
    document.addEventListener('ecm-schedule-cpm', () => _debouncedCpm());

    // ---- Inicializar panel EVM ----
    const evmEl = document.getElementById('evm-panel');
    if (evmEl) {
      _evmPanel = new EvmPanel(evmEl);
      // Actualizar al cambiar CPM
      appState.subscribe((_state, keys) => {
        if (evmEl.classList.contains('open') &&
            keys?.some(k => ['cpmResult', 'tasks'].includes(k))) {
          _evmPanel.refresh();
        }
      });
      // Botón cerrar dentro del panel
      evmEl.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target).id === 'btn-evm-close') {
          evmEl.classList.remove('open');
        }
      });
    }

    // ---- Inicializar panel Historial ----
    const changelogEl = document.getElementById('changelog-panel');
    if (changelogEl) {
      _changeLogPanel = new ChangeLogPanel(changelogEl);
      changelogEl.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target).id === 'btn-changelog-close') {
          changelogEl.classList.remove('open');
          document.getElementById('btn-changelog')?.removeAttribute('aria-pressed');
        }
      });
    }

    // ---- Inicializar panel Histograma de Recursos ----
    const rhEl = document.getElementById('resource-histogram-panel');
    if (rhEl) {
      _rhPanel = new ResourceHistogramPanel(rhEl);
    }

    // El motor de sync ya fue iniciado dentro de _loadProject.

    console.log('[ECM Project] v89 completo — modo', IS_LOCAL_MODE ? 'local' : 'Supabase');
  } catch (err) {
    console.error('[init]', err);
    _showToast('Error al iniciar: ' + err.message, 'error');
    // Reemplazar el placeholder "Cargando…" para que el usuario pueda usar la app
    const wbsPanel = document.getElementById('wbs-panel');
    if (wbsPanel && !wbsPanel.querySelector('#wbs-scroll')) {
      wbsPanel.innerHTML = `<div style="padding:24px;color:var(--clr-danger,#e74c3c);font-family:var(--font-ui)">
        Error al cargar: ${_escHtml(err.message)}<br><small>Abre la consola del navegador para más detalles (F12).</small>
      </div>`;
    }
  }
}

// ============================================================
// Sincronización de la escena Gantt
// ============================================================

function _syncGanttScene() {
  if (!_ganttScene) return;
  const { project, calendar, calExceptions, cpmResult } = appState.state;
  if (!project) return;

  _ganttScene.projectStart = isoToDate(project.start_date || new Date().toISOString().slice(0, 10));
  _ganttScene.cpmResult    = cpmResult;

  const calDef = calendar
    ? { work_week: calendar.work_week,
        exceptions: calExceptions.filter(e => !e.deleted_at).map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };

  _ganttScene.calendar = new Calendar(calDef);
}

// ============================================================
// Helpers: drag + PDF print
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
    dialog.style.position = 'fixed';
    dialog.style.margin = '0';
    dialog.style.transform = 'none';
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

/** Extrae todas las variables CSS custom de :root y las devuelve como bloque :root{…} */
function _getCssVarsInline() {
  try {
    const cs = getComputedStyle(document.documentElement);
    const seen = new Set(), vars = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (/** @type {CSSStyleRule} */ (rule).selectorText === ':root') {
            for (const p of /** @type {CSSStyleRule} */ (rule).style) {
              if (p.startsWith('--') && !seen.has(p)) {
                seen.add(p);
                vars.push(`${p}:${cs.getPropertyValue(p)}`);
              }
            }
          }
        }
      } catch(_e) { /* cross-origin sheet */ }
    }
    return vars.length ? `:root{${vars.join(';')}}` : '';
  } catch(_e) { return ''; }
}

function _printToPdf(moduleName, htmlContent) {
  const _proj = appState.state.project?.name ?? 'ECM Project';
  const _d = new Date();
  const _dd = String(_d.getDate()).padStart(2,'0');
  const _mm = String(_d.getMonth()+1).padStart(2,'0');
  const _yy = _d.getFullYear();
  const _hh = String(_d.getHours()).padStart(2,'0');
  const _mi = String(_d.getMinutes()).padStart(2,'0');
  const _projEsc = _proj.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const _modEsc = moduleName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const title = `${_proj}-${moduleName}-${_dd}${_mm}${_yy}`;
  const _appCssVars = _getCssVarsInline();
  const w = window.open('', '_blank', 'width=1100,height=880');
  if (!w) {
    document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.', type: 'warn' } }));
    return;
  }
  w.document.write(`<!DOCTYPE html><html><head>
<meta charset="utf-8">
${FONTS_LINK}
<title>${title}</title>
<style>
  ${_appCssVars}
  *{box-sizing:border-box}
  body{font-family:Arial,sans-serif;margin:0;padding:0;background:#f1f5f9;color:var(--clr-text,#1a1a2e)}
  .tb{background:#fff;padding:8px 14px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;position:sticky;top:0;z-index:100;border-bottom:1px solid #e2e8f0}
  .tb button{padding:5px 11px;border:1px solid #d1d5db;border-radius:5px;cursor:pointer;font-size:12px;background:#fff;color:#374151;white-space:nowrap}
  .tb button.pri{background:#1976d2;color:#fff;border-color:#1976d2;font-weight:600;font-size:13px;padding:6px 16px}
  .tb button.pri:hover{background:#1565c0}
  .tb button.act{background:#e3f2fd;color:#1565c0;border-color:#90caf9;font-weight:600}
  .tb button:hover:not(.pri){background:#f8fafc}
  .tb .sep{width:1px;height:20px;background:#e2e8f0;flex-shrink:0}
  .tb .lbl{font-size:11px;color:#64748b;white-space:nowrap}
  .tb input[type=text]{font-size:12px;padding:3px 8px;border:1px solid #d1d5db;border-radius:4px;background:#f8fafc;color:#374151;width:300px}
  .pv{padding:20px;display:flex;flex-direction:column;align-items:center;gap:16px;min-height:calc(100vh - 52px)}
  .a4{background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.4);padding:14mm 15mm;width:var(--pw,210mm);min-height:var(--ph,297mm);overflow:hidden}
  .tb select{font-size:12px;padding:3px 6px;border:1px solid #d1d5db;border-radius:4px;background:#fff;color:#374151}
  h1{font-size:18px;margin-bottom:16px}
  h2{font-size:14px;margin:14px 0 6px}
  table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 10px;font-size:12px}th{background:#f4f5f7;font-weight:600}
  svg{max-width:100%;height:auto}img{max-width:100%}
  .badge{display:inline-block;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600}
  .print-header,.print-footer{font-family:'Urbanist',system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .print-header{position:fixed;top:0;left:0;right:0;height:26px;display:none;align-items:center;justify-content:space-between;padding:0 10mm;border-bottom:0.5pt solid #CBD5E0;font-size:6pt;color:#4A5568;background:#fff;z-index:9999}
  .print-footer{position:fixed;bottom:0;left:0;right:0;height:22px;display:none;align-items:center;justify-content:space-between;padding:0 10mm;border-top:0.5pt solid #CBD5E0;font-size:6pt;color:#718096;background:#fff;z-index:9999}
  ${REPORT_TITLE_CSS}
  @media print{body{background:#fff}.tb{display:none!important}.pv{padding:0;min-height:0}.a4{box-shadow:none;width:100%;min-height:0;padding:1.5mm 0 0!important}.print-header,.print-footer{display:flex!important}@page{margin:10mm}}
  ${pageHfCss({ proj: _proj, date: `${_dd}-${_mm}-${_yy}, ${_hh}:${_mi}` })}
  ${REPORT_FONT_CSS}
</style>
</head><body>
<div class="tb">
  ${PAPER_SELECT_HTML}
  <span class="lbl">Orientaci&#243;n:</span>
  <button id="bp" class="act" onclick="setOri('portrait')">&#x1F4C4; Vertical</button>
  <button id="bl" onclick="setOri('landscape')">&#x1F5C2; Horizontal</button>
  <div class="sep"></div>
  <span class="lbl">&#x1F4C1; Archivo:</span>
  <input type="text" id="fn" value="${title}.pdf" title="Nombre sugerido del archivo PDF" oninput="document.title=this.value.replace(/\\.pdf$/i,'')">
  <div class="sep"></div>
  <button onclick="window.close()">&#x2715; Cerrar</button>
  <button class="pri" style="margin-left:auto" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
</div>
<div class="pv">
  <div class="a4" id="a4">
<div class="print-header"><span>ECM Project V1.00.01</span><span>${_projEsc}</span><span>${_dd}-${_mm}-${_yy}, ${_hh}:${_mi}</span></div>
<div class="print-footer"><span>By EHCM</span><span>&#8212;</span><span>P&aacute;gina <span id="phf-cur">1</span> de <span id="phf-tot">1</span></span></div>
<div class="print-title">${_modEsc}</div>
${normalizeReportBody(moduleName, htmlContent)}</div>
</div>
<script>
  (function(){function _u(){var h=document.getElementById('a4');if(!h)return;var t=Math.max(1,Math.ceil(h.scrollHeight/1120));var el=document.getElementById('phf-tot');if(el)el.textContent=t;}window.addEventListener('beforeprint',_u);_u();})();
  document.title=${JSON.stringify(title)};
  ${PAPER_JS}
  var _ori='portrait';
  function setOri(o){
    if(o)_ori=o; o=_ori;
    var sz=paperSize(o), a=document.getElementById('a4');
    a.style.setProperty('--pw',sz[0]+'mm'); a.style.setProperty('--ph',sz[1]+'mm');
    a.classList.toggle('land',o==='landscape');
    document.getElementById('bp').classList.toggle('act',o==='portrait');
    document.getElementById('bl').classList.toggle('act',o==='landscape');
    var s=document.getElementById('_ps')||document.createElement('style');
    s.id='_ps';s.textContent='@page{size:'+sz[0]+'mm '+sz[1]+'mm}';document.head.appendChild(s);
  }
  setOri('portrait');
<\/script>
</body></html>`);
  w.document.close();
}

// ============================================================
// Diálogo de resultados Monte Carlo
// ============================================================

/** @type {import('./monte-carlo.js').MonteCarloPanel|null} */
let _mcPanel = null;

function _showMonteCarloDlg(result, fmtDay) {
  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-monte-carlo'));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-monte-carlo';
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'mc-dlg-title');
    dlg.style.cssText = 'padding:0;border:1px solid var(--clr-border);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.35);max-width:520px;width:96vw;background:var(--clr-surface);color:var(--clr-text)';
    dlg.innerHTML = `
      <div data-drag-handle style="display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);border-radius:12px 12px 0 0">
        <span id="mc-dlg-title" style="font-weight:700;font-size:14px">🔮 Simulación Monte Carlo</span>
        <div style="display:flex;gap:4px;align-items:center">
          <button id="mc-dlg-print" class="btn btn-ghost btn-sm" aria-label="Imprimir PDF">🖨 Imprimir</button>
          <button id="mc-dlg-close" class="btn btn-icon btn-sm" aria-label="Cerrar">✕</button>
        </div>
      </div>
      <div id="mc-dlg-body" style="padding:20px 22px"></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#mc-dlg-close')?.addEventListener('click', () => dlg.close());
    dlg.querySelector('#mc-dlg-print')?.addEventListener('click', () => {
      const body = dlg.querySelector('#mc-dlg-body');
      const _mcCss = document.getElementById('mc-styles')?.textContent ?? '';
      const _mcVars = ':root{--mc-accent:#2563eb;--mc-kpi-bg:#f3f4f6;--mc-hist-fill:#60a5fa;--mc-p80-color:#dc2626;--mc-fg:#333;--mc-border:#e5e7eb;--mc-warn:#b45309;--mc-surface:#f5f7ff;--mc-hist-axis-stroke:#aaa;--mc-tick-fill:#666}';
      _printToPdf('Simulación Monte Carlo', `<style>${_mcCss}\n${_mcVars}</style><h1>Simulación Monte Carlo</h1>${body?.innerHTML ?? ''}`);
    });
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    _makeDraggable(dlg, '[data-drag-handle]');
  }
  const { p50, p80, p90, iterations: n } = result;
  const body = dlg.querySelector('#mc-dlg-body');
  if (body) {
    body.innerHTML = `
      <p style="font-size:13px;color:var(--clr-text-2);margin:0 0 16px">${n.toLocaleString()} iteraciones · distribución PERT por actividad</p>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
        <div style="text-align:center;background:var(--clr-surface-2);border-radius:8px;padding:14px 8px">
          <div style="font-size:11px;color:var(--clr-text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">P50</div>
          <div style="font-size:17px;font-weight:700;color:var(--clr-primary)">${fmtDay(p50)}</div>
          <div style="font-size:10px;color:var(--clr-text-3);margin-top:2px">${p50} días lab.</div>
        </div>
        <div style="text-align:center;background:var(--clr-surface-2);border-radius:8px;padding:14px 8px">
          <div style="font-size:11px;color:var(--clr-text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">P80</div>
          <div style="font-size:17px;font-weight:700;color:#fb8c00">${fmtDay(p80)}</div>
          <div style="font-size:10px;color:var(--clr-text-3);margin-top:2px">${p80} días lab.</div>
        </div>
        <div style="text-align:center;background:var(--clr-surface-2);border-radius:8px;padding:14px 8px">
          <div style="font-size:11px;color:var(--clr-text-3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">P90</div>
          <div style="font-size:17px;font-weight:700;color:#d32f2f">${fmtDay(p90)}</div>
          <div style="font-size:10px;color:var(--clr-text-3);margin-top:2px">${p90} días lab.</div>
        </div>
      </div>
      <p style="font-size:11px;color:var(--clr-text-3);margin:0">P50: 50% de probabilidad de terminar en esa fecha o antes. P80/P90: riesgo alto / muy alto.</p>`;
  }
  dlg.showModal();
}

// ============================================================
// Manejadores de botones del toolbar
// ============================================================

function _bindToolbar() {
  document.getElementById('btn-undo')?.addEventListener('click', () => {
    if (appState.undo()) _showToast(t('undone'));
    else _showToast(t('noMoreUndo'));
  });
  document.getElementById('btn-redo')?.addEventListener('click', () => {
    if (appState.redo()) _showToast(t('redone'));
    else _showToast(t('noMoreRedo'));
  });
  document.addEventListener('keydown', (e) => {
    const tag = /** @type {HTMLElement} */ (document.activeElement)?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (appState.undo()) _showToast(t('undone'));
      else _showToast(t('noMoreUndo'));
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      if (appState.redo()) _showToast(t('redone'));
      else _showToast(t('noMoreRedo'));
    }
  });
  document.getElementById('btn-add-task')?.addEventListener('click', () => {
    _wbsTable?.addTaskAfterSelected('task');
  });
  document.getElementById('btn-add-milestone')?.addEventListener('click', () => {
    _wbsTable?.addTaskAfterSelected('milestone');
  });
  document.getElementById('btn-indent')?.addEventListener('click', () => {
    const id = appState.state.selectedTaskId;
    if (id) _wbsTable?._indentTask(id);
  });
  document.getElementById('btn-outdent')?.addEventListener('click', () => {
    const id = appState.state.selectedTaskId;
    if (id) _wbsTable?._outdentTask(id);
  });
  document.getElementById('btn-auto-calc')?.addEventListener('change', e => {
    appState.setAutoCalc(/** @type {HTMLInputElement} */ (e.target).checked);
  });
  // ---- Theme picker: 7 temas ----
  {
    const _THEMES = [
      { id: 'light',     label: 'Claro',           bg: '#f7f8fa', primary: '#4f46e5' },
      { id: 'dark',      label: 'Oscuro',           bg: '#0f1117', primary: '#818cf8' },
      { id: 'blue-gray', label: 'Azul y gris',      bg: '#f0f4f8', primary: '#2563eb' },
      { id: 'emerald',   label: 'Verde esmeralda',   bg: '#f0fdf6', primary: '#059669' },
      { id: 'warm-gray', label: 'Gris cálido',       bg: '#fafaf9', primary: '#c2853a' },
      { id: 'purple',    label: 'Morado elegante',   bg: '#f5f0ff', primary: '#7c3aed' },
      { id: 'petrol',    label: 'Azul petróleo',     bg: '#f0f7fa', primary: '#0891b2' },
    ];
    const _tp = document.createElement('div');
    _tp.id = 'theme-picker-dropdown';
    _tp.style.cssText = 'position:fixed;right:8px;top:44px;background:var(--clr-surface);border:1px solid var(--clr-border);border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.18);padding:6px;z-index:var(--z-dropdown);min-width:190px;display:none';
    _tp.innerHTML = _THEMES.map(th => `<button class="theme-opt" data-tid="${th.id}" style="display:flex;align-items:center;gap:10px;width:100%;padding:7px 10px;border:none;background:transparent;cursor:pointer;border-radius:6px;font-size:12px;color:var(--clr-text);font-family:var(--font-ui);text-align:left"><span style="display:inline-flex;gap:3px;flex-shrink:0"><span style="width:14px;height:14px;border-radius:3px;background:${th.bg};border:1px solid rgba(0,0,0,.12);display:inline-block"></span><span style="width:14px;height:14px;border-radius:3px;background:${th.primary};display:inline-block"></span></span><span>${th.label}</span></button>`).join('');
    document.body.appendChild(_tp);
    _tp.addEventListener('click', e => {
      const btn = /** @type {HTMLElement} */ (e.target)?.closest?.('.theme-opt');
      if (!btn) return;
      const tid = /** @type {HTMLElement} */ (btn).dataset.tid;
      if (!tid) return;
      document.documentElement.setAttribute('data-theme', tid);
      try { localStorage.setItem('app-theme', tid); } catch { /* ignore */ }
      _tp.style.display = 'none';
    });
    document.addEventListener('click', e => {
      const tgt = /** @type {HTMLElement} */ (e.target);
      if (!_tp.contains(tgt) && tgt.id !== 'btn-theme') _tp.style.display = 'none';
    }, true);
    document.getElementById('btn-theme')?.addEventListener('click', e => {
      e.stopPropagation();
      _tp.style.display = _tp.style.display === 'none' ? 'block' : 'none';
    });
    try { const s = localStorage.getItem('app-theme'); if (s) document.documentElement.setAttribute('data-theme', s); } catch { /* ignore */ }
  }

  document.getElementById('btn-resources')?.addEventListener('click', () => {
    const selectedId = appState.state.selectedTaskId;
    if (selectedId) {
      // Abrir detalle de actividad y desplazarse a la sección de recursos
      _openTaskDetail(selectedId).then(() => {
        setTimeout(() => {
          document.getElementById('tdp-resources-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 120);
      });
    } else {
      _openResourceManager();
    }
  });

  document.getElementById('btn-calendar')?.addEventListener('click', () => _openCalendarManager());
  document.getElementById('btn-gantt-fit')?.addEventListener('click',      () => _ganttCanvas?.fitToView());
  document.getElementById('btn-gantt-zoom-in')?.addEventListener('click',  () => _ganttCanvas?.zoomIn());
  document.getElementById('btn-gantt-zoom-out')?.addEventListener('click', () => _ganttCanvas?.zoomOut());

  // ---- Línea base ----
  {

    const dlg         = /** @type {HTMLDialogElement} */ (document.getElementById('dlg-baseline'));
    const listEl      = document.getElementById('bl-list');
    const emptyMsg    = document.getElementById('bl-empty-msg');
    const activeInd   = document.getElementById('bl-active-indicator');
    const activeName  = document.getElementById('bl-active-name');
    const nameInput   = /** @type {HTMLInputElement} */ (document.getElementById('bl-name-input'));

    if (dlg) _makeDraggable(dlg, '[data-drag-handle]');

    async function _refreshBaselineList() {
      const pid = appState.state.project?.id;
      if (!pid || !listEl) return;
      const rows = await listBaselines(pid);
      if (emptyMsg) emptyMsg.style.display = rows.length ? 'none' : 'block';

      listEl.innerHTML = rows.map(b => {
        const isActive  = b.id === _activeBaselineId;
        const isPrimary = !!b.is_primary;
        const primaryBadge = isPrimary
          ? `<span title="Línea base primaria (plan aprobado)" style="font-size:13px;line-height:1" aria-label="Línea base primaria">⭐</span>`
          : `<button class="btn btn-ghost btn-sm" data-bl-primary="${b.id}" title="Marcar como línea base primaria" style="opacity:.5;font-size:12px;padding:0 4px" aria-label="Marcar como primaria">☆</button>`;
        const activeClass = isActive ? 'background:var(--clr-primary-subtle,#eef2ff);border-radius:4px;' : '';
        return `
        <div class="bl-row" style="display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid var(--clr-border-2);${activeClass}">
          ${primaryBadge}
          <span style="flex:1;font-size:var(--text-sm);color:var(--clr-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_escAttr(b.name)}">${_escHtml(b.name)}${isActive ? ' <span style="font-size:10px;color:var(--clr-primary)">▶ activa</span>' : ''}</span>
          <span style="font-size:var(--text-xs);color:var(--clr-text-3);white-space:nowrap">${b.created_at.slice(0,10)}</span>
          <button class="btn btn-ghost btn-sm" data-bl-apply="${b.id}" data-bl-name="${_escAttr(b.name)}" data-bl-primary="${isPrimary}" title="Aplicar como referencia de comparación (P6: Set as Primary)" style="font-size:13px;padding:0 5px" aria-label="Aplicar línea base">📌</button>
          <button class="btn btn-ghost btn-sm" data-bl-rename="${b.id}" data-bl-cur-name="${_escAttr(b.name)}" title="Renombrar" style="font-size:13px;padding:0 5px" aria-label="Renombrar">✏</button>
          <button class="btn btn-ghost btn-sm" data-bl-delete="${b.id}" title="Eliminar línea base" style="font-size:13px;padding:0 5px" aria-label="Eliminar">🗑</button>
        </div>`;
      }).join('');

      // Aplicar
      listEl.querySelectorAll('[data-bl-apply]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const el        = /** @type {HTMLElement} */ (btn);
          const id        = el.dataset.blApply;
          const name      = el.dataset.blName;
          const isPrimary = el.dataset.blPrimary === 'true';
          _activeBaselineId   = id;
          _activeBaselineName = name;
          const data = await loadBaselineData(id);
          appState.setBaselineData(data);
          appState.setBaselineMeta({ id, name, isPrimary });
          if (activeInd) activeInd.style.display = 'block';
          if (activeName) {
            activeName.textContent = name + (isPrimary ? ' ⭐' : '');
          }
          dlg?.close();
          _showToast('Línea base aplicada — varianzas visibles en la tabla', 'success');
        });
      });

      // Marcar como primaria
      listEl.querySelectorAll('[data-bl-primary]').forEach(btn => {
        if (/** @type {HTMLElement} */ (btn).tagName !== 'BUTTON') return;
        btn.addEventListener('click', async () => {
          const id = /** @type {HTMLElement} */ (btn).dataset.blPrimary;
          await setPrimaryBaseline(pid, id);
          // Si era la activa, actualizar meta
          if (id === _activeBaselineId) {
            appState.setBaselineMeta({ id, name: _activeBaselineName, isPrimary: true });
            if (activeName) activeName.textContent = _activeBaselineName + ' ⭐';
          }
          await _refreshBaselineList();
          _showToast('Línea base primaria definida', 'success');
        });
      });

      // Eliminar
      listEl.querySelectorAll('[data-bl-delete]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = /** @type {HTMLElement} */ (btn).dataset.blDelete;
          await deleteBaseline(id);
          if (id === _activeBaselineId) {
            _activeBaselineId = null;
            _activeBaselineName = '';
            appState.setBaselineData(null);
            appState.setBaselineMeta(null);
            if (activeInd) activeInd.style.display = 'none';
          }
          await _refreshBaselineList();
        });
      });

      // Renombrar
      listEl.querySelectorAll('[data-bl-rename]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const el  = /** @type {HTMLElement} */ (btn);
          const id  = el.dataset.blRename;
          const cur = el.dataset.blCurName || '';
          const newN = prompt('Nuevo nombre para la línea base:', cur);
          if (newN === null || !newN.trim()) return;
          try {
            await renameBaseline(id, newN.trim());
            if (id === _activeBaselineId) {
              _activeBaselineName = newN.trim();
              if (activeName) activeName.textContent = newN.trim() + (/** @type {any} */ (appState.state.baselineMeta)?.isPrimary ? ' ⭐' : '');
            }
            await _refreshBaselineList();
            _showToast('Línea base renombrada', 'success');
          } catch (err) {
            _showToast('Error: ' + /** @type {Error} */ (err).message, 'error');
          }
        });
      });
    }

    document.getElementById('btn-baseline')?.addEventListener('click', async () => {
      await _refreshBaselineList();
      if (activeInd) activeInd.style.display = _activeBaselineId ? 'block' : 'none';
      if (activeName) activeName.textContent = _activeBaselineName;
      dlg?.showModal();
    });
    document.getElementById('dlg-bl-close')?.addEventListener('click', () => dlg?.close());
    document.getElementById('dlg-bl-print')?.addEventListener('click', async () => {
      const pid = appState.state.project?.id;
      const projName = appState.state.project?.name || '';
      if (!pid) { _showToast('No hay proyecto activo', 'warn'); return; }
      const rows = await listBaselines(pid);
      const activeId = _activeBaselineId;
      const trs = rows.map(b => {
        const isPrimary = !!b.is_primary;
        const isActive  = b.id === activeId;
        return `<tr style="border-bottom:1px solid #eee">
          <td style="padding:7px 10px;font-weight:500">${_escHtml(b.name)}</td>
          <td style="padding:7px 10px;text-align:center">${isPrimary ? '⭐ Primaria' : ''}</td>
          <td style="padding:7px 10px;text-align:center">${isActive ? '▶ Activa' : ''}</td>
          <td style="padding:7px 10px;text-align:center">${b.created_at.slice(0,10)}</td>
        </tr>`;
      }).join('');
      _printToPdf('Líneas base', `
        <h1 style="font-size:18px;margin-bottom:4px">Gestión de Líneas Base</h1>
        <p style="color:#666;font-size:12px;margin-bottom:16px">Proyecto: ${_escHtml(projName)} · Total: ${rows.length}</p>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#f5f5f5">
            <th style="padding:7px 10px;text-align:left;border-bottom:2px solid #ddd">Nombre</th>
            <th style="padding:7px 10px;text-align:center;border-bottom:2px solid #ddd">Tipo</th>
            <th style="padding:7px 10px;text-align:center;border-bottom:2px solid #ddd">Estado</th>
            <th style="padding:7px 10px;text-align:center;border-bottom:2px solid #ddd">Creada</th>
          </tr></thead>
          <tbody>${trs || '<tr><td colspan="4" style="padding:8px;text-align:center;color:#999">Sin líneas base guardadas</td></tr>'}</tbody>
        </table>`);
    });
    document.getElementById('btn-bl-save')?.addEventListener('click', async () => {
      const name = nameInput?.value.trim() || '';
      if (!appState.state.project) { _showToast('Abre un proyecto primero', 'warn'); return; }
      if (!appState.state.cpmResult) { _showToast('CPM aún calculando…', 'warn'); return; }
      try {
        await saveBaseline(name || `Línea base ${new Date().toISOString().slice(0,10)}`);
        if (nameInput) nameInput.value = '';
        await _refreshBaselineList();
        _showToast('Línea base guardada', 'success');
      } catch (err) {
        _showToast('Error al guardar: ' + err.message, 'error');
      }
    });
    document.getElementById('btn-bl-clear')?.addEventListener('click', () => {
      _activeBaselineId = null;
      _activeBaselineName = '';
      appState.setBaselineData(null);
      appState.setBaselineMeta(null);
      if (activeInd) activeInd.style.display = 'none';
      _showToast('Línea base limpiada', 'success');
    });
  }

  // ---- Comparar con línea base ----
  document.getElementById('btn-baseline-compare')?.addEventListener('click', async () => {
    const { project, cpmResult } = appState.state;
    if (!project) { _showToast('Abre un proyecto primero', 'warn'); return; }
    if (!cpmResult) { _showToast('CPM aún calculando…', 'warn'); return; }
    await _openBaselineCompareModal();
  });

  let _blcAutoProject = null;
  async function _openBaselineCompareModal() {
    const { project, tasks, cpmResult } = appState.state;
    if (!project || !cpmResult) return;

    const baselines = await listBaselines(project.id);
    // Primera vez en el proyecto: comparar con la línea base principal (o la más reciente)
    if (_blcAutoProject !== project.id && baselines.length && !isBaselineCompareEnabled()) {
      _blcAutoProject = project.id;
      const def = baselines.find(b => b.is_primary) ?? baselines[0];
      try { await enableBaselineCompare(def.id); } catch { /* sin datos de línea base */ }
    }
    _blcAutoProject = project.id;

    let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-baseline-compare'));
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'dlg-baseline-compare';
      dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:760px;max-width:96vw;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden';
      dlg.setAttribute('role', 'dialog');
      dlg.setAttribute('aria-modal', 'true');
      document.body.appendChild(dlg);
      dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
    }

    const activeId = getActiveBaselineId();
    const compareEnabled = isBaselineCompareEnabled();

    dlg.innerHTML = `
      <div data-drag-handle style="display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);cursor:move;flex-shrink:0">
        <span style="font-size:20px">📊</span>
        <div style="flex:1">
          <div style="font-size:14px;font-weight:700;color:var(--clr-text)">Comparar con Línea Base</div>
          <div style="font-size:11px;color:var(--clr-text-3)">Selecciona una línea base para comparar en el Gantt</div>
        </div>
        ${compareEnabled ? '<button id="dlg-blc-disable" class="btn btn-ghost btn-sm" style="color:var(--clr-danger)">⊘ Desactivar comparación</button>' : ''}
        <button id="dlg-blc-print" class="btn btn-ghost btn-sm">🖨 Imprimir</button>
        <button id="dlg-blc-close" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar">✕</button>
      </div>
      <div style="padding:14px 18px;max-height:72vh;overflow-y:auto">
        ${!baselines.length ? '<p style="color:var(--clr-text-3);font-size:13px;padding:12px 0">No hay líneas base guardadas. Guarda una línea base primero.</p>' : `
          <div id="dlg-blc-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">
            ${baselines.map(b => {
              const isActive = b.id === activeId && compareEnabled;
              return `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border:1px solid ${isActive?'var(--clr-primary)':'var(--clr-border)'};border-radius:8px;background:${isActive?'var(--clr-primary-subtle,#eef2ff)':'var(--clr-surface-2,#f8f9fa)'}">
                <div style="flex:1">
                  <div style="font-size:13px;font-weight:600;color:var(--clr-text)">${_escHtml(b.name)}${b.is_primary?' ⭐':''}</div>
                  <div style="font-size:11px;color:var(--clr-text-3)">Creada: ${b.created_at.slice(0,10)}${isActive?' · <span style="color:var(--clr-primary);font-weight:600">▶ Comparando</span>':''}</div>
                </div>
                <button class="btn btn-sm ${isActive?'btn-ghost':'btn-primary'}" data-blc-select="${_escAttr(b.id)}" style="${isActive?'color:var(--clr-text-3)':''}">
                  ${isActive?'✓ Activa':'Comparar'}
                </button>
              </div>`;
            }).join('')}
          </div>
          <div id="dlg-blc-variance" style="display:${activeId && compareEnabled ? 'block' : 'none'}">
            <h3 style="font-size:13px;font-weight:700;color:var(--clr-text-2);margin-bottom:10px">Tabla de Varianzas vs Línea Base Activa</h3>
            <div style="overflow-x:auto">
              <table id="dlg-blc-table" style="width:100%;border-collapse:collapse;font-size:12px">
                <thead><tr style="background:var(--clr-surface-2)">
                  <th style="padding:7px 10px;text-align:left;border-bottom:2px solid var(--clr-border)">Actividad</th>
                  <th style="padding:7px 10px;text-align:center;border-bottom:2px solid var(--clr-border)">BL Inicio</th>
                  <th style="padding:7px 10px;text-align:center;border-bottom:2px solid var(--clr-border)">Act. Inicio</th>
                  <th style="padding:7px 10px;text-align:center;border-bottom:2px solid var(--clr-border)">ΔI</th>
                  <th style="padding:7px 10px;text-align:center;border-bottom:2px solid var(--clr-border)">BL Fin</th>
                  <th style="padding:7px 10px;text-align:center;border-bottom:2px solid var(--clr-border)">Act. Fin</th>
                  <th style="padding:7px 10px;text-align:center;border-bottom:2px solid var(--clr-border)">ΔF</th>
                  <th style="padding:7px 10px;text-align:center;border-bottom:2px solid var(--clr-border)">ΔD</th>
                </tr></thead>
                <tbody id="dlg-blc-tbody"></tbody>
              </table>
            </div>
          </div>`}
      </div>`;

    _makeDraggable(dlg, '[data-drag-handle]');
    dlg.querySelector('#dlg-blc-close')?.addEventListener('click', () => dlg.close());
    dlg.querySelector('#dlg-blc-disable')?.addEventListener('click', () => {
      disableBaselineCompare();
      const btn = document.getElementById('btn-baseline-compare');
      btn?.setAttribute('aria-pressed', 'false');
      btn?.classList.remove('active');
      _ganttCanvas?.render?.();
      _showToast('Comparación de línea base desactivada', 'info');
      dlg.close();
    });

    const _renderVariance = async (blId) => {
      const blData = await (async () => {
        const { default: _lbd } = await import('./baseline.js').catch(() => ({}));
        return loadBaselineData(blId);
      })();
      const tbody = dlg.querySelector('#dlg-blc-tbody');
      if (!tbody || !cpmResult?.tasks) return;
      // Índices laborables → fechas del calendario del proyecto
      const { calendar: _bc, calExceptions: _bx } = appState.state;
      const _bCal = new Calendar({ work_week: _bc?.work_week ?? [1,2,3,4,5], exceptions: (_bx ?? []).filter(e => !e.deleted_at) });
      const _bStart = isoToDate(project.start_date || new Date().toISOString().slice(0, 10));
      const _fd = (d) => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
      const _ds = (i) => _fd(_bCal.idxToDate(i, _bStart));
      const _df = (ef, es) => ef <= es ? _ds(es) : _fd(_bCal.finishDate(ef, _bStart)); // hito: mismo día
      const rows = [];
      for (const [tid, cpm] of cpmResult.tasks) {
        const task = tasks.get(tid);
        if (!task || task.deleted_at || cpm.is_summary) continue;
        const bl = blData?.get(tid);
        if (!bl) continue;
        const di = cpm.es - bl.es;
        const df = cpm.ef - bl.ef;
        const dd = (cpm.ef - cpm.es) - (bl.ef - bl.es);
        const clrI = di === 0 ? '' : di > 0 ? 'color:#D32F2F' : 'color:#388E3C';
        const clrF = df === 0 ? '' : df > 0 ? 'color:#D32F2F' : 'color:#388E3C';
        const clrD = dd === 0 ? '' : dd > 0 ? 'color:#D32F2F' : 'color:#388E3C';
        rows.push(`<tr style="border-bottom:1px solid var(--clr-border-2)">
          <td style="padding:6px 10px;font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_escHtml(task.name)}</td>
          <td style="padding:6px 10px;text-align:center">${_ds(bl.es)}</td>
          <td style="padding:6px 10px;text-align:center">${_ds(cpm.es)}</td>
          <td style="padding:6px 10px;text-align:center;font-weight:600;${clrI}">${di >= 0 ? '+' : ''}${di}</td>
          <td style="padding:6px 10px;text-align:center">${_df(bl.ef, bl.es)}</td>
          <td style="padding:6px 10px;text-align:center">${_df(cpm.ef, cpm.es)}</td>
          <td style="padding:6px 10px;text-align:center;font-weight:600;${clrF}">${df >= 0 ? '+' : ''}${df}</td>
          <td style="padding:6px 10px;text-align:center;font-weight:600;${clrD}">${dd >= 0 ? '+' : ''}${dd}</td>
        </tr>`);
      }
      tbody.innerHTML = rows.join('') || '<tr><td colspan="8" style="padding:10px;text-align:center;color:var(--clr-text-3)">Sin datos de varianza</td></tr>';
    };

    if (activeId && compareEnabled) {
      _renderVariance(activeId);
    }

    dlg.querySelectorAll('[data-blc-select]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const blId = /** @type {HTMLElement} */ (btn).dataset.blcSelect;
        await enableBaselineCompare(blId);
        const tbtn = document.getElementById('btn-baseline-compare');
        tbtn?.setAttribute('aria-pressed', 'true');
        tbtn?.classList.add('active');
        _ganttCanvas?.render?.();
        _showToast('Comparando con: ' + (baselines.find(b => b.id === blId)?.name ?? ''), 'success');
        dlg.close();
        await _openBaselineCompareModal();
      });
    });

    dlg.querySelector('#dlg-blc-print')?.addEventListener('click', async () => {
      const blId = getActiveBaselineId();
      const blName = baselines.find(b => b.id === blId)?.name ?? 'sin definir';
      const tbl = dlg.querySelector('#dlg-blc-table');
      _printToPdf('Comparación de Línea Base', `
        <h1 style="font-size:18px;margin-bottom:4px">Comparación de Línea Base</h1>
        <p style="color:#666;font-size:12px;margin-bottom:16px">Proyecto: ${_escHtml(project.name)} · Línea base: ${_escHtml(blName)}</p>
        ${tbl?.outerHTML ?? '<p>Sin datos de comparación activos.</p>'}`);
    });

    dlg.showModal();
  }

  // ---- Menú etiquetas de barras Gantt ----
  const _barLabelsBtn  = document.getElementById('btn-bar-labels');
  const _barLabelsMenu = document.getElementById('bar-labels-menu');
  _barLabelsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = _barLabelsMenu?.hidden === false;
    _barLabelsMenu && (_barLabelsMenu.hidden = open);
    _barLabelsBtn.setAttribute('aria-expanded', String(!open));
  });
  _barLabelsMenu?.addEventListener('change', () => {
    const checked = [..._barLabelsMenu.querySelectorAll('input:checked')].map(/** @type {HTMLInputElement} */ (i) => i.value);
    const labels  = checked.length ? checked : ['name'];
    try { localStorage.setItem('gantt-bar-labels', JSON.stringify(labels)); } catch {}
    _ganttCanvas?.setBarLabels(labels);
    _syncBarLabelsUI(labels);
  });
  document.addEventListener('click', (e) => {
    if (_barLabelsMenu && !_barLabelsMenu.hidden && !document.getElementById('bar-labels-wrap')?.contains(/** @type {Node} */ (e.target))) {
      _barLabelsMenu.hidden = true;
      _barLabelsBtn?.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _barLabelsMenu && !_barLabelsMenu.hidden) {
      _barLabelsMenu.hidden = true;
      _barLabelsBtn?.setAttribute('aria-expanded', 'false');
      _barLabelsBtn?.focus();
    }
  });
  _barLabelsMenu?.addEventListener('keydown', e => {
    const items = /** @type {HTMLElement[]} */ ([..._barLabelsMenu.querySelectorAll('input[type="checkbox"]')]);
    const idx = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'ArrowDown') { items[(idx + 1) % items.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { items[(idx - 1 + items.length) % items.length]?.focus(); e.preventDefault(); }
  });

  // ---- Menú columnas tabla EDT ----
  const _wbsColsBtn  = document.getElementById('btn-wbs-cols');
  const _wbsColsMenu = document.getElementById('wbs-cols-menu');
  _wbsColsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = _wbsColsMenu?.hidden === false;
    _wbsColsMenu && (_wbsColsMenu.hidden = open);
    _wbsColsBtn.setAttribute('aria-expanded', String(!open));
  });
  _wbsColsMenu?.addEventListener('change', () => {
    const checked = [..._wbsColsMenu.querySelectorAll('input:checked')].map(/** @type {HTMLInputElement} */ (i) => i.value);
    const visible = checked.length ? checked : ['name'];
    if (!visible.includes('name')) visible.push('name');
    try { localStorage.setItem('wbs-col-visibility', JSON.stringify(visible)); } catch {}
    _applyWbsColVisibility(visible);
  });
  document.addEventListener('click', (e) => {
    if (_wbsColsMenu && !_wbsColsMenu.hidden && !document.getElementById('wbs-cols-wrap')?.contains(/** @type {Node} */ (e.target))) {
      _wbsColsMenu.hidden = true;
      _wbsColsBtn?.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _wbsColsMenu && !_wbsColsMenu.hidden) {
      _wbsColsMenu.hidden = true;
      _wbsColsBtn?.setAttribute('aria-expanded', 'false');
      _wbsColsBtn?.focus();
    }
  });
  _wbsColsMenu?.addEventListener('keydown', e => {
    const items = /** @type {HTMLElement[]} */ ([..._wbsColsMenu.querySelectorAll('input[type="checkbox"]')]);
    const idx = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'ArrowDown') { items[(idx + 1) % items.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { items[(idx - 1 + items.length) % items.length]?.focus(); e.preventDefault(); }
  });


  document.getElementById('btn-changelog')?.addEventListener('click', () => {
    const panel = document.getElementById('changelog-panel');
    const btn   = document.getElementById('btn-changelog');
    const isOpen = panel?.classList.toggle('open');
    btn?.setAttribute('aria-pressed', String(isOpen));
    if (isOpen) {
      _changeLogPanel?.refresh();
      btn.style.background = 'var(--clr-primary)';
      btn.style.color = '#fff';
    } else {
      btn.style.background = '';
      btn.style.color = '';
    }
  });


  // ---- Importar XER (Primavera P6) ----
  document.getElementById('import-xer-file')?.addEventListener('change', async (e) => {
    const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const { project, tasks, deps, calendar, calExceptions, warnings } = parseXer(text);
      // Importar como proyecto nuevo
      await dbPut('projects', project);
      if (calendar)    await dbPut('calendars', calendar);
      if (calExceptions?.length) await Promise.all(calExceptions.map(ex => dbPut('calendar_exceptions', ex)));
      await Promise.all(tasks.map(t => dbPut('tasks', t)));
      await Promise.all(deps.map(d => dbPut('task_dependencies', d)));
      if (warnings.length) _showToast(`XER importado con ${warnings.length} advertencias`, 'warn');
      else _showToast('XER importado correctamente', 'success');
      // Recargar lista de proyectos
      await _renderProjectList();
    } catch (err) {
      _showToast('Error al importar XER: ' + err.message, 'error');
    }
    /** @type {HTMLInputElement} */ (e.target).value = '';
  });

  // ---- Registro de Riesgos ----
  let _riskPanel = null;
  document.getElementById('btn-risk-panel-close')?.addEventListener('click', () => {
    const overlay = document.getElementById('panel-risk-register');
    if (overlay) overlay.style.display = 'none';
  });

  // ---- Nivelación de recursos ----
  document.getElementById('btn-leveling-panel-close')?.addEventListener('click', () => {
    const panel = document.getElementById('panel-resource-leveling');
    if (panel) panel.style.display = 'none';
  });
  document.getElementById('btn-leveling-print')?.addEventListener('click', () => {
    const c = document.getElementById('resource-leveling-container');
    _printToPdf('Nivelación de Recursos', `<h1>Nivelación de Recursos</h1>${c?.innerHTML ?? '<p>Sin datos.</p>'}`);
  });
  _makeDraggable(document.getElementById('rl-card'), '[data-drag-handle]');

  // ---- Monte Carlo ----
  _mcPanel = null;
  document.getElementById('dlg-mc-close')?.addEventListener('click', () => {
    const dlg = /** @type {HTMLDialogElement} */ (document.getElementById('dlg-monte-carlo'));
    dlg?.close?.() ?? (dlg && (dlg.style.display = 'none'));
  });
  document.getElementById('dlg-mc-print')?.addEventListener('click', async () => {
    // Sin simulación previa: ejecutarla con los valores por defecto antes de imprimir
    if (_mcPanel && !_mcPanel._lastResult) await _mcPanel._runSimulation();
    const body = document.getElementById('monte-carlo-container');
    const _mcCss = document.getElementById('mc-styles')?.textContent ?? '';
    const _mcVars = ':root{--mc-accent:#2563eb;--mc-kpi-bg:#f3f4f6;--mc-hist-fill:#60a5fa;--mc-p80-color:#dc2626;--mc-fg:#333;--mc-border:#e5e7eb;--mc-warn:#b45309;--mc-surface:#f5f7ff;--mc-hist-axis-stroke:#aaa;--mc-tick-fill:#666}';
    _printToPdf('Simulación Monte Carlo', `<style>${_mcCss}\n${_mcVars}</style><h1>Simulación Monte Carlo</h1>${body?.innerHTML ?? ''}`);
  });
  _makeDraggable(document.getElementById('dlg-monte-carlo'), '[data-drag-handle]');

  // ---- Lookahead ----
  let _lookaheadPanel = /** @type {LookaheadPanel|null} */ (null);
  const _openPanel = (overlayId, containerId, PanelClass, panelRef, btnId) => {
    const overlay = /** @type {HTMLElement} */ (document.getElementById(overlayId));
    const container = /** @type {HTMLElement} */ (document.getElementById(containerId));
    if (!overlay || !container) return null;
    if (overlay.style.display !== 'none' && overlay.style.display !== '') {
      overlay.style.display = 'none';
      document.getElementById(btnId)?.setAttribute('aria-pressed', 'false');
      return null;
    }
    overlay.style.display = 'flex';
    document.getElementById(btnId)?.setAttribute('aria-pressed', 'true');
    if (!panelRef) panelRef = new PanelClass(container);
    else panelRef.refresh?.();
    return panelRef;
  };

  document.getElementById('btn-lookahead')?.addEventListener('click', () => {
    const { project } = appState.state;
    if (!project) { _showToast('Abre un proyecto primero', 'warn'); return; }
    _lookaheadPanel = _openPanel('panel-lookahead', 'lookahead-container', LookaheadPanel, _lookaheadPanel, 'btn-lookahead');
  });
  document.getElementById('btn-lookahead-close')?.addEventListener('click', () => {
    document.getElementById('panel-lookahead')?.style && (document.getElementById('panel-lookahead').style.display = 'none');
    document.getElementById('btn-lookahead')?.setAttribute('aria-pressed', 'false');
  });

  // ---- Lookahead Detallado (Last Planner System) ----
  let _ladPanel = /** @type {LookaheadDetailedPanel|null} */ (null);
  document.getElementById('btn-lookahead-detailed')?.addEventListener('click', () => {
    const { project } = appState.state;
    if (!project) { _showToast('Abre un proyecto primero', 'warn'); return; }
    _ladPanel = _openPanel('panel-lookahead-detailed', 'lookahead-detailed-container', LookaheadDetailedPanel, _ladPanel, 'btn-lookahead-detailed');
  });
  document.getElementById('btn-lad-close')?.addEventListener('click', () => {
    const p = document.getElementById('panel-lookahead-detailed');
    if (p) p.style.display = 'none';
    document.getElementById('btn-lookahead-detailed')?.setAttribute('aria-pressed', 'false');
  });

  // ---- Curva S ----
  let _curvaSPanel = /** @type {CurvaSPanel|null} */ (null);
  document.getElementById('btn-curva-s')?.addEventListener('click', () => {
    const { project } = appState.state;
    if (!project) { _showToast('Abre un proyecto primero', 'warn'); return; }
    _curvaSPanel = _openPanel('panel-curva-s', 'curva-s-container', CurvaSPanel, _curvaSPanel, 'btn-curva-s');
  });
  document.getElementById('btn-curva-s-close')?.addEventListener('click', () => {
    document.getElementById('panel-curva-s')?.style && (document.getElementById('panel-curva-s').style.display = 'none');
    document.getElementById('btn-curva-s')?.setAttribute('aria-pressed', 'false');
  });

  // ---- Notificaciones ----
  let _notifPanel = /** @type {NotificationsPanel|null} */ (null);
  document.getElementById('btn-notifications')?.addEventListener('click', () => {
    const { project } = appState.state;
    if (!project) { _showToast('Abre un proyecto primero', 'warn'); return; }
    _notifPanel = _openPanel('panel-notifications', 'notifications-container', NotificationsPanel, _notifPanel, 'btn-notifications');
  });
  document.getElementById('btn-notif-close')?.addEventListener('click', () => {
    document.getElementById('panel-notifications')?.style && (document.getElementById('panel-notifications').style.display = 'none');
    document.getElementById('btn-notifications')?.setAttribute('aria-pressed', 'false');
  });

  // ---- Diccionario WBS ----
  let _wbsDictPanel = /** @type {WbsDictionaryPanel|null} */ (null);
  document.getElementById('btn-wbs-dictionary')?.addEventListener('click', () => {
    const { project } = appState.state;
    if (!project) { _showToast('Abre un proyecto primero', 'warn'); return; }
    _wbsDictPanel = _openPanel('panel-wbs-dictionary', 'wbs-dictionary-container', WbsDictionaryPanel, _wbsDictPanel, 'btn-wbs-dictionary');
  });
  document.getElementById('btn-wbs-dict-close')?.addEventListener('click', () => {
    document.getElementById('panel-wbs-dictionary')?.style && (document.getElementById('panel-wbs-dictionary').style.display = 'none');
    document.getElementById('btn-wbs-dictionary')?.setAttribute('aria-pressed', 'false');
  });

  // ---- Reporte PDF ----
  document.getElementById('btn-pdf-report')?.addEventListener('click', () => {
    const result = generatePdfReport();
    if (!result.ok) _showToast(result.error ?? 'Error al generar reporte', 'error');
  });

  document.getElementById('btn-menu')?.addEventListener('click', () => {
    const panel = document.getElementById('explorer-panel');
    const overlay = document.getElementById('drawer-overlay');
    panel?.classList.toggle('open');
    overlay?.classList.toggle('visible');
  });
  document.getElementById('drawer-overlay')?.addEventListener('click', () => {
    document.getElementById('explorer-panel')?.classList.remove('open');
    document.getElementById('drawer-overlay')?.classList.remove('visible');
  });

  // ---- Pestañas inferiores (móvil ≤599 px) ----
  (function () {
    const tabs = document.querySelectorAll('#bottom-tabs .tab-btn');
    if (!tabs.length) return;
    const appEl    = document.getElementById('app');
    const explorer = document.getElementById('explorer-panel');
    const overlay  = document.getElementById('drawer-overlay');

    function _activateTab(idx) {
      tabs.forEach((b, i) => b.classList.toggle('active', i === idx));
      // Limpiar clases de vista
      appEl?.classList.remove('mobile-view-gantt', 'mobile-view-kpi');
      // Cerrar drawer del explorador si estaba abierto
      explorer?.classList.remove('open');
      overlay?.classList.remove('visible');
      switch (idx) {
        case 0: // Proyectos — abrir drawer lateral
          explorer?.classList.add('open');
          overlay?.classList.add('visible');
          break;
        case 1: // EDT — vista por defecto (sin clases extra)
          break;
        case 2: // Gantt
          appEl?.classList.add('mobile-view-gantt');
          break;
        case 3: // KPIs
          appEl?.classList.add('mobile-view-kpi');
          // Abrir panel EVM si aún no tiene contenido
          document.getElementById('btn-evm-view')?.click();
          break;
      }
    }

    tabs.forEach((btn, i) => btn.addEventListener('click', () => _activateTab(i)));

    // Al cerrar el drawer (overlay click o selección de proyecto), volver a tab EDT
    document.getElementById('drawer-overlay')?.addEventListener('click', () => {
      tabs.forEach((b, i) => b.classList.toggle('active', i === 1));
    });
  })();

  // ---- Menú Exportar ----
  const exportBtn  = document.getElementById('btn-export');
  const exportMenu = document.getElementById('export-menu');

  exportBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !exportMenu?.hidden;
    if (exportMenu) exportMenu.hidden = isOpen;
    exportBtn.setAttribute('aria-expanded', String(!isOpen));
  });

  // Cerrar menú al hacer clic fuera o con Escape / navegar con flechas
  document.addEventListener('click', () => {
    if (exportMenu && !exportMenu.hidden) {
      exportMenu.hidden = true;
      exportBtn?.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && exportMenu && !exportMenu.hidden) {
      exportMenu.hidden = true;
      exportBtn?.setAttribute('aria-expanded', 'false');
      exportBtn?.focus();
    }
  });
  exportMenu?.addEventListener('keydown', (e) => {
    if (exportMenu.hidden) return;
    const items = /** @type {HTMLElement[]} */ ([...exportMenu.querySelectorAll('button[data-action], label.menu-import-label')]);
    if (!items.length) return;
    const idx = items.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault(); items[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault(); items[items.length - 1].focus();
    }
  });

  exportMenu?.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('button[data-action]');
    if (!btn) return;
    exportMenu.hidden = true;
    exportBtn?.setAttribute('aria-expanded', 'false');

    const action = btn.dataset.action;
    const rows = _ganttCanvas ? _ganttScene.rows : [];

    switch (action) {
      case 'json':        exportJson();              break;
      case 'csv':         exportCsv();               break;
      case 'xml':         exportMspXml();            break;
      case 'svg':         exportSvg(rows);           break;
      case 'print-table': printWbsTable();           break;
      case 'print-gantt': printGantt(rows);          break;
      case 'print-pdf': {
        const result = generatePdfReport();
        if (!result.ok) _showToast(result.error ?? 'Error al generar reporte', 'error');
        break;
      }
      case 'col-config':  _showPrintColConfig();     break;
    }
  });

  // Importar JSON
  const _handleJsonImport = async (file) => {
    if (!file) return;
    try {
      const data = await importJson(file);
      await saveProjectSnapshot(data);
      await _loadProject(data.project.id);
      _renderProjectList();
      _showToast('Proyecto importado: ' + data.project.name, 'success');
    } catch (err) {
      _showToast('Error al importar: ' + err.message, 'error');
    }
  };
  document.getElementById('import-file')?.addEventListener('change', async (e) => {
    const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
    await _handleJsonImport(file);
    /** @type {HTMLInputElement} */ (e.target).value = '';
  });
  document.getElementById('sidebar-import-file')?.addEventListener('change', async (e) => {
    const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
    await _handleJsonImport(file);
    /** @type {HTMLInputElement} */ (e.target).value = '';
  });

  // Establecer título de impresión en el elemento #app
  const updatePrintTitle = () => {
    const { project } = appState.state;
    if (project) {
      document.getElementById('app')?.setAttribute('data-print-title',
        `${project.name} — Cronograma EDT — ${new Date().toLocaleDateString('es-PE')}`);
    }
  };
  appState.subscribe((_state, keys) => {
    if (!keys || keys.includes('project')) updatePrintTitle();
  });
  updatePrintTitle();
}

// ============================================================
// Arranque
// ============================================================

function _bindLinkMode() {
  const btn = document.getElementById('btn-link');
  if (!btn || btn.dataset.linkBound) return;
  btn.dataset.linkBound = '1';

  let _linkModeOn = false;

  btn.addEventListener('click', () => {
    _linkModeOn = !_linkModeOn;
    btn.setAttribute('aria-pressed', String(_linkModeOn));
    btn.classList.toggle('btn-active', _linkModeOn);
    btn.style.background = _linkModeOn ? 'var(--clr-primary, #1976D2)' : '';
    btn.style.color      = _linkModeOn ? '#fff' : '';
    _ganttCanvas?.setLinkMode(_linkModeOn);
  });

  document.addEventListener('gantt-add-dep', /** @type {any} */ async (e) => {
    const { predId, succId, type, lag } = e.detail;

    // Salir del modo enlace
    _linkModeOn = false;
    btn.setAttribute('aria-pressed', 'false');
    btn.classList.remove('btn-active');
    btn.style.background = '';
    btn.style.color      = '';
    _ganttCanvas?.setLinkMode(false);

    // Verificar que no exista ya la dependencia
    const existing = [...appState.state.deps.values()].find(
      d => !d.deleted_at && d.pred_id === predId && d.succ_id === succId
    );
    if (existing) { _showToast('Esa dependencia ya existe', 'warn'); return; }

    const dep = {
      id:          crypto.randomUUID(),
      project_id:  appState.state.project?.id ?? '',
      org_id:      authState.empresaActual?.org_id ?? null,
      pred_id:     predId,
      succ_id:     succId,
      type:        type ?? 'FS',
      lag_days:    lag  ?? 0,
      created_at:  new Date().toISOString(),
      updated_at:  new Date().toISOString(),
      deleted_at:  null,
    };
    appState.dispatch({ type: 'ADD_DEP', payload: { dep } });
    _showToast(`Dependencia ${type ?? 'FS'} creada`, 'success');
  });
}

// ============================================================
// Splitter arrastrable entre panel WBS y panel Gantt
// ============================================================

function _bindResizer() {
  const resizer    = document.getElementById('resizer-gantt');
  const ganttPanel = document.getElementById('gantt-panel');
  if (!resizer || !ganttPanel) return;
  if (resizer.dataset.bound) return;
  resizer.dataset.bound = '1';

  // Restaurar ancho guardado
  let saved = null;
  try { saved = localStorage.getItem('gantt-panel-width'); } catch {}
  if (saved) ganttPanel.style.width = saved;

  const _syncAria = () => {
    const w = Math.round(ganttPanel.getBoundingClientRect().width);
    resizer.setAttribute('aria-valuenow', String(w));
    resizer.setAttribute('aria-valuemax', String(Math.round(window.innerWidth - 280)));
  };
  _syncAria();

  let startX = 0, startW = 0, dragging = false;

  resizer.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    startX   = e.clientX;
    startW   = ganttPanel.getBoundingClientRect().width;
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  const _syncRtPanel = () => {
    const wbs = document.getElementById('wbs-panel');
    const rt  = document.getElementById('resource-table-panel');
    if (wbs && rt) rt.style.width = wbs.offsetWidth + 'px';
  };

  const _onMove = e => {
    if (!dragging) return;
    const dx = startX - e.clientX; // mover derecha → gantt se hace más pequeño
    const minW = 180;
    const maxW = window.innerWidth - 280;
    const newW = Math.max(minW, Math.min(maxW, startW + dx));
    ganttPanel.style.width = newW + 'px';
    _syncAria();
    _syncRtPanel();
    _ganttCanvas?.requestRender();
  };

  const _onUp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { localStorage.setItem('gantt-panel-width', ganttPanel.style.width); } catch {}
    _syncAria();
    // Forzar redibujado con el nuevo tamaño del canvas
    setTimeout(() => _ganttCanvas?.requestRender(), 50);
  };

  document.addEventListener('mousemove', _onMove);
  document.addEventListener('mouseup', _onUp);

  // Teclado: flechas para ajuste fino (ArrowLeft = más ancho Gantt, ArrowRight = más angosto)
  resizer.addEventListener('keydown', e => {
    const step = e.shiftKey ? 20 : 5;
    const w = ganttPanel.getBoundingClientRect().width;
    const minW = 180;
    const maxW = window.innerWidth - 280;
    if (e.key === 'ArrowLeft')  { ganttPanel.style.width = Math.min(maxW, w + step) + 'px'; e.preventDefault(); }
    if (e.key === 'ArrowRight') { ganttPanel.style.width = Math.max(minW, w - step) + 'px'; e.preventDefault(); }
    try { localStorage.setItem('gantt-panel-width', ganttPanel.style.width); } catch {}
    _syncAria();
    _ganttCanvas?.requestRender();
  });
}

// ── Horizontal resizer: Gantt / Histogram split ──
(function _bindResizerHistogram() {
  const rh   = document.getElementById('resizer-histogram');
  const rc   = document.getElementById('right-content');
  const ghEl = document.getElementById('gantt-host');
  const bs   = document.getElementById('bottom-split');
  if (!rh || !rc || !ghEl || !bs) return;

  let dragging = false, startY = 0, startGHH = 0;

  rh.addEventListener('mousedown', (e) => {
    dragging  = true;
    startY    = e.clientY;
    startGHH  = ghEl.getBoundingClientRect().height;
    document.body.style.cursor     = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const totalH = rc.getBoundingClientRect().height;
    const newGH  = Math.max(150, Math.min(totalH - 150, startGHH + (e.clientY - startY)));
    ghEl.style.flex   = 'none';
    ghEl.style.height = newGH + 'px';
    bs.style.height   = Math.max(150, totalH - newGH - 5) + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  });

  rh.addEventListener('touchstart', (e) => {
    dragging = true; startY = e.touches[0].clientY;
    startGHH = ghEl.getBoundingClientRect().height;
    e.preventDefault();
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const totalH = rc.getBoundingClientRect().height;
    const newGH  = Math.max(150, Math.min(totalH - 150, startGHH + (e.touches[0].clientY - startY)));
    ghEl.style.flex   = 'none';
    ghEl.style.height = newGH + 'px';
    bs.style.height   = Math.max(150, totalH - newGH - 5) + 'px';
  }, { passive: false });
  window.addEventListener('touchend', () => { dragging = false; });
})();

function _bindResizerExplorer() {
  const resizer  = document.getElementById('resizer-explorer');
  const explorer = document.getElementById('explorer-panel');
  if (!resizer || !explorer) return;
  if (resizer.dataset.bound) return;
  resizer.dataset.bound = '1';

  // Restaurar ancho guardado
  let saved = null;
  try { saved = localStorage.getItem('explorer-panel-width'); } catch {}
  if (saved) explorer.style.width = saved;

  const _syncAria = () => {
    const w = Math.round(explorer.getBoundingClientRect().width);
    resizer.setAttribute('aria-valuenow', String(w));
    resizer.setAttribute('aria-valuetext', `${w} píxeles`);
  };
  resizer.setAttribute('aria-valuemin', '160');
  resizer.setAttribute('aria-valuemax', '400');
  _syncAria();

  let startX = 0, startW = 0, dragging = false;

  resizer.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    startX   = e.clientX;
    startW   = explorer.getBoundingClientRect().width;
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  const _onMoveExp = e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const newW = Math.max(160, Math.min(400, startW + dx));
    explorer.style.width = newW + 'px';
    _syncAria();
  };

  const _onUpExp = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { localStorage.setItem('explorer-panel-width', explorer.style.width); } catch {}
    _syncAria();
  };

  document.addEventListener('mousemove', _onMoveExp);
  document.addEventListener('mouseup', _onUpExp);

  // Teclado: flechas para ajuste fino
  resizer.addEventListener('keydown', e => {
    const step = e.shiftKey ? 20 : 5;
    const w = explorer.getBoundingClientRect().width;
    if (e.key === 'ArrowRight') { explorer.style.width = Math.min(400, w + step) + 'px'; e.preventDefault(); }
    if (e.key === 'ArrowLeft')  { explorer.style.width = Math.max(160, w - step) + 'px'; e.preventDefault(); }
    try { localStorage.setItem('explorer-panel-width', explorer.style.width); } catch {}
    _syncAria();
  });
}

// ============================================================
// Organigrama de jerarquía (portafolio→programa→proyecto)
// ============================================================

// ============================================================
// Estructura de Proyectos — canvas libre
// ============================================================

/** Lee posiciones guardadas del lienzo */
function _ocGetPos() { try { return JSON.parse(localStorage.getItem('oc-pos') || '{}'); } catch { return {}; } }
function _getCpmNodePos() { const k='cpm-pos-'+(appState.state.project?.id??'x'); try{return JSON.parse(localStorage.getItem(k)||'{}')}catch{return{}} }
function _setCpmNodePos(m) { const k='cpm-pos-'+(appState.state.project?.id??'x'); try{localStorage.setItem(k,JSON.stringify(m))}catch{} }
/** Guarda posiciones */
function _ocSetPos(pos) { try { localStorage.setItem('oc-pos', JSON.stringify(pos)); } catch {} }

function _showOrgChart() {
  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-org-chart'));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-org-chart';
    dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:96vw;max-width:1400px;height:92vh;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden;position:fixed;top:4vh;left:max(0px,calc(50vw - 700px));margin:0;z-index:99999';
    dlg.dataset.ocNormal = dlg.style.cssText;
    dlg.setAttribute('aria-labelledby', 'oc-dlg-title');
    dlg.setAttribute('aria-modal', 'true');
    dlg.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;background:var(--clr-bg)">
        <div id="oc-dlg-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);flex-shrink:0;gap:8px;flex-wrap:wrap;cursor:move">
          <span id="oc-dlg-title" style="font-weight:700;font-size:15px">Estructura de Proyectos</span>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <button id="oc-add-pf"   class="btn btn-primary btn-sm">＋ Portafolio</button>
            <button id="oc-add-prog" class="btn btn-ghost btn-sm">＋ Programa</button>
            <button id="oc-add-proj" class="btn btn-ghost btn-sm">＋ Proyecto</button>
            <span style="width:1px;height:18px;background:var(--clr-border)"></span>
            <button id="oc-reset-layout" class="btn btn-ghost btn-sm" title="Restablecer posiciones" aria-label="Restablecer posiciones">↺ Organizar</button>
            <button id="oc-fit-view" class="btn btn-ghost btn-sm" title="Ajustar todo el contenido en la ventana" aria-label="Ajustar vista">⊞ Ajustar</button>
            <button id="oc-maximize" class="btn btn-ghost btn-sm" title="Maximizar ventana" aria-label="Maximizar">⛶</button>
            <button id="oc-print" class="btn btn-ghost btn-sm">🖨 Imprimir</button>
            <button id="btn-orgchart-close" class="btn btn-ghost btn-sm">✕ Cerrar</button>
          </div>
        </div>
        <div id="oc-viewport" style="flex:1;overflow:auto;overflow-x:auto;overflow-y:auto;position:relative;cursor:grab">
          <div id="oc-canvas" style="position:relative;width:3200px;height:2400px">
            <svg id="oc-svg-lines" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible"></svg>
          </div>
        </div>
      </div>
      <div id="oc-edit-overlay" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,0.35);z-index:20;align-items:center;justify-content:center">
        <div id="oc-edit-box" style="background:var(--clr-surface);border-radius:14px;padding:24px 26px;min-width:340px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.28);position:relative"></div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.setAttribute('aria-labelledby', 'oc-dlg-title');
    dlg.querySelector('#btn-orgchart-close')?.addEventListener('click', () => dlg?.close());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg?.close(); });

    // Drag-to-move ventana (header drag)
    { const hdr = dlg.querySelector('#oc-dlg-hdr');
      let _ox=0,_oy=0,_d=false;
      const onM=e=>{if(!_d)return;dlg.style.left=Math.max(0,e.clientX-_ox)+'px';dlg.style.top=Math.max(0,e.clientY-_oy)+'px';};
      const onU=()=>{_d=false;if(hdr)/** @type {HTMLElement} */(hdr).style.cursor='move';};
      hdr?.addEventListener('mousedown',e=>{if(/** @type {HTMLElement} */(e.target).closest('button'))return;const r=dlg.getBoundingClientRect();_ox=e.clientX-r.left;_oy=e.clientY-r.top;_d=true;/** @type {HTMLElement} */(hdr).style.cursor='grabbing';e.preventDefault();});
      document.addEventListener('mousemove',onM);document.addEventListener('mouseup',onU);
      dlg.addEventListener('close', () => { document.removeEventListener('mousemove', onM); document.removeEventListener('mouseup', onU); }, { once: true });
    }

    // Pan canvas with mouse drag inside viewport
    { const vp = /** @type {HTMLElement|null} */ (dlg.querySelector('#oc-viewport'));
      let _px=0,_py=0,_pd=false;
      vp?.addEventListener('mousedown',e=>{if(/** @type {HTMLElement} */(e.target).closest('.oc-card,.oc-btn-edit,.oc-btn-add'))return;_px=e.clientX+vp.scrollLeft;_py=e.clientY+vp.scrollTop;_pd=true;vp.style.cursor='grabbing';e.preventDefault();});
      vp?.addEventListener('mousemove',e=>{if(!_pd)return;vp.scrollLeft=_px-e.clientX;vp.scrollTop=_py-e.clientY;});
      vp?.addEventListener('mouseup',()=>{_pd=false;vp.style.cursor='grab';});
      vp?.addEventListener('mouseleave',()=>{_pd=false;vp.style.cursor='grab';});
    }

    // Maximize / restore
    dlg.querySelector('#oc-maximize')?.addEventListener('click', () => {
      const btn = /** @type {HTMLButtonElement} */ (dlg.querySelector('#oc-maximize'));
      if (dlg.dataset.ocMaximized === '1') {
        dlg.style.cssText = dlg.dataset.ocNormal ?? '';
        dlg.dataset.ocMaximized = '0';
        if (btn) btn.title = 'Maximizar ventana';
        if (btn) btn.textContent = '⛶';
      } else {
        dlg.style.cssText = 'border:none;border-radius:0;padding:0;width:100vw;max-width:100vw;height:100vh;box-shadow:none;overflow:hidden;position:fixed;top:0;left:0;margin:0;z-index:99999';
        dlg.dataset.ocMaximized = '1';
        if (btn) btn.title = 'Restaurar tamaño';
        if (btn) btn.textContent = '⊟';
      }
    });

    // Fit all cards in viewport using CSS scale transform
    dlg.querySelector('#oc-fit-view')?.addEventListener('click', () => {
      const vp = /** @type {HTMLElement|null} */ (dlg.querySelector('#oc-viewport'));
      const canvas = /** @type {HTMLElement|null} */ (document.getElementById('oc-canvas'));
      if (!vp || !canvas) return;
      const cards = [...canvas.querySelectorAll('.oc-card')];
      if (cards.length === 0) return;
      let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
      cards.forEach(card => {
        const el = /** @type {HTMLElement} */ (card);
        const x = parseInt(el.style.left) || 0;
        const y = parseInt(el.style.top)  || 0;
        const w = el.offsetWidth  || 160;
        const h = el.offsetHeight || 110;
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w; if (y + h > maxY) maxY = y + h;
      });
      if (!isFinite(minX)) return;
      const PAD = 48;
      const contentW = maxX - minX + PAD * 2;
      const contentH = maxY - minY + PAD * 2;
      const vpW = vp.clientWidth  || vp.offsetWidth;
      const vpH = vp.clientHeight || vp.offsetHeight;
      const scale = Math.min(vpW / contentW, vpH / contentH, 1);
      canvas.style.transform = `scale(${scale})`;
      canvas.style.transformOrigin = 'top left';
      vp.scrollLeft = Math.max(0, (minX - PAD) * scale);
      vp.scrollTop  = Math.max(0, (minY - PAD) * scale);
    });

    dlg.querySelector('#oc-add-pf')  ?.addEventListener('click', () => _ocOpenForm(dlg, 'portfolio', null));
    dlg.querySelector('#oc-add-prog')?.addEventListener('click', () => _ocOpenForm(dlg, 'program', null));
    dlg.querySelector('#oc-add-proj')?.addEventListener('click', () => _ocOpenForm(dlg, 'project', null));
    dlg.querySelector('#oc-reset-layout')?.addEventListener('click', () => {
      localStorage.removeItem('oc-pos');
      const canvas = /** @type {HTMLElement|null} */ (document.getElementById('oc-canvas'));
      if (canvas) { canvas.style.transform = ''; canvas.style.transformOrigin = ''; }
      _renderOrgChart();
    });
    dlg.querySelector('#oc-print')?.addEventListener('click', _printOrgChart);
  }
  _renderOrgChart();
  if (!dlg.open) dlg.showModal();
}

function _printOrgChart() {
  const canvas = document.getElementById('oc-canvas');
  const { project } = appState.state;
  if (!canvas) return;

  // Compute bounding box of visible cards
  const cards = [...canvas.querySelectorAll('.oc-card')];
  let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
  cards.forEach(card => {
    const x = parseInt(card.style.left) || 0;
    const y = parseInt(card.style.top)  || 0;
    const w = card.offsetWidth  || 160;
    const h = card.offsetHeight || 110;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w; if (y + h > maxY) maxY = y + h;
  });
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600; }
  const PAD = 40;
  minX -= PAD; minY -= PAD; maxX += PAD; maxY += PAD;
  const contentW = maxX - minX, contentH = maxY - minY;

  // Clone canvas, remove interactive controls
  const clone = canvas.cloneNode(true);
  clone.querySelectorAll('.oc-btn-edit,.oc-btn-add,.oc-drag-handle').forEach(el => el.remove());
  const canvasHtml = clone.outerHTML;

  const _dOc = new Date();
  const today    = _dOc.toLocaleDateString('es-PE');
  const projName = project?.name ?? '';
  const _ocDD = String(_dOc.getDate()).padStart(2,'0');
  const _ocMM = String(_dOc.getMonth()+1).padStart(2,'0');
  const _ocYY = _dOc.getFullYear();
  const _ocHH = String(_dOc.getHours()).padStart(2,'0');
  const _ocMi = String(_dOc.getMinutes()).padStart(2,'0');
  const _ocProjEsc = projName.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const _ocFileTitle = `${projName || 'ECM Project'}-Estructura de Proyectos-${_ocDD}${_ocMM}${_ocYY}`;

  const html = `<!doctype html>
<html lang="es"><head>
  <meta charset="UTF-8">
  ${FONTS_LINK}
  <title>${_ocFileTitle}</title>
  <style id="page-style">@page { size: A4 landscape; margin: 10mm; }</style>
  <style>
    :root { --clr-primary:#1976D2; --clr-bg:#f8f9fc; --clr-surface:#fff;
            --clr-surface-2:#f5f7fa; --clr-text:#1a1d23; --clr-text-2:#4a5568;
            --clr-border:#e2e8f0; }
    * { box-sizing:border-box; }
    body { margin:0; padding:0; font-family:'Segoe UI',system-ui,sans-serif; background:#f5f7fa; }
    .header { display:flex; align-items:center; padding:6px 12px 4px;
              border-bottom:2px solid #1976D2; background:#fff; }
    .proj-name { font-size:15px; font-weight:700; color:#1976D2; }
    .oc-frame { border:0.25px solid #546E7A; overflow:hidden; margin:8px 12px; background:#fff; }
    .controls { display:flex; align-items:center; gap:10px; padding:8px 12px;
                font-size:12px; flex-wrap:wrap; background:#fff;
                border-bottom:1px solid #CFD8DC; position:sticky; top:0; z-index:10; }
    .controls label { display:flex; align-items:center; gap:5px; color:#455A64; }
    .controls input[type=range] { width:100px; accent-color:#1976D2; }
    .controls input[type=number] { width:46px; padding:2px 4px; border:1px solid #90A4AE;
                                   border-radius:4px; font-size:12px; text-align:center; }
    .btn-c { border:1px solid #90A4AE; border-radius:6px; padding:4px 11px;
             font-size:12px; cursor:pointer; background:#fff; color:#455A64; }
    .btn-c:hover,.btn-c.active { background:#1976D2; color:#fff; border-color:#1976D2; }
    .btn-print { background:#1976D2; color:#fff; border:none; border-radius:6px;
                 padding:6px 16px; font-size:13px; cursor:pointer; font-weight:600; }
    .btn-print:hover { background:#1565C0; }
    .sep { width:1px; height:20px; background:#CFD8DC; flex-shrink:0; }
    .lbl-sm { font-size:11px; color:#78909C; }
    @media print { .controls { display:none !important; }
      footer.ecm-footer { display:block; position:fixed; bottom:0; left:0; right:0;
        font-size:6pt; color:#9E9E9E; text-align:center;
        border-top:1px solid #E0E0E0; padding-top:3px; padding-bottom:2px;
        background:white; }
      .oc-frame { margin:0; border:none; }
    }
    footer.ecm-footer { display:none; }
    /* Encabezado/pie estándar */
    .print-header,.print-footer{
      font-family:'Urbanist',system-ui,sans-serif;
      -webkit-print-color-adjust:exact;print-color-adjust:exact;
    }
    .print-header{
      position:fixed;top:0;left:0;right:0;height:26px;
      display:none;align-items:center;justify-content:space-between;
      padding:0 10mm;border-bottom:0.5pt solid #CBD5E0;
      font-size:6pt;color:#4A5568;background:#fff;z-index:9999;
    }
    .print-footer{
      position:fixed;bottom:0;left:0;right:0;height:22px;
      display:none;align-items:center;justify-content:space-between;
      padding:0 10mm;border-top:0.5pt solid #CBD5E0;
      font-size:6pt;color:#718096;background:#fff;z-index:9999;
    }
    ${REPORT_TITLE_CSS}
    @media print{
      .print-header,.print-footer{display:flex!important;}
      footer.ecm-footer{display:none!important;}
      .header{display:none!important;}
      .print-title{display:block!important;}
    }
    .print-title{display:none;}
    ${pageHfCss({ proj: projName, date: `${_ocDD}-${_ocMM}-${_ocYY}, ${_ocHH}:${_ocMi}` })}
  ${REPORT_FONT_CSS}
  </style>
</head><body>
<div class="print-header"><span>ECM Project V1.00.01</span><span>${_ocProjEsc}</span><span>${_ocDD}-${_ocMM}-${_ocYY}, ${_ocHH}:${_ocMi}</span></div>
<div class="print-footer"><span>By EHCM</span><span>&#8212;</span><span>P&aacute;gina <span id="phf-cur">1</span> de <span id="phf-tot">1</span></span></div>
  <div class="controls">
    <label>Zoom:
      <input type="range" id="zoom" min="10" max="200" value="100" step="5">
      <span id="zoom-val" style="min-width:38px">100%</span>
    </label>
    <div class="sep"></div>
    <label>Papel: <select id="paper" onchange="setOrient()" title="Tamaño del papel del PDF">
      <option value="A4" selected>A4</option><option value="A3">A3</option><option value="A2">A2</option><option value="A1">A1</option>
      <option value="Carta">Carta</option><option value="Oficio">Oficio</option><option value="Legal">Legal</option><option value="Tabloide">Tabloide</option>
    </select></label>
    <div class="sep"></div>
    <span class="lbl-sm">Orientaci&#243;n:</span>
    <button class="btn-c active" id="btn-land" onclick="setOrient('landscape')">&#x2B1B; Horizontal</button>
    <button class="btn-c" id="btn-port" onclick="setOrient('portrait')">&#x1F532; Vertical</button>
    <div class="sep"></div>
    <label>Hojas H: <input type="number" id="h-pages" min="1" max="10" value="1"></label>
    <label>Hojas V: <input type="number" id="v-pages" min="1" max="10" value="1"></label>
    <div class="sep"></div>
    <span class="lbl-sm">${today}</span>
    <button class="btn-print" style="margin-left:auto" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
  </div>
  <div class="header">
    <div class="proj-name">Estructura de Proyectos${projName ? ' — ' + projName : ''}</div>
  </div>
  <div class="print-title">Estructura de Proyectos</div>
  <div class="oc-frame" id="oc-frame">
    <div id="oc-inner" style="transform-origin:top left;position:relative">
      ${canvasHtml}
    </div>
  </div>
  <footer class="ecm-footer">ECM Project v1.0.0 | &#169; 2026 E. Ch&#225;vez</footer>
  <script>
    (function(){var el=document.getElementById('phf-tot');if(el)el.textContent=1;window.addEventListener('beforeprint',function(){var e=document.getElementById('phf-tot');if(e)e.textContent=1;});})();
    const inner = document.getElementById('oc-inner');
    const frame = document.getElementById('oc-frame');
    const zoom  = document.getElementById('zoom');
    const zoomVal = document.getElementById('zoom-val');
    const MX = ${minX}, MY = ${minY}, CW = ${contentW}, CH = ${contentH};

    function applyZoom(z) {
      const s = z / 100;
      inner.style.transform = 'translate(' + (-MX) + 'px,' + (-MY) + 'px) scale(' + s + ')';
      frame.style.width  = Math.round(CW * s) + 'px';
      frame.style.height = Math.round(CH * s) + 'px';
    }
    zoom.addEventListener('input', () => {
      zoomVal.textContent = zoom.value + '%';
      applyZoom(parseInt(zoom.value));
    });
    ${PAPER_JS}
    let _ocOri = 'landscape';
    function setOrient(o) {
      if (o) _ocOri = o; o = _ocOri;
      const sz = paperSize(o);
      document.getElementById('page-style').textContent = '@page { size: ' + sz[0] + 'mm ' + sz[1] + 'mm; margin: 10mm; }';
      document.getElementById('btn-land').classList.toggle('active', o === 'landscape');
      document.getElementById('btn-port').classList.toggle('active', o === 'portrait');
    }
    const pageW = window.innerWidth - 32;
    const autoZ = Math.max(10, Math.min(100, Math.floor(pageW / CW * 100)));
    zoom.value = autoZ; zoomVal.textContent = autoZ + '%'; applyZoom(autoZ);
  <\/script>
</body></html>`;

  const win = window.open('', '_blank', 'width=1200,height=800');
  if (!win) { _showToast('El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.', 'warn'); return; }
  win.document.write(html);
  win.document.close();
}

// ---- Helpers del formulario inline ----

function _ocCloseEdit(dlg) {
  const ov = dlg?.querySelector('#oc-edit-overlay');
  if (ov) ov.style.display = 'none';
  const dc = dlg?.querySelector('#oc-del-confirm');
  if (dc) dc.style.display = 'none';
  const dd = dlg?.querySelector('#oc-edit-delete');
  if (dd) dd.style.display = 'none';
}

function _ocOpenForm(dlg, type, data) {
  // Reemplaza TODO el contenido del edit-box con HTML fresco cada vez
  const overlay = dlg.querySelector('#oc-edit-overlay');
  if (!overlay) return;

  const _ocColors = { portfolio: '#1976D2', program: '#7B1FA2', project: '#2E7D32' };
  const _ocIcons  = {
    portfolio: `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" style="vertical-align:middle"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="${_ocColors.portfolio}"/></svg>`,
    program:   `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" style="vertical-align:middle"><path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z" fill="${_ocColors.program}"/></svg>`,
    project:   `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" style="vertical-align:middle"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" fill="${_ocColors.project}"/></svg>`,
  };
  const icons  = _ocIcons;
  const labels = { portfolio: 'Portafolio', program: 'Programa', project: 'Proyecto' };
  const isNew  = !data?.id;

  const inp = (id, label, val = '', ph = '', type2 = 'text') =>
    `<div style="margin-bottom:13px">
      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--clr-text-2)">${label}</label>
      <input id="ocf-${id}" type="${type2}" value="${_escHtml(String(val ?? ''))}" placeholder="${ph}"
        style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:13px;background:var(--clr-surface-2);color:var(--clr-text)">
    </div>`;

  const sel = (id, label) =>
    `<div style="margin-bottom:13px">
      <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:var(--clr-text-2)">${label}</label>
      <select id="ocf-${id}" style="width:100%;padding:8px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:13px;background:var(--clr-surface-2);color:var(--clr-text)">
        <option value="">(Ninguno)</option>
      </select>
    </div>`;

  let extraHtml = '';
  if (type === 'program' || type === 'project') extraHtml += sel('pfid', 'Portafolio');
  if (type === 'project') {
    extraHtml += sel('progid', 'Programa');
    extraHtml += inp('start', 'Fecha inicio', data?.start_date ?? '', 'AAAA-MM-DD');
    extraHtml += inp('pct', '% Avance', data?.percent_complete ?? 0, '0', 'number');
  }

  const box = dlg.querySelector('#oc-edit-box');
  box.innerHTML = `
    <h3 style="margin:0 0 16px;font-size:15px;font-weight:700">${icons[type]} ${isNew ? 'Nuevo' : 'Editar'} ${labels[type]}</h3>
    ${inp('name', 'Nombre *', data?.name ?? '', 'Nombre del ' + labels[type])}
    ${inp('code', 'Código', data?.code ?? '', 'Ej: PF-001')}
    ${inp('desc', 'Descripción', data?.description ?? '', 'Opcional')}
    ${extraHtml}
    ${!isNew ? `<div id="oc-del-zone" style="display:none;background:rgba(var(--clr-danger-rgb,231,76,60),0.08);border:1px solid rgba(var(--clr-danger-rgb,231,76,60),0.3);border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;color:var(--clr-danger,#e74c3c);margin-bottom:6px">⚠ Esta acción no se puede deshacer</div>
      <button id="ocf-del-confirm" style="background:var(--clr-danger,#e74c3c);color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600">Eliminar definitivamente</button>
      <button id="ocf-del-cancel" style="margin-left:8px;background:none;border:1px solid var(--clr-border);border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px">Cancelar</button>
    </div>` : ''}
    <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:16px">
      <div>${!isNew ? `<button id="ocf-del-init" style="background:none;border:1px solid var(--clr-danger,#e74c3c);color:var(--clr-danger,#e74c3c);border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px">🗑 Eliminar</button>` : ''}</div>
      <div style="display:flex;gap:8px">
        <button id="ocf-cancel" class="btn btn-ghost btn-sm">Cancelar</button>
        <button id="ocf-save" class="btn btn-primary btn-sm">Guardar</button>
      </div>
    </div>`;

  // Poblar selects
  loadHierarchy().then(({ portfolios, programs }) => {
    const pfSel = box.querySelector('#ocf-pfid');
    if (pfSel) {
      portfolios.forEach(pf => {
        const opt = new Option(`${pf.code ? pf.code + ' — ' : ''}${pf.name}`, pf.id);
        const curPf = data?.portfolio_id ?? data?.settings?.portfolio_id;
        if (curPf === pf.id) opt.selected = true;
        pfSel.appendChild(opt);
      });
    }
    const progSel = box.querySelector('#ocf-progid');
    if (progSel) {
      programs.forEach(prog => {
        const opt = new Option(`${prog.code ? prog.code + ' — ' : ''}${prog.name}`, prog.id);
        if (data?.settings?.program_id === prog.id) opt.selected = true;
        progSel.appendChild(opt);
      });
    }
  });

  // ---- Listeners ----
  box.querySelector('#ocf-cancel')?.addEventListener('click', () => { overlay.style.display = 'none'; });
  overlay.onclick = e => { if (e.target === overlay) overlay.style.display = 'none'; };

  box.querySelector('#ocf-del-init')?.addEventListener('click', () => {
    box.querySelector('#oc-del-zone').style.display = 'block';
    box.querySelector('#ocf-del-init').style.display = 'none';
  });
  box.querySelector('#ocf-del-cancel')?.addEventListener('click', () => {
    box.querySelector('#oc-del-zone').style.display = 'none';
    box.querySelector('#ocf-del-init').style.display = '';
  });
  box.querySelector('#ocf-del-confirm')?.addEventListener('click', async () => {
    try {
      if (type === 'portfolio') await deletePortfolio(data.id);
      else if (type === 'program') await deleteProgram(data.id);
      else await _deleteProject(data.id);
      overlay.style.display = 'none';
      await _renderOrgChart();
      _renderProjectList();
      _showToast('Eliminado', 'success');
    } catch (err) { _showToast('Error: ' + err.message, 'error'); }
  });

  box.querySelector('#ocf-save').addEventListener('click', async () => {
    const nameEl = box.querySelector('#ocf-name');
    const name = nameEl?.value.trim();
    if (!name) { nameEl.style.borderColor = 'var(--clr-danger,#e74c3c)'; nameEl.focus(); return; }
    nameEl.style.borderColor = '';

    const code     = box.querySelector('#ocf-code')?.value.trim() || null;
    const desc     = box.querySelector('#ocf-desc')?.value.trim() || null;
    const pfId     = box.querySelector('#ocf-pfid')?.value   || null;
    const progId   = box.querySelector('#ocf-progid')?.value || null;
    const startDate = box.querySelector('#ocf-start')?.value || null;
    const pct      = parseInt(box.querySelector('#ocf-pct')?.value || '0', 10) || 0;
    const now      = new Date().toISOString();
    const newId    = data?.id || crypto.randomUUID();

    try {
      if (type === 'portfolio') {
        await savePortfolio({
          id: newId, name, code, description: desc,
          settings: data?.settings ?? {},
          created_at: data?.created_at ?? now,
          updated_at: now, deleted_at: null,
        });
      } else if (type === 'program') {
        await saveProgram({
          id: newId, name, code, description: desc,
          portfolio_id: pfId,
          settings: data?.settings ?? {},
          created_at: data?.created_at ?? now,
          updated_at: now, deleted_at: null,
        });
      } else {
        const projSettings = {
          ...(data?.settings ?? {}),
          portfolio_id: pfId,
          program_id: progId,
        };
        await dbPut('projects', {
          id: newId, name, code, description: desc,
          start_date: startDate, percent_complete: pct,
          settings: projSettings,
          created_at: data?.created_at ?? now,
          updated_at: now, deleted_at: null,
        });
      }
      overlay.style.display = 'none';
      await _renderOrgChart();
      _renderProjectList();
      _showToast((isNew ? 'Creado: ' : 'Guardado: ') + name, 'success');
    } catch (err) { _showToast('Error al guardar: ' + err.message, 'error'); }
  });

  // Foco en nombre
  setTimeout(() => box.querySelector('#ocf-name')?.focus(), 50);
  overlay.style.display = 'flex';
}

// ---- Dibujar líneas de conexión SVG ----
function _ocDrawLines(canvas, cards) {
  const svg = canvas.querySelector('#oc-svg-lines');
  if (!svg) return;
  svg.innerHTML = '';
  const mkLine = (x1, y1, x2, y2, color) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const mid = (y1 + y2) / 2;
    path.setAttribute('d', `M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}`);
    path.setAttribute('stroke', color || 'var(--clr-border)');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('fill', 'none');
    path.setAttribute('opacity', '0.7');
    svg.appendChild(path);
  };

  cards.forEach(({ el, parentKey }) => {
    if (!parentKey) return;
    const parentEl = canvas.querySelector(`[data-oc-key="${parentKey}"]`);
    if (!parentEl) return;
    const cx  = parseInt(el.style.left) + el.offsetWidth / 2;
    const cy  = parseInt(el.style.top);
    const pcx = parseInt(parentEl.style.left) + parentEl.offsetWidth / 2;
    const pcy = parseInt(parentEl.style.top)  + parentEl.offsetHeight;
    mkLine(pcx, pcy, cx, cy, null);
  });
}

async function _renderOrgChart() {
  const canvas = document.getElementById('oc-canvas');
  if (!canvas) return;
  // Clear only card elements, keep SVG
  [...canvas.querySelectorAll('.oc-card')].forEach(c => c.remove());
  const svg = canvas.querySelector('#oc-svg-lines');
  if (svg) svg.innerHTML = '';

  const { portfolios, programs, projects } = await loadHierarchy();
  const currentId = appState.state.project?.id;

  const dlg = document.getElementById('dlg-org-chart');

  // ---- Calcular posiciones por defecto si no hay guardadas ----
  const savedPos = _ocGetPos();
  const CARD_W = 160, CARD_H = 110, COL_GAP = 200, ROW_GAP = 160;

  function defaultPos(type, id, col, row) {
    const key = `${type}:${id}`;
    if (savedPos[key]) return savedPos[key];
    return { x: 60 + col * (CARD_W + COL_GAP), y: 60 + row * (CARD_H + ROW_GAP) };
  }

  // Layout automático: cursor de columnas acumulado — cada nodo ocupa columna entera
  let cardList = []; // { type, data, pos, parentKey }
  let _col = 0; // cursor global de columna

  portfolios.forEach(pf => {
    const pfFirstCol = _col;
    let pfSpan = 0;

    const pfProgs = programs.filter(p => p.portfolio_id === pf.id);
    pfProgs.forEach(prog => {
      const progProjs = projects.filter(p => p.settings?.program_id === prog.id);
      const progFirstCol = _col;
      const numCols = Math.max(1, progProjs.length);

      progProjs.forEach((proj, ji) => {
        const projPos = defaultPos('proj', proj.id, _col + ji, 2);
        cardList.push({ type: 'project', data: proj, pos: projPos, parentKey: `prog:${prog.id}` });
      });

      const progCenterCol = progFirstCol + (numCols - 1) / 2;
      const progPos = defaultPos('prog', prog.id, progCenterCol, 1);
      cardList.push({ type: 'program', data: prog, pos: progPos, parentKey: `pf:${pf.id}` });

      _col += numCols;
      pfSpan += numCols;
    });

    // Proyectos directos del portafolio (sin programa)
    const pfDirectProjs = projects.filter(p => p.settings?.portfolio_id === pf.id && !p.settings?.program_id);
    pfDirectProjs.forEach((proj, ji) => {
      const projPos = defaultPos('proj', proj.id, _col + ji, 1);
      cardList.push({ type: 'project', data: proj, pos: projPos, parentKey: `pf:${pf.id}` });
    });
    if (pfDirectProjs.length > 0) { _col += pfDirectProjs.length; pfSpan += pfDirectProjs.length; }

    if (pfSpan === 0) { pfSpan = 1; _col++; }

    const pfCenterCol = pfFirstCol + (pfSpan - 1) / 2;
    const pfPos = defaultPos('pf', pf.id, pfCenterCol, 0);
    cardList.push({ type: 'portfolio', data: pf, pos: pfPos, parentKey: null });

    _col += 0.5; // separación visual entre portafolios
  });

  // Programas sin portafolio
  const orphanProgs = programs.filter(p => !p.portfolio_id);
  orphanProgs.forEach(prog => {
    const progFirstCol = _col;
    const progProjs = projects.filter(p => p.settings?.program_id === prog.id);
    const numCols = Math.max(1, progProjs.length);

    progProjs.forEach((proj, ji) => {
      const projPos = defaultPos('proj', proj.id, _col + ji, 1);
      cardList.push({ type: 'project', data: proj, pos: projPos, parentKey: `prog:${prog.id}` });
    });

    const progPos = defaultPos('prog', prog.id, progFirstCol + (numCols - 1) / 2, 0);
    cardList.push({ type: 'program', data: prog, pos: progPos, parentKey: null });
    _col += numCols + 0.5;
  });

  // Proyectos sin asignar
  const unassigned = projects.filter(p => !p.settings?.portfolio_id && !p.settings?.program_id);
  // Si ya hay posiciones guardadas, los proyectos nuevos (sin pos guardada) se ubican
  // cerca del clúster existente — no al final del cursor global _col que puede quedar muy lejos.
  const _savedVals = Object.values(savedPos);
  const _hasSaved = _savedVals.length > 0;
  const _clusterCX = _hasSaved
    ? Math.round(_savedVals.reduce((s, p) => s + p.x, 0) / _savedVals.length)
    : 60;
  const _clusterMaxY = _hasSaved
    ? Math.max(..._savedVals.map(p => p.y))
    : 60;
  const _newUnassigned = _hasSaved
    ? unassigned.filter(p => !savedPos[`proj:${p.id}`])
    : [];
  unassigned.forEach((proj, i) => {
    let projPos;
    if (_hasSaved && !savedPos[`proj:${proj.id}`]) {
      const ni = _newUnassigned.indexOf(proj);
      const half = (_newUnassigned.length - 1) / 2;
      projPos = {
        x: Math.max(60, Math.round(_clusterCX + (ni - half) * (CARD_W + 20))),
        y: _clusterMaxY + ROW_GAP,
      };
    } else {
      projPos = defaultPos('proj', proj.id, _col + i, orphanProgs.length > 0 ? 2 : 1);
    }
    cardList.push({ type: 'project', data: proj, pos: projPos, parentKey: null });
  });

  // ---- Crear tarjetas en el canvas ----
  const colors = { portfolio: '#1976D2', program: '#7B1FA2', project: '#2E7D32' };
  const bgCol  = { portfolio: 'rgba(25,118,210,0.06)', program: 'rgba(123,31,162,0.06)', project: 'rgba(46,125,50,0.06)' };
  const icons  = {
    portfolio: `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="${colors.portfolio}"/></svg>`,
    program:   `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path d="M11.99 18.54l-7.37-5.73L3 14.07l9 7 9-7-1.63-1.27-7.38 5.74zM12 16l7.36-5.73L21 9l-9-7-9 7 1.63 1.27L12 16z" fill="${colors.program}"/></svg>`,
    project:   `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1c-1.3 0-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z" fill="${colors.project}"/></svg>`,
  };

  cardList.forEach(({ type, data, pos }) => {
    const isActive = type === 'project' && data.id === currentId;
    const card = document.createElement('div');
    card.className = 'oc-card';
    const ocKey = `${type === 'portfolio' ? 'pf' : type === 'program' ? 'prog' : 'proj'}:${data.id}`;
    card.dataset.ocKey = ocKey;
    card.style.cssText = `
      position:absolute;left:${pos.x}px;top:${pos.y}px;
      width:${CARD_W}px;min-height:${CARD_H}px;
      border-radius:12px;border:2px solid ${isActive ? 'var(--clr-primary)' : colors[type]};
      background:${isActive ? 'rgba(25,118,210,0.12)' : bgCol[type]};
      box-shadow:0 2px 8px rgba(0,0,0,0.10);padding:10px 10px 8px;
      display:flex;flex-direction:column;align-items:center;gap:4px;
      cursor:grab;user-select:none;font-family:inherit;box-sizing:border-box;
      transition:box-shadow .15s;`;

    card.innerHTML = `
      <div class="oc-drag-handle" style="position:absolute;top:4px;left:6px;font-size:12px;opacity:0.25;cursor:grab;line-height:1" title="Arrastrar">⠿</div>
      <button class="oc-btn-edit" title="Editar" aria-label="Editar nodo" style="position:absolute;top:4px;right:26px;background:none;border:none;cursor:pointer;font-size:12px;opacity:0.3;padding:0;line-height:1">✎</button>
      <button class="oc-btn-add" title="Agregar hijo" aria-label="Agregar nodo hijo" style="position:absolute;top:4px;right:6px;background:none;border:none;cursor:pointer;font-size:12px;opacity:0.3;padding:0;line-height:1;font-weight:700">＋</button>
      <div style="width:22px;height:22px;margin-top:2px;display:flex;align-items:center;justify-content:center">${icons[type]}</div>
      <div style="font-size:11px;font-weight:700;word-break:break-word;text-align:center;line-height:1.3;color:${colors[type]};margin-top:2px">${_escHtml(data.name)}</div>
      ${data.code ? `<div style="font-size:9px;opacity:0.55;background:rgba(0,0,0,0.06);border-radius:4px;padding:1px 6px;margin-top:1px">${_escHtml(data.code)}</div>` : ''}
      ${type === 'project' && data.start_date ? `<div style="font-size:9px;opacity:0.4;margin-top:2px">📅 ${data.start_date}</div>` : ''}
      ${type === 'project' && data.percent_complete ? `<div style="font-size:9px;color:${colors[type]};margin-top:1px">▓ ${data.percent_complete}%</div>` : ''}`;

    // Hover reveal buttons
    const editBtn = card.querySelector('.oc-btn-edit');
    const addBtn  = card.querySelector('.oc-btn-add');
    card.addEventListener('mouseenter', () => {
      editBtn.style.opacity = '0.65'; addBtn.style.opacity = '0.65';
      card.style.boxShadow = '0 4px 16px rgba(0,0,0,0.18)';
    });
    card.addEventListener('mouseleave', () => {
      editBtn.style.opacity = '0.3'; addBtn.style.opacity = '0.3';
      card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.10)';
    });

    // Edit button → open form
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (dlg) _ocOpenForm(dlg, type, data);
    });

    // Add child button
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!dlg) return;
      if (type === 'portfolio') _ocOpenForm(dlg, 'program', { settings: {}, portfolio_id: data.id });
      else if (type === 'program') _ocOpenForm(dlg, 'project', { settings: { program_id: data.id, portfolio_id: data.portfolio_id } });
    });

    // Open project on click (only for project cards, not on button clicks)
    if (type === 'project') {
      card.addEventListener('click', e => {
        if (e.target !== card && !e.target.closest('.oc-drag-handle')) return;
        _loadProject(data.id).then(() => _showToast('Cargado: ' + data.name, 'success')).catch(err => _showToast('Error: ' + err.message, 'error'));
      });
    }

    // ---- Drag: reposicionar + reasignar padre ----
    let dragging = false, dx = 0, dy = 0, moved = false;

    const keyOf = c => `${c.type === 'portfolio' ? 'pf' : c.type === 'program' ? 'prog' : 'proj'}:${c.data.id}`;

    // Resalta o quita resaltado de drop targets compatibles
    const setDropHighlight = (on) => {
      const accepts = type === 'project' ? ['prog', 'pf'] : type === 'program' ? ['pf'] : [];
      canvas.querySelectorAll('.oc-card').forEach(c => {
        const k = c.dataset.ocKey ?? '';
        const prefix = k.split(':')[0];
        if (accepts.includes(prefix) && c !== card) {
          c.style.outline = on ? '3px dashed var(--clr-primary)' : '';
          c.style.outlineOffset = on ? '3px' : '';
        }
      });
    };

    card.addEventListener('mousedown', e => {
      if (e.target.closest('button')) return;
      dragging = true; moved = false;
      const vp = document.getElementById('oc-viewport');
      const vpR = vp ? vp.getBoundingClientRect() : { left: 0, top: 0 };
      const sl = vp ? vp.scrollLeft : 0, st = vp ? vp.scrollTop : 0;
      dx = (e.clientX - vpR.left + sl) - pos.x;
      dy = (e.clientY - vpR.top  + st) - pos.y;
      card.style.cursor = 'grabbing'; card.style.zIndex = '10';
      e.preventDefault();
    });

    const onMove = e => {
      if (!dragging) return;
      const vp = document.getElementById('oc-viewport');
      const vpR = vp ? vp.getBoundingClientRect() : { left: 0, top: 0 };
      const sl = vp ? vp.scrollLeft : 0, st = vp ? vp.scrollTop : 0;
      const newX = Math.max(0, (e.clientX - vpR.left + sl) - dx);
      const newY = Math.max(0, (e.clientY - vpR.top  + st) - dy);
      if (!moved && Math.hypot(newX - pos.x, newY - pos.y) > 5) {
        moved = true;
        setDropHighlight(true);
      }
      pos.x = newX; pos.y = newY;
      card.style.left = pos.x + 'px';
      card.style.top  = pos.y + 'px';
      _ocDrawLines(canvas, cardList.map(c => ({ el: canvas.querySelector(`[data-oc-key="${keyOf(c)}"]`), parentKey: c.parentKey })));
    };

    const onUp = async e => {
      if (!dragging) return;
      dragging = false; card.style.cursor = 'grab'; card.style.zIndex = '';
      setDropHighlight(false);

      if (moved) {
        // Guardar posición
        const posMap = _ocGetPos();
        posMap[ocKey] = { x: pos.x, y: pos.y };
        _ocSetPos(posMap);

        // Detectar si soltó sobre una tarjeta compatible para reasignar padre
        const vp = document.getElementById('oc-viewport');
        const vpRect = vp?.getBoundingClientRect();
        const scrollLeft = vp?.scrollLeft ?? 0;
        const scrollTop  = vp?.scrollTop  ?? 0;
        const canvasX = e.clientX - (vpRect?.left ?? 0) + scrollLeft;
        const canvasY = e.clientY - (vpRect?.top  ?? 0) + scrollTop;

        let dropped = false;
        canvas.querySelectorAll('.oc-card').forEach(target => {
          if (dropped || target === card) return;
          const tx = parseInt(target.style.left), ty = parseInt(target.style.top);
          const tw = target.offsetWidth, th = target.offsetHeight;
          if (canvasX >= tx && canvasX <= tx + tw && canvasY >= ty && canvasY <= ty + th) {
            const targetKey = target.dataset.ocKey ?? '';
            const [tPrefix, tId] = targetKey.split(':');

            if (type === 'project' && tPrefix === 'prog') {
              // Reasignar proyecto → programa
              const proj = projects.find(p => p.id === data.id);
              const prog = programs.find(p => p.id === tId);
              if (proj && prog) {
                const ns = { ...(proj.settings ?? {}), program_id: prog.id, portfolio_id: prog.portfolio_id ?? null };
                dbPut('projects', { ...proj, settings: ns, updated_at: new Date().toISOString() })
                  .then(() => { _showToast(`Proyecto asignado a ${prog.name}`, 'success'); _renderOrgChart(); _renderProjectList(); });
                dropped = true;
              }
            } else if (type === 'project' && tPrefix === 'pf') {
              // Reasignar proyecto → portafolio (sin programa)
              const proj = projects.find(p => p.id === data.id);
              const pf = portfolios.find(p => p.id === tId);
              if (proj && pf) {
                const ns = { ...(proj.settings ?? {}), program_id: null, portfolio_id: pf.id };
                dbPut('projects', { ...proj, settings: ns, updated_at: new Date().toISOString() })
                  .then(() => { _showToast(`Proyecto asignado a ${pf.name}`, 'success'); _renderOrgChart(); _renderProjectList(); });
                dropped = true;
              }
            } else if (type === 'program' && tPrefix === 'pf') {
              // Reasignar programa → portafolio
              const prog = programs.find(p => p.id === data.id);
              const pf = portfolios.find(p => p.id === tId);
              if (prog && pf) {
                saveProgram({ ...prog, portfolio_id: pf.id, updated_at: new Date().toISOString() })
                  .then(() => { _showToast(`Programa asignado a ${pf.name}`, 'success'); _renderOrgChart(); _renderProjectList(); });
                dropped = true;
              }
            }
          }
        });
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    dlg?.addEventListener('close', () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }, { once: true });

    canvas.appendChild(card);
  });

  // ---- Dibujar líneas ----
  _ocDrawLines(canvas, cardList.map(c => ({
    el: canvas.querySelector(`[data-oc-key="${c.type === 'portfolio' ? 'pf' : c.type === 'program' ? 'prog' : 'proj'}:${c.data.id}"]`),
    parentKey: c.parentKey,
  })));
}

// ============================================================
// Configurador de columnas de exportación / impresión
// ============================================================

const PRINT_COL_OPTS = [
  { id: 'wbs',    label: 'EDT (código WBS)',       group: 'tabla' },
  { id: 'name',   label: 'Nombre de actividad',    group: 'tabla' },
  { id: 'type',   label: 'Tipo (Tarea/Hito…)',     group: 'tabla' },
  { id: 'dur',    label: 'Duración (días)',         group: 'ambos' },
  { id: 'start',  label: 'Inicio',                 group: 'ambos' },
  { id: 'finish', label: 'Fin',                    group: 'ambos' },
  { id: 'pct',    label: '% Avance',               group: 'ambos' },
  { id: 'tf',     label: 'HT — Holgura Total',     group: 'ambos' },
  { id: 'ff',     label: 'HL — Holgura Libre',     group: 'tabla' },
  { id: 'pred',   label: 'Predecesoras (PRED)',    group: 'tabla' },
];

function _showPrintColConfig() {
  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-print-cols'));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-print-cols';
    dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:440px;max-width:95vw;box-shadow:0 8px 40px rgba(0,0,0,0.25);overflow:hidden';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-labelledby', 'pcc-title');
    dlg.setAttribute('aria-modal', 'true');
    dlg.innerHTML = `
      <div style="background:var(--clr-surface-2);padding:16px 20px;border-bottom:1px solid var(--clr-border)">
        <div id="pcc-title" style="font-weight:700;font-size:15px">⚙ Columnas de exportación</div>
        <div style="font-size:11px;opacity:0.6;margin-top:2px">Selecciona las columnas que aparecen al imprimir o exportar SVG.</div>
      </div>
      <div style="padding:16px 20px">
        <div style="font-size:11px;font-weight:600;color:var(--clr-text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">
          Tabla EDT (Imprimir tabla)
        </div>
        <div id="pcc-tabla" style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px"></div>
        <div style="font-size:11px;font-weight:600;color:var(--clr-text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px">
          Gantt SVG + Tabla EDT
        </div>
        <div id="pcc-ambos" style="display:flex;flex-direction:column;gap:6px"></div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--clr-border);background:var(--clr-surface-2)">
        <button class="btn btn-ghost btn-sm" id="pcc-cancel">Cancelar</button>
        <button class="btn btn-primary btn-sm" id="pcc-save">Guardar</button>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#pcc-cancel')?.addEventListener('click', () => dlg.close());
    dlg.querySelector('#pcc-save')?.addEventListener('click', () => {
      const checked = [...dlg.querySelectorAll('input[type=checkbox]:checked')].map(el => /** @type {HTMLInputElement} */ (el).value);
      setPrintCols(checked);
      dlg.close();
      _showToast('Columnas guardadas', 'success');
    });
  }

  // Rellenar checkboxes con el estado actual
  const selected = new Set(getPrintCols());
  ['tabla', 'ambos'].forEach(group => {
    const container = dlg.querySelector(`#pcc-${group}`);
    if (!container) return;
    container.innerHTML = '';
    PRINT_COL_OPTS.filter(c => c.group === group).forEach(col => {
      const label = document.createElement('label');
      label.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:4px 6px;border-radius:6px';
      label.innerHTML = `<input type="checkbox" value="${col.id}" ${selected.has(col.id) ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer">
        <span>${col.label}</span>
        <span style="font-size:10px;opacity:0.45;margin-left:auto">${col.group === 'ambos' ? 'Tabla + SVG' : 'Solo tabla'}</span>`;
      container.appendChild(label);
    });
  });

  dlg.showModal();
}

// ============================================================
// Red de precedencias CPM (Activity-on-Node)
// ============================================================

function _showCpmNetwork() {
  const { cpmResult, tasks: taskMap, deps: depMap } = appState.state;
  if (!cpmResult) {
    _showToast('El CPM aún no ha calculado. Espera un momento y vuelve a intentarlo.', 'warn');
    return;
  }

  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-cpm-network'));
  if (dlg) { if (!dlg.open) dlg.showModal(); _renderCpmNetwork(); setTimeout(() => dlg.querySelector('#btn-cpm-zoomfit')?.dispatchEvent(new Event('click')), 80); return; }

  dlg = document.createElement('dialog');
  dlg.id = 'dlg-cpm-network';
  dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:96vw;max-width:1400px;height:90vh;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden;position:fixed;top:5vh;left:max(0px,calc(50vw - 700px));margin:0;z-index:99999';
  dlg.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%">
      <div id="cpm-dlg-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);flex-shrink:0;cursor:move">
        <span id="cpm-dlg-title" style="font-weight:700;font-size:15px">Red CPM</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="btn-cpm-zoomfit" class="btn btn-ghost btn-sm" title="Zoom extendido — ver toda la red" aria-label="Zoom extendido — ver toda la red" style="font-size:16px;padding:2px 8px;line-height:1">⤢</button>
          <button id="btn-cpm-zoomin"  class="btn btn-ghost btn-sm" title="Acercar" aria-label="Acercar" style="font-size:16px;padding:2px 8px;line-height:1">＋</button>
          <button id="btn-cpm-zoomout" class="btn btn-ghost btn-sm" title="Alejar"  aria-label="Alejar" style="font-size:16px;padding:2px 8px;line-height:1">－</button>
          <span style="width:1px;height:18px;background:var(--clr-border);margin:0 4px;display:inline-block"></span>
          <span style="display:inline-block;width:11px;height:11px;background:#e74c3c;border-radius:2px"></span><span style="font-size:11px">Crítica</span>
          <span style="display:inline-block;width:11px;height:11px;background:#f39c12;border-radius:2px;margin-left:5px"></span><span style="font-size:11px">Casi crítica</span>
          <span style="display:inline-block;width:11px;height:11px;background:#2980b9;border-radius:2px;margin-left:5px"></span><span style="font-size:11px">Normal</span>
          <span style="display:inline-block;width:11px;height:11px;background:#27ae60;border-radius:2px;margin-left:5px"></span><span style="font-size:11px">Completa</span>
          <div style="position:relative;margin-left:10px" id="cpm-export-wrap">
            <button id="btn-cpm-export" class="btn btn-ghost btn-sm" title="Exportar red CPM" aria-haspopup="menu" aria-expanded="false" aria-label="Exportar red CPM" style="display:flex;align-items:center;gap:4px">🖨 Exportar ▾</button>
            <div id="cpm-export-menu" role="menu" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:var(--clr-surface);border:1px solid var(--clr-border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:9999;min-width:200px;overflow:hidden">
              <button class="cpm-exp-item" data-fmt="pdf" role="menuitem" tabindex="-1" style="display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;cursor:pointer;font-size:13px">📄 PDF (imprimir)</button>
              <button class="cpm-exp-item" data-fmt="png" role="menuitem" tabindex="-1" style="display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;cursor:pointer;font-size:13px">🖼 PNG (imagen)</button>
              <button class="cpm-exp-item" data-fmt="svg" role="menuitem" tabindex="-1" style="display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;cursor:pointer;font-size:13px">📐 SVG (vectorial)</button>
            </div>
          </div>
          <button id="btn-cpm-net-close" class="btn btn-ghost btn-sm" aria-label="Cerrar red CPM" style="margin-left:4px">✕ Cerrar</button>
        </div>
      </div>
      <div id="cpm-net-viewport" style="flex:1;overflow:hidden;position:relative;background:var(--clr-bg);cursor:grab">
        <canvas id="cpm-net-grid" style="position:absolute;top:0;left:0;pointer-events:none"></canvas>
        <svg id="cpm-net-svg" style="position:absolute;top:0;left:0;overflow:visible"></svg>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.setAttribute('aria-labelledby', 'cpm-dlg-title');
  dlg.setAttribute('aria-modal', 'true');

  dlg.querySelector('#btn-cpm-net-close')?.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  // Drag-to-move ventana
  { const hdr = dlg.querySelector('#cpm-dlg-hdr');
    let _ox=0,_oy=0,_d=false;
    const onM=e=>{if(!_d)return;dlg.style.left=Math.max(0,e.clientX-_ox)+'px';dlg.style.top=Math.max(0,e.clientY-_oy)+'px';};
    const onU=()=>{_d=false;if(hdr)hdr.style.cursor='move';};
    hdr?.addEventListener('mousedown',e=>{if(/** @type {HTMLElement} */(e.target).closest('button'))return;const r=dlg.getBoundingClientRect();_ox=e.clientX-r.left;_oy=e.clientY-r.top;_d=true;if(hdr)hdr.style.cursor='grabbing';e.preventDefault();});
    document.addEventListener('mousemove',onM);document.addEventListener('mouseup',onU);
    dlg.addEventListener('close', () => { document.removeEventListener('mousemove',onM); document.removeEventListener('mouseup',onU); }, { once: true });
  }

  // Zoom + pan state (accessible to zoom-fit button after render)
  const vp = /** @type {HTMLElement} */ (dlg.querySelector('#cpm-net-viewport'));
  let panX = 40, panY = 40, zoom = 1;
  let panning = false, px0 = 0, py0 = 0, tx0 = 0, ty0 = 0;

  function applyTransform() {
    const svg = /** @type {SVGElement|null} */ (dlg.querySelector('#cpm-net-svg'));
    if (svg) {
      svg.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
      svg.dataset.panX = String(panX); svg.dataset.panY = String(panY); svg.dataset.zoom = String(zoom);
    }
    _drawCpmGrid(dlg, panX, panY, zoom);
  }

  // Zoom-to-fit: calcula bounds del SVG y ajusta para que quepa
  function zoomFit() {
    const svg = /** @type {SVGSVGElement|null} */ (dlg.querySelector('#cpm-net-svg'));
    if (!svg) return;
    const bb = svg.getBBox();
    if (!bb.width || !bb.height) return;
    const vpR = vp.getBoundingClientRect();
    const scaleX = (vpR.width  - 80) / bb.width;
    const scaleY = (vpR.height - 80) / bb.height;
    zoom = Math.max(0.05, Math.min(scaleX, scaleY, 1));
    panX = (vpR.width  - bb.width  * zoom) / 2 - bb.x * zoom;
    panY = (vpR.height - bb.height * zoom) / 2 - bb.y * zoom;
    applyTransform();
  }

  dlg.querySelector('#btn-cpm-zoomfit')?.addEventListener('click', zoomFit);
  dlg.querySelector('#btn-cpm-zoomin')?.addEventListener('click', () => {
    zoom = Math.min(3, zoom * 1.25); applyTransform();
  });
  dlg.querySelector('#btn-cpm-zoomout')?.addEventListener('click', () => {
    zoom = Math.max(0.05, zoom / 1.25); applyTransform();
  });

  vp.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    panning = true; px0 = e.clientX; py0 = e.clientY; tx0 = panX; ty0 = panY;
    vp.style.cursor = 'grabbing';
  });
  const panOnMove = e => {
    if (!panning) return;
    panX = tx0 + e.clientX - px0;
    panY = ty0 + e.clientY - py0;
    applyTransform();
  };
  const panOnUp = () => { panning = false; vp.style.cursor = 'grab'; };
  document.addEventListener('mousemove', panOnMove);
  document.addEventListener('mouseup', panOnUp);
  dlg.addEventListener('close', () => { document.removeEventListener('mousemove', panOnMove); document.removeEventListener('mouseup', panOnUp); }, { once: true });
  vp.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = vp.getBoundingClientRect();
    const mx = e.clientX - rect.left - panX;
    const my = e.clientY - rect.top - panY;
    zoom = Math.max(0.05, Math.min(3, zoom * factor));
    panX = e.clientX - rect.left - mx * zoom;
    panY = e.clientY - rect.top - my * zoom;
    applyTransform();
  }, { passive: false });

  // ---- Export menu ----
  const exportBtn  = dlg.querySelector('#btn-cpm-export');
  const exportMenu = dlg.querySelector('#cpm-export-menu');

  exportBtn?.addEventListener('click', e => {
    e.stopPropagation();
    const nowOpen = exportMenu.style.display === 'none';
    exportMenu.style.display = nowOpen ? 'block' : 'none';
    exportBtn.setAttribute('aria-expanded', String(nowOpen));
    if (nowOpen) requestAnimationFrame(() => exportMenu.querySelector('[role="menuitem"]')?.focus());
  });
  document.addEventListener('click', () => { if (exportMenu) { exportMenu.style.display = 'none'; exportBtn?.setAttribute('aria-expanded', 'false'); } });
  exportMenu?.addEventListener('keydown', e => {
    const items = [...exportMenu.querySelectorAll('[role="menuitem"]')];
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { items[(idx + 1) % items.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { items[(idx - 1 + items.length) % items.length]?.focus(); e.preventDefault(); }
    else if (e.key === 'Escape') { exportMenu.style.display = 'none'; exportBtn?.setAttribute('aria-expanded', 'false'); exportBtn?.focus(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === ' ') { /** @type {HTMLElement} */ (document.activeElement)?.click(); e.preventDefault(); }
  });

  // Hover highlight for menu items
  dlg.querySelectorAll('.cpm-exp-item').forEach(btn => {
    btn.addEventListener('mouseenter', () => btn.style.background = 'var(--clr-surface-2)');
    btn.addEventListener('mouseleave', () => btn.style.background = 'none');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      exportMenu.style.display = 'none';
      const fmt = btn.dataset.fmt;
      _exportCpmNetwork(fmt, dlg);
    });
  });

  if (!dlg.open) dlg.showModal();
  _renderCpmNetwork();
  // Auto fit after render (brief delay for SVG layout)
  setTimeout(zoomFit, 80);
}

/** Exporta la Red CPM en el formato indicado (pdf | png | svg). */
function _exportCpmNetwork(fmt, dlg) {
  const svgEl = /** @type {SVGSVGElement|null} */ (dlg?.querySelector('#cpm-net-svg'));
  if (!svgEl) return;

  const bb = svgEl.getBBox();
  if (!bb.width || !bb.height) { _showToast('La red está vacía.', 'warn'); return; }
  const PAD = 40;
  const vbX = bb.x - PAD, vbY = bb.y - PAD;
  const vbW = bb.width  + PAD * 2;
  const vbH = bb.height + PAD * 2;

  // ---- Clonar SVG y ajustar viewBox ----
  const clone = /** @type {SVGSVGElement} */ (svgEl.cloneNode(true));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  // Limpiar estilos posicionales del diálogo para que el SVG fluya normalmente en el documento
  clone.style.cssText = '';
  clone.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  clone.setAttribute('width',  String(vbW));
  clone.setAttribute('height', String(vbH));

  // ---- Estilos embebidos ----
  const styleEl = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  styleEl.textContent = `text { font-family: 'Segoe UI', Arial, sans-serif; } rect { stroke-width: 1.5; }`;
  clone.prepend(styleEl);

  // ---- Guías minimalistas (fondo, detrás del contenido) ----
  const GRID = 60;
  const gridG = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  gridG.setAttribute('opacity', '0.25');
  // líneas verticales
  const x0 = Math.floor(vbX / GRID) * GRID;
  for (let x = x0; x <= vbX + vbW; x += GRID) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(x)); line.setAttribute('y1', String(vbY));
    line.setAttribute('x2', String(x)); line.setAttribute('y2', String(vbY + vbH));
    line.setAttribute('stroke', '#b0bec5'); line.setAttribute('stroke-width', '0.4');
    line.setAttribute('stroke-dasharray', '3 6');
    gridG.appendChild(line);
  }
  // líneas horizontales
  const y0 = Math.floor(vbY / GRID) * GRID;
  for (let y = y0; y <= vbY + vbH; y += GRID) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(vbX)); line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(vbX + vbW)); line.setAttribute('y2', String(y));
    line.setAttribute('stroke', '#b0bec5'); line.setAttribute('stroke-width', '0.4');
    line.setAttribute('stroke-dasharray', '3 6');
    gridG.appendChild(line);
  }
  clone.insertBefore(gridG, clone.firstChild.nextSibling); // after <style>

  const serializer = new XMLSerializer();
  const svgStr = serializer.serializeToString(clone);
  const projName = (appState.state.project?.code || appState.state.project?.name || 'red-cpm').replace(/[^\w.-]/g, '_');

  // ---- SVG descargable ----
  if (fmt === 'svg') {
    _dlUrl(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }), projName + '_red-cpm.svg');
    return;
  }

  // ---- PNG: rasterizar a 3× para alta resolución ----
  if (fmt === 'png') {
    const scale = 3;
    const imgW = Math.round(vbW * scale), imgH = Math.round(vbH * scale);
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = imgW; cv.height = imgH;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, imgW, imgH);
      ctx.drawImage(img, 0, 0, imgW, imgH);
      URL.revokeObjectURL(url);
      cv.toBlob(blob => _dlUrl(blob, projName + '_red-cpm.png'), 'image/png');
    };
    img.onerror = () => { URL.revokeObjectURL(url); _showToast('Error al generar PNG.', 'error'); };
    img.src = url;
    return;
  }

  // ---- PDF: SVG vectorial en tiles con window.print ----
  if (fmt === 'pdf') {
    const _d = new Date();
    const today = _d.toLocaleDateString('es-PE');
    const fileDateStr = `${String(_d.getDate()).padStart(2,'0')}-${String(_d.getMonth()+1).padStart(2,'0')}-${_d.getFullYear()}`;
    const projDisplayName = _escHtml(appState.state.project?.name ?? projName);
    const fileTitle = `${appState.state.project?.name ?? projName}-Red CPM-${fileDateStr.replace(/-/g, '')}`;   // = nombre del PDF (PROYECTO-Proceso-Fecha)
    const _cpmDateStr = `${String(_d.getDate()).padStart(2,'0')}-${String(_d.getMonth()+1).padStart(2,'0')}-${_d.getFullYear()}, ${String(_d.getHours()).padStart(2,'0')}:${String(_d.getMinutes()).padStart(2,'0')}`;

    // Obtener dimensiones del SVG clonado
    const _cpmSvgW = vbW;
    const _cpmSvgH = vbH;

    // Serializar el SVG para incrustar directamente en el HTML
    const svgInline = serializer.serializeToString(clone);

    const _cpmPdfFile = `${appState.state.project?.name ?? projName}-Red CPM-${String(_d.getDate()).padStart(2,'0')}${String(_d.getMonth()+1).padStart(2,'0')}${_d.getFullYear()}.pdf`;
    const _svgInnerMatch = svgInline.match(/^<svg[^>]*>([\s\S]*)<\/svg>$/);
    const _svgInnerCpm = _svgInnerMatch ? _svgInnerMatch[1] : svgInline;

    const html = `<!doctype html>
<html lang="es"><head>
  <meta charset="UTF-8">
  ${FONTS_LINK}
  <title>${fileTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body  { font-family: 'Segoe UI', system-ui, sans-serif; background:#f1f5f9; }
    .controls { display: flex; align-items: center; gap: 8px; padding: 8px 12px;
                font-size: 12px; flex-wrap: wrap; background:#fff;
                border-bottom: 1px solid #e2e8f0; position: sticky; top:0; z-index:10; }
    .controls label { display: flex; align-items: center; gap: 5px; color: #64748b; }
    .controls input[type=number] { width: 46px; padding: 2px 4px; border: 1px solid #d1d5db;
                                   border-radius: 4px; font-size: 12px; text-align:center;
                                   background:#f8fafc; color:#374151; }
    .btn-c { border: 1px solid #d1d5db; border-radius: 5px; padding: 4px 10px;
             font-size: 12px; cursor: pointer; background: #fff; color: #374151; white-space:nowrap; }
    .btn-c:hover, .btn-c.active { background: #1976D2; color: #fff; border-color: #1976D2; }
    .btn-print { background: #1976D2; color: #fff; border: none; border-radius: 5px;
                 padding: 6px 16px; font-size: 13px; cursor: pointer; font-weight:600; }
    .btn-print:hover { background: #1565C0; }
    .sep { width: 1px; height: 20px; background: #e2e8f0; flex-shrink:0; }
    .lbl-sm { font-size:11px; color:#64748b; white-space:nowrap; }
    input[type=text].fn-inp { font-size:12px; padding:3px 8px; border:1px solid #d1d5db;
                border-radius:4px; background:#f8fafc; color:#374151; width:260px; }
    .preview { padding: 20px; display:flex; flex-direction:column; align-items:center; gap:16px; min-height:calc(100vh - 52px); }
    .page-tile { background:#fff; box-shadow:0 4px 14px rgba(0,0,0,.4); position:relative; flex-shrink:0; }
    .page-tile svg { display:block; }
    .page-foot { position:absolute; bottom:1mm; left:0; right:0;
                 display:flex; justify-content:space-between; font-size:6pt; color:#718096;
                 border-top:0.5pt solid #CBD5E0; padding-top:2px;
                 font-family:'Urbanist',system-ui,sans-serif; }
    .page-title { position:absolute; top:4.5mm; left:0; right:0; text-align:center;
                  font-family:'Urbanist',system-ui,sans-serif; font-size:14pt; font-weight:600; color:#1A365D; }
    .page-head { position:absolute; top:1mm; left:0; right:0;
                 display:flex; justify-content:space-between; font-size:6pt; color:#4A5568;
                 border-bottom:0.5pt solid #CBD5E0; padding-bottom:2px;
                 font-family:'Urbanist',system-ui,sans-serif; }
    @media print {
      body { background:#fff; }
      .controls { display:none !important; }
      .preview { padding:0; gap:0; background:#fff; min-height:0; }
      .page-tile { box-shadow:none; break-after:page; page-break-after:always; margin:0; }
      .page-tile:last-child { break-after:avoid; page-break-after:avoid; }
      .page-foot { display:flex !important; }
    }
    ${pageHfCss({ proj: appState.state.project?.name ?? projName, date: _cpmDateStr })}
    ${REPORT_FONT_CSS}
  </style>
</head><body>
  <div class="controls">
    <label>Papel: <select id="paper" onchange="autoPages();renderTiles()" title="Tamaño del papel del PDF">
      <option value="A4" selected>A4</option><option value="A3">A3</option><option value="A2">A2</option><option value="A1">A1</option>
      <option value="Carta">Carta</option><option value="Oficio">Oficio</option><option value="Legal">Legal</option><option value="Tabloide">Tabloide</option>
    </select></label>
    <div class="sep"></div>
    <span class="lbl-sm">Orientaci&#243;n:</span>
    <button class="btn-c active" id="btn-land" onclick="setOrient('landscape')">&#x2B1B; Horizontal</button>
    <button class="btn-c" id="btn-port" onclick="setOrient('portrait')">&#x1F532; Vertical</button>
    <div class="sep"></div>
    <label title="Toda la red en una sola hoja"><input type="checkbox" id="fit1" onchange="renderTiles()"> Todo en 1 hoja</label>
    <div class="sep"></div>
    <label title="Franjas horizontales en que se corta la red (hojas una debajo de otra)">Hojas H: <input type="number" id="pg-rows" min="1" max="10" value="1" onchange="renderTiles()"></label>
    <label title="Columnas en que se corta el ancho de la red">Hojas V: <input type="number" id="pg-cols" min="1" max="10" value="1" onchange="renderTiles()"></label>
    <div class="sep"></div>
    <span class="lbl-sm">&#x1F4C1; Archivo:</span>
    <input type="text" id="fn-inp" class="fn-inp" value="${_cpmPdfFile}" title="Nombre sugerido del archivo PDF" oninput="document.title=this.value.replace(/\.pdf$/i,'')">
    <div class="sep"></div>
    <span class="lbl-sm">${today}</span>
    <div class="sep"></div>
    <button class="btn-c" onclick="window.close()">&#x2715; Cerrar</button>
    <button class="btn-print" style="margin-left:auto" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
  </div>
  <div class="preview" id="preview"></div>

  <script>
    const SVG_W = ${_cpmSvgW};
    const SVG_H = ${_cpmSvgH};
    const SVG_INNER = ${JSON.stringify(_svgInnerCpm)};
    const PROJ_NAME = ${JSON.stringify(appState.state.project?.name ?? projName)};
    const DATE_STR = ${JSON.stringify(_cpmDateStr)};
    const TOTAL_PAGES_REF = { v: 1 };

    /** Fila de encabezado/pie estándar: tres textos (izquierda, centro, derecha). */
    function hfRow(cls, texts) {
      const row = document.createElement('div');
      row.className = cls;
      for (const t of texts) { const s = document.createElement('span'); s.textContent = t; row.appendChild(s); }
      return row;
    }

    const HF_IN_MARGIN = ${supportsPageMarginBoxes()};  // encabezado/pie en el margen de la hoja (@page)
    const MIN_PT = 6, BASE_PX = 8;    // el texto más chico de la red (8px) se imprime a 6pt o más

    let _orient = 'landscape';

    /** Tamaños de papel (mm, vertical). */
    const PAPERS = { A4: [210, 297], A3: [297, 420], A2: [420, 594], A1: [594, 841],
                     Carta: [216, 279], Oficio: [216, 330], Legal: [216, 356], Tabloide: [279, 432] };

    /** Hoja (mm) y área útil: márgenes de 10mm, banda del título y, sin margin boxes, encabezado/pie. */
    function layout() {
      const isLand = _orient === 'landscape';
      const [pw, ph] = PAPERS[document.getElementById('paper').value] || PAPERS.A4;
      const W = isLand ? Math.max(pw, ph) : Math.min(pw, ph), H = isLand ? Math.min(pw, ph) : Math.max(pw, ph);
      const MARG = 10, top = HF_IN_MARGIN ? 9 : 12, bottom = HF_IN_MARGIN ? 0 : 5;
      return { W, H, MARG, top, bottom, availW: W - 2 * MARG, availH: H - 2 * MARG - top - bottom };
    }

    /** Hojas V (columnas) y H (franjas) necesarias para que el texto quede legible (≥ MIN_PT). */
    function autoPages() {
      const L = layout(), mmPerPx = MIN_PT / BASE_PX * 25.4 / 72;
      document.getElementById('pg-cols').value = Math.min(10, Math.max(1, Math.ceil(SVG_W * mmPerPx / L.availW)));
      document.getElementById('pg-rows').value = Math.min(10, Math.max(1, Math.ceil(SVG_H * mmPerPx / L.availH)));
    }

    function setOrient(o) {
      _orient = o;
      document.getElementById('btn-land').classList.toggle('active', o === 'landscape');
      document.getElementById('btn-port').classList.toggle('active', o === 'portrait');
      autoPages();
      renderTiles();
    }

    function renderTiles() {
      const fit1 = document.getElementById('fit1').checked;   // "Todo en 1 hoja"
      const colsIn = document.getElementById('pg-cols'), rowsIn = document.getElementById('pg-rows');
      colsIn.disabled = rowsIn.disabled = fit1;
      if (fit1) colsIn.value = rowsIn.value = 1;
      const hPages = Math.max(1, Math.min(10, parseInt(colsIn.value) || 1));   // columnas (Hojas V)
      const vPages = Math.max(1, Math.min(10, parseInt(rowsIn.value) || 1));   // franjas (Hojas H)
      const { W, H, MARG, top, bottom, availW, availH } = layout();

      const cellW = SVG_W / hPages;
      const cellH = SVG_H / vPages;
      // El SVG mide exactamente su porción escalada: si fuera más grande que la porción
      // (preserveAspectRatio meet), mostraría filas/columnas de la hoja siguiente.
      const scale = Math.min(availW / cellW, availH / cellH);
      const drawW = cellW * scale, drawH = cellH * scale;
      const totalPages = hPages * vPages;
      TOTAL_PAGES_REF.v = totalPages;

      let ps = document.getElementById('_ps') || document.createElement('style');
      ps.id = '_ps';
      ps.textContent = '@page{size:' + W + 'mm ' + H + 'mm;margin:' + MARG + 'mm}';
      document.head.appendChild(ps);

      const preview = document.getElementById('preview');
      preview.innerHTML = '';
      let pageNum = 0;

      for (let j = 0; j < vPages; j++) {
        for (let i = 0; i < hPages; i++) {
          pageNum++;
          const vbX = i * cellW;
          const vbY = j * cellH;

          const tile = document.createElement('div');
          tile.className = 'page-tile';
          tile.style.width = availW + 'mm';
          tile.style.height = (availH + top + bottom) + 'mm';

          const svgEl = document.createElementNS('http://www.w3.org/2000/svg','svg');
          svgEl.setAttribute('viewBox', vbX + ' ' + vbY + ' ' + cellW + ' ' + cellH);
          svgEl.setAttribute('width', drawW + 'mm');
          svgEl.setAttribute('height', drawH + 'mm');
          svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
          svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
          svgEl.setAttribute('preserveAspectRatio', 'xMinYMin meet');
          svgEl.style.marginTop = top + 'mm';
          svgEl.style.overflow = 'hidden';
          svgEl.innerHTML = SVG_INNER;
          tile.appendChild(svgEl);

          const ttl = document.createElement('div');
          ttl.className = 'page-title';
          ttl.style.top = HF_IN_MARGIN ? '0' : '4.5mm';
          ttl.textContent = 'Red CPM';
          tile.appendChild(ttl);

          // Sin soporte de margin boxes: encabezado y pie dentro de la hoja, en bandas propias
          if (!HF_IN_MARGIN) {
            tile.appendChild(hfRow('page-head', ['ECM Project V1.00.01', PROJ_NAME, DATE_STR]));
            tile.appendChild(hfRow('page-foot', ['By EHCM', '—', 'Página ' + pageNum + ' de ' + totalPages]));
          }

          preview.appendChild(tile);
        }
      }
    }

    autoPages();
    renderTiles();
  <\/script>
</body></html>`;

    const win = window.open('', '_blank', 'width=1200,height=800');
    if (!win) { _showToast('El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.', 'warn'); return; }
    win.document.write(html);
    win.document.close();
  }
}

function _dlUrl(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

/** Dibuja la grilla de guías sobre el canvas de fondo del viewport CPM. */
function _drawCpmGrid(dlg, panX, panY, zoom) {
  const canvas = /** @type {HTMLCanvasElement|null} */ (dlg.querySelector('#cpm-net-grid'));
  const vp     = dlg.querySelector('#cpm-net-viewport');
  if (!canvas || !vp) return;
  const vpR = vp.getBoundingClientRect();
  canvas.width  = vpR.width;
  canvas.height = vpR.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Tamaño lógico de celda de grilla (en coordenadas de escena)
  const CELL = 100;
  // En pantalla
  const step = CELL * zoom;
  if (step < 8) return; // Grilla muy densa → omitir

  ctx.strokeStyle = 'rgba(180,180,210,0.22)';
  ctx.lineWidth   = 1;

  // Punto de inicio en pantalla (ajustado al pan)
  const startX = ((panX % step) + step) % step;
  const startY = ((panY % step) + step) % step;

  ctx.beginPath();
  for (let x = startX; x <= canvas.width;  x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); }
  for (let y = startY; y <= canvas.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); }
  ctx.stroke();

  // Ejes de nivel (líneas más gruesas cada 5 celdas)
  const stepMajor = step * 5;
  const startXM = ((panX % stepMajor) + stepMajor) % stepMajor;
  const startYM = ((panY % stepMajor) + stepMajor) % stepMajor;
  ctx.strokeStyle = 'rgba(150,150,200,0.35)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let x = startXM; x <= canvas.width;  x += stepMajor) { ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); }
  for (let y = startYM; y <= canvas.height; y += stepMajor) { ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); }
  ctx.stroke();
}

function _renderCpmNetwork() {
  const { cpmResult, tasks: taskMap, deps: depMap, project } = appState.state;
  if (!cpmResult) return;
  const svg = /** @type {SVGSVGElement|null} */ (document.getElementById('cpm-net-svg'));
  if (!svg) return;
  svg.innerHTML = '';

  // Tareas hoja activas con resultado CPM
  const parentIds = new Set([...taskMap.values()].filter(t => !t.deleted_at).map(t => t.parent_id).filter(Boolean));
  const leafTasks = [...taskMap.values()].filter(t => !t.deleted_at && !parentIds.has(t.id) && cpmResult.tasks.has(t.id));

  if (!leafTasks.length) {
    svg.innerHTML = '<text x="40" y="60" fill="var(--clr-text)" font-size="14">No hay tareas hoja con CPM calculado.</text>';
    return;
  }

  const leafSet = new Set(leafTasks.map(t => t.id));
  const activeDeps = [...depMap.values()].filter(d => !d.deleted_at && leafSet.has(d.pred_id) && leafSet.has(d.succ_id));

  // Calcular niveles topológicos (BFS: nivel = max(nivel de predecesores) + 1)
  const predCount = new Map(leafTasks.map(t => [t.id, 0]));
  const succOf = new Map(leafTasks.map(t => [t.id, []]));
  for (const d of activeDeps) {
    predCount.set(d.succ_id, (predCount.get(d.succ_id) ?? 0) + 1);
    succOf.get(d.pred_id)?.push(d.succ_id);
  }
  const level = new Map();
  const queue = leafTasks.filter(t => (predCount.get(t.id) ?? 0) === 0).map(t => t.id);
  queue.forEach(id => level.set(id, 0));
  const remaining = new Map(predCount);
  let qi = 0;
  while (qi < queue.length) {
    const id = queue[qi++];
    const lv = level.get(id) ?? 0;
    for (const succId of (succOf.get(id) ?? [])) {
      const newLv = Math.max(level.get(succId) ?? 0, lv + 1);
      level.set(succId, newLv);
      remaining.set(succId, (remaining.get(succId) ?? 1) - 1);
      if ((remaining.get(succId) ?? 1) <= 0) queue.push(succId);
    }
  }
  // Tasks sin nivel (en ciclos) → nivel máximo + 1
  const maxLv = Math.max(0, ...level.values());
  leafTasks.forEach(t => { if (!level.has(t.id)) level.set(t.id, maxLv + 1); });

  // Agrupar por nivel
  const byLevel = new Map();
  leafTasks.forEach(t => {
    const lv = level.get(t.id) ?? 0;
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(t);
  });
  // Ordenar cada nivel por sort_order
  byLevel.forEach(arr => arr.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)));

  // Dimensiones de caja
  const BW = 148, BH = 80, GAP_X = 60, GAP_Y = 20;
  const STRIDE_X = BW + GAP_X;
  const STRIDE_Y = BH + GAP_Y;

  // Calcular posición de cada tarea (centrado vertical por columna)
  const pos = new Map(); // id → {x, y, cx, cy}
  const _maxColCount = Math.max(1, ...[...byLevel.values()].map(arr => arr.length));
  byLevel.forEach((tasks, lv) => {
    const offsetY = Math.floor((_maxColCount - tasks.length) / 2) * STRIDE_Y;
    tasks.forEach((t, row) => {
      const x = lv * STRIDE_X;
      const y = offsetY + row * STRIDE_Y;
      pos.set(t.id, { x, y, cx: x + BW / 2, cy: y + BH / 2 });
    });
  });

  // Aplicar posiciones guardadas por el usuario (drag persistido)
  const savedNodePos = _getCpmNodePos();
  pos.forEach((p, id) => {
    if (savedNodePos[id]) { p.x = savedNodePos[id].x; p.y = savedNodePos[id].y; p.cx = p.x + BW/2; p.cy = p.y + BH/2; }
  });

  // Obtener fecha de inicio del proyecto para mostrar días reales
  const startDate = project?.start_date ? new Date(project.start_date) : null;
  const fmtDay = (/** @type {number} */ idx) => {
    if (!startDate) return String(idx);
    const d = new Date(startDate);
    d.setDate(d.getDate() + idx);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  };

  // Definir marcador de flecha
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const mkMarker = (id, color) => {
    const m = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    m.setAttribute('id', id);
    m.setAttribute('markerWidth', '8'); m.setAttribute('markerHeight', '6');
    m.setAttribute('refX', '8'); m.setAttribute('refY', '3');
    m.setAttribute('orient', 'auto');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M0,0 L8,3 L0,6 Z');
    path.setAttribute('fill', color);
    m.appendChild(path);
    return m;
  };
  defs.appendChild(mkMarker('arr-crit', '#e74c3c'));
  defs.appendChild(mkMarker('arr-near', '#f39c12'));
  defs.appendChild(mkMarker('arr-norm', '#7f8c8d'));
  svg.appendChild(defs);

  // Dibujar flechas primero (debajo de las cajas)
  for (const d of activeDeps) {
    const p1 = pos.get(d.pred_id);
    const p2 = pos.get(d.succ_id);
    if (!p1 || !p2) continue;
    const r1 = cpmResult.tasks.get(d.pred_id);
    const r2 = cpmResult.tasks.get(d.succ_id);
    const isCrit = r1?.is_critical && r2?.is_critical;
    const isNear = !isCrit && ((r1?.tf ?? 99) <= 5 || (r2?.tf ?? 99) <= 5);
    const color = isCrit ? '#e74c3c' : isNear ? '#f39c12' : '#7f8c8d';
    const marker = isCrit ? 'arr-crit' : isNear ? 'arr-near' : 'arr-norm';

    const x1 = p1.x + BW, y1 = p1.cy;
    const x2 = p2.x, y2 = p2.cy;
    const mx = (x1 + x2) / 2;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    line.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', isCrit ? '2' : '1.5');
    line.setAttribute('marker-end', `url(#${marker})`);
    line.setAttribute('data-pred', d.pred_id);
    line.setAttribute('data-succ', d.succ_id);
    if (d.lag_days) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(mx)); text.setAttribute('y', String((y1 + y2) / 2 - 4));
      text.setAttribute('text-anchor', 'middle'); text.setAttribute('font-size', '10');
      text.setAttribute('fill', color);
      text.textContent = `${d.lag_days > 0 ? '+' : ''}${d.lag_days}d`;
      svg.appendChild(text);
    }
    svg.appendChild(line);
  }

  // Dibujar cajas
  for (const t of leafTasks) {
    const p = pos.get(t.id);
    if (!p) continue;
    const r = cpmResult.tasks.get(t.id);

    const isCrit = r?.is_critical;
    const isNear = !isCrit && (r?.tf ?? 99) <= 5;
    const isComp = r?.is_complete;
    const fillColor = isComp ? '#27ae60' : isCrit ? '#e74c3c' : isNear ? '#f39c12' : '#2980b9';
    const lightFill = isComp ? '#eafaf1' : isCrit ? '#fdedec' : isNear ? '#fef9e7' : '#eaf4fb';

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    // Rect exterior
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(p.x)); rect.setAttribute('y', String(p.y));
    rect.setAttribute('width', String(BW)); rect.setAttribute('height', String(BH));
    rect.setAttribute('rx', '4'); rect.setAttribute('fill', lightFill);
    rect.setAttribute('stroke', fillColor); rect.setAttribute('stroke-width', isCrit ? '2' : '1');
    g.appendChild(rect);

    // Franja superior (ES | DUR | EF)
    const top = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    top.setAttribute('x', String(p.x)); top.setAttribute('y', String(p.y));
    top.setAttribute('width', String(BW)); top.setAttribute('height', '20');
    top.setAttribute('rx', '4'); top.setAttribute('fill', fillColor); top.setAttribute('stroke', 'none');
    g.appendChild(top);
    // Franja inferior (LS | TF | LF)
    const bot = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bot.setAttribute('x', String(p.x)); bot.setAttribute('y', String(p.y + BH - 20));
    bot.setAttribute('width', String(BW)); bot.setAttribute('height', '20');
    bot.setAttribute('rx', '4'); bot.setAttribute('fill', fillColor + '88'); bot.setAttribute('stroke', 'none');
    g.appendChild(bot);

    const mkTxt = (txt, x, y, anchor = 'middle', size = '10', bold = false, color = '#fff') => {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      el.setAttribute('x', String(x)); el.setAttribute('y', String(y));
      el.setAttribute('text-anchor', anchor); el.setAttribute('font-size', size);
      el.setAttribute('dominant-baseline', 'middle');
      if (bold) el.setAttribute('font-weight', 'bold');
      el.setAttribute('fill', color);
      el.textContent = txt;
      return el;
    };

    // Líneas divisoras verticales en franjas
    const div1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    div1.setAttribute('x1', String(p.x + BW / 3)); div1.setAttribute('y1', String(p.y));
    div1.setAttribute('x2', String(p.x + BW / 3)); div1.setAttribute('y2', String(p.y + 20));
    div1.setAttribute('stroke', 'rgba(255,255,255,0.4)'); div1.setAttribute('stroke-width', '0.5');
    g.appendChild(div1);
    const div2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    div2.setAttribute('x1', String(p.x + (2 * BW) / 3)); div2.setAttribute('y1', String(p.y));
    div2.setAttribute('x2', String(p.x + (2 * BW) / 3)); div2.setAttribute('y2', String(p.y + 20));
    div2.setAttribute('stroke', 'rgba(255,255,255,0.4)'); div2.setAttribute('stroke-width', '0.5');
    g.appendChild(div2);

    const W3 = BW / 3;
    const es = r?.es ?? 0, ef = r?.ef ?? 0, ls = r?.ls ?? 0, lf = r?.lf ?? 0;
    const tf = r?.tf != null ? String(r.tf) : '—';
    const dur = t.duration_days ?? 0;

    // Franja superior: ES | DUR | EF
    g.appendChild(mkTxt(fmtDay(es), p.x + W3 * 0.5, p.y + 10, 'middle', '9'));
    g.appendChild(mkTxt(String(dur) + 'd', p.x + W3 * 1.5, p.y + 10, 'middle', '9', true));
    g.appendChild(mkTxt(fmtDay(ef), p.x + W3 * 2.5, p.y + 10, 'middle', '9'));

    // Nombre (máx. 2 líneas)
    const name = t.name ?? '';
    const line1 = name.length > 22 ? name.substring(0, 22) + '…' : name;
    g.appendChild(mkTxt(line1, p.cx, p.y + 33, 'middle', '10', false, isCrit || isNear ? fillColor : '#1a2533'));

    // WBS code (derive inline: count position among siblings)
    const wbsCode = (() => {
      const parts = [];
      let cur = t;
      while (cur) {
        const siblings = [...taskMap.values()].filter(x => x.parent_id === cur.parent_id && !x.deleted_at).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
        parts.unshift(String(siblings.indexOf(cur) + 1));
        cur = cur.parent_id ? taskMap.get(cur.parent_id) : null;
      }
      return parts.join('.');
    })();
    if (wbsCode) {
      const wbsEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      wbsEl.setAttribute('x', String(p.x + 4)); wbsEl.setAttribute('y', String(p.y + 24));
      wbsEl.setAttribute('font-size', '8'); wbsEl.setAttribute('fill', '#888');
      wbsEl.textContent = wbsCode;
      g.appendChild(wbsEl);
    }

    // Franja inferior: LS | TF | LF
    g.appendChild(mkTxt(fmtDay(ls), p.x + W3 * 0.5, p.y + BH - 10, 'middle', '9'));
    g.appendChild(mkTxt('H' + tf, p.x + W3 * 1.5, p.y + BH - 10, 'middle', '9', true));
    g.appendChild(mkTxt(fmtDay(lf), p.x + W3 * 2.5, p.y + BH - 10, 'middle', '9'));

    // Divisores franja inferior
    const div3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    div3.setAttribute('x1', String(p.x + BW / 3)); div3.setAttribute('y1', String(p.y + BH - 20));
    div3.setAttribute('x2', String(p.x + BW / 3)); div3.setAttribute('y2', String(p.y + BH));
    div3.setAttribute('stroke', 'rgba(255,255,255,0.4)'); div3.setAttribute('stroke-width', '0.5');
    g.appendChild(div3);
    const div4 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    div4.setAttribute('x1', String(p.x + (2 * BW) / 3)); div4.setAttribute('y1', String(p.y + BH - 20));
    div4.setAttribute('x2', String(p.x + (2 * BW) / 3)); div4.setAttribute('y2', String(p.y + BH));
    div4.setAttribute('stroke', 'rgba(255,255,255,0.4)'); div4.setAttribute('stroke-width', '0.5');
    g.appendChild(div4);

    // ---- Drag de nodo CPM ----
    g.setAttribute('data-task-id', t.id);
    g.style.cursor = 'grab';
    let _dd = false, _dSx = 0, _dSy = 0, _dPx = p.x, _dPy = p.y;
    g.addEventListener('mousedown', ev => {
      if (ev.button !== 0) return;
      ev.stopPropagation(); // evitar pan del viewport
      _dd = true; _dPx = p.x; _dPy = p.y;
      const vpEl = /** @type {HTMLElement|null} */ (svg.closest('#cpm-net-viewport'));
      const vpR  = vpEl ? vpEl.getBoundingClientRect() : { left: 0, top: 0 };
      const cPX  = parseFloat(svg.dataset.panX ?? '40');
      const cPY  = parseFloat(svg.dataset.panY ?? '40');
      const cZ   = parseFloat(svg.dataset.zoom ?? '1');
      _dSx = (ev.clientX - vpR.left - cPX) / cZ;
      _dSy = (ev.clientY - vpR.top  - cPY) / cZ;
      g.style.cursor = 'grabbing';
      ev.preventDefault();
    });
    const _dMove = ev => {
      if (!_dd) return;
      const vpEl = /** @type {HTMLElement|null} */ (svg.closest('#cpm-net-viewport'));
      const vpR  = vpEl ? vpEl.getBoundingClientRect() : { left: 0, top: 0 };
      const cPX  = parseFloat(svg.dataset.panX ?? '40');
      const cPY  = parseFloat(svg.dataset.panY ?? '40');
      const cZ   = parseFloat(svg.dataset.zoom ?? '1');
      const sx   = (ev.clientX - vpR.left - cPX) / cZ;
      const sy   = (ev.clientY - vpR.top  - cPY) / cZ;
      p.x = Math.max(0, _dPx + (sx - _dSx));
      p.y = Math.max(0, _dPy + (sy - _dSy));
      p.cx = p.x + BW / 2; p.cy = p.y + BH / 2;
      g.setAttribute('transform', `translate(${p.x - _dPx},${p.y - _dPy})`);
      // Actualizar flechas conectadas a este nodo
      svg.querySelectorAll(`[data-pred="${t.id}"],[data-succ="${t.id}"]`).forEach(arrow => {
        const pred = arrow.getAttribute('data-pred'), succ = arrow.getAttribute('data-succ');
        const p1 = pos.get(pred), p2 = pos.get(succ);
        if (!p1 || !p2) return;
        const x1=p1.x+BW, y1=p1.cy, x2=p2.x, y2=p2.cy, mx=(x1+x2)/2;
        arrow.setAttribute('d', `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`);
      });
    };
    const _dUp = () => {
      if (!_dd) return;
      _dd = false; g.style.cursor = 'grab';
      // Ajustar coordenadas base al nuevo origen absoluto
      g.removeAttribute('transform');
      // Redibujar todos los elementos internos del grupo con la posición final
      // (simplificación: guardar y re-renderizar en el próximo render)
      const nm = _getCpmNodePos();
      nm[t.id] = { x: p.x, y: p.y };
      _setCpmNodePos(nm);
    };
    document.addEventListener('mousemove', _dMove);
    document.addEventListener('mouseup', _dUp);
    const _dlgEl = svg.closest('dialog');
    if (_dlgEl) _dlgEl.addEventListener('close', () => {
      document.removeEventListener('mousemove', _dMove);
      document.removeEventListener('mouseup', _dUp);
    }, { once: true });

    svg.appendChild(g);
  }
}

// Abre el diálogo de nuevo elemento pre-configurado con el padre dado
function _openNewItemWithParent(type, parentType, parentId, parentCode) {
  const dlg    = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-new-item'));
  if (!dlg) return;

  // Seleccionar tipo
  const typeInput = document.getElementById('ni-type-' + type);
  if (typeInput) /** @type {HTMLInputElement} */ (typeInput).click();

  // Abrir diálogo (necesita estar abierto para poder actualizar el select)
  dlg.showModal();

  // Esperar a que se carguen las opciones del select
  setTimeout(async () => {
    if (parentType && parentId) {
      const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ni-parent'));
      if (sel) {
        const val = parentType + ':' + parentId;
        // Si la opción no existe aún, esperar a que _loadParentOptions termine
        let attempts = 0;
        while (![...sel.options].some(o => o.value === val) && attempts++ < 20) {
          await new Promise(r => setTimeout(r, 50));
        }
        sel.value = val;
      }

      // Auto-sugerir código si el padre tiene uno
      if (parentCode) {
        const { projects: projs, programs: progs } = await loadHierarchy();
        let count = 0;
        if (type === 'project' && parentType === 'program') count = projs.filter(p => p.settings?.program_id === parentId).length;
        if (type === 'project' && parentType === 'portfolio') count = projs.filter(p => p.settings?.portfolio_id === parentId && !p.settings?.program_id).length;
        if (type === 'program' && parentType === 'portfolio') count = progs.filter(p => p.portfolio_id === parentId).length;
        const codeEl = /** @type {HTMLInputElement|null} */ (document.getElementById('ni-code'));
        if (codeEl && !codeEl.value) codeEl.value = `${parentCode}-${String(count + 1).padStart(2, '0')}`;
      }
    }
    document.getElementById('ni-name')?.focus();
  }, 80);
}

document.addEventListener('DOMContentLoaded', () => {
  _bindToolbar();
  _bindNewProject();
  _bindLinkMode();
  _bindResizer();
  _bindResizerExplorer();
  document.getElementById('btn-orgchart-view')?.addEventListener('click', _showOrgChart);
  document.getElementById('btn-cpm-network')?.addEventListener('click', _showCpmNetwork);
  // Keyboard activation for static view items (role="button")
  ['btn-orgchart-view','btn-cpm-network','btn-edt-view','btn-gantt-view','btn-dcma-view','btn-sync-view','btn-evm-view','btn-resource-histogram-view'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); document.getElementById(id)?.click(); } });
  });

  // Cerrar panel explorador y navegar a la vista seleccionada
  const _closeExplorer = () => {
    document.getElementById('explorer-panel')?.classList.remove('open');
    document.getElementById('drawer-overlay')?.classList.remove('visible');
  };
  document.getElementById('btn-edt-view')?.addEventListener('click', () => {
    _closeExplorer();
    document.getElementById('wbs-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.getElementById('btn-gantt-view')?.addEventListener('click', () => {
    _closeExplorer();
    document.getElementById('gantt-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => _ganttCanvas?.requestRender(), 150);
  });
  document.getElementById('btn-hard-reload')?.addEventListener('click', async () => {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (_) { /* ignore */ }
    location.reload();
  });
  document.getElementById('btn-dcma-view')?.addEventListener('click', () => {
    _closeExplorer();
    const panel = document.getElementById('dcma-panel');
    if (panel) {
      const isOpen = panel.classList.toggle('open');
      if (isOpen) _dcmaPanel?.refresh();
      document.getElementById('btn-dcma-view')?.classList.toggle('active', isOpen);
    }
  });
  document.getElementById('btn-sync-view')?.addEventListener('click', () => {
    _closeExplorer();
    const status = appState.state.syncStatus;
    const labels = /** @type {Record<string,string>} */ ({
      local: 'Modo local (sin Supabase)',
      synced: 'Sincronizado con Supabase ✓',
      syncing: 'Sincronizando con Supabase…',
      offline: 'Sin conexión a internet',
      conflict: 'Conflicto de datos detectado',
    });
    _showToast(labels[status] ?? `Sync: ${status}`);
  });
  document.getElementById('btn-evm-view')?.addEventListener('click', () => {
    _closeExplorer();
    const panel = document.getElementById('evm-panel');
    const isOpen = panel?.classList.toggle('open');
    if (isOpen) _evmPanel?.refresh();
    document.getElementById('btn-evm-view')?.classList.toggle('active', !!isOpen);
  });
  document.getElementById('btn-resource-histogram-view')?.addEventListener('click', () => {
    _closeExplorer();
    const panel = document.getElementById('resource-histogram-panel');
    const rc    = document.getElementById('right-content');
    const isOpen = panel?.classList.toggle('open');
    rc?.classList.toggle('has-histogram', !!isOpen);
    document.getElementById('btn-resource-histogram-view')?.classList.toggle('active', !!isOpen);
    if (isOpen) {
      _rhPanel?.refresh();
      const wbs = document.getElementById('wbs-panel');
      const rt  = document.getElementById('resource-table-panel');
      if (wbs && rt) rt.style.width = wbs.offsetWidth + 'px';
    }
  });
  document.getElementById('btn-resource-leveling-view')?.addEventListener('click', async () => {
    _closeExplorer();
    const { project, tasks, cpmResult } = appState.state;
    if (!project) { _showToast('Abre un proyecto primero', 'warn'); return; }
    if (!cpmResult) { _showToast('Calculando CPM…', 'warn'); return; }
    try {
      const [resources, taskResources] = await Promise.all([
        getAll('resources').then(r => r.filter(x => !x.deleted_at)),
        getByIndex('task_resources', 'project_id', project.id).then(r => r.filter(x => !x.deleted_at)).catch(() => []),
      ]);
      const taskArr = [...tasks.values()].filter(t => !t.deleted_at);
      const conflicts = detectConflicts(taskArr, cpmResult.tasks, resources, taskResources);
      const levelPanel = document.getElementById('panel-resource-leveling');
      const container = document.getElementById('resource-leveling-container');
      if (levelPanel && container) {
        if (!conflicts.overloaded.length) {
          container.innerHTML = '<p style="font-size:13px;color:var(--clr-text)">✅ No se detectaron conflictos de recursos en el cronograma.</p>';
        } else {
          const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          container.innerHTML = `<p style="font-size:13px;color:var(--clr-text)">Se detectaron <strong>${conflicts.overloaded.length}</strong> conflicto(s) de recursos.</p>
            <ul style="font-size:12px;color:var(--clr-text-2);margin:8px 0 0;padding-left:18px">
              ${conflicts.overloaded.map(c => `<li>Recurso <strong>${esc(c.resource.name)}</strong> — día ${c.day}: carga ${c.load.toFixed(1)} / capacidad ${c.capacity}</li>`).join('')}
            </ul>`;
        }
        levelPanel.style.display = 'flex';
        document.getElementById('btn-resource-leveling-view')?.classList.add('active');
      } else {
        _showToast(conflicts.overloaded.length ? `${conflicts.overloaded.length} conflicto(s) de recursos` : 'Sin conflictos de recursos', conflicts.overloaded.length ? 'warn' : 'success');
      }
    } catch (err) {
      _showToast('Error en nivelación: ' + err.message, 'error');
    }
  });
  document.getElementById('btn-monte-carlo-view')?.addEventListener('click', () => {
    _closeExplorer();
    const { project, cpmResult, tasks, deps, calendar, calExceptions } = appState.state;
    if (!project) { _showToast('Abre un proyecto primero', 'warn'); return; }
    if (!cpmResult) { _showToast('Calculando CPM…', 'warn'); return; }
    const dlg = /** @type {HTMLDialogElement} */ (document.getElementById('dlg-monte-carlo'));
    const container = /** @type {HTMLElement} */ (document.getElementById('monte-carlo-container'));
    if (!dlg || !container) return;
    if (!_mcPanel) _mcPanel = new MonteCarloPanel(container);
    const _mcCal = new Calendar({
      work_week: calendar?.work_week ?? [1,2,3,4,5],
      exceptions: (calExceptions ?? []).filter(e => !e.deleted_at).map(e => ({ on_date: e.on_date, is_working: e.is_working })),
    });
    _mcPanel.onCpmUpdate(cpmResult, tasks, project, _mcCal, [...(deps?.values() ?? [])]);
    _mcPanel.refresh(project.id);
    dlg.showModal?.() ?? (dlg.style.display = 'block');
    document.getElementById('btn-monte-carlo-view')?.classList.add('active');
  });
  document.getElementById('btn-risk-register-view')?.addEventListener('click', () => {
    _closeExplorer();
    const { project } = appState.state;
    if (!project) { _showToast('Abre un proyecto primero', 'warn'); return; }
    const overlay = /** @type {HTMLElement} */ (document.getElementById('panel-risk-register'));
    const container = /** @type {HTMLElement} */ (document.getElementById('risk-register-container'));
    if (!overlay || !container) return;
    if (overlay.style.display === 'flex') { overlay.style.display = 'none'; document.getElementById('btn-risk-register-view')?.classList.remove('active'); return; }
    overlay.style.display = 'flex';
    document.getElementById('btn-risk-register-view')?.classList.add('active');
    new RiskRegisterPanel({ projectId: project.id, container, onClose: () => {
      overlay.style.display = 'none';
    }});
  });

  installDesktopPrint();
  initReports();
  _initAuthUI();
  init();
});

// ============================================================
// Auth UI: botón usuario en toolbar + reactividad
// ============================================================
async function _initAuthUI() {
  if (IS_LOCAL_MODE) return;

  // Inicializar sesión guardada
  await authInit();

  // Ocultar contenido mientras no hay sesión
  document.body.classList.toggle('app--noauth', !authState.user);

  // Suscribir a cambios de estado
  authState.subscribe(_renderAuthBtn);
  _renderAuthBtn(authState);

  // Mostrar login automáticamente si no hay sesión
  if (!authState.user) {
    setTimeout(() => showLoginModal(), 300);
  }
}

function _getInitials(nombre) {
  const parts = (nombre || '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0]?.[0] || 'U').toUpperCase();
}

function _renderAuthBtn(state) {
  document.body.classList.toggle('app--noauth', !state.user);
  let btn = document.getElementById('btn-auth-user');
  if (!btn) {
    const themeBtn = document.getElementById('btn-theme');
    if (!themeBtn) return;
    btn = document.createElement('button');
    btn.id = 'btn-auth-user';
    btn.style.cssText = 'display:flex;align-items:center;gap:7px;padding:3px 10px 3px 4px;border-radius:20px;border:1.5px solid var(--clr-border,#d1d5db);background:none;cursor:pointer;color:var(--clr-text,#111);font-family:var(--font-ui,system-ui);font-size:11px;white-space:nowrap;transition:background .15s';
    themeBtn.insertAdjacentElement('beforebegin', btn);
    btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--clr-surface-2,#f0f0ff)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; });
    btn.addEventListener('click', (e) => { e.stopPropagation(); _toggleAuthMenu(); });
    document.addEventListener('click', () => { document.getElementById('auth-menu')?.remove(); });
  }

  if (state.user) {
    const nombre  = state.perfil?.full_name || state.user.email?.split('@')[0] || 'Usuario';
    const initials = _getInitials(nombre);
    btn.title = nombre;
    btn.innerHTML = `
      <span style="width:24px;height:24px;border-radius:50%;background:var(--clr-accent,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">${_escHtml(initials)}</span>
      <span style="max-width:120px;overflow:hidden;text-overflow:ellipsis">${_escHtml(nombre)}</span>
    `;
  } else {
    btn.innerHTML = 'Ingresar';
    btn.style.borderRadius = '6px';
    btn.onclick = () => showLoginModal();
  }
}

function _toggleAuthMenu() {
  const existing = document.getElementById('auth-menu');
  if (existing) { existing.remove(); return; }
  if (!authState.user) { showLoginModal(); return; }

  const btn = document.getElementById('btn-auth-user');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();

  const menu = document.createElement('div');
  menu.id = 'auth-menu';
  menu.style.cssText = `
    position:fixed;top:${rect.bottom + 6}px;right:${window.innerWidth - rect.right}px;
    background:var(--clr-surface,#fff);border:1px solid var(--clr-border,#e2e8f0);
    border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.16);
    z-index:1000;min-width:230px;overflow:hidden;
    font-family:var(--font-ui,system-ui);font-size:.875rem;
  `;

  const nombre   = authState.perfil?.full_name || authState.user?.email?.split('@')[0] || 'Usuario';
  const email    = authState.user?.email || '';
  const empresa  = authState.empresaActual?.org_name || '';
  const rol      = authState.empresaActual?.empresa_role || authState.perfil?.platform_role || '';
  const rolLabel = { super_admin:'Super Admin', relevo:'Relevo', miembro:'Miembro', invitado_externo:'Invitado', propietario:'Propietario', co_propietario:'Co-propietario', ninguno:'' };
  const initials = _getInitials(nombre);
  const now      = new Date();
  const fechaStr = now.toLocaleDateString('es-PE',{day:'2-digit',month:'2-digit',year:'numeric'}) + ' ' + now.toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'});

  // Cabecera con avatar + nombre + email + rol
  const header = document.createElement('div');
  header.style.cssText = 'padding:16px 16px 12px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--clr-border,#e2e8f0)';
  header.innerHTML = `
    <div style="width:40px;height:40px;border-radius:50%;background:var(--clr-accent,#4f46e5);color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0">${_escHtml(initials)}</div>
    <div style="min-width:0">
      <div style="font-weight:700;font-size:.95rem;color:var(--clr-text,#111);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escHtml(nombre)}</div>
      <div style="font-size:.78rem;color:var(--clr-text-3,#888);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escHtml(email)}</div>
      ${rolLabel[rol] ? `<div style="font-size:.75rem;color:var(--clr-accent,#4f46e5);font-weight:500;margin-top:1px">${_escHtml(rolLabel[rol])}</div>` : ''}
    </div>
  `;
  menu.appendChild(header);

  const body = document.createElement('div');
  body.style.cssText = 'padding:6px';
  menu.appendChild(body);

  const addItem = (label, action) => {
    const el = document.createElement('button');
    el.style.cssText = 'display:block;width:100%;padding:9px 12px;text-align:left;border:none;background:none;border-radius:8px;cursor:pointer;color:var(--clr-text,#111);font-size:.875rem;font-family:inherit';
    el.textContent = label;
    el.addEventListener('mouseenter', () => { el.style.background = 'var(--clr-surface-2,#f0f0ff)'; });
    el.addEventListener('mouseleave', () => { el.style.background = 'none'; });
    el.addEventListener('click', (e) => { e.stopPropagation(); menu.remove(); action?.(); });
    body.appendChild(el);
  };

  const platformRol = authState.perfil?.platform_role || '';
  const esAdmin = ['super_admin','relevo'].includes(rol)
    || ['propietario','co_propietario'].includes(platformRol)
    || authState.empresas.length === 0;
  if (esAdmin) {
    addItem('Gestionar usuarios', () => showUsuariosPanel());
    addItem('Configurar empresa',  () => showEmpresaAdminPanel());
  }
  if (authState.empresas.length > 1) {
    addItem('Cambiar empresa', () => showLoginModal());
  }
  addItem('Cambiar contraseña', () => {
    import('./auth.js?v=180').then(m => m.showLoginModal?.());
  });
  addItem('Cerrar sesión', () => logout());

  // Pie con versión y fecha
  const footer = document.createElement('div');
  footer.style.cssText = 'padding:8px 14px;border-top:1px solid var(--clr-border,#e2e8f0);font-size:.72rem;color:var(--clr-text-3,#aaa);margin-top:4px';
  footer.textContent = `ECM Project v1.0.0 · ${fechaStr}`;
  menu.appendChild(footer);

  document.body.appendChild(menu);
}

