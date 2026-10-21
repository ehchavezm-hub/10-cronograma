// @ts-check
/**
 * monitoring.js — Integración opcional de Sentry para ECM Project.
 *
 * SETUP (una sola vez en index.html, ANTES de cargar main.js):
 *
 *   <!-- 1. Cargar Sentry desde CDN -->
 *   <script
 *     src="https://browser.sentry-cdn.com/7.99.0/bundle.min.js"
 *     crossorigin="anonymous"
 *   ></script>
 *
 *   <!-- 2. Inicializar con tu DSN de Supabase/Sentry -->
 *   <script>
 *     window.__ECM_SENTRY_DSN__ = "https://XXXXXXXX@oXXXXXX.ingest.sentry.io/XXXXXXX";
 *   </script>
 *
 * Luego importar e inicializar desde main.js:
 *   import { initMonitoring } from './monitoring.js';
 *   initMonitoring(window.__ECM_SENTRY_DSN__);
 */

let _initialized = false;

/** @returns {any} */
function _sentry() {
  return /** @type {any} */ (typeof window !== 'undefined' ? window['Sentry'] : undefined);
}

/**
 * Inicializa Sentry si el SDK está disponible y se provee un DSN válido.
 * @param {string|undefined} dsn
 */
export function initMonitoring(dsn) {
  if (_initialized || !dsn) return;
  const Sentry = _sentry();
  if (!Sentry?.init) {
    console.warn('[monitoring] Sentry SDK no cargado. Operando en modo consola.');
    _attachFallbackHandlers();
    _initialized = true;
    return;
  }
  try {
    Sentry.init({
      dsn,
      tracesSampleRate: 0.1,
      environment: location.hostname === 'localhost' ? 'development' : 'production',
      release: 'ecm-project@89',
      integrations: [
        new Sentry.BrowserTracing(),
      ],
      beforeSend(event) {
        // No enviar datos de usuarios internos en desarrollo
        if (location.hostname === 'localhost') return null;
        return event;
      },
    });
    _initialized = true;
    console.info('[monitoring] Sentry inicializado.');
  } catch (err) {
    console.error('[monitoring] Error al inicializar Sentry:', err);
    _attachFallbackHandlers();
    _initialized = true;
  }
}

/**
 * Captura un error con contexto adicional.
 * @param {unknown} err
 * @param {Record<string,unknown>} [context]
 */
export function captureError(err, context) {
  const Sentry = _sentry();
  if (Sentry?.captureException) {
    if (context) Sentry.setContext('ecm', context);
    Sentry.captureException(err);
  } else {
    console.error('[monitoring] captureError:', err, context ?? '');
  }
}

/**
 * Captura un mensaje con nivel de severidad.
 * @param {string} msg
 * @param {'info'|'warning'|'error'} [level]
 */
export function captureMessage(msg, level = 'info') {
  const Sentry = _sentry();
  if (Sentry?.captureMessage) {
    Sentry.captureMessage(msg, level);
  } else {
    const fn = level === 'error' ? console.error : level === 'warning' ? console.warn : console.info;
    fn(`[monitoring] ${level.toUpperCase()}: ${msg}`);
  }
}

/**
 * Envuelve una operación (como el cálculo CPM o importación WBS) para
 * medir su duración y capturar errores automáticamente.
 * @template T
 * @param {string} name  Nombre de la operación (e.g. "cpm.calculate")
 * @param {() => T|Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function trackOperation(name, fn) {
  const Sentry = _sentry();
  const t0 = performance.now();
  let transaction;
  if (Sentry?.startTransaction) {
    transaction = Sentry.startTransaction({ name, op: 'ecm.operation' });
  }
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - t0);
    if (ms > 3000) captureMessage(`Operación lenta: ${name} (${ms} ms)`, 'warning');
    return result;
  } catch (err) {
    captureError(err, { operation: name });
    throw err;
  } finally {
    transaction?.finish();
  }
}

/** Handlers de fallback cuando Sentry no está disponible. */
function _attachFallbackHandlers() {
  window.addEventListener('unhandledrejection', ev => {
    console.error('[monitoring] Unhandled rejection:', ev.reason);
  });
  window.addEventListener('error', ev => {
    console.error('[monitoring] Global error:', ev.message, ev.filename, ev.lineno);
  });
}
