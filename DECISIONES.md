# DECISIONES.md — Decisiones de arquitectura Gantt v7

## D1 — Convención de índice de días laborables (D1)
- Los días se representan como enteros (`es`, `ef`, `ls`, `lf`) donde el índice 0 es el día de inicio del proyecto.
- Duración exclusiva al final: `es=0, dur=3 → ef=3`.
- Para mostrar la fecha de fin: `finishDate(ef) = idxToDate(ef − 1, startDate)`.
- **Por qué**: Simplifica la aritmética de dependencias y permite que todos los cálculos sean enteros sin conversiones de fecha durante el CPM.

## D4 — ES nunca < 0
- Si una restricción empuja ES < 0, se recorta a 0 y se emite una advertencia `INICIO_RECORTADO`.
- **Por qué**: Un proyecto no puede comenzar antes de su fecha de inicio. Recortar es más robusto que rechazar la restricción.

## D5 — Tareas resumen derivadas, sin dependencias
- No existe `type='summary'`; las tareas resumen se identifican dinámicamente como aquellas con hijos.
- Las dependencias sobre tareas resumen no están permitidas (se validan en `ADD_DEP`).
- **Por qué**: Evita inconsistencias entre el tipo explícito y la estructura del árbol; la derivación garantiza coherencia.

## D7 — CPM siempre calculado en cliente
- `es`, `ef`, `ls`, `lf`, `tf`, `ff`, `is_critical` se calculan en el cliente vía Web Worker.
- Las columnas `calc_*` en la base de datos son solo caché opcional.
- **Por qué**: Permite que la app funcione completamente offline; el CPM es determinístico dado el mismo input.

## D9 — Solo `anon key` en código fuente
- `config.js` solo almacena la clave anónima pública.
- La clave `service_role` NUNCA aparece en ningún archivo del repositorio.
- **Por qué**: La seguridad real proviene de las políticas RLS, no de ocultar claves. Exponer `service_role` daría acceso total a la base de datos.

## D13 — Tareas al 100% = TF nulo
- Tareas con `percent_complete = 100` tienen `tf = null` y `is_critical = false`.
- Se muestran en verde independientemente de su flotamiento.
- **Por qué**: Una tarea terminada no tiene riesgo de retraso; mostrarla como crítica sería confuso.

## D15 — Web Worker con fallback síncrono
- El CPM corre en un `Worker` (tipo `module`) para no bloquear la UI.
- Si el worker falla al inicializarse, se usa `_runCpmSync()` en el hilo principal.
- **Por qué**: GitHub Pages sirve los archivos correctamente para workers; el fallback garantiza que la app sea funcional incluso en entornos restringidos.

---

## Métricas de rendimiento (plantilla Fase 6)

| Métrica | Objetivo | Medido en |
|---------|---------|-----------|
| Tiempo de cálculo CPM (1 000 tareas) | < 100 ms | Worker |
| Tiempo de cálculo CPM (5 000 tareas) | < 500 ms | Worker |
| Tiempo de render tabla (500 filas) | < 50 ms | Main thread |
| Tiempo de sincronización inicial | < 2 s | Supabase |
| Outbox flush (100 ops) | < 1 s | Supabase |
| FCP (primera carga, GitHub Pages) | < 2 s | Lighthouse |
| Tamaño total JS (sin Supabase SDK) | < 80 KB | Bundler |

*Completar con valores reales en Fase 6.*
