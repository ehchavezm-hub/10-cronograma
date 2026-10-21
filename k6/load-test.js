// k6/load-test.js — Load test para ECM Project (Supabase REST API)
// Uso: k6 run --env SUPABASE_URL=https://xxx.supabase.co --env SUPABASE_ANON_KEY=yyy k6/load-test.js
//
// Variables de entorno requeridas:
//   SUPABASE_URL      — URL base de tu proyecto Supabase (ej: https://abcdef.supabase.co)
//   SUPABASE_ANON_KEY — anon/public key del proyecto
//
// Variables opcionales (para apuntar a datos reales):
//   TEST_ORG_ID       — UUID de la organización de prueba (default: org-uuid-placeholder)
//   TEST_PROJECT_ID   — UUID del proyecto de prueba      (default: project-uuid-placeholder)
//
// Lectura de resultados:
//   p(95) < 1000ms  →  95 % de las peticiones terminaron en menos de 1 s  (objetivo verde)
//   p(99) < 2000ms  →  99 % de las peticiones terminaron en menos de 2 s  (umbral máximo)
//   error_rate < 1% →  menos de 1 de cada 100 peticiones falló
//
//   Al final del run k6 imprime una tabla con ✓ (threshold cumplido) o ✗ (violado).
//   Si algún threshold se viola, k6 termina con exit code != 0, ideal para CI/CD.

import { check, sleep } from 'k6';
import http from 'k6/http';
import { Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Métricas personalizadas
// ---------------------------------------------------------------------------

/** Tasa de errores global (cualquier respuesta no-200 o check fallido) */
const errors = new Rate('errors');

/**
 * Latencia específica del endpoint "listar proyectos".
 * Permite ver degradación en ese endpoint aislado sin mezclar con otros.
 */
const projectsListDuration = new Trend('projects_list_duration', true); // true = muestra en ms

/**
 * Latencia específica del endpoint "listar tareas".
 * Es el endpoint más pesado (join implícito + filtros), por eso se monitorea aparte.
 */
const tasksListDuration = new Trend('tasks_list_duration', true);

// ---------------------------------------------------------------------------
// Configuración de carga (stages)
// ---------------------------------------------------------------------------

export const options = {
  stages: [
    // Ramp-up: de 0 a 10 VUs en 30 segundos.
    // Sirve para detectar si el primer golpe de carga provoca errores.
    { duration: '30s', target: 10 },

    // Carga sostenida: 10 VUs durante 2 minutos.
    // Aquí se estabiliza la latencia; los percentiles p95/p99 se calculan sobre este tramo.
    { duration: '2m', target: 10 },

    // Ramp-down: de 10 a 0 VUs en 30 segundos.
    // Verifica que el sistema libera conexiones correctamente (no memory leak).
    { duration: '30s', target: 0 },
  ],

  thresholds: {
    // p99 de todas las peticiones debe ser < 2 000 ms  →  umbral rojo del performance guide
    // p95 de todas las peticiones debe ser < 1 000 ms  →  umbral verde del performance guide
    'http_req_duration': ['p(99)<2000', 'p(95)<1000'],

    // Menos del 1 % de las peticiones deben fallar (status != 2xx o check fallido)
    'http_req_failed': ['rate<0.01'],

    // Endpoint de listado de proyectos: p95 < 800 ms (más estricto, menos datos)
    'projects_list_duration': ['p(95)<800'],

    // Endpoint de listado de tareas: p95 < 1 500 ms (puede traer cientos de filas)
    'tasks_list_duration': ['p(95)<1500'],

    // Tasa de errores personalizada < 1 %
    'errors': ['rate<0.01'],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Genera un entero aleatorio en [min, max] (ambos inclusive).
 * Usado para elegir escenario al azar y para el sleep variable.
 */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Construye los headers comunes de la API de Supabase.
 * Supabase REST requiere:
 *   apikey        — siempre la anon key (identifica el proyecto)
 *   Authorization — "Bearer <token>" (puede ser anon key o JWT de usuario autenticado)
 */
function supabaseHeaders(anonKey) {
  return {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
    // Prefer: return=representation pide a PostgREST que devuelva la fila afectada
    // (útil en POST/PATCH; lo dejamos aquí por consistencia aunque los GETs lo ignoran)
    Prefer: 'return=representation',
  };
}

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

/**
 * Escenario 1 — Listar proyectos de una organización.
 *
 * Endpoint: GET /rest/v1/projects
 * Filtros:  org_id=eq.<org>  y  deleted_at=is.null  (excluye eliminados lógicamente)
 * Respuesta esperada: array JSON de proyectos activos.
 *
 * ¿Por qué monitorear este endpoint?
 * Es el primero que carga la aplicación al abrir el dashboard.
 * Lentitud aquí impacta directamente el time-to-interactive.
 */
function scenarioListProjects(baseUrl, headers, orgId) {
  const url = `${baseUrl}/rest/v1/projects?org_id=eq.${orgId}&deleted_at=is.null`;
  const start = Date.now();

  const res = http.get(url, { headers });

  projectsListDuration.add(Date.now() - start);

  const ok = check(res, {
    'list projects → status 200': (r) => r.status === 200,
    'list projects → body is array': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body);
      } catch (_) {
        return false;
      }
    },
  });

  errors.add(!ok);
  return ok;
}

/**
 * Escenario 2 — Obtener tareas de un proyecto con campos seleccionados.
 *
 * Endpoint: GET /rest/v1/tasks
 * Filtros:  project_id=eq.<project>
 * Select:   id, name, type, duration_days, percent_complete
 *           (reducir columnas baja el payload y el tiempo de serialización)
 *
 * ¿Por qué monitorear este endpoint?
 * Es el más llamado de la app: se ejecuta en cada apertura del cronograma
 * y en cada recálculo de dependencias.
 */
function scenarioGetTasks(baseUrl, headers, projectId) {
  const url =
    `${baseUrl}/rest/v1/tasks` +
    `?project_id=eq.${projectId}` +
    `&select=id,name,type,duration_days,percent_complete`;
  const start = Date.now();

  const res = http.get(url, { headers });

  tasksListDuration.add(Date.now() - start);

  const ok = check(res, {
    'get tasks → status 200': (r) => r.status === 200,
    'get tasks → body is array': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body);
      } catch (_) {
        return false;
      }
    },
  });

  errors.add(!ok);
  return ok;
}

/**
 * Escenario 3 — Obtener dependencias de tareas.
 *
 * Endpoint: GET /rest/v1/task_dependencies
 * Filtros:  project_id=eq.<project>
 *
 * ¿Por qué monitorear este endpoint?
 * Se carga junto con las tareas para construir el grafo de dependencias.
 * Un índice faltante en (project_id, predecessor_id) puede disparar seq-scans.
 */
function scenarioGetDependencies(baseUrl, headers, projectId) {
  const url = `${baseUrl}/rest/v1/task_dependencies?project_id=eq.${projectId}`;

  const res = http.get(url, { headers });

  const ok = check(res, {
    'get dependencies → status 200': (r) => r.status === 200,
    'get dependencies → body is array': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body);
      } catch (_) {
        return false;
      }
    },
  });

  errors.add(!ok);
  return ok;
}

/**
 * Escenario 4 — Obtener recursos asignados a tareas.
 *
 * Endpoint: GET /rest/v1/task_resources
 * Filtros:  project_id=eq.<project>
 *
 * ¿Por qué monitorear este endpoint?
 * Contiene las asignaciones de personas/equipos. El payload puede ser grande
 * si el proyecto tiene muchas asignaciones. Valida que el índice
 * idx_task_resources_project_id esté activo.
 */
function scenarioGetResources(baseUrl, headers, projectId) {
  const url = `${baseUrl}/rest/v1/task_resources?project_id=eq.${projectId}`;

  const res = http.get(url, { headers });

  const ok = check(res, {
    'get task_resources → status 200': (r) => r.status === 200,
    'get task_resources → body is array': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body);
      } catch (_) {
        return false;
      }
    },
  });

  errors.add(!ok);
  return ok;
}

/**
 * Escenario 5 — Obtener líneas base del proyecto.
 *
 * Endpoint: GET /rest/v1/baselines
 * Filtros:  project_id=eq.<project>
 *
 * ¿Por qué monitorear este endpoint?
 * Las baselines almacenan snapshots completos del cronograma.
 * Son el endpoint con el mayor payload potencial; una baseline de
 * un proyecto grande puede superar 1 MB. Valida la velocidad de
 * recuperación de datos históricos.
 */
function scenarioGetBaselines(baseUrl, headers, projectId) {
  const url = `${baseUrl}/rest/v1/baselines?project_id=eq.${projectId}`;

  const res = http.get(url, { headers });

  const ok = check(res, {
    'get baselines → status 200': (r) => r.status === 200,
    'get baselines → body is array': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body);
      } catch (_) {
        return false;
      }
    },
  });

  errors.add(!ok);
  return ok;
}

// ---------------------------------------------------------------------------
// Función principal de VU
// ---------------------------------------------------------------------------

/**
 * Cada VU (Virtual User) ejecuta este bucle durante toda la prueba.
 * En cada iteración elige un escenario al azar para distribuir la carga
 * entre los cinco endpoints y simular patrones de uso reales.
 */
export default function () {
  // Leer variables de entorno inyectadas con --env
  const baseUrl = __ENV.SUPABASE_URL || 'https://placeholder.supabase.co';
  const anonKey = __ENV.SUPABASE_ANON_KEY || 'placeholder-anon-key';
  const orgId = __ENV.TEST_ORG_ID || 'org-uuid-placeholder';
  const projectId = __ENV.TEST_PROJECT_ID || 'project-uuid-placeholder';

  const headers = supabaseHeaders(anonKey);

  // Elegir escenario aleatoriamente (distribución uniforme entre 5 opciones)
  const scenario = randomInt(1, 5);

  switch (scenario) {
    case 1:
      scenarioListProjects(baseUrl, headers, orgId);
      break;
    case 2:
      scenarioGetTasks(baseUrl, headers, projectId);
      break;
    case 3:
      scenarioGetDependencies(baseUrl, headers, projectId);
      break;
    case 4:
      scenarioGetResources(baseUrl, headers, projectId);
      break;
    case 5:
      scenarioGetBaselines(baseUrl, headers, projectId);
      break;
    default:
      scenarioListProjects(baseUrl, headers, orgId);
  }

  // Pausa aleatoria entre 1 y 3 segundos para simular "think time" del usuario.
  // Sin este sleep los VUs atacarían a máxima velocidad, lo que no refleja
  // el uso real y sobrecarga la base de datos artificialmente.
  sleep(randomInt(1, 3));
}

// ---------------------------------------------------------------------------
// Hooks opcionales
// ---------------------------------------------------------------------------

/**
 * setup() se ejecuta UNA SOLA VEZ antes de que arranquen los VUs.
 * Ideal para verificar conectividad y que la API responde antes del test.
 * El objeto retornado se pasa como parámetro a la función default() si se necesita.
 */
export function setup() {
  const baseUrl = __ENV.SUPABASE_URL || 'https://placeholder.supabase.co';
  const anonKey = __ENV.SUPABASE_ANON_KEY || 'placeholder-anon-key';

  console.log(`[setup] Verificando conectividad con ${baseUrl}...`);

  const res = http.get(`${baseUrl}/rest/v1/`, {
    headers: supabaseHeaders(anonKey),
  });

  // PostgREST responde 200 en la raíz con el schema OpenAPI
  if (res.status !== 200) {
    console.warn(
      `[setup] Advertencia: la API respondió ${res.status}. ` +
        'Verifica SUPABASE_URL y SUPABASE_ANON_KEY antes de analizar resultados.'
    );
  } else {
    console.log('[setup] Conectividad OK. Iniciando prueba de carga...');
  }
}

/**
 * teardown() se ejecuta UNA SOLA VEZ al finalizar todos los VUs.
 * Úsalo para limpiar datos de prueba si el test escribió registros.
 * (Este test solo hace GETs, así que no hay limpieza necesaria.)
 */
export function teardown() {
  console.log('[teardown] Prueba de carga completada.');
  console.log('[teardown] Revisa el resumen de thresholds arriba para el veredicto.');
  console.log(
    '[teardown] Para un informe HTML: k6 run --out json=results.json ... && k6-reporter results.json'
  );
}
