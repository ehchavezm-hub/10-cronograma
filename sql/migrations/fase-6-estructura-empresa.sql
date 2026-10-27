-- =============================================================
-- FASE 6: Estructura por empresa (Empresa › Portafolio › Programa › Proyecto)
-- Portafolios y programas pasan a guardarse en la nube dentro de su empresa.
-- Solo agrega: columna code y reglas de acceso de portfolios y programs
-- (tenían RLS activo sin reglas, por eso nadie podía usarlas).
-- =============================================================

ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE programs   ADD COLUMN IF NOT EXISTS code TEXT;

DROP POLICY IF EXISTS portfolios_select ON portfolios;
CREATE POLICY portfolios_select ON portfolios FOR SELECT TO authenticated
  USING (es_miembro_empresa(org_id) OR es_propietario_plataforma());
DROP POLICY IF EXISTS portfolios_insert ON portfolios;
CREATE POLICY portfolios_insert ON portfolios FOR INSERT TO authenticated WITH CHECK (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS portfolios_update ON portfolios;
CREATE POLICY portfolios_update ON portfolios FOR UPDATE TO authenticated USING (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS portfolios_delete ON portfolios;
CREATE POLICY portfolios_delete ON portfolios FOR DELETE TO authenticated USING (es_admin_o_propietario(org_id));

DROP POLICY IF EXISTS programs_select ON programs;
CREATE POLICY programs_select ON programs FOR SELECT TO authenticated
  USING (es_miembro_empresa(org_id) OR es_propietario_plataforma());
DROP POLICY IF EXISTS programs_insert ON programs;
CREATE POLICY programs_insert ON programs FOR INSERT TO authenticated WITH CHECK (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS programs_update ON programs;
CREATE POLICY programs_update ON programs FOR UPDATE TO authenticated USING (es_admin_o_propietario(org_id));
DROP POLICY IF EXISTS programs_delete ON programs;
CREATE POLICY programs_delete ON programs FOR DELETE TO authenticated USING (es_admin_o_propietario(org_id));
