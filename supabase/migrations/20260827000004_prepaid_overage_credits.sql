alter table public.billing_accounts add column credit_cents integer not null default 0 check (credit_cents >= 0);

create table public.billing_credit_deposits (
  checkout_session_id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  created_at timestamptz not null default now()
);
alter table public.billing_credit_deposits enable row level security;

create or replace function public.record_billing_credit_deposit(p_owner_id uuid, p_checkout_session_id text, p_amount_cents integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_amount_cents <= 0 then raise exception 'Credit amount must be positive'; end if;
  insert into public.billing_credit_deposits (checkout_session_id, owner_id, amount_cents) values (p_checkout_session_id, p_owner_id, p_amount_cents) on conflict do nothing;
  if found then
    insert into public.billing_accounts (owner_id, credit_cents) values (p_owner_id, p_amount_cents)
      on conflict (owner_id) do update set credit_cents = public.billing_accounts.credit_cents + excluded.credit_cents, updated_at = now();
  end if;
end $$;

create or replace function public.claim_lecture_for_owner_v2(p_lecture_id uuid, p_owner_id uuid)
returns table (kind text, stripe_customer_id text)
language plpgsql security definer set search_path = public as $$
declare subscription text; used integer; credits integer; free_lectures integer; ends_at timestamptz;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if not exists (select 1 from public.lectures where id = p_lecture_id and owner_id = p_owner_id) then raise exception 'Lecture not found'; end if;
  insert into public.billing_accounts (owner_id) values (p_owner_id) on conflict (owner_id) do nothing;
  select accounts.subscription_status, accounts.included_used, accounts.credit_cents, accounts.period_end into subscription, used, credits, ends_at from public.billing_accounts accounts where accounts.owner_id = p_owner_id for update;
  if exists (select 1 from public.lectures where id = p_lecture_id and billed_at is not null) then return query select billing_kind, null::text from public.lectures where id = p_lecture_id; return; end if;
  execute 'select count(*) from public.lectures where owner_id = $1 and billing_kind = ''free'' and status <> ''error''' into free_lectures using p_owner_id;
  if free_lectures = 0 then
    update public.billing_accounts set free_used = true, updated_at = now() where owner_id = p_owner_id;
    update public.lectures set billing_kind = 'free', billed_at = now() where id = p_lecture_id;
    return query select 'free'::text, null::text; return;
  end if;
  if subscription in ('active', 'trialing') and ends_at > now() then
    if used < 24 then
      update public.billing_accounts set included_used = included_used + 1, updated_at = now() where owner_id = p_owner_id;
      update public.lectures set billing_kind = 'included', billed_at = now() where id = p_lecture_id;
      return query select 'included'::text, null::text; return;
    end if;
    if credits < 50 then raise exception 'Your overage balance is empty. Add funds to continue.'; end if;
    update public.billing_accounts set credit_cents = credit_cents - 50, overage_used = overage_used + 1, updated_at = now() where owner_id = p_owner_id;
    update public.lectures set billing_kind = 'overage', billed_at = now() where id = p_lecture_id;
    return query select 'overage'::text, null::text; return;
  end if;
  raise exception 'Your free lecture is used. Subscribe to continue.';
end $$;
