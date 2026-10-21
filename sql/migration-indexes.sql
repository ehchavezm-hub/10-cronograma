-- ============================================================
-- Migration : migration-indexes
-- Date      : 2026-10-21
-- Description: Índices de performance para ECM Project
--
-- Todos los índices usan CREATE INDEX CONCURRENTLY IF NOT EXISTS
-- para evitar bloqueos de tabla en producción.
-- Los índices ya existentes en schema.sql NO se repiten aquí:
--   idx_tasks_project_id, idx_tasks_updated_at, idx_tasks_parent_id
--   idx_task_dependencies_project_id
--   idx_task_resources_task_id, idx_task_resources_project_id
-- ============================================================


-- ============================================================
-- SECTION 1: projects
-- Consultas frecuentes: por org_id, status, deleted_at
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_org_id
  ON projects(org_id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_org_status
  ON projects(org_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_updated_at
  ON projects(updated_at);


-- ============================================================
-- SECTION 2: tasks
-- Consultas frecuentes: por project+type, sort_order, EVM (percent_complete),
-- fechas reales (actual_start, actual_finish)
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_project_type
  ON tasks(project_id, type)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_project_sort
  ON tasks(project_id, sort_order)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_project_percent
  ON tasks(project_id, percent_complete)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tasks_project_dates
  ON tasks(project_id, actual_start, actual_finish)
  WHERE deleted_at IS NULL;


-- ============================================================
-- SECTION 3: task_dependencies
-- Consultas de ruta crítica (CPM): por predecesor, sucesor, tipo
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_deps_pred
  ON task_dependencies(pred_id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_deps_succ
  ON task_dependencies(succ_id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_deps_proj_type
  ON task_dependencies(project_id, type)
  WHERE deleted_at IS NULL;


-- ============================================================
-- SECTION 4: baselines / baseline_tasks
-- Consultas de comparación de línea base
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_baselines_project
  ON baselines(project_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_baseline_tasks_baseline
  ON baseline_tasks(baseline_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_baseline_tasks_task
  ON baseline_tasks(task_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_baseline_tasks_proj_base
  ON baseline_tasks(project_id, baseline_id);


-- ============================================================
-- SECTION 5: task_resources
-- Consultas de nivelación de recursos: por resource_id
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_task_resources_resource
  ON task_resources(resource_id)
  WHERE deleted_at IS NULL;


-- ============================================================
-- SECTION 6: memberships
-- Consultas de autenticación y autorización
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memberships_user
  ON memberships(user_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memberships_org_user
  ON memberships(org_id, user_id);


-- ============================================================
-- SECTION 7: portfolios / programs
-- Consultas de dashboard por organización
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_portfolios_org
  ON portfolios(org_id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_programs_org
  ON programs(org_id)
  WHERE deleted_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_programs_portfolio
  ON programs(portfolio_id)
  WHERE deleted_at IS NULL;


-- ============================================================
-- SECTION 8: JSONB GIN indexes
-- Para consultas sobre columnas JSONB (settings)
-- Nota: tasks no tiene columna settings — omitida.
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_settings_gin
  ON projects USING gin(settings jsonb_path_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_portfolios_settings_gin
  ON portfolios USING gin(settings jsonb_path_ops);


-- ============================================================
-- SECTION 9: Rollback
-- Descomentar y ejecutar para eliminar todos los índices creados
-- arriba (en orden inverso al de creación).
-- ============================================================

-- DROP INDEX CONCURRENTLY IF EXISTS idx_portfolios_settings_gin;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_projects_settings_gin;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_programs_portfolio;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_programs_org;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_portfolios_org;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_memberships_org_user;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_memberships_user;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_task_resources_resource;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_baseline_tasks_proj_base;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_baseline_tasks_task;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_baseline_tasks_baseline;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_baselines_project;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_task_deps_proj_type;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_task_deps_succ;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_task_deps_pred;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_tasks_project_dates;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_tasks_project_percent;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_tasks_project_sort;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_tasks_project_type;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_projects_updated_at;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_projects_org_status;
-- DROP INDEX CONCURRENTLY IF EXISTS idx_projects_org_id;


-- ============================================================
-- SECTION 10: ANALYZE
-- Actualizar estadísticas tras crear índices
-- ============================================================

ANALYZE projects;
ANALYZE tasks;
ANALYZE task_dependencies;
ANALYZE task_resources;
ANALYZE baselines;
ANALYZE baseline_tasks;
ANALYZE memberships;
ANALYZE portfolios;
ANALYZE programs;
