alter table public.billing_accounts
  add column cancel_at timestamptz,
  add column last_paid_period_end timestamptz;

create or replace function public.apply_paid_invoice(p_customer_id text, p_subscription_id text, p_period_end timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare account public.billing_accounts%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  select * into account from public.billing_accounts where stripe_customer_id = p_customer_id and stripe_subscription_id = p_subscription_id for update;
  if not found or p_period_end <= coalesce(account.last_paid_period_end, '-infinity'::timestamptz) then return; end if;
  update public.billing_accounts set included_seconds = 0, overage_seconds = 0, last_paid_period_end = p_period_end, updated_at = now() where owner_id = account.owner_id;
end $$;

create or replace function public.release_lecture_reservation(p_lecture_id uuid, p_owner_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare lecture public.lectures%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  select * into lecture from public.lectures where id = p_lecture_id and owner_id = p_owner_id for update;
  if not found or lecture.billed_seconds is not null or (lecture.reserved_included_seconds = 0 and lecture.reserved_overage_cents = 0) then return; end if;
  update public.billing_accounts set included_seconds = greatest(0, included_seconds - lecture.reserved_included_seconds), credit_cents = credit_cents + lecture.reserved_overage_cents, updated_at = now() where owner_id = p_owner_id;
  update public.lectures set billing_kind = null, billed_at = null, reserved_included_seconds = 0, reserved_overage_cents = 0 where id = p_lecture_id;
end $$;
