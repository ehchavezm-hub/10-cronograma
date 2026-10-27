-- =============================================================
-- FASE 0: Empresas y Seguridad — ECM Project Multiempresa v3
-- Ejecutar en Supabase > SQL Editor (orden importa por FK)
-- Ref: Esquema-Configuracion-ECM-Final-Multiempresa-v3.pptx
-- Decisiones validadas: 27/10/2026
-- =============================================================
-- Tres capas de permisos:
--   Plataforma  → platform_role en profiles (propietario / co_propietario)
--   Empresa     → org_memberships: super_admin / relevo / miembro / invitado_externo
--   Grupo       → group_memberships: administrador / miembro + área
-- Reemplaza las políticas anon_all_* (base totalmente abierta) por RLS
-- aislado por empresa y por grupo.
-- =============================================================

-- ============================================================
-- 0. Extensiones necesarias
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. Ampliar profiles — capa Plataforma
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS short_code   TEXT,
  ADD COLUMN IF NOT EXISTS cargo        TEXT,
  ADD COLUMN IF NOT EXISTS active       BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS platform_role TEXT NOT NULL DEFAULT 'ninguno'
    CHECK (platform_role IN ('propietario','co_propietario','ninguno'));

-- ============================================================
-- 2. Ampliar organizations — propietario y co-propietario
-- ============================================================
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS owner_id      UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS co_owner_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status        TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','deleted'));

-- ============================================================
-- 3. Tabla org_memberships — capa Empresa
--    (reemplaza/amplía la tabla memberships existente)
-- ============================================================
CREATE TABLE IF NOT EXISTS org_memberships (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  empresa_role  TEXT NOT NULL DEFAULT 'miembro'
    CHECK (empresa_role IN ('super_admin','relevo','miembro','invitado_externo','pendiente')),
  empresa_ext   TEXT,                   -- nombre de empresa para invitados externos
  active        BOOLEAN NOT NULL DEFAULT true,
  temp_password TEXT,                   -- clave temporal (hash); NULL = ya cambió
  invited_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ,            -- solo para invitados externos
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE TRIGGER trg_org_memberships_updated_at
  BEFORE UPDATE ON org_memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE org_memberships ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 4. Tabla areas — 11 áreas por empresa (plantilla editable)
-- ============================================================
CREATE TABLE IF NOT EXISTS areas (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_default  BOOLEAN NOT NULL DEFAULT false,  -- viene de la plantilla base
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE(org_id, name)
);

CREATE TRIGGER trg_areas_updated_at
  BEFORE UPDATE ON areas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE areas ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. Tabla group_memberships — capa Grupo (proyecto)
-- ============================================================
CREATE TABLE IF NOT EXISTS group_memberships (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  group_role    TEXT NOT NULL DEFAULT 'miembro'
    CHECK (group_role IN ('administrador','miembro')),
  area_id       UUID REFERENCES areas(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

CREATE TRIGGER trg_group_memberships_updated_at
  BEFORE UPDATE ON group_memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE group_memberships ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 6. Tabla permisos — área × módulo (4 niveles)
--    Una fila por (org_id, area_id, modulo)
--    project_id NULL = plantilla de empresa; NOT NULL = ajuste por grupo
-- ============================================================
CREATE TABLE IF NOT EXISTS permisos (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  area_id     UUID NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  project_id  UUID REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = plantilla empresa
  modulo      TEXT NOT NULL,
  nivel       TEXT NOT NULL DEFAULT 'solo_ver'
    CHECK (nivel IN ('editar','solo_avance','solo_ver','sin_acceso')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, area_id, modulo, project_id)
);

CREATE TRIGGER trg_permisos_updated_at
  BEFORE UPDATE ON permisos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE permisos ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 7. Tabla auditoria — registro de acciones
-- ============================================================
CREATE TABLE IF NOT EXISTS auditoria (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID REFERENCES organizations(id) ON DELETE SET NULL,
  user_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  accion      TEXT NOT NULL,           -- 'crear_usuario', 'cambiar_rol', etc.
  tabla       TEXT,
  registro_id TEXT,
  detalle     JSONB NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auditoria_org_id    ON auditoria(org_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_user_id   ON auditoria(user_id);
CREATE INDEX IF NOT EXISTS idx_auditoria_created_at ON auditoria(created_at DESC);

ALTER TABLE auditoria ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 8. Tabla acceso_soporte — permisos de soporte temporales
-- ============================================================
CREATE TABLE IF NOT EXISTS acceso_soporte (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id       UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  granted_by   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  support_user UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE acceso_soporte ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 9. Función helpers de seguridad
-- ============================================================

-- Retorna true si el usuario actual es propietario o co-propietario de la plataforma
CREATE OR REPLACE FUNCTION es_propietario_plataforma()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND platform_role IN ('propietario','co_propietario')
  );
$$;

-- Retorna el rol del usuario actual en la empresa dada
CREATE OR REPLACE FUNCTION rol_en_empresa(p_org_id UUID)
RETURNS TEXT LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT empresa_role FROM org_memberships
  WHERE org_id = p_org_id AND user_id = auth.uid() AND active = true
  LIMIT 1;
$$;

-- Retorna true si el usuario actual es super_admin o relevo de la empresa
CREATE OR REPLACE FUNCTION es_admin_empresa(p_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT COALESCE(rol_en_empresa(p_org_id) IN ('super_admin','relevo'), false);
$$;

-- Retorna true si el usuario actual pertenece a la empresa (cualquier rol activo)
CREATE OR REPLACE FUNCTION es_miembro_empresa(p_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_memberships
    WHERE org_id = p_org_id AND user_id = auth.uid() AND active = true
  );
$$;

-- Retorna true si el usuario actual tiene acceso al proyecto (como miembro de grupo)
CREATE OR REPLACE FUNCTION tiene_acceso_grupo(p_project_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT EXISTS (
    SELECT 1 FROM group_memberships gm
    JOIN projects p ON p.id = gm.project_id
    WHERE gm.project_id = p_project_id
      AND gm.user_id = auth.uid()
      AND es_miembro_empresa(p.org_id)
  );
$$;

-- Función principal: puede(accion, modulo, project_id)
-- Retorna true si el usuario actual tiene el nivel mínimo requerido
-- niveles: sin_acceso < solo_ver < solo_avance < editar
CREATE OR REPLACE FUNCTION puede(
  p_accion   TEXT,   -- 'ver', 'avance', 'editar', 'admin_grupo', 'admin_empresa'
  p_modulo   TEXT,   -- nombre del módulo (puede ser NULL para acciones de admin)
  p_proj_id  UUID    -- NULL para acciones de empresa/plataforma
) RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY INVOKER AS $$
DECLARE
  v_org_id UUID;
  v_area_id UUID;
  v_nivel TEXT;
  v_nivel_req TEXT;
BEGIN
  -- Plataforma siempre puede todo
  IF es_propietario_plataforma() THEN RETURN true; END IF;

  -- Obtener org_id del proyecto si se dio
  IF p_proj_id IS NOT NULL THEN
    SELECT org_id INTO v_org_id FROM projects WHERE id = p_proj_id AND deleted_at IS NULL;
    IF v_org_id IS NULL THEN RETURN false; END IF;
  END IF;

  -- Acciones de administración de empresa
  IF p_accion = 'admin_empresa' THEN
    RETURN es_admin_empresa(v_org_id);
  END IF;

  -- Para módulos: verificar acceso al grupo
  IF p_proj_id IS NOT NULL THEN
    IF NOT tiene_acceso_grupo(p_proj_id) THEN RETURN false; END IF;

    -- Administrador del grupo puede todo en su grupo
    IF EXISTS (
      SELECT 1 FROM group_memberships
      WHERE project_id = p_proj_id AND user_id = auth.uid() AND group_role = 'administrador'
    ) THEN RETURN true; END IF;

    -- Obtener área del usuario en este grupo
    SELECT area_id INTO v_area_id
    FROM group_memberships
    WHERE project_id = p_proj_id AND user_id = auth.uid();

    IF v_area_id IS NULL THEN RETURN false; END IF;

    -- Obtener nivel del permiso (ajuste de grupo primero, luego plantilla de empresa)
    SELECT nivel INTO v_nivel FROM permisos
    WHERE area_id = v_area_id AND modulo = p_modulo
      AND (project_id = p_proj_id OR project_id IS NULL)
    ORDER BY project_id NULLS LAST
    LIMIT 1;

    IF v_nivel IS NULL OR v_nivel = 'sin_acceso' THEN RETURN false; END IF;

    -- Verificar nivel mínimo requerido
    v_nivel_req := CASE p_accion
      WHEN 'ver'    THEN 'solo_ver'
      WHEN 'avance' THEN 'solo_avance'
      WHEN 'editar' THEN 'editar'
      ELSE 'editar'
    END;

    RETURN CASE v_nivel_req
      WHEN 'solo_ver'    THEN v_nivel IN ('solo_ver','solo_avance','editar')
      WHEN 'solo_avance' THEN v_nivel IN ('solo_avance','editar')
      WHEN 'editar'      THEN v_nivel = 'editar'
      ELSE false
    END;
  END IF;

  RETURN false;
END;
$$;

-- ============================================================
-- 10. Seed: 11 áreas plantilla base (se copian al crear empresa)
-- ============================================================
CREATE TABLE IF NOT EXISTS areas_plantilla (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  sort_order  INT NOT NULL
);

INSERT INTO areas_plantilla (name, sort_order) VALUES
  ('Oficina Técnica',             1),
  ('Planificación',               2),
  ('Costos',                      3),
  ('Calidad',                     4),
  ('Administración de Contratos', 5),
  ('Administración de Obra',      6),
  ('Seguridad',                   7),
  ('Servicios Generales',         8),
  ('Almacén',                     9),
  ('Ingeniería',                 10),
  ('Otros',                      11)
ON CONFLICT (name) DO NOTHING;

-- Permisos base por área (plantilla inicial — editable por cada empresa)
-- Módulos: cronograma | calendarios | lineas_base | lookahead | evm | riesgos | reportes
-- Esta tabla es la fuente para copiar al crear una empresa nueva.
CREATE TABLE IF NOT EXISTS permisos_plantilla (
  id          SERIAL PRIMARY KEY,
  area_name   TEXT NOT NULL REFERENCES areas_plantilla(name),
  modulo      TEXT NOT NULL,
  nivel       TEXT NOT NULL CHECK (nivel IN ('editar','solo_avance','solo_ver','sin_acceso')),
  UNIQUE(area_name, modulo)
);

INSERT INTO permisos_plantilla (area_name, modulo, nivel) VALUES
  -- Oficina Técnica
  ('Oficina Técnica','cronograma',   'editar'),
  ('Oficina Técnica','calendarios',  'editar'),
  ('Oficina Técnica','lineas_base',  'solo_ver'),
  ('Oficina Técnica','lookahead',    'editar'),
  ('Oficina Técnica','evm',          'solo_ver'),
  ('Oficina Técnica','riesgos',      'solo_ver'),
  ('Oficina Técnica','reportes',     'solo_ver'),
  -- Planificación
  ('Planificación','cronograma',    'editar'),
  ('Planificación','calendarios',   'editar'),
  ('Planificación','lineas_base',   'editar'),
  ('Planificación','lookahead',     'editar'),
  ('Planificación','evm',           'solo_ver'),
  ('Planificación','riesgos',       'editar'),
  ('Planificación','reportes',      'solo_ver'),
  -- Costos
  ('Costos','cronograma',    'solo_ver'),
  ('Costos','calendarios',   'solo_ver'),
  ('Costos','lineas_base',   'solo_ver'),
  ('Costos','lookahead',     'solo_ver'),
  ('Costos','evm',           'editar'),
  ('Costos','riesgos',       'solo_ver'),
  ('Costos','reportes',      'solo_ver'),
  -- Calidad
  ('Calidad','cronograma',    'solo_ver'),
  ('Calidad','calendarios',   'sin_acceso'),
  ('Calidad','lineas_base',   'sin_acceso'),
  ('Calidad','lookahead',     'solo_ver'),
  ('Calidad','evm',           'sin_acceso'),
  ('Calidad','riesgos',       'editar'),
  ('Calidad','reportes',      'solo_ver'),
  -- Administración de Contratos
  ('Administración de Contratos','cronograma',   'solo_ver'),
  ('Administración de Contratos','calendarios',  'solo_ver'),
  ('Administración de Contratos','lineas_base',  'solo_ver'),
  ('Administración de Contratos','lookahead',    'solo_ver'),
  ('Administración de Contratos','evm',          'editar'),
  ('Administración de Contratos','riesgos',      'editar'),
  ('Administración de Contratos','reportes',     'solo_ver'),
  -- Administración de Obra
  ('Administración de Obra','cronograma',   'solo_avance'),
  ('Administración de Obra','calendarios',  'solo_ver'),
  ('Administración de Obra','lineas_base',  'solo_ver'),
  ('Administración de Obra','lookahead',    'editar'),
  ('Administración de Obra','evm',          'solo_ver'),
  ('Administración de Obra','riesgos',      'solo_ver'),
  ('Administración de Obra','reportes',     'solo_ver'),
  -- Seguridad
  ('Seguridad','cronograma',   'solo_ver'),
  ('Seguridad','calendarios',  'sin_acceso'),
  ('Seguridad','lineas_base',  'sin_acceso'),
  ('Seguridad','lookahead',    'solo_ver'),
  ('Seguridad','evm',          'sin_acceso'),
  ('Seguridad','riesgos',      'editar'),
  ('Seguridad','reportes',     'solo_ver'),
  -- Servicios Generales
  ('Servicios Generales','cronograma',   'solo_ver'),
  ('Servicios Generales','calendarios',  'sin_acceso'),
  ('Servicios Generales','lineas_base',  'sin_acceso'),
  ('Servicios Generales','lookahead',    'solo_ver'),
  ('Servicios Generales','evm',          'sin_acceso'),
  ('Servicios Generales','riesgos',      'sin_acceso'),
  ('Servicios Generales','reportes',     'solo_ver'),
  -- Almacén
  ('Almacén','cronograma',   'solo_ver'),
  ('Almacén','calendarios',  'solo_ver'),
  ('Almacén','lineas_base',  'sin_acceso'),
  ('Almacén','lookahead',    'solo_ver'),
  ('Almacén','evm',          'sin_acceso'),
  ('Almacén','riesgos',      'sin_acceso'),
  ('Almacén','reportes',     'solo_ver'),
  -- Ingeniería
  ('Ingeniería','cronograma',   'solo_avance'),
  ('Ingeniería','calendarios',  'solo_ver'),
  ('Ingeniería','lineas_base',  'solo_ver'),
  ('Ingeniería','lookahead',    'solo_ver'),
  ('Ingeniería','evm',          'sin_acceso'),
  ('Ingeniería','riesgos',      'solo_ver'),
  ('Ingeniería','reportes',     'solo_ver'),
  -- Otros
  ('Otros','cronograma',   'solo_ver'),
  ('Otros','calendarios',  'solo_ver'),
  ('Otros','lineas_base',  'solo_ver'),
  ('Otros','lookahead',    'solo_ver'),
  ('Otros','evm',          'solo_ver'),
  ('Otros','riesgos',      'solo_ver'),
  ('Otros','reportes',     'solo_ver')
ON CONFLICT (area_name, modulo) DO NOTHING;

-- ============================================================
-- 11. Función: crear empresa nueva con plantilla de 11 áreas
-- ============================================================
CREATE OR REPLACE FUNCTION crear_empresa(
  p_name      TEXT,
  p_slug      TEXT,
  p_owner_id  UUID  -- super_admin inicial de la empresa
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_org_id UUID;
  v_area_id UUID;
  r_area RECORD;
  r_perm RECORD;
BEGIN
  -- Crear la organización
  INSERT INTO organizations (name, slug, owner_id, status)
  VALUES (p_name, p_slug, p_owner_id, 'active')
  RETURNING id INTO v_org_id;

  -- Copiar las 11 áreas plantilla
  FOR r_area IN SELECT * FROM areas_plantilla ORDER BY sort_order LOOP
    INSERT INTO areas (org_id, name, sort_order, is_default)
    VALUES (v_org_id, r_area.name, r_area.sort_order, true)
    RETURNING id INTO v_area_id;

    -- Copiar los permisos de esa área
    FOR r_perm IN SELECT * FROM permisos_plantilla WHERE area_name = r_area.name LOOP
      INSERT INTO permisos (org_id, area_id, project_id, modulo, nivel)
      VALUES (v_org_id, v_area_id, NULL, r_perm.modulo, r_perm.nivel);
    END LOOP;
  END LOOP;

  -- Asignar al creador como super_admin de la empresa
  INSERT INTO org_memberships (org_id, user_id, empresa_role, active)
  VALUES (v_org_id, p_owner_id, 'super_admin', true);

  RETURN v_org_id;
END;
$$;

-- ============================================================
-- 12. RLS — Nuevas políticas por empresa (reemplaza anon_all_*)
-- ============================================================

-- 12.1 organizations: solo miembros y propietario de plataforma
DROP POLICY IF EXISTS "anon_all_organizations" ON organizations;
DROP POLICY IF EXISTS "auth_all_organizations" ON organizations;

CREATE POLICY "org_select" ON organizations FOR SELECT
  USING (es_propietario_plataforma() OR es_miembro_empresa(id));

CREATE POLICY "org_insert" ON organizations FOR INSERT
  WITH CHECK (es_propietario_plataforma());

CREATE POLICY "org_update" ON organizations FOR UPDATE
  USING (es_propietario_plataforma() OR es_admin_empresa(id));

CREATE POLICY "org_delete" ON organizations FOR DELETE
  USING (es_propietario_plataforma());

-- 12.2 profiles: cada uno ve el suyo; admins ven los de su empresa
DROP POLICY IF EXISTS "anon_all_profiles" ON profiles;
DROP POLICY IF EXISTS "auth_all_profiles" ON profiles;

CREATE POLICY "profiles_select" ON profiles FOR SELECT
  USING (
    id = auth.uid()
    OR es_propietario_plataforma()
    OR EXISTS (
      SELECT 1 FROM org_memberships om1
      JOIN org_memberships om2 ON om2.org_id = om1.org_id
      WHERE om1.user_id = auth.uid() AND om2.user_id = profiles.id
        AND om1.active = true
    )
  );

CREATE POLICY "profiles_insert" ON profiles FOR INSERT
  WITH CHECK (id = auth.uid() OR es_propietario_plataforma());

CREATE POLICY "profiles_update" ON profiles FOR UPDATE
  USING (id = auth.uid() OR es_propietario_plataforma());

-- 12.3 projects: miembros del grupo o admins de empresa
DROP POLICY IF EXISTS "anon_all_projects" ON projects;
DROP POLICY IF EXISTS "auth_all_projects" ON projects;

CREATE POLICY "projects_select" ON projects FOR SELECT
  USING (
    es_propietario_plataforma()
    OR es_admin_empresa(org_id)
    OR tiene_acceso_grupo(id)
  );

CREATE POLICY "projects_insert" ON projects FOR INSERT
  WITH CHECK (es_propietario_plataforma() OR es_admin_empresa(org_id));

CREATE POLICY "projects_update" ON projects FOR UPDATE
  USING (es_propietario_plataforma() OR es_admin_empresa(org_id)
         OR (tiene_acceso_grupo(id) AND EXISTS (
           SELECT 1 FROM group_memberships
           WHERE project_id = projects.id AND user_id = auth.uid() AND group_role = 'administrador'
         )));

CREATE POLICY "projects_delete" ON projects FOR DELETE
  USING (es_propietario_plataforma() OR es_admin_empresa(org_id));

-- 12.4 tasks: miembros del grupo según nivel de permiso
DROP POLICY IF EXISTS "anon_all_tasks" ON tasks;
DROP POLICY IF EXISTS "auth_all_tasks" ON tasks;

CREATE POLICY "tasks_select" ON tasks FOR SELECT
  USING (puede('ver', 'cronograma', project_id));

CREATE POLICY "tasks_insert" ON tasks FOR INSERT
  WITH CHECK (puede('editar', 'cronograma', project_id));

CREATE POLICY "tasks_update" ON tasks FOR UPDATE
  USING (puede('avance', 'cronograma', project_id));

CREATE POLICY "tasks_delete" ON tasks FOR DELETE
  USING (puede('editar', 'cronograma', project_id));

-- 12.5 calendars
DROP POLICY IF EXISTS "anon_all_calendars" ON calendars;
DROP POLICY IF EXISTS "auth_all_calendars" ON calendars;

CREATE POLICY "calendars_select" ON calendars FOR SELECT
  USING (puede('ver', 'calendarios', project_id) OR es_admin_empresa(org_id));

CREATE POLICY "calendars_insert" ON calendars FOR INSERT
  WITH CHECK (puede('editar', 'calendarios', project_id) OR es_admin_empresa(org_id));

CREATE POLICY "calendars_update" ON calendars FOR UPDATE
  USING (puede('editar', 'calendarios', project_id) OR es_admin_empresa(org_id));

CREATE POLICY "calendars_delete" ON calendars FOR DELETE
  USING (puede('editar', 'calendarios', project_id) OR es_admin_empresa(org_id));

-- 12.6 org_memberships
CREATE POLICY "orgmem_select" ON org_memberships FOR SELECT
  USING (user_id = auth.uid() OR es_admin_empresa(org_id) OR es_propietario_plataforma());

CREATE POLICY "orgmem_insert" ON org_memberships FOR INSERT
  WITH CHECK (es_admin_empresa(org_id) OR es_propietario_plataforma());

CREATE POLICY "orgmem_update" ON org_memberships FOR UPDATE
  USING (es_admin_empresa(org_id) OR es_propietario_plataforma());

CREATE POLICY "orgmem_delete" ON org_memberships FOR DELETE
  USING (es_admin_empresa(org_id) OR es_propietario_plataforma());

-- 12.7 areas
CREATE POLICY "areas_select" ON areas FOR SELECT
  USING (es_miembro_empresa(org_id));

CREATE POLICY "areas_insert" ON areas FOR INSERT
  WITH CHECK (es_admin_empresa(org_id));

CREATE POLICY "areas_update" ON areas FOR UPDATE
  USING (es_admin_empresa(org_id));

CREATE POLICY "areas_delete" ON areas FOR DELETE
  USING (es_admin_empresa(org_id));

-- 12.8 group_memberships
CREATE POLICY "groupmem_select" ON group_memberships FOR SELECT
  USING (user_id = auth.uid() OR es_admin_empresa(org_id)
         OR EXISTS (
           SELECT 1 FROM group_memberships gm2
           WHERE gm2.project_id = group_memberships.project_id
             AND gm2.user_id = auth.uid() AND gm2.group_role = 'administrador'
         ));

CREATE POLICY "groupmem_insert" ON group_memberships FOR INSERT
  WITH CHECK (es_admin_empresa(org_id)
              OR EXISTS (
                SELECT 1 FROM group_memberships gm2
                WHERE gm2.project_id = group_memberships.project_id
                  AND gm2.user_id = auth.uid() AND gm2.group_role = 'administrador'
              ));

CREATE POLICY "groupmem_update" ON group_memberships FOR UPDATE
  USING (es_admin_empresa(org_id));

CREATE POLICY "groupmem_delete" ON group_memberships FOR DELETE
  USING (es_admin_empresa(org_id));

-- 12.9 permisos
CREATE POLICY "permisos_select" ON permisos FOR SELECT
  USING (es_miembro_empresa(org_id));

CREATE POLICY "permisos_insert" ON permisos FOR INSERT
  WITH CHECK (es_admin_empresa(org_id));

CREATE POLICY "permisos_update" ON permisos FOR UPDATE
  USING (es_admin_empresa(org_id));

CREATE POLICY "permisos_delete" ON permisos FOR DELETE
  USING (es_admin_empresa(org_id));

-- 12.10 auditoria (solo insertar y leer los propios; admin ve todo)
CREATE POLICY "auditoria_select" ON auditoria FOR SELECT
  USING (user_id = auth.uid() OR es_admin_empresa(org_id) OR es_propietario_plataforma());

CREATE POLICY "auditoria_insert" ON auditoria FOR INSERT
  WITH CHECK (true);  -- cualquier usuario autenticado puede insertar

-- 12.11 acceso_soporte
CREATE POLICY "soporte_select" ON acceso_soporte FOR SELECT
  USING (es_propietario_plataforma() OR granted_by = auth.uid() OR support_user = auth.uid());

CREATE POLICY "soporte_insert" ON acceso_soporte FOR INSERT
  WITH CHECK (granted_by = auth.uid() AND es_miembro_empresa(org_id));

CREATE POLICY "soporte_update" ON acceso_soporte FOR UPDATE
  USING (granted_by = auth.uid());

-- 12.12 Tablas de datos restantes (baselines, resources, etc.)
-- Aplicar RLS por acceso al grupo

DROP POLICY IF EXISTS "anon_all_resources" ON resources;
DROP POLICY IF EXISTS "auth_all_resources" ON resources;
CREATE POLICY "resources_select" ON resources FOR SELECT USING (es_miembro_empresa(org_id));
CREATE POLICY "resources_insert" ON resources FOR INSERT WITH CHECK (puede('editar','calendarios', NULL) OR es_admin_empresa(org_id));
CREATE POLICY "resources_update" ON resources FOR UPDATE USING (es_admin_empresa(org_id));
CREATE POLICY "resources_delete" ON resources FOR DELETE USING (es_admin_empresa(org_id));

DROP POLICY IF EXISTS "anon_all_task_resources" ON task_resources;
DROP POLICY IF EXISTS "auth_all_task_resources" ON task_resources;
CREATE POLICY "task_resources_select" ON task_resources FOR SELECT USING (puede('ver','cronograma', project_id));
CREATE POLICY "task_resources_insert" ON task_resources FOR INSERT WITH CHECK (puede('editar','cronograma', project_id));
CREATE POLICY "task_resources_update" ON task_resources FOR UPDATE USING (puede('editar','cronograma', project_id));
CREATE POLICY "task_resources_delete" ON task_resources FOR DELETE USING (puede('editar','cronograma', project_id));

DROP POLICY IF EXISTS "anon_all_baselines" ON baselines;
DROP POLICY IF EXISTS "auth_all_baselines" ON baselines;
CREATE POLICY "baselines_select" ON baselines FOR SELECT USING (puede('ver','lineas_base', project_id));
CREATE POLICY "baselines_insert" ON baselines FOR INSERT WITH CHECK (puede('editar','lineas_base', project_id));
CREATE POLICY "baselines_update" ON baselines FOR UPDATE USING (puede('editar','lineas_base', project_id));
CREATE POLICY "baselines_delete" ON baselines FOR DELETE USING (puede('editar','lineas_base', project_id));

DROP POLICY IF EXISTS "anon_all_baseline_tasks" ON baseline_tasks;
DROP POLICY IF EXISTS "auth_all_baseline_tasks" ON baseline_tasks;
CREATE POLICY "baseline_tasks_select" ON baseline_tasks FOR SELECT USING (puede('ver','lineas_base', project_id));
CREATE POLICY "baseline_tasks_insert" ON baseline_tasks FOR INSERT WITH CHECK (puede('editar','lineas_base', project_id));
CREATE POLICY "baseline_tasks_update" ON baseline_tasks FOR UPDATE USING (puede('editar','lineas_base', project_id));
CREATE POLICY "baseline_tasks_delete" ON baseline_tasks FOR DELETE USING (puede('editar','lineas_base', project_id));

DROP POLICY IF EXISTS "anon_all_calendar_exceptions" ON calendar_exceptions;
DROP POLICY IF EXISTS "auth_all_calendar_exceptions" ON calendar_exceptions;
CREATE POLICY "calexc_select" ON calendar_exceptions FOR SELECT USING (puede('ver','calendarios', project_id) OR es_admin_empresa(org_id));
CREATE POLICY "calexc_insert" ON calendar_exceptions FOR INSERT WITH CHECK (puede('editar','calendarios', project_id) OR es_admin_empresa(org_id));
CREATE POLICY "calexc_update" ON calendar_exceptions FOR UPDATE USING (puede('editar','calendarios', project_id) OR es_admin_empresa(org_id));
CREATE POLICY "calexc_delete" ON calendar_exceptions FOR DELETE USING (puede('editar','calendarios', project_id) OR es_admin_empresa(org_id));

DROP POLICY IF EXISTS "anon_all_portfolios" ON portfolios;
DROP POLICY IF EXISTS "auth_all_portfolios" ON portfolios;
CREATE POLICY "portfolios_select" ON portfolios FOR SELECT USING (es_miembro_empresa(org_id));
CREATE POLICY "portfolios_insert" ON portfolios FOR INSERT WITH CHECK (es_admin_empresa(org_id));
CREATE POLICY "portfolios_update" ON portfolios FOR UPDATE USING (es_admin_empresa(org_id));
CREATE POLICY "portfolios_delete" ON portfolios FOR DELETE USING (es_admin_empresa(org_id));

DROP POLICY IF EXISTS "anon_all_programs" ON programs;
DROP POLICY IF EXISTS "auth_all_programs" ON programs;
CREATE POLICY "programs_select" ON programs FOR SELECT USING (es_miembro_empresa(org_id));
CREATE POLICY "programs_insert" ON programs FOR INSERT WITH CHECK (es_admin_empresa(org_id));
CREATE POLICY "programs_update" ON programs FOR UPDATE USING (es_admin_empresa(org_id));
CREATE POLICY "programs_delete" ON programs FOR DELETE USING (es_admin_empresa(org_id));

DROP POLICY IF EXISTS "anon_all_memberships" ON memberships;
DROP POLICY IF EXISTS "auth_all_memberships" ON memberships;
CREATE POLICY "memberships_select" ON memberships FOR SELECT USING (user_id = auth.uid() OR es_admin_empresa(org_id));
CREATE POLICY "memberships_insert" ON memberships FOR INSERT WITH CHECK (es_admin_empresa(org_id) OR es_propietario_plataforma());
CREATE POLICY "memberships_update" ON memberships FOR UPDATE USING (es_admin_empresa(org_id) OR es_propietario_plataforma());
CREATE POLICY "memberships_delete" ON memberships FOR DELETE USING (es_admin_empresa(org_id) OR es_propietario_plataforma());

-- ============================================================
-- 13. Índices adicionales para rendimiento
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_org_memberships_org_user  ON org_memberships(org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_user_id   ON org_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_proj    ON group_memberships(project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_group_memberships_user    ON group_memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_permisos_area_modulo      ON permisos(area_id, modulo);
CREATE INDEX IF NOT EXISTS idx_areas_org_id              ON areas(org_id);

-- ============================================================
-- FIN — Fase 0 completada
-- Siguiente: Fase 1 — Ingreso y usuarios (correo + clave, relevo, auditoría)
-- ============================================================
