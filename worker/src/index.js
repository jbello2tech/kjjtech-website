// KJJ Tech review approval worker
// Routes:
//   POST /submit                         — Formspree webhook; stores review + pings Discord
//   GET  /review/:id/approve?t=<hmac>    — approve + auto-commit to GitHub
//   GET  /review/:id/deny?t=<hmac>       — deny (stays in DB, never published)
//   GET  /list?key=<ADMIN_KEY>           — list recent reviews (for debugging)

const enc = new TextEncoder();
const dec = new TextDecoder();

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
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

async function makeLinks(env, id) {
  const origin = env.WORKER_ORIGIN;
  const approve = await hmac(env.HMAC_SECRET, `${id}:approve`);
  const deny = await hmac(env.HMAC_SECRET, `${id}:deny`);
  return {
    approve: `${origin}/review/${id}/approve?t=${approve}`,
    deny: `${origin}/review/${id}/deny?t=${deny}`,
  };
}

function buildTestimonialBlock(review) {
  const rating = Math.max(1, Math.min(5, parseInt(review.rating, 10) || 5));
  const stars = '★'.repeat(rating);
  const displayName = review.display_anonymously === 'Yes' ? 'Verified Client' : review.name;
  const role = review.service_type || 'Client Review';
  const quote = String(review.review || '').trim();

  return `        <div class="testimonial">
          <div class="testimonial__stars">${stars}</div>
          <p class="testimonial__quote">"${escapeHtml(quote)}"</p>
          <div class="testimonial__author">
            <span class="testimonial__name">${escapeHtml(displayName)}</span>
            <span class="testimonial__role">${escapeHtml(role)}</span>
          </div>
        </div>
        `;
}

async function sendDiscord(env, review, links) {
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

async function commitToGitHub(env, review) {
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const path = 'index.html';
  const headers = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'kjjtech-review-worker',
  };

  const getRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
    { headers }
  );
  if (!getRes.ok) throw new Error(`GitHub GET failed: ${getRes.status} ${await getRes.text()}`);
  const cur = await getRes.json();
  const content = b64decodeUtf8(cur.content);

  const marker = '<!-- REVIEWS:END -->';
  if (!content.includes(marker)) {
    throw new Error('Insertion marker <!-- REVIEWS:END --> not found in index.html');
  }

  const block = buildTestimonialBlock(review);
  const newContent = content.replace(marker, `${block}${marker}`);
  const displayName = review.display_anonymously === 'Yes' ? 'Verified Client' : review.name;

  const putRes = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Publish approved review from ${displayName}`,
        content: b64encodeUtf8(newContent),
        sha: cur.sha,
        branch,
      }),
    }
  );
  if (!putRes.ok) throw new Error(`GitHub PUT failed: ${putRes.status} ${await putRes.text()}`);
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
      // Formspree webhook
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

        const links = await makeLinks(env, id);
        await sendDiscord(env, { ...body, id, rating }, links);

        // Browser form POST → redirect to the thanks page
        return Response.redirect('https://kjjtech.com/thanks.html', 303);
      }

      // Approve / deny
      const m = pathname.match(/^\/review\/([^/]+)\/(approve|deny)$/);
      if (m && req.method === 'GET') {
        const [, id, action] = m;
        const token = url.searchParams.get('t') || '';
        const expected = await hmac(env.HMAC_SECRET, `${id}:${action}`);
        if (!(await timingSafeEqual(token, expected))) {
          return htmlPage('Invalid link', '<p>This approval link is invalid or has been tampered with.</p>', { status: 403, error: true });
        }

        const row = await env.DB.prepare('SELECT * FROM reviews WHERE id = ?').bind(id).first();
        if (!row) {
          return htmlPage('Not found', '<p>No review matches this link.</p>', { status: 404, error: true });
        }
        if (row.status !== 'pending') {
          return htmlPage(
            'Already handled',
            `<p>This review was already marked <strong>${escapeHtml(row.status)}</strong>.</p>`
          );
        }

        if (action === 'deny') {
          await env.DB.prepare("UPDATE reviews SET status = 'denied', decided_at = datetime('now') WHERE id = ?").bind(id).run();
          return htmlPage('Review denied', '<p>The review was rejected. It will never be published.</p>');
        }

        // approve → commit to GitHub
        await commitToGitHub(env, row);
        await env.DB.prepare("UPDATE reviews SET status = 'approved', decided_at = datetime('now') WHERE id = ?").bind(id).run();
        return htmlPage(
          'Review approved',
          '<p>Committed to <code>main</code>. GitHub Pages will redeploy in about a minute.</p><p><a href="https://kjjtech.com/#testimonials">View testimonials →</a></p>'
        );
      }

      // Simple listing for debugging
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
