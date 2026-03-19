# ShieldSmart Newsletter — XNL Tech
### Powered by Cloudflare Workers + Anthropic AI
**Partner: PromptMechanics.org**

---

## What This Is

A fully automated, AI-generated cyber safety newsletter system with:
- **Landing page** (Cloudflare Pages) — email capture & brand presence
- **Cloudflare Worker** — backend API for subscriptions + AI newsletter generation
- **Anthropic Claude** — generates the newsletter content 3x/week automatically
- **KV Storage** — stores subscribers (no database needed)
- **Mailgun** — sends emails (swappable with SendGrid, Resend, Postmark)

---

## Project Structure

```
xnl-newsletter/
├── landing-page/
│   └── index.html          ← Deploy to Cloudflare Pages
└── cloudflare-worker/
    ├── worker.js           ← The Worker (newsletter brain)
    └── wrangler.toml       ← Worker config
```

---

## STEP-BY-STEP SETUP

### Step 1 — Deploy the Landing Page

1. Go to [Cloudflare Pages](https://pages.cloudflare.com)
2. Click **Create a project → Upload assets**
3. Upload the `landing-page/index.html` file
4. Give it a name like `shieldsmart`
5. Your page will be live at `shieldsmart.pages.dev`
6. (Optional) Connect your custom domain in Pages settings

### Step 2 — Create the KV Namespace

In your terminal (with Node.js installed):

```bash
npm install -g wrangler
wrangler login
cd cloudflare-worker
npx wrangler kv:namespace create SUBSCRIBERS
```

Copy the `id` it prints and paste it into `wrangler.toml` where it says `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### Step 3 — Deploy the Worker

```bash
cd cloudflare-worker
npx wrangler deploy
```

It will give you a URL like: `https://shieldsmart-newsletter.your-subdomain.workers.dev`

### Step 4 — Set Your Secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY
# Paste your key from console.anthropic.com

npx wrangler secret put ADMIN_SECRET
# Make up a strong secret token — you'll use this to trigger sends manually

npx wrangler secret put SEND_API_KEY
# Your Mailgun API key (from mailgun.com)

npx wrangler secret put SEND_FROM
# Type: ShieldSmart <hello@xnltech.com>

npx wrangler secret put SEND_DOMAIN
# Type: xnltech.com  (must match your Mailgun verified domain)
```

### Step 5 — Connect the Landing Page to the Worker

Open `landing-page/index.html` and find this line:

```javascript
const WORKER_URL = 'https://your-worker.your-subdomain.workers.dev/subscribe';
```

Replace it with your actual Worker URL + `/subscribe`.

Re-upload the updated HTML to Cloudflare Pages.

---

## API REFERENCE

### POST /subscribe
Saves a new subscriber to KV.

**Body:**
```json
{
  "firstName": "Linda",
  "lastName": "Smith",
  "email": "linda@example.com"
}
```

**Response:**
```json
{ "success": true, "message": "Subscribed successfully!" }
```

---

### GET /generate?type=monday
Generates a newsletter issue using Anthropic.
Returns rendered HTML. Requires `X-Admin-Secret` header.

**Types:** `monday` | `wednesday` | `friday`

**Example:**
```bash
curl -H "X-Admin-Secret: YOUR_SECRET" \
  "https://your-worker.workers.dev/generate?type=friday"
```

---

### GET /subscribers
Lists all subscribers. Requires `X-Admin-Secret` header.

```bash
curl -H "X-Admin-Secret: YOUR_SECRET" \
  "https://your-worker.workers.dev/subscribers"
```

---

### POST /send?type=wednesday
Generates and sends the newsletter to ALL active subscribers.
Requires `X-Admin-Secret` header.

```bash
curl -X POST -H "X-Admin-Secret: YOUR_SECRET" \
  "https://your-worker.workers.dev/send?type=wednesday"
```

---

## AUTOMATIC SCHEDULE

The Worker fires automatically via Cloudflare Cron Triggers:

| Day | Time (UTC) | Issue Type |
|-----|-----------|------------|
| Monday | 9:00 AM | Threat Radar |
| Wednesday | 9:00 AM | Safety Skill |
| Friday | 9:00 AM | Fix-It Help Desk |

To adjust the time, edit `wrangler.toml` cron expressions and redeploy.

---

## EMAIL PROVIDER SWAP

The `sendEmail()` function in `worker.js` uses **Mailgun** by default.

To switch to **Resend** (simpler, recommended for beginners):
1. Sign up at resend.com (free tier: 3,000 emails/month)
2. Replace the `sendEmail()` function body with:

```javascript
async function sendEmail(subscriber, htmlContent, subject, env) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.SEND_FROM || 'ShieldSmart <hello@xnltech.com>',
      to: subscriber.email,
      subject: subject,
      html: htmlContent,
    }),
  });
  if (!res.ok) throw new Error(await res.text());
}
```

3. Set `SEND_API_KEY` to your Resend API key (no `SEND_DOMAIN` needed)

---

## BRANDING

- **Newsletter name:** ShieldSmart
- **Brand:** XNL Tech
- **Partner:** PromptMechanics.org
- **Contact email:** help@xnltech.com
- **Colors:** Navy #0C1A2E | Teal #00C2A8 | Amber #F5A623 | Red #E8443A

---

## COSTS (Estimated Monthly)

| Service | Free Tier | Paid |
|---------|-----------|------|
| Cloudflare Workers | 100K requests/day free | $5/mo beyond |
| Cloudflare Pages | Unlimited free | — |
| Cloudflare KV | 100K reads/day free | — |
| Anthropic Claude | Pay per use | ~$0.05–0.15/issue |
| Resend (email) | 3,000/mo free | $20/mo for 50K |

**Estimated total for first 1,000 subscribers: ~$5–15/month**

---

*Built by XNL Tech | PromptMechanics.org*
