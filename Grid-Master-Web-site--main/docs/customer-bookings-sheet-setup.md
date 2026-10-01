# Customer Bookings → Google Sheet (auto-updating "Excel" file)

Every time a visitor books a solar consultation on your website, their details
(name, phone, email, **property address**, service, date/time, notes, equipment
package, etc.) are automatically appended as a new row to a Google Sheet that
only you can see. Open the sheet any time to see every customer who has booked,
day after day — and download it as a real `.xlsx` Excel file with one click
(**File → Download → Microsoft Excel**).

**Nothing on the website itself changes.** The booking form, the booking e-mail,
the confirmation screen — all of that keeps working exactly as it did before.
This is a second, silent step the backend does in parallel; if it ever fails for
any reason, the booking still completes normally for the customer.

---

## 🩺 Already set this up and rows are NOT appearing?

**Skip the setup and open this URL in your browser:**

```
https://web-site-self-eta.vercel.app/api/booking-health?selftest=1
```

It runs a live test from your website's backend to your Apps Script and tells
you, in plain English, exactly what is wrong and what to click. It writes
nothing to your sheet. Jump to [Troubleshooting](#-troubleshooting) and find
the `verdict.status` it reported.

---

## Step 1 — Create the sheet

1. Go to <https://sheets.google.com> and click **Blank**.
2. Rename it (top-left, "Untitled spreadsheet") to **Grid Master Bookings**.

> ⚠️ The script **must** be created from inside this sheet (next step). A
> standalone script made at script.google.com has no spreadsheet attached and
> will fail with *"This script is not bound to a spreadsheet."*

## Step 2 — Paste in the logging script

1. In the sheet, click **Extensions → Apps Script**.
2. Delete everything in the editor (`Code.gs`) and paste in the **entire**
   contents of
   [`google-apps-script/BookingSheetLogger.gs`](./google-apps-script/BookingSheetLogger.gs).
3. Click the **Save** icon (`Ctrl+S` / `Cmd+S`). Name the project
   **Grid Master Booking Logger** if asked.

## Step 3 — Set the shared secret

This stops a stranger who finds your script's web address from writing junk
rows into your sheet.

1. In the Apps Script editor, click the **⚙️ Project Settings** (left sidebar).
2. Scroll to **Script Properties** → **Add script property**.
3. Property: `SHARED_SECRET`
   Value: any long random text, e.g. `gm-solar-7f3k9qzx2m`
4. Click **Save script properties**.

> 📋 **Copy that value somewhere** — you must paste the *identical* text into
> Vercel in Step 6. One extra space or a missing character and every booking is
> silently rejected. This is by far the most common cause of "nothing appears in
> the sheet".

## Step 4 — Run the one-time setup function

1. Back in the **Editor** (`< >` icon), pick **`setupBookingSheet`** from the
   function dropdown at the top.
2. Click **▶ Run**.
3. Google asks for permission the first time: **Review permissions** → choose
   your account → **Advanced** → **Go to Grid Master Booking Logger (unsafe)**
   → **Allow**. (It says "unsafe" for every personal script; it is your own
   code and it only touches this one sheet.)
4. Check the **Execution log** at the bottom. You should see
   `Sheet ready…`, `SHARED_SECRET configured: yes`, and a
   **Secret fingerprint** like `3f7a1c92` — note it down.
5. Your sheet now has a **Bookings** tab with bold headers.

## Step 5 — Deploy it as a Web App

1. Top-right: **Deploy → New deployment**.
2. Click the **⚙️ gear** next to "Select type" → choose **Web app**.
3. Fill in:
   - **Description**: `Booking logger`
   - **Execute as**: **Me (your@gmail.com)**
   - **Who has access**: **Anyone** ← ⚠️ **must be "Anyone"**, *not*
     "Anyone with Google Account". With the wrong choice Google returns a
     sign-in page to your website and no row is ever written.
4. Click **Deploy**, then **Copy** the **Web app URL**.
   It must look like:
   `https://script.google.com/macros/s/AKfyc…/exec` — **ending in `/exec`**.
   (A URL ending in `/dev` is the private test URL and will never work.)

## Step 6 — Add the two values to Vercel

1. <https://vercel.com> → your project → **Settings → Environment Variables**.
2. Add both, ticking **Production**, **Preview** *and* **Development**:

   | Name | Value |
   | --- | --- |
   | `GOOGLE_SHEETS_WEBHOOK_URL` | the `/exec` URL from Step 5 |
   | `GOOGLE_SHEETS_SECRET` | the exact `SHARED_SECRET` text from Step 3 |

3. **Save.**

## Step 7 — Redeploy (this step is mandatory)

Environment variables only reach a **new** deployment. Existing ones keep
running with the old, empty values.

1. Vercel → your project → **Deployments**.
2. On the newest deployment click the **⋯** menu → **Redeploy** → **Redeploy**.
3. Wait for it to turn **Ready**.

## Step 8 — Verify

Open:

```
https://web-site-self-eta.vercel.app/api/booking-health?selftest=1
```

You want:

```json
"verdict": {
  "status": "healthy",
  "headline": "The backend reached your Apps Script and it accepted the request."
}
```

Also confirm the two fingerprints are identical:

- `configuration.sheetLogging.GOOGLE_SHEETS_SECRET.fingerprint` (from Vercel)
- `selftest.script.secretFingerprint` (from Apps Script)

If they match, submit a real test booking on the website — a row appears in the
**Bookings** tab within about a second.

---

## 🔧 Troubleshooting

Open `/api/booking-health?selftest=1` and match the `verdict.status`:

### `not-configured`
`GOOGLE_SHEETS_WEBHOOK_URL` is not reaching the running site.
→ You either never saved it in Vercel, saved it only for *Preview*, or **did not
redeploy**. Do Step 6 and **Step 7**.

### `bad-url`
Read `problems`. Usually one of:
- URL ends in **`/dev`** → redeploy and copy the **`/exec`** URL (Step 5).
- URL ends in `/edit` → you copied the *spreadsheet* address, not the Apps
  Script **Web app URL**.
- URL has a trailing space or line break → re-paste it.

### `broken` with *"Invalid secret."*
Vercel and Apps Script hold different secrets. Compare:
- `configuration.sheetLogging.GOOGLE_SHEETS_SECRET.fingerprint`
- `selftest.script.secretFingerprint`

Different → re-copy the exact value into both places (Step 3 and Step 6), then
**redeploy** (Step 7). Watch for trailing spaces and smart quotes.

### `broken` with *"sign-in page instead of running the script"*
The deployment's access level is wrong.
→ Apps Script → **Deploy → Manage deployments** → **✏️ pencil** →
**Who has access: Anyone** → **Deploy**. Copy the new `/exec` URL into Vercel
and redeploy.

### `broken` with *"not bound to a spreadsheet"*
The script was created standalone. Delete it, open your Google Sheet, and use
**Extensions → Apps Script** instead (Step 2).

### `healthy` but rows still do not appear
You are probably looking at a different spreadsheet. The self-test reports
`selftest.script.spreadsheetName` and `sheetName` — open that exact file and
check the **Bookings** tab.

### Still stuck
In the Apps Script editor click **Executions** (left sidebar). Every call from
your website appears there with its status and error.

---

## How it works (for reference)

```
Visitor books on the website
          │
          ▼
POST /api/booking            ← Vercel serverless function (backend only)
          │
          ├─► Google Apps Script  ──►  appends a row to your Bookings sheet
          │
          └─► mail provider / FormSubmit  ──►  booking e-mail (unchanged)
```

- Sheet logging runs **in parallel** with the e-mail and **cannot** change the
  response the website receives. If Google is down, the booking still succeeds.
- No visitor ever sees any of this — there is no new UI anywhere on the site.
- Columns written: Received At, Booking Reference, Customer Name, Phone, Email,
  **Property Address**, Purpose, Service Required, Lead Engineer, Scheduled
  Audit Date, Time Slot, Special Notes, Selected Equipment, Equipment Package
  Total, Source IP.

### Turning it off
Delete `GOOGLE_SHEETS_WEBHOOK_URL` in Vercel and redeploy. The logger becomes a
silent no-op; everything else is unaffected.
