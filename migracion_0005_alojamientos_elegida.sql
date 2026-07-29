-- Migración 0005 · Sicilia 2026
-- Marca de "casa elegida" por base para el presupuesto de hospedaje (pestaña 📊 Hospedaje).
-- Idempotente y retrocompatible: la columna default false no afecta al código anterior.

alter table public.alojamientos
  add column if not exists elegida boolean not null default false;
