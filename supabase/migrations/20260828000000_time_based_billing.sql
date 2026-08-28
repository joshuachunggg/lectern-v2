alter table public.billing_accounts
  add column included_seconds integer not null default 0 check (included_seconds >= 0),
  add column overage_seconds integer not null default 0 check (overage_seconds >= 0);

alter table public.lectures
  add column billed_seconds integer,
  add column reserved_included_seconds integer not null default 0,
  add column reserved_overage_cents integer not null default 0;

alter table public.lecture_sources add column duration_seconds integer check (duration_seconds >= 0);

create or replace function public.claim_lecture_for_owner_v2(p_lecture_id uuid, p_owner_id uuid)
returns table (kind text, stripe_customer_id text)
language plpgsql security definer set search_path = public as $$
declare subscription text; used integer; credits integer; free_lectures integer; ends_at timestamptz; reserved_seconds integer; reserved_cents integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if not exists (select 1 from public.lectures where id = p_lecture_id and owner_id = p_owner_id) then raise exception 'Lecture not found'; end if;
  insert into public.billing_accounts (owner_id) values (p_owner_id) on conflict (owner_id) do nothing;
  select subscription_status, included_seconds, credit_cents, period_end into subscription, used, credits, ends_at from public.billing_accounts where owner_id = p_owner_id for update;
  if exists (select 1 from public.lectures where id = p_lecture_id and billed_at is not null) then return query select billing_kind, null::text from public.lectures where id = p_lecture_id; return; end if;
  execute 'select count(*) from public.lectures where owner_id = $1 and billing_kind = ''free'' and status <> ''error''' into free_lectures using p_owner_id;
  if free_lectures = 0 then
    update public.billing_accounts set free_used = true, updated_at = now() where owner_id = p_owner_id;
    update public.lectures set billing_kind = 'free', billed_at = now() where id = p_lecture_id;
    return query select 'free'::text, null::text; return;
  end if;
  if subscription in ('active', 'trialing') and ends_at > now() then
    reserved_seconds := least(5400, greatest(0, 108000 - used));
    reserved_cents := ceil(greatest(0, 5400 - reserved_seconds)::numeric * 50 / 3600)::integer;
    if credits < reserved_cents then raise exception 'Your overage balance needs $% to cover a 90-minute lecture.', (reserved_cents / 100.0)::text; end if;
    update public.billing_accounts set included_seconds = included_seconds + reserved_seconds, credit_cents = credit_cents - reserved_cents, updated_at = now() where owner_id = p_owner_id;
    update public.lectures set billing_kind = case when reserved_cents = 0 then 'included' else 'overage' end, billed_at = now(), reserved_included_seconds = reserved_seconds, reserved_overage_cents = reserved_cents where id = p_lecture_id;
    return query select case when reserved_cents = 0 then 'included' else 'overage' end, null::text; return;
  end if;
  raise exception 'Your free lecture is used. Subscribe to continue.';
end $$;

create or replace function public.settle_lecture_time(p_lecture_id uuid, p_owner_id uuid, p_seconds integer)
returns void language plpgsql security definer set search_path = public as $$
declare lecture public.lectures%rowtype; account public.billing_accounts%rowtype; available integer; included integer; overage integer; cents integer;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_seconds < 0 or p_seconds > 5400 then raise exception 'A lecture can contain at most 90 minutes of audio'; end if;
  select * into lecture from public.lectures where id = p_lecture_id and owner_id = p_owner_id for update;
  if lecture.billed_seconds is not null then return; end if;
  if lecture.billing_kind = 'free' then update public.lectures set billed_seconds = p_seconds where id = p_lecture_id; return; end if;
  select * into account from public.billing_accounts where owner_id = p_owner_id for update;
  available := greatest(0, 108000 - account.included_seconds + lecture.reserved_included_seconds);
  included := least(p_seconds, available);
  overage := p_seconds - included;
  cents := ceil(overage::numeric * 50 / 3600)::integer;
  update public.billing_accounts set included_seconds = included_seconds - lecture.reserved_included_seconds + included, credit_cents = credit_cents - lecture.reserved_overage_cents + cents, overage_seconds = overage_seconds + overage, updated_at = now() where owner_id = p_owner_id;
  update public.lectures set billed_seconds = p_seconds, reserved_included_seconds = 0, reserved_overage_cents = 0 where id = p_lecture_id;
end $$;
