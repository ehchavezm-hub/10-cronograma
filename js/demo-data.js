// @ts-check
/**
 * demo-data.js — Proyecto DEMO completo (datos ficticios, claramente rotulados).
 * Proyecto: Edificio Residencial "Las Palmas" (39 tareas, 6 fases).
 *
 * Las fechas son RELATIVAS al día en que se genera: el proyecto siempre está a
 * mitad de ejecución, para que los módulos que dependen de "hoy" (Lookahead,
 * Plan semanal, alertas, stand-up, valor ganado) tengan datos.
 *
 * Contiene datos para todos los módulos: cronograma con avance y fechas reales,
 * costos (EVM), dos líneas base, recursos (mano de obra, equipos y materiales),
 * dos calendarios con feriados, riesgos, diccionario WBS, estimaciones de tres
 * puntos (Monte Carlo), Last Planner (plan semanal, PPC, restricciones, stand-up),
 * portafolio/programa e historial de cambios de ejemplo.
 */

import { Calendar } from './calendar.js';
import { computeCPM } from './cpm.js';

/** Cambiar al modificar el contenido del DEMO: fuerza su regeneración. */
export const DEMO_VERSION = 5;

export const ORG_ID   = '00000000-0000-0000-0000-000000000001';
export const PROJ_ID  = '00000000-0000-0000-0000-000000000010';
export const CAL_ID   = '00000000-0000-0000-0000-000000000020';
export const CAL2_ID  = '00000000-0000-0000-0000-000000000021';
export const PORT_ID  = '00000000-0000-0000-0000-000000000030';
export const PROG_ID  = '00000000-0000-0000-0000-000000000031';

const T  = (n) => `task-demo-${String(n).padStart(3, '0')}`;
const D  = (n) => `dep-demo-${String(n).padStart(3, '0')}`;
const R  = (n) => `res-demo-${String(n).padStart(3, '0')}`;
const TR = (n) => `taskres-demo-${String(n).padStart(3, '0')}`;

// ── Utilidades de fecha (hora local) ─────────────────────────
const _pad = (n) => String(n).padStart(2, '0');
/** @param {Date} d */
const iso = (d) => `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
/** @param {Date} d @param {number} n */
const addDays = (d, n) => { const r = new Date(d.getFullYear(), d.getMonth(), d.getDate()); r.setDate(r.getDate() + n); return r; };
/** Lunes de la semana de d. @param {Date} d */
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

/** Clave ISO de semana 'YYYY-WNN' (igual que lookahead-detailed.js). @param {Date} date */
function weekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${_pad(weekNo)}`;
}

/** Domingo de Pascua (algoritmo de Meeus/Jones/Butcher). @param {number} y */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
}

/** Feriados nacionales del Perú para un año. @param {number} y */
function peruHolidays(y) {
  const e = easter(y);
  return [
    [new Date(y, 0, 1), 'Año Nuevo'],
    [addDays(e, -3), 'Jueves Santo'],
    [addDays(e, -2), 'Viernes Santo'],
    [new Date(y, 4, 1), 'Día del Trabajo'],
    [new Date(y, 5, 29), 'San Pedro y San Pablo'],
    [new Date(y, 6, 28), 'Fiestas Patrias'],
    [new Date(y, 6, 29), 'Fiestas Patrias'],
    [new Date(y, 7, 30), 'Santa Rosa de Lima'],
    [new Date(y, 9, 8), 'Combate de Angamos'],
    [new Date(y, 10, 1), 'Todos los Santos'],
    [new Date(y, 11, 8), 'Inmaculada Concepción'],
    [new Date(y, 11, 25), 'Navidad'],
  ];
}

// ── Definición del proyecto ──────────────────────────────────
// [n, padre, orden, nombre, tipo, duración plan, duración real (si difiere)]
const TASKS = [
  [60, null, 0, 'Inicio de Proyecto', 'milestone', 0],
  [1, null, 1, 'FASE 1 — Trabajos Preliminares', 'task', 0],
  [10, null, 2, 'FASE 2 — Cimentación', 'task', 0],
  [20, null, 3, 'FASE 3 — Estructura', 'task', 0],
  [30, null, 4, 'FASE 4 — Albañilería', 'task', 0],
  [40, null, 5, 'FASE 5 — Instalaciones', 'task', 0],
  [50, null, 6, 'FASE 6 — Acabados y Cierre', 'task', 0],
  [2, 1, 1, 'Movilización y limpieza de terreno', 'task', 5],
  [3, 1, 2, 'Replanteo topográfico', 'task', 3],
  [4, 1, 3, 'Permisos y licencias', 'milestone', 0],
  [5, 1, 4, 'Instalación de servicios provisionales', 'task', 4, 5],
  [11, 10, 1, 'Excavación masiva', 'task', 8, 10],
  [12, 10, 2, 'Excavación de zanjas', 'task', 5],
  [13, 10, 3, 'Habilitación de acero de cimientos', 'task', 6],
  [14, 10, 4, 'Encofrado de cimientos', 'task', 4],
  [15, 10, 5, 'Vaciado de concreto fc=210', 'task', 3, 4],
  [16, 10, 6, 'Curado', 'task', 7],
  [17, 10, 7, 'Cimentación completada', 'milestone', 0],
  [21, 20, 1, 'Encofrado de columnas P1', 'task', 5],
  [22, 20, 2, 'Habilitación de acero columnas', 'task', 4, 5],
  [23, 20, 3, 'Vaciado de columnas P1', 'task', 2],
  [24, 20, 4, 'Encofrado de vigas y losa P1', 'task', 6],
  [25, 20, 5, 'Vaciado de losa aligerada P1', 'task', 3],
  [26, 20, 6, 'Estructura P1 completada', 'milestone', 0],
  [27, 20, 7, 'Encofrado columnas P2', 'task', 5],
  [28, 20, 8, 'Vaciado columnas P2', 'task', 2],
  [29, 20, 9, 'Vaciado de losa P2', 'task', 3],
  [31, 30, 1, 'Asentado de ladrillo P1', 'task', 10],
  [32, 30, 2, 'Tarrajeo interior P1', 'task', 8],
  [33, 30, 3, 'Asentado de ladrillo P2', 'task', 10],
  [34, 30, 4, 'Tarrajeo interior P2', 'task', 8],
  [41, 40, 1, 'Instalaciones sanitarias P1', 'task', 8],
  [42, 40, 2, 'Instalaciones eléctricas P1', 'task', 8],
  [43, 40, 3, 'Instalaciones sanitarias P2', 'task', 8],
  [44, 40, 4, 'Instalaciones eléctricas P2', 'task', 8],
  [51, 50, 1, 'Pisos y pavimentos', 'task', 10],
  [52, 50, 2, 'Pintado general', 'task', 8],
  [53, 50, 3, 'Carpintería y aluminio', 'task', 6],
  [54, 50, 4, 'Limpieza final', 'task', 3],
  [55, 50, 5, 'Entrega de obra', 'milestone', 0],
  [56, 50, 6, 'Acta de Entrega Final', 'milestone', 0],
];

/** Ritmo de avance de las tareas en curso (1 = según plan, <1 = atrasada). */
const PACE = { 31: 0.75, 41: 0.6, 42: 1.0, 27: 0.85, 28: 0.7, 29: 0.8, 33: 0.7 };

// [n, pred, succ, tipo, desfase]
const DEPS = [
  // Inicio → Fase 1
  [1,  60,  2, 'FS', 0],  // Inicio de Proyecto → Movilización
  // Fase 1 — Trabajos Preliminares
  [2,   2,  3, 'FS', 0],  // Movilización → Replanteo topográfico
  [3,   3,  4, 'FS', 0],  // Replanteo → Permisos y licencias
  [4,   4,  5, 'FS', 0],  // Permisos → Servicios provisionales
  // Fase 1 → Fase 2
  [5,   5, 11, 'FS', 0],  // Servicios provisionales → Excavación masiva
  // Fase 2 — Cimentación
  [6,  11, 12, 'FS', 0],  // Exc masiva → Exc zanjas
  [7,  12, 13, 'FS', 0],  // Zanjas → Habilitación acero
  [8,  13, 14, 'FS', 0],  // Acero → Encofrado cimientos
  [9,  14, 15, 'FS', 0],  // Encofrado → Vaciado concreto
  [10, 15, 16, 'FS', 0],  // Vaciado → Curado
  [11, 16, 17, 'FS', 0],  // Curado → Cimentación completada
  // Fase 2 → Fase 3
  [12, 17, 21, 'FS', 0],  // Cimentación completada → Encofrado columnas P1
  // Fase 3 — Estructura P1
  [13, 21, 22, 'FS', 0],  // Encofrado columnas P1 → Habilitación acero columnas
  [14, 22, 23, 'FS', 0],  // Acero columnas → Vaciado columnas P1
  [15, 23, 24, 'FS', 2],  // Columnas P1 → Encofrado vigas/losa P1 (2d fragüe)
  [16, 24, 25, 'FS', 0],  // Encofrado vigas → Vaciado losa P1
  [17, 25, 26, 'FS', 0],  // Vaciado losa P1 → Estructura P1 completada
  // Estructura P2
  [18, 26, 27, 'FS', 0],  // Estructura P1 → Encofrado columnas P2
  [19, 27, 28, 'FS', 0],  // Encofrado P2 → Vaciado columnas P2
  [20, 28, 29, 'FS', 2],  // Columnas P2 → Vaciado losa P2 (2d fragüe)
  // Fase 3 → Fase 4 (Albañilería)
  [21, 25, 31, 'FS', 5],  // Losa P1 → Ladrillo P1 (5d lag curado losa)
  [22, 29, 33, 'FS', 5],  // Losa P2 → Ladrillo P2 (5d lag curado losa)
  // Fase 4 — Albañilería
  [23, 31, 32, 'FS', 0],  // Ladrillo P1 → Tarrajeo interior P1
  [24, 33, 34, 'FS', 0],  // Ladrillo P2 → Tarrajeo interior P2
  // Fase 3 → Fase 5 (Instalaciones)
  [25, 25, 41, 'FS', 3],  // Losa P1 → Instalaciones sanitarias P1 (3d lag)
  [26, 41, 42, 'FS', 0],  // Sanitarias P1 → Eléctricas P1
  [27, 29, 43, 'FS', 3],  // Losa P2 → Instalaciones sanitarias P2 (3d lag)
  [28, 43, 44, 'FS', 0],  // Sanitarias P2 → Eléctricas P2
  // Fase 4+5 → Fase 6 (Acabados y Cierre)
  [29, 32, 51, 'FS', 0],  // Tarrajeo P1 → Pisos y pavimentos
  [30, 34, 51, 'FS', 0],  // Tarrajeo P2 → Pisos y pavimentos
  [31, 42, 51, 'FS', 0],  // Eléctricas P1 → Pisos y pavimentos
  [32, 44, 51, 'FS', 0],  // Eléctricas P2 → Pisos y pavimentos
  // Fase 6 — Acabados
  [33, 51, 52, 'FS', 3],  // Pisos → Pintado general (3d lag)
  [34, 51, 53, 'FS', 5],  // Pisos → Carpintería y aluminio (5d lag)
  [35, 52, 54, 'FS', 0],  // Pintado → Limpieza final
  [36, 53, 54, 'FS', 0],  // Carpintería → Limpieza final
  [37, 54, 55, 'FS', 0],  // Limpieza → Entrega de obra
  [38, 55, 56, 'FS', 0],  // Entrega de obra → Acta de Entrega Final
];

// [n, nombre, tipo, máx. unidades, tarifa (S/ por hora o por unidad), unidad, rol]
const RESOURCES = [
  [1, 'Maestro de Obra', 'work', 200, 45.00, null, 'Supervisión de campo'],
  [2, 'Oficial', 'work', 600, 28.00, null, 'Operario calificado'],
  [3, 'Peón', 'work', 800, 18.00, null, 'Ayudante'],
  [4, 'Operador de Maquinaria', 'work', 100, 55.00, null, 'Equipo pesado'],
  [5, 'Ingeniero Residente', 'work', 100, 95.00, null, 'Dirección técnica'],
  [6, 'Topógrafo', 'work', 100, 60.00, null, 'Control topográfico'],
  [7, 'Electricista', 'work', 200, 35.00, null, 'Instalaciones eléctricas'],
  [8, 'Gasfitero', 'work', 200, 32.00, null, 'Instalaciones sanitarias'],
  [9, 'Excavadora 320', 'equipment', 1, 280.00, 'h-m', 'Movimiento de tierras'],
  [10, 'Mezcladora 9 p3', 'equipment', 2, 35.00, 'h-m', 'Concreto en obra'],
  [11, 'Concreto premezclado fc=210', 'material', 0, 420.00, 'm3', 'Material'],
  [12, 'Acero corrugado fy=4200', 'material', 0, 4.80, 'kg', 'Material'],
  [13, 'Ladrillo King Kong 18 h', 'material', 0, 1350.00, 'millar', 'Material'],
  [14, 'Cemento Portland tipo I', 'material', 0, 29.50, 'bolsa', 'Material'],
];

// [tarea, recurso, unidades]
const ASSIGN = [
  [2, 1, 100], [2, 3, 100], [3, 1, 50], [3, 6, 100], [5, 1, 100], [5, 2, 100], [5, 3, 100],
  [11, 1, 100], [11, 3, 100], [11, 4, 100], [11, 9, 1], [12, 1, 100], [12, 3, 100], [12, 4, 100], [12, 9, 1],
  [13, 1, 100], [13, 2, 100], [13, 3, 100], [13, 12, 4200], [14, 1, 100], [14, 2, 100],
  [15, 1, 100], [15, 2, 100], [15, 3, 100], [15, 11, 85], [15, 10, 1],
  [21, 1, 100], [21, 2, 100], [22, 1, 100], [22, 2, 100], [22, 3, 100], [22, 12, 3600],
  [23, 1, 100], [23, 2, 100], [23, 11, 18], [24, 1, 100], [24, 2, 100], [24, 3, 100],
  [25, 1, 100], [25, 2, 100], [25, 11, 42], [25, 12, 2900],
  [27, 1, 100], [27, 2, 100], [28, 1, 100], [28, 2, 100], [28, 11, 16], [29, 1, 100], [29, 2, 100], [29, 11, 40],
  [31, 1, 100], [31, 3, 100], [31, 13, 14], [31, 14, 120], [32, 1, 100], [32, 2, 100], [32, 14, 160],
  [33, 1, 100], [33, 3, 100], [33, 13, 14], [33, 14, 120], [34, 1, 100], [34, 2, 100], [34, 14, 160],
  [41, 2, 100], [41, 3, 100], [41, 8, 100], [42, 2, 100], [42, 7, 100], [43, 2, 100], [43, 3, 100], [43, 8, 100], [44, 2, 100], [44, 7, 100],
  [51, 1, 100], [51, 2, 100], [51, 3, 100], [52, 1, 100], [52, 2, 100], [53, 1, 100], [53, 2, 100], [54, 1, 100], [54, 3, 100],
  [2, 5, 25], [11, 5, 25], [15, 5, 50], [25, 5, 50], [29, 5, 50],
];

/** Costo de subcontratos y otros gastos directos por tarea (S/), además de mano de obra y materiales. */
const OTHER_COST = {
  2: 18000, 3: 6500, 5: 42000, 11: 165000, 12: 38000, 13: 9000, 14: 52000, 15: 21000, 16: 6000,
  21: 48000, 22: 8000, 23: 15000, 24: 96000, 25: 38000, 27: 46000, 28: 14000, 29: 36000,
  31: 72000, 32: 64000, 33: 72000, 34: 64000, 41: 118000, 42: 132000, 43: 118000, 44: 132000,
  51: 265000, 52: 148000, 53: 236000, 54: 22000,
};

/** Desviación de costo de lo ejecutado (1 = según presupuesto). */
const COST_FACTOR = { 11: 1.12, 15: 1.08, 22: 1.06, 5: 1.05, 31: 1.04, 41: 1.07 };

/** Diccionario WBS: [alcance, descripción, criterio de aceptación, responsable]. */
const WBS = {
  2: ['Limpieza y desbroce del terreno de 1,200 m²; instalación de cerco perimétrico.', 'Movilización de equipos, herramientas y personal; retiro de maleza y desmonte.', 'Terreno libre de obstáculos y cerco instalado según plano de obras provisionales.', 'Ing. Residente'],
  3: ['Trazo de ejes, niveles y BM del proyecto.', 'Replanteo con estación total a partir de los hitos del plano topográfico.', 'Acta de replanteo firmada por la supervisión; tolerancia ±5 mm.', 'Topógrafo'],
  4: ['Licencia de edificación y permisos municipales.', 'Obtención de la licencia de obra y autorizaciones de ocupación de vía.', 'Licencia vigente publicada en obra.', 'Gerente de Proyecto'],
  5: ['Agua, desagüe y energía provisional; oficina y almacén.', 'Conexiones temporales y casetas de obra.', 'Servicios operativos y aprobados por Seguridad.', 'Maestro de Obra'],
  11: ['Excavación masiva hasta −3.00 m; 2,400 m³.', 'Excavación con excavadora y eliminación de material excedente.', 'Fondo nivelado y compactado; aprobación de mecánica de suelos.', 'Ing. Residente'],
  12: ['Zanjas para cimientos corridos; 180 m³.', 'Excavación manual y mecánica de zanjas según planos E-01.', 'Dimensiones verificadas por topografía.', 'Maestro de Obra'],
  13: ['Acero de zapatas y cimientos; 4.2 t.', 'Corte, doblado y armado de acero fy=4200.', 'Inspección de armadura aprobada antes del vaciado.', 'Maestro de Obra'],
  14: ['Encofrado de cimientos y sobrecimientos.', 'Encofrado de madera con aplomado y arriostre.', 'Medidas y verticalidad verificadas.', 'Maestro de Obra'],
  15: ['Concreto fc=210 kg/cm² en cimientos; 85 m³.', 'Vaciado con concreto premezclado y vibrado.', 'Probetas a 7 y 28 días con resistencia ≥ fc.', 'Ing. Residente'],
  16: ['Curado de concreto de cimentación.', 'Curado con agua durante 7 días.', 'Registro diario de curado completo.', 'Maestro de Obra'],
  17: ['Hito: cimentación terminada.', 'Fin de los trabajos de cimentación.', 'Protocolos de cimentación aprobados.', 'Supervisión'],
  21: ['Encofrado de columnas del primer piso.', 'Encofrado metálico de 24 columnas.', 'Plomo y escuadra verificados.', 'Maestro de Obra'],
  22: ['Acero de columnas; 3.6 t.', 'Habilitación y armado de columnas con estribos.', 'Inspección de acero aprobada.', 'Maestro de Obra'],
  23: ['Concreto de columnas P1; 18 m³.', 'Vaciado y vibrado de columnas.', 'Resistencia a 28 días ≥ fc=210.', 'Ing. Residente'],
  24: ['Encofrado de vigas y losa aligerada P1; 420 m².', 'Encofrado, colocación de ladrillo de techo y acero.', 'Contraflecha y niveles verificados.', 'Maestro de Obra'],
  25: ['Concreto de losa aligerada P1; 42 m³.', 'Vaciado de vigas y losa con bomba.', 'Superficie nivelada; probetas conformes.', 'Ing. Residente'],
  26: ['Hito: estructura del primer piso.', 'Estructura P1 terminada.', 'Protocolos de estructura P1 aprobados.', 'Supervisión'],
  27: ['Encofrado de columnas del segundo piso.', 'Encofrado de 24 columnas P2.', 'Plomo y escuadra verificados.', 'Maestro de Obra'],
  28: ['Concreto de columnas P2; 16 m³.', 'Vaciado y vibrado de columnas P2.', 'Resistencia a 28 días ≥ fc=210.', 'Ing. Residente'],
  29: ['Concreto de losa P2; 40 m³.', 'Vaciado de vigas y losa del segundo piso.', 'Superficie nivelada; probetas conformes.', 'Ing. Residente'],
  31: ['Muros de ladrillo P1; 640 m².', 'Asentado de ladrillo King Kong con mortero 1:4.', 'Muros aplomados; juntas ≤ 1.5 cm.', 'Maestro de Obra'],
  32: ['Tarrajeo de muros interiores P1; 1,150 m².', 'Tarrajeo frotachado con cintas y maestras.', 'Planitud ±3 mm en regla de 2 m.', 'Maestro de Obra'],
  33: ['Muros de ladrillo P2; 640 m².', 'Asentado de ladrillo King Kong con mortero 1:4.', 'Muros aplomados; juntas ≤ 1.5 cm.', 'Maestro de Obra'],
  34: ['Tarrajeo de muros interiores P2; 1,150 m².', 'Tarrajeo frotachado con cintas y maestras.', 'Planitud ±3 mm en regla de 2 m.', 'Maestro de Obra'],
  41: ['Redes de agua y desagüe P1.', 'Tuberías PVC, montantes y pruebas hidráulicas.', 'Prueba hidráulica sin fugas durante 24 h.', 'Subcontrata IISS'],
  42: ['Instalaciones eléctricas P1.', 'Tuberías, cajas, cableado y tablero de distribución.', 'Prueba de aislamiento conforme al CNE.', 'Subcontrata IIEE'],
  43: ['Redes de agua y desagüe P2.', 'Tuberías PVC, montantes y pruebas hidráulicas.', 'Prueba hidráulica sin fugas durante 24 h.', 'Subcontrata IISS'],
  44: ['Instalaciones eléctricas P2.', 'Tuberías, cajas, cableado y tablero.', 'Prueba de aislamiento conforme al CNE.', 'Subcontrata IIEE'],
  51: ['Contrapisos, porcelanato y zócalos; 1,800 m².', 'Contrapiso de 4 cm y porcelanato 60×60.', 'Nivelación ±2 mm; sin piezas rotas.', 'Subcontrata Acabados'],
  52: ['Pintura de muros y cielos rasos; 3,600 m².', 'Imprimante y dos manos de látex lavable.', 'Acabado uniforme sin manchas.', 'Subcontrata Acabados'],
  53: ['Puertas, closets y ventanas de aluminio.', 'Suministro e instalación de carpintería y aluminio.', 'Funcionamiento y hermeticidad verificados.', 'Subcontrata Carpintería'],
  54: ['Limpieza final de obra.', 'Retiro de desmonte y limpieza fina de ambientes.', 'Ambientes listos para entrega.', 'Maestro de Obra'],
  55: ['Hito: entrega de obra al cliente.', 'Acta de recepción de obra.', 'Acta de entrega firmada sin observaciones.', 'Gerente de Proyecto'],
};

/** Factor del pesimista en tres puntos (por defecto 1.5). */
const PESS = { 11: 2.0, 15: 1.8, 31: 1.7, 41: 1.8, 42: 1.7, 51: 1.6, 53: 1.9 };

// ── Constructor ──────────────────────────────────────────────
const STAMP = '2026-01-01T00:00:00Z';
const base = (o) => ({ org_id: ORG_ID, project_id: PROJ_ID, created_at: STAMP, updated_at: STAMP, deleted_at: null, ...o });

/**
 * Genera el DEMO anclado a la fecha `now`.
 * @param {Date} [now]
 */
export function buildDemoData(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Fecha de corte: último viernes (hoy si es viernes)
  const dataDate = addDays(today, -((today.getDay() + 2) % 7));
  // Inicio: lunes 13 semanas antes de la fecha de corte
  const start = addDays(mondayOf(dataDate), -13 * 7);

  const exceptions = [];
  for (let y = start.getFullYear() - 0; y <= start.getFullYear() + 1; y++) {
    for (const [d, name] of peruHolidays(y)) {
      exceptions.push(base({ id: `calex-demo-${iso(d)}`, calendar_id: CAL_ID, on_date: iso(d), is_working: false, name, project_id: undefined }));
    }
  }
  const cal = new Calendar({ work_week: [1, 2, 3, 4, 5], exceptions: exceptions.map(e => ({ on_date: e.on_date, is_working: false })) });
  const startDate = cal.nextWorkingDay(start);
  const dIdx = (d) => cal.dateToIdx(d, startDate);
  const idxDate = (i) => cal.idxToDate(i, startDate);
  const ddIdx = dIdx(dataDate);

  const rateOf = new Map(RESOURCES.map(r => [r[0], r]));
  const deps = DEPS.map(([n, p, s, type, lag]) => base({ id: D(n), pred_id: T(p), succ_id: T(s), type, lag_days: lag }));

  /** @param {Record<number, number>} durOf */
  const mkTasks = (durOf) => TASKS.map(([n, parent, order, name, type]) => base({
    id: T(n), parent_id: parent == null ? null : T(parent), sort_order: order, name, type,
    duration_days: type === 'milestone' ? 0 : durOf[n], work_hours: 0, percent_complete: 0,
    actual_start: null, actual_finish: null, constraint_type: 'ASAP', constraint_date: null,
    planned_cost: 0, actual_cost: 0, notes: null,
  }));
  const planDur = Object.fromEntries(TASKS.map(t => [t[0], t[5]]));
  const realDur = Object.fromEntries(TASKS.map(t => [t[0], t[6] ?? t[5]]));

  // 1) Plan contractual (línea base 1) y 2) ejecución real simulada
  const cpmPlan = computeCPM(mkTasks(planDur), deps, cal, startDate);
  const cpmReal = computeCPM(mkTasks(realDur), deps, cal, startDate);

  // Costo planificado por tarea: mano de obra + equipos + materiales + subcontratos
  const planCost = {};
  for (const [n, , , , type] of TASKS) {
    if (type === 'milestone' || !planDur[n]) { planCost[n] = 0; continue; }
    let c = OTHER_COST[n] ?? 0;
    for (const [tn, rn, units] of ASSIGN) {
      if (tn !== n) continue;
      const r = rateOf.get(rn);
      if (r[2] === 'work') c += r[4] * 8 * planDur[n] * units / 100;
      else if (r[2] === 'equipment') c += r[4] * 8 * planDur[n] * units;
      else c += r[4] * units;
    }
    planCost[n] = Math.round(c);
  }

  // 3) Estado a la fecha de corte
  const parents = new Set(TASKS.map(t => t[1]).filter(Boolean));
  const tasks = mkTasks(planDur).map(t => {
    const n = Number(t.id.slice(-3));
    const isLeaf = !parents.has(n);
    if (!isLeaf) return t;
    const r = cpmReal.tasks.get(t.id);
    const wbs = WBS[n];
    if (wbs) Object.assign(t, { wbs_scope: wbs[0], wbs_description: wbs[1], wbs_acceptance: wbs[2], wbs_owner: wbs[3] });
    t.planned_cost = planCost[n];
    if (t.type !== 'milestone') {
      const d = planDur[n];
      Object.assign(t, { optimistic_dur: Math.max(1, Math.round(d * 0.8)), most_likely_dur: d, pessimistic_dur: Math.max(d + 1, Math.round(d * (PESS[n] ?? 1.5))) });
    }
    if (!r) return t;
    const rd = realDur[n];
    if (t.type === 'milestone') {
      if (r.es <= ddIdx) Object.assign(t, { percent_complete: 100, actual_start: iso(idxDate(r.es)), actual_finish: iso(idxDate(r.es)) });
      return t;
    }
    if (r.ef <= ddIdx) {
      Object.assign(t, { percent_complete: 100, duration_days: rd, actual_start: iso(idxDate(r.es)), actual_finish: iso(idxDate(r.ef - 1)) });
    } else if (r.es <= ddIdx) {
      const pct = Math.max(5, Math.min(90, Math.round(((ddIdx - r.es + 1) / rd) * (PACE[n] ?? 1) * 100)));
      Object.assign(t, { percent_complete: pct, duration_days: rd, actual_start: iso(idxDate(r.es)) });
    }
    t.actual_cost = Math.round(t.planned_cost * (t.percent_complete / 100) * (COST_FACTOR[n] ?? 0.98));
    return t;
  });
  const tById = new Map(tasks.map(t => [t.id, t]));
  // Notas y una restricción de fecha (para DCMA y el diccionario)
  tById.get(T(11)).notes = 'Se encontró napa freática a −2.60 m; se requirió bombeo adicional (2 días).';
  tById.get(T(15)).notes = 'Retraso de un día por demora del concreto premezclado.';
  tById.get(T(42)).notes = 'Coordinar con la concesionaria eléctrica la acometida definitiva.';
  const entrega = cpmReal.tasks.get(T(55));
  if (entrega) Object.assign(tById.get(T(55)), { constraint_type: 'FNLT', constraint_date: iso(addDays(idxDate(entrega.es), 21)) });

  // Estado actual (para las semanas del Last Planner)
  const cpmNow = computeCPM(tasks, deps, cal, startDate, ddIdx);

  const resources = RESOURCES.map(([n, name, type, max, rate, unit, role]) => base({ id: R(n), name, type, max_units: max, rate_per_hour: rate, unit_label: unit, role }));
  const task_resources = ASSIGN.map(([tn, rn, units], i) => base({ id: TR(i + 1), task_id: T(tn), resource_id: R(rn), units }));

  // Líneas base
  const blRows = (blId, cpm) => [...cpm.tasks].filter(([, c]) => c.es != null).map(([taskId, c]) => ({ id: `blt-${blId}-${taskId}`, baseline_id: blId, task_id: taskId, es: c.es, ef: c.ef, dur: c.ef - c.es }));
  const baselines = [
    { id: 'bl-demo-001', project_id: PROJ_ID, name: 'LB0 — Contractual', created_at: `${iso(addDays(startDate, -3))}T09:00:00Z`, is_active: true, is_primary: true },
    { id: 'bl-demo-002', project_id: PROJ_ID, name: 'LB1 — Reprogramación mes 2', created_at: `${iso(addDays(dataDate, -21))}T09:00:00Z`, is_active: true, is_primary: false },
  ];
  const baseline_tasks = [...blRows('bl-demo-001', cpmPlan), ...blRows('bl-demo-002', cpmReal)];

  // Riesgos
  const rk = (i, title, description, probability, impact, category, response, owner, status) => ({
    id: `risk-demo-${_pad(i)}`, project_id: PROJ_ID, title, description, probability, impact, risk_score: probability * impact,
    category, response, owner, status, created_at: `${iso(addDays(startDate, i * 3))}T10:00:00Z`, updated_at: `${iso(addDays(dataDate, -i))}T10:00:00Z`, deleted_at: null,
  });
  const risks = [
    rk(1, 'Napa freática alta en excavación', 'Agua subterránea por encima del nivel de cimentación.', 4, 4, 'Técnico', 'Bombeo continuo y drenaje perimetral; estudio complementario de suelos.', 'Ing. Residente', 'Cerrado'),
    rk(2, 'Demora en suministro de concreto', 'El proveedor de premezclado tiene alta demanda en la zona.', 3, 4, 'Externo', 'Contrato con segundo proveedor y programación con 72 h de anticipación.', 'Logística', 'En seguimiento'),
    rk(3, 'Alza del precio del acero', 'Variación del precio internacional del acero corrugado.', 3, 3, 'Externo', 'Compra anticipada del 60% del acero estructural.', 'Gerente de Proyecto', 'En seguimiento'),
    rk(4, 'Lluvias atípicas', 'Fenómeno El Niño costero podría afectar vaciados y acabados.', 2, 4, 'Externo', 'Plan de contingencia con toldos y reprogramación de vaciados.', 'Ing. Residente', 'Abierto'),
    rk(5, 'Rotación de mano de obra calificada', 'Escasez de oficiales y operarios por otras obras cercanas.', 3, 3, 'Organizacional', 'Incentivos por productividad y bolsa de reemplazos.', 'Administración de Obra', 'Abierto'),
    rk(6, 'Observaciones de la supervisión a planos IIEE', 'Cambios en el diseño eléctrico pendientes de aprobación.', 4, 3, 'Gestión de proyectos', 'Reunión semanal de compatibilización y RFIs con plazo de 48 h.', 'Oficina Técnica', 'Abierto'),
    rk(7, 'Accidente de trabajo en altura', 'Trabajos en losas y encofrados sin barandas temporales.', 2, 5, 'Técnico', 'Líneas de vida, barandas y charlas diarias de 5 minutos.', 'Seguridad', 'En seguimiento'),
    rk(8, 'Retraso en licencia de conexión eléctrica', 'Trámite con la concesionaria para la acometida definitiva.', 3, 4, 'Externo', 'Iniciar el trámite 60 días antes y seguimiento quincenal.', 'Administración de Contratos', 'Abierto'),
    rk(9, 'Robo de materiales en almacén', 'Pérdida de herramientas y cobre en obra.', 2, 2, 'Organizacional', 'Vigilancia nocturna y control de kardex.', 'Almacén', 'Aceptado'),
    rk(10, 'Calidad del porcelanato importado', 'Lotes con diferencias de tono y calibre.', 2, 3, 'Técnico', 'Inspección de lotes en origen y muestras aprobadas por el cliente.', 'Calidad', 'Abierto'),
  ];

  // ── Last Planner ────────────────────────────────────────────
  const curWeekMon = mondayOf(today);
  const weekRows = (mon) => {
    const fri = addDays(mon, 4); const out = [];
    for (const t of tasks) {
      if (parents.has(Number(t.id.slice(-3)))) continue;
      const c = cpmNow.tasks.get(t.id); if (!c) continue;
      const s = idxDate(c.es), e = idxDate(Math.max(c.es, c.ef - 1));
      if (s <= fri && e >= mon) out.push(t);
    }
    return out;
  };
  const TRADES = [['Fierreros', 'kg'], ['Carpinteros', 'm²'], ['Concreteros', 'm³'], ['Albañiles', 'm²'], ['Gasfiteros', 'ml'], ['Electricistas', 'pto']];
  const PEOPLE = ['J. Pérez', 'M. Rojas', 'C. Díaz', 'L. Soto', 'R. Vega'];
  const plan = {}, ppc = {};
  const CAUSES = ['Materiales no disponibles', 'Mano de obra no disponible', 'Pre-requisito / trabajo previo', 'Problema de diseño / planos', 'Condiciones climáticas', 'Equipos / herramientas no disponibles'];
  for (let w = -6; w <= 3; w++) {
    const mon = addDays(curWeekMon, w * 7); const wk = weekKey(mon);
    const acts = [0, 1, 2].map(j => {
      const [trade, unit] = TRADES[(w + 6 + j) % TRADES.length];
      return { id: `lps-demo-${wk}-${j}`, code: `LPS-${wk.slice(-3)}-${j + 1}`, name: `${trade}: frente ${['A', 'B', 'C'][j]} — ${['habilitación', 'montaje', 'vaciado / cierre'][j]}`,
        responsible: PEOPLE[(w + 6 + j) % PEOPLE.length], trade, unit, qty: [1200, 85, 36][j] + (w + 6) * 10, status: w >= 1 && j === 2 ? 'blocked' : 'ready' };
    });
    plan[wk] = acts;
    if (w < 0) {
      const rows = weekRows(mon); const tasksDone = {}; const reasons = {}; let miss = 0;
      rows.forEach((t, i) => {
        const late = (PACE[Number(t.id.slice(-3))] ?? 1) < 1 && i % 2 === 0;
        tasksDone['cpm-' + t.id] = !late;
        if (late) { reasons['cpm-' + t.id] = CAUSES[(miss++ + w + 6) % CAUSES.length]; }
      });
      acts.forEach((a, j) => {
        const ok = !((w + 6 + j) % 4 === 0);
        tasksDone['lps-' + a.id] = ok;
        if (!ok) reasons['lps-' + a.id] = CAUSES[(j + w + 9) % CAUSES.length];
      });
      ppc[wk] = { tasks: tasksDone, reasons, saved: true, savedAt: `${iso(addDays(mon, 4))}T17:30:00Z` };
    }
  }
  const upcoming = tasks.filter(t => !parents.has(Number(t.id.slice(-3))) && t.percent_complete < 100 && t.type !== 'milestone')
    .sort((a, b) => (cpmNow.tasks.get(a.id)?.es ?? 0) - (cpmNow.tasks.get(b.id)?.es ?? 0));
  const RTYPES = [['Materiales', 'Llegada de porcelanato importado (lote 2)', 'Proveedor Cerámicos SAC'], ['Diseño / Planos', 'Planos de IIEE revisión C pendientes', 'Proyectista IIEE'],
    ['Permisos', 'Autorización municipal para uso de vía (bomba)', 'Municipalidad'], ['Mano de Obra', 'Cuadrilla adicional de albañilería', 'Subcontrata Albañilería'],
    ['Equipos', 'Andamios certificados para fachada', 'Alquiler de Equipos SAC'], ['Pre-requisito', 'Liberación de losa P2 por la supervisión', 'Supervisión'],
    ['Submittals', 'Aprobación de muestras de pintura', 'Cliente'], ['Contratos / CO', 'Orden de cambio por puntos eléctricos adicionales', 'Administración de Contratos'],
    ['Materiales', 'Tuberías PVC de 4" en almacén', 'Almacén'], ['Otros', 'Pruebas de presión con la empresa de agua', 'Sedapal']];
  const rests = RTYPES.map(([type, desc, company], i) => {
    const t = upcoming[i % Math.max(1, upcoming.length)];
    const c = t ? cpmNow.tasks.get(t.id) : null;
    const need = c ? idxDate(Math.max(0, c.es - 3)) : addDays(today, 7 + i * 3);
    const status = i < 3 ? 'cleared' : i < 6 ? 'in-progress' : 'pending';
    return { id: `rest-demo-${_pad(i + 1)}`, desc, type, activityNumber: null, taskId: t?.id ?? null, responsible: PEOPLE[i % PEOPLE.length], responsibleCompany: company,
      rfiNumber: type === 'Diseño / Planos' ? 'RFI-014' : null, dateIdentified: iso(addDays(today, -20 + i)), requiredDate: iso(need), dueDate: iso(need),
      promisedDate: iso(addDays(need, i % 3 === 0 ? 2 : -1)), effectiveDate: status === 'cleared' ? iso(addDays(today, -5 + i)) : null, status,
      comments: status === 'cleared' ? 'Levantada y verificada en campo.' : 'Seguimiento en la reunión semanal.', createdAt: `${iso(addDays(today, -20 + i))}T08:00:00Z`, updatedAt: `${iso(today)}T08:00:00Z` };
  });
  const standup = {};
  for (let k = 1, d = addDays(today, -1); k <= 10; d = addDays(d, -1)) {
    if (!cal.isWorkingDay(d)) continue;
    const t = upcoming[k % Math.max(1, upcoming.length)];
    standup[iso(d)] = { q1: `Avance en ${t?.name ?? 'frentes activos'}; vaciado y habilitación según plan.`, q2: k % 3 === 0 ? 'Falta de agua en la mañana; se coordinó cisterna.' : 'Sin impedimentos.',
      q3: `Hoy: continuar ${t?.name ?? 'trabajos'} y preparar el frente siguiente.`, savedAt: `${iso(d)}T07:45:00Z` };
    k++;
  }
  const lps = {
    meta: { area: 'Torre A — Edificio Las Palmas', contratista: '[DEMO] Constructora Las Palmas SAC', turno: 'Diurno 07:00–17:00', lastPlanner: 'Ing. M. Rojas' },
    plan, ppc, rests, standup,
  };

  // Historial de cambios de ejemplo (en memoria de sesión)
  const changeLog = [
    ['UPDATE_TASK', `Avance de "${tById.get(T(31)).name}" actualizado a ${tById.get(T(31)).percent_complete}%`, T(31), 0],
    ['UPDATE_TASK', `Fecha real de inicio registrada en "${tById.get(T(41)).name}"`, T(41), 1],
    ['UPDATE_PROJECT', 'Fecha de corte actualizada', null, 1],
    ['UPDATE_TASK', `Duración de "${tById.get(T(22)).name}" ajustada a ${realDur[22]} días`, T(22), 3],
    ['ADD_DEP', 'Dependencia SS+5 creada: losa P1 → ladrillo P1', T(31), 5],
    ['UPDATE_TASK', `"${tById.get(T(15)).name}" marcada como completada`, T(15), 9],
    ['UPDATE_TASK', `Nota agregada en "${tById.get(T(11)).name}"`, T(11), 14],
    ['ADD_TASK', 'Tarea creada: "Curado"', T(16), 20],
  ].map(([cmd, label, taskId, daysAgo], i) => ({ ts: new Date(dataDate.getTime() - (Number(daysAgo) * 86400000) + (16 - i) * 3600000), cmd, label, taskId }));

  const project = base({
    id: PROJ_ID, program_id: PROG_ID, code: 'PRJ-DEMO', name: '[DEMO] Edificio Residencial Las Palmas', sponsor_id: null,
    start_date: iso(startDate), actual_start_date: iso(startDate), actual_finish_date: null, data_date: iso(dataDate),
    calendar_id: CAL_ID, budget: Math.round(Object.values(planCost).reduce((a, b) => a + b, 0) * 1.10 / 1000) * 1000, currency: 'PEN', is_template: false,
    settings: { demo: true, demo_version: DEMO_VERSION, demo_anchor: iso(today), program_id: PROG_ID }, project_id: undefined,
  });
  delete project.project_id;
  const calendar = base({ id: CAL_ID, name: 'Calendario Estándar (Lun–Vie)', work_week: [1, 2, 3, 4, 5], hours_per_day: 8, shift_label: 'Diurno', shift_start: '07:00', shift_end: '17:00' });
  const calendar2 = base({ id: CAL2_ID, name: 'Turno extendido (Lun–Sáb)', work_week: [1, 2, 3, 4, 5, 6], hours_per_day: 10, shift_label: 'Extendido', shift_start: '07:00', shift_end: '18:00' });
  exceptions.forEach(e => { delete e.project_id; });

  return {
    project, calendar, calendars: [calendar, calendar2], calExceptions: exceptions, tasks, deps, resources, task_resources,
    baselines, baseline_tasks, risks, lps, changeLog,
    organization: { id: ORG_ID, name: '[DEMO] Constructora Las Palmas SAC', slug: 'demo', plan: 'free', settings: { demo: true }, created_at: STAMP, updated_at: STAMP, deleted_at: null },
    portfolio: { id: PORT_ID, org_id: ORG_ID, name: '[DEMO] Portafolio Edificaciones', code: 'PTF-DEMO', description: 'Proyectos de edificación de vivienda', settings: {}, created_at: STAMP, updated_at: STAMP, deleted_at: null },
    program: { id: PROG_ID, org_id: ORG_ID, portfolio_id: PORT_ID, name: '[DEMO] Programa Vivienda Lima', code: 'PRG-DEMO', description: 'Edificios residenciales en Lima', settings: {}, created_at: STAMP, updated_at: STAMP, deleted_at: null },
  };
}

/** DEMO generado al cargar la app (compatibilidad con el uso anterior). */
export const DEMO_DATA = buildDemoData();
