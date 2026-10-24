-- The traveller can now pick any update interval from 10 minutes to 12 hours,
-- not only the presets. Replaces the check added in 20261025000007.
-- Safe to run whether or not 000007 was applied: it only swaps the constraint.

alter table public.journeys
  drop constraint if exists journeys_update_interval_minutes_check;

alter table public.journeys
  add constraint journeys_update_interval_minutes_check
    check (update_interval_minutes is null or update_interval_minutes between 10 and 720);
