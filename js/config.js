// @ts-check
/**
 * config.js — Claves públicas de Supabase.
 * SOLO la URL y la anon key (públicas por diseño).
 * La service_role NUNCA aparece aquí (D9).
 *
 * Instrucciones: copie config.example.js a config.js
 * y reemplace los valores con los de su proyecto Supabase.
 */

export const SUPABASE_URL      = 'https://rduzdeojbcelfjqsuvht.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJkdXpkZW9qYmNlbGZqcXN1dmh0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxNTM4ODEsImV4cCI6MjEwNzcyOTg4MX0.QNno9SCL8xiTa2BmNSKAfT-rHNvD1wpyKiOJVJB0_98';

// Si ambas están vacías, la app funciona en Modo local (sin conexión).
export const IS_LOCAL_MODE = !SUPABASE_URL || !SUPABASE_ANON_KEY;
