import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const text = new TextEncoder();
const hex = (value: Uint8Array) => [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
const stripeSubscription = async (id: string) => {
  const response = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, { headers: { Authorization: `Bearer ${Deno.env.get('STRIPE_SECRET_KEY')}` } });
  if (!response.ok) throw new Error('Could not retrieve Stripe subscription.');
  return await response.json();
};
async function verified(request: Request, payload: string) {
  const signature = request.headers.get('stripe-signature') ?? '', timestamp = signature.match(/(?:^|,)t=(\d+)/)?.[1], expected = signature.matchAll(/(?:^|,)v1=([a-f0-9]+)/g);
  if (!timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', text.encode(Deno.env.get('STRIPE_WEBHOOK_SECRET')!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const actual = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, text.encode(`${timestamp}.${payload}`))));
  return [...expected].some(match => match[1] === actual);
}

Deno.serve(async request => {
  const payload = await request.text();
  if (!await verified(request, payload)) return new Response('Invalid signature', { status: 400 });
  const event = JSON.parse(payload), object = event.data.object, admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const syncSubscription = async (id: string, owner?: string) => {
    const subscription = await stripeSubscription(id), end = subscription.current_period_end ?? subscription.items?.data?.[0]?.current_period_end;
    const query = admin.from('billing_accounts').update({ stripe_subscription_id: subscription.id, subscription_status: subscription.status, period_end: end ? new Date(end * 1000).toISOString() : null, updated_at: new Date().toISOString() });
    if (owner) await query.eq('owner_id', owner); else await query.eq('stripe_customer_id', object.customer);
  }
  const owner = object.metadata?.owner_id;
  if (event.type === 'checkout.session.completed' && owner && typeof object.subscription === 'string') {
    await admin.from('billing_accounts').upsert({ owner_id: owner, stripe_customer_id: object.customer, stripe_subscription_id: object.subscription });
    await syncSubscription(object.subscription, owner);
  }
  if (event.type.startsWith('customer.subscription.')) await syncSubscription(object.id, owner);
  if (event.type === 'invoice.paid' && typeof object.subscription === 'string') {
    await syncSubscription(object.subscription);
    const account = admin.from('billing_accounts').update({ included_used: 0, updated_at: new Date().toISOString() }).eq('stripe_customer_id', object.customer).eq('stripe_subscription_id', object.subscription);
    await account;
    await admin.from('billing_accounts').update({ overage_used: 0 }).eq('stripe_customer_id', object.customer).eq('stripe_subscription_id', object.subscription);
  }
  if (event.type === 'invoice.payment_failed') await admin.from('billing_accounts').update({ subscription_status: 'past_due', updated_at: new Date().toISOString() }).eq('stripe_customer_id', object.customer);
  return new Response('ok');
});
