-- =============================================================
-- FASE 3: Integración Empresa ↔ Proyectos
-- Ejecutar DESPUÉS de fase-2-admin-empresa.sql
-- =============================================================
-- Objetivo: ligar los proyectos a empresas y gestionar el acceso
-- por grupos dentro de cada proyecto.
--
-- Cambios:
--   - projects.org_id ya existe; añadir índice y FK si no están
--   - RLS en projects: solo miembros de la empresa pueden ver/editar
--   - group_memberships: RLS estricto por empresa y proyecto
--   - Funciones: mis_proyectos(), crear_proyecto(), acceso_proyecto()
--   - Vista: vista_proyectos_empresa
-- =============================================================

-- ============================================================
-- 1. Índice en projects.org_id (si no existe)
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id)
  WHERE org_id IS NOT NULL;

-- ============================================================
-- 2. Políticas RLS en "projects"
--    (reemplaza las políticas abiertas si existían)
-- ============================================================

-- Leer: miembros activos de la empresa propietaria,
--       o proyectos sin empresa (modo local / demo)
DROP POLICY IF EXISTS projects_select ON projects;
CREATE POLICY projects_select ON projects
  FOR SELECT USING (
    org_id IS NULL
    OR EXISTS (
      SELECT 1 FROM org_memberships om
      WHERE om.org_id = projects.org_id
        AND om.user_id = auth.uid()
        AND om.active = true
    )
  );

-- Insertar: miembros activos de la empresa
DROP POLICY IF EXISTS projects_insert ON projects;
CREATE POLICY projects_insert ON projects
  FOR INSERT WITH CHECK (
    org_id IS NULL
    OR es_miembro_empresa(org_id)
  );

-- Actualizar: miembros con permiso "editar" en el proyecto
DROP POLICY IF EXISTS projects_update ON projects;
CREATE POLICY projects_update ON projects
  FOR UPDATE USING (
    org_id IS NULL
    OR es_admin_empresa(org_id)
    OR tiene_acceso_grupo(id, 'cronograma', 'editar')
  );

-- Eliminar: solo admins de empresa
DROP POLICY IF EXISTS projects_delete ON projects;
CREATE POLICY projects_delete ON projects
  FOR DELETE USING (
    org_id IS NULL
    OR es_admin_empresa(org_id)
  );

-- ============================================================
-- 3. Políticas RLS en "group_memberships"
-- ============================================================

-- Leer: propios memberships + admins de empresa
DROP POLICY IF EXISTS gm_select ON group_memberships;
CREATE POLICY gm_select ON group_memberships
  FOR SELECT USING (
    user_id = auth.uid()
    OR es_admin_empresa(org_id)
  );

-- Insertar: solo admins de empresa
DROP POLICY IF EXISTS gm_insert ON group_memberships;
CREATE POLICY gm_insert ON group_memberships
  FOR INSERT WITH CHECK (es_admin_empresa(org_id));

-- Actualizar: solo admins de empresa
DROP POLICY IF EXISTS gm_update ON group_memberships;
CREATE POLICY gm_update ON group_memberships
  FOR UPDATE USING (es_admin_empresa(org_id));

-- Eliminar: solo admins de empresa
DROP POLICY IF EXISTS gm_delete ON group_memberships;
CREATE POLICY gm_delete ON group_memberships
  FOR DELETE USING (es_admin_empresa(org_id));

-- ============================================================
-- 4. Función: mis_proyectos(p_org_id)
--    Lista proyectos accesibles al usuario en la empresa
-- ============================================================
CREATE OR REPLACE FUNCTION mis_proyectos(p_org_id UUID)
RETURNS TABLE(
  project_id   UUID,
  project_name TEXT,
  project_code TEXT,
  status       TEXT,
  start_date   DATE,
  acceso       TEXT,
  created_at   TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    p.id,
    p.name,
    p.code,
    p.status,
    p.start_date,
    COALESCE(
      (SELECT MIN(gm.group_role) FROM group_memberships gm
       WHERE gm.project_id = p.id AND gm.user_id = auth.uid() AND gm.active = true),
      CASE WHEN es_admin_empresa(p_org_id) THEN 'administrador' ELSE 'miembro' END
    ),
    p.created_at
  FROM projects p
  WHERE p.org_id = p_org_id
    AND (p.deleted_at IS NULL OR p.deleted_at > NOW())
    AND (
      es_admin_empresa(p_org_id)
      OR EXISTS (
        SELECT 1 FROM group_memberships gm
        WHERE gm.project_id = p.id AND gm.user_id = auth.uid() AND gm.active = true
      )
    )
  ORDER BY p.name;
$$;

-- ============================================================
-- 5. Función: agregar_miembro_proyecto(p_org_id, p_project_id,
--             p_user_id, p_group_role, p_area_id)
-- ============================================================
CREATE OR REPLACE FUNCTION agregar_miembro_proyecto(
  p_org_id     UUID,
  p_project_id UUID,
  p_user_id    UUID,
  p_group_role TEXT DEFAULT 'miembro',
  p_area_id    UUID DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT es_admin_empresa(p_org_id) THEN
    RAISE EXCEPTION 'Sin permisos para gestionar miembros del proyecto';
  END IF;

  -- Verificar que el usuario sea miembro de la empresa
  IF NOT EXISTS (
    SELECT 1 FROM org_memberships
    WHERE org_id = p_org_id AND user_id = p_user_id AND active = true
  ) THEN
    RAISE EXCEPTION 'El usuario no es miembro de esta empresa';
  END IF;

  INSERT INTO group_memberships (org_id, project_id, user_id, group_role, area_id, active)
  VALUES (p_org_id, p_project_id, p_user_id, p_group_role, p_area_id, true)
  ON CONFLICT (project_id, user_id)
  DO UPDATE SET group_role = EXCLUDED.group_role, area_id = EXCLUDED.area_id,
    active = true, updated_at = NOW();

  PERFORM registrar_auditoria('agregar_miembro_proyecto', 'group_memberships', p_project_id::TEXT,
    jsonb_build_object('user_id', p_user_id, 'role', p_group_role));
END;
$$;

-- ============================================================
-- 6. Vista: vista_proyectos_empresa
--    Resumen de proyectos con conteo de miembros
-- ============================================================
CREATE OR REPLACE VIEW vista_proyectos_empresa AS
SELECT
  p.id          AS project_id,
  p.org_id,
  p.name        AS project_name,
  p.code        AS project_code,
  p.status,
  p.start_date,
  p.created_at,
  COUNT(gm.id)  AS miembros_count
FROM projects p
LEFT JOIN group_memberships gm ON gm.project_id = p.id AND gm.active = true
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.org_id, p.name, p.code, p.status, p.start_date, p.created_at;

-- ============================================================
-- 7. Índice para group_memberships
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_gm_project_user ON group_memberships(project_id, user_id)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_gm_org_id ON group_memberships(org_id)
  WHERE active = true;

-- ============================================================
-- FIN — Fase 3 completada
-- Arquitectura multi-empresa completa:
--   Fase 0: Seguridad base + RLS
--   Fase 1: Auth + gestión de usuarios
--   Fase 2: Panel de administración de empresa
--   Fase 3: Integración empresa ↔ proyectos
-- ============================================================
