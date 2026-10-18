// @ts-check
/** Internacionalización — Español (Perú) */

const ES_PE = {
  appName: 'Cronogramas',
  localMode: 'Modo local',
  synced: 'Sincronizado',
  syncing: 'Sincronizando…',
  offline: 'Sin conexión',
  conflict: 'Conflicto',

  // Toolbar
  addTask: 'Agregar tarea',
  addMilestone: 'Agregar hito',
  indent: 'Indentar',
  outdent: 'Desindentar',
  undo: 'Deshacer',
  redo: 'Rehacer',
  addDep: 'Agregar dependencia',
  datDate: 'Fecha de corte',
  autoCalc: 'Cálculo automático',
  manualCalc: 'Cálculo manual',

  // Columnas WBS
  col_wbs:      'EDT',
  col_name:     'Nombre',
  col_type:     'Tipo',
  col_dur:      'Duración',
  col_start:    'Inicio',
  col_finish:   'Fin',
  col_pct:      '% Avance',
  col_tf:       'HT',
  col_ff:       'HL',
  col_constraint: 'Restricción',
  col_pred:     'Predecesoras',
  col_cost:     'Costo Plan.',
  col_alerts:   'Alertas',
  col_actions:  '',

  // Tipos de tarea
  taskType_task:      'Tarea',
  taskType_milestone: 'Hito',
  taskType_summary:   'Resumen',

  // Tipos de dependencia
  dep_FS: 'FC', dep_SS: 'CC', dep_FF: 'FF', dep_SF: 'CF',

  // Restricciones
  constraint_ASAP: 'Lo antes posible',
  constraint_ALAP: 'Lo más tarde posible',
  constraint_SNET: 'No iniciar antes de',
  constraint_SNLT: 'No iniciar después de',
  constraint_FNET: 'No finalizar antes de',
  constraint_FNLT: 'No finalizar después de',
  constraint_MSO:  'Debe iniciar el',
  constraint_MFO:  'Debe finalizar el',

  // Alertas CPM
  warn_INICIO_RECORTADO:   'Inicio recortado a día 0',
  warn_FUERA_DE_SECUENCIA: 'Fuera de secuencia — lógica retenida',
  warn_CICLO:              'Dependencia crea un ciclo lógico',
  warn_RESTRICCION:        'Restricción conflictiva',
  warn_LAG_HIGH:           'Retraso excesivo (>10 d)',
  warn_LEAD:               'Adelanto detectado',
  warn_HARD_CONSTRAINT:    'Restricción rígida — minimice su uso',
  warn_NO_PRED:            'Sin predecesora (no es inicio del proyecto)',
  warn_NO_SUCC:            'Sin sucesora (no es fin del proyecto)',

  // Días
  daysUnit: 'd',
  hoursUnit: 'h',

  // Mensajes
  confirmDelete: '¿Eliminar esta tarea? Los datos se pueden recuperar con Deshacer.',
  cyclicDep: (chain) => `La dependencia crea un ciclo: ${chain}`,
  summaryHasDep: 'La tarea resumen no puede tener dependencias; muévalas a sus subtareas.',
  milestoneHasChildren: 'Un hito no puede tener subtareas.',
  projectNotFound: 'Proyecto no encontrado.',
  loadingProject: 'Cargando proyecto…',
  noProjects: 'Sin proyectos. Cree uno para comenzar.',
  demoLabel: '[DEMO]',
  saved: 'Guardado',
  undone: 'Deshacer completado',
  redone: 'Rehacer completado',
  noMoreUndo: 'Sin más acciones para deshacer',
  noMoreRedo: 'Sin más acciones para rehacer',
  outboxWarning: 'Se alcanzó el límite del outbox (10 000 ops). Sincronice antes de continuar.',
};

/**
 * @param {string} key
 * @param {...any} args
 * @returns {string}
 */
export function t(key, ...args) {
  const val = ES_PE[key];
  if (typeof val === 'function') return val(...args);
  return val ?? key;
}

export default ES_PE;
