// KJJ Tech review approval worker
// Routes:
//   POST /submit                         — form POST from leave-review.html; stores + pings Discord
//   GET  /review/:id/approve?t=<hmac>    — approve + auto-commit to GitHub
//   GET  /review/:id/deny?t=<hmac>       — deny (stays in DB, never published)
//   GET  /review/:id/remove?t=<hmac>     — remove an already-published review from GitHub
//   GET  /list?key=<ADMIN_KEY>           — list recent reviews (for debugging)

const enc = new TextEncoder();
const dec = new TextDecoder();

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function b64encodeUtf8(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function signAction(env, id, action) {
  const sig = await hmac(env.HMAC_SECRET, `${id}:${action}`);
  return `${env.WORKER_ORIGIN}/review/${id}/${action}?t=${sig}`;
}

async function makeSubmitLinks(env, id) {
  return {
    approve: await signAction(env, id, 'approve'),
    deny: await signAction(env, id, 'deny'),
  };
}

function buildTestimonialBlock(review) {
  const rating = Math.max(1, Math.min(5, parseInt(review.rating, 10) || 5));
  const stars = '★'.repeat(rating);
  const isAnon = review.display_anonymously === 'Yes';
  const displayName = isAnon ? 'Verified Client' : review.name;
  const role = review.service_type || 'Client Review';
  const quote = String(review.review || '').trim();
  const id = review.id;
  const datePublished = (review.decided_at || review.created_at || new Date().toISOString().slice(0, 10)).slice(0, 10);

  // Google's Review structured data rejects generic author names like "Verified Client".
  // Emit JSON-LD only when we have a real person name to cite.
  const jsonLd = isAnon ? '' : `
          <script type="application/ld+json">
          ${JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Review",
            "itemReviewed": {
              "@type": "LocalBusiness",
              "name": "KJJ Tech",
              "url": "https://kjjtech.com"
            },
            "reviewRating": {
              "@type": "Rating",
              "ratingValue": String(rating),
              "bestRating": "5"
            },
            "author": { "@type": "Person", "name": review.name },
            "reviewBody": quote,
            "datePublished": datePublished
          })}
          </script>`;

  return `        <!-- review:${id} -->
        <div class="testimonial" data-review-id="${escapeHtml(id)}">
          <div class="testimonial__stars">${stars}</div>
          <p class="testimonial__quote">"${escapeHtml(quote)}"</p>
          <div class="testimonial__author">
            <span class="testimonial__name">${escapeHtml(displayName)}</span>
            <span class="testimonial__role">${escapeHtml(role)}</span>
          </div>${jsonLd}
        </div>
        <!-- /review:${id} -->
        `;
}

async function sendSubmissionDiscord(env, review, links) {
  const ratingStars = '★'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
  const displayAs = review.display_anonymously === 'Yes'
    ? `Verified Client (real name: ${review.name})`
    : review.name;

  const embed = {
    title: 'New review submission',
    color: 0xf5b50a,
    fields: [
      { name: 'Rating', value: ratingStars, inline: true },
      { name: 'Service', value: review.service_type || '—', inline: true },
      { name: 'Display As', value: displayAs, inline: false },
      { name: 'Business / Role', value: review.business_or_role || '—', inline: true },
      { name: 'Email', value: review.email || '—', inline: true },
      { name: 'Review', value: String(review.review || '').slice(0, 1000) || '—' },
    ],
    footer: { text: `ID: ${review.id}` },
    timestamp: new Date().toISOString(),
  };

  const content = `**[✅ Approve & Publish](${links.approve})** · **[❌ Deny](${links.deny})**`;

  const res = await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, embeds: [embed] }),
  });
  if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
}

async function sendApprovedDiscord(env, review, removeUrl) {
  const displayName = review.display_anonymously === 'Yes' ? 'Verified Client' : review.name;
  const embed = {
    title: 'Review published',
    description: `"${String(review.review || '').slice(0, 200)}${(review.review || '').length > 200 ? '…' : ''}"`,
    color: 0x22c55e,
    fields: [
      { name: 'Display As', value: displayName, inline: true },
      { name: 'Rating', value: '★'.repeat(review.rating), inline: true },
    ],
    footer: { text: `ID: ${review.id}` },
    timestamp: new Date().toISOString(),
  };
  const content = `Live on kjjtech.com within ~60s. Need to pull it down later? **[🗑 Remove from site](${removeUrl})**`;
  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, embeds: [embed] }),
  });
}

async function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'kjjtech-review-worker',
  };
}

async function fetchIndexHtml(env) {
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const headers = await ghHeaders(env);
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/index.html?ref=${branch}`,
    { headers }
  );
  if (!res.ok) throw new Error(`GitHub GET failed: ${res.status} ${await res.text()}`);
  const cur = await res.json();
  return { content: b64decodeUtf8(cur.content), sha: cur.sha };
}

async function putIndexHtml(env, newContent, sha, commitMessage) {
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const headers = await ghHeaders(env);
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/index.html`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: commitMessage,
        content: b64encodeUtf8(newContent),
        sha,
        branch,
      }),
    }
  );
  if (!res.ok) throw new Error(`GitHub PUT failed: ${res.status} ${await res.text()}`);
}

async function commitApprovalToGitHub(env, review) {
  const { content, sha } = await fetchIndexHtml(env);
  const marker = '<!-- REVIEWS:END -->';
  if (!content.includes(marker)) {
    throw new Error('Insertion marker <!-- REVIEWS:END --> not found in index.html');
  }
  const block = buildTestimonialBlock(review);
  const newContent = content.replace(marker, `${block}${marker}`);
  const displayName = review.display_anonymously === 'Yes' ? 'Verified Client' : review.name;
  await putIndexHtml(env, newContent, sha, `Publish approved review from ${displayName}`);
}

async function commitRemovalToGitHub(env, review) {
  const { content, sha } = await fetchIndexHtml(env);
  const id = review.id;
  const blockRe = new RegExp(
    `[ \\t]*<!-- review:${escapeRegExp(id)} -->[\\s\\S]*?<!-- /review:${escapeRegExp(id)} -->[ \\t]*\\n?`,
    ''
  );
  if (!blockRe.test(content)) {
    throw new Error(`Could not find review block ${id} in index.html — it may have been edited or already removed.`);
  }
  const newContent = content.replace(blockRe, '');
  const displayName = review.display_anonymously === 'Yes' ? 'Verified Client' : review.name;
  await putIndexHtml(env, newContent, sha, `Remove review from ${displayName}`);
}

function htmlPage(title, body, opts = {}) {
  const color = opts.error ? '#b00020' : '#0a0a0a';
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} — KJJ Tech Reviews</title><style>
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:4rem auto;padding:2rem;text-align:center;color:${color};line-height:1.6;}
      h1{font-weight:300;letter-spacing:0.02em;font-size:1.6rem;margin-bottom:1rem;}
      p{color:#555;}
      a{color:#0a0a0a;}
      .card{border:1px solid #eee;border-radius:8px;padding:1.5rem;margin-top:1.5rem;text-align:left;background:#fafafa;font-size:0.9rem;}
    </style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`,
    { status: opts.status || 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { pathname } = url;

    try {
      // Submission from leave-review.html
      if (pathname === '/submit' && req.method === 'POST') {
        const ct = req.headers.get('content-type') || '';
        let body;
        if (ct.includes('application/json')) {
          body = await req.json();
        } else {
          const form = await req.formData();
          body = Object.fromEntries(form.entries());
        }

        if (body.form_type !== 'client_review') {
          return new Response('ignored (not a review submission)', { status: 200 });
        }

        const id = crypto.randomUUID();
        const rating = Math.max(1, Math.min(5, parseInt(body.rating, 10) || 5));

        await env.DB.prepare(
          `INSERT INTO reviews (id, name, email, business_or_role, rating, service_type, review, display_anonymously, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
        ).bind(
          id,
          body.name || '',
          body.email || '',
          body.business_or_role || '',
          rating,
          body.service_type || '',
          body.review || '',
          body.display_anonymously || 'No'
        ).run();

        const links = await makeSubmitLinks(env, id);
        await sendSubmissionDiscord(env, { ...body, id, rating }, links);

        return Response.redirect('https://kjjtech.com/thanks.html', 303);
      }

      // Approve / deny / remove
      const m = pathname.match(/^\/review\/([^/]+)\/(approve|deny|remove)$/);
      if (m && req.method === 'GET') {
        const [, id, action] = m;
        const token = url.searchParams.get('t') || '';
        const expected = await hmac(env.HMAC_SECRET, `${id}:${action}`);
        if (!(await timingSafeEqual(token, expected))) {
          return htmlPage('Invalid link', '<p>This link is invalid or has been tampered with.</p>', { status: 403, error: true });
        }

        const row = await env.DB.prepare('SELECT * FROM reviews WHERE id = ?').bind(id).first();
        if (!row) {
          return htmlPage('Not found', '<p>No review matches this link.</p>', { status: 404, error: true });
        }

        // State machine:
        //   pending → approve | deny
        //   approved → remove
        //   denied | removed → no further actions

        if (action === 'approve') {
          if (row.status !== 'pending') {
            return htmlPage('Already handled', `<p>This review was already marked <strong>${escapeHtml(row.status)}</strong>.</p>`);
          }
          await commitApprovalToGitHub(env, row);
          await env.DB.prepare("UPDATE reviews SET status = 'approved', decided_at = datetime('now') WHERE id = ?").bind(id).run();
          const removeUrl = await signAction(env, id, 'remove');
          try { await sendApprovedDiscord(env, row, removeUrl); } catch (e) { console.error('Discord followup failed', e); }
          return htmlPage(
            'Review approved',
            `<p>Committed to <code>main</code>. GitHub Pages will redeploy in about a minute.</p>
             <p><a href="https://kjjtech.com/#testimonials">View testimonials →</a></p>
             <p style="margin-top:2rem;font-size:0.85rem;color:#888;">Need to take it down later? <a href="${removeUrl}">Remove from site</a></p>`
          );
        }

        if (action === 'deny') {
          if (row.status !== 'pending') {
            return htmlPage('Already handled', `<p>This review was already marked <strong>${escapeHtml(row.status)}</strong>.</p>`);
          }
          await env.DB.prepare("UPDATE reviews SET status = 'denied', decided_at = datetime('now') WHERE id = ?").bind(id).run();
          return htmlPage('Review denied', '<p>The review was rejected. It will never be published.</p>');
        }

        if (action === 'remove') {
          if (row.status !== 'approved') {
            return htmlPage('Cannot remove', `<p>Only approved reviews can be removed. This review is currently <strong>${escapeHtml(row.status)}</strong>.</p>`, { status: 409, error: true });
          }
          await commitRemovalToGitHub(env, row);
          await env.DB.prepare("UPDATE reviews SET status = 'removed', decided_at = datetime('now') WHERE id = ?").bind(id).run();
          return htmlPage(
            'Review removed',
            '<p>The testimonial has been stripped from <code>index.html</code>. GitHub Pages will redeploy in about a minute.</p>'
          );
        }
      }

      // Weekly digest — posts a summary to Discord and returns JSON
      if (pathname === '/admin/digest' && req.method === 'GET') {
        const key = url.searchParams.get('key') || '';
        if (!env.ADMIN_KEY || !(await timingSafeEqual(key, env.ADMIN_KEY))) {
          return new Response('forbidden', { status: 403 });
        }

        const pending = await env.DB
          .prepare("SELECT id, name, rating, created_at FROM reviews WHERE status = 'pending' ORDER BY created_at ASC")
          .all();
        const weekStats = await env.DB
          .prepare("SELECT status, COUNT(*) AS n FROM reviews WHERE decided_at >= datetime('now', '-7 days') OR created_at >= datetime('now', '-7 days') GROUP BY status")
          .all();

        const counts = { pending: 0, approved: 0, denied: 0, removed: 0 };
        for (const row of weekStats.results || []) counts[row.status] = row.n;
        const pendingCount = (pending.results || []).length;

        const lines = [];
        if (pendingCount === 0) {
          lines.push('No pending reviews this week.');
        } else {
          lines.push(`**${pendingCount} pending review${pendingCount === 1 ? '' : 's'} waiting for you:**`);
          for (const r of pending.results.slice(0, 10)) {
            const age = Math.floor((Date.now() - new Date(r.created_at + 'Z').getTime()) / 86400000);
            lines.push(`• **${r.name}** — ${'★'.repeat(r.rating)} — submitted ${age}d ago`);
          }
          if (pendingCount > 10) lines.push(`…and ${pendingCount - 10} more.`);
        }

        const embed = {
          title: 'Weekly review digest',
          color: 0x0a0a0a,
          description: lines.join('\n'),
          fields: [
            { name: 'Last 7 days', value: `Approved: **${counts.approved}** · Denied: **${counts.denied}** · Removed: **${counts.removed}**` },
          ],
          timestamp: new Date().toISOString(),
        };

        await fetch(env.DISCORD_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ embeds: [embed] }),
        });

        return Response.json({ ok: true, pending: pendingCount, last_7_days: counts });
      }

      // Debug listing
      if (pathname === '/list' && req.method === 'GET') {
        const key = url.searchParams.get('key') || '';
        if (!env.ADMIN_KEY || !(await timingSafeEqual(key, env.ADMIN_KEY))) {
          return new Response('forbidden', { status: 403 });
        }
        const { results } = await env.DB
          .prepare('SELECT id, name, rating, status, created_at, decided_at FROM reviews ORDER BY created_at DESC LIMIT 50')
          .all();
        return Response.json(results);
      }

      if (pathname === '/' || pathname === '/health') {
        return new Response('kjjtech-reviews: ok', { status: 200 });
      }

      return new Response('not found', { status: 404 });
    } catch (err) {
      console.error(err);
      return new Response(`error: ${err.message}`, { status: 500 });
    }
  },
};
