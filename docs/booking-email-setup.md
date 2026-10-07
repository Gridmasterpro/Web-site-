# Booking e-mails — full setup guide

This guide covers the three mails/files around every booking:

1. **Booking notification → your company inbox** (always wanted).
2. **Thank-you confirmation → the customer**, sent from your company with the
   **official booking receipt attached as a branded PDF** (needs Path B).
3. **PDF receipt download** in the customer's browser (works everywhere, no
   setup at all).

> One-time note for the repository layout: file paths changed when the repo
> was reorganised. The booking engine now lives in `frontend/lib/`, the mail
> senders in `backend/`, and the shared PDF receipt builder in `shared/`.

---

## What happens on every booking

The booking engine (`frontend/lib/bookingMail.js`) tries the relays in order
and reports **exactly** what happened — no guessing:

1. **The site's own relay** — `/api/booking` (Vercel) or
   `/.netlify/functions/booking` (Netlify). Same-origin, no activation, no CORS,
   no ad-blocker surface. Sends through *your* mail provider, and also sends
   the **customer confirmation mail with the PDF receipt attached** when the
   provider supports it (all recommended providers do).
2. **FormSubmit** — first as `multipart/form-data` (no CORS preflight), then as
   JSON. The JSON answer is parsed: `success:true` is a real delivery,
   `"needs Activation"` is reported as such instead of being called a success.
   (This relay can only reach your inbox — it cannot mail the customer.)
3. **No relay reachable** — the booking is **saved on the device**
   (`localStorage`) and re-sent automatically on the next visit, when the
   connection returns, or with the **Retry automatic send** button on the
   confirmation screen. The screen also offers:
   * **Send this booking by e-mail** — opens the visitor's own mail app with the
     whole booking pre-filled and addressed to `contactgridmaster@gmail.com`;
   * **WhatsApp / Call** — pre-filled with the reference, date and slot.

Nothing is ever reported as "sent" unless a relay confirmed it.

### 📄 The PDF receipt

* On the confirmation screen the customer can **Download Official Receipt
  (PDF)** — a branded A4 receipt with their reference, contact details, the
  scheduled site-visit date/time, the lead engineer, and any selected
  equipment package. It is generated on the fly in the browser by
  `shared/bookingPdf.mjs` — no downloads library, works offline.
* When Path B below is configured, the **same renderer** produces the copy
  attached to the customer's thank-you mail, so the two always match.

### ✉️ The customer confirmation mail

With a working provider (Path B) the customer immediately receives a mail
**from your company** titled

> *Thank you {name} — Booking Confirmed [GM-SR-123456] — site visit on {date}*

It states which team member visits, the date and time slot, the property
address, what to keep ready, what happens next — and attaches the PDF receipt.
The confirmation screen tells the customer the mail is on its way.

Free kill switch: set `CUSTOMER_CONFIRMATION_EMAIL=off` and redeploy.

---

## ✅ Finish the setup (choose one path)

### Path A — 30 seconds, free: activate FormSubmit (do this even if you also do B)

1. Open the live site and submit **one** test booking (any details will do).
2. Open `contactgridmaster@gmail.com` and search for the mail from **formsubmit.co** —
   subject **"Activate Form"**. Check **Spam / Promotions** as well.
3. Click the activation link in that mail once.
4. Submit another test booking. The confirmation screen now shows
   **"Solar Booking Submitted Successfully!"** and the mail arrives.

> The activation is tied to that exact address. If `COMPANY_INFO.email` is ever
> changed in `frontend/data/solarData.js`, the new address needs its own activation.
>
> FormSubmit can only mail **you** — the customer confirmation + PDF (Path B)
> cannot work through it.

### Path B — permanent: send from your own mail account (recommended)

Add the mail-provider variables on your host and every booking is sent from that
provider — there is no activation link at all. This is also what unlocks the
**customer thank-you mail with the PDF receipt**.

**Brevo (recommended, free 300 mails/day, works with your Gmail as sender)**

1. Create a free account at <https://brevo.com>.
2. Verify your sender (one-time, so customer mails show your brand, not
   "via brevo.com"):
   **Senders, Domains & Dedicated IPs → Senders → Add a sender** → use your
   Gmail address (e.g. `contactgridmaster@gmail.com`) and click the
   verification link Brevo e-mails to it.
3. Copy an API key: **SMTP & API → API Keys → Generate a new API key**.
4. Vercel → your project → **Settings → Environment Variables** → add:
   * `BREVO_API_KEY` = the key you just created
   * `MAIL_FROM` = `Grid Master Solar Systems <contactgridmaster@gmail.com>`
     (the address must be the verified sender from step 2)
   * `MAIL_TO` = `contactgridmaster@gmail.com` (where booking notifications go)
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the function picks the variables up.
6. Submit a test booking **with your own e-mail as the customer address**:
   * your inbox gets the booking notification (from the `brevo` relay), and
   * the customer address gets the thank-you mail **with the PDF receipt
     attached** — check Spam the first time and mark it "Not spam".

**Alternatives** (also cancel-capable of customer confirmations):

* **Resend** — free 100 mails/day. The default `onboarding@resend.dev` sender
  can only mail *your own* inbox; to reach customers you must add and verify a
  domain you own in Resend first. Set `RESEND_API_KEY` + `MAIL_FROM`.
* **SendGrid** — free 100 mails/day; verify a single sender under *Settings →
  Sender Authentication*. Set `SENDGRID_API_KEY` + `MAIL_FROM`.
* **Web3Forms** — `WEB3FORMS_KEY`: mails bookings to your inbox with zero
  sender setup, but **cannot** e-mail the customer (no confirmation, no PDF).
* **Any webhook** — `MAIL_WEBHOOK_URL`: receives the booking + rendered mail +
  base64 PDF so you can forward it any way you like.

All variables are documented inline in [`.env.example`](../.env.example).

> Sanity check any time: open `/api/booking` on the deployed site. It answers
> `{"success":false,"configured":false,...}` (HTTP 501) when no provider is set,
> and `405` when the variables are live — that is the healthy answer for a GET.

### Path C — no third party at all

If you would rather not use a mail API, point `MAIL_WEBHOOK_URL` at a Google Apps
Script bound to your Gmail account: it can send the mail *and* append every
booking to a Google Sheet that you own.

---

## 📬 Recovering bookings that were lost before the relay fix

FormSubmit keeps every submission it received for **30 days**, even the ones it
did not deliver, and exposes them through a free archive API (5 calls/day):

1. Activate the form first (Path A).
2. Call (replace the address with yours):

   ```bash
   curl "https://formsubmit.co/api/get-submissions/YOUR_API_KEY/contactgridmaster@gmail.com"
   ```

   The API key is e-mailed to you when the form is activated. Each entry carries
   the full field list, so every missed booking can be recovered by hand.

Also worth checking while you are in Gmail: **Spam**, **Promotions**, and the
*All Mail* tab for anything from `formsubmit.co`, and consider adding a filter so
that sender always lands in the inbox.

---

## Troubleshooting the customer confirmation

The `/api/booking` answer carries a `customerMail` object so you can see
exactly what happened (visible in the browser's Network tab after a booking):

| `customerMail.status` | Meaning | Fix |
| --------------------- | ------- | --- |
| `sent` | Thank-you mail + PDF were handed to the provider | Nothing — check Spam on the customer side |
| `failed` | The provider refused it (e.g. sender not verified) | Finish the sender verification for your provider (Path B, step 2) |
| `unsupported` | Web3Forms is configured | It cannot mail customers — switch to Brevo/Resend/SendGrid |
| `disabled` | `CUSTOMER_CONFIRMATION_EMAIL=off` | Remove the variable or set `on` |
| `skipped` | No usable customer e-mail on the booking | The form already requires a valid e-mail |

The booking notification to you is **never** blocked by a confirmation failure.

---

## Verifying everything locally

```bash
npm install
npm run dev          # http://localhost:3000  → Book Now → submit a test booking
npm test             # booking-mail engine + PDF + confirmation unit tests
npm run build
```

The confirmation screen always states which relay answered, and the
**Show delivery details** link lists every attempt (`company relay`, `formsubmit
(multipart)`, `formsubmit (json)`) with its HTTP status and the relay's own
message — that is the fastest way to see what your network is doing.
