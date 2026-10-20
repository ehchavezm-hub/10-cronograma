// @ts-check
/**
 * xer-import.js — Importador de archivos XER de Primavera P6.
 *
 * Parsea el formato texto tabulado XER y lo convierte al schema
 * interno de ECM Project (tasks, deps, project, calendar).
 *
 * Uso:
 *   import { parseXer } from './xer-import.js';
 *   const { project, tasks, deps, calendar, warnings } = parseXer(xerText);
 */

// ============================================================
// Parser de formato XER
// ============================================================

/**
 * Lee un string XER y devuelve un Map<tableName, row[]>
 * donde cada row es un objeto campo→valor (strings crudos).
 * @param {string} text
 * @returns {Map<string, Record<string,string>[]>}
 */
function _parseXerTables(text) {
  const tables = new Map();
  let currentTable = null;
  let fields = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    const tag  = line.slice(0, 2);
    const rest = line.slice(3); // después del tab

    if (tag === '%T') {
      currentTable = rest.trim();
      fields = [];
      if (!tables.has(currentTable)) tables.set(currentTable, []);
    } else if (tag === '%F') {
      fields = rest.split('\t');
    } else if (tag === '%R' && currentTable) {
      const values = rest.split('\t');
      const row = /** @type {Record<string,string>} */ ({});
      fields.forEach((f, i) => { row[f] = values[i] ?? ''; });
      tables.get(currentTable).push(row);
    } else if (tag === '%E') {
      break;
    }
  }

  return tables;
}

// ============================================================
// Parseo de clndr_data (calendario P6 en XML interno)
// ============================================================

/**
 * Extrae días hábiles de la semana del XML clndr_data de P6.
 * Retorna array estilo work_week [0-6] donde 0=domingo.
 * Si no puede parsear, devuelve lunes-viernes [1,2,3,4,5].
 * @param {string} clndrData
 * @returns {number[]}
 */
function _parseClndrWorkWeek(clndrData) {
  if (!clndrData) return [1, 2, 3, 4, 5];
  try {
    // P6 usa: <DaysOfWeek>...</DaysOfWeek> con <d t="WK_Sun" w="1"/> etc.
    // w="1" = trabajable, w="0" = no trabajable
    const dayMap = { WK_Sun: 0, WK_Mon: 1, WK_Tue: 2, WK_Wed: 3, WK_Thu: 4, WK_Fri: 5, WK_Sat: 6 };
    const work = [];
    const rx = /<d[^>]+t="([^"]+)"[^>]+w="([^"]+)"/g;
    let m;
    while ((m = rx.exec(clndrData)) !== null) {
      const [, t, w] = m;
      if (w === '1' && dayMap[t] != null) work.push(dayMap[t]);
    }
    return work.length ? work.sort((a, b) => a - b) : [1, 2, 3, 4, 5];
  } catch {
    return [1, 2, 3, 4, 5];
  }
}

/**
 * Extrae excepciones de calendario del XML clndrData de P6.
 * P6 usa <Exceptions><e d="2024-06-17" t="0"/> </Exceptions>
 * t=0 → día no laborable, t=1 → día laborable (anulación)
 * @param {string} clndrData
 * @returns {{ on_date: string, is_working: boolean }[]}
 */
function _parseClndrExceptions(clndrData) {
  if (!clndrData) return [];
  const exceptions = [];
  try {
    const rx = /<e[^>]+d="([^"]+)"[^>]+t="([^"]+)"/g;
    let m;
    while ((m = rx.exec(clndrData)) !== null) {
      const [, d, t] = m;
      const dateStr = d.slice(0, 10);
      exceptions.push({ on_date: dateStr, is_working: t !== '0' });
    }
  } catch { /* ignorar */ }
  return exceptions;
}

// ============================================================
// Parseador principal
// ============================================================

/**
 * Parsea un string XER de Primavera P6 y retorna los datos
 * convertidos al schema interno de ECM Project.
 *
 * @param {string} xerText  Contenido completo del archivo .xer
 * @param {string} [projectId]  UUID del proyecto destino (genera uno si no se pasa)
 * @returns {{
 *   project:  object,
 *   tasks:    object[],
 *   deps:     object[],
 *   calendar: object|null,
 *   calExceptions: object[],
 *   warnings: string[],
 * }}
 */
export function parseXer(xerText, projectId = crypto.randomUUID()) {
  const warnings = [];
  const now = new Date().toISOString();

  // ---- 1. Parsear tablas crudas ----
  const tables = _parseXerTables(xerText);

  // ---- 2. Proyecto ----
  const projRows = tables.get('PROJECT') ?? [];
  // Tomar el primer proyecto si hay varios
  const projRow  = projRows[0] ?? {};
  const project = {
    id:           projectId,
    name:         projRow.proj_short_name || projRow.proj_id || 'Proyecto importado',
    start_date:   (projRow.target_start_dt || projRow.plan_start_dt || '').slice(0, 10) || null,
    finish_date:  (projRow.scd_end_dt     || projRow.plan_end_dt   || '').slice(0, 10) || null,
    data_date:    (projRow.last_recalc_date || '').slice(0, 10) || null,
    org_id:       null,
    deleted_at:   null,
    created_at:   now,
    updated_at:   now,
  };

  // ---- 3. Calendario ----
  const clndrRows = (tables.get('CLNDR') ?? tables.get('CALENDARS') ?? []);
  // Preferir el primer calendario del proyecto si hay proj_id
  const projCalId   = projRow.clndr_id ?? null;
  const clndrRow    = (projCalId && clndrRows.find(r => r.clndr_id === projCalId))
                      ?? clndrRows[0]
                      ?? null;

  let calendar     = null;
  let calExceptions = [];

  if (clndrRow) {
    const workWeek = _parseClndrWorkWeek(clndrRow.clndr_data ?? '');
    const hoursPerDay = parseFloat(clndrRow.day_hr_cnt || '8') || 8;
    calExceptions = _parseClndrExceptions(clndrRow.clndr_data ?? '').map(e => ({
      id:          crypto.randomUUID(),
      calendar_id: projectId, // se fijará al insertar en IDB
      on_date:     e.on_date,
      is_working:  e.is_working,
      deleted_at:  null,
    }));
    calendar = {
      id:            projectId,
      name:          clndrRow.clndr_name || 'Calendario importado',
      work_week:     workWeek,
      hours_per_day: hoursPerDay,
      deleted_at:    null,
      created_at:    now,
      updated_at:    now,
    };
  } else {
    warnings.push('No se encontró calendario en el XER; se usará lunes–viernes por defecto.');
  }

  const hoursPerDay = calendar ? (calendar.hours_per_day ?? 8) : 8;

  // ---- 4. WBS ----
  // Construir árbol WBS: wbs_id → { wbs_name, parent_wbs_id, children[] }
  const wbsRows  = tables.get('WBS') ?? [];
  // En P6 la raíz WBS tiene parent_wbs_id vacío o igual a proj_id
  const wbsById  = /** @type {Map<string, Record<string,string>>} */ (new Map());
  for (const r of wbsRows) wbsById.set(r.wbs_id, r);

  // Mapa wbs_id → UUID de tarea resumen que representará ese nodo
  const wbsToTaskId = /** @type {Map<string, string>} */ (new Map());

  // ---- 5. Tareas ----
  const taskRows = tables.get('TASK') ?? [];
  if (taskRows.length === 0) {
    warnings.push('No se encontraron actividades (tabla TASK vacía).');
  }

  // Mapa xer task_id → UUID generado
  const xerToUuid = /** @type {Map<string, string>} */ (new Map());
  for (const r of taskRows) xerToUuid.set(r.task_id, crypto.randomUUID());

  // También los nodos WBS que no tienen una tarea TT_WBS explícita
  // necesitan un UUID de summary. Los TT_WBS sí aparecen en TASK.
  for (const r of taskRows) {
    if (r.task_type === 'TT_WBS') {
      wbsToTaskId.set(r.wbs_id, xerToUuid.get(r.task_id));
    }
  }

  // Para nodos WBS que no tienen tarea TT_WBS propia,
  // crear tareas summary sintéticas
  const syntheticTasks = [];
  for (const [wbsId, wbsRow] of wbsById) {
    if (!wbsToTaskId.has(wbsId)) {
      const uid = crypto.randomUUID();
      wbsToTaskId.set(wbsId, uid);
      syntheticTasks.push({
        _xerWbsId:     wbsId,
        _synthetic:    true,
        id:            uid,
        project_id:    projectId,
        name:          wbsRow.wbs_name || wbsRow.wbs_short_name || wbsId,
        type:          'summary',
        duration_days: 0,
        start_date:    null,
        finish_date:   null,
        pct_complete:  0,
        parent_id:     null,
        wbs_code:      null,
        constraint_type:  null,
        constraint_date:  null,
        planned_cost:  0,
        deleted_at:    null,
        created_at:    now,
        updated_at:    now,
      });
    }
  }

  // Convertir filas TASK → schema interno
  const taskObjs = taskRows.map(r => {
    const uid   = xerToUuid.get(r.task_id);
    const durHr = parseFloat(r.target_drtn_hr_cnt || '0') || 0;

    // Tipo de tarea
    let type = 'task';
    if (r.task_type === 'TT_Mile') type = 'milestone';
    else if (r.task_type === 'TT_WBS' || r.task_type === 'TT_LOE') type = 'summary';

    return {
      id:            uid,
      project_id:    projectId,
      name:          r.task_name || r.task_code || r.task_id,
      type,
      duration_days: Math.max(0, Math.round(durHr / hoursPerDay)),
      start_date:    (r.act_start_dt || r.target_start_dt || '').slice(0, 10) || null,
      finish_date:   (r.act_end_dt   || r.target_end_dt   || '').slice(0, 10) || null,
      pct_complete:  parseFloat(r.phys_complete_pct || '0') || 0,
      parent_id:     null, // se rellena en el paso de jerarquía
      wbs_code:      null,
      constraint_type:  null,
      constraint_date:  null,
      planned_cost:  0,
      deleted_at:    null,
      created_at:    now,
      updated_at:    now,
      // metadatos para resolver jerarquía
      _xerWbsId:     r.wbs_id,
      _taskType:     r.task_type,
    };
  });

  // ---- 6. Resolver parent_id desde jerarquía WBS ----
  // Un task pertenece a un wbs_id. Si ese wbs tiene un task summary,
  // ese summary es el padre. El summary a su vez tiene parent = el summary de parent_wbs_id.

  const allTasks = [...syntheticTasks, ...taskObjs];
  const taskById = /** @type {Map<string, object>} */ (new Map(allTasks.map(t => [t.id, t])));

  for (const t of allTasks) {
    const wbsId = t._xerWbsId;
    if (!wbsId) continue;
    const wbsRow = wbsById.get(wbsId);
    if (!wbsRow) continue;

    if (t.type === 'summary' && wbsToTaskId.get(wbsId) === t.id) {
      // Nodo summary: su padre es el summary del wbs padre
      const parentWbsId = wbsRow.parent_wbs_id;
      if (parentWbsId && wbsToTaskId.has(parentWbsId)) {
        const parentSummaryId = wbsToTaskId.get(parentWbsId);
        if (parentSummaryId !== t.id) {
          t.parent_id = parentSummaryId;
        }
      }
    } else {
      // Tarea normal o hito: su padre es el summary del wbs al que pertenece
      const summaryId = wbsToTaskId.get(wbsId);
      if (summaryId && summaryId !== t.id) {
        t.parent_id = summaryId;
      }
    }
  }

  // Limpiar metadatos internos
  for (const t of allTasks) {
    delete t._xerWbsId;
    delete t._taskType;
    delete t._synthetic;
  }

  // ---- 7. Dependencias (TASKPRED) ----
  const predRows = tables.get('TASKPRED') ?? [];
  const depTypeMap = { PR_FS: 'FS', PR_SS: 'SS', PR_FF: 'FF', PR_SF: 'SF' };

  const deps = [];
  for (const r of predRows) {
    const sucId  = xerToUuid.get(r.task_id);
    const predId = xerToUuid.get(r.pred_task_id);
    if (!sucId || !predId) {
      if (r.task_id) warnings.push(`Tarea no encontrada: ${r.task_id} o ${r.pred_task_id}`);
      continue;
    }
    const lagHr  = parseFloat(r.lag_hr_cnt || '0') || 0;
    deps.push({
      id:          crypto.randomUUID(),
      project_id:  projectId,
      pred_id:     predId,
      succ_id:     sucId,
      type:        depTypeMap[r.pred_type] ?? 'FS',
      lag_days:    Math.round(lagHr / hoursPerDay),
      deleted_at:  null,
    });
  }

  // ---- 8. Porcentaje de avance desde act_drtn si phys_complete_pct está vacío ----
  for (const t of taskObjs) {
    const r = taskRows.find(row => xerToUuid.get(row.task_id) === t.id);
    if (!r) continue;
    const pct = parseFloat(r.phys_complete_pct || '');
    if (!isNaN(pct)) {
      t.pct_complete = Math.min(100, Math.max(0, pct));
    }
  }

  if (deps.length === 0 && predRows.length > 0) {
    warnings.push('No se pudieron mapear dependencias: verifique que las tablas TASK y TASKPRED coincidan.');
  }

  return {
    project,
    tasks:         allTasks,
    deps,
    calendar,
    calExceptions,
    warnings,
  };
}

// ============================================================
// Lector de archivo (browser File API)
// ============================================================

/**
 * Lee un File y retorna el resultado de parseXer.
 * @param {File} file
 * @param {string} [projectId]
 * @returns {Promise<ReturnType<typeof parseXer>>}
 */
export async function readXerFile(file, projectId) {
  const text = await file.text();
  return parseXer(text, projectId);
}
