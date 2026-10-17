# Cronogramas v7 — Sistema de Gestión de Proyectos de Construcción

Aplicación web profesional de cronogramas (CPM/Gantt) para gestión de proyectos de construcción. Funciona completamente offline en modo local y opcionalmente sincroniza con Supabase.

**Demo en producción:** https://ehchavezm-hub.github.io/10-cronograma/

---

## Requisitos

- Navegador moderno con soporte ES Modules (Chrome 90+, Firefox 88+, Edge 90+, Safari 15+)
- Para desarrollo: Python 3 o Node.js (para servidor local)
- Para sincronización en la nube: Cuenta Supabase (gratuita)

---

## Inicio rápido

### 1. Clonar el repositorio

```bash
git clone https://github.com/ehchavezm-hub/10-cronograma.git
cd 10-cronograma
```

### 2. Iniciar servidor local

```bash
python3 -m http.server 8080
```

O con Node.js:

```bash
npx serve .
```

### 3. Abrir en el navegador

```
http://localhost:8080
```

> **Importante:** No abrir `index.html` con doble clic. Los módulos ES requieren un servidor HTTP.

---

## Configuración de Supabase (opcional)

### 1. Crear proyecto Supabase

1. Ir a https://supabase.com y crear una cuenta.
2. Crear un nuevo proyecto.
3. Anotar la URL del proyecto y la clave `anon` (pública).

### 2. Crear el esquema

Ejecutar en el SQL Editor de Supabase:

```sql
-- 1. Esquema completo
\i sql/schema.sql

-- 2. Políticas RLS
\i sql/rls.sql

-- 3. Datos iniciales (opcional)
\i sql/seed.sql
```

O copiar el contenido de cada archivo y ejecutarlo en el editor.

### 3. Configurar la aplicación

```bash
cp js/config.example.js js/config.js
```

Editar `js/config.js`:

```js
export const SUPABASE_URL      = 'https://xxxxxxxx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJ...';
```

> **Seguridad:** Solo la clave `anon` va en `config.js`. La clave `service_role` **nunca** debe aparecer en el código fuente.

---

## Despliegue en GitHub Pages

### 1. Subir a GitHub

```bash
git add .
git commit -m "feat: Fase 1 — tabla EDT + motor CPM"
git push origin main
```

### 2. Activar GitHub Pages

1. Ir a **Settings → Pages** en el repositorio.
2. Seleccionar **Source: Deploy from a branch**.
3. Branch: `main`, carpeta: `/ (root)`.
4. Guardar.

El archivo `.nojekyll` ya está incluido para que GitHub Pages sirva todos los archivos.

### 3. Acceder

```
https://<usuario>.github.io/<repositorio>/
```

---

## Estructura del proyecto

```
/
├── index.html              # Punto de entrada
├── css/
│   ├── tokens.css          # Variables de diseño
│   ├── layout.css          # Layout de 3 paneles
│   ├── components.css      # Componentes UI
│   └── print.css           # Estilos de impresión
├── js/
│   ├── config.js           # Configuración (no commitear si tiene llaves)
│   ├── config.example.js   # Plantilla de configuración
│   ├── main.js             # Punto de entrada JS
│   ├── state.js            # Estado global + undo/redo
│   ├── cpm.js              # Motor CPM
│   ├── calendar.js         # Utilidades de calendario
│   ├── wbs-table.js        # Tabla EDT interactiva
│   ├── storage.js          # IndexedDB (offline-first)
│   ├── i18n.js             # Traducciones (es-PE)
│   ├── demo-data.js        # Datos demo
│   └── workers/
│       └── cpm.worker.js   # Web Worker CPM
├── sql/
│   ├── schema.sql          # Esquema PostgreSQL
│   ├── rls.sql             # Políticas RLS Supabase
│   └── seed.sql            # Datos iniciales
├── tests/
│   └── cpm.test.html       # Pruebas del motor CPM
├── .nojekyll               # Requerido por GitHub Pages
├── DECISIONES.md           # Decisiones de arquitectura
└── CONTRIBUTING.md         # Guía de contribución
```

---

## Fases de desarrollo

| Fase | Estado | Descripción |
|------|--------|-------------|
| 1 | ✅ Completa | Estado, IndexedDB, calendario, tabla EDT, motor CPM, datos demo |
| 2 | 🔄 Pendiente | Gantt con Canvas + SVG |
| 3 | 🔄 Pendiente | Panel de calidad DCMA |
| 4 | 🔄 Pendiente | Impresión, exportación JSON/CSV/MS Project |
| 5 | 🔄 Pendiente | Sincronización Supabase, RLS, modo offline |
| 6 | 🔄 Pendiente | Valor ganado, curva S, historial de cambios |

---

## Pruebas

Abrir en el navegador (con servidor local activo):

```
http://localhost:8080/tests/cpm.test.html
```

Las pruebas P1.1–P1.8 deben pasar todas en verde.

---

## Licencia

MIT — Ver LICENSE para detalles.
