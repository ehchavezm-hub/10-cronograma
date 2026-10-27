-- =============================================================
-- FASE 5: Consolidación del esquema multiempresa (solo agrega)
-- Aplica las partes de la fase 0 que faltaban en Supabase:
-- tablas areas, group_memberships, permisos, auditoria, acceso_soporte,
-- plantillas de 11 áreas, funciones de permisos y crear_empresa.
-- Corrige handle_new_user (usaba columnas inexistentes), crea los perfiles
-- faltantes y asigna al propietario de la plataforma.
-- NO cambia las reglas de acceso de las tablas existentes (eso es la fase de
-- cierre de seguridad, aparte).
-- =============================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;


-- ============================================================
-- 0. Extensiones necesarias
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. Ampliar profiles — capa Plataforma
-- ============================================================
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS email        TEXT,
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

DROP TRIGGER IF EXISTS trg_org_memberships_updated_at ON org_memberships;
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

DROP TRIGGER IF EXISTS trg_areas_updated_at ON areas;
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

DROP TRIGGER IF EXISTS trg_group_memberships_updated_at ON group_memberships;
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

DROP TRIGGER IF EXISTS trg_permisos_updated_at ON permisos;
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
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_org_id UUID;
  v_area_id UUID;
  r_area RECORD;
  r_perm RECORD;
BEGIN
  -- Solo para uno mismo, salvo el propietario de la plataforma
  IF p_owner_id IS DISTINCT FROM auth.uid() AND NOT es_propietario_plataforma() THEN
    RAISE EXCEPTION 'Solo puede crear empresas a su propio nombre';
  END IF;
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
-- 12. Reglas de acceso SOLO para las tablas nuevas
-- ============================================================
DROP POLICY IF EXISTS areas_select ON areas;
CREATE POLICY areas_select ON areas FOR SELECT USING (es_miembro_empresa(org_id));
DROP POLICY IF EXISTS areas_insert ON areas;
CREATE POLICY areas_insert ON areas FOR INSERT WITH CHECK (es_admin_empresa(org_id));
DROP POLICY IF EXISTS areas_update ON areas;
CREATE POLICY areas_update ON areas FOR UPDATE USING (es_admin_empresa(org_id));
DROP POLICY IF EXISTS areas_delete ON areas;
CREATE POLICY areas_delete ON areas FOR DELETE USING (es_admin_empresa(org_id) AND NOT is_default);

DROP POLICY IF EXISTS permisos_select ON permisos;
CREATE POLICY permisos_select ON permisos FOR SELECT USING (es_miembro_empresa(org_id));
DROP POLICY IF EXISTS permisos_insert ON permisos;
CREATE POLICY permisos_insert ON permisos FOR INSERT WITH CHECK (es_admin_empresa(org_id));
DROP POLICY IF EXISTS permisos_update ON permisos;
CREATE POLICY permisos_update ON permisos FOR UPDATE USING (es_admin_empresa(org_id));
DROP POLICY IF EXISTS permisos_delete ON permisos;
CREATE POLICY permisos_delete ON permisos FOR DELETE USING (es_admin_empresa(org_id));

DROP POLICY IF EXISTS gm_select ON group_memberships;
CREATE OR REPLACE FUNCTION es_admin_grupo(p_project_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT EXISTS (SELECT 1 FROM group_memberships
                 WHERE project_id = p_project_id AND user_id = auth.uid() AND group_role = 'administrador');
$$;
CREATE POLICY gm_select ON group_memberships FOR SELECT
  USING (user_id = auth.uid() OR es_admin_empresa(org_id) OR es_admin_grupo(project_id));
DROP POLICY IF EXISTS gm_insert ON group_memberships;
CREATE POLICY gm_insert ON group_memberships FOR INSERT WITH CHECK (es_admin_empresa(org_id));
DROP POLICY IF EXISTS gm_update ON group_memberships;
CREATE POLICY gm_update ON group_memberships FOR UPDATE USING (es_admin_empresa(org_id));
DROP POLICY IF EXISTS gm_delete ON group_memberships;
CREATE POLICY gm_delete ON group_memberships FOR DELETE USING (es_admin_empresa(org_id));

DROP POLICY IF EXISTS auditoria_select ON auditoria;
CREATE POLICY auditoria_select ON auditoria FOR SELECT USING (user_id = auth.uid() OR es_admin_empresa(org_id) OR es_propietario_plataforma());
DROP POLICY IF EXISTS auditoria_insert ON auditoria;
CREATE POLICY auditoria_insert ON auditoria FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS soporte_select ON acceso_soporte;
CREATE POLICY soporte_select ON acceso_soporte FOR SELECT USING (es_propietario_plataforma() OR granted_by = auth.uid() OR support_user = auth.uid());
DROP POLICY IF EXISTS soporte_insert ON acceso_soporte;
CREATE POLICY soporte_insert ON acceso_soporte FOR INSERT WITH CHECK (granted_by = auth.uid() AND es_admin_empresa(org_id));
DROP POLICY IF EXISTS soporte_update ON acceso_soporte;
CREATE POLICY soporte_update ON acceso_soporte FOR UPDATE USING (granted_by = auth.uid());

ALTER TABLE areas_plantilla ENABLE ROW LEVEL SECURITY;
ALTER TABLE permisos_plantilla ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS areas_plantilla_select ON areas_plantilla;
CREATE POLICY areas_plantilla_select ON areas_plantilla FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS permisos_plantilla_select ON permisos_plantilla;
CREATE POLICY permisos_plantilla_select ON permisos_plantilla FOR SELECT TO authenticated USING (true);

-- ============================================================
-- 13. Registro de usuarios: perfil automático (corrige columnas)
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, platform_role, created_at)
  VALUES (NEW.id, NEW.email,
          COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
          'ninguno', NOW())
  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
  RETURN NEW;
END; $$;

-- Perfiles faltantes de usuarios ya registrados
INSERT INTO profiles (id, email, full_name, platform_role, created_at)
SELECT u.id, u.email, COALESCE(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)), 'ninguno', NOW()
FROM auth.users u
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

-- Propietario de la plataforma: el primer usuario registrado (si aún no hay uno)
UPDATE profiles SET platform_role = 'propietario'
WHERE id = (SELECT id FROM auth.users ORDER BY created_at LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM profiles WHERE platform_role = 'propietario');

-- ============================================================
-- 14. Empresas existentes: copiar plantilla de 11 áreas y permisos
-- ============================================================
INSERT INTO areas (org_id, name, sort_order, is_default)
SELECT o.id, ap.name, ap.sort_order, true FROM organizations o CROSS JOIN areas_plantilla ap
WHERE o.deleted_at IS NULL
ON CONFLICT (org_id, name) DO NOTHING;

INSERT INTO permisos (org_id, area_id, project_id, modulo, nivel)
SELECT a.org_id, a.id, NULL, pp.modulo, pp.nivel
FROM areas a JOIN permisos_plantilla pp ON pp.area_name = a.name
WHERE NOT EXISTS (SELECT 1 FROM permisos p WHERE p.area_id = a.id AND p.modulo = pp.modulo AND p.project_id IS NULL);
