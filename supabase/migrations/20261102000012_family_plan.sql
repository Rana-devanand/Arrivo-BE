-- Arrivo Plus Family (FR-BIL-10): the owner pays $49 a year and shares Plus with
-- up to 2 people invited by email. Additive only: one column and one table.

-- Which product was bought ('familyYearly' is Arrivo Plus Family).
alter table public.subscriptions
  add column if not exists plan_key text
    check (plan_key in ('monthly', 'sixMonths', 'yearly', 'familyYearly'));

create table if not exists public.family_members (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  email text not null,
  member_user_id uuid references auth.users (id) on delete cascade,
  status text not null default 'invited'
    check (status in ('invited', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
create index if not exists family_members_owner_idx on public.family_members (owner_id);
create index if not exists family_members_email_idx on public.family_members (lower(email)) where status = 'invited';
-- Someone can be a member of one Family at a time.
create unique index if not exists family_members_one_family
  on public.family_members (member_user_id) where status = 'accepted';

alter table public.family_members enable row level security;

-- The API uses the service role. These protect anything that reaches the table directly:
-- the owner and the member can read their own rows; only the server writes.
create policy family_members_read_own on public.family_members
  for select using (owner_id = auth.uid() or member_user_id = auth.uid());
