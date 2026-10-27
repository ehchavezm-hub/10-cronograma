// @ts-check
'use strict';

const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');

// In dev: main.js is in electron/, web files are one level up.
// Packaged: electron-builder places extraResources at resources/app/ on disk.
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');
// Puerto fijo: el origen (http://127.0.0.1:PUERTO) identifica la base de datos local
// (IndexedDB/localStorage). Con un puerto aleatorio los datos "desaparecían" en cada arranque.
const PORTS    = [47613, 47614, 47615, 47616, 47617];

// El ejecutable es autónomo: siempre en Modo local (sin Supabase ni conexión a internet).
// La base de datos es la local, que se inicia con el proyecto DEMO.
const LOCAL_CONFIG_JS = [
  '// config.js servido por el ejecutable Windows: Modo local, sin conexión.',
  "export const SUPABASE_URL      = '';",
  "export const SUPABASE_ANON_KEY = '';",
  'export const IS_LOCAL_MODE = true;',
  '',
].join('\n');

/** Documentos HTML temporales para generar PDF desde la vista previa de Reportes. */
const PRINT_DOCS = new Map();
let _printSeq = 0;

// ── MIME types ────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.webmanifest': 'application/manifest+json',
};

// ── Local HTTP server (preserves ?v= cache-busting + ES modules) ──
let serverPort = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Strip query string for file lookup
      let pathname = '/';
      try { pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname); } catch { /* 404 */ }
      if (pathname === '/js/config.js') {
        res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
        res.end(LOCAL_CONFIG_JS); return;
      }
      if (pathname.startsWith('/__print/')) {
        const doc = PRINT_DOCS.get(pathname.slice(9));
        res.writeHead(doc ? 200 : 404, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
        res.end(doc || 'Not found'); return;
      }
      const filePath  = pathname === '/'
        ? path.join(APP_ROOT, 'index.html')
        : path.join(APP_ROOT, pathname.replace(/^\//, ''));

      // Security: prevent path traversal
      const realPath = path.resolve(filePath);
      if (!realPath.startsWith(path.resolve(APP_ROOT))) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      fs.readFile(realPath, (err, data) => {
        if (err) {
          res.writeHead(404); res.end('Not found'); return;
        }
        const ext  = path.extname(realPath).toLowerCase();
        const mime = MIME[ext] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mime,
          'Cache-Control': 'no-store',
          'Cross-Origin-Opener-Policy': 'same-origin',
        });
        res.end(data);
      });
    });

    let i = 0;
    const tryListen = () => server.listen(PORTS[i] ?? 0, '127.0.0.1');
    server.on('error', (err) => {
      if (/** @type {any} */ (err).code === 'EADDRINUSE' && i < PORTS.length) { i++; tryListen(); }
      else reject(err);
    });
    server.on('listening', () => {
      serverPort = /** @type {any} */(server.address()).port;
      resolve(serverPort);
    });
    tryListen();
  });
}

// ── Guardar PDF ──────────────────────────────────────────────
/** @param {string} name */
function _pdfFileName(name) {
  const base = String(name || 'ECM-Project')
    .replace(/\.pdf$/i, '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim() || 'ECM-Project';
  return base + '.pdf';
}

/**
 * Genera el PDF de una ventana (CSS @page: tamaño, márgenes, encabezado y pie)
 * y pregunta dónde guardarlo, proponiendo el nombre PROYECTO-Proceso-Fecha.
 * @param {Electron.WebContents} wc  contenido a imprimir
 * @param {BrowserWindow|null} parent  ventana dueña del diálogo
 * @param {string} name
 */
async function _savePdf(wc, parent, name) {
  const pdf = await wc.printToPDF({ printBackground: true, preferCSSPageSize: true });
  const docsDir = path.join(app.getPath('documents'), 'ECM Project');
  try { fs.mkdirSync(docsDir, { recursive: true }); } catch { /* sin carpeta: el diálogo elige */ }
  const opts = {
    title: 'Guardar PDF',
    defaultPath: path.join(docsDir, _pdfFileName(name)),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  };
  const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return { canceled: true };
  fs.writeFileSync(r.filePath, pdf);
  shell.openPath(r.filePath);
  return { success: true, path: r.filePath };
}

// Ventanas de reporte y vista previa de Reportes: se imprime una copia estática del documento
// (ver installDesktopPrint en js/pdf-utils.js)
ipcMain.handle('ecm-print-html', async (event, /** @type {{html:string,name:string}} */ opts) => {
  const id = String(++_printSeq);
  PRINT_DOCS.set(id, String(opts?.html || ''));
  const win = new BrowserWindow({
    show: false, width: 1200, height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, javascript: false, spellcheck: false },
  });
  try {
    await win.loadURL(`http://127.0.0.1:${serverPort}/__print/${id}`);
    await new Promise(r => setTimeout(r, 300)); // fuentes locales
    return await _savePdf(win.webContents, BrowserWindow.fromWebContents(event.sender), opts?.name);
  } catch (err) {
    return { error: String(err) };
  } finally {
    PRINT_DOCS.delete(id);
    if (!win.isDestroyed()) win.destroy();
  }
});

// ── IPC: Guardar PDF generado por jsPDF en el renderer ───────
ipcMain.handle('ecm-save-pdf-buffer', async (event, /** @type {{b64:string,fileName:string}} */ opts) => {
  try {
    const pdfBuf = Buffer.from(opts.b64 || '', 'base64');
    const rawName = opts.fileName || 'ECM-Project.pdf';
    const safeFileName = rawName
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/-+/g, '-')
      .replace(/^[_\-]+|[_\-]+$/g, '')
      .trim()
      || 'ECM-Project.pdf';
    const docsDir = path.join(os.homedir(), 'Documents', 'ECM Project');
    fs.mkdirSync(docsDir, { recursive: true });
    const pdfPath = path.join(docsDir, safeFileName);
    fs.writeFileSync(pdfPath, pdfBuf);
    shell.openPath(pdfPath);
    return { success: true, path: pdfPath };
  } catch (err) {
    return { error: String(err) };
  }
});

// ── Electron window ───────────────────────────────────────────
let mainWindow = null;

async function createWindow() {
  const port = await startServer();

  mainWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth:  900,
    minHeight: 600,
    title: 'ECM Project',
    icon: path.join(APP_ROOT, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
      spellcheck:       false, // sin descarga de diccionarios: el ejecutable no usa internet
      preload:          path.join(__dirname, 'preload-main.js'),
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Ventanas de impresión: usar preload que reemplaza window.print con printToPDF
  const preloadPrint = path.join(__dirname, 'preload-print.js');

  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    // Ventana en blanco → vista previa de impresión (printGantt usa window.open('','_blank'))
    if (!u || u === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1200, height: 800,
          title: 'ECM Project — Impresión',
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: false,
            nodeIntegration:  false,
            sandbox:          false,
            spellcheck:       false,
            preload:          preloadPrint,
          }
        }
      };
    }
    // Solo abrir externamente URLs http/https fuera del servidor local
    if ((u.startsWith('https://') || u.startsWith('http://')) && !u.startsWith('http://127.0.0.1')) {
      shell.openExternal(u);
    }
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// Una sola instancia: dos procesos sobre la misma base de datos local podrían pisarse.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(createWindow).catch((err) => {
    dialog.showErrorBox('ECM Project', 'No se pudo iniciar la aplicación:\n' + String(err));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!mainWindow) createWindow(); });
}
