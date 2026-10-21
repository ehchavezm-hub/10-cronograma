# ECM Project — Configuración de Producción Supabase (1000 usuarios)

Guía de referencia para escalar ECM Project a 1,000 usuarios concurrentes con Supabase como backend.

---

## 1. PgBouncer — Connection Pooling

Supabase incluye PgBouncer integrado. Para 1,000 usuarios concurrentes:

| Parámetro | Valor recomendado | Justificación |
|-----------|-------------------|---------------|
| **Modo** | `Transaction` | Libera la conexión al terminar cada transacción; ideal para muchos usuarios cortos |
| **Pool size** | 15–20 conexiones por instancia | PostgreSQL soporta ~100 conexiones totales en el plan Pro |
| **Max client connections** | 1,000 | Cubre el máximo de usuarios simultáneos |
| **Server idle timeout** | 600 s | Cierra conexiones inactivas al servidor |
| **Client idle timeout** | 0 | No cerrar clientes (el frontend reconecta solo) |

**En Supabase Dashboard:** Project Settings → Database → Connection Pooling → Mode: Transaction.

### URL de conexión desde el cliente JS

```javascript
// supabase.js (singleton — importar siempre desde aquí)
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const SUPABASE_URL = import.meta.env?.VITE_SUPABASE_URL ?? window.__ECM_SUPABASE_URL__;
const SUPABASE_ANON = import.meta.env?.VITE_SUPABASE_ANON ?? window.__ECM_SUPABASE_ANON__;

// Usar la URL de Pooler (puerto 6543) en producción
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true },
  db:   { schema: 'public' },
  global: { headers: { 'x-ecm-version': '89' } },
});
```

> **Regla:** Una sola instancia por tab del navegador. Nunca llamar `createClient` múltiples veces.

---

## 2. Caching en el Borde — GitHub Pages + Cloudflare

ECM Project es una SPA estática en GitHub Pages. Agregar Cloudflare como proxy (plan Free) aporta:

### Headers recomendados (via `_headers` file en la raíz)

```
# _headers (archivo especial de GitHub Pages / Netlify / Cloudflare Pages)

/js/*.js
  Cache-Control: public, max-age=31536000, immutable

/css/*.css
  Cache-Control: public, max-age=31536000, immutable

/index.html
  Cache-Control: no-cache, must-revalidate

/sw.js
  Cache-Control: no-cache

/manifest.json
  Cache-Control: public, max-age=86400
```

Los archivos JS/CSS ya usan versiones (`?v=99`), por lo que `immutable` es seguro.

### Reglas de Cloudflare (opcional)

- Caché nivel "Estándar" para todos los assets estáticos.
- Bypass cache para `*.supabase.co` y `/rest/v1/*`.
- Minify HTML/JS/CSS activado.

---

## 3. Rate Limiting

Supabase aplica rate limiting por defecto. Recomendaciones adicionales:

| Endpoint | Límite sugerido | Acción |
|----------|----------------|--------|
| `POST /auth/v1/token` | 30 req/min por IP | Bloquear con Cloudflare WAF |
| `GET /rest/v1/projects` | 100 req/min por usuario | Implementar debounce en el cliente |
| Cálculo CPM (local) | — | Usar Web Worker (ya implementado) |

En el cliente, evitar llamadas repetidas:

```javascript
// Ejemplo: debounce de 300 ms antes de persistir cambios
let _saveTimer;
function scheduleSync() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(syncToSupabase, 300);
}
```

---

## 4. Checklist de Monitoreo

- [ ] Activar **Supabase Observability** (Dashboard → Logs → API Logs)
- [ ] Configurar alertas en **Supabase** para errores 5xx
- [ ] Integrar **Sentry** con `js/monitoring.js` (ver instrucciones en ese archivo)
- [ ] Revisar `pg_stat_activity` semanalmente para detectar consultas lentas
- [ ] Monitorear `pg_stat_user_tables` para detectar tablas sin índices
- [ ] Activar **pgaudit** en Supabase para auditoría de acceso a datos sensibles
- [ ] Configurar backup diario automático (Supabase Pro lo incluye)
- [ ] Revisar políticas RLS con `sql/rls-policies.sql` en cada nueva tabla

---

*Generado para ECM Project v89 — E. Chávez — 2026*
