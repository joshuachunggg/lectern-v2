create table public.saved_prompts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null check (char_length(name) between 1 and 100),
  prompt text not null check (char_length(prompt) between 1 and 4000),
  created_at timestamptz not null default now()
);

alter table public.saved_prompts enable row level security;
create policy "users manage their saved prompts" on public.saved_prompts
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
