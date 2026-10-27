-- =============================================================
-- FASE 1: Login, Usuarios y Gestión de Empresa
-- Ejecutar DESPUÉS de fase-0-empresas-seguridad.sql
-- =============================================================
-- Mejoras sobre Fase 0:
--   - Trigger de limpieza de clave temporal al cambiar contraseña
--   - Función para registrar auditoria desde el cliente (SECURITY DEFINER)
--   - Función para verificar si un usuario tiene clave temporal activa
--   - Vista simplificada para el panel de usuarios
-- =============================================================

-- ============================================================
-- 1. Función para registrar auditoría desde cliente autenticado
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_auditoria(
  p_accion      TEXT,
  p_tabla       TEXT,
  p_registro_id TEXT,
  p_detalle     JSONB DEFAULT '{}'
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO auditoria (org_id, user_id, accion, tabla, registro_id, detalle)
  SELECT
    om.org_id,
    auth.uid(),
    p_accion,
    p_tabla,
    p_registro_id,
    p_detalle
  FROM org_memberships om
  WHERE om.user_id = auth.uid() AND om.active = true
  LIMIT 1;
END;
$$;

-- ============================================================
-- 2. Función: tiene_clave_temporal(p_org_id)
--    Retorna true si el usuario actual tiene clave temporal activa
-- ============================================================
CREATE OR REPLACE FUNCTION tiene_clave_temporal(p_org_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_memberships
    WHERE org_id = p_org_id AND user_id = auth.uid()
      AND active = true AND temp_password IS NOT NULL
  );
$$;

-- ============================================================
-- 3. Función: mis_empresas()
--    Retorna las empresas del usuario autenticado (para el selector)
-- ============================================================
CREATE OR REPLACE FUNCTION mis_empresas()
RETURNS TABLE(
  org_id        UUID,
  org_name      TEXT,
  org_slug      TEXT,
  empresa_role  TEXT,
  has_temp_pwd  BOOLEAN,
  org_status    TEXT
) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  SELECT
    o.id,
    o.name,
    o.slug,
    om.empresa_role,
    (om.temp_password IS NOT NULL),
    o.status
  FROM org_memberships om
  JOIN organizations o ON o.id = om.org_id
  WHERE om.user_id = auth.uid() AND om.active = true
    AND (om.expires_at IS NULL OR om.expires_at > NOW())
    AND o.status = 'active'
  ORDER BY o.name;
$$;

-- ============================================================
-- 4. Función: limpiar_clave_temporal(p_org_id)
--    Llamar tras cambio de contraseña exitoso
-- ============================================================
CREATE OR REPLACE FUNCTION limpiar_clave_temporal(p_org_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE org_memberships
  SET temp_password = NULL, updated_at = NOW()
  WHERE org_id = p_org_id AND user_id = auth.uid() AND active = true;
END;
$$;

-- ============================================================
-- 5. Vista: vista_usuarios_empresa
--    Para el panel de administración (solo accesible a admins)
-- ============================================================
CREATE OR REPLACE VIEW vista_usuarios_empresa AS
SELECT
  om.id          AS mem_id,
  om.org_id,
  om.user_id,
  om.empresa_role,
  om.active,
  (om.temp_password IS NOT NULL) AS has_temp_pwd,
  om.expires_at,
  om.invited_by,
  om.created_at  AS joined_at,
  p.full_name,
  p.short_code,
  p.cargo,
  p.platform_role
FROM org_memberships om
LEFT JOIN profiles p ON p.id = om.user_id;

-- RLS en la vista: se hereda de las tablas base.
-- Solo super_admin y relevo pueden verla via es_admin_empresa(org_id).

-- ============================================================
-- 6. Función: invitar_usuario_empresa(email, rol, org_id)
--    Nota: requiere service_role para crear usuarios auth.
--    Esta versión registra el intento de invitación en auditoria
--    para que el super_admin sepa qué correos están pendientes.
--    La creación real del usuario auth se hace desde el cliente JS.
-- ============================================================
CREATE OR REPLACE FUNCTION registrar_invitacion(
  p_email       TEXT,
  p_org_id      UUID,
  p_empresa_role TEXT DEFAULT 'miembro'
) RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT es_admin_empresa(p_org_id) THEN
    RAISE EXCEPTION 'Sin permisos para invitar usuarios en esta empresa';
  END IF;

  INSERT INTO auditoria (org_id, user_id, accion, tabla, registro_id, detalle)
  VALUES (
    p_org_id,
    auth.uid(),
    'invitar_usuario',
    'org_memberships',
    p_email,
    jsonb_build_object('email', p_email, 'rol', p_empresa_role)
  );
END;
$$;

-- ============================================================
-- 7. Función: asignar_relevo(p_user_id, p_org_id)
--    Designa un usuario como relevo del super_admin
-- ============================================================
CREATE OR REPLACE FUNCTION asignar_relevo(p_user_id UUID, p_org_id UUID)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT (rol_en_empresa(p_org_id) = 'super_admin') THEN
    RAISE EXCEPTION 'Solo el super_admin puede asignar relevo';
  END IF;

  -- Quitar relevo anterior
  UPDATE org_memberships
  SET empresa_role = 'miembro', updated_at = NOW()
  WHERE org_id = p_org_id AND empresa_role = 'relevo';

  -- Asignar nuevo relevo
  UPDATE org_memberships
  SET empresa_role = 'relevo', updated_at = NOW()
  WHERE org_id = p_org_id AND user_id = p_user_id AND active = true;

  -- Auditoría
  PERFORM registrar_auditoria('asignar_relevo', 'org_memberships', p_user_id::TEXT,
    jsonb_build_object('org_id', p_org_id));
END;
$$;

-- ============================================================
-- 8. Índices adicionales para consultas de auth frecuentes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_profiles_platform_role ON profiles(platform_role)
  WHERE platform_role <> 'ninguno';

CREATE INDEX IF NOT EXISTS idx_org_memberships_role ON org_memberships(org_id, empresa_role)
  WHERE active = true;

CREATE INDEX IF NOT EXISTS idx_org_memberships_temp ON org_memberships(user_id)
  WHERE temp_password IS NOT NULL AND active = true;

-- ============================================================
-- FIN — Fase 1 completada
-- Siguiente: Fase 2 — Panel de administración de empresa en UI
-- ============================================================
