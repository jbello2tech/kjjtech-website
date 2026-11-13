// Live Google reviews for the homepage.
//
// Google's Places API terms don't allow caching review content (only the
// Place ID may be stored), so every call fetches fresh from Google. The page
// only calls this when the reviews section scrolls into view, and a daily cap
// (counted in D1 — counts only, no review content) keeps usage inside the
// free monthly allowance. Over the cap, we return {capped:true} and the page
// simply hides the section until the next day.
//
// Secret: GOOGLE_PLACES_KEY (restricted to Places API (New))
// Vars:   GOOGLE_PLACE_ID, GOOGLE_DAILY_CAP (default 30)

const FIELDS = 'rating,userRatingCount,googleMapsUri,googleMapsLinks.reviewsUri,googleMapsLinks.writeAReviewUri,reviews';
const ALLOWED_ORIGINS = /^https:\/\/(www\.)?kjjtech\.com$|^http:\/\/localhost(:\d+)?$/;

function cors(req) {
  const origin = req.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.test(origin)
    ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
    : {};
}

async function takeQuota(env) {
  const cap = Number(env.GOOGLE_DAILY_CAP || 30);
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS api_usage (day TEXT NOT NULL, api TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, api))').run();
  const row = await env.DB.prepare(
    `INSERT INTO api_usage (day, api, n) VALUES (date('now'), 'places', 1)
     ON CONFLICT(day, api) DO UPDATE SET n = n + 1
     RETURNING n`
  ).first();
  return row.n <= cap;
}

export async function handleGoogleReviews(req, env) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(req) };
  if (!env.GOOGLE_PLACES_KEY || !env.GOOGLE_PLACE_ID) {
    return new Response(JSON.stringify({ error: 'not configured' }), { status: 503, headers });
  }
  if (!(await takeQuota(env))) {
    return new Response(JSON.stringify({ capped: true }), { headers });
  }

  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(env.GOOGLE_PLACE_ID)}`, {
    headers: { 'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY, 'X-Goog-FieldMask': FIELDS },
  });
  if (!res.ok) {
    console.error('Places API error', res.status, (await res.text()).slice(0, 300));
    return new Response(JSON.stringify({ error: 'upstream' }), { status: 502, headers });
  }
  const p = await res.json();
  const body = {
    rating: p.rating ?? null,
    count: p.userRatingCount ?? 0,
    mapsUri: p.googleMapsUri || null,
    reviewsUri: p.googleMapsLinks?.reviewsUri || p.googleMapsUri || null,
    writeReviewUri: p.googleMapsLinks?.writeAReviewUri || null,
    reviews: (p.reviews || []).map(r => ({
      author: r.authorAttribution?.displayName || 'Google user',
      authorUri: r.authorAttribution?.uri || null,
      photo: r.authorAttribution?.photoUri || null,
      rating: r.rating ?? null,
      when: r.relativePublishTimeDescription || '',
      text: r.text?.text || r.originalText?.text || '',
      uri: r.googleMapsUri || null,
    })),
  };
  return new Response(JSON.stringify(body), { headers });
}

// ---- New-review alerts to Discord ---------------------------------------
// Runs on the Worker's cron (4x/day). Stores only the review COUNT (a number,
// no review content) to detect increases, then posts to the reviews channel
// with a link to read/reply on Google. Uses the same daily cap as the page.

export async function checkNewGoogleReviews(env) {
  if (!env.GOOGLE_PLACES_KEY || !env.GOOGLE_PLACE_ID) return;
  if (!(await takeQuota(env))) return;

  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(env.GOOGLE_PLACE_ID)}`, {
    headers: { 'X-Goog-Api-Key': env.GOOGLE_PLACES_KEY, 'X-Goog-FieldMask': FIELDS },
  });
  if (!res.ok) { console.error('Places check failed', res.status); return; }
  const p = await res.json();
  const count = p.userRatingCount ?? 0;

  await env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)').run();
  const prev = await env.DB.prepare("SELECT value FROM kv WHERE key = 'google_review_count'").first();
  await env.DB.prepare("INSERT INTO kv (key, value) VALUES ('google_review_count', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(String(count)).run();
  if (!prev) return;                     // first run: just record the baseline
  const added = count - Number(prev.value);
  if (added <= 0) return;                // no change, or Google removed one

  // Newest review among the (up to 5) Google returns, if it's recent.
  const newest = (p.reviews || []).slice().sort((a, b) => (b.publishTime || '').localeCompare(a.publishTime || ''))[0];
  const recent = newest && Date.now() - Date.parse(newest.publishTime) < 3 * 86400000;
  const fields = [{ name: 'Google rating', value: `${(p.rating ?? 0).toFixed(1)} ★ · ${count} review${count === 1 ? '' : 's'}`, inline: true }];
  if (recent) {
    fields.unshift({ name: 'Latest', value: `${'★'.repeat(newest.rating || 0)} from **${newest.authorAttribution?.displayName || 'Google user'}**\n${(newest.text?.text || '').slice(0, 300)}${(newest.text?.text || '').length > 300 ? '…' : ''}` });
  }
  const id = String(env.DISCORD_MENTION_USER_ID || '').trim();
  const mention = /^\d{15,25}$/.test(id) ? { content: `<@${id}> New Google review`, allowed_mentions: { users: [id] } } : {};
  const url = (recent && newest.googleMapsUri) || p.googleMapsLinks?.reviewsUri || p.googleMapsUri;

  await fetch(env.DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...mention, embeds: [{
      title: `⭐ ${added} new Google review${added === 1 ? '' : 's'}`,
      url,
      description: 'Reply on Google: it helps your ranking and future customers see it.',
      color: 0xfbbc04,
      fields,
      timestamp: new Date().toISOString(),
    }] }),
  }).catch(e => console.error('Google review Discord post failed', e));
}
