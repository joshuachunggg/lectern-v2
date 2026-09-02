alter table public.lectures add column deleted_at timestamptz;
grant update (deleted_at) on public.lectures to authenticated;
