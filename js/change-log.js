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
  const name = cmd.payload?.task?.name ?? cmd.payload?.name ?? '';
  switch (cmd.type) {
    case 'ADD_TASK':     return `Nueva tarea: "${name}"`;
    case 'UPDATE_TASK':  return `Editada: "${name || (cmd.payload?.id ?? '?')}"`;
    case 'REMOVE_TASK':  return `Eliminada: "${name || (cmd.payload?.id ?? '?')}"`;
    case 'RESTORE_TASK': return `Restaurada: "${name || (cmd.payload?.id ?? '?')}"`;
    case 'MOVE_TASK':    return `Movida: "${name || (cmd.payload?.id ?? '?')}"`;
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
