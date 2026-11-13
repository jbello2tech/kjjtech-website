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
