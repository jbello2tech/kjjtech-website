# KJJ Tech — Review Approval Worker

Cloudflare Worker that receives review submissions from the `leave-review.html` Formspree form, stores them in D1, pings a Discord webhook with Approve/Deny links, and — on approve — auto-commits a new `<div class="testimonial">` into `index.html` on `main` (GitHub Pages redeploys in ~60s).

## Architecture

```
customer → leave-review.html → Formspree ──(webhook)──► Worker /submit
                                                              │
                                                              ▼
                                              D1 (reviews, status='pending')
                                                              │
                                                              ▼
                                              Discord webhook (approve/deny links)
                                                              │
                                          ┌───────────────────┴──────────────────┐
                                          ▼                                      ▼
                              /review/:id/approve                      /review/:id/deny
                                          │                                      │
                              GitHub PUT /contents/index.html    D1 update status='denied'
                                          │
                                  Pages redeploy ~60s
```

## One-time deploy

Run from `worker/` directory.

### 1. Install + login

```bash
npm install
npx wrangler login
```

### 2. Create the D1 database

```bash
npm run db:create
```

Copy the `database_id` from the output into `wrangler.toml` (replace `PLACEHOLDER_DB_ID`).

### 3. Run the schema

```bash
npm run db:migrate
```

### 4. Set secrets

```bash
# Discord webhook URL (Server → Integrations → Webhooks → New Webhook → Copy URL)
npx wrangler secret put DISCORD_WEBHOOK_URL

# GitHub fine-grained PAT with repo: kjjtech-website, Contents: Read/Write
# Create at: https://github.com/settings/personal-access-tokens/new
npx wrangler secret put GITHUB_TOKEN

# Random long string for signing approve/deny URLs — generate with:
#   openssl rand -base64 48
npx wrangler secret put HMAC_SECRET

# Optional: for /list debug endpoint
npx wrangler secret put ADMIN_KEY
```

### 5. First deploy (to get the workers.dev URL)

```bash
npm run deploy
```

It prints something like `https://kjjtech-reviews.<subdomain>.workers.dev`. Copy that URL into `wrangler.toml` → `WORKER_ORIGIN`, then redeploy:

```bash
npm run deploy
```

### 6. Wire up Formspree

In your Formspree dashboard for form `xreydwyb`:

- **Settings → Integrations → Webhooks** (paid plan) — add `https://<your-worker-url>/submit`.

**Free-plan alternative:** change the `action=` on `leave-review.html` to point directly at `https://<your-worker-url>/submit`, and the Worker handles email notifications via Discord itself (Formspree is no longer in the loop for reviews).

### 7. Test

Submit a review on `https://kjjtech.com/leave-review.html`. You should get a Discord message within seconds with Approve/Deny links.

## Secrets recap

| Name | Purpose |
|---|---|
| `DISCORD_WEBHOOK_URL` | Where review notifications are posted |
| `GITHUB_TOKEN` | PAT that can commit to `index.html` |
| `HMAC_SECRET` | Signs approve/deny URLs so only you can trigger them |
| `ADMIN_KEY` | Optional; required to hit `/list` |

## Useful commands

```bash
npm run dev                                    # local dev
npm run deploy                                 # push to Cloudflare
npm run logs                                   # tail live logs
npm run db:shell -- "SELECT * FROM reviews"    # query prod D1
```

## Where approved reviews go in the HTML

The Worker inserts the new `<div class="testimonial">` block immediately **before** the `<!-- REVIEWS:END -->` marker inside `<div class="testimonials__grid">` in `index.html`. Don't remove that marker.
