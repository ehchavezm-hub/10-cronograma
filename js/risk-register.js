// @ts-check
/**
 * risk-register.js — Registro de Riesgos con matriz de probabilidad × impacto.
 *
 * Schema de riesgo:
 *   id, project_id, title, description, probability(1-5), impact(1-5),
 *   risk_score(=prob*impact), category, response, owner, status,
 *   created_at, updated_at, deleted_at
 *
 * Colores por score:
 *   bajo  (1-4)  : #4caf50
 *   medio (5-9)  : #ff9800
 *   alto  (10-25): #f44336
 */

import { getByIndex, put } from './storage.js';

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

const CATEGORIES = ['Técnico', 'Externo', 'Organizacional', 'Gestión de proyectos', 'Otro'];
const STATUSES   = ['Abierto', 'En seguimiento', 'Cerrado', 'Aceptado'];

function _scoreColor(score) {
  if (score >= 10) return '#f44336';
  if (score >= 5)  return '#ff9800';
  return '#4caf50';
}

function _scoreName(score) {
  if (score >= 10) return 'Alto';
  if (score >= 5)  return 'Medio';
  return 'Bajo';
}

function _uid() {
  return 'rsk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function _now() { return new Date().toISOString(); }

/** @param {number} v @returns {string} */
function _probLabel(v) {
  return ['', 'Muy baja', 'Baja', 'Media', 'Alta', 'Muy alta'][v] ?? String(v);
}

/** @param {number} v @returns {string} */
function _impLabel(v) {
  return ['', 'Muy bajo', 'Bajo', 'Moderado', 'Alto', 'Muy alto'][v] ?? String(v);
}

export class RiskRegisterPanel {
  /**
   * @param {{projectId: string, container: HTMLElement, onClose?: ()=>void}} opts
   */
  constructor({ projectId, container, onClose }) {
    this.projectId = projectId;
    this.container = container;
    this.onClose   = onClose ?? (() => {});
    /** @type {any[]} */
    this.risks     = [];
    this._view     = 'list'; // 'list' | 'matrix'
    this._editRisk = null;
    this._render();
    this._loadRisks();
  }

  // ---- Data ----

  async _loadRisks() {
    try {
      const all = await getByIndex('risks', 'project_id', this.projectId);
      this.risks = all.filter(r => !r.deleted_at);
      this._renderBody();
    } catch (e) {
      console.error('RiskRegister load error', e);
    }
  }

  async _saveRisk(risk) {
    risk.updated_at = _now();
    await put('risks', risk);
    await this._loadRisks();
  }

  async _deleteRisk(id) {
    const r = this.risks.find(r => r.id === id);
    if (!r) return;
    r.deleted_at = _now();
    r.updated_at = _now();
    await put('risks', r);
    await this._loadRisks();
  }

  // ---- Render ----

  _render() {
    this.container.innerHTML = '';
    this.container.className = 'rr-panel';

    // Header
    const hdr = document.createElement('div');
    hdr.className = 'rr-header';
    hdr.setAttribute('data-drag-handle', '');
    hdr.innerHTML = `
      <span class="rr-title">Registro de Riesgos</span>
      <div class="rr-header-actions">
        <button class="rr-btn rr-btn-sm rr-view-toggle" data-view="list" title="Vista Lista">&#9776; Lista</button>
        <button class="rr-btn rr-btn-sm rr-view-toggle" data-view="matrix" title="Vista Matriz">&#9724; Matriz</button>
        <button class="rr-btn rr-btn-primary" id="rr-new-btn">+ Nuevo Riesgo</button>
        <button class="rr-close-btn" title="Cerrar">&times;</button>
      </div>`;
    this.container.appendChild(hdr);

    hdr.querySelector('.rr-close-btn').addEventListener('click', () => this.onClose());
    hdr.querySelector('#rr-new-btn').addEventListener('click', () => this._openForm(null));
    hdr.querySelectorAll('.rr-view-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        this._view = /** @type {HTMLElement} */ (btn).dataset.view;
        this._updateViewButtons();
        this._renderBody();
      });
    });

    // Body container
    this._bodyEl = document.createElement('div');
    this._bodyEl.className = 'rr-body';
    this.container.appendChild(this._bodyEl);

    // Form modal
    this._formOverlay = document.createElement('div');
    this._formOverlay.className = 'rr-overlay hidden';
    this.container.appendChild(this._formOverlay);

    this._updateViewButtons();
    if (this.container.parentElement) _makeDraggable(this.container.parentElement, '[data-drag-handle]');
  }

  _updateViewButtons() {
    this.container.querySelectorAll('.rr-view-toggle').forEach(btn => {
      /** @type {HTMLElement} */ (btn).classList.toggle('active', /** @type {HTMLElement} */ (btn).dataset.view === this._view);
    });
  }

  _renderBody() {
    if (!this._bodyEl) return;
    if (this._view === 'matrix') {
      this._renderMatrix();
    } else {
      this._renderList();
    }
  }

  // ---- List View ----

  _renderList() {
    const el = this._bodyEl;
    el.innerHTML = '';

    if (!this.risks.length) {
      el.innerHTML = '<p class="rr-empty">No hay riesgos registrados. Haz clic en "+ Nuevo Riesgo" para agregar uno.</p>';
      return;
    }

    const table = document.createElement('table');
    table.className = 'rr-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Título</th>
          <th>Categoría</th>
          <th>Prob.</th>
          <th>Impacto</th>
          <th>Score</th>
          <th>Nivel</th>
          <th>Responsable</th>
          <th>Estado</th>
          <th>Acciones</th>
        </tr>
      </thead>`;
    const tbody = document.createElement('tbody');
    const sorted = [...this.risks].sort((a, b) => (b.risk_score ?? 0) - (a.risk_score ?? 0));
    for (const r of sorted) {
      const score = r.risk_score ?? (r.probability * r.impact);
      const color = _scoreColor(score);
      const level = _scoreName(score);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="rr-td-title" title="${_esc(r.description ?? '')}">${_esc(r.title)}</td>
        <td>${_esc(r.category ?? '')}</td>
        <td class="rr-center">${r.probability} — ${_probLabel(r.probability)}</td>
        <td class="rr-center">${r.impact} — ${_impLabel(r.impact)}</td>
        <td class="rr-center"><span class="rr-score-badge" style="background:${color}">${score}</span></td>
        <td class="rr-center"><span style="color:${color};font-weight:600">${level}</span></td>
        <td>${_esc(r.owner ?? '')}</td>
        <td><span class="rr-status-chip">${_esc(r.status ?? '')}</span></td>
        <td class="rr-actions">
          <button class="rr-btn rr-btn-xs rr-edit-btn" data-id="${_esc(r.id)}">Editar</button>
          <button class="rr-btn rr-btn-xs rr-btn-danger rr-del-btn" data-id="${_esc(r.id)}">Eliminar</button>
        </td>`;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    el.appendChild(table);

    el.querySelectorAll('.rr-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = this.risks.find(r => r.id === /** @type {HTMLElement} */ (btn).dataset.id);
        if (r) this._openForm(r);
      });
    });
    el.querySelectorAll('.rr-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('¿Eliminar este riesgo?')) {
          this._deleteRisk(/** @type {HTMLElement} */ (btn).dataset.id);
        }
      });
    });
  }

  // ---- Matrix View ----

  _renderMatrix() {
    const el = this._bodyEl;
    el.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.className = 'rr-matrix-wrap';

    const grid = document.createElement('div');
    grid.className = 'rr-matrix-grid';

    // Y label
    const yLabel = document.createElement('div');
    yLabel.className = 'rr-matrix-ylabel';
    yLabel.textContent = 'Probabilidad';
    wrap.appendChild(yLabel);

    // Grid area
    const gridArea = document.createElement('div');
    gridArea.className = 'rr-matrix-area';

    // Build 5×5 cells, prob=5..1 (rows top to bottom), impact=1..5 (cols left to right)
    for (let prob = 5; prob >= 1; prob--) {
      const row = document.createElement('div');
      row.className = 'rr-matrix-row';

      // Row label
      const rowLbl = document.createElement('div');
      rowLbl.className = 'rr-matrix-rowlbl';
      rowLbl.textContent = `${prob} — ${_probLabel(prob)}`;
      row.appendChild(rowLbl);

      for (let imp = 1; imp <= 5; imp++) {
        const score = prob * imp;
        const color = _scoreColor(score);
        const cell = document.createElement('div');
        cell.className = 'rr-matrix-cell';
        cell.style.background = color + '22';
        cell.style.borderColor = color + '88';

        const cellRisks = this.risks.filter(r => r.probability === prob && r.impact === imp);
        cell.innerHTML = `<span class="rr-cell-score" style="color:${color}">${score}</span>`;
        for (const r of cellRisks) {
          const chip = document.createElement('div');
          chip.className = 'rr-cell-chip';
          chip.title = r.title;
          chip.textContent = r.title.length > 18 ? r.title.slice(0, 16) + '…' : r.title;
          chip.addEventListener('click', () => this._openForm(r));
          cell.appendChild(chip);
        }
        row.appendChild(cell);
      }
      gridArea.appendChild(row);
    }

    // X labels
    const xRow = document.createElement('div');
    xRow.className = 'rr-matrix-xrow';
    xRow.appendChild(document.createElement('div')); // spacer for rowlbl
    for (let imp = 1; imp <= 5; imp++) {
      const lbl = document.createElement('div');
      lbl.className = 'rr-matrix-collbl';
      lbl.textContent = `${imp} — ${_impLabel(imp)}`;
      xRow.appendChild(lbl);
    }
    gridArea.appendChild(xRow);

    wrap.appendChild(gridArea);

    // X axis label
    const xLabel = document.createElement('div');
    xLabel.className = 'rr-matrix-xlabel';
    xLabel.textContent = 'Impacto';
    wrap.appendChild(xLabel);

    el.appendChild(wrap);

    // Legend
    const legend = document.createElement('div');
    legend.className = 'rr-matrix-legend';
    legend.innerHTML = `
      <span><span class="rr-leg-dot" style="background:#4caf50"></span>Bajo (1–4)</span>
      <span><span class="rr-leg-dot" style="background:#ff9800"></span>Medio (5–9)</span>
      <span><span class="rr-leg-dot" style="background:#f44336"></span>Alto (10–25)</span>`;
    el.appendChild(legend);
  }

  // ---- Form ----

  _openForm(risk) {
    this._editRisk = risk ? { ...risk } : null;
    const isNew = !risk;
    const r = risk ?? {
      id: _uid(), project_id: this.projectId, title: '', description: '',
      probability: 3, impact: 3, category: CATEGORIES[0], response: '',
      owner: '', status: STATUSES[0], created_at: _now(),
    };

    this._formOverlay.innerHTML = '';
    this._formOverlay.classList.remove('hidden');

    const modal = document.createElement('div');
    modal.className = 'rr-modal';
    modal.innerHTML = `
      <div class="rr-modal-header">
        <span>${isNew ? 'Nuevo Riesgo' : 'Editar Riesgo'}</span>
        <button class="rr-close-btn rr-modal-close">&times;</button>
      </div>
      <div class="rr-modal-body">
        <label>Título *
          <input class="rr-input" id="rr-f-title" value="${_esc(r.title)}" maxlength="200" required>
        </label>
        <label>Descripción
          <textarea class="rr-input rr-textarea" id="rr-f-desc" rows="3">${_esc(r.description ?? '')}</textarea>
        </label>
        <div class="rr-form-row">
          <label>Categoría
            <select class="rr-input" id="rr-f-cat">${CATEGORIES.map(c => `<option${c===r.category?' selected':''}>${c}</option>`).join('')}</select>
          </label>
          <label>Estado
            <select class="rr-input" id="rr-f-status">${STATUSES.map(s => `<option${s===r.status?' selected':''}>${s}</option>`).join('')}</select>
          </label>
        </div>
        <div class="rr-form-row">
          <label>Probabilidad (1–5)
            <div class="rr-slider-row">
              <input type="range" min="1" max="5" step="1" id="rr-f-prob" value="${r.probability}" class="rr-slider">
              <span id="rr-f-prob-lbl">${r.probability} — ${_probLabel(r.probability)}</span>
            </div>
          </label>
          <label>Impacto (1–5)
            <div class="rr-slider-row">
              <input type="range" min="1" max="5" step="1" id="rr-f-imp" value="${r.impact}" class="rr-slider">
              <span id="rr-f-imp-lbl">${r.impact} — ${_impLabel(r.impact)}</span>
            </div>
          </label>
        </div>
        <div class="rr-score-preview" id="rr-f-score-preview">
          Score: <strong id="rr-f-score-val">${r.probability * r.impact}</strong>
          &nbsp;<span id="rr-f-score-name">${_scoreName(r.probability * r.impact)}</span>
        </div>
        <div class="rr-form-row">
          <label>Responsable
            <input class="rr-input" id="rr-f-owner" value="${_esc(r.owner ?? '')}" maxlength="100">
          </label>
        </div>
        <label>Plan de respuesta
          <textarea class="rr-input rr-textarea" id="rr-f-response" rows="3">${_esc(r.response ?? '')}</textarea>
        </label>
      </div>
      <div class="rr-modal-footer">
        <button class="rr-btn" id="rr-f-cancel">Cancelar</button>
        <button class="rr-btn rr-btn-primary" id="rr-f-save">Guardar</button>
      </div>`;

    this._formOverlay.appendChild(modal);

    const probSlider = /** @type {HTMLInputElement} */ (modal.querySelector('#rr-f-prob'));
    const impSlider  = /** @type {HTMLInputElement} */ (modal.querySelector('#rr-f-imp'));
    const probLbl    = modal.querySelector('#rr-f-prob-lbl');
    const impLbl     = modal.querySelector('#rr-f-imp-lbl');
    const scoreVal   = modal.querySelector('#rr-f-score-val');
    const scoreName  = modal.querySelector('#rr-f-score-name');
    const scoreBox   = /** @type {HTMLElement} */ (modal.querySelector('#rr-f-score-preview'));

    const _updateScore = () => {
      const p = +probSlider.value, im = +impSlider.value;
      const sc = p * im;
      probLbl.textContent  = `${p} — ${_probLabel(p)}`;
      impLbl.textContent   = `${im} — ${_impLabel(im)}`;
      scoreVal.textContent = String(sc);
      scoreName.textContent = _scoreName(sc);
      scoreBox.style.borderColor = _scoreColor(sc);
      scoreBox.style.color = _scoreColor(sc);
    };
    probSlider.addEventListener('input', _updateScore);
    impSlider.addEventListener('input', _updateScore);
    _updateScore();

    modal.querySelector('#rr-f-cancel').addEventListener('click', () => this._closeForm());
    modal.querySelector('.rr-modal-close').addEventListener('click', () => this._closeForm());

    modal.querySelector('#rr-f-save').addEventListener('click', async () => {
      const title = /** @type {HTMLInputElement} */ (modal.querySelector('#rr-f-title')).value.trim();
      if (!title) { alert('El título es obligatorio.'); return; }
      const prob = +probSlider.value;
      const imp  = +impSlider.value;
      const record = {
        ...r,
        title,
        description: /** @type {HTMLTextAreaElement} */ (modal.querySelector('#rr-f-desc')).value.trim(),
        category:    /** @type {HTMLSelectElement}   */ (modal.querySelector('#rr-f-cat')).value,
        status:      /** @type {HTMLSelectElement}   */ (modal.querySelector('#rr-f-status')).value,
        probability: prob,
        impact:      imp,
        risk_score:  prob * imp,
        owner:       /** @type {HTMLInputElement}    */ (modal.querySelector('#rr-f-owner')).value.trim(),
        response:    /** @type {HTMLTextAreaElement} */ (modal.querySelector('#rr-f-response')).value.trim(),
      };
      if (isNew) record.created_at = _now();
      await this._saveRisk(record);
      this._closeForm();
    });
  }

  _closeForm() {
    this._formOverlay.classList.add('hidden');
    this._editRisk = null;
  }

  // ---- Public API ----

  /** Refresca los riesgos desde IndexedDB. */
  refresh() { this._loadRisks(); }

  /** @returns {any[]} */
  getRisks() { return [...this.risks]; }
}

// ---- helpers ----
/** @param {any} s @returns {string} */
function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
