// @ts-check
'use strict';
/**
 * preload-main.js — Puente mínimo para la ventana principal del ejecutable.
 * Los reportes (ventanas e iframe de Reportes) guardan el PDF con savePdfHtml.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ecmDesktop', {
  /** @param {string} html @param {string} name */
  savePdfHtml: (html, name) => ipcRenderer.invoke('ecm-print-html', { html, name }),
});
