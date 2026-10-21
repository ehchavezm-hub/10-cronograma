// @ts-check
'use strict';
/**
 * preload-print.js — Preload para ventanas de vista previa de impresión.
 * Reemplaza window.print() con printToPDF vía IPC para evitar el
 * diálogo nativo de Windows y generar el PDF directamente con nombre correcto.
 */

const { ipcRenderer } = require('electron');

// Override window.print antes de que cualquier script de la página se ejecute.
// Sobrevive a document.write() porque window persiste en el mismo contexto.
Object.defineProperty(window, 'print', {
  configurable: true,
  writable: true,
  value: function ecmPrint() {
    const title = document.title || 'ECM Project-Gantt';
    // Leer orientación actual del estilo @page de la página
    const pageStyleEl = document.getElementById('page-style');
    const isLandscape = !pageStyleEl || pageStyleEl.textContent.includes('landscape');
    ipcRenderer.invoke('ecm-print-pdf', { title, landscape: isLandscape }).catch(() => {
      // no fallback al diálogo nativo — el PDF se abre en el visor del sistema
    });
  }
});
