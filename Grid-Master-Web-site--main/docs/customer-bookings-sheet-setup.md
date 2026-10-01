# Customer Bookings → Google Sheet (auto-updating "Excel" file)

This adds a **backend-only** feature: every time a visitor books a solar
consultation on your website, their details (name, phone, email, property
address, service, date/time, notes, etc.) are automatically appended as a new
row to a Google Sheet that only you can see. You open the sheet any time to
see every customer who has booked, day after day — and you can download it as
a real `.xlsx` Excel file with one click (**File → Download → Microsoft
Excel**).

**Nothing on the website itself changes.** The booking form, the booking
e-mail, the confirmation screen — all of that keeps working exactly as it did
before. This is a second, silent step the backend does in parallel; if it
ever fails for any reason, the booking still completes normally for the
customer.

No coding is required from you — just the one-time setup below (about 10
minutes), done entirely inside Google Sheets in your browser.

---

## Step 1 — Create the sheet

1. Go to <https://sheets.google.com> and click **Blank** to create a new sheet.
2. Rename it (top-left, "Untitled spreadsheet") to **Grid Master Bookings**.

## Step 2 — Paste in the logging script

1. In the sheet, click **Extensions → Apps Script**.
2. Delete anything in the editor (`Code.gs`) and paste in the entire contents
   of [`google-apps-script/BookingSheetLogger.gs`](./google-apps-script/BookingSheetLogger.gs)
   from this repo.
3. Click the **Save** icon (or `Ctrl+S` / `Cmd+S`). Name the project
   **Grid Master Booking Logger** if asked.

## Step 3 — Set a shared secret (recommended — keeps the sheet private)

This stops a stranger who somehow finds your script's web address from being
able to write junk rows into your sheet.

1. Still in the Apps Script editor, click the ⚙️ **Project Settings** icon on
   the left.
2. Scroll to **Script properties → Add script property**.
3. Property: `SHARED_SECRET`. Value: make up any long random text, e.g.
   `gm-7f2a9c14-bookings-secret` (write it down — you'll paste it into Vercel
   in Step 5).
4. Click **Save script properties**.

## Step 4 — Deploy it as a Web App

1. Back in the editor, click **Deploy → New deployment**.
2. Click the ⚙️ gear next to "Select type" and choose **Web app**.
3. Fill in:
   - Description: `Booking logger`
   - Execute as: **Me**
   - Who has access: **Anyone**
     *(this only controls who can reach the URL — your `SHARED_SECRET` from
     Step 3 is what actually protects the sheet; without that secret, the URL
     check in the script still rejects anything it doesn't trust)*
4. Click **Deploy**. Google will ask you to **Authorize access** — choose your
   own Google account and click **Advanced → Go to Grid Master Booking Logger
   (unsafe)** → **Allow**. ("Unsafe" here just means Google hasn't reviewed
   the script publicly; it's your own script, running only in your own
   account.)
5. Copy the **Web app URL** shown — it looks like:
   `https://script.google.com/macros/s/AKfycbx.../exec`

## Step 5 — Connect it to your website (Vercel)

1. Go to [vercel.com](https://vercel.com) → your Grid Master project →
   **Settings → Environment Variables**.
2. Add these two variables (Production, and Preview if you use it):
   - `GOOGLE_SHEETS_WEBHOOK_URL` = the URL you copied in Step 4
   - `GOOGLE_SHEETS_SECRET` = the exact same value you set as `SHARED_SECRET`
     in Step 3
3. **Redeploy** the project (Deployments tab → ⋯ on the latest deployment →
   **Redeploy**) so the new variables take effect.

That's it. From now on, every completed booking on the live site adds one row
to the **Bookings** tab of your Google Sheet, with columns for the booking
reference, customer name, phone, email, property address, purpose, service,
engineer, date, time slot, notes, selected equipment and total.

---

## Verifying it works

1. Open the live website and submit a test booking (any details).
2. Open your **Grid Master Bookings** Google Sheet — within a few seconds a
   new row should appear in the **Bookings** tab.
3. If it doesn't show up:
   - Re-check the `GOOGLE_SHEETS_WEBHOOK_URL` value in Vercel matches the
     deployment URL from Step 4 exactly (it must end in `/exec`, not `/dev`).
   - Make sure you redeployed the Vercel project after adding the variables.
   - In the Apps Script editor, click **Deployments → ⋯ → Manage deployments**
     and confirm the deployment is still **Active**.
   - Check **Apps Script → Executions** (left sidebar) for any failed runs and
     their error message.

## This is independent from the booking e-mail

Your existing e-mail setup (see [`booking-email-setup.md`](./booking-email-setup.md))
keeps working exactly as before — whether or not you've set up the e-mail
provider, the Google Sheet still gets every booking, because the two features
run side by side and neither can block or break the other.

## Updating later

- To change which columns are recorded, edit `COLUMNS` in
  `BookingSheetLogger.gs`, save, then **Deploy → Manage deployments → Edit →
  New version → Deploy** (editing the code alone does not update a live
  deployment).
- To rotate the secret, change the `SHARED_SECRET` script property, redeploy
  the Apps Script as a new version, and update `GOOGLE_SHEETS_SECRET` in
  Vercel to match.
