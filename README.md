# ☀️ Grid Master — Advanced Solar Designing, Installation & Integration System

**Grid Master** is a modern, high-performance web platform for solar systems engineering, rooftop 3D designing, equipment price cataloging, and turnkey installation & grid integration. Designed for both **Home (Residential)** and **Building (Commercial)** solar purpose requirements.

This repository is the full web application (a React + Vite + Tailwind + React Router multi-page app — every menu item opens its own page), deployable directly from the repo root to Vercel (primary) or Netlify.

> ### ⚠️ One-time Vercel setting after the 2026 reorganization
> The code used to live one folder deeper (`Grid-Master-Web-site--main/`). It now
> sits at the **repository root**. In your Vercel project open
> **Settings → General → Root Directory** and change it from
> `Grid-Master-Web-site--main` to the repository root (`.`, i.e. leave the field
> empty / `./`), then **Redeploy**. Nothing else changed about hosting:
> `vercel.json` still provides the SPA rewrite and `api/` still hosts the
> booking functions.

---

## 🗂️ Where things live (repo map)

```
Web-site-/
│
├── 🌐 frontend/                  ← THE WEBSITE (everything the visitor's browser runs)
│   ├── main.jsx, App.jsx         →  app entry, routing, shared booking state
│   ├── index.css                 →  Tailwind + 3D flip-card + utilities
│   ├── pages/                    →  one file per URL (HomePage, ServicesPage, …)
│   ├── components/               →  Navbar, Hero, BookingModal, SolarCalculator, …
│   ├── data/solarData.js         →  EDIT ME: prices, company info, team, FAQs
│   └── lib/
│       ├── bookingMail.js        →  booking delivery engine (relay ladder, retry queue)
│       └── downloadPdf.js        →  hands the browser the PDF receipt
│
├── ⚙️ backend/                   ← THE SERVER SIDE (runs inside serverless functions)
│   ├── handleBooking.mjs         →  POST /api/booking handler: validation, throttling
│   ├── mailProvider.mjs          →  Brevo / Resend / SendGrid / Web3Forms / webhook
│   ├── confirmationMail.mjs      →  customer thank-you mail + PDF attachment
│   ├── sheetLogger.mjs           →  appends every booking to your Google Sheet
│   └── bookingHealth.mjs         →  read-only self-diagnosis endpoint
│
├── 🔗 shared/                    ← code used by BOTH sides (no browser, no Node APIs)
│   ├── bookingPdf.mjs            →  branded booking-receipt PDF generator (zero deps)
│   └── receiptModel.mjs          →  normalises a booking for the PDF
│
├── 🚢 api/                       ← VERCEL deploy glue (thin wrappers around backend/)
│   ├── booking.js                →  POST /api/booking
│   └── booking-health.js         →  GET  /api/booking-health
├── 🚢 netlify/functions/         ← NETLIFY deploy glue (same wrappers, kept as option)
│
├── 📚 docs/                      ← click-by-click setup guides
│   ├── booking-email-setup.md    →  mail relay + customer confirmation (Brevo)
│   ├── customer-bookings-sheet-setup.md → Google Sheet logger
│   └── google-apps-script/       →  the Apps Script to paste for the sheet
│
├── 🧪 tests/                     ← automated tests (node:test, 96 tests)
├── 🛠️ scripts/                   ← dev helpers (run.bat for Windows, svg maker)
├── public/                       ← static files copied into the build as-is
│
├── index.html                    ← the single HTML page everything renders into
├── package.json                  ← dependencies & npm scripts
├── vite.config.js                ← build config (Vite 5)
├── tailwind.config.js            ← styling config (scans frontend/)
├── postcss.config.js             ← CSS post-processing
├── vercel.json                   ← Vercel: SPA rewrite
├── netlify.toml                  ← Netlify: build + functions + redirects
├── .env.example                  →  🔑 API KEYS TEMPLATE — the only place keys are
│                                    configured (copy values into the Vercel
│                                    dashboard, never into git)
└── .gitignore                    →  node_modules, dist, .env, logs
```

**In a hurry?** Prices/text → `frontend/data/solarData.js`. Booking form →
`frontend/components/BookingModal.jsx`. Booking e-mail → `backend/`. Receipt
look → `shared/bookingPdf.mjs`. API keys → Vercel dashboard (template:
`.env.example`). Setup guides → `docs/`.

---

## 🧭 Site Pages

| URL | Page |
| --- | --- |
| `/` | Home — hero, stats, service highlights, process, reviews, call-to-action |
| `/services` | Services (Home / Building) |
| `/design-samples` | Design Samples & CAD blueprints |
| `/equipment` | Equipment & Prices with quote builder |
| `/calculator` | Solar system calculator |
| `/team` | Engineering team + Head Engineer visiting card |
| `/contact` | Contact details, booking and FAQ |

Menu links open real pages (no fast in-page scrolling); each page opens at the top with a soft fade-in.
Because these are real URLs the host must serve `index.html` for unknown paths — already configured for
Vercel (`vercel.json`) and Netlify (`netlify.toml`, `public/_redirects`). For a local static server use `npm run build && npx serve -s dist`.

---

## 🚀 Key Features

### 1. 🏠 Dual Scope: Home vs Building
- **Home / Residential Solar**: 5 kW to 20 kW hybrid setups, 100% electricity bill offsets, silent lithium battery backup banks.
- **Building / Commercial**: 50 kW to 2+ MW commercial rooftop BIPV, high-voltage transformer hooks, ballasted racking, peak demand shaving.

### 2. 🧮 Interactive System Sizing Calculator
- Select purpose (**Home** or **Building**), slide to your rooftop area (sq ft) and monthly electricity bill.
- Capacity is sized from the bill **and capped by usable roof area** (with a clear note when the roof is the limiting factor).
- Instant results: monthly generation, monthly savings, payback period, 25-year net savings, and an itemized cost breakdown.
- One-click booking that carries the calculated design into the booking form.

### 3. 🛒 Hardware Catalog with Transparent Pricing + Quote Builder
- Component store with prices for panels, hybrid inverters, LiFePO4 batteries, and racking.
- Category filtering + live search.
- **Quote builder**: add equipment, adjust quantities with +/− steppers, see the live package total, then book installation with the exact package attached to the booking email and PDF receipt.

### 4. 📅 Online Booking Engine
- Purpose (Home/Building), service type, preferred lead engineer, date (no past dates), time slot, contact & property details.
- Delivers to `contactgridmaster@gmail.com` through relays tried in order — the site's own mail relay first, then FormSubmit — so a single blocked or un-activated relay cannot lose a booking.
- **Honest status handling**: the confirmation screen only says "submitted successfully" when a relay confirmed it; otherwise it says the booking is saved and offers one-click retry, a pre-filled e-mail, WhatsApp and phone.
- A booking that could not be sent is stored on the device and re-sent automatically later (next visit / back online).
- **📄 Official PDF receipt**: one click downloads a branded A4 receipt (reference, contact details, site-visit date & slot, lead engineer, equipment package) — generated in the browser with zero dependencies.
- **✉️ Instant customer confirmation**: when the own-relay is configured, the customer is automatically e-mailed a thank-you **from the company** stating which team member visits on which date and time slot, **with the same PDF receipt attached**.
- **Copy Reference & Receipt** button for pasting into WhatsApp or mail.

> **Setup for booking e-mails + customer confirmations**: [`docs/booking-email-setup.md`](docs/booking-email-setup.md)
> — the recommended, free Brevo path takes ~10 minutes and covers both mail directions.
>
> **Want every booking as a spreadsheet row too?**
> See [`docs/customer-bookings-sheet-setup.md`](docs/customer-bookings-sheet-setup.md).

### 5. 📐 Designing Samples & CAD Blueprint Viewer
- Residential and commercial case-study portfolio with filters.
- **Inspect CAD Blueprint modal**: technical spec tables, generation & CO₂ metrics, and engineering sign-off by **GANDHAMANENI GOUTHAM** and **Ashish Kumar**.

### 6. 💳 Interactive 3D Digital Visiting Card
- Flippable 3D card for Head Engineer **GANDHAMANENI GOUTHAM**.
- **Real scannable QR code** (opens a direct call to the Head Engineer).
- **Save vCard (.vcf)** button, copy contact details, credential badges.

### 7. 👨‍🔬 Engineering Roster, Testimonials & FAQ
- Team roster featuring **GANDHAMANENI GOUTHAM** (Head Engineer) and **Ashish Kumar** (Solar Designer Engineer), plus a "Grid Master Standard" guarantees card, client reviews and an FAQ accordion.

### 8. 💬 Floating WhatsApp Button
- Always-visible WhatsApp contact button (bottom-right) that opens a chat with the Head Engineer's number (+91 7200745180) with a pre-filled message. Also used as a fallback when email delivery can't be confirmed.

---

## 💻 Tech Stack

- **Frontend**: React 18
- **Build Tool**: Vite 5
- **Styling**: Tailwind CSS 3 (+ `tailwindcss-animate` for modal transitions)
- **Icons**: Lucide React
- **QR**: qrcode.react
- **Typography**: Inter & Fira Code (Google Fonts)
- **PDF receipts**: hand-rolled, dependency-free generator in `shared/` (no 300 KB library in the bundle)
- **Deployment**: Vercel (primary) / Netlify ready

---

## 🛠️ Getting Started

### Prerequisites
[Node.js](https://nodejs.org/) v18 or higher.

```bash
npm install
npm run dev        # → http://localhost:3000
npm run build      # production build in dist/
```

On Windows you can also double-click `scripts/run.bat`.

### ⚠️ Important: booking e-mails need a one-time setup
Out of the box the site tries your own relay and then FormSubmit. **Before the first real booking can arrive**, either:

- **Path A (30 s)** — activate FormSubmit once from the `contactgridmaster@gmail.com` inbox, **or**
- **Path B (~10 min, recommended)** — set `BREVO_API_KEY` + `MAIL_FROM` + `MAIL_TO` on Vercel. This also unlocks the **customer thank-you mail with the PDF receipt attached**.

Full click-by-click guide: [`docs/booking-email-setup.md`](docs/booking-email-setup.md).

---

## 💰 Pricing / Currency (Dual: ₹ primary, $ secondary)

Prices show **₹ (primary) with an ≈ $ equivalent** across the catalog, quote builder,
calculator and booking receipts — all driven by one config in
[`frontend/data/solarData.js`](./frontend/data/solarData.js):

```js
export const CURRENCY = {
  rate: 85, // ₹ per 1 USD (reference conversion)
  formatINR / formatUSD / inrFromUSD / usdFromINR
};
export const SOLAR_ASSUMPTIONS = { tariffPerKwhInr: 10, ... }; // calculator (INR-based)
```

- **Change the reference rate**: edit `CURRENCY.rate`.
- **Change an equipment price**: edit `priceINR` on the item in `EQUIPMENT_CATALOG` (`pricePerUnit` is the USD reference used for the ≈ $ display).
- **Change calculator assumptions** (tariff, cost per kW, battery cost): edit `SOLAR_ASSUMPTIONS`.

> The ≈ $ values are conversions at the reference rate — if you want exact fixed USD prices
> next to the ₹ prices, set them manually per item. (On PDF receipts ₹ is printed as
> "Rs." — classic PDF fonts have no ₹ glyph.)

---

## 👤 Contacts & Leadership

- **Company**: Grid Master Solar Systems
- **Head Engineer**: GANDHAMANENI GOUTHAM (Solar Designing Engineer & Electrical Engineer)
  - 📞 `+91 72007 45180`
  - ✉️ `goutham4518@gmail.com`
- **Solar Designer Engineer**: Ashish Kumar — `snazzy5566@gmail.com`
- **Headquarters**: Solar Tech Park, Suite 402, Clean Energy Corridor, Hyderabad

> Note: `contactgridmaster@gmail.com` is the booking receipt inbox configured in `COMPANY_INFO` — update it in `frontend/data/solarData.js` if you move to a company domain.
> Changing it also invalidates the FormSubmit activation for the old address, so re-run the
> one-time activation in [`docs/booking-email-setup.md`](docs/booking-email-setup.md), or set
> `MAIL_TO` to the new inbox with a mail provider configured.

---

## 🧪 Tests

```bash
npm test        # 96 tests: delivery engine, server relay, PDF, confirmation mail, jsdom flows
npm run verify  # tests + production build
```

- `tests/bookingMail.test.mjs` — relay order, multipart-before-JSON transport, FormSubmit's
  activation/error answers, retry queue behaviour.
- `tests/serverRelay.test.mjs` — provider detection, mail rendering/escaping, handler
  validation, throttling, 501 fallback.
- `tests/confirmationMail.test.mjs` — the customer thank-you mail: visit details,
  provider attachment shapes (Brevo/Resend/SendGrid), Web3Forms skip, kill switch,
  and that a confirmation failure never breaks the booking.
- `tests/bookingPdf.test.mjs` — PDF structure/xref validity, ₹ → Rs. sanitisation,
  model mapping, determinism, pagination.
- `tests/apiAdapters.test.mjs` — the Vercel and Netlify entry points.
- `tests/sheetLogger.test.mjs` — Google Sheet logging + health checks.
- `tests/dom/bookingFlow.test.mjs` — drives the real app in jsdom: opens the booking form,
  submits it, and asserts what goes on the wire and what the customer is told (including that
  a blocked or un-activated relay is **never** reported as a successful delivery).

---

© 2026 Grid Master Solar Systems. All rights reserved.
