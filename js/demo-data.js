// @ts-check
/**
 * demo-data.js — Datos de demostración para modo local.
 * Portafolio DEMO claramente rotulado. Datos ficticios.
 * Proyecto: Edificio Residencial "Las Palmas" (≈ 40 tareas, 4 niveles EDT).
 */

const ORG_ID    = '00000000-0000-0000-0000-000000000001';
const PROJ_ID   = '00000000-0000-0000-0000-000000000010';
const CAL_ID    = '00000000-0000-0000-0000-000000000020';

const T  = (n) => `task-demo-${String(n).padStart(3,'0')}`;
const D  = (n) => `dep-demo-${String(n).padStart(3,'0')}`;
const R  = (n) => `res-demo-${String(n).padStart(3,'0')}`;
const TR = (n) => `taskres-demo-${String(n).padStart(3,'0')}`;

/** @type {any} */
export const DEMO_DATA = {
  project: {
    id: PROJ_ID,
    org_id: ORG_ID,
    program_id: null,
    code: 'PRJ-2026-DEMO',
    name: '[DEMO] Edificio Residencial Las Palmas',
    sponsor_id: null,
    start_date: '2026-01-05',
    actual_start_date: null,
    actual_finish_date: null,
    data_date: null,
    calendar_id: CAL_ID,
    budget: 5000000.00,
    currency: 'PEN',
    is_template: false,
    settings: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  },

  calendar: {
    id: CAL_ID,
    org_id: ORG_ID,
    project_id: PROJ_ID,
    name: 'Calendario Estándar (Lun–Vie)',
    work_week: [1, 2, 3, 4, 5],
    hours_per_day: 8,
    shift_label: 'Diurno',
    shift_start: '07:00',
    shift_end: '17:00',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  },

  calExceptions: [
    // Feriados nacionales Perú 2026 (verificados con PCM/El Peruano)
    { id: 'calex-001', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-01-01', is_working: false, name: 'Año Nuevo', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-002', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-04-02', is_working: false, name: 'Jueves Santo', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-003', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-04-03', is_working: false, name: 'Viernes Santo', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-004', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-05-01', is_working: false, name: 'Día del Trabajo', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-005', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-06-29', is_working: false, name: 'San Pedro y San Pablo', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-006', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-07-28', is_working: false, name: 'Fiestas Patrias', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-007', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-07-29', is_working: false, name: 'Fiestas Patrias', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-008', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-08-30', is_working: false, name: 'Santa Rosa de Lima', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-009', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-10-08', is_working: false, name: 'Combate de Angamos', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-010', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-11-01', is_working: false, name: 'Todos los Santos', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-011', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-12-08', is_working: false, name: 'Inmaculada Concepción', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
    { id: 'calex-012', org_id: ORG_ID, calendar_id: CAL_ID, on_date: '2026-12-25', is_working: false, name: 'Navidad', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null },
  ],

  tasks: [
    // ========== NIVEL 1: Fases ==========
    _task(T(1),  null,        1,  'FASE 1 — Trabajos Preliminares', 'task', 0,   0, 0),
    _task(T(10), null,        2,  'FASE 2 — Cimentación',           'task', 0,   0, 0),
    _task(T(20), null,        3,  'FASE 3 — Estructura',            'task', 0,   0, 0),
    _task(T(30), null,        4,  'FASE 4 — Albañilería',           'task', 0,   0, 0),
    _task(T(40), null,        5,  'FASE 5 — Instalaciones',         'task', 0,   0, 0),
    _task(T(50), null,        6,  'FASE 6 — Acabados y Cierre',     'task', 0,   0, 0),

    // ========== FASE 1 ==========
    _task(T(2),  T(1),        1,  'Movilización y limpieza de terreno', 'task', 5,  0,  100, '2026-01-05', '2026-01-09'),
    _task(T(3),  T(1),        2,  'Replanteo topográfico',              'task', 3,  0,  100, '2026-01-12', '2026-01-14'),
    _task(T(4),  T(1),        3,  'Permisos y licencias',               'milestone', 0, 0, 100, '2026-01-14', '2026-01-14'),
    _task(T(5),  T(1),        4,  'Instalación de servicios provisionales', 'task', 4, 0, 60, '2026-01-15'),

    // ========== FASE 2 ==========
    _task(T(11), T(10),       1,  'Excavación masiva',              'task', 8,  0,  40, '2026-01-15'),
    _task(T(12), T(10),       2,  'Excavación de zanjas',           'task', 5,  0,  0),
    _task(T(13), T(10),       3,  'Habilitación de acero de cimientos', 'task', 6, 0, 0),
    _task(T(14), T(10),       4,  'Encofrado de cimientos',         'task', 4,  0,  0),
    _task(T(15), T(10),       5,  'Vaciado de concreto fc=210',     'task', 3,  0,  0),
    _task(T(16), T(10),       6,  'Curado',                         'task', 7,  0,  0),
    _task(T(17), T(10),       7,  'Cimentación completada',         'milestone', 0, 0, 0),

    // ========== FASE 3 ==========
    _task(T(21), T(20),       1,  'Encofrado de columnas P1',       'task', 5,  0,  0),
    _task(T(22), T(20),       2,  'Habilitación de acero columnas', 'task', 4,  0,  0),
    _task(T(23), T(20),       3,  'Vaciado de columnas P1',         'task', 2,  0,  0),
    _task(T(24), T(20),       4,  'Encofrado de vigas y losa P1',   'task', 6,  0,  0),
    _task(T(25), T(20),       5,  'Vaciado de losa aligerada P1',   'task', 3,  0,  0),
    _task(T(26), T(20),       6,  'Estructura P1 completada',       'milestone', 0, 0, 0),
    _task(T(27), T(20),       7,  'Encofrado columnas P2',          'task', 5,  0,  0),
    _task(T(28), T(20),       8,  'Vaciado columnas P2',            'task', 2,  0,  0),
    _task(T(29), T(20),       9,  'Vaciado de losa P2',             'task', 3,  0,  0),

    // ========== FASE 4 ==========
    _task(T(31), T(30),       1,  'Asentado de ladrillo P1',        'task', 10, 0,  0),
    _task(T(32), T(30),       2,  'Tarrajeo interior P1',           'task', 8,  0,  0),
    _task(T(33), T(30),       3,  'Asentado de ladrillo P2',        'task', 10, 0,  0),
    _task(T(34), T(30),       4,  'Tarrajeo interior P2',           'task', 8,  0,  0),

    // ========== FASE 5 ==========
    _task(T(41), T(40),       1,  'Instalaciones sanitarias P1',    'task', 8,  0,  0),
    _task(T(42), T(40),       2,  'Instalaciones eléctricas P1',    'task', 8,  0,  0),
    _task(T(43), T(40),       3,  'Instalaciones sanitarias P2',    'task', 8,  0,  0),
    _task(T(44), T(40),       4,  'Instalaciones eléctricas P2',    'task', 8,  0,  0),

    // ========== FASE 6 ==========
    _task(T(51), T(50),       1,  'Pisos y pavimentos',             'task', 10, 0,  0),
    _task(T(52), T(50),       2,  'Pintado general',                'task', 8,  0,  0),
    _task(T(53), T(50),       3,  'Carpintería y aluminio',         'task', 6,  0,  0),
    _task(T(54), T(50),       4,  'Limpieza final',                 'task', 3,  0,  0),
    _task(T(55), T(50),       5,  'Entrega de obra',                'milestone', 0, 0, 0),
  ],

  deps: [
    // Fase 1 interna
    _dep(D(1),  T(2),  T(3),  'FS', 0),
    _dep(D(2),  T(3),  T(4),  'FS', 0),
    _dep(D(3),  T(3),  T(5),  'FS', 0),

    // Fase 1 → Fase 2
    _dep(D(10), T(5),  T(11), 'FS', 0),
    _dep(D(11), T(5),  T(12), 'FS', 2),  // lag 2

    // Fase 2 interna
    _dep(D(12), T(11), T(13), 'SS', 3),  // SS lag 3: acero puede empezar 3d después del inicio de excavación
    _dep(D(13), T(12), T(14), 'FS', 0),
    _dep(D(14), T(13), T(14), 'FS', 0),
    _dep(D(15), T(14), T(15), 'FS', 0),
    _dep(D(16), T(15), T(16), 'FS', 0),
    _dep(D(17), T(16), T(17), 'FS', 0),
    _dep(D(18), T(11), T(17), 'FF', 0),  // FF: excavación debe terminar cuando se cierra cimentación

    // Fase 2 → Fase 3
    _dep(D(20), T(17), T(21), 'FS', 0),
    _dep(D(21), T(17), T(22), 'FS', 0),

    // Fase 3 interna
    _dep(D(22), T(22), T(21), 'SS', 0),
    _dep(D(23), T(21), T(23), 'FS', 0),
    _dep(D(24), T(22), T(23), 'FS', 0),
    _dep(D(25), T(23), T(24), 'FS', 2),
    _dep(D(26), T(24), T(25), 'FS', 0),
    _dep(D(27), T(25), T(26), 'FS', 0),
    _dep(D(28), T(26), T(27), 'FS', 0),
    _dep(D(29), T(27), T(28), 'FS', 0),
    _dep(D(30), T(28), T(29), 'FS', 2),

    // Fase 3 → Fase 4 y 5 (paralelas)
    _dep(D(31), T(25), T(31), 'SS', 5),  // albañilería puede empezar SS+5 con losa
    _dep(D(32), T(25), T(41), 'SS', 3),
    _dep(D(33), T(25), T(42), 'SS', 3),
    _dep(D(34), T(29), T(33), 'SS', 5),
    _dep(D(35), T(29), T(43), 'SS', 3),
    _dep(D(36), T(29), T(44), 'SS', 3),

    // Fase 4 interna
    _dep(D(37), T(31), T(32), 'FS', 0),
    _dep(D(38), T(33), T(34), 'FS', 0),

    // Fase 4+5 → Fase 6
    _dep(D(40), T(32), T(51), 'FS', 0),
    _dep(D(41), T(34), T(51), 'FS', 0),
    _dep(D(42), T(41), T(51), 'FS', 0),
    _dep(D(43), T(42), T(51), 'FS', 0),
    _dep(D(44), T(43), T(51), 'FS', 0),
    _dep(D(45), T(44), T(51), 'FS', 0),

    // Fase 6 interna
    _dep(D(46), T(51), T(52), 'SS', 3),
    _dep(D(47), T(51), T(53), 'SS', 5),
    _dep(D(48), T(52), T(54), 'FS', 0),
    _dep(D(49), T(53), T(54), 'FS', 0),
    _dep(D(50), T(54), T(55), 'FS', 0),
  ],

  resources: [
    _res(R(1), 'Maestro de Obra',          'work', 100, 45.00),
    _res(R(2), 'Oficial',                  'work', 100, 28.00),
    _res(R(3), 'Peón',                     'work', 100, 18.00),
    _res(R(4), 'Operador de Maquinaria',   'work', 100, 55.00),
  ],

  task_resources: [
    // ── FASE 1: Trabajos Preliminares ──
    _tr(TR(1),  T(2),  R(1), 100),  // Maestro → Movilización
    _tr(TR(2),  T(2),  R(3), 100),  // Peón    → Movilización
    _tr(TR(3),  T(3),  R(1), 50),   // Maestro → Replanteo
    _tr(TR(4),  T(5),  R(1), 100),  // Maestro → Instalación servicios
    _tr(TR(5),  T(5),  R(2), 100),  // Oficial → Instalación servicios
    _tr(TR(6),  T(5),  R(3), 100),  // Peón    → Instalación servicios

    // ── FASE 2: Cimentación ──
    _tr(TR(7),  T(11), R(1), 100),  // Maestro → Excavación masiva
    _tr(TR(8),  T(11), R(3), 100),  // Peón    → Excavación masiva
    _tr(TR(9),  T(11), R(4), 100),  // Operador → Excavación masiva
    _tr(TR(10), T(12), R(1), 100),  // Maestro → Excavación zanjas
    _tr(TR(11), T(12), R(3), 100),  // Peón    → Excavación zanjas
    _tr(TR(12), T(12), R(4), 100),  // Operador → Excavación zanjas
    _tr(TR(13), T(13), R(1), 100),  // Maestro → Hab. acero cimientos
    _tr(TR(14), T(13), R(2), 100),  // Oficial → Hab. acero cimientos
    _tr(TR(15), T(13), R(3), 100),  // Peón    → Hab. acero cimientos
    _tr(TR(16), T(14), R(1), 100),  // Maestro → Encofrado cimientos
    _tr(TR(17), T(14), R(2), 100),  // Oficial → Encofrado cimientos
    _tr(TR(18), T(15), R(1), 100),  // Maestro → Vaciado concreto
    _tr(TR(19), T(15), R(2), 100),  // Oficial → Vaciado concreto
    _tr(TR(20), T(15), R(3), 100),  // Peón    → Vaciado concreto

    // ── FASE 3: Estructura ──
    _tr(TR(21), T(21), R(1), 100),  // Maestro → Encofrado columnas P1
    _tr(TR(22), T(21), R(2), 100),  // Oficial → Encofrado columnas P1
    _tr(TR(23), T(22), R(1), 100),  // Maestro → Hab. acero columnas
    _tr(TR(24), T(22), R(2), 100),  // Oficial → Hab. acero columnas
    _tr(TR(25), T(22), R(3), 100),  // Peón    → Hab. acero columnas
    _tr(TR(26), T(23), R(1), 100),  // Maestro → Vaciado columnas P1
    _tr(TR(27), T(23), R(2), 100),  // Oficial → Vaciado columnas P1
    _tr(TR(28), T(24), R(1), 100),  // Maestro → Encofrado vigas losa P1
    _tr(TR(29), T(24), R(2), 100),  // Oficial → Encofrado vigas losa P1
    _tr(TR(30), T(24), R(3), 100),  // Peón    → Encofrado vigas losa P1
    _tr(TR(31), T(25), R(1), 100),  // Maestro → Vaciado losa P1
    _tr(TR(32), T(25), R(2), 100),  // Oficial → Vaciado losa P1
    _tr(TR(33), T(27), R(1), 100),  // Maestro → Encofrado columnas P2
    _tr(TR(34), T(27), R(2), 100),  // Oficial → Encofrado columnas P2
    _tr(TR(35), T(28), R(1), 100),  // Maestro → Vaciado columnas P2
    _tr(TR(36), T(28), R(2), 100),  // Oficial → Vaciado columnas P2
    _tr(TR(37), T(29), R(1), 100),  // Maestro → Vaciado losa P2
    _tr(TR(38), T(29), R(2), 100),  // Oficial → Vaciado losa P2

    // ── FASE 4+5: Albañilería + Instalaciones (paralelas) ──
    _tr(TR(39), T(31), R(1), 100),  // Maestro → Ladrillo P1
    _tr(TR(40), T(31), R(3), 100),  // Peón    → Ladrillo P1
    _tr(TR(41), T(32), R(1), 100),  // Maestro → Tarrajeo P1
    _tr(TR(42), T(32), R(2), 100),  // Oficial → Tarrajeo P1
    _tr(TR(43), T(33), R(1), 100),  // Maestro → Ladrillo P2
    _tr(TR(44), T(33), R(3), 100),  // Peón    → Ladrillo P2
    _tr(TR(45), T(34), R(1), 100),  // Maestro → Tarrajeo P2
    _tr(TR(46), T(34), R(2), 100),  // Oficial → Tarrajeo P2
    _tr(TR(47), T(41), R(2), 100),  // Oficial → Instalaciones sanitarias P1
    _tr(TR(48), T(42), R(2), 100),  // Oficial → Instalaciones eléctricas P1
    _tr(TR(49), T(43), R(2), 100),  // Oficial → Instalaciones sanitarias P2
    _tr(TR(50), T(44), R(2), 100),  // Oficial → Instalaciones eléctricas P2
    _tr(TR(51), T(41), R(3), 100),  // Peón    → Instalaciones sanitarias P1
    _tr(TR(52), T(43), R(3), 100),  // Peón    → Instalaciones sanitarias P2

    // ── FASE 6: Acabados ──
    _tr(TR(53), T(51), R(1), 100),  // Maestro → Pisos y pavimentos
    _tr(TR(54), T(51), R(2), 100),  // Oficial → Pisos y pavimentos
    _tr(TR(55), T(51), R(3), 100),  // Peón    → Pisos y pavimentos
    _tr(TR(56), T(52), R(1), 100),  // Maestro → Pintado general
    _tr(TR(57), T(52), R(2), 100),  // Oficial → Pintado general
    _tr(TR(58), T(53), R(1), 100),  // Maestro → Carpintería y aluminio
    _tr(TR(59), T(53), R(2), 100),  // Oficial → Carpintería y aluminio
    _tr(TR(60), T(54), R(1), 100),  // Maestro → Limpieza final
    _tr(TR(61), T(54), R(3), 100),  // Peón    → Limpieza final
  ],
};

// ---- Helpers para construir tareas ----

function _task(id, parent_id, sort_order, name, type, duration_days, work_hours = 0, percent_complete = 0, actual_start = null, actual_finish = null) {
  return {
    id, org_id: ORG_ID, project_id: PROJ_ID,
    parent_id: parent_id ?? null,
    sort_order,
    name, type,
    duration_days: type === 'milestone' ? 0 : duration_days,
    work_hours,
    percent_complete,
    actual_start:  actual_start  ?? null,
    actual_finish: actual_finish ?? null,
    constraint_type: 'ASAP',
    constraint_date: null,
    planned_cost: duration_days * 1500,
    actual_cost:  0,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  };
}

function _dep(id, pred_id, succ_id, type, lag_days) {
  return {
    id, org_id: ORG_ID, project_id: PROJ_ID,
    pred_id, succ_id, type, lag_days,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  };
}

function _res(id, name, type, max_units, rate_per_hour) {
  return {
    id, org_id: ORG_ID, project_id: PROJ_ID,
    name, type, max_units, rate_per_hour,
    unit_label: null, role: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  };
}

function _tr(id, task_id, resource_id, units) {
  return {
    id, org_id: ORG_ID, project_id: PROJ_ID,
    task_id, resource_id, units,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    deleted_at: null,
  };
}
