# KJJ Tech billing alerts (Cloudflare Worker)

Receives Stripe webhooks at `https://billing.kjjtech.com/stripe` and sends each alert to Discord and to email (Microsoft Graph, from `MAIL_FROM` to `NOTIFY_TO`).

| Stripe event | Alert |
|---|---|
| `checkout.session.completed` | New 5G SIM order: plan, static IP, customer, phone, shipping address (other checkouts show as "New Stripe payment") |
| `invoice.paid` (renewals only) | Renewal paid |
| `invoice.payment_failed` | Payment failed, attempt number and next retry date (pings you on Discord) |
| `customer.subscription.updated` | Went past due or unpaid, cancellation scheduled, or back to active |
| `customer.subscription.deleted` | Subscription canceled: suspend the SIM (pings you on Discord) |

## Setup

```sh
cd billing-worker
npm install
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # whsec_... from the Stripe webhook endpoint
npx wrangler secret put DISCORD_WEBHOOK_URL     # Discord channel > Edit Channel > Integrations > Webhooks
npx wrangler secret put MS_TENANT_ID            # same values as the reviews worker
npx wrangler secret put MS_CLIENT_ID
npx wrangler secret put MS_CLIENT_SECRET
npx wrangler secret put DISCORD_MENTION_USER_ID # optional: your Discord user ID
npx wrangler deploy
```

Optional: `STRIPE_READ_KEY`, a restricted Stripe key with read access to Customers. It adds names and emails to the subscription alerts, which otherwise show the customer ID linked to Stripe.

Test: `npm test` runs the alert formatting and signature checks locally. `npx wrangler tail` streams live logs.
