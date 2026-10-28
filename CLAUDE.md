# CLAUDE.md — ECM Project · Protocolo de trabajo obligatorio

## Identidad del proyecto

- **Nombre de la app**: ECM Project (nunca "Cronograma", nunca "COSAPI")
- **Repo**: `ehchavezm-hub/10-cronograma`
- **Deploy**: GitHub Pages desde rama `main`
- **Rama de desarrollo**: `main-6r0m8g` (reset a `origin/main` antes de cada cambio)
- **Stack**: SPA estática HTML/JS ES modules + Supabase REST API + Service Worker

---

## MANDATOS PERMANENTES — nunca ignorar

1. **Nunca parar de trabajar.** Trabajar en paralelo con todos los agentes disponibles.
2. **Siempre crear Y mergear el PR** en tiempo real, inmediatamente después de cada cambio.
3. **Nunca modificar texto existente** de la UI sin instrucción explícita.
4. **Nunca cambiar colores de barras Gantt** sin instrucción explícita.
5. **La app se llama ECM Project** — nunca "Cronograma", nunca "COSAPI".
6. **Eliminar la palabra COSAPI** de todo el desarrollo del aplicativo.
7. **Nunca desproporción** entre dimensiones verticales y horizontales en visualizaciones.
8. **No es necesario indicar de qué color es cada elemento** en leyendas.
9. **Si llegan múltiples correcciones seguidas**, aplicarlas todas aunque no haya terminado la primera.
10. **No mentir** — nunca reportar algo como "listo" sin haberlo verificado.

---

## PROTOCOLO OBLIGATORIO antes de reportar "listo"

### Paso 1 — Búsqueda exhaustiva ANTES de tocar nada

```bash
grep -rn "TÉRMINO_A_CAMBIAR" /home/user/10-cronograma/js/ --include="*.js"
```

- Registrar TODOS los archivos encontrados
- Corregir TODOS, no solo el que "parece" el correcto
- Archivos donde vive la lógica por módulo:
  - **Administración**: `js/admin-console.js`
  - **LPS/Lookahead/Stand-Up/Recursos**: `js/pdf-utils.js` (utilidad compartida), `js/main.js`
  - **Gantt/Cronograma PDF**: `js/print.js`
  - **Red CPM**: `js/main.js`
  - **Reportes PDF generales**: `js/pdf-report.js`, `js/reports.js`

### Paso 2 — Verificar CERO instancias restantes

```bash
grep -rn "TÉRMINO_A_CAMBIAR" /home/user/10-cronograma/js/ --include="*.js"
# Debe retornar VACÍO. Si no → volver al Paso 1.
```

### Paso 3 — Verificación local con servidor + Playwright

Para cambios UI o de cálculo, levantar servidor local y verificar:

```bash
# Terminal 1: servidor
cd /home/user/10-cronograma && python3 -m http.server 8765 &

# Playwright: verificar el elemento cambiado
node -e "
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: true, args: ['--no-sandbox']
  });
  const p = await b.newPage();
  await p.goto('http://localhost:8765/', { waitUntil: 'networkidle' });
  // Tomar screenshot del elemento específico
  await p.screenshot({ path: '/tmp/verify.png' });
  await b.close();
})();
"
```

- Si el screenshot confirma el resultado → continuar
- Si no → corregir y repetir desde Paso 1

### Paso 4 — Validar sintaxis JS antes del commit

```bash
node --check js/admin-console.js
node --check js/main.js
node --check js/pdf-utils.js
# etc. para cada archivo modificado
```

### Paso 5 — Solo entonces: commit + push + PR + merge

```bash
git fetch origin main
git checkout -B main-6r0m8g origin/main
git add [archivos modificados]
git commit -m "fix(cN): descripción"
git push -f origin main-6r0m8g
# → crear PR → mergear inmediatamente
```

---

## Gestión del Service Worker (cache-busting)

Cada cambio en un archivo JS **debe** incrementar su versión en `sw.js`:

```javascript
// sw.js
const CACHE = 'cronogramas-vN';  // incrementar N
// En SHELL array:
'./js/admin-console.js?v=N',    // incrementar N
'./js/main.js?v=N',             // incrementar N
```

- Archivos sin versión en SHELL (`pdf-utils.js`, `print.js`, etc.) quedan invalidados por el bump del `CACHE`.
- **Nunca olvidar** actualizar ambos: el string `CACHE` Y el `?v=N` del archivo modificado.

---

## Estructura de archivos críticos

| Archivo | Responsabilidad |
|---|---|
| `js/admin-console.js` | Módulo Administración completo (~2600 líneas) |
| `js/main.js` | App principal LPS — Gantt, Red CPM, Lookahead, Stand-Up |
| `js/pdf-utils.js` | **Utilidad compartida** — PAPER_SELECT_HTML, PAPER_JS, estilos PDF |
| `js/print.js` | Reporte PDF Gantt/Diagrama de Gantt |
| `js/pdf-report.js` | Reportes PDF proyecto (Informe Ejecutivo, EVM, etc.) |
| `js/reports.js` | Reportes proyecto adicionales |
| `js/supabase.js` | Cliente Supabase — `_get()`, `_post()`, etc. |
| `sw.js` | Service Worker — cache-busting obligatorio |

---

## Reglas de PDF y reportes

- **Tamaños de papel permitidos**: A0, A1, A2, A3, A4 (default), A5, A6. **Prohibidos**: Carta, Oficio, Legal, Tabloide.
- **Líneas conectoras en PDF**: usar SVG `<line>` — siempre se renderiza en pantalla y PDF. Nunca usar `background-color` para líneas (no imprime por defecto).
- **Colores en PDF**: agregar `*{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}` en `@media print`.
- **Scrollbars en PDF**: ocultar con `::-webkit-scrollbar{display:none}` y `scrollbar-width:none`.
- **Org chart / Estructura Jerárquica**: usar posicionamiento absoluto + SVG lines (algoritmo `getW`/`place`), igual que `_renderOrgChartAdmin`.
- **Auto-scale**: wrapper `jer-outer`/`jer-inner`/`fitJer` para ajustar al ancho disponible.

---

## Reglas de la UI

- **Org chart web**: usa `_renderOrgChartAdmin` con canvas-style layout (CW/CH/HG/VG constantes).
- **Sin límites de filas** en reportes: nunca agregar `limit:'50'` o `limit:'100'` en llamadas `_get()`.
- **Jerarquía**: Empresa → Portafolio → Programa → Proyecto.
- **Administración niveles**: Plataforma → Empresa → Proyecto (selector en toolbar).

---

## Errores comunes y sus soluciones

| Error | Causa | Solución |
|---|---|---|
| Cambio no visible en prod | Cache SW no invalidado | Bump `CACHE` + `?v=N` del archivo |
| Push rechazado (non-fast-forward) | Branch divergió de main | `git push -f origin main-6r0m8g` |
| Líneas PDF en desorden | `display:flex` + `border-left` en `width:0` | Usar SVG `<line>` con posicionamiento absoluto |
| Colores no aparecen en PDF | `background` no imprime | Usar `border` o agregar `print-color-adjust:exact` |
| Reporte muestra solo 50/100 filas | `limit` en `_get()` | Eliminar el parámetro `limit` |
| Scrollbars en PDF preview | `overflow` visible en body | `::-webkit-scrollbar{display:none}` + `overflow:hidden` en `@media print` |
| Selector papel incompleto | Carta/Oficio en archivo equivocado | Buscar en TODOS: admin-console.js, pdf-utils.js, main.js, print.js |

---

## Git — flujo estándar

```bash
# Antes de cada feature/fix:
git fetch origin main
git checkout -B main-6r0m8g origin/main

# Commit:
git add [archivos específicos — nunca git add -A sin revisar]
git commit -m "fix(cN): descripción clara

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01HviLPgRapjwX8691uUAvNz"

# Push:
git push -f origin main-6r0m8g

# PR + merge inmediato (squash):
# → mcp__github__create_pull_request
# → mcp__github__merge_pull_request (squash)
```

---

## Lo que NO hacer

- ❌ Reportar "listo" sin haber verificado (visual + grep vacío)
- ❌ Asumir que el cambio está solo en un archivo sin buscar en todos
- ❌ Crear PR sin mergear inmediatamente
- ❌ Usar `git add -A` (puede incluir archivos sensibles)
- ❌ Modificar texto de la UI sin instrucción explícita
- ❌ Agregar comentarios innecesarios al código
- ❌ Usar `background-color` para líneas en PDF
- ❌ Poner límites (`limit`) en consultas de reportes
- ❌ Usar Carta/Oficio/Legal/Tabloide en selectores de papel
