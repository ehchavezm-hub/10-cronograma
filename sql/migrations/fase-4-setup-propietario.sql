-- =============================================================
-- FASE 4: Setup inicial de Propietario de Plataforma
-- Ejecutar DESPUÉS de fase-0-empresas-seguridad.sql
-- =============================================================
-- Objetivo:
--   1. Trigger en auth.users → crea fila en profiles automáticamente
--      al registrarse un usuario nuevo (via /auth/v1/signup)
--   2. Función reclamar_propietario() — asigna platform_role='propietario'
--      al usuario actual, SOLO si no existe ningún propietario todavía.
--      Es idempotente y segura (no puede haber dos propietarios vía esta vía).
-- =============================================================

-- ============================================================
-- 1. Trigger: crear perfil automáticamente al registrarse
--    (handler en auth schema, SECURITY DEFINER para poder
--     escribir en public.profiles desde auth context)
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, platform_role, created_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    'ninguno',
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- Crear el trigger en auth.users (solo si no existe)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'on_auth_user_created'
      AND tgrelid = 'auth.users'::regclass
  ) THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
  END IF;
END;
$$;

-- ============================================================
-- 2. Función: reclamar_propietario()
--    Solo tiene efecto la primera vez (cuando no hay propietario)
--    Retorna TRUE si fue asignado, FALSE si ya existía propietario.
-- ============================================================
CREATE OR REPLACE FUNCTION public.reclamar_propietario()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER AS $$
DECLARE
  v_uid UUID;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Usuario no autenticado';
  END IF;

  -- Si ya existe un propietario, no hacer nada
  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE platform_role = 'propietario'
  ) THEN
    RETURN false;
  END IF;

  -- Asignar propietario al usuario actual
  UPDATE public.profiles
  SET platform_role = 'propietario'
  WHERE id = v_uid;

  RETURN true;
END;
$$;

-- Permitir que cualquier usuario autenticado llame la función
-- (La función misma controla que solo opere una vez)
GRANT EXECUTE ON FUNCTION public.reclamar_propietario() TO authenticated;

-- ============================================================
-- FIN — Fase 4 completada
-- Pasos post-deploy:
--   1. Ejecutar este SQL en Supabase > SQL Editor
--   2. El primer usuario que se registre y llame reclamar_propietario()
--      queda como propietario de plataforma
--   3. Los usuarios siguientes obtienen platform_role = 'ninguno'
-- ============================================================
