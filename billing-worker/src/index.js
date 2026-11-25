// KJJ Tech billing alerts
// Receives Stripe webhooks and posts alerts to Discord and email (Microsoft Graph)
// for 5G data SIM orders, renewals, failed payments and cancellations.

const COLORS = { green: 0x16a34a, blue: 0x1d4ed8, amber: 0xd97706, red: 0xdc2626, gray: 0x6b7280 };
const DASH = 'https://dashboard.stripe.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response('KJJ Tech billing alerts: OK', { headers: { 'content-type': 'text/plain' } });
    }
    if (request.method !== 'POST' || url.pathname !== '/stripe') {
      return new Response('Not found', { status: 404 });
    }

    const body = await request.text();
    const ok = await verifyStripeSignature(body, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET);
    if (!ok) return new Response('Invalid signature', { status: 400 });

    let event;
    try { event = JSON.parse(body); } catch { return new Response('Bad JSON', { status: 400 }); }

    // Stripe retries and manual resends reuse the same event ID: alert only once per event.
    if (env.SEEN && event.id) {
      const key = `evt:${event.id}`;
      if (await env.SEEN.get(key)) {
        return new Response(JSON.stringify({ received: true, duplicate: true }), { headers: { 'content-type': 'application/json' } });
      }
      await env.SEEN.put(key, '1', { expirationTtl: 7 * 24 * 3600 });
    }

    const alert = await buildAlert(event, env);
    if (alert) {
      const results = await Promise.allSettled([sendDiscord(env, alert), sendEmail(env, alert)]);
      // Log only a safe summary: errors can contain URLs or values from secrets.
      results.forEach((r, i) => {
        if (r.status === 'rejected') console.error(i ? 'email failed' : 'discord failed', safeError(r.reason));
      });
    }
    return new Response(JSON.stringify({ received: true }), { headers: { 'content-type': 'application/json' } });
  },
};

function safeError(err) {
  const msg = String((err && err.message) || err || '');
  if (/^(Discord|Graph sendMail) \d{3}/.test(msg)) return msg.slice(0, 40);
  if (/^Graph token failed/.test(msg)) return msg.slice(0, 60);
  return (err && err.name) || 'Error';
}

// ---- Stripe signature (Stripe-Signature: t=...,v1=...) -------------------

export async function verifyStripeSignature(payload, header, secret, toleranceSec = 300) {
  secret = (secret || '').trim();
  if (!header || !secret) return false;
  const parts = {};
  const sigs = [];
  for (const kv of header.split(',')) {
    const [k, v] = kv.split('=');
    if (k === 't') parts.t = v;
    if (k === 'v1') sigs.push(v);
  }
  if (!parts.t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts.t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return sigs.some(s => timingSafeEqual(s, expected));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ---- Event -> alert ------------------------------------------------------

const money = (cents, cur = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: (cur || 'usd').toUpperCase() }).format((cents || 0) / 100);
const date = ts => (ts ? new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : '');

function simPlan(env, session) {
  const sub = session.amount_subtotal;
  if (session.payment_link === env.SIM_MONTHLY_LINK) return { plan: 'Monthly ($149/mo)', staticIp: sub >= 15900 };
  if (session.payment_link === env.SIM_YEARLY_LINK) return { plan: 'Yearly ($1,440/yr)', staticIp: sub >= 156000 };
  return null;
}

function formatAddress(a) {
  if (!a) return '';
  return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', ') + (a.postal_code ? ' ' + a.postal_code : ''), a.country && a.country !== 'US' ? a.country : '']
    .filter(s => s && s.trim()).join('\n');
}

async function customerInfo(env, customerId) {
  if (!customerId || !env.STRIPE_READ_KEY) return null;
  try {
    const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, { headers: { Authorization: `Bearer ${env.STRIPE_READ_KEY}` } });
    if (!res.ok) return null;
    const c = await res.json();
    return { name: c.name, email: c.email, phone: c.phone };
  } catch { return null; }
}

function who(name, email, customerId) {
  const label = [name, email].filter(Boolean).join(' · ') || customerId || 'Unknown customer';
  return customerId ? `[${label}](${DASH}/customers/${customerId})` : label;
}

export async function buildAlert(event, env) {
  const o = event.data && event.data.object;
  if (!o) return null;
  const live = event.livemode ? '' : ' (TEST)';

  switch (event.type) {
    case 'checkout.session.completed': {
      const sim = simPlan(env, o);
      const cd = o.customer_details || {};
      const ship = (o.collected_information && o.collected_information.shipping_details) || o.shipping_details || null;
      const fields = [
        { name: 'Customer', value: who(cd.name, cd.email, o.customer), inline: false },
        { name: 'Phone', value: cd.phone || '—', inline: true },
        { name: 'Paid today', value: money(o.amount_total, o.currency), inline: true },
      ];
      if (sim) {
        fields.unshift({ name: 'Plan', value: sim.plan, inline: true }, { name: 'Static IP', value: sim.staticIp ? 'Yes (+add-on)' : 'No', inline: true });
        fields.push({ name: 'Ship SIM to', value: ship ? `${ship.name || cd.name || ''}\n${formatAddress(ship.address)}`.trim() : '—', inline: false });
      }
      if (o.subscription) fields.push({ name: 'Subscription', value: `[Open in Stripe](${DASH}/subscriptions/${o.subscription})`, inline: false });
      return {
        level: 'good',
        title: sim ? `🛒 New 5G data SIM order${live}` : `💳 New Stripe payment${live}`,
        summary: sim ? 'Next: confirm coverage, activate the SIM and ship it.' : 'A checkout was completed.',
        color: COLORS.green,
        fields,
      };
    }

    case 'invoice.paid': {
      if (o.billing_reason === 'subscription_create') return null; // covered by the checkout alert
      if (!o.subscription && !(o.parent && o.parent.subscription_details)) return null;
      return {
        level: 'info',
        title: `✅ Renewal paid${live}`,
        summary: 'A subscription payment went through. Service stays active.',
        color: COLORS.blue,
        fields: [
          { name: 'Customer', value: who(o.customer_name, o.customer_email, o.customer), inline: false },
          { name: 'Amount', value: money(o.amount_paid, o.currency), inline: true },
          { name: 'Invoice', value: o.hosted_invoice_url ? `[View](${o.hosted_invoice_url})` : `[Open](${DASH}/invoices/${o.id})`, inline: true },
        ],
      };
    }

    case 'invoice.payment_failed': {
      const next = o.next_payment_attempt ? `Stripe will retry on ${date(o.next_payment_attempt)}.` : 'No more automatic retries are scheduled.';
      return {
        level: 'bad',
        title: `⚠️ Payment failed${live}`,
        summary: `${next} The customer gets an email to update their card.`,
        color: COLORS.amber,
        fields: [
          { name: 'Customer', value: who(o.customer_name, o.customer_email, o.customer), inline: false },
          { name: 'Amount due', value: money(o.amount_due, o.currency), inline: true },
          { name: 'Attempt', value: String(o.attempt_count || 1), inline: true },
          { name: 'Invoice', value: `[Open in Stripe](${DASH}/invoices/${o.id})`, inline: true },
        ],
      };
    }

    case 'customer.subscription.updated': {
      const prev = (event.data.previous_attributes) || {};
      const c = await customerInfo(env, o.customer);
      const base = [
        { name: 'Customer', value: who(c && c.name, c && c.email, o.customer), inline: false },
        { name: 'Subscription', value: `[Open in Stripe](${DASH}/subscriptions/${o.id})`, inline: true },
      ];
      if ('status' in prev && (o.status === 'past_due' || o.status === 'unpaid')) {
        return { level: 'bad', title: `⚠️ Subscription ${o.status.replace('_', ' ')}${live}`, summary: 'Payments are failing. If it isn\'t resolved, consider suspending the SIM.', color: COLORS.amber, fields: base };
      }
      if ('cancel_at_period_end' in prev && o.cancel_at_period_end) {
        return { level: 'bad', title: `📅 Cancellation scheduled${live}`, summary: `The customer canceled. Service ends ${date(o.cancel_at || o.current_period_end || (o.items && o.items.data && o.items.data[0] && o.items.data[0].current_period_end))}; suspend the SIM then.`, color: COLORS.gray, fields: base };
      }
      if ('status' in prev && o.status === 'active' && (prev.status === 'past_due' || prev.status === 'unpaid')) {
        return { level: 'good', title: `✅ Subscription back to active${live}`, summary: 'The overdue payment was collected.', color: COLORS.green, fields: base };
      }
      return null;
    }

    case 'customer.subscription.deleted': {
      const c = await customerInfo(env, o.customer);
      return {
        level: 'bad',
        title: `🛑 Subscription canceled${live}`,
        summary: 'Billing has stopped. Suspend this SIM in the Crosstalk partner portal.',
        color: COLORS.red,
        fields: [
          { name: 'Customer', value: who(c && c.name, c && c.email, o.customer), inline: false },
          { name: 'Reason', value: (o.cancellation_details && o.cancellation_details.reason) ? o.cancellation_details.reason.replace(/_/g, ' ') : '—', inline: true },
          { name: 'Subscription', value: `[Open in Stripe](${DASH}/subscriptions/${o.id})`, inline: true },
        ],
      };
    }

    default:
      return null;
  }
}

// ---- Delivery ------------------------------------------------------------

async function sendDiscord(env, a) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const mention = a.level === 'bad' && env.DISCORD_MENTION_USER_ID ? `<@${env.DISCORD_MENTION_USER_ID}> ` : '';
  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: `${mention}${a.summary}`,
      allowed_mentions: { users: env.DISCORD_MENTION_USER_ID ? [env.DISCORD_MENTION_USER_ID] : [] },
      embeds: [{ title: a.title, color: a.color, fields: a.fields, timestamp: new Date().toISOString() }],
    }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Discord-style [label](url) -> HTML link
const md = s => esc(s).replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>').replace(/\n/g, '<br>');

export function emailHtml(a) {
  const rows = a.fields.map(f => `<tr><td style="padding:6px 12px 6px 0;color:#6b7280;vertical-align:top;white-space:nowrap">${esc(f.name)}</td><td style="padding:6px 0;vertical-align:top">${md(f.value)}</td></tr>`).join('');
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;color:#0a0a0a;max-width:560px">
<div style="border-left:4px solid #${a.color.toString(16).padStart(6, '0')};padding:4px 0 4px 12px;margin-bottom:12px"><strong style="font-size:16px">${esc(a.title)}</strong><br><span style="color:#444">${esc(a.summary)}</span></div>
<table style="border-collapse:collapse">${rows}</table>
<p style="color:#9ca3af;font-size:12px;margin-top:16px">KJJ Tech billing alerts &middot; Stripe</p></div>`;
}

async function sendEmail(env, a) {
  if (!env.MS_TENANT_ID || !env.MS_CLIENT_ID || !env.MS_CLIENT_SECRET || !env.NOTIFY_TO) return;
  const tok = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }),
  }).then(r => r.json());
  if (!tok.access_token) throw new Error(`Graph token failed: ${tok.error || ''}`);
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: a.title.replace(/^[^\w]+\s*/u, ''),
        body: { contentType: 'HTML', content: emailHtml(a) },
        toRecipients: env.NOTIFY_TO.split(',').map(e => ({ emailAddress: { address: e.trim() } })),
      },
      saveToSentItems: false,
    }),
  });
  if (!res.ok) throw new Error(`Graph sendMail ${res.status} ${await res.text()}`);
}
