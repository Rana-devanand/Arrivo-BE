-- Shared cache for slow or paid lookups (destination information from Wikipedia,
-- nearby police stations and hospitals). Additive only: one new table.
--
-- Keys are places and areas ("dest:v1:18.52,73.86:pune"), never people. Nothing in
-- here says who asked. Read and written by the server only (service role): row
-- level security is on and there are deliberately no policies.

create table if not exists public.api_cache (
  key text primary key,
  value jsonb not null,
  fetched_at timestamptz not null default now()
);

create index if not exists api_cache_fetched_idx on public.api_cache (fetched_at);

alter table public.api_cache enable row level security;
