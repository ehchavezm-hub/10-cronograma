# Performance & Load Testing Guide — ECM Project

> **Etapa 4 · Plan Maestro de Optimización**
> Referencia técnica para monitoreo de rendimiento, pruebas de carga y prevención
> de condiciones de carrera en la SPA del cronograma de proyectos.

---

## Tabla de contenidos

1. [Supabase Log Analysis](#1-supabase-log-analysis)
2. [Performance Thresholds](#2-performance-thresholds)
3. [Race Condition Prevention](#3-race-condition-prevention)
4. [k6 Quick Start](#4-k6-quick-start)
5. [Index Verification Queries](#5-index-verification-queries)

---

## 1. Supabase Log Analysis

### 1.1 Acceder a los logs de API

1. Abre el **Supabase Dashboard** → selecciona tu proyecto.
2. En el menú lateral ve a **Logs → API**.
3. Los logs se muestran en tiempo real con retención de 7 días en el plan Pro.

### 1.2 Filtrar consultas lentas (> 500 ms)

En el campo de búsqueda del Log Explorer usa la siguiente consulta:

```sql
-- Supabase Log Explorer (interfaz SQL del dashboard)
SELECT
  timestamp,
  path,
  method,
  status_code,
  response_time_ms
FROM
  edge_logs
WHERE
  response_time_ms > 500
ORDER BY
  response_time_ms DESC
LIMIT 50;
```

O usando el filtro visual:

- **Filter** → `response_time` → **greater than** → `500`
- **Columnas relevantes a revisar:** `path`, `method`, `status_code`, `response_time_ms`

### 1.3 Identificar patrones N+1

El patrón N+1 aparece cuando la aplicación hace:

1. **1 consulta** para obtener una lista de recursos (ej: proyectos).
2. **N consultas** adicionales, una por cada ítem de la lista (ej: tareas de cada proyecto).

**Señales en los logs:**

```
GET /rest/v1/tasks?project_id=eq.aaa  → 12 ms
GET /rest/v1/tasks?project_id=eq.bbb  → 11 ms
GET /rest/v1/tasks?project_id=eq.ccc  → 13 ms
... (repetido N veces en un lapso de < 1 s)
```

**Cómo detectarlo:**

```sql
-- Detectar burst de consultas idénticas en ventana de 1 segundo
SELECT
  DATE_TRUNC('second', timestamp) AS second_bucket,
  path,
  COUNT(*) AS request_count
FROM
  edge_logs
WHERE
  timestamp > NOW() - INTERVAL '1 hour'
  AND path LIKE '/rest/v1/tasks%'
GROUP BY
  second_bucket, path
HAVING
  COUNT(*) > 5
ORDER BY
  second_bucket DESC, request_count DESC;
```

**Solución recomendada:** Usar PostgREST embedded resources en lugar de N llamadas individuales:

```
-- En lugar de N llamadas GET /rest/v1/tasks?project_id=eq.X
-- Usar un único GET con select embebido:
GET /rest/v1/projects?select=id,name,tasks(id,name,duration_days)&org_id=eq.{ORG_ID}
```

### 1.4 Analizar el breakdown de latencia

Para cada consulta lenta, el detalle de Supabase muestra:

| Componente | Descripción | Objetivo |
|---|---|---|
| **Edge latency** | Tiempo en el CDN/proxy antes de llegar a PostgREST | < 30 ms |
| **PostgREST overhead** | Parsing de la query REST → SQL | < 20 ms |
| **Database execution** | Tiempo real en PostgreSQL | < 400 ms |

Si el 90 % del tiempo está en *Database execution*, el problema es un índice faltante o una consulta no optimizada. Ver sección 5.

---

## 2. Performance Thresholds

### 2.1 Umbrales por métrica

| Métrica | Verde ✅ | Amarillo ⚠️ | Rojo 🔴 | Acción en rojo |
|---|---|---|---|---|
| **p99 latencia global** | < 1 000 ms | 1 000 – 2 000 ms | > 2 000 ms | Revisar índices, considerar caché |
| **Tasa de errores HTTP** | < 0.1 % | 0.1 % – 1 % | > 1 % | Revisar logs de error, alertar |
| **Listado de tareas (100 tasks)** | < 200 ms | 200 – 500 ms | > 500 ms | EXPLAIN ANALYZE en la query |
| **Listado de proyectos** | < 150 ms | 150 – 400 ms | > 400 ms | Verificar índice en `org_id` |
| **Carga de dependencias** | < 100 ms | 100 – 300 ms | > 300 ms | Verificar índice en `project_id` |
| **Carga de recursos** | < 150 ms | 150 – 400 ms | > 400 ms | Verificar índice en `project_id` |
| **Carga de baselines** | < 300 ms | 300 – 800 ms | > 800 ms | Paginación o compresión de payload |
| **Time to Interactive (app)** | < 2 s | 2 – 4 s | > 4 s | Lazy load, code splitting |
| **Concurrent users sin degradación** | ≤ 10 VUs | 11 – 25 VUs | > 25 VUs | Escalar instancia Supabase |

### 2.2 SLOs (Service Level Objectives) recomendados

```
SLO-1: p95 de /rest/v1/tasks < 500 ms — medido en ventana de 7 días
SLO-2: Error rate < 0.5 % — medido en ventana de 24 horas
SLO-3: Disponibilidad > 99.5 % — medido en ventana de 30 días
```

### 2.3 Configurar alertas en Supabase

En **Dashboard → Monitoring → Alerts**:

1. **Alerta de latencia:** `avg_response_time > 800ms` durante 5 minutos → Slack/email.
2. **Alerta de errores:** `error_rate > 1%` durante 2 minutos → Slack/email.
3. **Alerta de conexiones:** `active_connections > 80%` del pool → Slack/email.

---

## 3. Race Condition Prevention

Las condiciones de carrera en SPAs ocurren cuando múltiples eventos asíncronos
compiten por modificar el mismo estado. A continuación los tres patrones más
comunes en el ECM Project y su solución específica.

---

### 3.1 Double-click save (doble guardado)

**Problema:** El usuario hace doble clic en "Guardar". Se lanzan dos peticiones
`PATCH` simultáneas al mismo registro. La segunda puede sobreescribir los cambios
de la primera con datos más antiguos (los del snapshot previo al primer PATCH).

**Patrón de solución: deshabilitar el botón al enviar y rehabilitarlo al recibir respuesta.**

```javascript
// js/modules/task-editor.js

async function saveTask(taskId, formData) {
  const saveBtn = document.getElementById('btn-save-task');

  // 1. Deshabilitar INMEDIATAMENTE, antes del await.
  //    Esto bloquea cualquier clic mientras la petición está en vuelo.
  saveBtn.disabled = true;
  saveBtn.textContent = 'Guardando…';

  try {
    const { data, error } = await supabase
      .from('tasks')
      .update(formData)
      .eq('id', taskId)
      .select()
      .single();

    if (error) throw error;

    showSuccessToast('Tarea guardada correctamente');
    return data;

  } catch (err) {
    showErrorToast(`Error al guardar: ${err.message}`);
    throw err;

  } finally {
    // 2. Re-habilitar en el bloque finally para que siempre se ejecute,
    //    tanto en éxito como en error.  Si el catch relanza, el finally
    //    igual corre antes de que el error suba al llamador.
    saveBtn.disabled = false;
    saveBtn.textContent = 'Guardar';
  }
}
```

**Por qué funciona:** `disabled = true` se ejecuta de forma síncrona antes del
primer `await`. El event loop de JS es single-threaded: ningún handler de clic
puede ejecutarse mientras el stack está activo. Al volver del `await`, el botón
sigue deshabilitado, por lo que los clics acumulados en la UI durante la espera
son descartados por el navegador.

---

### 3.2 Concurrent Supabase writes (escrituras concurrentes)

**Problema:** Dos pestañas del mismo usuario (o dos usuarios distintos) cargan
el mismo registro, hacen cambios diferentes, y ambas hacen `PATCH` casi al mismo
tiempo. La última escritura gana y borra silenciosamente los cambios de la primera.

**Patrón de solución: optimistic locking con verificación de `updated_at`.**

```javascript
// js/modules/optimistic-lock.js

/**
 * Actualiza un registro solo si updated_at no ha cambiado desde que
 * el cliente lo cargó. Si otro proceso lo modificó mientras tanto,
 * el UPDATE afecta 0 filas y detectamos el conflicto.
 *
 * @param {string} table       - Nombre de la tabla en Supabase
 * @param {string} id          - UUID del registro a actualizar
 * @param {object} changes     - Campos a actualizar
 * @param {string} knownUpdatedAt - Valor de updated_at que tenía el cliente al leer
 * @throws {Error} Si hay conflicto (otro proceso modificó el registro)
 */
async function updateWithOptimisticLock(table, id, changes, knownUpdatedAt) {
  const { data, error, count } = await supabase
    .from(table)
    .update({
      ...changes,
      updated_at: new Date().toISOString(), // PostgREST no tiene NOW() directo en update
    })
    .eq('id', id)
    .eq('updated_at', knownUpdatedAt) // <-- la condición de locking
    .select()
    .returns('representation');         // necesario para que count sea preciso

  if (error) throw error;

  // Si count === 0, el registro existe pero updated_at cambió: hay un conflicto.
  if (!data || data.length === 0) {
    throw new Error(
      'CONFLICT: El registro fue modificado por otro proceso. ' +
      'Recarga la página para ver la versión más reciente antes de guardar.'
    );
  }

  return data[0];
}

// Uso en el editor de tareas:
async function saveTaskSafe(task, formChanges) {
  try {
    const updated = await updateWithOptimisticLock(
      'tasks',
      task.id,
      formChanges,
      task.updated_at // valor que se cargó cuando se abrió el editor
    );
    showSuccessToast('Guardado correctamente');
    return updated;

  } catch (err) {
    if (err.message.startsWith('CONFLICT')) {
      // Informar al usuario y recargar el registro fresco
      showConflictDialog({
        message: 'Otro usuario modificó esta tarea mientras la editabas.',
        onReload: () => reloadTask(task.id),
      });
    } else {
      showErrorToast(err.message);
    }
  }
}
```

**Requisito de base de datos:** La columna `updated_at` debe actualizarse automáticamente.
Verifica que el trigger esté activo:

```sql
-- Verificar que el trigger de updated_at existe en la tabla tasks
SELECT trigger_name, event_manipulation, action_timing
FROM information_schema.triggers
WHERE event_object_table = 'tasks'
  AND trigger_name LIKE '%updated_at%';

-- Si no existe, crearlo:
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_set_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
```

---

### 3.3 Stale closure en event handlers

**Problema:** Un event handler captura una variable en el momento en que se define
(closure). Si esa variable se actualiza después (por ejemplo, al cambiar el proyecto
seleccionado), el handler sigue usando el valor viejo. Esto provoca que una acción
del usuario opere sobre datos incorrectos.

**Ejemplo del problema:**

```javascript
// ❌ INCORRECTO — stale closure
function setupSaveButton(projectId) {
  // projectId queda "congelado" en este closure.
  // Si el usuario cambia de proyecto antes de guardar,
  // este handler seguirá usando el projectId anterior.
  document.getElementById('btn-save').addEventListener('click', async () => {
    await saveProject(projectId); // ← valor obsoleto si projectId cambió
  });
}
```

**Patrón de solución: leer el estado desde `e.target.dataset` en el momento del evento.**

```javascript
// js/modules/project-actions.js

// ✅ CORRECTO — leer projectId desde el DOM en el momento del clic

/**
 * Al renderizar el botón, escribe el ID en un data attribute.
 * Esto garantiza que el handler siempre lea el ID actual, no el capturado
 * cuando se registró el listener.
 */
function renderSaveButton(projectId) {
  const btn = document.getElementById('btn-save');
  // Actualizar el dataset cada vez que cambia el proyecto activo
  btn.dataset.projectId = projectId;
}

// Registrar el listener UNA SOLA VEZ (en el montaje del componente).
// No volver a registrar en cada cambio de proyecto: acumularía duplicados.
document.getElementById('btn-save').addEventListener('click', async (e) => {
  // Leer el projectId del DOM en el instante del clic, no de un closure.
  const projectId = e.target.dataset.projectId;

  if (!projectId) {
    console.warn('btn-save disparado sin projectId en dataset');
    return;
  }

  await saveProject(projectId); // siempre usa el valor más reciente
});

// En cada cambio de proyecto activo, solo actualizar el dataset:
function onProjectChange(newProjectId) {
  renderSaveButton(newProjectId);
  // No hay que volver a registrar el listener
}
```

**Regla general:** Si un event handler necesita saber "sobre qué dato actuar",
ese dato debe vivir en el DOM (via `dataset`) y ser leído en el momento del evento,
no en el momento del registro del handler.

**Caso adicional — cleanup de listeners en vistas dinámicas:**

```javascript
// Al navegar a otra vista, limpiar los listeners para evitar
// que handlers obsoletos reaccionen a eventos de otra vista.

let currentController = null;

function mountProjectView(projectId) {
  // AbortController permite cancelar todos los listeners de golpe
  currentController = new AbortController();
  const { signal } = currentController;

  document.getElementById('btn-save').addEventListener(
    'click',
    (e) => saveProject(e.target.dataset.projectId),
    { signal } // el listener se elimina automáticamente al hacer controller.abort()
  );
}

function unmountProjectView() {
  if (currentController) {
    currentController.abort(); // limpia todos los listeners registrados con este signal
    currentController = null;
  }
}
```

---

## 4. k6 Quick Start

### 4.1 Instalación

```bash
# macOS
brew install k6

# Ubuntu / Debian
sudo gpg -k
sudo gpg --no-default-keyring \
  --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 \
  --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6

# Windows (winget)
winget install k6 --source winget

# Docker (sin instalación local)
docker pull grafana/k6
```

### 4.2 Comandos de uso

```bash
# Ejecución básica (requiere variables de entorno)
k6 run \
  --env SUPABASE_URL=https://tu-proyecto.supabase.co \
  --env SUPABASE_ANON_KEY=tu-anon-key \
  k6/load-test.js

# Con IDs de datos reales para pruebas significativas
k6 run \
  --env SUPABASE_URL=https://tu-proyecto.supabase.co \
  --env SUPABASE_ANON_KEY=tu-anon-key \
  --env TEST_ORG_ID=uuid-de-la-org-de-prueba \
  --env TEST_PROJECT_ID=uuid-del-proyecto-de-prueba \
  k6/load-test.js

# Sobrescribir el número de VUs y duración para una prueba rápida
k6 run \
  --vus 3 --duration 30s \
  --env SUPABASE_URL=https://tu-proyecto.supabase.co \
  --env SUPABASE_ANON_KEY=tu-anon-key \
  k6/load-test.js

# Exportar resultados en JSON para procesamiento posterior
k6 run \
  --out json=results/load-test-$(date +%Y%m%d-%H%M%S).json \
  --env SUPABASE_URL=https://tu-proyecto.supabase.co \
  --env SUPABASE_ANON_KEY=tu-anon-key \
  k6/load-test.js

# Ejecutar con Docker (sin instalar k6 localmente)
docker run --rm -i \
  -e SUPABASE_URL=https://tu-proyecto.supabase.co \
  -e SUPABASE_ANON_KEY=tu-anon-key \
  -v "$(pwd)/k6:/scripts" \
  grafana/k6 run /scripts/load-test.js
```

### 4.3 Interpretar los resultados

Al finalizar, k6 imprime un resumen como este:

```
          /\      |‾‾| /‾‾/   /‾‾/
     /\  /  \     |  |/  /   /  /
    /  \/    \    |     (   /   ‾‾\
   /          \   |  |\  \ |  (‾)  |
  / __________ \  |__| \__\ \_____/ .io

  execution: local
     script: k6/load-test.js
     output: -

  scenarios: (100.00%) 1 scenario, 10 max VUs, 3m30s max duration

  ✓ list projects → status 200
  ✓ list projects → body is array
  ✓ get tasks → status 200
  ...

  █ setup

  checks.........................: 99.82% ✓ 1123  ✗ 2
  data_received..................: 4.2 MB 19 kB/s
  data_sent......................: 312 kB 1.4 kB/s
  errors.........................: 0.18%  ✓ 0 ✗ 2
  http_req_blocked...............: avg=1.2ms   p(95)=2.1ms
  http_req_duration..............: avg=187ms   p(95)=423ms  p(99)=891ms
  ✓ { expected_response:true }...: avg=187ms   p(95)=423ms  p(99)=891ms
  http_req_failed................: 0.00%  ✓ 0 ✗ 632
  http_reqs......................: 632    2.84/s
  iteration_duration.............: avg=2.3s    p(95)=4.1s
  iterations.....................: 214    0.96/s
  projects_list_duration.........: avg=143ms   p(95)=312ms
  tasks_list_duration............: avg=221ms   p(95)=487ms
  vus............................: 1      min=1  max=10
  vus_max........................: 10     min=10 max=10

  ✓ http_req_duration..............: p(99)<2000ms ✓  p(95)<1000ms ✓
  ✓ http_req_failed................: rate<0.01    ✓
  ✓ projects_list_duration.........: p(95)<800ms  ✓
  ✓ tasks_list_duration............: p(95)<1500ms ✓
  ✓ errors.........................: rate<0.01    ✓
```

**Cómo leer los thresholds:**
- `✓` → el threshold se cumplió → el sistema está dentro del SLO.
- `✗` → el threshold se violó → acción requerida según la tabla de la sección 2.

---

## 5. Index Verification Queries

Antes de correr el load test, verifica que todos los índices críticos estén activos
y siendo usados por el query planner de PostgreSQL.

### 5.1 Listar índices existentes en tablas ECM

```sql
-- Ver todos los índices de las tablas del cronograma
SELECT
  schemaname,
  tablename,
  indexname,
  indexdef
FROM
  pg_indexes
WHERE
  tablename IN ('tasks', 'projects', 'task_dependencies', 'task_resources', 'baselines')
ORDER BY
  tablename, indexname;
```

### 5.2 EXPLAIN ANALYZE — Listado de tareas (endpoint más crítico)

```sql
-- Simular exactamente la query que genera PostgREST para:
-- GET /rest/v1/tasks?project_id=eq.{ID}&select=id,name,type,duration_days,percent_complete

EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT
  id,
  name,
  type,
  duration_days,
  percent_complete
FROM
  tasks
WHERE
  project_id = 'reemplaza-con-uuid-real'::uuid
ORDER BY
  wbs_code;  -- orden típico para mostrar el cronograma

-- Resultado esperado (índice activo):
-- Index Scan using idx_tasks_project_id on tasks
--   Index Cond: (project_id = '...'::uuid)
--   Rows Removed by Filter: 0
--   Execution Time: 0.8..3.2 ms  ← dentro del threshold verde

-- Resultado problemático (sin índice):
-- Seq Scan on tasks
--   Filter: (project_id = '...'::uuid)
--   Rows Removed by Filter: 45000
--   Execution Time: 180..800 ms  ← threshold rojo
```

### 5.3 EXPLAIN ANALYZE — Dependencias de tareas

```sql
-- GET /rest/v1/task_dependencies?project_id=eq.{ID}

EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM task_dependencies
WHERE project_id = 'reemplaza-con-uuid-real'::uuid;

-- Debe mostrar: Index Scan using idx_task_dependencies_project_id
-- Si muestra Seq Scan, crear el índice:
CREATE INDEX CONCURRENTLY idx_task_dependencies_project_id
  ON task_dependencies (project_id);
```

### 5.4 EXPLAIN ANALYZE — Recursos de tareas

```sql
-- GET /rest/v1/task_resources?project_id=eq.{ID}

EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM task_resources
WHERE project_id = 'reemplaza-con-uuid-real'::uuid;

-- Crear si falta:
CREATE INDEX CONCURRENTLY idx_task_resources_project_id
  ON task_resources (project_id);
```

### 5.5 EXPLAIN ANALYZE — Baselines

```sql
-- GET /rest/v1/baselines?project_id=eq.{ID}

EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM baselines
WHERE project_id = 'reemplaza-con-uuid-real'::uuid
ORDER BY created_at DESC;

-- Índice compuesto recomendado (project_id + created_at para el ORDER BY):
CREATE INDEX CONCURRENTLY idx_baselines_project_created
  ON baselines (project_id, created_at DESC);
```

### 5.6 EXPLAIN ANALYZE — Listado de proyectos por organización

```sql
-- GET /rest/v1/projects?org_id=eq.{ID}&deleted_at=is.null

EXPLAIN (ANALYZE, BUFFERS)
SELECT *
FROM projects
WHERE
  org_id = 'reemplaza-con-uuid-real'::uuid
  AND deleted_at IS NULL
ORDER BY
  name;

-- Índice parcial recomendado (solo filas activas, menor tamaño del índice):
CREATE INDEX CONCURRENTLY idx_projects_org_active
  ON projects (org_id, name)
  WHERE deleted_at IS NULL;
```

### 5.7 Verificar que pg_stat_user_indexes registra uso real

Después de correr el load test, confirma que los índices se usaron:

```sql
-- Consultar estadísticas de uso de índices
-- (se resetean con pg_stat_reset(); acumula desde el último reset)
SELECT
  schemaname,
  relname        AS table_name,
  indexrelname   AS index_name,
  idx_scan       AS times_used,
  idx_tup_read   AS tuples_read,
  idx_tup_fetch  AS tuples_fetched
FROM
  pg_stat_user_indexes
WHERE
  relname IN ('tasks', 'projects', 'task_dependencies', 'task_resources', 'baselines')
ORDER BY
  idx_scan DESC;

-- Si idx_scan = 0 para un índice que debería usarse:
-- 1. Verifica que la query filtra por la columna del índice con el tipo correcto.
-- 2. Verifica que la tabla tiene suficientes filas (< 1000 filas puede preferir seq scan).
-- 3. Ejecuta: ANALYZE <tabla>;  para actualizar las estadísticas del planner.
```

### 5.8 Detectar índices no utilizados (candidatos a eliminar)

```sql
-- Índices que nunca se usan ocupan espacio y ralentizan los writes.
-- Revisar estos después de 7+ días de tráfico real.
SELECT
  schemaname,
  relname        AS table_name,
  indexrelname   AS index_name,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  idx_scan       AS times_used
FROM
  pg_stat_user_indexes
WHERE
  idx_scan = 0
  AND relname NOT IN ('schema_migrations') -- excluir tablas de sistema
ORDER BY
  pg_relation_size(indexrelid) DESC;
```

---

## Apéndice: Comandos de referencia rápida

```bash
# Verificar versión de k6 instalada
k6 version

# Ver métricas disponibles durante la ejecución (modo verbose)
k6 run --verbose k6/load-test.js

# Prueba de humo (1 VU, 1 iteración) para validar el script
k6 run --vus 1 --iterations 1 \
  --env SUPABASE_URL=... --env SUPABASE_ANON_KEY=... \
  k6/load-test.js

# Prueba de estrés (ramp agresivo para encontrar el límite)
k6 run --stage '1m:50' --stage '30s:0' \
  --env SUPABASE_URL=... --env SUPABASE_ANON_KEY=... \
  k6/load-test.js

# Limpiar caché de plan en PostgreSQL (solo desarrollo, nunca producción)
-- En Supabase SQL Editor:
SELECT pg_stat_reset();
DISCARD ALL;
```

---

*Última actualización: Etapa 4 — Plan Maestro de Optimización ECM Project*
