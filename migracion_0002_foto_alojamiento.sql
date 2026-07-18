-- ============================================================
-- Sicilia 2026 · Migración 0002: foto del alojamiento
-- Guarda la miniatura que trae el auto-relleno desde el link.
-- Correr en: Supabase → SQL Editor → New query → Run
-- ============================================================

alter table alojamientos add column if not exists foto text;

-- (opcional) comprobar
-- select id, base, nombre, foto from alojamientos;
