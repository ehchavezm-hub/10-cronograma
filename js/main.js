// @ts-check
/**
 * main.js — Punto de entrada de la aplicación.
 * Detecta file://, inicializa módulos, carga datos demo en modo local.
 */

import { IS_LOCAL_MODE } from './config.js';
import { appState }      from './state.js';
import { WbsTable }      from './wbs-table.js?v=9';
import { GanttCanvas }   from './gantt-canvas.js?v=28';
import { GanttScene }    from './scene.js';
import { DcmaPanel }     from './dcma.js';
import { Calendar, isoToDate } from './calendar.js';
import { computeCPM }    from './cpm.js';
import { openDB, listProjects, loadProject, saveProjectSnapshot, putMany, put as dbPut, getByIndex, remove as dbRemove,
         listPortfolios, savePortfolio, deletePortfolio, listPrograms, saveProgram, deleteProgram, loadHierarchy } from './storage.js?v=4';
import { t }             from './i18n.js';
import { DEMO_DATA }     from './demo-data.js';
import { exportJson, importJson, exportCsv, exportMspXml, exportSvg } from './io.js';
import { printWbsTable, printGantt, getPrintCols, setPrintCols } from './print.js?v=7';
import { SyncEngine }     from './sync.js';
import { outboxAdd }      from './storage.js?v=4';
import { EvmPanel }       from './evm.js';
import { ChangeLogPanel, logCommand } from './change-log.js';

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
        exceptions: calExceptions.filter(e => !e.deleted_at).map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
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
        exceptions: calExceptions.filter(e => !e.deleted_at).map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
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

function _initTaskDetailPanel() {
  if (_taskDetailPanel) return;
  const panel = document.createElement('div');
  panel.id = 'task-detail-panel';
  panel.style.cssText = `
    position:fixed;right:0;top:0;bottom:0;width:380px;max-width:100vw;
    background:var(--clr-surface);border-left:1px solid var(--clr-border);
    box-shadow:-4px 0 24px rgba(0,0,0,0.12);z-index:400;
    display:flex;flex-direction:column;transform:translateX(100%);
    transition:transform 0.22s cubic-bezier(.4,0,.2,1);overflow:hidden;
  `;
  panel.innerHTML = `
    <div id="tdp-header" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);flex-shrink:0">
      <span style="font-weight:700;font-size:14px">Detalle de actividad</span>
      <button id="tdp-close" class="btn btn-icon btn-sm" title="Cerrar">✕</button>
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
}

function _closeTaskDetail() {
  if (_taskDetailPanel) _taskDetailPanel.style.transform = 'translateX(100%)';
}

async function _openTaskDetail(taskId) {
  _initTaskDetailPanel();
  const task = appState.state.tasks.get(taskId);
  if (!task) return;

  _taskDetailPanel.dataset.taskId = taskId;
  const cpmTask = appState.state.cpmResult?.tasks?.get(taskId);
  const project = appState.state.project;
  const startIso = project?.start_date || new Date().toISOString().slice(0, 10);

  const idxToDate = (idx) => {
    if (idx == null) return '—';
    const cal = appState.state.calendar;
    const calDef = cal
      ? { work_week: cal.work_week, exceptions: (appState.state.calExceptions || []).filter(e => !e.deleted_at).map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
      : { work_week: [1,2,3,4,5], exceptions: [] };
    const calObj = new (/** @type {any} */ (window).__Calendar || Object)(calDef);
    // Usamos isoToDate + calendar.idxToDate si disponible, sino calculamos directo
    try {
      const { Calendar: Cal } = /** @type {any} */ ({});
      const start = new Date(startIso + 'T00:00:00');
      start.setDate(start.getDate() + idx);
      return start.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });
    } catch { return String(idx) + 'd'; }
  };

  // Calcular fechas desde índice de días
  const startDate = new Date(startIso + 'T00:00:00');
  const addDays = (n) => {
    if (n == null) return '—';
    const d = new Date(startDate);
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('es-PE', { day:'2-digit', month:'2-digit', year:'numeric' });
  };

  // Cargar recursos asignados
  let taskResources = [];
  let allResources = [];
  try {
    const { getAll, getByIndex } = await import('./storage.js?v=4');
    [allResources, taskResources] = await Promise.all([
      getAll('resources').then(r => r.filter(x => !x.deleted_at)),
      getByIndex('task_resources', 'task_id', taskId).then(r => r.filter(x => !x.deleted_at)),
    ]);
  } catch (e) { /* sin recursos */ }

  const constraintTypes = ['ASAP','ALAP','MSO','MFO','SNET','SNLT','FNET','FNLT'];
  const constraintLabels = { ASAP:'Lo antes posible', ALAP:'Lo más tarde posible',
    MSO:'Inicio no antes de', MFO:'Fin no antes de', SNET:'Inicio no antes de (SNET)',
    SNLT:'Inicio no después de', FNET:'Fin no antes de (FNET)', FNLT:'Fin no después de' };

  const resOpts = allResources.map(r =>
    `<option value="${r.id}">${_escHtml(r.name)}${r.role ? ' ('+_escHtml(r.role)+')' : ''}</option>`).join('');

  const resRows = taskResources.map(tr => {
    const res = allResources.find(r => r.id === tr.resource_id);
    const unitSuffix = res?.type === 'material' || res?.type === 'equipment'
      ? (res.unit_label ? ' ' + _escHtml(res.unit_label) : ' und')
      : ' %';
    const typeTag = { work: 'trabajo', material: 'material', equipment: 'equipo', cost: 'costo' };
    return `<tr data-trid="${tr.id}">
      <td style="padding:4px 8px;font-size:12px">${_escHtml(res?.name ?? '—')}<br><span style="font-size:10px;color:var(--clr-text-3)">${typeTag[res?.type ?? 'work'] ?? ''}</span></td>
      <td style="padding:4px 8px;font-size:12px">${_escHtml(res?.role ?? '')}</td>
      <td style="padding:4px 8px;font-size:12px"><input type="number" class="tdp-res-units" data-trid="${tr.id}" value="${tr.units ?? 100}" min="1" max="100000" style="width:64px;padding:2px 6px;border:1px solid var(--clr-border);border-radius:4px;font-size:11px;background:var(--clr-surface);color:var(--clr-text)">${unitSuffix}</td>
      <td style="padding:4px 8px"><button class="btn btn-icon btn-sm tdp-res-remove" data-trid="${tr.id}" title="Quitar" style="color:var(--clr-danger,#e74c3c);padding:0 6px">✕</button></td>
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
          <button id="tdp-open-catalog" class="btn btn-ghost btn-sm" title="Gestionar catálogo global de recursos" style="font-size:11px;padding:3px 8px">📚 Catálogo</button>
        </div>
        <table id="tdp-res-table" style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:var(--clr-surface-2)">
              <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Recurso</th>
              <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Rol</th>
              <th style="padding:4px 8px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Unidades</th>
              <th style="padding:4px 8px;width:32px"></th>
            </tr>
          </thead>
          <tbody id="tdp-res-body">${resRows || '<tr><td colspan="4" style="padding:8px;color:var(--clr-text-3);font-size:12px;text-align:center">Sin recursos asignados</td></tr>'}</tbody>
        </table>
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

  // Listeners para recursos
  body.querySelector('#tdp-res-add')?.addEventListener('click', () => _tdpAddResource(taskId));
  body.querySelector('#tdp-open-resources')?.addEventListener('click', (e) => { e.preventDefault(); _openResourceManager(); });
  body.querySelector('#tdp-open-catalog')?.addEventListener('click', () => _openResourceManager());
  body.addEventListener('click', (e) => {
    if (/** @type {HTMLElement} */ (e.target).classList.contains('tdp-res-remove')) {
      const trid = /** @type {HTMLElement} */ (e.target).dataset.trid;
      /** @type {HTMLElement} */ (e.target).closest('tr')?.remove();
      _taskDetailPanel.dataset['removeRes'] = (_taskDetailPanel.dataset['removeRes'] || '') + trid + ',';
    }
  });

  _taskDetailPanel.style.transform = 'translateX(0)';
}

async function _tdpAddResource(taskId) {
  const sel = /** @type {HTMLSelectElement} */ (document.getElementById('tdp-res-select'));
  if (!sel?.value) return;
  const resId = sel.value;
  const { getAll } = await import('./storage.js?v=4');
  const allRes = await getAll('resources').then(r => r.filter(x => !x.deleted_at));
  const res = allRes.find(r => r.id === resId);
  if (!res) return;

  // Verificar que no esté ya asignado
  const tbody = document.getElementById('tdp-res-body');
  const existing = tbody?.querySelector(`[data-trid]`);
  // Simplemente añadimos fila nueva (se persiste al guardar)
  const trid = crypto.randomUUID();
  const tr = document.createElement('tr');
  tr.dataset.trid = trid;
  tr.dataset.newRes = resId;
  const newUnitSuffix = res.type === 'material' || res.type === 'equipment'
    ? (res.unit_label ? ' ' + res.unit_label : ' und') : ' %';
  const newTypeTag = { work: 'trabajo', material: 'material', equipment: 'equipo', cost: 'costo' };
  tr.innerHTML = `
    <td style="padding:4px 8px;font-size:12px">${_escHtml(res.name)}<br><span style="font-size:10px;color:var(--clr-text-3)">${newTypeTag[res.type ?? 'work'] ?? ''}</span></td>
    <td style="padding:4px 8px;font-size:12px">${_escHtml(res.role ?? '')}</td>
    <td style="padding:4px 8px;font-size:12px"><input type="number" class="tdp-res-units" data-trid="${trid}" value="100" min="1" max="100000" style="width:64px;padding:2px 6px;border:1px solid var(--clr-border);border-radius:4px;font-size:11px;background:var(--clr-surface);color:var(--clr-text)">${_escHtml(newUnitSuffix)}</td>
    <td style="padding:4px 8px"><button class="btn btn-icon btn-sm tdp-res-remove" data-trid="${trid}" title="Quitar" style="color:var(--clr-danger,#e74c3c);padding:0 6px">✕</button></td>`;
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
    const { getByIndex, put: dbPutSt, remove: dbRemoveSt } = await import('./storage.js?v=4');
    // Eliminar los marcados
    const toRemove = (panel.dataset['removeRes'] || '').split(',').filter(Boolean);
    for (const trid of toRemove) {
      try { await dbRemoveSt('task_resources', trid); } catch {}
    }
    panel.dataset['removeRes'] = '';

    // Agregar nuevos
    const newRows = document.querySelectorAll('#tdp-res-body tr[data-new-res]');
    for (const row of newRows) {
      const resId = /** @type {HTMLElement} */ (row).dataset.newRes;
      const units = /** @type {HTMLInputElement|null} */ (row.querySelector('.tdp-res-units'))?.value ?? '100';
      const rec = {
        id: /** @type {HTMLElement} */ (row).dataset.trid,
        project_id: proj.id,
        task_id: taskId,
        resource_id: resId,
        units: parseFloat(units) || 100,
        org_id: proj.org_id ?? null,
        deleted_at: null,
      };
      await dbPutSt('task_resources', rec);
      delete /** @type {HTMLElement} */ (row).dataset.newRes;
    }
    // Actualizar unidades de los existentes
    const unitInputs = document.querySelectorAll('#tdp-res-body .tdp-res-units:not([data-new-res])');
    for (const inp of unitInputs) {
      const trid = /** @type {HTMLElement} */ (inp).dataset.trid;
      if (!trid) continue;
      const existing = await getByIndex('task_resources', 'task_id', taskId).then(r => r.find(x => x.id === trid)).catch(() => null);
      if (existing) { existing.units = parseFloat(/** @type {HTMLInputElement} */ (inp).value) || 100; await dbPutSt('task_resources', existing); }
    }
  }

  _showToast('Guardado', 'success');
  _closeTaskDetail();
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
  }

  const { getAll } = await import('./storage.js?v=4');
  const resources = await getAll('resources').then(r => r.filter(x => !x.deleted_at));

  const typeLabel = { work: 'Trabajo', material: 'Material', equipment: 'Equipo', cost: 'Costo fijo' };
  const typeBadgeColor = { work:'#1976D2', material:'#7B1FA2', equipment:'#E65100', cost:'#2E7D32' };
  const rows = resources.map(r => {
    const typ = r.type ?? 'work';
    // Precio/Unidad: para trabajo → S/XX/h; material/equipo → S/XX/<unidad>; costo → S/XX
    const unitSuffix = typ === 'work' ? '/h' : (r.unit_label ? '/'+r.unit_label : '');
    const priceCell = r.rate_per_hour != null ? `S/ ${r.rate_per_hour}${unitSuffix}` : '—';
    // Disponibilidad máxima solo para trabajo
    const dispMax = typ === 'work' ? `${r.max_units ?? 100}%` : (r.unit_label ? r.unit_label : '—');
    return `<tr style="border-bottom:1px solid var(--clr-border)">
      <td style="padding:6px 10px;font-size:13px;font-weight:500">${_escHtml(r.name)}</td>
      <td style="padding:6px 10px"><span style="font-size:10px;font-weight:600;padding:2px 6px;border-radius:4px;color:#fff;background:${typeBadgeColor[typ]??'#607D8B'}">${typeLabel[typ]??typ}</span></td>
      <td style="padding:6px 10px;font-size:12px;color:var(--clr-text-3)">${_escHtml(r.role ?? '—')}</td>
      <td style="padding:6px 10px;font-size:12px;color:var(--clr-text-3)">${priceCell}</td>
      <td style="padding:6px 10px;font-size:12px;color:var(--clr-text-3)">${dispMax}</td>
      <td style="padding:5px 8px;white-space:nowrap">
        <button class="btn btn-sm rm-assign" data-rid="${r.id}" title="Asignar este recurso a actividades" style="font-size:11px;padding:3px 8px;background:#1976D2;color:#fff;border:none;border-radius:5px;cursor:pointer;margin-right:4px">▶ Asignar</button>
        <button class="btn btn-icon btn-sm rm-del" data-rid="${r.id}" title="Eliminar" style="color:var(--clr-danger,#e74c3c)">🗑</button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--clr-text-3)">Sin recursos en el catálogo</td></tr>';

  dlg.innerHTML = `
    <div id="dlg-res-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);cursor:move;user-select:none" title="Arrastrar para mover">
      <div>
        <div style="font-weight:700;font-size:15px">Catálogo de Recursos</div>
        <div style="font-size:11px;color:var(--clr-text-3);margin-top:2px">Recursos disponibles para asignar a actividades</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <button id="dlg-res-assign" class="btn btn-primary btn-sm" title="Asignar recursos a actividades (masivo)" style="cursor:pointer">📌 Asignar Recursos</button>
        <button id="dlg-res-close" class="btn btn-icon btn-sm" style="cursor:default">✕</button>
      </div>
    </div>
    <div style="padding:16px;max-height:45vh;overflow-y:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="background:var(--clr-surface-2)">
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Nombre</th>
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Tipo</th>
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Rol</th>
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600">Precio/Ud.</th>
          <th style="padding:6px 10px;text-align:left;font-size:11px;color:var(--clr-text-3);font-weight:600" title="Disponibilidad máxima (Trabajo) o Unidad de medida (Material/Equipo)">Unid./Disp.Máx</th>
          <th style="width:130px"></th>
        </tr></thead>
        <tbody id="rm-body">${rows}</tbody>
      </table>
    </div>
    <div style="padding:14px 16px;border-top:1px solid var(--clr-border);background:var(--clr-surface-2)">
      <div style="font-size:12px;font-weight:700;color:var(--clr-text-2);margin-bottom:10px">Agregar recurso al catálogo</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
        <input id="rm-name" type="text" placeholder="Nombre *" style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
        <select id="rm-type" style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
          <option value="work">Trabajo (mano de obra)</option>
          <option value="material">Material</option>
          <option value="equipment">Equipo / Maquinaria</option>
          <option value="cost">Costo fijo</option>
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:10px">
        <input id="rm-role" type="text" placeholder="Rol / Especialidad" title="Ej: Ing. Civil, Operario, Albañil" style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
        <input id="rm-rate" type="number" min="0" step="0.01" placeholder="Precio/Unidad (S/)" title="Tasa estándar. Para trabajo: S/h. Para material: S/unidad." style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
        <span id="rm-fields-extra" style="display:contents">
          <input id="rm-unit-label" type="text" placeholder="Unidad (m³, kg, und…)" title="Unidad de medida — para material y equipo" style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text)">
          <input id="rm-max-units" type="number" min="1" max="100000" step="1" placeholder="Disponib. máx (%)" title="Disponibilidad máxima para recursos de trabajo (%). Ej: 100 = jornada completa, 50 = medio tiempo." style="padding:7px 10px;border:1px solid var(--clr-border);border-radius:7px;font-size:12px;background:var(--clr-surface);color:var(--clr-text);display:none">
        </span>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button id="rm-add" class="btn btn-primary btn-sm">＋ Agregar al catálogo</button>
        <span id="rm-type-hint" style="font-size:11px;color:var(--clr-text-3)">Tipo Trabajo: define rol y disponibilidad máxima (%)</span>
      </div>
    </div>`;

  dlg.querySelector('#dlg-res-close').addEventListener('click', () => dlg.close());
  dlg.querySelector('#dlg-res-assign').addEventListener('click', () => { dlg.close(); _openResourceAssign(); });

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
    const { put: dbPutSt } = await import('./storage.js?v=4');
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
      if (confirm('¿Eliminar este recurso?')) {
        const { remove: dbRemoveSt } = await import('./storage.js?v=4');
        await dbRemoveSt('resources', rid);
        btn.closest('tr')?.remove();
        _showToast('Recurso eliminado', 'success');
      }
    }
  });

  if (!dlg.open) dlg.show();
}

// ============================================================
// Asignación masiva de recursos a actividades
// ============================================================

async function _openResourceAssign(preSelectedId = null) {
  const { getAll, getByIndex, put: dbPut, remove: dbRemove } = await import('./storage.js?v=4');
  const resources = await getAll('resources').then(r => r.filter(x => !x.deleted_at));
  if (!resources.length) {
    _showToast('Agrega recursos al catálogo primero', 'warn');
    _openResourceManager();
    return;
  }
  const tasks = appState.state.tasks?.filter(t => !t.deleted_at && t.type !== 'milestone') ?? [];
  if (!tasks.length) { _showToast('No hay actividades en el proyecto', 'warn'); return; }

  let dlg = document.getElementById('dlg-res-assign');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-res-assign';
    dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:860px;max-width:98vw;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden;position:fixed;margin:0;top:60px;left:max(8px,calc(50vw - 430px));z-index:1100';
    document.body.appendChild(dlg);
  }

  const typeLabel = { work:'Trabajo', material:'Material', equipment:'Equipo', cost:'Costo' };
  const typeBadge = { work:'#1976D2', material:'#7B1FA2', equipment:'#E65100', cost:'#2E7D32' };

  const resItems = resources.map(r =>
    `<label class="ra-res-item" data-rid="${r.id}" style="display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:pointer;border-radius:6px;margin-bottom:2px;border:1px solid transparent">
      <input type="radio" name="ra-res" value="${r.id}" style="accent-color:#1976D2">
      <span style="flex:1;font-size:12px;font-weight:500">${_escHtml(r.name)}</span>
      <span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:4px;color:#fff;background:${typeBadge[r.type??'work']??'#607D8B'}">${typeLabel[r.type??'work']??r.type}</span>
    </label>`).join('');

  const wbsMap = {};
  tasks.forEach(t => { wbsMap[t.id] = t; });
  const taskItems = tasks.map(t =>
    `<label class="ra-task-item" data-tid="${t.id}" style="display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;border-radius:5px;margin-bottom:1px">
      <input type="checkbox" class="ra-task-cb" value="${t.id}" style="accent-color:#1976D2">
      <span style="font-size:11px;color:var(--clr-text-3);min-width:32px">${_escHtml(t.wbs_code??'')}</span>
      <span style="font-size:12px;flex:1">${_escHtml(t.name)}</span>
    </label>`).join('');

  dlg.innerHTML = `
    <div id="dlg-ra-hdr" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);cursor:move;user-select:none">
      <div>
        <div style="font-weight:700;font-size:15px">📌 Asignar Recursos a Actividades</div>
        <div style="font-size:11px;color:var(--clr-text-3);margin-top:2px">Selecciona un recurso y las actividades. Puedes filtrar y seleccionar todo.</div>
      </div>
      <button id="dlg-ra-close" class="btn btn-icon btn-sm">✕</button>
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
          <input id="ra-filter" type="text" placeholder="Filtrar por nombre…" style="flex:1;padding:4px 8px;border:1px solid var(--clr-border);border-radius:6px;font-size:11px;background:var(--clr-surface);color:var(--clr-text)">
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

  // Drag-to-move
  { const hdr = dlg.querySelector('#dlg-ra-hdr');
    let _ox=0,_oy=0,_d=false;
    const onM=e=>{if(!_d)return;dlg.style.left=Math.max(0,e.clientX-_ox)+'px';dlg.style.top=Math.max(0,e.clientY-_oy)+'px';};
    const onU=()=>{_d=false;hdr.style.cursor='move';};
    hdr.addEventListener('mousedown',e=>{if(e.target.closest('button'))return;const r=dlg.getBoundingClientRect();_ox=e.clientX-r.left;_oy=e.clientY-r.top;_d=true;hdr.style.cursor='grabbing';e.preventDefault();});
    if(dlg.__raClean)dlg.__raClean();
    document.addEventListener('mousemove',onM);document.addEventListener('mouseup',onU);
    dlg.__raClean=()=>{document.removeEventListener('mousemove',onM);document.removeEventListener('mouseup',onU);};
  }

  const _getSelectedRes = () => dlg.querySelector('input[name="ra-res"]:checked')?.value ?? null;
  const _getSelectedTasks = () => [...dlg.querySelectorAll('.ra-task-cb:checked')].map(cb => cb.value);
  const _updateCount = () => {
    const n = _getSelectedTasks().length;
    dlg.querySelector('#ra-count').textContent = n + ' sel.';
    const hasRes = !!_getSelectedRes();
    dlg.querySelector('#ra-btn-assign').disabled = !(hasRes && n > 0);
    dlg.querySelector('#ra-btn-remove').disabled = !(hasRes && n > 0);
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
    let count = 0;
    for (const tid of tids) {
      const existing = await getByIndex('task_resources', 'task_id', tid)
        .then(r => r.find(x => !x.deleted_at && x.resource_id === rid)).catch(() => null);
      if (existing) {
        existing.units = units;
        await dbPut('task_resources', existing);
      } else {
        await dbPut('task_resources', {
          id: crypto.randomUUID(), task_id: tid, resource_id: rid,
          units, deleted_at: null
        });
      }
      count++;
    }
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
    let count = 0;
    for (const tid of tids) {
      const existing = await getByIndex('task_resources', 'task_id', tid)
        .then(r => r.find(x => !x.deleted_at && x.resource_id === rid)).catch(() => null);
      if (existing) { await dbRemove('task_resources', existing.id); count++; }
    }
    statusEl.textContent = count ? `✓ Quitado de ${count} actividades` : 'Sin asignación previa';
    if (count) _showToast(`Recurso quitado de ${count} actividades`, 'success');
  });

  if (!dlg.open) dlg.show();
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
      <td style="padding:4px 8px"><button class="btn btn-icon btn-sm cal-del-ex" data-exid="${_escAttr(ex.id)}" title="Eliminar" style="color:var(--clr-danger,#e74c3c);padding:0 6px">✕</button></td>
    </tr>`).join('') || '<tr id="cal-ex-empty"><td colspan="4" style="padding:8px;text-align:center;color:var(--clr-text-3);font-size:12px">Sin excepciones registradas</td></tr>';

  dlg.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2)">
      <span style="font-weight:700;font-size:15px">🗓 Calendario del proyecto</span>
      <button id="dlg-cal-close" class="btn btn-icon btn-sm">✕</button>
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
          <input id="cal-ex-date" type="date" style="padding:6px 10px;border:1px solid var(--clr-border);border-radius:6px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text)">
          <input id="cal-ex-name" type="text" placeholder="Descripción (ej: Año Nuevo)" style="flex:1;min-width:120px;padding:6px 10px;border:1px solid var(--clr-border);border-radius:6px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text)">
          <select id="cal-ex-type" style="padding:6px 10px;border:1px solid var(--clr-border);border-radius:6px;font-size:12px;background:var(--clr-surface-2);color:var(--clr-text)">
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
      <td style="padding:4px 8px"><button class="btn btn-icon btn-sm cal-del-ex" data-exid="${newId}" title="Eliminar" style="color:var(--clr-danger,#e74c3c);padding:0 6px">✕</button></td>`;
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

    const { put: dbPutSt } = await import('./storage.js?v=4');

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

    // Si el proyecto no tenía calendario, actualizar calendar_id
    if (!proj.calendar_id || proj.calendar_id !== calId) {
      appState.dispatch({ type: 'UPDATE_PROJECT', payload: { fields: { calendar_id: calId } } });
    }

    // Actualizar estado en memoria
    const finalExceptions = [...updatedCalExceptions.filter(e => !e.deleted_at), ...newExceptions];
    appState._applyRemote({ calendar: updatedCal, calExceptions: finalExceptions });

    _showToast('Calendario guardado', 'success');
    dlg.close();
  });

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
  const projects = await listProjects();
  if (projects.some(p => p.is_template === false || !p.is_template)) {
    return projects[0]; // ya existe
  }
  // Guardar datos demo en IndexedDB
  await saveProjectSnapshot(DEMO_DATA);
  return DEMO_DATA.project;
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
  try { localStorage.setItem('last-project-id', projectId); } catch { /* ignore */ }
  history.replaceState(null, '', location.pathname + '?p=' + encodeURIComponent(projectId));
  _renderProjectList();
  if (!data.project.start_date) {
    _showToast('Sin fecha de inicio — edita el proyecto para configurarla', 'warn');
  }

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
  const { portfolios, programs, projects } = await loadHierarchy();
  const currentId = appState.state.project?.id;

  const rows = [];

  // Proyectos sin portafolio ni programa (nivel raíz)
  const rootProjects  = projects.filter(p => !p.settings?.portfolio_id && !p.settings?.program_id);
  // Programas sin portafolio (nivel raíz)
  const rootPrograms  = programs.filter(p => !p.portfolio_id);

  function _projItem(p, indent = 0) {
    return `<div class="explorer-item ${p.id === currentId ? 'active' : ''}" data-project-id="${p.id}"
      title="${_escAttr(p.name)}" style="padding-left:${8 + indent * 16}px">
      <span class="item-icon">📋</span>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px">${_escHtml(p.name)}</span>
      ${p.id !== currentId ? `<button class="btn btn-ghost" data-del-project="${p.id}" title="Eliminar"
        style="padding:0 4px;font-size:10px;line-height:1;opacity:0.5;flex-shrink:0">✕</button>` : ''}
    </div>`;
  }

  function _progItem(prog, indent = 0) {
    const progProjects = projects.filter(p => p.settings?.program_id === prog.id);
    return `<div class="explorer-section-title" style="padding-left:${8 + indent * 16}px;display:flex;align-items:center;gap:4px">
        <span>📦</span><span>${_escHtml(prog.name)}</span>
        ${prog.code ? `<span style="font-size:10px;opacity:0.6">${_escHtml(prog.code)}</span>` : ''}
        <button class="btn btn-ghost" data-add-to-program="${prog.id}" data-prog-code="${_escAttr(prog.code||'')}" title="Nuevo proyecto en este programa"
          style="padding:0 5px;font-size:11px;line-height:1;color:var(--clr-primary);margin-left:auto" tabindex="0">＋</button>
        <button class="btn btn-ghost" data-del-program="${prog.id}" title="Eliminar programa"
          style="padding:0 4px;font-size:10px;line-height:1;opacity:0.4">✕</button>
      </div>
      ${progProjects.map(p => _projItem(p, indent + 1)).join('')}`;
  }

  // Portafolios
  portfolios.forEach(pf => {
    const pfPrograms  = programs.filter(p => p.portfolio_id === pf.id);
    const pfProjects  = projects.filter(p => p.settings?.portfolio_id === pf.id && !p.settings?.program_id);
    rows.push(`<div class="explorer-section-title" style="display:flex;align-items:center;gap:4px">
        <span>🗂</span><span>${_escHtml(pf.name)}</span>
        ${pf.code ? `<span style="font-size:10px;opacity:0.6">${_escHtml(pf.code)}</span>` : ''}
        <button class="btn btn-ghost" data-add-to-portfolio="${pf.id}" data-pf-code="${_escAttr(pf.code||'')}" title="Nuevo programa/proyecto en este portafolio"
          style="padding:0 5px;font-size:11px;line-height:1;color:var(--clr-primary);margin-left:auto" tabindex="0">＋</button>
        <button class="btn btn-ghost" data-del-portfolio="${pf.id}" title="Eliminar portafolio"
          style="padding:0 4px;font-size:10px;line-height:1;opacity:0.4">✕</button>
      </div>`);
    pfPrograms.forEach(prog => rows.push(_progItem(prog, 1)));
    pfProjects.forEach(p   => rows.push(_projItem(p, 1)));
  });

  // Programas raíz (sin portafolio)
  rootPrograms.forEach(prog => rows.push(_progItem(prog, 0)));

  // Proyectos raíz
  rootProjects.forEach(p => rows.push(_projItem(p, 0)));

  list.innerHTML = rows.join('');

  list.querySelectorAll('[data-project-id]').forEach(el => {
    el.addEventListener('click', async (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('[data-del-project]')) return;
      const pid = /** @type {HTMLElement} */ (el).dataset.projectId;
      if (pid && pid !== appState.state.project?.id) {
        try {
          await _loadProject(pid);
          _showToast('Proyecto cargado: ' + (appState.state.project?.name ?? ''), 'success');
        } catch (err) {
          _showToast('Error al cargar proyecto: ' + err.message, 'error');
        }
      }
    });
  });

  list.querySelectorAll('[data-del-project]').forEach(delBtn => {
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const pid = /** @type {HTMLElement} */ (delBtn).dataset.delProject;
      const { projects: projs } = await loadHierarchy();
      const proj = projs.find(p => p.id === pid);
      if (!proj) return;
      if (!confirm(`¿Eliminar el proyecto "${proj.name}"?\nEsta acción no se puede deshacer.`)) return;
      try {
        await _deleteProject(pid);
        _showToast('Proyecto eliminado', 'success');
        _renderProjectList();
      } catch (err) {
        _showToast('Error al eliminar: ' + err.message, 'error');
      }
    });
  });

  list.querySelectorAll('[data-del-portfolio]').forEach(delBtn => {
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = /** @type {HTMLElement} */ (delBtn).dataset.delPortfolio;
      if (!confirm('¿Eliminar este portafolio? Los proyectos y programas dentro quedarán sin asignar.')) return;
      try { await deletePortfolio(id); _showToast('Portafolio eliminado', 'success'); _renderProjectList(); }
      catch (err) { _showToast('Error: ' + err.message, 'error'); }
    });
  });

  list.querySelectorAll('[data-del-program]').forEach(delBtn => {
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = /** @type {HTMLElement} */ (delBtn).dataset.delProgram;
      if (!confirm('¿Eliminar este programa? Los proyectos dentro quedarán sin asignar.')) return;
      try { await deleteProgram(id); _showToast('Programa eliminado', 'success'); _renderProjectList(); }
      catch (err) { _showToast('Error: ' + err.message, 'error'); }
    });
  });

  // "+" junto a programa → nuevo proyecto heredando código
  list.querySelectorAll('[data-add-to-program]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id   = /** @type {HTMLElement} */ (btn).dataset.addToProgram;
      const code = /** @type {HTMLElement} */ (btn).dataset.progCode;
      _openNewItemWithParent('project', 'program', id, code);
    });
  });

  // "+" junto a portafolio → nuevo programa o proyecto directo
  list.querySelectorAll('[data-add-to-portfolio]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id   = /** @type {HTMLElement} */ (btn).dataset.addToPortfolio;
      const code = /** @type {HTMLElement} */ (btn).dataset.pfCode;
      _openNewItemWithParent('project', 'portfolio', id, code);
    });
  });
}

async function _deleteProject(projectId) {
  const tasks = await getByIndex('tasks', 'project_id', projectId);
  const deps  = await getByIndex('task_dependencies', 'project_id', projectId);
  for (const t of tasks) await dbRemove('tasks', t.id);
  for (const d of deps)  await dbRemove('task_dependencies', d.id);
  await dbRemove('projects', projectId);
}

function _escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function _escAttr(s) {
  return String(s ?? '').replace(/"/g,'&quot;');
}

// ============================================================
// Crear nuevo elemento (portafolio / programa / proyecto)
// ============================================================

function _bindNewProject() {
  const btn    = document.getElementById('btn-new-project');
  const dlg    = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-new-item'));
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
    const type   = /** @type {HTMLInputElement|null} */ (document.querySelector('input[name="ni-type"]:checked'))?.value ?? 'project';
    const name   = /** @type {HTMLInputElement} */ (document.getElementById('ni-name')).value.trim();
    const code   = /** @type {HTMLInputElement} */ (document.getElementById('ni-code')).value.trim();
    const start  = /** @type {HTMLInputElement} */ (document.getElementById('ni-start')).value;
    const parentVal = /** @type {HTMLSelectElement} */ (document.getElementById('ni-parent'))?.value ?? '';

    if (!name) return;
    if (type === 'project' && !start) return;

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
          id, org_id: null, code: code || null, name, start_date: start,
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
let _syncEngine     = null;
let _ganttFitPending = false; // true tras cargar proyecto → auto-ajusta al primer CPM

async function init() {
  try {
    await openDB();
    _initWorker();

    appState.onRequestCpm = _requestCpm;

    // ---- Cargar proyecto ----
    const projectId = new URLSearchParams(location.search).get('p')
                   || localStorage.getItem('last-project-id');
    if (projectId) {
      try {
        await _loadProject(projectId);
      } catch {
        const proj = await _ensureDemoData();
        await _loadProject(proj.id);
      }
    } else {
      const proj = await _ensureDemoData();
      await _loadProject(proj.id);
    }

    // ---- Inicializar tabla WBS ----
    const wbsPanel = document.getElementById('wbs-panel');
    if (wbsPanel) {
      _wbsTable = new WbsTable(wbsPanel);
    }

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
          document.getElementById('btn-evm')?.removeAttribute('aria-pressed');
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

    // El motor de sync ya fue iniciado dentro de _loadProject.

    console.log('[Cronogramas] v28 completo — modo', IS_LOCAL_MODE ? 'local' : 'Supabase');
  } catch (err) {
    console.error('[init]', err);
    _showToast('Error al iniciar: ' + err.message, 'error');
    // Reemplazar el placeholder "Cargando…" para que el usuario pueda usar la app
    const wbsPanel = document.getElementById('wbs-panel');
    if (wbsPanel && !wbsPanel.querySelector('#wbs-scroll')) {
      wbsPanel.innerHTML = `<div style="padding:24px;color:var(--clr-danger,#e74c3c);font-family:var(--font-ui)">
        Error al cargar: ${err.message}<br><small>Abre la consola del navegador para más detalles (F12).</small>
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
  document.getElementById('btn-theme')?.addEventListener('click', () => {
    const html = document.documentElement;
    const cur = html.getAttribute('data-theme');
    html.setAttribute('data-theme', cur === 'dark' ? 'light' : 'dark');
  });
  document.getElementById('btn-dcma')?.addEventListener('click', () => {
    const panel = document.getElementById('dcma-panel');
    const btn   = document.getElementById('btn-dcma');
    const isOpen = panel?.classList.toggle('open');
    btn?.setAttribute('aria-pressed', String(isOpen));
    if (isOpen) {
      _dcmaPanel?.refresh();
      btn.style.background = 'var(--clr-primary)';
      btn.style.color = '#fff';
    } else {
      btn.style.background = '';
      btn.style.color = '';
    }
  });

  document.getElementById('btn-resources')?.addEventListener('click', () => {
    const selectedId = appState.state.selectedTaskId;
    if (selectedId) {
      // Abrir detalle de actividad y desplazarse a la sección de recursos
      _openTaskDetailPanel(selectedId).then(() => {
        setTimeout(() => {
          document.getElementById('tdp-resources-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 120);
      });
    } else {
      _openResourceManager();
    }
  });

  document.getElementById('btn-calendar')?.addEventListener('click', () => _openCalendarEditor());
  document.getElementById('btn-gantt-fit')?.addEventListener('click', () => _ganttCanvas?.fitToView());

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
    localStorage.setItem('gantt-bar-labels', JSON.stringify(labels));
    _ganttCanvas?.setBarLabels(labels);
    _syncBarLabelsUI(labels);
  });
  document.addEventListener('click', (e) => {
    if (_barLabelsMenu && !_barLabelsMenu.hidden && !document.getElementById('bar-labels-wrap')?.contains(/** @type {Node} */ (e.target))) {
      _barLabelsMenu.hidden = true;
      _barLabelsBtn?.setAttribute('aria-expanded', 'false');
    }
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
    localStorage.setItem('wbs-col-visibility', JSON.stringify(visible));
    _applyWbsColVisibility(visible);
  });
  document.addEventListener('click', (e) => {
    if (_wbsColsMenu && !_wbsColsMenu.hidden && !document.getElementById('wbs-cols-wrap')?.contains(/** @type {Node} */ (e.target))) {
      _wbsColsMenu.hidden = true;
      _wbsColsBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  document.getElementById('btn-evm')?.addEventListener('click', () => {
    const panel = document.getElementById('evm-panel');
    const btn   = document.getElementById('btn-evm');
    const isOpen = panel?.classList.toggle('open');
    btn?.setAttribute('aria-pressed', String(isOpen));
    if (isOpen) {
      _evmPanel?.refresh();
      btn.style.background = 'var(--clr-primary)';
      btn.style.color = '#fff';
    } else {
      btn.style.background = '';
      btn.style.color = '';
    }
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

  // ---- Menú Exportar ----
  const exportBtn  = document.getElementById('btn-export');
  const exportMenu = document.getElementById('export-menu');

  exportBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !exportMenu?.hidden;
    if (exportMenu) exportMenu.hidden = isOpen;
    exportBtn.setAttribute('aria-expanded', String(!isOpen));
  });

  // Cerrar menú al hacer clic fuera
  document.addEventListener('click', () => {
    if (exportMenu && !exportMenu.hidden) {
      exportMenu.hidden = true;
      exportBtn?.setAttribute('aria-expanded', 'false');
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
      case 'col-config':  _showPrintColConfig();     break;
    }
  });

  // Importar JSON
  document.getElementById('import-file')?.addEventListener('change', async (e) => {
    const file = /** @type {HTMLInputElement} */ (e.target).files?.[0];
    if (!file) return;
    try {
      const data = await importJson(file);
      await saveProjectSnapshot(data);
      await _loadProject(data.project.id);
      _showToast('Proyecto importado: ' + data.project.name, 'success');
    } catch (err) {
      _showToast('Error al importar: ' + err.message, 'error');
    }
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
  if (!btn) return;

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
      pred_id:     predId,
      succ_id:     succId,
      type:        type ?? 'FS',
      lag:         lag  ?? 0,
      created_at:  new Date().toISOString(),
      updated_at:  new Date().toISOString(),
      deleted_at:  null,
    };
    appState.dispatch({ type: 'ADD_DEP', payload: { dep } });
    _showToast('Dependencia FS creada', 'success');
  });
}

// ============================================================
// Splitter arrastrable entre panel WBS y panel Gantt
// ============================================================

function _bindResizer() {
  const resizer    = document.getElementById('resizer-gantt');
  const ganttPanel = document.getElementById('gantt-panel');
  if (!resizer || !ganttPanel) return;

  // Restaurar ancho guardado
  const saved = localStorage.getItem('gantt-panel-width');
  if (saved) ganttPanel.style.width = saved;

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

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = startX - e.clientX; // mover derecha → gantt se hace más pequeño
    const minW = 180;
    const maxW = window.innerWidth - 280;
    const newW = Math.max(minW, Math.min(maxW, startW + dx));
    ganttPanel.style.width = newW + 'px';
    _ganttCanvas?.requestRender();
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('gantt-panel-width', ganttPanel.style.width);
    // Forzar redibujado con el nuevo tamaño del canvas
    setTimeout(() => _ganttCanvas?.requestRender(), 50);
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
function _ocSetPos(pos) { localStorage.setItem('oc-pos', JSON.stringify(pos)); }

function _showOrgChart() {
  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-org-chart'));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'dlg-org-chart';
    dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:96vw;max-width:1400px;height:92vh;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden;position:relative';
    dlg.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;background:var(--clr-bg)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);flex-shrink:0;gap:8px;flex-wrap:wrap">
          <span style="font-weight:700;font-size:15px">Estructura de Proyectos</span>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <button id="oc-add-pf"   class="btn btn-primary btn-sm">＋ Portafolio</button>
            <button id="oc-add-prog" class="btn btn-ghost btn-sm">＋ Programa</button>
            <button id="oc-add-proj" class="btn btn-ghost btn-sm">＋ Proyecto</button>
            <span style="width:1px;height:18px;background:var(--clr-border)"></span>
            <button id="oc-reset-layout" class="btn btn-ghost btn-sm" title="Restablecer posiciones">↺ Organizar</button>
            <button id="oc-print" class="btn btn-ghost btn-sm">🖨 Imprimir</button>
            <button id="btn-orgchart-close" class="btn btn-ghost btn-sm">✕ Cerrar</button>
          </div>
        </div>
        <div id="oc-viewport" style="flex:1;overflow:auto;position:relative">
          <div id="oc-canvas" style="position:relative;width:3200px;height:2400px">
            <svg id="oc-svg-lines" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible"></svg>
          </div>
        </div>
      </div>
      <div id="oc-edit-overlay" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,0.35);z-index:20;align-items:center;justify-content:center">
        <div id="oc-edit-box" style="background:var(--clr-surface);border-radius:14px;padding:24px 26px;min-width:340px;max-width:460px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.28);position:relative"></div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#btn-orgchart-close')?.addEventListener('click', () => dlg?.close());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg?.close(); });

    dlg.querySelector('#oc-add-pf')  ?.addEventListener('click', () => _ocOpenForm(dlg, 'portfolio', null));
    dlg.querySelector('#oc-add-prog')?.addEventListener('click', () => _ocOpenForm(dlg, 'program', null));
    dlg.querySelector('#oc-add-proj')?.addEventListener('click', () => _ocOpenForm(dlg, 'project', null));
    dlg.querySelector('#oc-reset-layout')?.addEventListener('click', () => {
      localStorage.removeItem('oc-pos');
      _renderOrgChart();
    });
    dlg.querySelector('#oc-print')?.addEventListener('click', _printOrgChart);
  }
  _renderOrgChart();
  dlg.showModal();
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

  const today    = new Date().toLocaleDateString('es-PE');
  const projName = project?.name ?? '';

  const html = `<!doctype html>
<html lang="es"><head>
  <meta charset="UTF-8">
  <title>Estructura de Proyectos</title>
  <style id="page-style">@page { size: landscape; margin: 10mm; }</style>
  <style>
    :root { --clr-primary:#1976D2; --clr-bg:#f8f9fc; --clr-surface:#fff;
            --clr-surface-2:#f5f7fa; --clr-text:#1a1d23; --clr-text-2:#4a5568;
            --clr-border:#e2e8f0; }
    * { box-sizing:border-box; }
    body { margin:0; padding:0; font-family:'Segoe UI',system-ui,sans-serif; background:#fff; }
    .header { display:flex; align-items:center; padding:0 0 6px;
              border-bottom:2px solid #1976D2; margin-bottom:8px; }
    .proj-name { font-size:16px; font-weight:700; color:#1976D2; }
    .oc-frame { border:0.25px solid #546E7A; overflow:hidden; }
    .controls { display:flex; align-items:center; gap:12px; padding:8px 0 10px;
                font-size:12px; flex-wrap:wrap; }
    .controls label { display:flex; align-items:center; gap:6px; color:#455A64; }
    .controls input[type=range] { width:120px; accent-color:#1976D2; }
    .btn-c { border:1px solid #90A4AE; border-radius:6px; padding:5px 13px;
             font-size:12px; cursor:pointer; background:#fff; color:#455A64; }
    .btn-c:hover,.btn-c.active { background:#1976D2; color:#fff; border-color:#1976D2; }
    .btn-print { background:#1976D2; color:#fff; border:none; border-radius:6px;
                 padding:6px 16px; font-size:13px; cursor:pointer; }
    .btn-print:hover { background:#1565C0; }
    .sep { width:1px; height:22px; background:#CFD8DC; }
    @media print { .controls { display:none !important; } }
  </style>
</head><body>
  <div class="controls">
    <label>Zoom:
      <input type="range" id="zoom" min="10" max="200" value="100" step="5">
      <span id="zoom-val" style="min-width:40px">100%</span>
    </label>
    <div class="sep"></div>
    <span style="color:#78909C">Orientación:</span>
    <button class="btn-c active" id="btn-land" onclick="setOrient('landscape')">⬛ Horizontal</button>
    <button class="btn-c" id="btn-port" onclick="setOrient('portrait')">🔲 Vertical</button>
    <div class="sep"></div>
    <button class="btn-print" onclick="window.print()">🖨 Imprimir</button>
    <span style="color:#78909C;font-size:11px">${today}</span>
  </div>
  <div class="header">
    <div class="proj-name">Estructura de Proyectos${projName ? ' — ' + projName : ''}</div>
  </div>
  <div class="oc-frame" id="oc-frame">
    <div id="oc-inner" style="transform-origin:top left;position:relative">
      ${canvasHtml}
    </div>
  </div>
  <script>
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
    function setOrient(o) {
      document.getElementById('page-style').textContent = '@page { size: ' + o + '; margin: 10mm; }';
      document.getElementById('btn-land').classList.toggle('active', o === 'landscape');
      document.getElementById('btn-port').classList.toggle('active', o === 'portrait');
    }
    const pageW = window.innerWidth - 32;
    const autoZ = Math.max(10, Math.min(100, Math.floor(pageW / CW * 100)));
    zoom.value = autoZ; zoomVal.textContent = autoZ + '%'; applyZoom(autoZ);
  <\/script>
</body></html>`;

  const win = window.open('', '_blank', 'width=1200,height=800');
  if (!win) { alert('El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.'); return; }
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
    ${!isNew ? `<div id="oc-del-zone" style="display:none;background:rgba(231,76,60,0.08);border:1px solid rgba(231,76,60,0.3);border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;color:#c0392b;margin-bottom:6px">⚠ Esta acción no se puede deshacer</div>
      <button id="ocf-del-confirm" style="background:#e74c3c;color:#fff;border:none;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600">Eliminar definitivamente</button>
      <button id="ocf-del-cancel" style="margin-left:8px;background:none;border:1px solid var(--clr-border);border-radius:6px;padding:6px 14px;cursor:pointer;font-size:12px">Cancelar</button>
    </div>` : ''}
    <div style="display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:16px">
      <div>${!isNew ? `<button id="ocf-del-init" style="background:none;border:1px solid #e74c3c;color:#e74c3c;border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px">🗑 Eliminar</button>` : ''}</div>
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
      else await dbRemove('projects', data.id);
      overlay.style.display = 'none';
      await _renderOrgChart();
      _showToast('Eliminado', 'success');
    } catch (err) { _showToast('Error: ' + err.message, 'error'); }
  });

  box.querySelector('#ocf-save').addEventListener('click', async () => {
    const nameEl = box.querySelector('#ocf-name');
    const name = nameEl?.value.trim();
    if (!name) { nameEl.style.borderColor = '#e74c3c'; nameEl.focus(); return; }
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

  // Layout automático: asignar columnas/filas
  const pfPositions = portfolios.map((pf, i) => ({ id: pf.id, col: i }));
  let cardList = []; // { type, data, pos, parentKey }

  portfolios.forEach((pf, pi) => {
    const pos = defaultPos('pf', pf.id, pi, 0);
    cardList.push({ type: 'portfolio', data: pf, pos, parentKey: null });

    const pfProgs = programs.filter(p => p.portfolio_id === pf.id);
    pfProgs.forEach((prog, gi) => {
      const progPos = defaultPos('prog', prog.id, pi + gi * 0.5, 1);
      cardList.push({ type: 'program', data: prog, pos: progPos, parentKey: `pf:${pf.id}` });

      projects.filter(p => p.settings?.program_id === prog.id).forEach((proj, ji) => {
        const projPos = defaultPos('proj', proj.id, pi + gi * 0.5 + ji * 0.3, 2);
        cardList.push({ type: 'project', data: proj, pos: projPos, parentKey: `prog:${prog.id}` });
      });
    });

    // Proyectos directos del portafolio (sin programa)
    projects.filter(p => p.settings?.portfolio_id === pf.id && !p.settings?.program_id).forEach((proj, ji) => {
      const projPos = defaultPos('proj', proj.id, pi + 0.5 + ji * 0.3, 1);
      cardList.push({ type: 'project', data: proj, pos: projPos, parentKey: `pf:${pf.id}` });
    });
  });

  // Programas sin portafolio
  const orphanProgs = programs.filter(p => !p.portfolio_id);
  orphanProgs.forEach((prog, i) => {
    const progPos = defaultPos('prog', prog.id, portfolios.length + i, 0);
    cardList.push({ type: 'program', data: prog, pos: progPos, parentKey: null });
    projects.filter(p => p.settings?.program_id === prog.id).forEach((proj, ji) => {
      const projPos = defaultPos('proj', proj.id, portfolios.length + i + ji * 0.3, 1);
      cardList.push({ type: 'project', data: proj, pos: projPos, parentKey: `prog:${prog.id}` });
    });
  });

  // Proyectos sin asignar
  const unassigned = projects.filter(p => !p.settings?.portfolio_id && !p.settings?.program_id);
  unassigned.forEach((proj, i) => {
    const projPos = defaultPos('proj', proj.id, i, orphanProgs.length > 0 ? 2 : 1);
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
      <button class="oc-btn-edit" title="Editar" style="position:absolute;top:4px;right:26px;background:none;border:none;cursor:pointer;font-size:12px;opacity:0.3;padding:0;line-height:1">✎</button>
      <button class="oc-btn-add" title="Agregar hijo" style="position:absolute;top:4px;right:6px;background:none;border:none;cursor:pointer;font-size:12px;opacity:0.3;padding:0;line-height:1;font-weight:700">＋</button>
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
                  .then(() => { _showToast(`Proyecto asignado a ${prog.name}`, 'success'); _renderOrgChart(); });
                dropped = true;
              }
            } else if (type === 'project' && tPrefix === 'pf') {
              // Reasignar proyecto → portafolio (sin programa)
              const proj = projects.find(p => p.id === data.id);
              const pf = portfolios.find(p => p.id === tId);
              if (proj && pf) {
                const ns = { ...(proj.settings ?? {}), program_id: null, portfolio_id: pf.id };
                dbPut('projects', { ...proj, settings: ns, updated_at: new Date().toISOString() })
                  .then(() => { _showToast(`Proyecto asignado a ${pf.name}`, 'success'); _renderOrgChart(); });
                dropped = true;
              }
            } else if (type === 'program' && tPrefix === 'pf') {
              // Reasignar programa → portafolio
              const prog = programs.find(p => p.id === data.id);
              const pf = portfolios.find(p => p.id === tId);
              if (prog && pf) {
                saveProgram({ ...prog, portfolio_id: pf.id, updated_at: new Date().toISOString() })
                  .then(() => { _showToast(`Programa asignado a ${pf.name}`, 'success'); _renderOrgChart(); });
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
    dlg.innerHTML = `
      <div style="background:var(--clr-surface-2);padding:16px 20px;border-bottom:1px solid var(--clr-border)">
        <div style="font-weight:700;font-size:15px">⚙ Columnas de exportación</div>
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
      // Mostrar confirmación
      const toast = document.createElement('div');
      toast.className = 'toast toast-success';
      toast.textContent = '✓ Columnas guardadas';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 2500);
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
    alert('El CPM aún no ha calculado. Espera un momento y vuelve a intentarlo.');
    return;
  }

  let dlg = /** @type {HTMLDialogElement|null} */ (document.getElementById('dlg-cpm-network'));
  if (dlg) { dlg.showModal(); _renderCpmNetwork(); setTimeout(() => dlg.querySelector('#btn-cpm-zoomfit')?.dispatchEvent(new Event('click')), 80); return; }

  dlg = document.createElement('dialog');
  dlg.id = 'dlg-cpm-network';
  dlg.style.cssText = 'border:none;border-radius:12px;padding:0;width:96vw;max-width:1400px;height:90vh;box-shadow:0 8px 40px rgba(0,0,0,0.3);overflow:hidden';
  dlg.innerHTML = `
    <div style="display:flex;flex-direction:column;height:100%">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--clr-border);background:var(--clr-surface-2);flex-shrink:0">
        <span style="font-weight:700;font-size:15px">Red CPM</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button id="btn-cpm-zoomfit" class="btn btn-ghost btn-sm" title="Zoom extendido — ver toda la red" style="font-size:16px;padding:2px 8px;line-height:1">⤢</button>
          <button id="btn-cpm-zoomin"  class="btn btn-ghost btn-sm" title="Acercar" style="font-size:16px;padding:2px 8px;line-height:1">＋</button>
          <button id="btn-cpm-zoomout" class="btn btn-ghost btn-sm" title="Alejar"  style="font-size:16px;padding:2px 8px;line-height:1">－</button>
          <span style="width:1px;height:18px;background:var(--clr-border);margin:0 4px;display:inline-block"></span>
          <span style="display:inline-block;width:11px;height:11px;background:#e74c3c;border-radius:2px"></span><span style="font-size:11px">Crítica</span>
          <span style="display:inline-block;width:11px;height:11px;background:#f39c12;border-radius:2px;margin-left:5px"></span><span style="font-size:11px">Casi crítica</span>
          <span style="display:inline-block;width:11px;height:11px;background:#2980b9;border-radius:2px;margin-left:5px"></span><span style="font-size:11px">Normal</span>
          <span style="display:inline-block;width:11px;height:11px;background:#27ae60;border-radius:2px;margin-left:5px"></span><span style="font-size:11px">Completa</span>
          <div style="position:relative;margin-left:10px" id="cpm-export-wrap">
            <button id="btn-cpm-export" class="btn btn-ghost btn-sm" title="Exportar red CPM" style="display:flex;align-items:center;gap:4px">🖨 Exportar ▾</button>
            <div id="cpm-export-menu" style="display:none;position:absolute;right:0;top:calc(100% + 4px);background:var(--clr-surface);border:1px solid var(--clr-border);border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.15);z-index:9999;min-width:200px;overflow:hidden">
              <button class="cpm-exp-item" data-fmt="pdf" style="display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;cursor:pointer;font-size:13px">📄 PDF (imprimir)</button>
              <button class="cpm-exp-item" data-fmt="png" style="display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;cursor:pointer;font-size:13px">🖼 PNG (imagen)</button>
              <button class="cpm-exp-item" data-fmt="svg" style="display:block;width:100%;text-align:left;padding:10px 16px;background:none;border:none;cursor:pointer;font-size:13px">📐 SVG (vectorial)</button>
            </div>
          </div>
          <button id="btn-cpm-net-close" class="btn btn-ghost btn-sm" style="margin-left:4px">✕ Cerrar</button>
        </div>
      </div>
      <div id="cpm-net-viewport" style="flex:1;overflow:hidden;position:relative;background:var(--clr-bg);cursor:grab">
        <canvas id="cpm-net-grid" style="position:absolute;top:0;left:0;pointer-events:none"></canvas>
        <svg id="cpm-net-svg" style="position:absolute;top:0;left:0;overflow:visible"></svg>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  dlg.querySelector('#btn-cpm-net-close')?.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

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
  document.addEventListener('mousemove', e => {
    if (!panning) return;
    panX = tx0 + e.clientX - px0;
    panY = ty0 + e.clientY - py0;
    applyTransform();
  });
  document.addEventListener('mouseup', () => { panning = false; vp.style.cursor = 'grab'; });
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
    exportMenu.style.display = exportMenu.style.display === 'none' ? 'block' : 'none';
  });
  document.addEventListener('click', () => { if (exportMenu) exportMenu.style.display = 'none'; });

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

  dlg.showModal();
  _renderCpmNetwork();
  // Auto fit after render (brief delay for SVG layout)
  setTimeout(zoomFit, 80);
}

/** Exporta la Red CPM en el formato indicado (pdf | png | svg). */
function _exportCpmNetwork(fmt, dlg) {
  const svgEl = /** @type {SVGSVGElement|null} */ (dlg?.querySelector('#cpm-net-svg'));
  if (!svgEl) return;

  const bb = svgEl.getBBox();
  if (!bb.width || !bb.height) { alert('La red está vacía.'); return; }
  const PAD = 40;
  const vbX = bb.x - PAD, vbY = bb.y - PAD;
  const vbW = bb.width  + PAD * 2;
  const vbH = bb.height + PAD * 2;

  // ---- Clonar SVG y ajustar viewBox ----
  const clone = /** @type {SVGSVGElement} */ (svgEl.cloneNode(true));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.style.transform = '';
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
    img.onerror = () => { URL.revokeObjectURL(url); alert('Error al generar PNG.'); };
    img.src = url;
    return;
  }

  // ---- PDF: SVG vectorial inline en ventana de impresión ----
  if (fmt === 'pdf') {
    const today = new Date().toLocaleDateString('es-PE');
    const projDisplayName = _escHtml(appState.state.project?.name ?? projName);

    // Quitar width/height fijos; dejar solo viewBox para que CSS controle el tamaño
    clone.removeAttribute('width');
    clone.removeAttribute('height');
    clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Serializar el SVG para incrustar directamente en el HTML
    // Se usa blob URL en lugar de document.write para evitar que el parser HTML
    // reordene el DOM al encontrar SVG (problema histórico con document.write + SVG)
    const svgInline = serializer.serializeToString(clone);

    const html = `<!doctype html>
<html lang="es"><head>
  <meta charset="UTF-8">
  <title></title>
  <style id="page-style">@page { size: landscape; margin: 10mm; }</style>
  <style>
    * { box-sizing: border-box; }
    body  { margin: 0; padding: 8px 12px; font-family: 'Segoe UI', system-ui, sans-serif; }
    .header { display: flex; align-items: center; padding: 0 0 6px;
              border-bottom: 2px solid #1976D2; margin-bottom: 8px; }
    .proj-name { font-size: 16px; font-weight: 700; color: #1976D2; }
    .gantt-frame { border: 0.25px solid #546E7A; display: block; width: 100%; overflow: hidden; }
    .gantt-frame svg { width: var(--zoom-w, 100%); height: auto; display: block; }
    .controls { display: flex; align-items: center; gap: 12px; padding: 8px 0 10px;
                font-size: 12px; flex-wrap: wrap; }
    .controls label { display: flex; align-items: center; gap: 6px; color: #455A64; }
    .controls input[type=range] { width: 120px; accent-color: #1976D2; }
    .btn-c { border: 1px solid #90A4AE; border-radius: 6px; padding: 5px 13px;
             font-size: 12px; cursor: pointer; background: #fff; color: #455A64; }
    .btn-c:hover, .btn-c.active { background: #1976D2; color: #fff; border-color: #1976D2; }
    .btn-print { background: #1976D2; color: #fff; border: none; border-radius: 6px;
                 padding: 6px 16px; font-size: 13px; cursor: pointer; }
    .btn-print:hover { background: #1565C0; }
    .sep { width: 1px; height: 22px; background: #CFD8DC; }
    .legend-wrap { margin-top: 8px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
    .legend-item { display: flex; align-items: center; gap: 5px; font-size: 12px; color: #444; }
    .legend-swatch { width: 13px; height: 13px; border-radius: 2px; flex-shrink: 0; }
    @media print { .controls { display: none !important; } }
  </style>
</head><body>
  <div class="controls">
    <label>Zoom:
      <input type="range" id="zoom" min="30" max="300" value="100" step="5">
      <span id="zoom-val" style="min-width:40px">100%</span>
    </label>
    <div class="sep"></div>
    <span style="color:#78909C">Orientaci&#243;n:</span>
    <button class="btn-c active" id="btn-land">&#x2B1B; Horizontal</button>
    <button class="btn-c" id="btn-port">&#x1F532; Vertical</button>
    <div class="sep"></div>
    <button class="btn-print" id="btn-print">&#x1F5A8; Imprimir</button>
    <span style="color:#78909C;font-size:11px">${today}</span>
  </div>
  <div class="header">
    <div class="proj-name">${projDisplayName}</div>
  </div>
  <div class="gantt-frame">${svgInline}</div>
  <div class="legend-wrap">
    <div class="legend-item"><div class="legend-swatch" style="background:#e74c3c"></div>Cr&#237;tica</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#f39c12"></div>Casi cr&#237;tica</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#2980b9"></div>Normal</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#27ae60"></div>Completa</div>
  </div>
  <script>
    const zoom = document.getElementById('zoom');
    const zoomVal = document.getElementById('zoom-val');
    const frame = document.querySelector('.gantt-frame');
    zoom.addEventListener('input', () => {
      zoomVal.textContent = zoom.value + '%';
      frame.style.setProperty('--zoom-w', zoom.value + '%');
    });
    function setOrient(o) {
      document.getElementById('page-style').textContent = '@page { size: ' + o + '; margin: 10mm; }';
      document.getElementById('btn-land').classList.toggle('active', o === 'landscape');
      document.getElementById('btn-port').classList.toggle('active', o === 'portrait');
    }
    document.getElementById('btn-land').addEventListener('click', () => setOrient('landscape'));
    document.getElementById('btn-port').addEventListener('click', () => setOrient('portrait'));
    document.getElementById('btn-print').addEventListener('click', () => window.print());
  <\/script>
</body></html>`;

    // Usar blob URL: el navegador carga el documento completo de forma normal,
    // sin document.write, sin reordenamiento del parser al encontrar SVG inline
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const blobUrl = URL.createObjectURL(blob);
    const win = window.open(blobUrl, '_blank', 'width=1300,height=900');
    if (!win) { URL.revokeObjectURL(blobUrl); alert('El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.'); return; }
    // Liberar blob URL después de que la ventana haya cargado
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
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

  // Calcular posición de cada tarea
  const pos = new Map(); // id → {x, y, cx, cy}
  byLevel.forEach((tasks, lv) => {
    tasks.forEach((t, row) => {
      const x = lv * STRIDE_X;
      const y = row * STRIDE_Y;
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
    if (d.lag) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(mx)); text.setAttribute('y', String((y1 + y2) / 2 - 4));
      text.setAttribute('text-anchor', 'middle'); text.setAttribute('font-size', '10');
      text.setAttribute('fill', color);
      text.textContent = `${d.lag > 0 ? '+' : ''}${d.lag}d`;
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
  document.getElementById('btn-orgchart-view')?.addEventListener('click', _showOrgChart);
  document.getElementById('btn-cpm-network')?.addEventListener('click', _showCpmNetwork);

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
  });
  document.getElementById('btn-dcma-view')?.addEventListener('click', () => {
    _closeExplorer();
    document.getElementById('btn-dcma')?.click();
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
    document.getElementById('btn-evm')?.click();
  });

  init();
});
