-- The country a person travels in, and who may open the admin dashboard.
-- Additive only: two new columns, a guard trigger and a read-only summary function.
--
-- Everyone starts as USER (the default fills existing rows). To make someone an
-- admin, a person runs this in the SQL editor:
--   update public.profiles set user_role = 'ADMIN'
--    where id = (select id from auth.users where email = 'someone@example.com');

alter table public.profiles
  add column if not exists country_code text
    check (country_code ~ '^[A-Z]{2}$');

alter table public.profiles
  add column if not exists user_role text not null default 'USER'
    check (user_role in ('USER', 'ADMIN'));

update public.profiles set user_role = 'USER' where user_role is null;

-- profiles_own lets a signed-in person write their own row directly, so without this
-- anyone could make themselves an admin. Only the server and the SQL editor may set it.
create or replace function public.guard_profile_role()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.user_role := 'USER';
  elsif new.user_role is distinct from old.user_role then
    raise exception 'user_role can only be changed by an administrator';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_role on public.profiles;
create trigger profiles_guard_role
  before insert or update on public.profiles
  for each row execute function public.guard_profile_role();

-- Journey counts per person for the admin dashboard (called by the API only).
create or replace function public.admin_journey_stats()
returns table (
  owner_id uuid,
  total integer,
  active integer,
  overdue integer,
  completed integer,
  cancelled integer,
  last_started_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select owner_id,
         count(*)::integer,
         count(*) filter (where status = 'active')::integer,
         count(*) filter (where status = 'overdue')::integer,
         count(*) filter (where status = 'completed')::integer,
         count(*) filter (where status = 'cancelled')::integer,
         max(started_at)
    from public.journeys
   group by owner_id;
$$;
revoke all on function public.admin_journey_stats() from public, anon, authenticated;
