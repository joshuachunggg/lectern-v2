import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const stripe = async (path: string, body: URLSearchParams) => {
  const response = await fetch(`https://api.stripe.com/v1${path}`, { method: 'POST', headers: { Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
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
    const { action } = await request.json();
    const { data: account } = await admin.from('billing_accounts').select('*').eq('owner_id', user.id).maybeSingle();
    if (action === 'status') return Response.json({ active: ['active', 'trialing'].includes(account?.subscription_status ?? ''), included_used: account?.included_used ?? 0, free_used: account?.free_used ?? false }, { headers: cors });
    let customer = account?.stripe_customer_id;
    if (!customer) {
      const created = await stripe('/customers', new URLSearchParams({ email: user.email ?? '', 'metadata[supabase_user_id]': user.id }));
      customer = created.id;
      await admin.from('billing_accounts').upsert({ owner_id: user.id, stripe_customer_id: customer });
    }
    const origin = request.headers.get('origin') ?? 'http://localhost:5173';
    if (action === 'portal') {
      const session = await stripe('/billing_portal/sessions', new URLSearchParams({ customer, return_url: origin }));
      return Response.json({ url: session.url }, { headers: cors });
    }
    if (action !== 'checkout') throw new Error('Invalid billing action.');
    if (['active', 'trialing'].includes(account?.subscription_status ?? '')) throw new Error('Your subscription is already active.');
    const session = await stripe('/checkout/sessions', new URLSearchParams({ mode: 'subscription', customer, success_url: `${origin}?billing=success`, cancel_url: `${origin}?billing=cancelled`, 'line_items[0][price]': Deno.env.get('STRIPE_BASE_PRICE_ID')!, 'line_items[0][quantity]': '1', 'line_items[1][price]': Deno.env.get('STRIPE_OVERAGE_PRICE_ID')!, 'metadata[owner_id]': user.id, 'subscription_data[metadata][owner_id]': user.id }));
    return Response.json({ url: session.url }, { headers: cors });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Billing failed.' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
