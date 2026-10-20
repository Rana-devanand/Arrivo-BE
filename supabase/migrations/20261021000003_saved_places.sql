-- Saved places (Home, Work, favourites) for one-tap journeys.
-- Additive only: creates one new table, its indexes and its row level security.

create table if not exists public.saved_places (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null default 'other' check (kind in ('home', 'work', 'other')),
  label text not null check (char_length(label) between 1 and 60),
  name text not null check (char_length(name) between 1 and 160),
  address text not null default '',
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  google_place_id text,
  created_at timestamptz not null default now()
);

create index if not exists saved_places_owner_idx
  on public.saved_places (owner_id, created_at desc);

-- One Home and one Work per person.
create unique index if not exists saved_places_one_home_work_uq
  on public.saved_places (owner_id, kind)
  where kind in ('home', 'work');

alter table public.saved_places enable row level security;

drop policy if exists saved_places_owner on public.saved_places;
create policy saved_places_owner on public.saved_places
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
