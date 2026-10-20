-- In-app notifications and recently chosen places.
-- Additive only: two new tables with their indexes and row level security.

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- invite_accepted, invite_declined, journey_started, journey_arrived,
  -- journey_cancelled, journey_delayed, attachment, sos
  type text not null,
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id)
  where read_at is null;

alter table public.notifications enable row level security;
drop policy if exists notifications_owner on public.notifications;
create policy notifications_owner on public.notifications
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Places a person picked before. Reusing them saves paid search lookups.
create table if not exists public.recent_places (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  google_place_id text,
  name text not null check (char_length(name) between 1 and 160),
  address text not null default '',
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  use_count integer not null default 1,
  last_used_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index if not exists recent_places_owner_place_uq
  on public.recent_places (owner_id, google_place_id)
  where google_place_id is not null;
create index if not exists recent_places_owner_used_idx
  on public.recent_places (owner_id, last_used_at desc);

alter table public.recent_places enable row level security;
drop policy if exists recent_places_owner on public.recent_places;
create policy recent_places_owner on public.recent_places
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
