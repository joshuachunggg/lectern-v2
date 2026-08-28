alter table public.lectures
  add column note_detail smallint not null default 3
  check (note_detail between 1 and 5);
