-- Sicilia 2026 · migración 0007
-- Enlaza un gasto con un pendiente de efectivo (tasa turística, silla del carro, pago
-- al anfitrión) para que al registrarlo desaparezca de la lista de "por pagar allá".
alter table public.gastos add column if not exists ref text;
create index if not exists gastos_ref_idx on public.gastos(ref);
