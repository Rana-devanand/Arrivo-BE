-- Invitation codes for trusted contacts.
-- Additive only: adds columns and indexes to the contacts table.

alter table public.contacts
  add column if not exists invite_code text,
  add column if not exists contact_user_id uuid references auth.users (id) on delete set null,
  add column if not exists accepted_at timestamptz;

-- A code identifies exactly one invitation.
create unique index if not exists contacts_invite_code_uq
  on public.contacts (invite_code)
  where invite_code is not null;

-- Finds the people who follow me (and the journeys shared with me) quickly.
create index if not exists contacts_contact_user_idx
  on public.contacts (contact_user_id)
  where contact_user_id is not null;
