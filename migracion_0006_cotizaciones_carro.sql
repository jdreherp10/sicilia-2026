-- Migración 0006 · Sicilia 2026
-- Tabla para comparar cotizaciones de alquiler del vehículo (pestaña 🚐 Carro).
-- Reparto del carro: Elina cuenta completa (ocupa asiento); la silla la paga el núcleo A.

create table if not exists public.cotizaciones_carro (
  id           text primary key,
  proveedor    text,
  canal        text,
  modelo       text,
  transmision  text,
  precio       numeric,          -- total del alquiler 13 días (USD), idealmente con cobertura total
  seguro       boolean not null default false,  -- incluye cobertura total sin franquicia
  deposito     numeric,          -- caución bloqueada (USD), informativa (no se reparte)
  carseat      numeric,          -- costo de la silla (USD) — lo paga el núcleo A
  kmilim       boolean not null default false,  -- kilometraje ilimitado
  cancela      boolean not null default false,  -- cancelación gratis
  url          text,
  notas        text,
  elegida      boolean not null default false,
  created_at   timestamptz not null default now()
);

alter table public.cotizaciones_carro enable row level security;
drop policy if exists car_all on public.cotizaciones_carro;
create policy car_all on public.cotizaciones_carro for all using (true) with check (true);

alter publication supabase_realtime add table public.cotizaciones_carro;
