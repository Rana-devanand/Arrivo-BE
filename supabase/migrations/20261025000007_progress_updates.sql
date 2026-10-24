-- Periodic "on the way" updates to a journey's contacts.
-- Additive only: two nullable columns on journeys.
--   update_interval_minutes  how often the traveller chose to update contacts (null = never)
--   last_progress_at         when the last update was sent (compare-and-swap, so two
--                            location uploads at the same moment send only one)

alter table public.journeys
  add column if not exists update_interval_minutes integer
    check (update_interval_minutes in (15, 30, 60, 120, 180)),
  add column if not exists last_progress_at timestamptz;
