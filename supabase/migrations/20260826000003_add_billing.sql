alter table public.lectures
  add column billing_kind text check (billing_kind in ('free', 'included', 'overage')),
  add column billed_at timestamptz;

create table public.billing_accounts (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  subscription_status text not null default 'none',
  period_end timestamptz,
  included_used integer not null default 0 check (included_used >= 0),
  free_used boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.billing_accounts enable row level security;
create policy "users read their billing" on public.billing_accounts for select using (owner_id = auth.uid());

create or replace function public.claim_lecture(p_lecture_id uuid)
returns table (kind text, stripe_customer_id text)
language plpgsql security definer set search_path = public as $$
declare account public.billing_accounts%rowtype;
begin
  if not exists (select 1 from public.lectures where id = p_lecture_id and owner_id = auth.uid()) then raise exception 'Lecture not found'; end if;
  if exists (select 1 from public.lectures where id = p_lecture_id and billed_at is not null) then
    return query select lectures.billing_kind, accounts.stripe_customer_id from public.lectures lectures left join public.billing_accounts accounts on accounts.owner_id = lectures.owner_id where lectures.id = p_lecture_id;
    return;
  end if;
  insert into public.billing_accounts (owner_id) values (auth.uid()) on conflict (owner_id) do nothing;
  select * into account from public.billing_accounts where owner_id = auth.uid() for update;
  if not account.free_used then
    update public.billing_accounts set free_used = true, updated_at = now() where owner_id = auth.uid();
    update public.lectures set billing_kind = 'free', billed_at = now() where id = p_lecture_id;
    return query select 'free'::text, null::text;
  elsif account.subscription_status in ('active', 'trialing') and account.period_end > now() then
    if account.included_used < 24 then
      update public.billing_accounts set included_used = included_used + 1, updated_at = now() where owner_id = auth.uid();
      update public.lectures set billing_kind = 'included', billed_at = now() where id = p_lecture_id;
      return query select 'included'::text, null::text;
    end if;
    update public.lectures set billing_kind = 'overage', billed_at = now() where id = p_lecture_id;
    return query select 'overage'::text, account.stripe_customer_id;
  end if;
  raise exception 'Your free lecture is used. Subscribe to continue.';
end $$;

grant execute on function public.claim_lecture(uuid) to authenticated;

update storage.buckets set file_size_limit = 26214400 where id = 'lecture-files';

alter table public.lectures add constraint lectures_synthesis_prompt_limit check (char_length(synthesis_prompt) <= 1500) not valid;
alter table public.saved_prompts add constraint saved_prompts_prompt_limit check (char_length(prompt) <= 1500) not valid;

drop policy "users manage their lecture files" on storage.objects;
create policy "users manage their lecture files" on storage.objects for all to authenticated
using (bucket_id = 'lecture-files' and (storage.foldername(name))[1] in (select id::text from public.lectures where owner_id = auth.uid()))
with check (bucket_id = 'lecture-files'
  and lower(storage.extension(name)) = any (array['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac', 'flac', 'pdf', 'pptx', 'txt'])
  and (storage.foldername(name))[1] in (select id::text from public.lectures where owner_id = auth.uid()));

create or replace function public.check_lecture_sources()
returns trigger language plpgsql security definer set search_path = public, storage as $$
declare total_bytes bigint;
begin
  if not (lower(storage.extension(new.storage_path)) = any (array['mp3', 'm4a', 'wav', 'webm', 'ogg', 'aac', 'flac', 'pdf', 'pptx', 'txt'])) then raise exception 'Unsupported file type'; end if;
  select coalesce(sum(coalesce((objects.metadata ->> 'size')::bigint, 0)), 0) into total_bytes
  from public.lecture_sources sources join storage.objects on objects.name = sources.storage_path and objects.bucket_id = 'lecture-files'
  where sources.lecture_id = new.lecture_id;
  select total_bytes + coalesce((metadata ->> 'size')::bigint, 0) into total_bytes from storage.objects where bucket_id = 'lecture-files' and name = new.storage_path;
  if total_bytes > 26214400 then raise exception 'A lecture can contain at most 25 MB of source files'; end if;
  if (select count(*) from public.lecture_sources where lecture_id = new.lecture_id) >= 12 then raise exception 'A lecture can contain at most 12 source files'; end if;
  return new;
end $$;
create trigger enforce_lecture_source_limits before insert or update on public.lecture_sources for each row execute function public.check_lecture_sources();
