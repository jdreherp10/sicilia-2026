-- ============================================================
-- Sicilia 2026 · Backend compartido (Supabase)
-- Migración 0001: gastos, alojamientos (opciones) y votos
-- Correr en: Supabase → SQL Editor → New query → Run
-- ============================================================

-- 1) GASTOS COMPARTIDOS -------------------------------------------------
create table if not exists gastos (
  id          text primary key,
  created_at  timestamptz default now(),
  fecha       date not null,
  descripcion text,
  monto       numeric not null,
  pago        text not null check (pago in ('A','B','K')),   -- A=Johan&Christel, B=Peter&Sofía, K=Klaus
  tipo        text not null default 'normal' check (tipo in ('normal','hospedaje')),
  para        text[] not null default '{}'                    -- ids de personas beneficiarias; '{}' = todos
);

-- 2) OPCIONES DE ALOJAMIENTO (una fila por opción de Airbnb) ------------
create table if not exists alojamientos (
  id          text primary key,
  created_at  timestamptz default now(),
  base        text not null,        -- palermo | cefalu | catania | siracusa | sanvito
  nombre      text not null,
  url         text,
  precio      numeric,              -- precio TOTAL de la estadía en esa base (€)
  notas       text,
  elegido     boolean not null default false
);

-- 3) VOTOS (un voto por persona por base; se puede cambiar) -------------
create table if not exists votos (
  base            text not null,
  votante         text not null,    -- id de persona: johan, christel, peter, sofia, klaus, pili, pilo (elina no vota)
  alojamiento_id  text not null references alojamientos(id) on delete cascade,
  updated_at      timestamptz default now(),
  primary key (base, votante)
);

-- 4) SEGURIDAD (app familiar sin login; la anon key es pública) ---------
--    RLS activado + políticas permisivas para el rol anónimo.
alter table gastos       enable row level security;
alter table alojamientos enable row level security;
alter table votos        enable row level security;

drop policy if exists p_gastos_anon on gastos;
create policy p_gastos_anon on gastos
  for all to anon using (true) with check (true);

drop policy if exists p_aloj_anon on alojamientos;
create policy p_aloj_anon on alojamientos
  for all to anon using (true) with check (true);

drop policy if exists p_votos_anon on votos;
create policy p_votos_anon on votos
  for all to anon using (true) with check (true);

-- Listo. Copia la Project URL y la anon public key desde
-- Supabase → Project Settings → API, y pásamelas.
