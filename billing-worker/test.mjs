// Local test: signature check + every alert type, with Discord/Graph calls captured.
import worker, { verifyStripeSignature, buildAlert, emailHtml } from './src/index.js';
const secret = 'whsec_test123';
const env = { STRIPE_WEBHOOK_SECRET: secret, DISCORD_WEBHOOK_URL: 'https://discord.test/hook', DISCORD_MENTION_USER_ID: '42',
  MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', MAIL_FROM: 'from@x.test', NOTIFY_TO: 'to@x.test',
  SIM_MONTHLY_LINK: 'plink_M', SIM_YEARLY_LINK: 'plink_Y' };
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init && init.body }); 
  if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok' }));
  return new Response(null, { status: 204 }); };
async function sign(body, t = Math.floor(Date.now()/1000)) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map(b=>b.toString(16).padStart(2,'0')).join('')}`;
}
const events = [
  { type: 'checkout.session.completed', livemode: true, data: { object: { payment_link: 'plink_M', amount_subtotal: 15900, amount_total: 16934, currency: 'usd', customer: 'cus_1', subscription: 'sub_1',
    customer_details: { name: 'Jane Doe', email: 'jane@x.test', phone: '+14075550100' },
    collected_information: { shipping_details: { name: 'Jane Doe', address: { line1: '1 Main St', city: 'Orlando', state: 'FL', postal_code: '32801', country: 'US' } } } } } },
  { type: 'checkout.session.completed', livemode: true, data: { object: { payment_link: 'plink_other', amount_subtotal: 34000, amount_total: 34000, currency: 'usd', customer_details: { name: 'Bob', email: 'b@x.test' } } } },
  { type: 'invoice.paid', livemode: true, data: { object: { id: 'in_1', billing_reason: 'subscription_cycle', subscription: 'sub_1', customer: 'cus_1', customer_name: 'Jane Doe', customer_email: 'jane@x.test', amount_paid: 15900, currency: 'usd', hosted_invoice_url: 'https://invoice.test/1' } } },
  { type: 'invoice.paid', livemode: true, data: { object: { id: 'in_0', billing_reason: 'subscription_create', subscription: 'sub_1' } } },
  { type: 'invoice.payment_failed', livemode: false, data: { object: { id: 'in_2', customer: 'cus_1', customer_name: 'Jane Doe', customer_email: 'jane@x.test', amount_due: 15900, currency: 'usd', attempt_count: 2, next_payment_attempt: 1796000000 } } },
  { type: 'customer.subscription.updated', livemode: true, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'past_due' }, previous_attributes: { status: 'active' } } },
  { type: 'customer.subscription.updated', livemode: true, data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: true, cancel_at: 1798000000 }, previous_attributes: { cancel_at_period_end: false } } },
  { type: 'customer.subscription.deleted', livemode: true, data: { object: { id: 'sub_1', customer: 'cus_1', cancellation_details: { reason: 'payment_failed' } } } },
  { type: 'charge.succeeded', livemode: true, data: { object: {} } },
];
for (const ev of events) {
  const a = await buildAlert(ev, env);
  console.log(ev.type.padEnd(32), a ? `${a.title} | ${a.fields.map(f=>f.name+': '+f.value.replace(/\n/g,' / ')).join(' | ')}` : '(no alert)');
}
// end-to-end through fetch handler
const body = JSON.stringify(events[0]);
calls.length = 0;
let r = await worker.fetch(new Request('https://billing.test/stripe', { method: 'POST', body, headers: { 'stripe-signature': await sign(body) } }), env);
const store = new Map(); env.SEEN = { get: async k => store.get(k) || null, put: async (k, v) => { store.set(k, v); } };
const dupBody = JSON.stringify({ ...events[0], id: 'evt_dup' });
let c1 = calls.length; await worker.fetch(new Request('https://billing.test/stripe', { method: 'POST', body: dupBody, headers: { 'stripe-signature': await sign(dupBody) } }), env);
let first = calls.length - c1; c1 = calls.length;
const r2 = await worker.fetch(new Request('https://billing.test/stripe', { method: 'POST', body: dupBody, headers: { 'stripe-signature': await sign(dupBody) } }), env);
console.log('dedupe: first sent', first, 'calls; repeat sent', calls.length - c1, 'calls ->', await r2.text());
delete env.SEEN;
console.log('\nvalid sig ->', r.status, '| outbound calls:', calls.map(c => c.url.split('/')[2]).join(', '));
const d = JSON.parse(calls.find(c => c.url.includes('discord')).body); console.log('discord content:', d.content, '| mention allowed:', JSON.stringify(d.allowed_mentions));
r = await worker.fetch(new Request('https://billing.test/stripe', { method: 'POST', body, headers: { 'stripe-signature': 't=1,v1=abc' } }), env); console.log('bad sig ->', r.status);
r = await worker.fetch(new Request('https://billing.test/stripe', { method: 'POST', body, headers: { 'stripe-signature': await sign(body, Math.floor(Date.now()/1000)-1000) } }), env); console.log('stale sig ->', r.status);
r = await worker.fetch(new Request('https://billing.test/', { method: 'GET' }), env); console.log('health ->', r.status, await r.text());
import { writeFileSync } from 'node:fs';
if (process.argv[2]) writeFileSync(process.argv[2], emailHtml(await buildAlert(events[0], env)));
