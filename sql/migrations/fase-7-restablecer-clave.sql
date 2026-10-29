-- =============================================================
-- FASE 7: «Nueva clave» desde Administración cambia la contraseña real.
-- Antes solo se guardaba la clave en org_memberships y la cuenta seguía
-- con la anterior, por eso la persona no podía entrar con la nueva.
-- Solo agrega una función; no cambia datos ni reglas existentes.
-- =============================================================

CREATE OR REPLACE FUNCTION public.restablecer_clave_temporal(p_mem_id UUID, p_clave TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'extensions' AS $$
DECLARE
  v_user UUID;
  v_org  UUID;
BEGIN
  SELECT user_id, org_id INTO v_user, v_org FROM org_memberships WHERE id = p_mem_id;
  IF v_user IS NULL THEN RAISE EXCEPTION 'Usuario no encontrado en esta empresa'; END IF;
  IF NOT es_admin_o_propietario(v_org) THEN RAISE EXCEPTION 'No tienes permiso para cambiar claves en esta empresa'; END IF;
  IF v_user = auth.uid() THEN RAISE EXCEPTION 'Para tu propia cuenta usa «Cambiar contraseña»'; END IF;
  -- La clave de un propietario o co-propietario solo la puede cambiar el propietario
  IF EXISTS (SELECT 1 FROM profiles WHERE id = v_user AND platform_role IN ('propietario','co_propietario'))
     AND NOT EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND platform_role = 'propietario') THEN
    RAISE EXCEPTION 'No puedes cambiar la clave de un propietario de la plataforma';
  END IF;
  IF length(coalesce(p_clave, '')) < 8 THEN RAISE EXCEPTION 'La clave debe tener al menos 8 caracteres'; END IF;

  UPDATE auth.users
     SET encrypted_password = crypt(p_clave, gen_salt('bf')), updated_at = NOW()
   WHERE id = v_user;
  UPDATE org_memberships SET temp_password = p_clave WHERE id = p_mem_id;
END; $$;

REVOKE EXECUTE ON FUNCTION public.restablecer_clave_temporal(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restablecer_clave_temporal(UUID, TEXT) TO authenticated;
