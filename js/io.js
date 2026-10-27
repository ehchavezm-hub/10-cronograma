// @ts-check
/**
 * io.js — Exportación e importación del proyecto.
 *
 * Formatos:
 *   • JSON  — instantánea completa (proyecto, tareas, deps, calendario)
 *   • CSV   — tabla de actividades (WBS, nombre, duraciones, fechas, CPM)
 *   • XML   — MS Project XML (importable en MSP 2010+)
 *   • SVG   — diagrama Gantt vectorial (usa gantt-svg.js)
 *
 * Todos los exports usan descarga del lado del cliente (Blob + a[download]).
 */

import { appState }      from './state.js';
import { isoToDate, Calendar } from './calendar.js';
import { renderGanttSvg } from './gantt-svg.js';

// ============================================================
// Helpers de descarga
// ============================================================

/** Descarga un Blob como archivo. */
function _download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

/** Escapa un campo CSV (envuelve en comillas si contiene coma, comilla o salto de línea). */
function _csvField(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

/** Escapa caracteres especiales XML. */
function _xmlEsc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Construye la instancia Calendar desde el estado. */
function _makeCalendar() {
  const { calendar, calExceptions } = appState.state;
  const calDef = calendar
    ? { work_week: calendar.work_week,
        exceptions: (calExceptions ?? []).filter(e => !e.deleted_at)
          .map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };
  return new Calendar(calDef);
}

/** Calcula códigos WBS para todas las tareas activas. */
function _calcWbsCodes(tasks) {
  const activeTasks = [...tasks.values()].filter(t => !t.deleted_at);
  const children    = new Map(activeTasks.map(t => [t.id, []]));
  const roots       = [];
  for (const t of activeTasks) {
    if (!t.parent_id) roots.push(t);
    else children.get(t.parent_id)?.push(t);
  }
  for (const ch of children.values()) ch.sort((a, b) => a.sort_order - b.sort_order);
  roots.sort((a, b) => a.sort_order - b.sort_order);

  const codes  = new Map();
  const depths = new Map();
  const walk   = (task, prefix, depth) => {
    codes.set(task.id, prefix);
    depths.set(task.id, depth);
    const ch = children.get(task.id) ?? [];
    ch.forEach((c, i) => walk(c, prefix ? `${prefix}.${i + 1}` : String(i + 1), depth + 1));
  };
  roots.forEach((r, i) => walk(r, String(i + 1), 0));
  return { codes, depths };
}

/** Construye la lista ordenada de tareas visibles (DFS, sin filtrar por expandedIds). */
function _orderedTasks(tasks) {
  const activeTasks = [...tasks.values()].filter(t => !t.deleted_at);
  const children    = new Map(activeTasks.map(t => [t.id, []]));
  const roots       = [];
  for (const t of activeTasks) {
    if (!t.parent_id) roots.push(t);
    else children.get(t.parent_id)?.push(t);
  }
  for (const ch of children.values()) ch.sort((a, b) => a.sort_order - b.sort_order);
  roots.sort((a, b) => a.sort_order - b.sort_order);

  const result = [];
  const walk = (task) => { result.push(task); for (const c of children.get(task.id) ?? []) walk(c); };
  roots.forEach(r => walk(r));
  return result;
}

// ============================================================
// Exportar JSON
// ============================================================

/** Exporta el proyecto completo como JSON descargable. */
export function exportJson() {
  const { project, tasks, deps, calendar, calExceptions } = appState.state;
  if (!project) return;

  const snapshot = {
    version: 7,
    exported_at: new Date().toISOString(),
    project,
    tasks:  [...tasks.values()].filter(t => !t.deleted_at),
    deps:   [...deps.values()].filter(d => !d.deleted_at),
    calendar,
    calExceptions: calExceptions.filter(e => !e.deleted_at),
  };

  const json  = JSON.stringify(snapshot, null, 2);
  const blob  = new Blob([json], { type: 'application/json;charset=utf-8' });
  const name  = (project.code || project.name).replace(/[^\w.-]/g, '_') + '_gantt.json';
  _download(blob, name);
}

// ============================================================
// Importar JSON
// ============================================================

/**
 * Importa un archivo JSON de proyecto.
 * @param {File} file
 * @returns {Promise<object>} La instantánea deserializada.
 */
export function importJson(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => {
      try {
        const data = JSON.parse(/** @type {string} */ (e.target.result));
        if (!data.project || !Array.isArray(data.tasks) || (data.deps !== undefined && !Array.isArray(data.deps))) {
          reject(new Error('Formato de archivo no válido — falta project o tasks.'));
        } else {
          resolve(data);
        }
      } catch (err) {
        reject(new Error('No se pudo parsear el JSON: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Error al leer el archivo.'));
    reader.readAsText(file, 'utf-8');
  });
}

// ============================================================
// Exportar CSV
// ============================================================

/** Exporta la tabla de actividades como CSV UTF-8. */
export function exportCsv() {
  const { project, tasks, deps, cpmResult } = appState.state;
  if (!project) return;

  const cal       = _makeCalendar();
  const startDate = isoToDate(project.start_date);
  const ordered   = _orderedTasks(tasks);
  const { codes } = _calcWbsCodes(tasks);
  const cpmTasks  = cpmResult?.tasks ?? new Map();

  // Mapa predecesoras: succId → [pred wbs strings]
  const predMap = new Map();
  deps.forEach(d => {
    if (d.deleted_at) return;
    if (!predMap.has(d.succ_id)) predMap.set(d.succ_id, []);
    const predWbs = codes.get(d.pred_id) ?? '?';
    const lag     = d.lag_days !== 0 ? (d.lag_days > 0 ? `+${d.lag_days}` : d.lag_days) : '';
    predMap.get(d.succ_id).push(`${predWbs}${d.type !== 'FS' ? d.type : ''}${lag}`);
  });

  const HEADER = ['EDT','ID','Nombre','Tipo','Duración (d)','Inicio','Fin','% Avance',
                  'HT (d)','HL (d)','Predecesoras','Restricción'];

  const parentIds = new Set(ordered.filter(t => t.parent_id).map(t => t.parent_id));
  const rows = ordered.map(task => {
    const cpm     = cpmTasks.get(task.id);
    const wbs     = codes.get(task.id) ?? '';
    const isSumm  = parentIds.has(task.id);
    const type    = isSumm ? 'resumen' : task.type === 'milestone' ? 'hito' : 'tarea';

    let startStr = '', finStr = '', tf = '', ff = '';
    if (cpm) {
      if (cpm.es != null) startStr = cal.idxToDate(cpm.es, startDate).toISOString().slice(0,10);
      if (cpm.ef != null) finStr   = cal.idxToDate(Math.max(cpm.es, cpm.ef - 1), startDate).toISOString().slice(0,10);
      if (cpm.tf != null) tf = String(cpm.tf);
      if (cpm.ff != null) ff = String(cpm.ff);
    }

    return [
      wbs, task.id, task.name, type,
      task.type === 'milestone' ? 0 : task.duration_days,
      startStr, finStr,
      task.percent_complete ?? 0,
      tf, ff,
      (predMap.get(task.id) ?? []).join('; '),
      task.constraint_type ?? 'ASAP',
    ].map(_csvField).join(',');
  });

  const csv  = '﻿' + [HEADER.join(','), ...rows].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const name = (project.code || project.name).replace(/[^\w.-]/g, '_') + '_actividades.csv';
  _download(blob, name);
}

// ============================================================
// Exportar MS Project XML
// ============================================================

const DEP_TYPE_MSP = { FS: 1, SS: 3, FF: 0, SF: 2 };

/** Exporta el proyecto en formato MS Project XML (importable en MSP 2010+). */
export function exportMspXml() {
  const { project, tasks, deps, cpmResult } = appState.state;
  if (!project) return;

  const cal       = _makeCalendar();
  const startDate = isoToDate(project.start_date);
  const ordered   = _orderedTasks(tasks);
  const { codes, depths } = _calcWbsCodes(tasks);
  const cpmTasks  = cpmResult?.tasks ?? new Map();
  const uidMap    = new Map(ordered.map((t, i) => [t.id, i + 1]));

  const parentIds = new Set(ordered.filter(t => t.parent_id).map(t => t.parent_id));

  // Dependencias por sucesor
  const predsBySucc = new Map();
  deps.forEach(d => {
    if (d.deleted_at) return;
    if (!predsBySucc.has(d.succ_id)) predsBySucc.set(d.succ_id, []);
    predsBySucc.get(d.succ_id).push(d);
  });

  const taskXml = ordered.map((task, i) => {
    const cpm      = cpmTasks.get(task.id);
    const uid      = i + 1;
    const isSumm   = parentIds.has(task.id);
    const isMile   = task.type === 'milestone';
    const dur      = isMile ? 0 : (task.duration_days ?? 0);
    const durStr   = `PT${dur * 8}H0M0S`;
    const depth    = depths.get(task.id) ?? 0;
    const wbs      = codes.get(task.id) ?? String(uid);
    const pct      = task.percent_complete ?? 0;

    let startStr = _mspDate(startDate);
    let finStr   = _mspDate(startDate);
    if (cpm && cpm.es != null) startStr = _mspDate(cal.idxToDate(cpm.es, startDate));
    if (cpm && cpm.ef != null) finStr   = _mspDate(cal.idxToDate(Math.max(cpm.es, cpm.ef - 1), startDate));

    const predsXml = (predsBySucc.get(task.id) ?? []).map(d => {
      const predUid = uidMap.get(d.pred_id) ?? 0;
      const lagMs   = d.lag_days * 8 * 3600000;
      const lagStr  = `PT${d.lag_days * 8}H0M0S`;
      return `<PredecessorLink>
        <PredecessorUID>${predUid}</PredecessorUID>
        <Type>${DEP_TYPE_MSP[d.type] ?? 1}</Type>
        <LinkLag>${lagMs}</LinkLag>
        <LagFormat>7</LagFormat>
      </PredecessorLink>`;
    }).join('\n      ');

    return `  <Task>
    <UID>${uid}</UID>
    <ID>${uid}</ID>
    <Name>${_xmlEsc(task.name)}</Name>
    <Type>0</Type>
    <IsNull>0</IsNull>
    <WBS>${_xmlEsc(wbs)}</WBS>
    <OutlineNumber>${_xmlEsc(wbs)}</OutlineNumber>
    <OutlineLevel>${depth + 1}</OutlineLevel>
    <Summary>${isSumm ? 1 : 0}</Summary>
    <Milestone>${isMile ? 1 : 0}</Milestone>
    <Duration>${durStr}</Duration>
    <DurationFormat>7</DurationFormat>
    <Start>${startStr}</Start>
    <Finish>${finStr}</Finish>
    <PercentComplete>${pct}</PercentComplete>
    <Notes>${_xmlEsc(task.notes ?? '')}</Notes>
    ${predsXml}
  </Task>`;
  }).join('\n');

  const projStart = _mspDate(startDate);
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>${_xmlEsc(project.name)}</Name>
  <Title>${_xmlEsc(project.name)}</Title>
  <Subject>${_xmlEsc(project.description ?? '')}</Subject>
  <StartDate>${projStart}</StartDate>
  <CalendarUID>1</CalendarUID>
  <DefaultView>Gantt Chart</DefaultView>
  <Calendars>
    <Calendar>
      <UID>1</UID>
      <Name>Standard</Name>
      <IsBaseCalendar>1</IsBaseCalendar>
    </Calendar>
  </Calendars>
  <Tasks>
${taskXml}
  </Tasks>
  <Assignments/>
</Project>`;

  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  const name = (project.code || project.name).replace(/[^\w.-]/g, '_') + '_msproject.xml';
  _download(blob, name);
}

function _mspDate(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, '');
}

// ============================================================
// Exportar SVG del Gantt
// ============================================================

/**
 * Exporta el diagrama Gantt como SVG vectorial.
 * @param {Array<{id:string,isSummary:boolean,depth:number}>} rows Filas visibles (del GanttCanvas)
 */
export function exportSvg(rows) {
  const { project, tasks, deps, cpmResult, calendar, calExceptions } = appState.state;
  if (!project || !cpmResult) return;

  const calDef    = calendar
    ? { work_week: calendar.work_week,
        exceptions: (calExceptions ?? []).filter(e => !e.deleted_at)
          .map(e => ({ on_date: e.on_date, is_working: e.is_working })) }
    : { work_week: [1,2,3,4,5], exceptions: [] };
  const cal       = new Calendar(calDef);
  const startDate = isoToDate(project.start_date);

  let ganttExtraCols = [];
  try {
    const saved = JSON.parse(localStorage.getItem('wbs-col-visibility') || '[]');
    ganttExtraCols = ['wbs','dur','start','finish','pct','tf','ff','pred'].filter(c => saved.includes(c));
  } catch { /* ignore */ }
  const svgStr = renderGanttSvg({
    tasks, deps, cpmResult, calendar: cal,
    projectStart: startDate, rows,
    nearThreshold: appState.state.nearThreshold ?? 5,
    extraCols: ganttExtraCols,
  });

  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
  const name = (project.code || project.name).replace(/[^\w.-]/g, '_') + '_gantt.svg';
  _download(blob, name);
}
