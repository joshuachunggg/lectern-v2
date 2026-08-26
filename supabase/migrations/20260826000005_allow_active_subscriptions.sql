-- Stripe's subscription status is authoritative for access. period_end is used
-- for usage-cycle tracking and may be absent on an otherwise active checkout.
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
  elsif account.subscription_status in ('active', 'trialing') then
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
