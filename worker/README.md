# KJJ Tech — Review Approval Worker

Cloudflare Worker that receives review submissions from the `leave-review.html` form (POSTed directly, no Formspree), stores them in D1, pings a Discord webhook with Approve/Deny/Remove links, and auto-commits approved testimonials into `index.html` on `main` (GitHub Pages redeploys in ~60s).

## Architecture

```
customer → leave-review.html ──(POST)──► reviews.kjjtech.com/submit
                                                   │
                                                   ▼
                                 D1 (reviews, status='pending')
                                                   │
                                                   ▼
                                 Discord webhook (approve / deny links)
                                                   │
                    ┌──────────────────────────────┴───────────────────────────────┐
                    ▼                              ▼                               ▼
           /review/:id/approve          /review/:id/deny               /review/:id/remove
                    │                              │                               │
      GitHub PUT index.html          D1 status='denied'      GitHub PUT index.html
         (insert block)                                           (strip block)
                    │                                               │
            Pages redeploy                                   Pages redeploy
                    │
      Discord follow-up message
       with Remove link
```

Weekly digest runs via a scheduled CCR routine that hits `/admin/digest?key=<ADMIN_KEY>` every Monday.

## Routes

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/submit` | Review submission from `leave-review.html`. Form-encoded. |
| `GET` | `/review/:id/approve?t=<hmac>` | Commit block into `index.html`, flip to `approved`. |
| `GET` | `/review/:id/deny?t=<hmac>` | Mark `denied` (never published). |
| `GET` | `/review/:id/remove?t=<hmac>` | Strip a previously-approved block from `index.html`. |
| `GET` | `/admin/digest?key=<ADMIN_KEY>` | Post a weekly digest to Discord and return JSON. |
| `GET` | `/list?key=<ADMIN_KEY>` | Debug listing of the 50 most recent rows. |
| `GET` | `/health` | Returns `kjjtech-reviews: ok`. |

## One-time deploy (first-time setup)

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

# Random long string for signing approve/deny/remove URLs:
#   openssl rand -base64 48
npx wrangler secret put HMAC_SECRET

# Used by /admin/digest and /list:
#   openssl rand -hex 32
npx wrangler secret put ADMIN_KEY
```

### 5. Deploy

```bash
npm run deploy
```

This provisions `reviews.kjjtech.com` as a Worker custom domain automatically (Cloudflare manages the DNS for kjjtech.com, so the A/AAAA records and SSL are created in one step).

### 6. Verify

```bash
curl https://reviews.kjjtech.com/health
# → kjjtech-reviews: ok
```

Submit a review on `https://kjjtech.com/leave-review.html`. You should get a Discord message within seconds with Approve/Deny links.

## Secrets recap

| Name | Purpose |
|---|---|
| `DISCORD_WEBHOOK_URL` | Where review notifications are posted. |
| `GITHUB_TOKEN` | Fine-grained PAT, Contents R/W on `jbello2tech/kjjtech-website`. |
| `HMAC_SECRET` | Signs approve/deny/remove URLs so only Discord clicks work. |
| `ADMIN_KEY` | Guards `/admin/digest` and `/list`. |

Rotate with `npx wrangler secret put <NAME>`.

## Useful commands

```bash
npm run dev                                    # local dev
npm run deploy                                 # push to Cloudflare
npm run logs                                   # tail live logs
npm run db:shell -- "SELECT * FROM reviews ORDER BY created_at DESC LIMIT 10"
```

Trigger a digest on demand:

```bash
curl 'https://reviews.kjjtech.com/admin/digest?key=<ADMIN_KEY>'
```

## How approved reviews are inserted into `index.html`

The Worker inserts the new `<div class="testimonial">` block immediately **before** the `<!-- REVIEWS:END -->` marker inside `<div class="testimonials__grid">`. Each approved block is wrapped with `<!-- review:<id> -->` / `<!-- /review:<id> -->` comment markers and carries a `data-review-id="<id>"` attribute so the removal endpoint can locate it deterministically.

Don't remove the `<!-- REVIEWS:END -->` marker or the per-review wrapper comments — they're load-bearing.

## Review lifecycle

```
submit → pending ──approve──► approved ──remove──► removed
                ──deny────► denied
```

`denied` and `removed` are terminal. To un-remove a review, you'd have to edit D1 and re-add the block by hand.
