// @ts-check
/**
 * supabase.js — Cliente HTTP ligero para Supabase REST API.
 *
 * No depende del SDK oficial: solo fetch + anon key (D9).
 * Exporta un singleton `sb` con métodos: select, insert, upsert, softDelete, rpc.
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY, IS_LOCAL_MODE } from './config.js';

// ============================================================
// Cliente base
// ============================================================

class SupabaseClient {
  constructor(url, anonKey) {
    this._url  = url.replace(/\/$/, '');
    this._key  = anonKey;
    /** @type {string|null} JWT del usuario autenticado */
    this._token = null;
  }

  /** Fija el JWT de sesión tras el login. */
  setToken(jwt) { this._token = jwt; }
  clearToken()  { this._token = null; }

  _headers(extra = {}) {
    return {
      'Content-Type':  'application/json',
      'apikey':         this._key,
      'Authorization': `Bearer ${this._token ?? this._key}`,
      'Prefer':        'return=representation',
      ...extra,
    };
  }

  /**
   * GET /rest/v1/<tabla>?<filtros>&select=<cols>
   * @param {string} tabla
   * @param {Record<string,string>} [filters]  Ej: { project_id: 'eq.uuid' }
   * @param {string} [select]  columnas PostgREST
   * @returns {Promise<any[]>}
   */
  async select(tabla, filters = {}, select = '*') {
    const params = new URLSearchParams({ select, ...filters });
    const res = await fetch(`${this._url}/rest/v1/${tabla}?${params}`, {
      headers: this._headers(),
    });
    if (!res.ok) throw await _pgError(res);
    return res.json();
  }

  /**
   * POST /rest/v1/<tabla>  (INSERT único o lote)
   * @param {string} tabla
   * @param {object|object[]} rows
   * @returns {Promise<any[]>}
   */
  async insert(tabla, rows) {
    const body = Array.isArray(rows) ? rows : [rows];
    const res  = await fetch(`${this._url}/rest/v1/${tabla}`, {
      method:  'POST',
      headers: this._headers(),
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw await _pgError(res);
    return res.json();
  }

  /**
   * POST /rest/v1/<tabla> con Prefer: resolution=merge-duplicates (UPSERT).
   * @param {string} tabla
   * @param {object|object[]} rows
   * @param {string} [onConflict]  columnas de conflicto separadas por coma
   * @returns {Promise<any[]>}
   */
  async upsert(tabla, rows, onConflict = 'id') {
    const body = Array.isArray(rows) ? rows : [rows];
    const res  = await fetch(`${this._url}/rest/v1/${tabla}`, {
      method:  'POST',
      headers: this._headers({
        'Prefer': `return=representation,resolution=merge-duplicates`,
        ...(onConflict ? { 'X-Upsert': onConflict } : {}),
      }),
      body:    JSON.stringify(body),
    });
    if (!res.ok) throw await _pgError(res);
    return res.json();
  }

  /**
   * PATCH /rest/v1/<tabla>?id=eq.<id>  (UPDATE parcial)
   * @param {string} tabla
   * @param {string} id
   * @param {object} campos
   * @returns {Promise<any[]>}
   */
  async update(tabla, id, campos) {
    const res = await fetch(`${this._url}/rest/v1/${tabla}?id=eq.${id}`, {
      method:  'PATCH',
      headers: this._headers(),
      body:    JSON.stringify(campos),
    });
    if (!res.ok) throw await _pgError(res);
    return res.json();
  }

  /**
   * Soft-delete: PATCH deleted_at = now() en lugar de DELETE real.
   * @param {string} tabla
   * @param {string} id
   */
  async softDelete(tabla, id) {
    return this.update(tabla, id, { deleted_at: new Date().toISOString() });
  }

  /**
   * POST /rest/v1/rpc/<nombre>
   * @param {string} nombre
   * @param {object} [params]
   */
  async rpc(nombre, params = {}) {
    const res = await fetch(`${this._url}/rest/v1/rpc/${nombre}`, {
      method:  'POST',
      headers: this._headers({ 'Prefer': 'return=representation' }),
      body:    JSON.stringify(params),
    });
    if (!res.ok) throw await _pgError(res);
    return res.json();
  }

  // ---- Realtime (suscripción a cambios) ----

  /**
   * Suscribe a cambios de una tabla vía Supabase Realtime WebSocket.
   * Devuelve una función para desuscribirse.
   *
   * @param {string} tabla
   * @param {string} projectId
   * @param {(evento:{type:string,record:object}) => void} onEvent
   * @returns {() => void} unsub
   */
  subscribe(tabla, projectId, onEvent) {
    const wsUrl = this._url
      .replace('https://', 'wss://')
      .replace('http://',  'ws://')
      + '/realtime/v1/websocket?apikey=' + encodeURIComponent(this._key) + '&vsn=1.0.0';

    const ws = new WebSocket(wsUrl);
    let heartbeat = null;

    ws.addEventListener('open', () => {
      // Enviar join al canal de la tabla filtrada por project_id
      ws.send(JSON.stringify({
        topic:   `realtime:public:${tabla}:project_id=eq.${projectId}`,
        event:   'phx_join',
        payload: { config: { postgres_changes: [{ event: '*', schema: 'public', table: tabla }] } },
        ref:     null,
      }));
      heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
        }
      }, 25000);
    });

    ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.event === 'postgres_changes' && msg.payload?.data) {
          const { type, record, old_record } = msg.payload.data;
          onEvent({ type, record: type === 'DELETE' ? old_record : record });
        }
      } catch { /* ignorar mensajes malformados */ }
    });

    ws.addEventListener('error', () => { /* conexión perdida — sync polleará */ });

    return () => {
      if (heartbeat) clearInterval(heartbeat);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    };
  }
}

async function _pgError(res) {
  let body = '';
  try { body = JSON.stringify(await res.json()); } catch { body = await res.text(); }
  return new Error(`Supabase ${res.status}: ${body}`);
}

// ============================================================
// Singleton — null cuando IS_LOCAL_MODE
// ============================================================

export const sb = IS_LOCAL_MODE ? null : new SupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);
