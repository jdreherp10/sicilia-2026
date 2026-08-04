-- Sicilia 2026 · migración 0009
-- Reparto por platos: qué consumió cada persona en un restaurante, más lo compartido
-- (vino, agua, coperto, propina) y entre quiénes se divide.
--   {"platos":{"johan":18.5,"christel":22},"compartido":{"monto":24,"entre":["johan","christel"]}}
alter table public.gastos add column if not exists detalle jsonb;
