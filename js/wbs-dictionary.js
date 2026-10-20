// @ts-check
/**
 * wbs-dictionary.js — Diccionario WBS.
 * Muestra y edita campos descriptivos extendidos de cada entregable:
 * alcance, descripción, criterios de aceptación, responsable.
 */

import { appState } from './state.js';
import { put as dbPut } from './storage.js';

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
      @media print { body { margin: 0; } }
    </style>
  </head><body>${htmlContent}<script>window.print();window.close();<\/script></body></html>`);
  w.document.close();
}

export class WbsDictionaryPanel {
  /** @param {HTMLElement} containerEl */
  constructor(containerEl) {
    this.el = containerEl;
    /** @type {string|null} */
    this._selectedTaskId = null;
    this._build();
  }

  _build() {
    this.el.innerHTML = '';
    this.el.style.cssText = 'display:flex;flex-direction:column;height:100%;font-family:var(--font-ui)';

    const hdr = document.createElement('div');
    hdr.setAttribute('data-drag-handle', '');
    hdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid var(--clr-border);flex-shrink:0';
    hdr.innerHTML = `
      <span style="font-size:20px">📖</span>
      <div style="flex:1">
        <div style="font-size:var(--text-md,14px);font-weight:600;color:var(--clr-text)">Diccionario WBS</div>
        <div style="font-size:11px;color:var(--clr-text-3)">Alcance, criterios de aceptación y responsables por entregable</div>
      </div>`;
    const _printBtn = document.createElement('button');
    _printBtn.innerHTML = '🖨';
    _printBtn.title = 'Imprimir PDF';
    _printBtn.className = 'btn btn-ghost btn-icon btn-sm';
    _printBtn.style.cssText = 'font-size:15px;flex-shrink:0';
    _printBtn.addEventListener('click', () => {
      _printToPdf('Diccionario WBS', `<h1>Diccionario WBS</h1>${this._detailEl?.innerHTML ?? '<p>Sin tarea seleccionada.</p>'}`);
    });
    hdr.appendChild(_printBtn);
    this.el.appendChild(hdr);

    const body = document.createElement('div');
    body.style.cssText = 'flex:1;display:flex;overflow:hidden;min-height:0';

    // Panel izquierdo: lista de tareas
    this._listEl = document.createElement('div');
    this._listEl.style.cssText = 'width:240px;border-right:1px solid var(--clr-border);overflow:auto;flex-shrink:0';

    // Panel derecho: detalle/edición
    this._detailEl = document.createElement('div');
    this._detailEl.style.cssText = 'flex:1;overflow:auto;padding:16px 20px';

    body.appendChild(this._listEl);
    body.appendChild(this._detailEl);
    this.el.appendChild(body);

    this._renderList();
    this._showEmpty();
    if (this.el.parentElement) _makeDraggable(this.el.parentElement, '[data-drag-handle]');
  }

  _renderList() {
    const { tasks, cpmResult } = appState.state;
    const _allTasks = [...(tasks?.values() ?? [])].filter(t => !t.deleted_at);
    const _dictParentIds = new Set(_allTasks.filter(t => t.parent_id).map(t => t.parent_id));
    const taskArr = _allTasks.filter(t => t.type !== 'summary' && !_dictParentIds.has(t.id));

    if (!taskArr.length) {
      this._listEl.innerHTML = '<p style="color:var(--clr-text-3);font-size:12px;padding:12px">Sin tareas disponibles.</p>';
      return;
    }

    this._listEl.innerHTML = taskArr.map(t => {
      const isCrit = cpmResult?.tasks?.get(t.id)?.tf === 0;
      const hasDef = !!(t.wbs_scope || t.wbs_description || t.wbs_acceptance);
      return `
        <div class="wbs-list-item" data-id="${_esc(t.id)}" style="
          padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--clr-border);
          font-size:12px;color:var(--clr-text);transition:background .15s;
          display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;opacity:0.6;flex-shrink:0">${isCrit?'🔴':'⬜'}</span>
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${_esc(t.name)}">${_esc(t.name)}</span>
          ${hasDef?'<span style="font-size:10px;color:#388E3C" title="Tiene definición">✓</span>':''}
        </div>`;
    }).join('');

    this._listEl.querySelectorAll('.wbs-list-item').forEach(el => {
      el.addEventListener('click', () => {
        this._listEl.querySelectorAll('.wbs-list-item').forEach(x => (/** @type {HTMLElement} */ (x)).style.background = '');
        /** @type {HTMLElement} */ (el).style.background = 'var(--clr-primary-light,#e8eaf6)';
        const id = el.getAttribute('data-id');
        if (id) this._showDetail(id);
      });
    });
  }

  /** @param {string} taskId */
  _showDetail(taskId) {
    this._selectedTaskId = taskId;
    const { tasks } = appState.state;
    const task = tasks?.get(taskId);
    if (!task) return;

    this._detailEl.innerHTML = `
      <h3 style="font-size:13px;font-weight:600;color:var(--clr-text);margin:0 0 14px;overflow:hidden;text-overflow:ellipsis">${_esc(task.name)}</h3>
      <div style="display:flex;flex-direction:column;gap:14px">
        <label style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:11px;font-weight:600;color:var(--clr-text-2);text-transform:uppercase;letter-spacing:.5px">Descripción</span>
          <textarea id="wbs-description" rows="3" style="
            border:1px solid var(--clr-border);border-radius:6px;padding:8px 10px;font-size:12px;
            color:var(--clr-text);background:var(--clr-surface);resize:vertical;font-family:inherit"
            placeholder="Descripción del entregable...">${_esc(task.wbs_description ?? '')}</textarea>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:11px;font-weight:600;color:var(--clr-text-2);text-transform:uppercase;letter-spacing:.5px">Alcance</span>
          <textarea id="wbs-scope" rows="3" style="
            border:1px solid var(--clr-border);border-radius:6px;padding:8px 10px;font-size:12px;
            color:var(--clr-text);background:var(--clr-surface);resize:vertical;font-family:inherit"
            placeholder="Qué incluye y qué no incluye este entregable...">${_esc(task.wbs_scope ?? '')}</textarea>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:11px;font-weight:600;color:var(--clr-text-2);text-transform:uppercase;letter-spacing:.5px">Criterios de Aceptación</span>
          <textarea id="wbs-acceptance" rows="3" style="
            border:1px solid var(--clr-border);border-radius:6px;padding:8px 10px;font-size:12px;
            color:var(--clr-text);background:var(--clr-surface);resize:vertical;font-family:inherit"
            placeholder="Condiciones que deben cumplirse para aceptar este entregable...">${_esc(task.wbs_acceptance ?? '')}</textarea>
        </label>
        <label style="display:flex;flex-direction:column;gap:4px">
          <span style="font-size:11px;font-weight:600;color:var(--clr-text-2);text-transform:uppercase;letter-spacing:.5px">Responsable</span>
          <input id="wbs-owner" type="text" style="
            border:1px solid var(--clr-border);border-radius:6px;padding:8px 10px;font-size:12px;
            color:var(--clr-text);background:var(--clr-surface);font-family:inherit"
            placeholder="Nombre del responsable"
            value="${_esc(task.wbs_owner ?? '')}">
        </label>
        <div style="display:flex;gap:8px">
          <button id="wbs-save" class="btn btn-primary btn-sm" style="font-size:12px;padding:6px 16px">Guardar</button>
          <span id="wbs-saved-msg" style="font-size:11px;color:#388E3C;align-self:center;display:none">✓ Guardado</span>
        </div>
      </div>`;

    this._detailEl.querySelector('#wbs-save')?.addEventListener('click', () => this._save());
  }

  _showEmpty() {
    this._detailEl.innerHTML = '<p style="color:var(--clr-text-3);font-size:13px;padding:16px 0">Selecciona una tarea de la lista para ver o editar su definición WBS.</p>';
  }

  async _save() {
    if (!this._selectedTaskId) return;
    const { tasks, project } = appState.state;
    const task = tasks?.get(this._selectedTaskId);
    if (!task) return;

    /** @param {string} id @returns {string} */
    const val = id => (/** @type {HTMLInputElement|HTMLTextAreaElement} */ (this._detailEl.querySelector('#' + id)))?.value ?? '';

    const updated = {
      ...task,
      wbs_description: val('wbs-description').trim() || null,
      wbs_scope: val('wbs-scope').trim() || null,
      wbs_acceptance: val('wbs-acceptance').trim() || null,
      wbs_owner: val('wbs-owner').trim() || null,
      updated_at: new Date().toISOString(),
    };

    try {
      await dbPut('tasks', updated);
      // Actualizar en memoria
      tasks?.set(this._selectedTaskId, updated);
      const msg = /** @type {HTMLElement} */ (this._detailEl.querySelector('#wbs-saved-msg'));
      if (msg) { msg.style.display = ''; setTimeout(() => { msg.style.display = 'none'; }, 2000); }
      // Refrescar lista para actualizar indicador ✓
      this._renderList();
      document.dispatchEvent(new CustomEvent('ecm-task-updated', { detail: { id: this._selectedTaskId } }));
    } catch (err) {
      console.error('[WBS dictionary] save error', err);
    }
  }

  refresh() {
    this._renderList();
    if (this._selectedTaskId) this._showDetail(this._selectedTaskId);
    else this._showEmpty();
  }
}
