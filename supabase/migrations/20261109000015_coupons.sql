-- Discount offers (coupons) that an admin creates on the website dashboard. Additive only: one new table.
--
-- Each row is shown to signed-in people while it is live (starts_at <= now < ends_at) and can be passed to the
-- payment checkout. The matching discount is created in Dodo Payments by the server (dodo_discount_id), which is
-- what really takes the percentage off the first payment, so a code can never promise more than Dodo gives.
--
-- Only the server reads and writes this table (service role key). Row level security is on with no policy, so
-- nobody else can touch it.

create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  -- What people tap or type: 3 to 16 capital letters and digits.
  code text not null unique check (code ~ '^[A-Z0-9]{3,16}$'),
  -- The name on the offer card, such as "Launch offer".
  title text not null,
  -- Taken off the first payment only.
  percent_off integer not null check (percent_off between 1 and 90),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  dodo_discount_id text,
  -- False once an admin ended the offer early.
  active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists coupons_window_idx on public.coupons (ends_at);

alter table public.coupons enable row level security;
