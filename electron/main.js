// @ts-check
'use strict';

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const url   = require('url');

// In dev: main.js is in electron/, web files are one level up.
// Packaged: electron-builder places extraResources at resources/app/ on disk.
const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');
const PORT     = 0; // OS assigns a free port

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
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Strip query string for file lookup
      const pathname  = url.parse(req.url || '/').pathname || '/';
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

    server.listen(PORT, '127.0.0.1', () => {
      serverPort = /** @type {any} */(server.address()).port;
      resolve(serverPort);
    });
  });
}

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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('activate', () => { if (!mainWindow) createWindow(); });
