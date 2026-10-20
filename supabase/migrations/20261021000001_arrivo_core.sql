-- Arrivo core schema.
--
-- IMPORTANT: run this only on the NEW Supabase project created for Arrivo.
-- It is additive (creates new objects only) and never drops or alters existing ones.
-- Do not run it on another app's database.

create type public.journey_status as enum ('active', 'overdue', 'completed', 'cancelled');
create type public.contact_status as enum ('invited', 'accepted', 'declined', 'removed');
create type public.travel_mode as enum ('walk', 'bike', 'car', 'transit');

-- Profiles ------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  phone text,
  avatar_url text,
  deletion_requested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Trusted contacts ----------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  phone text,
  email text,
  status public.contact_status not null default 'invited',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contact_has_channel check (phone is not null or email is not null)
);
create unique index contacts_owner_email_uq on public.contacts (owner_id, lower(email))
  where email is not null and status <> 'removed';
create unique index contacts_owner_phone_uq on public.contacts (owner_id, phone)
  where phone is not null and status <> 'removed';

-- Journeys ------------------------------------------------------------------
create table public.journeys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  destination_name text not null,
  destination_lat double precision,
  destination_lng double precision,
  origin_name text not null default '',
  mode public.travel_mode not null default 'car',
  status public.journey_status not null default 'active',
  started_at timestamptz not null default now(),
  expected_arrival timestamptz not null,
  arrived_at timestamptz,
  ended_at timestamptz,
  vehicle text not null default '',
  note text not null default '',
  late_check_in boolean not null default true,
  grace_minutes integer not null default 10 check (grace_minutes between 1 and 60),
  auto_arrival boolean not null default true,
  notify_on_start boolean not null default true,
  distance_km numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- One journey in progress per person (SRS FR-JRN-02).
create unique index one_open_journey_per_owner on public.journeys (owner_id)
  where status in ('active', 'overdue');
create index journeys_owner_started_idx on public.journeys (owner_id, started_at desc);

create table public.journey_contacts (
  journey_id uuid not null references public.journeys (id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  primary key (journey_id, contact_id)
);

-- Live location -------------------------------------------------------------
create table public.location_points (
  id bigint generated always as identity primary key,
  journey_id uuid not null references public.journeys (id) on delete cascade,
  lat double precision not null,
  lng double precision not null,
  accuracy real,
  speed real,
  recorded_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index location_points_journey_time_idx on public.location_points (journey_id, recorded_at desc);

-- Watch links (for people without the app) ----------------------------------
create table public.watch_links (
  token text primary key,
  journey_id uuid not null references public.journeys (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

-- Safety ---------------------------------------------------------------------
create table public.sos_events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  journey_id uuid references public.journeys (id) on delete set null,
  lat double precision,
  lng double precision,
  created_at timestamptz not null default now()
);

create table public.safety_timers (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Push tokens ----------------------------------------------------------------
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('ios', 'android', 'web')),
  push_token text not null unique,
  updated_at timestamptz not null default now()
);

-- Overdue sweep (called by the API job) ---------------------------------------
create or replace function public.mark_overdue_journeys(now_ts timestamptz)
returns integer
language sql
security definer
set search_path = public
as $$
  with updated as (
    update public.journeys
       set status = 'overdue', updated_at = now_ts
     where status = 'active'
       and expected_arrival + make_interval(mins => grace_minutes) < now_ts
    returning 1
  )
  select count(*)::integer from updated;
$$;
revoke all on function public.mark_overdue_journeys(timestamptz) from public, anon, authenticated;

-- Row level security ------------------------------------------------------------
-- The API uses the service role (bypasses RLS) and scopes every query to the
-- signed-in user. These policies protect against any direct client access.
alter table public.profiles enable row level security;
alter table public.contacts enable row level security;
alter table public.journeys enable row level security;
alter table public.journey_contacts enable row level security;
alter table public.location_points enable row level security;
alter table public.watch_links enable row level security;
alter table public.sos_events enable row level security;
alter table public.safety_timers enable row level security;
alter table public.devices enable row level security;

create policy profiles_own on public.profiles for all
  using (id = auth.uid()) with check (id = auth.uid());
create policy contacts_own on public.contacts for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy journeys_own on public.journeys for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy journey_contacts_own on public.journey_contacts for all
  using (exists (select 1 from public.journeys j where j.id = journey_id and j.owner_id = auth.uid()))
  with check (exists (select 1 from public.journeys j where j.id = journey_id and j.owner_id = auth.uid()));
create policy location_points_own on public.location_points for all
  using (exists (select 1 from public.journeys j where j.id = journey_id and j.owner_id = auth.uid()))
  with check (exists (select 1 from public.journeys j where j.id = journey_id and j.owner_id = auth.uid()));
create policy watch_links_own on public.watch_links for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy sos_events_own on public.sos_events for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy safety_timers_own on public.safety_timers for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy devices_own on public.devices for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
