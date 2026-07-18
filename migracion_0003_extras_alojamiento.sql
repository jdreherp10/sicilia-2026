-- ============================================================
-- Sicilia 2026 · Migración 0003: extras / tasas en efectivo
-- Guarda las tasas (tassa di soggiorno, pagos en efectivo, depósitos)
-- que el auto-relleno detecta en la descripción del anuncio.
-- Correr en: Supabase → SQL Editor → New query → Run
-- ============================================================

alter table alojamientos add column if not exists extras jsonb not null default '[]'::jsonb;

-- (opcional) comprobar
-- select id, base, nombre, extras from alojamientos;
