// @ts-check
/**
 * change-log.js — Panel de historial de cambios.
 *
 * Muestra el stack de undo/redo con tipo de comando, tarea afectada
 * y marca de tiempo. Persiste en memoria de sesión (no IndexedDB).
 */

import { appState } from './state.js';

// ============================================================
// Registro en memoria
// ============================================================

/** @type {{ts:Date, cmd:string, label:string, taskId:string|null}[]} */
const _log = [];
const MAX_LOG = 200;

/**
 * Registra un comando en el historial de sesión.
 * Llamado por main.js desde appState.onPersist.
 * @param {object} cmd
 */
export function logCommand(cmd) {
  const entry = {
    ts:     new Date(),
    cmd:    cmd.type ?? '?',
    label:  _cmdLabel(cmd),
    taskId: cmd.payload?.task?.id ?? cmd.payload?.id ?? null,
  };
  _log.unshift(entry);
  if (_log.length > MAX_LOG) _log.pop();
}

// ============================================================
// Panel DOM
// ============================================================

export class ChangeLogPanel {
  /** @param {HTMLElement} container */
  constructor(container) {
    this._container = container;
    container.innerHTML = `
<div class="changelog-header">
  <h2 class="changelog-title">📋 Historial de cambios</h2>
  <button class="btn btn-ghost btn-sm" id="btn-changelog-clear" title="Limpiar historial de sesión">🗑 Limpiar</button>
  <button class="btn btn-ghost btn-sm no-print" id="btn-changelog-print" title="Imprimir PDF" aria-label="Imprimir historial PDF">🖨 Imprimir</button>
  <button class="btn btn-ghost btn-sm no-print" id="btn-changelog-close" aria-label="Cerrar historial">✕</button>
</div>
<div class="changelog-body">
  <table class="changelog-table">
    <thead>
      <tr>
        <th style="width:100px">Hora</th>
        <th style="width:160px">Acción</th>
        <th>Descripción</th>
      </tr>
    </thead>
    <tbody id="changelog-tbody"></tbody>
  </table>
  <div id="changelog-empty" style="display:none;padding:32px;text-align:center;color:var(--clr-text-3)">
    No hay cambios en esta sesión.
  </div>
</div>`;

    container.querySelector('#btn-changelog-clear')?.addEventListener('click', () => {
      _log.length = 0;
      this.refresh();
    });

    container.querySelector('#btn-changelog-print')?.addEventListener('click', () => {
      const body = container.querySelector('.changelog-body');
      _printToPdf('Historial de cambios', `<h1>Historial de cambios</h1>${body?.innerHTML ?? ''}`);
    });
  }

  refresh() {
    const tbody = this._container.querySelector('#changelog-tbody');
    const empty = this._container.querySelector('#changelog-empty');
    if (!tbody || !empty) return;

    if (!_log.length) {
      tbody.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';

    tbody.innerHTML = _log.map(e => `
      <tr class="changelog-row">
        <td class="cl-time">${_fmtTime(e.ts)}</td>
        <td><span class="cl-badge cl-${_badgeClass(e.cmd)}">${_shortCmd(e.cmd)}</span></td>
        <td class="cl-label">${_esc(e.label)}</td>
      </tr>`).join('');
  }
}

// ============================================================
// Helpers
// ============================================================

function _cmdLabel(cmd) {
  const nameFromPayload = cmd.payload?.task?.name ?? cmd.payload?.name ?? '';
  switch (cmd.type) {
    case 'ADD_TASK':     return `Nueva tarea: "${nameFromPayload}"`;
    case 'UPDATE_TASK': {
      const t = appState.state.tasks.get(cmd.payload?.id);
      return `Editada: "${t?.name || (cmd.payload?.id ?? '?')}"`;
    }
    case 'REMOVE_TASK': {
      const t = appState.state.tasks.get(cmd.payload?.id);
      return `Eliminada: "${t?.name || nameFromPayload || (cmd.payload?.id ?? '?')}"`;
    }
    case 'RESTORE_TASK': {
      const t = appState.state.tasks.get(cmd.payload?.id);
      return `Restaurada: "${t?.name || nameFromPayload || (cmd.payload?.id ?? '?')}"`;
    }
    case 'MOVE_TASK': {
      const t = appState.state.tasks.get(cmd.payload?.id);
      return `Movida: "${t?.name || nameFromPayload || (cmd.payload?.id ?? '?')}"`;
    }
    case 'ADD_DEP':      return `Dependencia añadida`;
    case 'REMOVE_DEP':   return `Dependencia eliminada`;
    case 'UPDATE_PROJECT': return `Proyecto actualizado`;
    default:             return cmd.type ?? '?';
  }
}

function _shortCmd(type) {
  const map = {
    ADD_TASK: 'Nueva', UPDATE_TASK: 'Edición', REMOVE_TASK: 'Eliminar',
    RESTORE_TASK: 'Restaurar', MOVE_TASK: 'Mover', ADD_DEP: 'Enlace+', REMOVE_DEP: 'Enlace−',
    UPDATE_PROJECT: 'Proyecto',
  };
  return map[type] ?? type;
}

function _badgeClass(type) {
  if (type === 'ADD_TASK' || type === 'ADD_DEP' || type === 'RESTORE_TASK') return 'add';
  if (type === 'REMOVE_TASK' || type === 'REMOVE_DEP') return 'remove';
  if (type === 'UPDATE_TASK' || type === 'UPDATE_PROJECT') return 'update';
  return 'other';
}

function _fmtTime(d) {
  return d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _printToPdf(moduleName, htmlContent) {
  const _proj = appState.state.project?.name ?? 'ECM Project';
  const _d = new Date(), _dd = String(_d.getDate()).padStart(2,'0'), _mm = String(_d.getMonth()+1).padStart(2,'0'), _yy = _d.getFullYear();
  const title = `${_proj}-${moduleName}-${_dd}${_mm}${_yy}`;
  const w = window.open('', '_blank', 'width=1000,height=750');
  if (!w) return;
  w.document.write(`<!DOCTYPE html><html><head>
    <meta charset="utf-8"><title>${title}</title>
    <style>
      *{box-sizing:border-box}body{font-family:Arial,sans-serif;margin:0;padding:0}
      .np{background:#f5f5f5;border-bottom:1px solid #ddd;padding:8px 16px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .np button{padding:6px 14px;border:1px solid #999;border-radius:4px;cursor:pointer;font-size:13px;background:#fff}
      .np button.pri{background:#0066cc;color:#fff;border-color:#0066cc}
      .np label{font-size:12px;color:#666}
      .ct{padding:24px}h1{font-size:18px;margin-bottom:16px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 10px;font-size:12px}th{background:#f4f5f7;font-weight:600}
      @media print{.np{display:none!important}.ct{padding:8px}}
    </style>
  </head><body>
  <div class="np">
    <button class="pri" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
    <span style="color:#bbb">|</span>
    <label>Orientaci&#243;n:</label>
    <button onclick="setOri('portrait')">Vertical</button>
    <button onclick="setOri('landscape')">Horizontal</button>
    <span style="color:#bbb">|</span>
    <label>Hojas H: <input type="number" min="1" max="10" value="1" style="width:44px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:12px;text-align:center"></label>
    <label>Hojas V: <input type="number" min="1" max="10" value="1" style="width:44px;padding:2px 4px;border:1px solid #ccc;border-radius:3px;font-size:12px;text-align:center"></label>
    <span style="color:#bbb">|</span>
    <button onclick="window.close()">&#x2715; Cerrar</button>
  </div>
  <div class="ct">${htmlContent}</div>
  <script>
    function setOri(o){var s=document.getElementById('ps')||document.createElement('style');s.id='ps';s.textContent='@page{size:A4 '+o+'}';document.head.appendChild(s);}
    setOri('portrait');
  <\/script>
  </body></html>`);
  w.document.close();
}
