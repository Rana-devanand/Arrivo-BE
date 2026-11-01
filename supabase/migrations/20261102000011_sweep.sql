-- The 5-minute check (FR-TRK-22): "location stopped" alerts, paused sharing,
-- overdue and due progress updates. Additive only: two new columns.
--
-- Run this part in the SQL editor:

alter table public.journeys
  add column if not exists stale_alert_at timestamptz;

alter table public.journeys
  add column if not exists sharing_paused boolean not null default false;

-- ---------------------------------------------------------------------------
-- Then schedule the check. This needs the pg_cron and pg_net extensions
-- (Database > Extensions in the Supabase dashboard) and your API address and
-- CRON_SECRET (the same value as in the backend's environment).
--
-- Do NOT commit the real secret. Keep it in Supabase Vault, pasted only into the SQL editor:
--
--   select vault.create_secret('PASTE_YOUR_CRON_SECRET', 'arrivo_cron_secret');
--
--   select cron.schedule(
--     'arrivo-sweep',
--     '*/5 * * * *',
--     $$
--     select net.http_post(
--       url     := 'https://YOUR-API.vercel.app/v1/internal/sweep',
--       headers := jsonb_build_object(
--         'Authorization',
--         'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'arrivo_cron_secret')
--       ),
--       body    := '{}'::jsonb,
--       timeout_milliseconds := 25000
--     );
--     $$
--   );
--
-- Keep the run log small:
--   select cron.schedule('arrivo-cron-cleanup', '0 3 * * *',
--     $$ delete from cron.job_run_details where end_time < now() - interval '3 days' $$);
--
-- To check it runs:  select * from cron.job_run_details order by start_time desc limit 5;
-- To stop it:        select cron.unschedule('arrivo-sweep');
