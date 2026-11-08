# ECM Project — Infraestructura: inactividad, cuotas y continuidad

Última auditoría: 2026-11-08 · Próxima revisión: 2027-01-01 (issue automático trimestral)

Contexto: repo `ehchavezm-hub/10-cronograma` · entorno: producción · presupuesto: plan gratuito · alertas: correo de GitHub (fallos de Actions + issues).

---

## 1. Inventario y límites

| Componente | Plan | Política de inactividad | Reactivación | Riesgo de pérdida de datos | Cuotas / vencimientos críticos | Riesgo |
|---|---|---|---|---|---|---|
| **Supabase** (Postgres + Auth + REST), proyecto `rduzdeojbcelfjqsuvht` | Free | Pausa si no hay "suficiente actividad de base de datos de usuario" en 7 días; "normalmente bastan unas pocas solicitudes al día" | **Manual** (Dashboard → Resume project), 2–5 min | **Sí**: solo se puede restaurar hasta **90 días** después de la pausa. En Free los backups **no se pueden descargar** | BD 500 MB (uso actual: 13 MB, 2,6 %); 9 usuarios auth; Storage 0 B; anon key vence en 2106 | **Alto** |
| **GitHub Actions** (workflows programados) | Free | Workflows `schedule` se desactivan tras **60 días sin actividad** en el repo | Manual (Actions → Enable) o vía API | No | Minutos ilimitados en repos públicos | **Medio** |
| **GitHub Pages** (hosting de la SPA) | Free | No se pausa por inactividad | — | No (el código está en git) | 1 GB de sitio, 100 GB/mes de ancho de banda (límite blando); dominio `*.github.io` y SSL gestionados por GitHub, sin vencimiento | **Bajo** |
| Sentry (`js/monitoring.js`) | — | Solo referenciado en un comentario; no se carga | — | — | — | N/A |

Fuentes: [Supabase — Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing) · [Supabase — Production Checklist](https://supabase.com/docs/guides/deployment/going-into-prod) · [GitHub — Disable and enable workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows)

## 2. Mecanismos implementados

| Mecanismo | Archivo | Qué hace |
|---|---|---|
| Keep-alive de Supabase | `.github/workflows/supabase-keepalive.yml` | **Diario** (09:17 UTC): 3 consultas REST que llegan a Postgres (`organizations`, `projects`, `profiles`) + `auth/v1/health`. Exige HTTP 200 en todas; 3 reintentos con 20 s de espera y timeout de 20 s. Si falla, el job falla con el enlace de restauración → GitHub envía correo |
| Monitor de GitHub Pages | mismo workflow | Comprueba que la app publicada responda 200 |
| Anti-desactivación del planificador | mismo workflow (último paso, `if: always()`) | Re-habilita vía API `supabase-keepalive.yml` e `infra-review.yml` en cada ejecución, sin commits de relleno |
| Prueba del camino de fallo | `workflow_dispatch` → `probar_fallo: true` | Usa una URL inválida para comprobar que el fallo y la alerta se disparan |
| Revisión trimestral | `.github/workflows/infra-review.yml` | 1 de ene/abr/jul/oct abre un issue con checklist de revisión |

Credenciales: solo la URL y la anon key de `js/config.js` (públicas por diseño, protegidas por RLS). No se agregaron secretos.

## 3. Matriz de riesgo y verificación

| Plataforma | Acción | Verificación | Estado | Evidencia |
|---|---|---|---|---|
| Supabase | Restaurado de pausa (con autorización); keep-alive diario | Ejecución real: 3 tablas + auth = 200 | ACTIVE_HEALTHY | [run 42492081037](https://github.com/ehchavezm-hub/10-cronograma/actions/runs/42492081037) |
| GitHub Actions | Auto re-habilitación vía API | `supabase-keepalive.yml habilitado`, `infra-review.yml habilitado` | Activo | mismo run |
| GitHub Pages | Monitor diario | `https://ehchavezm-hub.github.io/10-cronograma/ → 200` | En línea | mismo run |
| Revisión trimestral | Issue automático | Issue creado | Activo | [issue #251](https://github.com/ehchavezm-hub/10-cronograma/issues/251) |

## 4. Límites residuales

| Caso no cubierto | Por qué | Solución definitiva |
|---|---|---|
| Supabase podría pausar aunque haya consultas | El umbral de "actividad suficiente" no es público | **Supabase Pro** (≈ US$25/mes): los proyectos de pago no se pausan |
| Sin respaldo de datos fuera del proveedor | En Free los backups no son descargables; tras 90 días en pausa el proyecto no se puede restaurar | **Pendiente de aprobación**: workflow semanal con `pg_dump` (requiere el secreto `SUPABASE_DB_URL` en GitHub Secrets) que guarde el dump como artefacto privado. Alternativa: Supabase Pro (backups diarios, 7 días) |
| Alerta temprana de cuotas (≥ 80 %) | Consultar el uso exige un token de administración (Management API), que no está configurado | Revisión trimestral manual (issue automático); o agregar un token de Supabase con aprobación |
| Que el "enable" vía API reinicie el contador de 60 días | GitHub no documenta qué cuenta como "actividad"; es un patrón comunitario | Cualquier commit al repo también lo reinicia; el issue trimestral sirve de respaldo |
| Workflow desactivado a mano | La auto-reactivación no corre si nadie lo ejecuta | No desactivarlo; si se hace, reactivar en Actions |
| Caída de GitHub o de Supabase | Fuera de nuestro control | Status pages: githubstatus.com · status.supabase.com |

## 5. Runbook

**Correo "Supabase keep-alive failed" — paso "Consultar Supabase"**
1. Abre el log de la ejecución: si dice `auth=000` / `=000`, el proyecto no responde.
2. Entra a https://supabase.com/dashboard/project/rduzdeojbcelfjqsuvht.
3. Si está **Paused**: pulsa **Resume project** y espera de 2 a 5 minutos.
4. Si aparece **401/403** en las tablas: la anon key cambió → actualiza `js/config.js`.
5. Vuelve a ejecutar el workflow (Actions → Supabase keep-alive → Run workflow) y confirma que queda en verde.

**Correo de fallo — paso "Verificar GitHub Pages"**
1. Revisa Settings → Pages (fuente: rama `main`) y la última ejecución de *pages build and deployment*.
2. Consulta githubstatus.com. Si es una caída de GitHub, solo hay que esperar.

**Banner "This scheduled workflow is disabled" en Actions**
1. Actions → elige el workflow → **Enable workflow**.
2. Ejecútalo manualmente una vez.

**Issue "Revisión trimestral de infraestructura"**
1. Completa el checklist, actualiza este documento y cierra el issue.

## 6. Evidencia de verificación (2026-11-08)

- **Camino de éxito** — [run 42492081037](https://github.com/ehchavezm-hub/10-cronograma/actions/runs/42492081037):
  `intento 1 → organizations=200 projects=200 profiles=200 auth=200` · `GitHub Pages → 200` · ambos workflows re-habilitados.
- **Camino de fallo, 1.ª prueba** — [run 42492083068](https://github.com/ehchavezm-hub/10-cronograma/actions/runs/42492083068): el job falló (la alerta se dispara), pero con `exit code 6` de curl, sin reintentos ni mensaje de restauración. **Bug corregido** (`|| true` en las llamadas curl).
- **Camino de fallo, 2.ª prueba** — ver la ejecución con `probar_fallo: true` posterior a la corrección en Actions.
- **Supabase** — estado `ACTIVE_HEALTHY`; BD 13 MB (2,6 % de 500 MB); 9 usuarios.
- **Pendiente de confirmar por el propietario**: que el correo de fallo de GitHub llegó a su bandeja.
