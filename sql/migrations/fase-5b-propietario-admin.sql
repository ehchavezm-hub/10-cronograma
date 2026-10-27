-- =============================================================
-- FASE 5b: El propietario de la plataforma también administra
-- las áreas, permisos y miembros de proyecto de cualquier empresa
-- (aunque no sea miembro de ella). Solo cambia las reglas de las
-- tablas nuevas de la fase 5.
-- =============================================================

CREATE OR REPLACE FUNCTION es_admin_o_propietario(p_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public' AS $$
  SELECT es_admin_empresa(p_org_id) OR es_propietario_plataforma();
$$;

DROP POLICY IF EXISTS areas_select ON areas;
CREATE POLICY areas_select ON areas FOR SELECT USING (es_miembro_empresa(org_id) OR es_propietario_plataforma());
DROP POLICY IF EXISTS areas_insert ON areas;
CREATE POLICY areas_insert ON areas FOR INSERT WITH CHECK (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS areas_update ON areas;
CREATE POLICY areas_update ON areas FOR UPDATE USING (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS areas_delete ON areas;
CREATE POLICY areas_delete ON areas FOR DELETE USING (es_admin_o_propietario(org_id) AND NOT is_default);

DROP POLICY IF EXISTS permisos_select ON permisos;
CREATE POLICY permisos_select ON permisos FOR SELECT USING (es_miembro_empresa(org_id) OR es_propietario_plataforma());
DROP POLICY IF EXISTS permisos_insert ON permisos;
CREATE POLICY permisos_insert ON permisos FOR INSERT WITH CHECK (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS permisos_update ON permisos;
CREATE POLICY permisos_update ON permisos FOR UPDATE USING (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS permisos_delete ON permisos;
CREATE POLICY permisos_delete ON permisos FOR DELETE USING (es_admin_o_propietario(org_id));

DROP POLICY IF EXISTS gm_select ON group_memberships;
CREATE POLICY gm_select ON group_memberships FOR SELECT
  USING (user_id = auth.uid() OR es_admin_o_propietario(org_id) OR es_admin_grupo(project_id));
DROP POLICY IF EXISTS gm_insert ON group_memberships;
CREATE POLICY gm_insert ON group_memberships FOR INSERT WITH CHECK (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS gm_update ON group_memberships;
CREATE POLICY gm_update ON group_memberships FOR UPDATE USING (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS gm_delete ON group_memberships;
CREATE POLICY gm_delete ON group_memberships FOR DELETE USING (es_admin_o_propietario(org_id));

DROP POLICY IF EXISTS auditoria_select ON auditoria;
CREATE POLICY auditoria_select ON auditoria FOR SELECT
  USING (user_id = auth.uid() OR es_admin_o_propietario(org_id));
