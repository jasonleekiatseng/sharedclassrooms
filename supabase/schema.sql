-- SharedClassrooms — Supabase schema
-- Run this once in your Supabase project's SQL Editor (Dashboard → SQL Editor → New query),
-- then click "Run". Safe to re-run only if the tables don't already exist.

create table if not exists centers (
  id text primary key,
  data jsonb not null,
  created_at bigint
);

create table if not exists listings (
  id text primary key,
  center_id text references centers(id) on delete cascade,
  data jsonb not null,
  created_at bigint
);

create table if not exists inquiries (
  id text primary key,
  listing_id text references listings(id) on delete cascade,
  data jsonb not null,
  created_at bigint
);

create index if not exists listings_center_id_idx on listings(center_id);
create index if not exists inquiries_listing_id_idx on inquiries(listing_id);

-- Row Level Security -----------------------------------------------------
-- IMPORTANT — read this before going live.
-- The app is currently a pure front-end client using Supabase's public
-- "anon" key, with no real user accounts yet (Admin is a shared passcode
-- checked in the browser; the Google Sign-In on Manage Listing is not yet
-- backed by verified server-side identity). Given that, these policies are
-- deliberately left OPEN — anyone with the anon key (which ships inside
-- the built app, visible to anyone) can read and write every row. This
-- matches how the app already behaves today, so nothing changes when you
-- migrate off window.storage.
--
-- This is fine for internal testing and early pilots where the people
-- using it are known and trusted, but it is NOT safe once this is public
-- and unrelated strangers can reach the URL. Before that point, replace
-- these policies with ones that check a real authenticated user (Supabase
-- Auth), e.g. restrict "admin" actions (verify, flag, standing changes) to
-- rows where the signed-in user has an admin role, and restrict listing
-- edits to the center that owns them. Flagging this explicitly rather than
-- leaving it implicit, since it's the same category of gap as the client
-- side passcode check — real access control needs to move server-side.

alter table centers enable row level security;
alter table listings enable row level security;
alter table inquiries enable row level security;

create policy "public read centers" on centers for select using (true);
create policy "public insert centers" on centers for insert with check (true);
create policy "public update centers" on centers for update using (true);

create policy "public read listings" on listings for select using (true);
create policy "public insert listings" on listings for insert with check (true);
create policy "public update listings" on listings for update using (true);

create policy "public read inquiries" on inquiries for select using (true);
create policy "public insert inquiries" on inquiries for insert with check (true);
create policy "public update inquiries" on inquiries for update using (true);
