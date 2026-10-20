-- DRIFT CONTROL shared event state
-- Run this once in your Supabase project's SQL Editor.

create table if not exists public.drift_events (
  id text primary key check (id = 'main'),
  state jsonb not null default '{"eventName":"DRIFT EVENT","format":32,"scoringMethod":"best","drivers":[],"bracket":null,"backgroundUrl":"","backgroundName":"","tab":"drivers"}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.drift_events enable row level security;

grant select on public.drift_events to anon, authenticated;
grant insert, update on public.drift_events to authenticated;

drop policy if exists "Public can view drift event" on public.drift_events;
create policy "Public can view drift event"
  on public.drift_events for select
  to anon, authenticated
  using (true);

drop policy if exists "Signed-in editors can create drift event" on public.drift_events;
create policy "Signed-in editors can create drift event"
  on public.drift_events for insert
  to authenticated
  with check (id = 'main');

drop policy if exists "Signed-in editors can update drift event" on public.drift_events;
create policy "Signed-in editors can update drift event"
  on public.drift_events for update
  to authenticated
  using (id = 'main')
  with check (id = 'main');

insert into public.drift_events (id, state)
values ('main', '{"eventName":"DRIFT EVENT","format":32,"scoringMethod":"best","drivers":[],"bracket":null,"backgroundUrl":"","backgroundName":"","tab":"drivers"}'::jsonb)
on conflict (id) do nothing;

-- Enable realtime updates for the public event row.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'drift_events'
  ) then
    alter publication supabase_realtime add table public.drift_events;
  end if;
end $$;

-- Public read bucket for event background photos; signed-in editors may upload images.
-- The application compresses uploaded photos before sending them to this bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'drift-backgrounds',
  'drift-backgrounds',
  true,
  12582912,
  array['image/webp', 'image/jpeg', 'image/png']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can view drift backgrounds" on storage.objects;
create policy "Public can view drift backgrounds"
  on storage.objects for select
  to public
  using (bucket_id = 'drift-backgrounds');

drop policy if exists "Signed-in editors can upload drift backgrounds" on storage.objects;
create policy "Signed-in editors can upload drift backgrounds"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'drift-backgrounds');
