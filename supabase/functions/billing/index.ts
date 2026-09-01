import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const stripe = async (path: string, body: URLSearchParams, idempotencyKey?: string) => {
  const response = await fetch(`https://api.stripe.com/v1${path}`, { method: 'POST', headers: { Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Stripe request failed.');
  return result;
};
const stripeSubscription = async (id: string) => {
  const response = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, { headers: { Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}` } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? 'Stripe request failed.');
  return result;
};

Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const token = request.headers.get('Authorization'); if (!token) throw new Error('Sign in required.');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: token } } });
    const { data: { user } } = await client.auth.getUser(); if (!user) throw new Error('Sign in required.');
    const { action, creditCents, returnUrl: requestedReturnUrl } = await request.json();
    let { data: account } = await admin.from('billing_accounts').select('*').eq('owner_id', user.id).maybeSingle();
    if (action === 'status') {
      if (account?.stripe_subscription_id) {
        const subscription = await stripeSubscription(account.stripe_subscription_id), end = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
        account = { ...account, subscription_status: subscription.status, period_end: end ? new Date(end * 1000).toISOString() : null, cancel_at: subscription.cancel_at ? new Date(subscription.cancel_at * 1000).toISOString() : subscription.cancel_at_period_end && end ? new Date(end * 1000).toISOString() : null };
        await admin.from('billing_accounts').update({ subscription_status: account.subscription_status, period_end: account.period_end, cancel_at: account.cancel_at, updated_at: new Date().toISOString() }).eq('owner_id', user.id);
      }
      const active = ['active', 'trialing'].includes(account?.subscription_status ?? '') && (!!account?.period_end && new Date(account.period_end) > new Date());
      return Response.json({ active, included_seconds: account?.included_seconds ?? 0, overage_seconds: account?.overage_seconds ?? 0, credit_cents: account?.credit_cents ?? 0, free_used: account?.free_used ?? false, cancel_at: account?.cancel_at ?? null }, { headers: cors });
    }
    if (!account) {
      await admin.from('billing_accounts').upsert({ owner_id: user.id }, { onConflict: 'owner_id', ignoreDuplicates: true });
      ({ data: account } = await admin.from('billing_accounts').select('*').eq('owner_id', user.id).single());
    }
    let customer = account?.stripe_customer_id;
    if (!customer) {
      const pending = `pending:${user.id}`;
      const { data: locked } = await admin.from('billing_accounts').update({ stripe_customer_id: pending }).eq('owner_id', user.id).is('stripe_customer_id', null).select('owner_id').maybeSingle();
      if (!locked) throw new Error('Billing setup is already in progress. Please try again in a moment.');
      try {
        const created = await stripe('/customers', new URLSearchParams({ email: user.email ?? '', 'metadata[supabase_user_id]': user.id }));
        customer = created.id;
        await admin.from('billing_accounts').update({ stripe_customer_id: customer }).eq('owner_id', user.id).eq('stripe_customer_id', pending);
      } catch (error) {
        await admin.from('billing_accounts').update({ stripe_customer_id: null }).eq('owner_id', user.id).eq('stripe_customer_id', pending);
        throw error;
      }
    }
    const origin = request.headers.get('origin') ?? 'http://localhost:5173', returnUrl = new URL(typeof requestedReturnUrl === 'string' ? requestedReturnUrl : origin);
    if (returnUrl.origin !== origin) throw new Error('Invalid return URL.');
    if (action === 'portal') {
      const session = await stripe('/billing_portal/sessions', new URLSearchParams({ customer, return_url: returnUrl.href }));
      return Response.json({ url: session.url }, { headers: cors });
    }
    if (action === 'credit_checkout') {
      if (!['active', 'trialing'].includes(account?.subscription_status ?? '')) throw new Error('An active subscription is required to add overage funds.');
      if (!Number.isInteger(creditCents) || creditCents < 50 || creditCents > 10_000) throw new Error('Enter an amount from $0.50 to $100.00.');
      const session = await stripe('/checkout/sessions', new URLSearchParams({ mode: 'payment', customer, success_url: `${returnUrl.href}?billing=credit-added`, cancel_url: `${returnUrl.href}?billing=cancelled`, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][product_data][name]': 'Lectern overage balance', 'line_items[0][price_data][unit_amount]': String(creditCents), 'line_items[0][quantity]': '1', 'metadata[owner_id]': user.id, 'metadata[purpose]': 'overage_credit' }));
      return Response.json({ url: session.url }, { headers: cors });
    }
    if (action !== 'checkout') throw new Error('Invalid billing action.');
    if (['active', 'trialing'].includes(account?.subscription_status ?? '')) throw new Error('Your subscription is already active.');
    const session = await stripe('/checkout/sessions', new URLSearchParams({ mode: 'subscription', customer, success_url: `${returnUrl.href}?billing=success`, cancel_url: `${returnUrl.href}?billing=cancelled`, 'line_items[0][price]': Deno.env.get('STRIPE_BASE_PRICE_ID')!, 'line_items[0][quantity]': '1', 'metadata[owner_id]': user.id, 'subscription_data[metadata][owner_id]': user.id }), `subscription-checkout:${customer}:${new Date().toISOString().slice(0, 10)}`);
    return Response.json({ url: session.url }, { headers: cors });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Billing failed.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
