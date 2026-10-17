-- seed.sql — Datos iniciales para Supabase (demo portfolio + feriados Perú 2026)
-- Ejecutar como superuser o con service_role key
-- NOTA: Las fechas de feriados provienen del Decreto Supremo publicado en PCM/El Peruano
-- para el año 2026.

BEGIN;

-- ============================================================
-- Organización demo
-- ============================================================
INSERT INTO organizations (id, name, slug, plan, settings)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Constructora Demo SAC',
  'demo',
  'free',
  '{"timezone":"America/Lima","date_format":"DD/MM/YYYY"}'
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Usuario demo (debe coincidir con un auth.users existente)
-- Se usa un UUID fijo para facilitar pruebas en seed local.
-- En producción, reemplazar con el UUID real del usuario.
-- ============================================================
INSERT INTO profiles (id, full_name, avatar_url, timezone)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  'Usuario Demo',
  NULL,
  'America/Lima'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO org_members (org_id, user_id, role)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000002',
  'admin'
)
ON CONFLICT (org_id, user_id) DO NOTHING;

-- ============================================================
-- Proyecto demo
-- ============================================================
INSERT INTO projects (
  id, org_id, name, code, description,
  start_date, data_date, status,
  planned_budget, currency, settings
)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  '[DEMO] Edificio Residencial Las Palmas',
  'ERP-2026',
  'Proyecto demo de construcción — 4 niveles EDT, ~40 actividades, ruta crítica visible.',
  '2026-01-05',
  NULL,
  'active',
  5000000.00,
  'PEN',
  '{"near_threshold":5,"default_calendar":"00000000-0000-0000-0000-000000000020"}'
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Calendario estándar Perú (Lun–Vie)
-- ============================================================
INSERT INTO calendars (
  id, org_id, name, work_week, is_default
)
VALUES (
  '00000000-0000-0000-0000-000000000020',
  '00000000-0000-0000-0000-000000000001',
  'Estándar Perú — Lun a Vie',
  '{1,2,3,4,5}',
  true
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Feriados nacionales Perú 2026
-- Fuente: Decreto Supremo PCM / El Peruano 2025
-- ============================================================
INSERT INTO calendar_exceptions (id, calendar_id, on_date, is_working, description)
VALUES
  ('fpe-2026-01', '00000000-0000-0000-0000-000000000020', '2026-01-01', false, 'Año Nuevo'),
  ('fpe-2026-02', '00000000-0000-0000-0000-000000000020', '2026-04-02', false, 'Jueves Santo'),
  ('fpe-2026-03', '00000000-0000-0000-0000-000000000020', '2026-04-03', false, 'Viernes Santo'),
  ('fpe-2026-04', '00000000-0000-0000-0000-000000000020', '2026-05-01', false, 'Día del Trabajo'),
  ('fpe-2026-05', '00000000-0000-0000-0000-000000000020', '2026-06-07', false, 'Batalla de Arica'),
  ('fpe-2026-06', '00000000-0000-0000-0000-000000000020', '2026-06-29', false, 'San Pedro y San Pablo'),
  ('fpe-2026-07', '00000000-0000-0000-0000-000000000020', '2026-07-28', false, 'Fiestas Patrias'),
  ('fpe-2026-08', '00000000-0000-0000-0000-000000000020', '2026-07-29', false, 'Fiestas Patrias'),
  ('fpe-2026-09', '00000000-0000-0000-0000-000000000020', '2026-08-30', false, 'Santa Rosa de Lima'),
  ('fpe-2026-10', '00000000-0000-0000-0000-000000000020', '2026-10-08', false, 'Combate de Angamos'),
  ('fpe-2026-11', '00000000-0000-0000-0000-000000000020', '2026-11-01', false, 'Todos los Santos'),
  ('fpe-2026-12', '00000000-0000-0000-0000-000000000020', '2026-12-08', false, 'Inmaculada Concepción'),
  ('fpe-2026-13', '00000000-0000-0000-0000-000000000020', '2026-12-25', false, 'Navidad')
ON CONFLICT (id) DO NOTHING;

COMMIT;
