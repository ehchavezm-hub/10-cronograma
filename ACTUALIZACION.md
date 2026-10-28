# ECM Project — Registro de Desarrollo

> Este archivo se actualiza al final de cada sesión de desarrollo.
> Sirve como memoria persistente para continuar sin re-explicar el contexto.

---

## ¿Qué es este proyecto?

ECM Project es una aplicación web de gestión de proyectos de construcción e ingeniería. Permite planificar, monitorear y reportar proyectos usando metodologías LPS (Last Planner System), Gantt, Red CPM, EVM y análisis de riesgos. Está orientada a empresas constructoras con estructura jerárquica multi-empresa/portafolio/programa/proyecto.

- **Repositorio:** `ehchavezm-hub/10-cronograma` (rama `main`)
- **URL producción:** `https://ehchavezm-hub.github.io/10-cronograma/`
- **URL staging/dev:** N/A — se verifica con servidor local `python3 -m http.server 8765`
- **Stack tecnológico:** `Frontend: SPA HTML/JS ES modules | Backend: Supabase REST API | Base de datos: Supabase (PostgreSQL) | Deploy: GitHub Pages`

---

## Arquitectura del proyecto

```
10-cronograma/
  index.html              ← punto de entrada único (SPA)
  sw.js                   ← Service Worker — cache-busting obligatorio
  manifest.json           ← PWA manifest
  CLAUDE.md               ← protocolo de trabajo obligatorio
  ACTUALIZACION.md        ← este archivo
  css/
    tokens.css            ← design tokens (colores, espaciado)
    layout.css            ← estructura de la app
    components.css        ← componentes reutilizables
    print.css             ← estilos de impresión
  js/
    main.js               ← app principal LPS (Gantt, CPM, Lookahead, Stand-Up)
    admin-console.js      ← módulo Administración completo (~2600 líneas)
    pdf-utils.js          ← utilidad compartida PDF (PAPER_SELECT_HTML, PAPER_JS)
    print.js              ← PDF Gantt/Cronograma
    pdf-report.js         ← reportes PDF ejecutivos (EVM, Informe, etc.)
    reports.js            ← reportes adicionales del proyecto
    supabase.js           ← cliente Supabase (_get, _post, _put, _delete)
    auth.js               ← autenticación
    state.js              ← estado global de la app
    gantt-canvas.js       ← renderizado Gantt en canvas
    gantt-svg.js          ← renderizado Gantt en SVG
    cpm.js                ← cálculo Red CPM
    evm.js                ← Earned Value Management
    curva-s.js            ← Curva S
    lookahead.js          ← módulo Lookahead
    lookahead-detailed.js ← Lookahead detallado
    monte-carlo.js        ← simulación Monte Carlo
    risk-register.js      ← Registro de riesgos
    baseline.js           ← Línea base del proyecto
    baseline-compare.js   ← Comparación con línea base
    wbs-table.js          ← Tabla WBS
    wbs-dictionary.js     ← Diccionario WBS
    resource-histogram.js ← Histograma de recursos
    resource-leveling.js  ← Nivelación de recursos
    dcma.js               ← Análisis DCMA 14-point
    change-log.js         ← Registro de cambios
    notifications.js      ← Sistema de notificaciones
    xer-import.js         ← Importación archivos .xer (Primavera)
    io.js                 ← Importación/exportación
    sync.js               ← Sincronización con Supabase
    scene.js              ← Motor de renderizado de vistas
    calendar.js           ← Gestión de calendarios laborales
    i18n.js               ← Internacionalización
    demo-data.js          ← Datos demo del proyecto
    demo-seed.js          ← Semilla de datos demo
    cache.js              ← Gestión de caché local
    async-queue.js        ← Cola de operaciones asíncronas
    connectivity.js       ← Verificación conectividad
    config.js             ← Configuración global
    storage.js            ← Abstracción de almacenamiento local
  fonts/
    fonts.css             ← fuentes locales
```

### Archivos críticos
| Archivo | Propósito |
|---------|-----------|
| `js/admin-console.js` | Módulo Administración — estructura jerárquica, org chart, reportes admin |
| `js/main.js` | App principal — Gantt, CPM, Lookahead, Stand-Up, todas las vistas LPS |
| `js/pdf-utils.js` | **Utilidad compartida** — selector de papel y JS para TODOS los reportes LPS |
| `js/print.js` | PDF del diagrama Gantt/Cronograma |
| `js/pdf-report.js` | PDFs ejecutivos: Informe, EVM, Curva S, etc. |
| `js/supabase.js` | Cliente REST Supabase — único punto de acceso a datos |
| `sw.js` | Service Worker — versionado de cache obligatorio en cada deploy |

---

## Dependencias y configuración

### Requisitos previos
- Node.js v18+ (para Playwright y validación de sintaxis)
- Python 3 (para servidor local de verificación)
- Playwright con Chromium en `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
- Cuenta Supabase con proyecto configurado

### Variables de entorno necesarias
```
SUPABASE_URL=          # URL del proyecto Supabase
SUPABASE_ANON_KEY=     # Clave anónima pública de Supabase
```
*(Configuradas en `js/config.js` o directamente en `js/supabase.js`)*

### Comandos principales
```bash
# Servidor local de desarrollo/verificación
python3 -m http.server 8765

# Validar sintaxis JS antes de commit
node --check js/admin-console.js
node --check js/main.js
node --check js/pdf-utils.js

# Screenshot de verificación con Playwright
node -e "
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: true, args: ['--no-sandbox']
  });
  const p = await b.newPage();
  await p.goto('http://localhost:8765/', { waitUntil: 'networkidle' });
  await p.screenshot({ path: '/tmp/verify.png' });
  await b.close();
})();
"

# Deploy: push a main via PR (GitHub Pages auto-deploy)
git push -f origin main-6r0m8g
# → crear PR → mergear (squash) → GitHub Pages despliega automáticamente
```

---

## Estado actual del proyecto

**Versión SW:** `cronogramas-v235`
**Última actualización:** `2026-10-28`

### Módulos / funcionalidades implementadas
| Módulo | Estado | Notas |
|--------|--------|-------|
| Gantt / Cronograma | ✅ Completo | Canvas + SVG, PDF A0-A6 |
| Red CPM | ✅ Completo | Cálculo crítico, PDF |
| LPS / Lookahead | ✅ Completo | Semanas configurables |
| Stand-Up Diario | ✅ Completo | Vista diaria |
| EVM (Earned Value) | ✅ Completo | Curvas PV/EV/AC, índices |
| Curva S | ✅ Completo | Avance físico vs planificado |
| Monte Carlo | ✅ Completo | Simulación de riesgos de cronograma |
| Registro de Riesgos | ✅ Completo | Matriz probabilidad-impacto |
| WBS / EDT | ✅ Completo | Tabla + diccionario |
| Histograma de Recursos | ✅ Completo | Por recurso y período |
| Nivelación de Recursos | ✅ Completo | Algoritmo de nivelación |
| Baseline / Línea Base | ✅ Completo | Captura y comparación |
| DCMA 14-point | ✅ Completo | Análisis de calidad del cronograma |
| Importación .XER | ✅ Completo | Primavera P6 |
| Administración — Estructura Jerárquica | ✅ Completo | Empresa→Portafolio→Programa→Proyecto |
| Administración — Org Chart Web | ✅ Completo | Canvas-style + CRUD inline |
| Administración — Org Chart PDF | ✅ Completo | Posicionamiento absoluto + SVG lines |
| Administración — Reportes Admin | ✅ Completo | Estructura, usuarios, auditoría |
| Administración — Reporte de Auditoría | ✅ Completo | Antes: "Actividad reciente" |
| Selectores de papel PDF (A0–A6) | ✅ Completo | Carta/Oficio/Legal/Tabloide eliminados |
| Service Worker / PWA | ✅ Completo | Cache-first, offline-ready |
| Datos DEMO | ✅ Completo | Proyecto de ejemplo precargado |
| CLAUDE.md | ✅ Completo | Protocolo de trabajo obligatorio |

---

## Historial de cambios recientes

| Commit | Fecha | Cambio | Archivos afectados |
|--------|-------|--------|--------------------|
| `e4fc1e5` | 2026-10-28 | Fusionar template CLAUDE.md generalizado con datos ECM Project | `CLAUDE.md` |
| `e934a43` | 2026-10-28 | Crear CLAUDE.md con protocolo obligatorio de verificación | `CLAUDE.md` |
| `a897a41` | 2026-10-28 | Eliminar Carta/Oficio/Legal/Tabloide de TODOS los módulos (fix completo) | `admin-console.js`, `pdf-utils.js`, `main.js`, `print.js`, `sw.js` |
| `57ce893` | 2026-10-28 | Renombrar "Actividad reciente" → "Reporte de auditoría" | `admin-console.js` |
| `addf460` | 2026-10-28 | Ocultar scrollbars en PDF preview | `admin-console.js` |
| `353e67e` | 2026-10-28 | Rewrite org chart PDF con posicionamiento absoluto + SVG lines | `admin-console.js` |
| `75642b4` | 2026-10-27 | Auditoría técnica v1 — reportes + UI | múltiples |
| `21d75f2` | 2026-10-27 | Reportes Estructura Jerárquica y Usuarios en Administración | `admin-console.js` |

---

## Bugs resueltos

| # | Síntoma | Causa raíz | Fix aplicado | Commit |
|---|---------|-----------|--------------|--------|
| c9 | Líneas conectoras del org chart PDF en desorden | `display:flex` + `border-left` en elementos `width:0` | Rewrite completo con posicionamiento absoluto + SVG `<line>` | `353e67e` |
| c10 | Scrollbars horizontal y vertical visibles en PDF preview | `overflow` visible en body al abrir iframe de PDF | `::-webkit-scrollbar{display:none}` + `overflow:hidden` en `@media print` | `addf460` |
| c12 | Nombre incorrecto "Actividad reciente" en reporte de auditoría | Nombre original no actualizado al renombrar la funcionalidad | Cambio en lista de reportes y en título PDF | `57ce893` |
| c13 | Carta/Oficio/Legal/Tabloide aparecían en selectores de papel | Búsqueda incompleta — se corrigieron solo 2 de 4 archivos en primer intento | grep exhaustivo en todos los .js → corrección en 4 archivos | `a897a41` |
| c7 | Reportes mostraban solo 50/100 filas | `limit:'50'`/`limit:'100'` hardcodeado en llamadas `_get()` | Eliminar parámetro `limit` de todas las consultas de reportes | `b58108e` |
| c6 | Org chart PDF desbordaba el ancho de la hoja | Sin auto-scale en árbol amplio | Wrapper `jer-outer`/`jer-inner` + función `fitJer` | `d4401f0` |

---

## Decisiones técnicas tomadas

| Decisión | Alternativas descartadas | Razón |
|----------|--------------------------|-------|
| SVG `<line>` para conectores en PDF | `border-left`/`background-color`, pseudoelementos CSS | CSS `background` no imprime por defecto; SVG siempre se renderiza en pantalla y PDF |
| Posicionamiento absoluto para org chart PDF | `display:flex`, CSS grid | Flex con elementos `width:0` genera líneas en posiciones incorrectas |
| `print-color-adjust:exact` en `@media print` | Ninguna alternativa | Sin esto, fondos de color no se imprimen en la mayoría de browsers |
| Tamaños de papel solo A0–A6 | Carta, Oficio, Legal, Tabloide | Estándar internacional ISO; el cliente requiere solo formatos métricos |
| Service Worker cache-first + versionado por `?v=N` | Sin cache, cache-network | SPA estática en GitHub Pages — cache-first garantiza offline y velocidad |
| Un solo `admin-console.js` monolítico (~2600 líneas) | Múltiples módulos separados | La app es una SPA sin bundler; un archivo reduce peticiones HTTP |
| `pdf-utils.js` como utilidad compartida para papel/print | Duplicar en cada módulo | Garantiza consistencia entre módulos LPS y evita el error de c13 |

---

## Patrones y convenciones del proyecto

- **Módulo Admin**: todo en `js/admin-console.js` — funciones prefijadas con `_` (privadas) o sin prefijo (públicas)
- **Módulo LPS**: todo en `js/main.js` — vistas registradas como objetos en `VIEWS[]`
- **Acceso a datos**: siempre via `_get(tabla, params)`, `_post()`, `_put()`, `_delete()` de `supabase.js`
- **Reportes PDF admin**: `_printAdmPdf(title, html, ctxName, frame)` — escribe HTML completo en iframe
- **Selectores de papel**: usar `PAPER_SEL` (admin) o `PAPER_SELECT_HTML` (pdf-utils) — nunca hardcodear
- **Tamaños de papel JS**: objeto `PAPERS = { A0:[841,1189], A1:[594,841], ... }` — siempre en mm
- **Cache busting**: al modificar cualquier JS, incrementar `CACHE` en `sw.js` + `?v=N` del archivo
- **Nombres de funciones**: camelCase (`renderOrgChart`, `buildJer`, `printPdf`)
- **Sin comentarios** que expliquen el "qué"; solo comentar el "por qué" cuando no es obvio

---

## Integraciones externas

| Servicio | Propósito | Credenciales | Documentación |
|----------|-----------|-------------|---------------|
| Supabase | Base de datos PostgreSQL + autenticación | En `js/config.js` (no commiteado) | https://supabase.com/docs |
| GitHub Pages | Deploy automático desde rama `main` | Token GitHub del repo | https://pages.github.com |

---

## Tareas pendientes

### Alta prioridad
- [ ] Auditoría v88 — revisar todos los módulos post-correcciones c9–c13

### Media prioridad
- [ ] Tests automatizados para módulos de cálculo (EVM, CPM, Monte Carlo)
- [ ] Optimizar tamaño de `admin-console.js` (~2600 líneas) considerando split si crece más

### Backlog / ideas futuras
- [ ] Exportación a MS Project (.mpp)
- [ ] Integración con Primavera P6 Cloud API
- [ ] Notificaciones push para hitos de proyecto

---

## Problemas conocidos / limitaciones

- `github.io` no es accesible desde el contenedor de desarrollo — verificación visual requiere servidor local + Playwright
- `admin-console.js` es un monolito (~2600 líneas) — búsquedas con grep son obligatorias antes de editar
- El proxy del entorno de desarrollo bloquea algunos MCP servers (Slack, Asana, Linear, Atlassian)

---

## Cómo continuar el desarrollo

1. Clona el repo: `git clone https://github.com/ehchavezm-hub/10-cronograma.git`
2. Lee `CLAUDE.md` (protocolo obligatorio) y este archivo completo
3. Revisa el historial reciente: `git log --oneline -20`
4. Levanta el servidor local: `python3 -m http.server 8765`
5. Verifica el estado visual con Playwright antes de hacer cambios
6. Sigue el **Protocolo de 5 pasos** de `CLAUDE.md` antes de reportar "listo"
7. Continúa desde la sección **Tareas pendientes**

---

## Notas de la última sesión

**Fecha:** `2026-10-28`
**Sesión:** `https://claude.ai/code/session_01HviLPgRapjwX8691uUAvNz`

En esta sesión se completaron las correcciones c9–c13 y se creó la documentación permanente del proyecto:

- **c9**: Rewrite completo del org chart PDF — de flex+border-left a posicionamiento absoluto + SVG lines. Las líneas ahora se renderizan correctamente en pantalla y al imprimir.
- **c10**: Eliminados scrollbars en PDF preview con CSS webkit + scrollbar-width:none.
- **c12**: "Actividad reciente" renombrado a "Reporte de auditoría" en lista y título PDF.
- **c13**: Corrección crítica — en el primer intento solo se corrigieron 2 de 4 archivos (false positive). Tras grep exhaustivo se encontraron y corrigieron los 4 archivos que contenían Carta/Oficio/Legal/Tabloide: `admin-console.js`, `pdf-utils.js`, `main.js`, `print.js`.
- **CLAUDE.md**: Creado con protocolo obligatorio de 5 pasos para evitar false positives futuros. Incluye mandatos permanentes, reglas de PDF, flujo git, errores comunes y anti-patrones.
- **ACTUALIZACION.md**: Este archivo — registro de desarrollo completo del proyecto.

**Lección principal de esta sesión**: Nunca reportar "listo" sin ejecutar `grep -rn` en TODOS los archivos antes Y después del cambio. El error de c13 costó 2 ciclos extra de corrección.
