// @ts-check
'use strict';
/**
 * preload-print.js — Preload para ventanas de vista previa de impresión.
 * Reemplaza window.print() con generación directa de PDF vía IPC,
 * mostrando un modal personalizado en lugar del diálogo nativo.
 */

const { ipcRenderer } = require('electron');

function _ecmGeneratePdf() {
  const title     = document.title || 'ECM Project-Gantt';
  const pageStyleEl = document.getElementById('page-style');
  const isLandscape = !pageStyleEl || pageStyleEl.textContent.includes('landscape');

  // Mostrar overlay de "Generando PDF..."
  let overlay = document.getElementById('ecm-pdf-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'ecm-pdf-overlay';
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:99999',
    'display:flex;align-items:center;justify-content:center',
    'background:rgba(21,33,56,0.62);backdrop-filter:blur(3px)',
    'font-family:"Segoe UI",system-ui,sans-serif',
  ].join(';');
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:16px;padding:40px 48px;text-align:center;
                box-shadow:0 16px 48px rgba(0,0,0,0.28);min-width:340px;max-width:480px;">
      <div style="font-size:52px;margin-bottom:18px;line-height:1">📄</div>
      <div style="font-size:17px;font-weight:700;color:#1565C0;margin-bottom:8px">Generando PDF…</div>
      <div style="font-size:13px;color:#78909C">El archivo se guardará en Documentos / ECM Project</div>
      <div style="margin-top:20px;height:4px;border-radius:2px;background:#E3F2FD;overflow:hidden">
        <div id="ecm-progress-bar"
             style="height:100%;border-radius:2px;background:#1976D2;width:0%;
                    transition:width 2.5s ease-out"></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  // Animar barra
  requestAnimationFrame(() => {
    const bar = document.getElementById('ecm-progress-bar');
    if (bar) bar.style.width = '85%';
  });

  ipcRenderer.invoke('ecm-print-pdf', { title, landscape: isLandscape })
    .then((result) => {
      const bar = document.getElementById('ecm-progress-bar');
      if (bar) { bar.style.transition = 'width 0.3s'; bar.style.width = '100%'; }

      if (result && result.success) {
        const shortPath = result.path.replace(/.*[/\\]ECM Project[/\\]/, 'Documentos/ECM Project/');
        overlay.querySelector('div > div').innerHTML = `
          <div style="font-size:52px;margin-bottom:18px;line-height:1">✅</div>
          <div style="font-size:17px;font-weight:700;color:#2E7D32;margin-bottom:10px">
            PDF generado exitosamente</div>
          <div style="font-size:12px;color:#546E7A;word-break:break-all;margin-bottom:20px;
                      background:#F1F8E9;border-radius:8px;padding:8px 12px">
            📁 ${shortPath}</div>
          <button onclick="document.getElementById('ecm-pdf-overlay').remove()"
                  style="background:#1976D2;color:#fff;border:none;border-radius:8px;
                         padding:9px 28px;font-size:14px;font-weight:600;cursor:pointer">
            Cerrar</button>`;
        setTimeout(() => overlay.remove(), 6000);
      } else {
        overlay.querySelector('div > div').innerHTML = `
          <div style="font-size:52px;margin-bottom:18px;line-height:1">❌</div>
          <div style="font-size:17px;font-weight:700;color:#C62828;margin-bottom:10px">
            Error al generar PDF</div>
          <div style="font-size:13px;color:#78909C;margin-bottom:20px">
            ${(result && result.error) ? result.error : 'Error desconocido'}</div>
          <button onclick="document.getElementById('ecm-pdf-overlay').remove()"
                  style="background:#B71C1C;color:#fff;border:none;border-radius:8px;
                         padding:9px 28px;font-size:14px;font-weight:600;cursor:pointer">
            Cerrar</button>`;
      }
    })
    .catch(() => { overlay.remove(); });
}

// Override window.print() — sobrevive a document.write() porque window persiste
Object.defineProperty(window, 'print', {
  configurable: true,
  writable:     true,
  value:        _ecmGeneratePdf,
});

// Exponer también como global para onclick directo
window.ecmIsElectron  = true;
window.ecmGeneratePdf = _ecmGeneratePdf;
