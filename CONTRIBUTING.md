# CONTRIBUTING.md — Guía de contribución

## Estilo de código

- **ES Modules**: Todos los archivos JS usan `import`/`export`. Sin bundler ni transpiler.
- **Sin comentarios obvios**: Solo comentar el *por qué*, no el *qué*.
- **Nombres descriptivos**: Variables y funciones deben ser autoexplicativos.
- **`@ts-check`** al inicio de cada módulo para validación tipo IDE.
- Indentación: 2 espacios.
- Comillas: simples para JS, dobles para atributos HTML.

## Estructura de módulos

| Módulo | Responsabilidad |
|--------|----------------|
| `state.js` | Estado global, undo/redo, comandos |
| `cpm.js` | Algoritmo CPM puro (sin efectos secundarios) |
| `calendar.js` | Conversión fecha ↔ índice de día laborable |
| `storage.js` | IndexedDB, outbox, persistencia local |
| `wbs-table.js` | Render y edición de la tabla EDT |
| `sync.js` (Fase 5) | Sincronización con Supabase |

## Agregar una verificación DCMA

Las verificaciones DCMA se ubican en `js/dcma.js`. Cada verificación es una función pura:

```js
/**
 * @param {Map<string,CpmTaskResult>} tasks
 * @param {import('./cpm.js').TaskDependency[]} deps
 * @returns {DcmaFinding[]}
 */
export function checkMissingLogic(tasks, deps) {
  // Una actividad sin predecesores NI sucesores (excepto inicio/fin del proyecto)
  // ...
  return findings;
}
```

Luego registrarla en el array `CHECKS` de `dcma.js`:

```js
export const CHECKS = [
  { id: 'MISSING_LOGIC', fn: checkMissingLogic, category: 'logic', severity: 'high' },
  // ...
];
```

## Flujo de comandos (undo/redo)

Todo cambio de datos pasa por `appState.dispatch(cmd)`:

```js
appState.dispatch({
  type: 'ADD_TASK',
  payload: { task: { id, name, duration_days, ... } }
});
```

El inverso del comando se calcula en `state.js` automáticamente.

## Datos de prueba

Modificar `js/demo-data.js` para agregar tareas al proyecto demo. Los IDs fijos (`00000000-…`) garantizan idempotencia al recargar.

## Convenciones de ID

- IDs de objetos demo: `00000000-0000-0000-0000-{tipo}{número}` (ej: `000000000010` para proyectos).
- IDs generados en tiempo de ejecución: `crypto.randomUUID()`.

## Compatibilidad con GitHub Pages

- Sin rutas absolutas que comiencen con `/js/` fuera de `index.html`.
- Todos los imports de módulos usan rutas relativas: `'./cpm.js'`, `'../calendar.js'`.
- El archivo `.nojekyll` debe estar en la raíz.
