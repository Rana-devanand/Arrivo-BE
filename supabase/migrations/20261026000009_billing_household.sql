-- Arrivo Plus subscriptions (paid on the Arrivo website through Dodo Payments) and
-- the Family household. Additive only: new tables, indexes and row level security.
--
-- The API talks to these with the service role key. The policies below are defence
-- in depth for anything that reaches the database directly.

-- One row per person who has ever subscribed. No row means the Free plan.
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  status text not null
    check (status in ('active', 'past_due', 'on_hold', 'cancelled', 'expired', 'failed')),
  -- 1 = monthly, 6 = every six months, 12 = yearly
  interval_months integer check (interval_months in (1, 6, 12)),
  dodo_subscription_id text unique,
  dodo_customer_id text,
  -- When the paid time runs out (next billing date); access lasts until then.
  current_period_end timestamptz,
  -- Time of the newest webhook applied, so a late, older event cannot undo a newer one.
  last_event_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Checkout sessions we created, so a payment can be tied back to the person even if
-- the payment provider does not copy our metadata onto the subscription.
create table if not exists public.billing_checkouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  plan_key text not null,
  dodo_session_id text,
  created_at timestamptz not null default now()
);
create index if not exists billing_checkouts_email_idx
  on public.billing_checkouts (lower(email), created_at desc);

-- Short-lived tickets the app hands to the website, so the website knows who is paying
-- without a password or a sign-in token in the address. Only a hash is stored.
create table if not exists public.billing_tickets (
  token_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  plan_key text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists billing_tickets_expires_idx on public.billing_tickets (expires_at);

-- The Family household: one per person, a name and some of their contacts.
create table if not exists public.households (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.household_members (
  owner_id uuid not null references public.households (owner_id) on delete cascade,
  contact_id uuid not null references public.contacts (id) on delete cascade,
  primary key (owner_id, contact_id)
);

alter table public.subscriptions enable row level security;
alter table public.billing_checkouts enable row level security;
alter table public.billing_tickets enable row level security;
alter table public.households enable row level security;
alter table public.household_members enable row level security;

-- A person may read their own subscription. Only the server writes it.
create policy subscriptions_read_own on public.subscriptions
  for select using (user_id = auth.uid());

create policy households_own on public.households
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy household_members_own on public.household_members
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
