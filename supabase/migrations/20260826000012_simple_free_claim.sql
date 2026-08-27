create or replace function public.claim_lecture_for_owner(p_lecture_id uuid, p_owner_id uuid)
returns table (kind text, stripe_customer_id text)
language plpgsql security definer set search_path = public as $$
declare account public.billing_accounts%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if not exists (select 1 from public.lectures where id = p_lecture_id and owner_id = p_owner_id) then raise exception 'Lecture not found'; end if;
  if exists (select 1 from public.lectures where id = p_lecture_id and billed_at is not null) then return query select billing_kind, null::text from public.lectures where id = p_lecture_id; return; end if;
  insert into public.billing_accounts (owner_id) values (p_owner_id) on conflict (owner_id) do nothing;
  select * into account from public.billing_accounts where owner_id = p_owner_id for update;
  if not account.free_used then
    update public.billing_accounts set free_used = true, updated_at = now() where owner_id = p_owner_id;
    update public.lectures set billing_kind = 'free', billed_at = now() where id = p_lecture_id;
    return query select 'free'::text, null::text;
  end if;
  if account.subscription_status in ('active', 'trialing') then
    if account.included_used < 24 then update public.billing_accounts set included_used = included_used + 1, updated_at = now() where owner_id = p_owner_id; update public.lectures set billing_kind = 'included', billed_at = now() where id = p_lecture_id; return query select 'included'::text, null::text; end if;
    update public.lectures set billing_kind = 'overage', billed_at = now() where id = p_lecture_id; return query select 'overage'::text, account.stripe_customer_id;
  end if;
  raise exception 'Your free lecture is used. Subscribe to continue.';
end $$;
