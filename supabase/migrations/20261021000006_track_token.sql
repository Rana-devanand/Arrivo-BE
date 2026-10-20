-- A private key per journey so the phone can keep sending its location from a
-- background service (where the sign-in session may not be available).
-- Additive only: one nullable column and a unique index.

alter table public.journeys
  add column if not exists track_token text;

create unique index if not exists journeys_track_token_uq
  on public.journeys (track_token)
  where track_token is not null;
