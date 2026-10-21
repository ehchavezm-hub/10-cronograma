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
  const _d = new Date();
  const _dd = String(_d.getDate()).padStart(2,'0');
  const _mm = String(_d.getMonth()+1).padStart(2,'0');
  const _yy = _d.getFullYear();
  const title = `${_proj}-${moduleName}-${_dd}${_mm}${_yy}`;
  const w = window.open('', '_blank', 'width=1100,height=880');
  if (!w) {
    document.dispatchEvent(new CustomEvent('show-toast', { detail: { msg: 'El navegador bloqueó la ventana emergente. Permítala e intente de nuevo.', type: 'warn' } }));
    return;
  }
  w.document.write(`<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>${title}</title>
<style>
  *{box-sizing:border-box}
  body{font-family:Arial,sans-serif;margin:0;padding:0;background:#cfd8dc}
  .tb{background:#263238;padding:8px 14px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;position:sticky;top:0;z-index:100;border-bottom:2px solid #37474f}
  .tb button{padding:5px 11px;border:1px solid #546e7a;border-radius:4px;cursor:pointer;font-size:12px;background:#37474f;color:#ecf0f1;white-space:nowrap}
  .tb button.pri{background:#1976d2;color:#fff;border-color:#1976d2;font-weight:600;font-size:13px;padding:6px 16px}
  .tb button.pri:hover{background:#1565c0}
  .tb button.act{background:#0d47a1;color:#fff;border-color:#1565c0}
  .tb button:hover:not(.pri){background:#455a64}
  .tb .sep{width:1px;height:20px;background:#546e7a;flex-shrink:0}
  .tb .lbl{font-size:11px;color:#90a4ae;white-space:nowrap}
  .tb input[type=text]{font-size:12px;padding:3px 8px;border:1px solid #546e7a;border-radius:3px;background:#37474f;color:#ecf0f1;width:300px}
  .pv{padding:20px;display:flex;flex-direction:column;align-items:center;gap:16px;min-height:calc(100vh - 52px)}
  .a4{background:#fff;box-shadow:0 4px 14px rgba(0,0,0,.4);padding:14mm 15mm;width:210mm;min-height:297mm;overflow:hidden}
  .a4.land{width:297mm;min-height:210mm}
  h1{font-size:18px;margin-bottom:16px}
  h2{font-size:14px;margin:14px 0 6px}
  table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 10px;font-size:12px}th{background:#f4f5f7;font-weight:600}
  svg{max-width:100%;height:auto}img{max-width:100%}
  .badge{display:inline-block;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600}
  @media print{body{background:#fff}.tb{display:none!important}.pv{padding:0;min-height:0}.a4{box-shadow:none;width:100%;min-height:0;padding:8mm 10mm}@page{margin:0}}
</style>
</head><body>
<div class="tb">
  <button class="pri" onclick="window.print()">&#x1F5A8; Guardar PDF</button>
  <div class="sep"></div>
  <span class="lbl">Orientaci&#243;n:</span>
  <button id="bp" class="act" onclick="setOri('portrait')">&#x1F4C4; Vertical</button>
  <button id="bl" onclick="setOri('landscape')">&#x1F5C2; Horizontal</button>
  <div class="sep"></div>
  <span class="lbl">&#x1F4C1; Archivo:</span>
  <input type="text" id="fn" value="${title}.pdf" title="Nombre sugerido del archivo PDF">
  <div class="sep"></div>
  <button onclick="window.close()">&#x2715; Cerrar</button>
</div>
<div class="pv">
  <div class="a4" id="a4">${htmlContent}</div>
</div>
<script>
  document.title=${JSON.stringify(title)};
  function setOri(o){
    document.getElementById('a4').classList.toggle('land',o==='landscape');
    document.getElementById('bp').classList.toggle('act',o==='portrait');
    document.getElementById('bl').classList.toggle('act',o==='landscape');
    var s=document.getElementById('_ps')||document.createElement('style');
    s.id='_ps';s.textContent='@page{size:A4 '+o+'}';document.head.appendChild(s);
  }
  setOri('portrait');
<\/script>
</body></html>`);
  w.document.close();
}
