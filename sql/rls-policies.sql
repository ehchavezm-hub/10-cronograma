-- =============================================================
-- ECM Project — Row Level Security Policies
-- Objetivo: aislamiento multitenant estricto por usuario/proyecto
-- Aplicar en Supabase > SQL Editor o como migración numerada
-- =============================================================

-- ----------------------------------------------------------------
-- HELPER: función que retorna los project_id accesibles por el
-- usuario autenticado. Usa SECURITY INVOKER para que corra con
-- los permisos del llamante (no del propietario de la función).
-- ----------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_project_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY INVOKER
AS $$
  SELECT id FROM projects WHERE owner_id = auth.uid();
$$;

-- ================================================================
-- TABLA: projects
-- ================================================================
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;

-- Solo el propietario puede ver sus proyectos
CREATE POLICY "projects_select_owner"
  ON projects FOR SELECT
  USING (owner_id = auth.uid());

-- Solo el usuario autenticado puede insertar proyectos propios
CREATE POLICY "projects_insert_owner"
  ON projects FOR INSERT
  WITH CHECK (owner_id = auth.uid());

-- Solo el propietario puede actualizar su proyecto
CREATE POLICY "projects_update_owner"
  ON projects FOR UPDATE
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- Solo el propietario puede eliminar su proyecto
CREATE POLICY "projects_delete_owner"
  ON projects FOR DELETE
  USING (owner_id = auth.uid());

-- ================================================================
-- TABLA: tasks
-- ================================================================
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY "tasks_select_owner"
  ON tasks FOR SELECT
  USING (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "tasks_insert_owner"
  ON tasks FOR INSERT
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "tasks_update_owner"
  ON tasks FOR UPDATE
  USING (project_id IN (SELECT auth_project_ids()))
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "tasks_delete_owner"
  ON tasks FOR DELETE
  USING (project_id IN (SELECT auth_project_ids()));

-- ================================================================
-- TABLA: resources
-- ================================================================
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;

CREATE POLICY "resources_select_owner"
  ON resources FOR SELECT
  USING (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "resources_insert_owner"
  ON resources FOR INSERT
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "resources_update_owner"
  ON resources FOR UPDATE
  USING (project_id IN (SELECT auth_project_ids()))
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "resources_delete_owner"
  ON resources FOR DELETE
  USING (project_id IN (SELECT auth_project_ids()));

-- ================================================================
-- TABLA: task_resources
-- ================================================================
ALTER TABLE task_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_resources FORCE ROW LEVEL SECURITY;

CREATE POLICY "task_resources_select_owner"
  ON task_resources FOR SELECT
  USING (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "task_resources_insert_owner"
  ON task_resources FOR INSERT
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "task_resources_update_owner"
  ON task_resources FOR UPDATE
  USING (project_id IN (SELECT auth_project_ids()))
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "task_resources_delete_owner"
  ON task_resources FOR DELETE
  USING (project_id IN (SELECT auth_project_ids()));

-- ================================================================
-- TABLA: wbs_nodes
-- ================================================================
ALTER TABLE wbs_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wbs_nodes FORCE ROW LEVEL SECURITY;

CREATE POLICY "wbs_nodes_select_owner"
  ON wbs_nodes FOR SELECT
  USING (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "wbs_nodes_insert_owner"
  ON wbs_nodes FOR INSERT
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "wbs_nodes_update_owner"
  ON wbs_nodes FOR UPDATE
  USING (project_id IN (SELECT auth_project_ids()))
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "wbs_nodes_delete_owner"
  ON wbs_nodes FOR DELETE
  USING (project_id IN (SELECT auth_project_ids()));

-- ================================================================
-- TABLA: baseline_tasks
-- ================================================================
ALTER TABLE baseline_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE baseline_tasks FORCE ROW LEVEL SECURITY;

CREATE POLICY "baseline_tasks_select_owner"
  ON baseline_tasks FOR SELECT
  USING (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "baseline_tasks_insert_owner"
  ON baseline_tasks FOR INSERT
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "baseline_tasks_update_owner"
  ON baseline_tasks FOR UPDATE
  USING (project_id IN (SELECT auth_project_ids()))
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "baseline_tasks_delete_owner"
  ON baseline_tasks FOR DELETE
  USING (project_id IN (SELECT auth_project_ids()));

-- ================================================================
-- TABLA: calendar_exceptions
-- ================================================================
ALTER TABLE calendar_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_exceptions FORCE ROW LEVEL SECURITY;

CREATE POLICY "calendar_exceptions_select_owner"
  ON calendar_exceptions FOR SELECT
  USING (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "calendar_exceptions_insert_owner"
  ON calendar_exceptions FOR INSERT
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "calendar_exceptions_update_owner"
  ON calendar_exceptions FOR UPDATE
  USING (project_id IN (SELECT auth_project_ids()))
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "calendar_exceptions_delete_owner"
  ON calendar_exceptions FOR DELETE
  USING (project_id IN (SELECT auth_project_ids()));

-- ================================================================
-- TABLA: risks
-- ================================================================
ALTER TABLE risks ENABLE ROW LEVEL SECURITY;
ALTER TABLE risks FORCE ROW LEVEL SECURITY;

CREATE POLICY "risks_select_owner"
  ON risks FOR SELECT
  USING (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "risks_insert_owner"
  ON risks FOR INSERT
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "risks_update_owner"
  ON risks FOR UPDATE
  USING (project_id IN (SELECT auth_project_ids()))
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

CREATE POLICY "risks_delete_owner"
  ON risks FOR DELETE
  USING (project_id IN (SELECT auth_project_ids()));

-- ================================================================
-- TABLA: change_log
-- ================================================================
ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_log FORCE ROW LEVEL SECURITY;

CREATE POLICY "change_log_select_owner"
  ON change_log FOR SELECT
  USING (project_id IN (SELECT auth_project_ids()));

-- El change_log solo admite INSERT (es inmutable por diseño)
CREATE POLICY "change_log_insert_owner"
  ON change_log FOR INSERT
  WITH CHECK (project_id IN (SELECT auth_project_ids()));

-- No se permiten UPDATE ni DELETE en el change_log (audit trail)

-- ================================================================
-- VERIFICACIÓN: lista todas las políticas activas
-- ================================================================
-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual
--   FROM pg_policies
--  WHERE schemaname = 'public'
--  ORDER BY tablename, cmd;
