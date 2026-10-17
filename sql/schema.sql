-- schema.sql — Esquema completo para Supabase
-- Ejecutar en Supabase > SQL Editor como primera vez (orden importa por FK)
-- La service_role key NUNCA aparece en el código fuente (D9).

-- ============================================================
-- Extensiones
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- Helpers de timestamps
-- ============================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ============================================================
-- 1. organizations
-- ============================================================
CREATE TABLE IF NOT EXISTS organizations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'free',
  settings    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_organizations" ON organizations
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_organizations" ON organizations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 2. profiles  (espejo de auth.users)
-- ============================================================
CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY,  -- mismo UUID que auth.users
  full_name   TEXT,
  avatar_url  TEXT,
  timezone    TEXT NOT NULL DEFAULT 'America/Lima',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_profiles" ON profiles
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_profiles" ON profiles
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 3. memberships  (org_members)
-- ============================================================
CREATE TABLE IF NOT EXISTS memberships (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

CREATE TRIGGER trg_memberships_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_memberships" ON memberships
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_memberships" ON memberships
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 4. portfolios
-- ============================================================
CREATE TABLE IF NOT EXISTS portfolios (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  settings    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE TRIGGER trg_portfolios_updated_at
  BEFORE UPDATE ON portfolios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_portfolios" ON portfolios
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_portfolios" ON portfolios
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 5. programs
-- ============================================================
CREATE TABLE IF NOT EXISTS programs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  portfolio_id  UUID REFERENCES portfolios(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  settings      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE TRIGGER trg_programs_updated_at
  BEFORE UPDATE ON programs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE programs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_programs" ON programs
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_programs" ON programs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 6. calendars
-- ============================================================
CREATE TABLE IF NOT EXISTS calendars (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    UUID,   -- FK a projects se agrega después
  name          TEXT NOT NULL,
  work_week     INT[] NOT NULL DEFAULT '{1,2,3,4,5}',
  hours_per_day NUMERIC(4,2) NOT NULL DEFAULT 8,
  shift_label   TEXT,
  shift_start   TIME,
  shift_end     TIME,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ
);

CREATE TRIGGER trg_calendars_updated_at
  BEFORE UPDATE ON calendars
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE calendars ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_calendars" ON calendars
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_calendars" ON calendars
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 7. projects
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id              UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  program_id          UUID REFERENCES programs(id) ON DELETE SET NULL,
  sponsor_id          UUID,
  calendar_id         UUID REFERENCES calendars(id) ON DELETE SET NULL,
  code                TEXT,
  name                TEXT NOT NULL,
  description         TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  start_date          DATE,
  actual_start_date   DATE,
  actual_finish_date  DATE,
  data_date           DATE,
  budget              NUMERIC(18,2),
  planned_budget      NUMERIC(18,2),
  currency            TEXT NOT NULL DEFAULT 'PEN',
  is_template         BOOLEAN NOT NULL DEFAULT false,
  settings            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at          TIMESTAMPTZ
);

-- FK circular: calendars.project_id → projects
ALTER TABLE calendars
  ADD CONSTRAINT fk_calendars_project
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;

CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_projects" ON projects
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_projects" ON projects
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 8. calendar_exceptions
-- ============================================================
CREATE TABLE IF NOT EXISTS calendar_exceptions (
  id          TEXT PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
  on_date     DATE NOT NULL,
  is_working  BOOLEAN NOT NULL DEFAULT false,
  name        TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE(calendar_id, on_date)
);

CREATE TRIGGER trg_calendar_exceptions_updated_at
  BEFORE UPDATE ON calendar_exceptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE calendar_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_calendar_exceptions" ON calendar_exceptions
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_calendar_exceptions" ON calendar_exceptions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 9. tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS tasks (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id         UUID REFERENCES tasks(id) ON DELETE SET NULL,
  sort_order        INT NOT NULL DEFAULT 0,
  name              TEXT NOT NULL,
  type              TEXT NOT NULL DEFAULT 'task',  -- task | milestone | summary
  duration_days     INT NOT NULL DEFAULT 0,
  work_hours        NUMERIC(8,2) NOT NULL DEFAULT 0,
  percent_complete  NUMERIC(5,2) NOT NULL DEFAULT 0,
  actual_start      DATE,
  actual_finish     DATE,
  constraint_type   TEXT NOT NULL DEFAULT 'ASAP',
  constraint_date   DATE,
  planned_cost      NUMERIC(18,2) NOT NULL DEFAULT 0,
  actual_cost       NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_id  ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at  ON tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id   ON tasks(parent_id);

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_tasks" ON tasks
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_tasks" ON tasks
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 10. task_dependencies
-- ============================================================
CREATE TABLE IF NOT EXISTS task_dependencies (
  id          TEXT PRIMARY KEY,
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pred_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  succ_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'FS',  -- FS | SS | FF | SF
  lag_days    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE(pred_id, succ_id, type)
);

CREATE INDEX IF NOT EXISTS idx_task_dependencies_project_id ON task_dependencies(project_id);

CREATE TRIGGER trg_task_dependencies_updated_at
  BEFORE UPDATE ON task_dependencies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_task_dependencies" ON task_dependencies
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_task_dependencies" ON task_dependencies
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 11. resources
-- ============================================================
CREATE TABLE IF NOT EXISTS resources (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'work',  -- work | material | cost
  rate        NUMERIC(14,4) NOT NULL DEFAULT 0,
  unit        TEXT NOT NULL DEFAULT 'h',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE TRIGGER trg_resources_updated_at
  BEFORE UPDATE ON resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_resources" ON resources
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_resources" ON resources
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 12. task_resources
-- ============================================================
CREATE TABLE IF NOT EXISTS task_resources (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  resource_id UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  allocation  NUMERIC(5,2) NOT NULL DEFAULT 1.0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  UNIQUE(task_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_task_resources_task_id    ON task_resources(task_id);
CREATE INDEX IF NOT EXISTS idx_task_resources_project_id ON task_resources(project_id);

CREATE TRIGGER trg_task_resources_updated_at
  BEFORE UPDATE ON task_resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE task_resources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_task_resources" ON task_resources
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_task_resources" ON task_resources
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 13. baselines
-- ============================================================
CREATE TABLE IF NOT EXISTS baselines (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id      UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_baselines_updated_at
  BEFORE UPDATE ON baselines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE baselines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_baselines" ON baselines
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_baselines" ON baselines
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ============================================================
-- 14. baseline_tasks
-- ============================================================
CREATE TABLE IF NOT EXISTS baseline_tasks (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  org_id            UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  baseline_id       UUID NOT NULL REFERENCES baselines(id) ON DELETE CASCADE,
  task_id           UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  planned_start     DATE,
  planned_finish    DATE,
  planned_duration  INT,
  planned_cost      NUMERIC(18,2),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(baseline_id, task_id)
);

ALTER TABLE baseline_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_all_baseline_tasks" ON baseline_tasks
  FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE POLICY "auth_all_baseline_tasks" ON baseline_tasks
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
