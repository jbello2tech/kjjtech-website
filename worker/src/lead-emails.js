// Automated lead follow-up emails for checklist downloads.
//
// A daily cron (8 AM America/New_York) does two passes over the `leads` table:
//   1. Welcome email  — checklist leads at least 1 hour old that haven't been emailed.
//   2. Follow-up      — leads whose welcome email went out 5+ days ago, unless they
//                       already replied (checked in the sender's mailbox) or unsubscribed.
//
// Mail goes out through Microsoft Graph as MAIL_FROM (a real M365 mailbox), so
// copies land in Sent Items and replies arrive in the normal inbox.
//
// Required secrets: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, HMAC_SECRET
// Required vars:    MAIL_FROM, WORKER_ORIGIN
// Optional vars:    MAIL_POSTAL_ADDRESS (shown in the email footer)

const CHECKLIST_RESOURCE = 'unifi-security-checklist';
const MAX_PER_RUN = 40;            // safety cap per pass
const FOLLOWUP_DAYS = 5;
const SEND_HOUR_NY = 8;

const SIGNATURE = {
  name: 'Jorge Bello',
  company: 'KJJ Tech',
  site: 'https://kjjtech.com',
  phone: '(914) 527-9957',
};

// Per-page copy. `topic` is used in the follow-up; `line` goes in the welcome email.
const TOPICS = {
  'unifi-vlan-setup-guide': {
    topic: 'VLAN setup',
    line: "Since you came from the VLAN guide: the spots people most often trip on are switch port profiles and getting inter-VLAN traffic rules right, especially for IoT and guest networks. Small mistakes there can quietly undo the isolation you're setting up.",
  },
  'unifi-zone-based-firewall': {
    topic: 'zone-based firewall setup',
    line: "Since you came from the zone-based firewall post: the migration is a big shift. The most common issues are rules that end up too broad after the move, and unexpected default 'allow' behavior between custom zones.",
  },
  'unifi-ap-placement-guide': {
    topic: 'access point placement',
    line: "Since you came from the AP placement guide: most WiFi complaints I see come down to channel width, transmit power set too high, or APs mounted where they're convenient rather than where coverage is needed. A quick look at a floor plan usually sorts it out.",
  },
  'sonos-unifi-best-practices': {
    topic: 'Sonos + UniFi setup',
    line: "Since you came from the Sonos post: Sonos is picky about multicast, IGMP snooping, and spanning tree, and it gets trickier once it lives on a separate VLAN from the phones controlling it.",
  },
  'network-security-tips': {
    topic: 'network security',
    line: "Since you came from the network security tips post: the biggest wins are usually the boring ones, like firmware updates, removing old port forwards, separating IoT devices, and locking down remote access.",
  },
};
const DEFAULT_TOPIC = {
  topic: 'UniFi network',
  line: "Most of the networks I review have one or two small gaps, usually around port forwards, IoT segmentation, or remote access, that are quick to close once you know where to look.",
};

// ---- helpers -------------------------------------------------------------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function hmacB64(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function unsubscribeToken(env, id) {
  return hmacB64(env.HMAC_SECRET, `${id}:unsubscribe`);
}

async function unsubscribeUrl(env, id) {
  return `${env.WORKER_ORIGIN}/unsubscribe?id=${encodeURIComponent(id)}&t=${await unsubscribeToken(env, id)}`;
}

export function nyHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(date));
}

// ---- email bodies --------------------------------------------------------

function wrap(paragraphs, footerHtml) {
  const p = paragraphs.map(t => `<p style="margin:0 0 14px">${t}</p>`).join('');
  const sig = `<p style="margin:18px 0 0">${esc(SIGNATURE.name)}<br>${esc(SIGNATURE.company)}<br>` +
    `<a href="${SIGNATURE.site}" style="color:#1d4ed8">kjjtech.com</a> &middot; ${esc(SIGNATURE.phone)}</p>`;
  return `<div style="font-family:-apple-system,Segoe UI,Calibri,Arial,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:600px">` +
    `${p}${sig}<p style="margin:28px 0 0;font-size:12px;color:#777;line-height:1.5">${footerHtml}</p></div>`;
}

function footer(env, unsubUrl) {
  const addr = env.MAIL_POSTAL_ADDRESS ? ` &middot; ${esc(env.MAIL_POSTAL_ADDRESS)}` : '';
  return `You're receiving this because you downloaded the UniFi Security Checklist from kjjtech.com. ` +
    `<a href="${unsubUrl}" style="color:#777">Unsubscribe</a>.<br>KJJ Tech${addr}`;
}

export function welcomeEmail(env, lead, unsubUrl) {
  const t = TOPICS[lead.source] || DEFAULT_TOPIC;
  return {
    subject: 'Your UniFi checklist + a quick offer',
    html: wrap([
      'Hi there,',
      'Thanks for downloading the <b>UniFi Security Checklist</b> from KJJ Tech. I hope it comes in handy.',
      esc(t.line),
      "If you get stuck, or want a second set of eyes before making changes on a live network, just reply to this email. I'm happy to answer a quick question at no cost. And if you'd rather have someone take care of it, we can set up a short call and walk through your setup together.",
      'Either way, good luck with the project!',
    ], footer(env, unsubUrl)),
  };
}

export function followupEmail(env, lead, unsubUrl) {
  const t = TOPICS[lead.source] || DEFAULT_TOPIC;
  return {
    subject: 'Did the UniFi checklist help?',
    html: wrap([
      'Hi there,',
      `Just checking in: did the UniFi Security Checklist cover what you needed for your ${esc(t.topic)}?`,
      "If something didn't make sense or you hit a snag, reply here and I'll point you in the right direction.",
      `And if you'd rather hand it off, we do <a href="https://kjjtech.com/remote-unifi-services.html" style="color:#1d4ed8">remote UniFi setups and security reviews</a> for homes and businesses anywhere in the US.`,
      "This is my last note about the checklist. Thanks again for reading!",
    ], footer(env, unsubUrl)),
  };
}

// ---- Microsoft Graph -----------------------------------------------------

async function graphToken(env) {
  const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Graph token failed: ${res.status} ${data.error_description || data.error || ''}`.trim());
  return data.access_token;
}

async function graphSend(env, token, to, { subject, html }) {
  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) throw new Error(`sendMail ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// True if the mailbox has any message from `email` received after `sinceIso`.
async function hasRepliedSince(env, token, email, sinceIso) {
  const filter = `from/emailAddress/address eq '${email.replace(/'/g, "''")}'`;
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.MAIL_FROM)}/messages` +
    `?$filter=${encodeURIComponent(filter)}&$select=receivedDateTime&$top=25`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`reply check ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { value = [] } = await res.json();
  const since = new Date(sinceIso.replace(' ', 'T') + 'Z').getTime();
  return value.some(m => new Date(m.receivedDateTime).getTime() >= since);
}

// ---- the daily run -------------------------------------------------------

async function ensureColumns(env) {
  const { results } = await env.DB.prepare('PRAGMA table_info(leads)').all();
  const have = new Set((results || []).map(r => r.name));
  for (const col of ['emailed_at', 'followup_at', 'unsubscribed_at', 'email_note']) {
    if (!have.has(col)) await env.DB.prepare(`ALTER TABLE leads ADD COLUMN ${col} TEXT`).run();
  }
}

/**
 * Sends due welcome + follow-up emails. With dryRun, nothing is sent or written;
 * the return value lists what would happen.
 */
export async function runLeadEmails(env, { dryRun = false } = {}) {
  await ensureColumns(env);
  const report = { dryRun, welcome: [], followup: [], skipped: [], errors: [] };

  const welcomeDue = (await env.DB.prepare(
    `SELECT id, email, source, created_at FROM leads
      WHERE resource = ? AND status = 'new'
        AND emailed_at IS NULL AND unsubscribed_at IS NULL
        AND created_at <= datetime('now', '-1 hour')
      ORDER BY created_at LIMIT ?`
  ).bind(CHECKLIST_RESOURCE, MAX_PER_RUN).all()).results || [];

  const followupDue = (await env.DB.prepare(
    `SELECT id, email, source, emailed_at FROM leads
      WHERE resource = ? AND status = 'new'
        AND emailed_at IS NOT NULL AND followup_at IS NULL AND unsubscribed_at IS NULL
        AND date(emailed_at) <= date('now', ?)
      ORDER BY emailed_at LIMIT ?`
  ).bind(CHECKLIST_RESOURCE, `-${FOLLOWUP_DAYS} days`, MAX_PER_RUN).all()).results || [];

  if (!welcomeDue.length && !followupDue.length) return report;

  // Addresses that are unsubscribed or already got a welcome email on any row
  // (people sometimes download twice) — never email them a second welcome.
  const prior = (await env.DB.prepare(
    `SELECT lower(email) e, max(emailed_at IS NOT NULL) emailed, max(unsubscribed_at IS NOT NULL) unsub
       FROM leads GROUP BY lower(email)`
  ).all()).results || [];
  const priorMap = new Map(prior.map(r => [r.e, r]));

  const token = dryRun ? null : await graphToken(env);
  const mark = (id, col, note) => dryRun ? null : env.DB.prepare(
    `UPDATE leads SET ${col} = datetime('now'), email_note = ? WHERE id = ?`
  ).bind(note, id).run();

  const seen = new Set();
  for (const lead of welcomeDue) {
    const key = lead.email.toLowerCase();
    const p = priorMap.get(key);
    if (seen.has(key) || p?.emailed || p?.unsub) {
      report.skipped.push({ email: lead.email, why: p?.unsub ? 'unsubscribed' : 'duplicate download' });
      // Close out the row so it isn't re-evaluated daily and gets no follow-up.
      if (!dryRun) await env.DB.prepare(
        `UPDATE leads SET emailed_at = datetime('now'), followup_at = datetime('now'), email_note = 'skipped: duplicate/unsubscribed' WHERE id = ?`
      ).bind(lead.id).run();
      continue;
    }
    seen.add(key);
    try {
      if (!dryRun) {
        await graphSend(env, token, lead.email, welcomeEmail(env, lead, await unsubscribeUrl(env, lead.id)));
        await mark(lead.id, 'emailed_at', 'welcome sent');
      }
      report.welcome.push({ email: lead.email, source: lead.source });
    } catch (e) {
      report.errors.push({ email: lead.email, step: 'welcome', error: e.message });
    }
  }

  for (const lead of followupDue) {
    try {
      if (!dryRun) {
        if (await hasRepliedSince(env, token, lead.email, lead.emailed_at)) {
          await mark(lead.id, 'followup_at', 'follow-up skipped: they replied');
          report.skipped.push({ email: lead.email, why: 'already replied' });
          continue;
        }
        await graphSend(env, token, lead.email, followupEmail(env, lead, await unsubscribeUrl(env, lead.id)));
        await mark(lead.id, 'followup_at', 'follow-up sent');
      }
      report.followup.push({ email: lead.email, source: lead.source });
    } catch (e) {
      report.errors.push({ email: lead.email, step: 'follow-up', error: e.message });
    }
  }

  return report;
}

export async function postRunSummary(env, report) {
  const { welcome, followup, skipped, errors } = report;
  if (!welcome.length && !followup.length && !skipped.length && !errors.length) return;
  const list = arr => arr.map(x => `• ${x.email}${x.source ? ` (${x.source})` : ''}${x.why ? ` — ${x.why}` : ''}${x.error ? ` — ${x.step}: ${x.error}` : ''}`).join('\n').slice(0, 1000) || '—';
  const fields = [];
  if (welcome.length) fields.push({ name: `Welcome emails sent (${welcome.length})`, value: list(welcome) });
  if (followup.length) fields.push({ name: `Follow-ups sent (${followup.length})`, value: list(followup) });
  if (skipped.length) fields.push({ name: `Skipped (${skipped.length})`, value: list(skipped) });
  if (errors.length) fields.push({ name: `⚠️ Errors (${errors.length})`, value: list(errors) });
  await fetch(env.LEADS_WEBHOOK_URL || env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [{
      title: '📬 Checklist lead emails',
      color: errors.length ? 0xdc2626 : 0x16a34a,
      fields,
      timestamp: new Date().toISOString(),
    }] }),
  }).catch(e => console.error('Run summary Discord post failed', e));
}

export async function scheduledLeadEmails(env) {
  if (nyHour() !== SEND_HOUR_NY) return; // cron fires hourly; only send at 8 AM Eastern
  let report;
  try {
    report = await runLeadEmails(env);
  } catch (e) {
    report = { welcome: [], followup: [], skipped: [], errors: [{ email: '(run)', step: 'run', error: e.message }] };
  }
  await postRunSummary(env, report);
}
