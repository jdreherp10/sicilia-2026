-- Sicilia 2026 · migración 0008
-- Transparencia del libro de cuentas:
--  · por          → quién registró el movimiento (firma ligera, sin contraseñas)
--  · anulado      → los movimientos no se borran; se anulan y siguen visibles
--  · anulado_por  → quién lo anuló
alter table public.gastos add column if not exists por text;
alter table public.gastos add column if not exists anulado boolean not null default false;
alter table public.gastos add column if not exists anulado_por text;
