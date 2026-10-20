-- Train and metro travel modes, the planned route, and a photo of the vehicle.
-- Additive only: adds two enum values and nullable columns to journeys.

alter type public.travel_mode add value if not exists 'train';
alter type public.travel_mode add value if not exists 'metro';

alter table public.journeys
  add column if not exists origin_lat double precision,
  add column if not exists origin_lng double precision,
  -- The planned route (Google encoded polyline) and its legs (walk, metro, train...).
  add column if not exists route_polyline text,
  add column if not exists route_steps jsonb,
  -- Photo of the number plate / ride, so contacts can check it.
  add column if not exists vehicle_image_url text;
