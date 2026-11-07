-- Two details kept with each journey's destination. Additive only: two new columns.
--
-- destination_image_url: the address of a Wikipedia or Commons picture of the place (the app gets it
--   with the place's information), so "Repeat a trip" can show it for good. Never an uploaded file.
-- destination_address: the address as the person picked it ("Hinjewadi, Pune, Maharashtra 411057,
--   India"), so the destination's city, state and country can be read again later: it is what picks
--   the language the destination information is offered in.

alter table public.journeys
  add column if not exists destination_image_url text,
  add column if not exists destination_address text;
