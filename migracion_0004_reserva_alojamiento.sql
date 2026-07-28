-- ============================================================
-- Sicilia 2026 · Migración 0004: casa reservada + link de invitación
-- Marca una casa como reservada y guarda el link de invitación de
-- Airbnb (co-viajero) para que la familia se una a la reserva.
-- Correr en: Supabase → SQL Editor → New query → Run
-- ============================================================

alter table alojamientos add column if not exists reservada boolean not null default false;
alter table alojamientos add column if not exists invite text;

-- (opcional) comprobar
-- select id, base, nombre, reservada, invite from alojamientos;
