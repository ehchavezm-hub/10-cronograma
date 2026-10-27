-- =============================================================
-- FASE 2: Panel de Administración de Empresa
-- Ejecutar DESPUÉS de fase-1-login-usuarios.sql
-- =============================================================
-- Mejoras sobre Fase 1:
--   - RLS estricto en tabla "areas" (solo admin empresa puede CRUD)
--   - RLS estricto en tabla "permisos" (solo admin empresa puede CRUD)
--   - Función helper: areas_empresa(p_org_id) — lista áreas de una empresa
--   - Función helper: permisos_empresa(p_org_id) — lista permisos plantilla empresa
--   - Función: crear_area(p_org_id, p_name, p_sort_order) — crear área con validación
--   - Función: set_permiso_empresa(p_org_id, p_area_id, p_modulo, p_nivel) — upsert de permiso
--   - Vista: vista_permisos_empresa — permisos plantilla a nivel empresa
-- =============================================================

-- ============================================================
-- 1. Políticas RLS para "areas"
-- ============================================================

-- Leer: cualquier miembro activo de la empresa
DROP POLICY IF EXISTS areas_select ON areas;
CREATE POLICY areas_select ON areas
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM org_memberships om
      WHERE om.org_id = areas.org_id
        AND om.user_id = auth.uid()
        AND om.active = true
    )
  );

-- Insertar: solo admins de la empresa
DROP POLICY IF EXISTS areas_insert ON areas;
CREATE POLICY areas_insert ON areas
  FOR INSERT WITH CHECK (es_admin_empresa(org_id));

-- Actualizar: solo admins de la empresa
DROP POLICY IF EXISTS areas_update ON areas;
CREATE POLICY areas_update ON areas
  FOR UPDATE USING (es_admin_empresa(org_id));

-- Eliminar: solo admins de la empresa (no areas is_default)
DROP POLICY IF EXISTS areas_delete ON areas;
CREATE POLICY areas_delete ON areas
  FOR DELETE USING (es_admin_empresa(org_id) AND NOT is_default);

-- ============================================================
-- 2. Políticas RLS para "permisos"
-- ============================================================

-- Leer: cualquier miembro activo de la empresa
DROP POLICY IF EXISTS permisos_select ON permisos;
CREATE POLICY permisos_select ON permisos
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM org_memberships om
      WHERE om.org_id = permisos.org_id
        AND om.user_id = auth.uid()
        AND om.active = true
    )
  );

-- Insertar: solo admins
DROP POLICY IF EXISTS permisos_insert ON permisos;
CREATE POLICY permisos_insert ON permisos
  FOR INSERT WITH CHECK (es_admin_empresa(org_id));

-- Actualizar: solo admins
DROP POLICY IF EXISTS permisos_update ON permisos;
CREATE POLICY permisos_update ON permisos
  FOR UPDATE USING (es_admin_empresa(org_id));

-- Eliminar: solo admins
DROP POLICY IF EXISTS permisos_delete ON permisos;
CREATE POLICY permisos_delete ON permisos
  FOR DELETE USING (es_admin_empresa(org_id));

-- ============================================================
-- 3. Función: areas_empresa(p_org_id)
--    Lista las áreas configuradas de una empresa
-- ============================================================
CREATE OR REPLACE FUNCTION areas_empresa(p_org_id UUID)
RETURNS TABLE(
  id          UUID,
  name        TEXT,
  sort_order  INTEGER,
  is_default  BOOLEAN
) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT a.id, a.name, a.sort_order, a.is_default
  FROM areas a
  WHERE a.org_id = p_org_id
    AND es_miembro_empresa(p_org_id)
  ORDER BY a.sort_order, a.name;
$$;

-- ============================================================
-- 4. Función: crear_area(p_org_id, p_name, p_sort_order)
--    Crea un área nueva validando permisos y unicidad del nombre
-- ============================================================
CREATE OR REPLACE FUNCTION crear_area(
  p_org_id     UUID,
  p_name       TEXT,
  p_sort_order INTEGER DEFAULT 99
) RETURNS UUID LANGUAGE plpgsql SECURITY INVOKER AS $$
DECLARE
  v_id UUID;
BEGIN
  IF NOT es_admin_empresa(p_org_id) THEN
    RAISE EXCEPTION 'Sin permisos para gestionar áreas en esta empresa';
  END IF;

  IF EXISTS (SELECT 1 FROM areas WHERE org_id = p_org_id AND lower(name) = lower(trim(p_name))) THEN
    RAISE EXCEPTION 'Ya existe un área con ese nombre en esta empresa';
  END IF;

  INSERT INTO areas (org_id, name, sort_order, is_default)
  VALUES (p_org_id, trim(p_name), p_sort_order, false)
  RETURNING id INTO v_id;

  PERFORM registrar_auditoria('crear_area', 'areas', v_id::TEXT,
    jsonb_build_object('name', p_name, 'org_id', p_org_id));

  RETURN v_id;
END;
$$;

-- ============================================================
-- 5. Función: set_permiso_empresa(p_org_id, p_area_id, p_modulo, p_nivel)
--    Upsert de permiso plantilla a nivel empresa (project_id = null)
-- ============================================================
CREATE OR REPLACE FUNCTION set_permiso_empresa(
  p_org_id  UUID,
  p_area_id UUID,
  p_modulo  TEXT,
  p_nivel   TEXT
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT es_admin_empresa(p_org_id) THEN
    RAISE EXCEPTION 'Sin permisos para gestionar permisos en esta empresa';
  END IF;

  INSERT INTO permisos (org_id, area_id, project_id, modulo, nivel)
  VALUES (p_org_id, p_area_id, null, p_modulo, p_nivel)
  ON CONFLICT (org_id, area_id, modulo)
  DO UPDATE SET nivel = EXCLUDED.nivel, updated_at = NOW()
  WHERE permisos.project_id IS NULL;

  PERFORM registrar_auditoria('set_permiso', 'permisos', p_area_id::TEXT,
    jsonb_build_object('modulo', p_modulo, 'nivel', p_nivel));
END;
$$;

-- ============================================================
-- 6. Vista: vista_permisos_empresa
--    Permisos plantilla a nivel empresa (sin proyecto)
-- ============================================================
CREATE OR REPLACE VIEW vista_permisos_empresa AS
SELECT
  p.id,
  p.org_id,
  p.area_id,
  p.modulo,
  p.nivel,
  a.name AS area_name,
  a.sort_order AS area_sort_order,
  a.is_default
FROM permisos p
JOIN areas a ON a.id = p.area_id
WHERE p.project_id IS NULL;

-- ============================================================
-- 7. Índices adicionales para consultas de admin empresa
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_areas_org_id ON areas(org_id);
CREATE INDEX IF NOT EXISTS idx_permisos_org_area ON permisos(org_id, area_id) WHERE project_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_permisos_project ON permisos(project_id) WHERE project_id IS NOT NULL;

-- ============================================================
-- FIN — Fase 2 completada
-- Siguiente: Fase 3 — Selección de empresa + integración proyectos
-- ============================================================
