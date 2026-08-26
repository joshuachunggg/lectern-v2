import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const text = new TextEncoder();
const hex = (value: Uint8Array) => [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
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
  const owner = object.metadata?.owner_id;
  if (event.type === 'checkout.session.completed' && owner) await admin.from('billing_accounts').upsert({ owner_id: owner, stripe_customer_id: object.customer, stripe_subscription_id: object.subscription, subscription_status: 'active' });
  if (event.type.startsWith('customer.subscription.')) {
    const end = object.current_period_end ? new Date(object.current_period_end * 1000).toISOString() : null;
    const query = admin.from('billing_accounts').update({ stripe_subscription_id: object.id, subscription_status: object.status, period_end: end, updated_at: new Date().toISOString() });
    if (owner) await query.eq('owner_id', owner); else await query.eq('stripe_customer_id', object.customer);
  }
  if (event.type === 'invoice.paid') {
    const end = object.lines?.data?.[0]?.period?.end;
    await admin.from('billing_accounts').update({ subscription_status: 'active', included_used: 0, period_end: end ? new Date(end * 1000).toISOString() : null, updated_at: new Date().toISOString() }).eq('stripe_customer_id', object.customer);
  }
  if (event.type === 'invoice.payment_failed') await admin.from('billing_accounts').update({ subscription_status: 'past_due', updated_at: new Date().toISOString() }).eq('stripe_customer_id', object.customer);
  return new Response('ok');
});
