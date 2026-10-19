// @ts-check
/**
 * cpm.worker.js — Web Worker para el motor CPM.
 * Recibe: { tasks, deps, calendarDef, projectStartISO, dataDateISO, nearThreshold }
 * Devuelve: CpmResult serializado
 */

// Importar módulos usando rutas relativas al worker
// Los workers en módulos usan type:"module"
import { Calendar, isoToDate } from '../calendar.js';
import { computeCPM } from '../cpm.js';


self.onmessage = function (e) {
  try {
    const { tasks, deps, calendarDef, projectStartISO, dataDateISO, nearThreshold = 5 } = e.data;

    const calendar = new Calendar(calendarDef);
    const projectStart = isoToDate(projectStartISO);

    let dataDateIdx = null;
    if (dataDateISO) {
      dataDateIdx = calendar.dateToIdx(isoToDate(dataDateISO), projectStart);
    }

    const result = computeCPM(tasks, deps, calendar, projectStart, dataDateIdx, nearThreshold);

    // Serializar (Maps no se transfieren directamente con postMessage)
    const serialized = {
      tasks: [...result.tasks.entries()].map(([id, v]) => ({ id, ...v })),
      warnings: result.warnings,
      projectDuration: result.projectDuration,
    };

    self.postMessage({ ok: true, result: serialized });
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
