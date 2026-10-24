// @ts-check
/**
 * reports.js — Sección "Reportes": árbol de todos los reportes agrupados por tema,
 * vista previa A4 e impresión.
 *
 * No duplica generadores: cada reporte se genera con su código actual (el mismo botón
 * 🖨 de su panel). Mientras se genera, window.open devuelve la ventana del <iframe> de
 * vista previa, así la página de impresión se escribe ahí en lugar de en una ventana
 * nueva. Los paneles que haya que abrir para generar un reporte se cierran después y la
 * pantalla queda como estaba.
 */

import { printToPdf } from './pdf-utils.js';

/**
 * Pasos para generar un reporte: selectores CSS a los que se hace clic, en orden.
 * Un paso { text, within } busca un botón por su texto; { wait } espera una condición.
 * @typedef {string | {text:string, within?:string} | {wait:() => boolean}} Step
 * @typedef {{ name:string, steps?:Step[], run?:() => void }} Report
 */

/** @type {{ group:string, reports:Report[] }[]} */
const TREE = [
  { group: 'Configuración', reports: [
    { name: 'Estructura de Proyectos', steps: ['#btn-orgchart-view', '#oc-print'] },
  ]},
  { group: 'Calendarios', reports: [
    { name: 'Calendarios',             steps: ['#btn-calendar', '#cal-mgr-print'] },
    { name: 'Calendario del proyecto', steps: ['#btn-calendar', 'button[data-cal-edit]', '#dlg-cal-print'] },
  ]},
  { group: 'Cronograma', reports: [
    { name: 'Tabla EDT',                run: _tablaEdt },
    { name: 'Diagrama de Gantt',        steps: ['[data-action="print-gantt"]'] },
    { name: 'Red CPM',                  steps: ['#btn-cpm-network', '#btn-cpm-export', '.cpm-exp-item[data-fmt="pdf"]'] },
    { name: 'Diccionario WBS',          steps: ['#btn-wbs-dictionary', '.wbs-list-item', 'button[title="Imprimir tarea actual"]'] },
    { name: 'Diccionario WBS Completo', steps: ['#btn-wbs-dictionary', { text: 'Imprimir Todo', within: '#panel-wbs-dictionary' }] },
  ]},
  { group: 'Recursos', reports: [
    { name: 'Catálogo de Recursos',   steps: ['#btn-resources', '#rm-btn-print'] },
    { name: 'Asignación de Recursos', steps: ['#btn-resources', '#btn-open-assign-dlg', 'input[name="ra-res"]', '#dlg-ra-print'] },
    { name: 'Histograma de Recursos', steps: ['#btn-resource-histogram-view',
        { wait: () => _visible('#rh-chart-wrap') || _visible('#rh-empty') }, '#btn-rh-print'] },
    { name: 'Nivelación de Recursos', steps: ['#btn-resource-leveling-view', '#btn-leveling-print'] },
  ]},
  { group: 'Planificación (Lookahead / LPS)', reports: [
    { name: 'Vista Lookahead',           steps: ['#btn-lookahead', '#la-btn-print'] },
    { name: 'Lookahead - Planificación', steps: ['#btn-lookahead-detailed', '.lad-tab[data-tab="planning"]', '#lad-btn-print'] },
    { name: 'Plan Semanal WWP',          steps: ['#btn-lookahead-detailed', '.lad-tab[data-tab="compliance"]', '#lad-btn-print'] },
    { name: 'Log de Restricciones',      steps: ['#btn-lookahead-detailed', '.lad-tab[data-tab="restrictions"]', '#lad-btn-print'] },
    { name: 'Lookahead - Dashboard',     steps: ['#btn-lookahead-detailed', '.lad-tab[data-tab="dashboard"]', '#lad-btn-print'] },
    { name: 'Stand-Up Diario',           steps: ['#btn-lookahead-detailed', '.lad-tab[data-tab="standup"]', '#lad-btn-print'] },
  ]},
  { group: 'Control y avance', reports: [
    { name: 'Informe Ejecutivo',         steps: ['#btn-pdf-report'] },
    { name: 'Curva S',                   steps: ['#btn-curva-s', '#panel-curva-s button[title="Imprimir PDF"]'] },
    { name: 'Valor Ganado (EVM)',        steps: ['#btn-evm-view', { wait: () => !!document.querySelector('#evm-content [data-kpi="bac"]')?.textContent?.trim().match(/\d/) }, '#btn-evm-print'] },
    { name: 'Líneas base',               steps: ['#btn-baseline', '#dlg-bl-print'] },
    { name: 'Comparación de Línea Base', steps: ['#btn-baseline-compare', '#dlg-blc-print'] },
    { name: 'Historial de cambios',      steps: ['#btn-changelog', '#btn-changelog-print'] },
    { name: 'Alertas',                   steps: ['#btn-notifications', '#panel-notifications button[title="Imprimir PDF"]'] },
  ]},
  { group: 'Calidad', reports: [
    { name: 'Evaluación DCMA 14 Puntos', steps: ['#btn-dcma-view', '#dcma-print-btn'] },
  ]},
  { group: 'Riesgo', reports: [
    { name: 'Registro de Riesgos',    steps: ['#btn-risk-register-view', '.rr-print-btn'] },
    { name: 'Simulación Monte Carlo', steps: ['#btn-monte-carlo-view', '#dlg-mc-print'] },
  ]},
];

/** Paneles que se abren con la clase .open o con style.display; se restauran tras generar. */
const OPEN_CLASS_PANELS = ['changelog-panel', 'dcma-panel', 'evm-panel', 'resource-histogram-panel'];
const DISPLAY_PANELS = ['panel-lookahead', 'panel-lookahead-detailed', 'panel-curva-s', 'panel-notifications',
  'panel-wbs-dictionary', 'panel-risk-register', 'panel-resource-leveling'];

let _panel = /** @type {HTMLElement|null} */ (null);
let _frameWrap = /** @type {HTMLElement|null} */ (null);
let _busy = false;

/** Crea la sección y la conecta con su entrada del menú lateral. */
export function initReports() {
  document.getElementById('btn-reports-view')?.addEventListener('click', _open);
}

function _open() {
  if (!_panel) _panel = _build();
  _panel.style.display = 'flex';
}

function _close() {
  if (_panel) _panel.style.display = 'none';
}

function _build() {
  const panel = document.createElement('div');
  panel.id = 'panel-reports';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'reports-title');
  panel.style.cssText = 'display:none;position:fixed;inset:0;z-index:850;background:rgba(0,0,0,.35)';
  panel.innerHTML = `
    <div style="position:absolute;inset:3vh 2vw;background:var(--clr-surface,#fff);border-radius:12px;
                box-shadow:0 8px 40px rgba(0,0,0,.25);display:flex;flex-direction:column;overflow:hidden">
      <div style="display:flex;align-items:center;gap:10px;padding:12px 18px;border-bottom:1px solid var(--clr-border,#e2e8f0)">
        <span style="font-size:18px">📑</span>
        <h2 id="reports-title" style="flex:1;margin:0;font-size:var(--text-md,15px);font-weight:var(--fw-semi,600)">Reportes</h2>
        <button id="btn-reports-print" class="btn btn-primary btn-sm" disabled title="Imprimir / guardar PDF del reporte seleccionado">🖨 Imprimir / PDF (A4)</button>
        <button id="btn-reports-close" class="btn btn-ghost btn-icon btn-sm" aria-label="Cerrar reportes" title="Cerrar">✕</button>
      </div>
      <div style="flex:1;min-height:0;display:flex">
        <nav id="reports-tree" aria-label="Lista de reportes"
             style="width:280px;flex-shrink:0;overflow:auto;padding:10px 8px;border-right:1px solid var(--clr-border,#e2e8f0);font-size:13px"></nav>
        <div id="reports-frame-wrap" style="flex:1;min-width:0;position:relative;background:#f1f5f9">
          <div class="reports-msg" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--clr-text-3,#64748b);font-size:13px">
            Seleccione un reporte de la lista para ver su vista previa.
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(panel);

  _frameWrap = /** @type {HTMLElement} */ (panel.querySelector('#reports-frame-wrap'));
  panel.querySelector('#btn-reports-close')?.addEventListener('click', _close);
  panel.addEventListener('click', e => { if (e.target === panel) _close(); });
  panel.addEventListener('keydown', e => { if (e.key === 'Escape') _close(); });
  panel.querySelector('#btn-reports-print')?.addEventListener('click', _printCurrent);

  // Árbol: un grupo plegable por tema, un reporte debajo del otro
  const tree = /** @type {HTMLElement} */ (panel.querySelector('#reports-tree'));
  for (const { group, reports } of TREE) {
    const det = document.createElement('details');
    det.open = true;
    det.style.cssText = 'margin-bottom:6px';
    const sum = document.createElement('summary');
    sum.textContent = group;
    sum.style.cssText = 'cursor:pointer;padding:6px 8px;font-weight:600;color:var(--clr-text-2,#4a5568);border-radius:6px;user-select:none';
    det.appendChild(sum);
    const ul = document.createElement('ul');
    ul.style.cssText = 'list-style:none;margin:0;padding:0 0 0 14px;border-left:1px solid var(--clr-border,#e2e8f0);margin-left:14px';
    for (const rep of reports) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'reports-item';
      btn.textContent = rep.name;
      btn.style.cssText = 'display:block;width:100%;text-align:left;padding:5px 8px;margin:1px 0;border:none;border-radius:6px;background:none;color:var(--clr-text,#1a1d23);cursor:pointer;font:inherit';
      btn.addEventListener('click', () => _select(rep, btn));
      li.appendChild(btn);
      ul.appendChild(li);
    }
    det.appendChild(ul);
    tree.appendChild(det);
  }
  return panel;
}

/** @param {Report} rep @param {HTMLButtonElement} btn */
async function _select(rep, btn) {
  if (_busy || !_panel || !_frameWrap) return;
  _busy = true;
  _panel.querySelectorAll('.reports-item').forEach(b => {
    /** @type {HTMLElement} */ (b).style.background = '';
    /** @type {HTMLElement} */ (b).style.color = '';
  });
  btn.style.background = 'var(--clr-primary,#1976D2)';
  btn.style.color = '#fff';
  const printBtn = /** @type {HTMLButtonElement} */ (_panel.querySelector('#btn-reports-print'));
  printBtn.disabled = true;
  _message('Generando vista previa…');

  // Ventana de vista previa nueva para cada reporte
  const frame = document.createElement('iframe');
  frame.title = 'Vista previa: ' + rep.name;
  frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;background:#f1f5f9';
  const snap = _snapshot();
  const realOpen = window.open, realAlert = window.alert;
  let opened = false, alertMsg = '';
  window.open = /** @type {any} */ (() => {
    if (opened) return null;
    opened = true;
    _frameWrap?.appendChild(frame);
    return frame.contentWindow;
  });
  window.alert = (m) => { alertMsg = String(m ?? ''); };

  try {
    if (rep.run) rep.run();
    else await _runSteps(rep.steps ?? []);
    await _until(() => opened || !!alertMsg, 8000);
  } catch (err) {
    console.error('[Reportes]', rep.name, err);
  } finally {
    window.open = realOpen;
    window.alert = realAlert;
    _restore(snap);
    _busy = false;
  }

  if (opened) {
    await _until(() => frame.contentDocument?.readyState === 'complete', 4000);
    // Dentro de la sección no aplica el botón "Cerrar" de la ventana de impresión
    const st = frame.contentDocument?.createElement('style');
    if (st && frame.contentDocument?.head) {
      st.textContent = 'button[onclick="window.close()"]{display:none!important}';
      frame.contentDocument.head.appendChild(st);
    }
    _useReportFileName(frame);
    _frameWrap.querySelectorAll('iframe').forEach(f => { if (f !== frame) f.remove(); });
    _frameWrap.querySelector('.reports-msg')?.remove();
    printBtn.disabled = false;
  } else {
    frame.remove();
    _message(alertMsg || 'No se pudo generar este reporte con los datos actuales del proyecto.');
  }
}

function _printCurrent() {
  const frame = /** @type {HTMLIFrameElement|null} */ (_frameWrap?.querySelector('iframe') ?? null);
  const win = frame?.contentWindow;
  if (!win) return;
  win.focus();
  win.print();
}

/**
 * Al imprimir un iframe, el navegador propone como nombre del PDF el título de la ventana
 * principal ("ECM Project"). Mientras dura la impresión se usa el título del reporte, que
 * sigue la regla PROYECTO-Proceso-Fecha (o lo escrito en el campo "Archivo").
 * Aplica al botón de la sección y al "Guardar PDF" de la barra del reporte.
 * @param {HTMLIFrameElement} frame
 */
function _useReportFileName(frame) {
  const win = /** @type {any} */ (frame.contentWindow);
  if (!win) return;
  const print = win.print.bind(win);
  win.print = () => {
    const prev = document.title;
    const field = /** @type {HTMLInputElement|null} */ (win.document.querySelector('#fn, #fn-inp'));
    document.title = (field?.value || win.document.title || prev).replace(/\.pdf$/i, '').trim() || prev;
    try { print(); } finally { setTimeout(() => { document.title = prev; }, 0); }
  };
}

/** @param {string} text */
function _message(text) {
  if (!_frameWrap) return;
  _frameWrap.querySelectorAll('iframe').forEach(f => f.remove());
  let msg = /** @type {HTMLElement|null} */ (_frameWrap.querySelector('.reports-msg'));
  if (!msg) {
    msg = document.createElement('div');
    msg.className = 'reports-msg';
    msg.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--clr-text-3,#64748b);font-size:13px;padding:24px;text-align:center';
    _frameWrap.appendChild(msg);
  }
  msg.textContent = text;
}

/** Ejecuta los pasos (clics) que generan el reporte. @param {Step[]} steps */
async function _runSteps(steps) {
  for (const step of steps) {
    if (typeof step === 'object' && 'wait' in step) { await _until(step.wait, 8000); continue; }
    const el = await _until(() => _find(step), 6000);
    if (!el) throw new Error('No se encontró: ' + JSON.stringify(step));
    /** @type {HTMLElement} */ (el).click();
    await _sleep(350);
  }
}

/** @param {string | {text:string, within?:string}} step */
function _find(step) {
  if (typeof step === 'string') return document.querySelector(step);
  const root = step.within ? document.querySelector(step.within) : document;
  return [...(root?.querySelectorAll('button') ?? [])].find(b => b.textContent?.includes(step.text)) ?? null;
}

/** Tabla EDT: se imprime desde la vista principal; aquí se arma la misma tabla en una hoja A4 horizontal. */
function _tablaEdt() {
  const table = document.querySelector('.wbs-table');
  if (!table) return;
  const clone = /** @type {HTMLElement} */ (table.cloneNode(true));
  // Respetar las columnas ocultas en pantalla y quitar las que no se imprimen
  const hidden = new Set([...table.querySelectorAll('th[data-col]')]
    .filter(th => getComputedStyle(th).display === 'none').map(th => th.getAttribute('data-col')));
  hidden.add('alerts');
  clone.querySelectorAll('[data-col]').forEach(c => { if (hidden.has(c.getAttribute('data-col'))) c.remove(); });
  clone.querySelectorAll('.td-actions,.expand-btn,.task-notes-icon,.sort-indicator,.indent-spacer').forEach(e => e.remove());
  printToPdf('Tabla EDT', `<link rel="stylesheet" href="css/components.css?v=99">${clone.outerHTML}`);
  // Hoja horizontal, como la impresión de la tabla EDT
  setTimeout(() => { try { /** @type {any} */ (_frameWrap?.querySelector('iframe')?.contentWindow)?.setOri?.('landscape'); } catch { /* ignore */ } }, 300);
}

// ---- Estado de la pantalla: abrir paneles para generar un reporte y dejarlos como estaban ----

function _snapshot() {
  return {
    openCls: OPEN_CLASS_PANELS.map(id => [id, !!document.getElementById(id)?.classList.contains('open')]),
    display: DISPLAY_PANELS.map(id => [id, document.getElementById(id)?.style.display ?? '']),
    dialogs: new Set(document.querySelectorAll('dialog[open]')),
    hasHistogram: !!document.getElementById('right-content')?.classList.contains('has-histogram'),
    menuHidden: !!document.getElementById('export-menu')?.hidden,
    buttons: [...document.querySelectorAll('[id^="btn-"]')].map(b => {
      const el = /** @type {HTMLElement} */ (b);
      return [el, el.className, el.style.background, el.style.color, el.getAttribute('aria-pressed')];
    }),
  };
}

/** @param {ReturnType<typeof _snapshot>} s */
function _restore(s) {
  for (const [id, open] of s.openCls) document.getElementById(/** @type {string} */ (id))?.classList.toggle('open', /** @type {boolean} */ (open));
  for (const [id, disp] of s.display) {
    const el = document.getElementById(/** @type {string} */ (id));
    if (el) el.style.display = /** @type {string} */ (disp);
  }
  document.querySelectorAll('dialog[open]').forEach(d => { if (!s.dialogs.has(d)) /** @type {HTMLDialogElement} */ (d).close(); });
  document.getElementById('right-content')?.classList.toggle('has-histogram', s.hasHistogram);
  const menu = document.getElementById('export-menu');
  if (menu) menu.hidden = s.menuHidden;
  for (const [el, cls, bg, color, pressed] of s.buttons) {
    const b = /** @type {HTMLElement} */ (el);
    b.className = /** @type {string} */ (cls);
    b.style.background = /** @type {string} */ (bg);
    b.style.color = /** @type {string} */ (color);
    if (pressed === null) b.removeAttribute('aria-pressed'); else b.setAttribute('aria-pressed', /** @type {string} */ (pressed));
  }
  if (_panel) _panel.style.display = 'flex';
}

/** @param {string} sel */
function _visible(sel) {
  const el = /** @type {HTMLElement|null} */ (document.querySelector(sel));
  return !!el && el.style.display !== 'none' && el.offsetParent !== null;
}

/** @param {number} ms */
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Espera hasta que fn() devuelva un valor verdadero (o se agote el tiempo).
 * @template T @param {() => T} fn @param {number} ms @returns {Promise<T|null>}
 */
async function _until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await _sleep(100);
  }
  return null;
}
