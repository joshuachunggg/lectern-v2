create table public.lectures (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  title text not null check (char_length(title) between 1 and 200),
  status text not null default 'ready' check (status in ('ready', 'transcribing', 'synthesizing', 'done', 'error')),
  status_message text not null default 'Ready to process.',
  transcript text,
  notes text,
  created_at timestamptz not null default now()
);
create table public.lecture_sources (
  id uuid primary key default gen_random_uuid(),
  lecture_id uuid not null references public.lectures(id) on delete cascade,
  storage_path text not null unique,
  filename text not null,
  content_type text not null,
  source_type text not null check (source_type in ('audio', 'material')),
  created_at timestamptz not null default now()
);
alter table public.lectures enable row level security;
alter table public.lecture_sources enable row level security;
create policy "users manage their lectures" on public.lectures for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "users manage their sources" on public.lecture_sources for all using (exists (select 1 from public.lectures where id = lecture_id and owner_id = auth.uid())) with check (exists (select 1 from public.lectures where id = lecture_id and owner_id = auth.uid()));
insert into storage.buckets (id, name, public) values ('lecture-files', 'lecture-files', false);
create policy "users manage their lecture files" on storage.objects for all to authenticated using (bucket_id = 'lecture-files' and (storage.foldername(name))[1] in (select id::text from public.lectures where owner_id = auth.uid())) with check (bucket_id = 'lecture-files' and (storage.foldername(name))[1] in (select id::text from public.lectures where owner_id = auth.uid()));
