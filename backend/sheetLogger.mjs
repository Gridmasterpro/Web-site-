/**
 * Customer booking → Google Sheet logger.
 *
 * Purpose
 * -------
 * Every time a visitor books a solar consultation, this module hands the
 * booking to a small Google Apps Script "Web App" that the site owner deploys
 * from their own Google account (see docs/customer-bookings-sheet-setup.md).
 * That script appends one row per booking to a Google Sheet the owner can
 * open any time — download it as .xlsx and it *is* an Excel file.
 *
 * This is completely independent from the e-mail relay in `mailProvider.mjs`:
 *
 *   - It runs whether or not a mail provider (Resend/Brevo/...) is configured.
 *   - A failure here NEVER changes the booking's HTTP response, status code,
 *     or the visitor-facing outcome — the booking flow and the website are
 *     not touched by this feature at all.
 *
 * Configure ONE environment variable on the host to turn this on:
 *
 *   GOOGLE_SHEETS_WEBHOOK_URL   the Apps Script "exec" URL from the setup guide
 *   GOOGLE_SHEETS_SECRET        (recommended) a shared secret the script
 *                               checks before writing, so the public exec URL
 *                               cannot be used by strangers to fill the sheet
 *
 * Without GOOGLE_SHEETS_WEBHOOK_URL this module is a silent no-op.
 *
 * Why this file is defensive
 * --------------------------
 * A Google Apps Script web app answers HTTP 200 for almost everything,
 * including the cases where it wrote nothing at all:
 *
 *   - wrong shared secret   → 200 + {"ok":false,"error":"Invalid secret."}
 *   - deployed with access  → 302 → an HTML Google *sign-in page*, served 200
 *     "Anyone with Google
 *      Account" instead of
 *      "Anyone"
 *   - /dev URL pasted       → 302 → HTML sign-in page, served 200
 *     instead of /exec
 *
 * Treating `response.ok` as success therefore reports "logged" while the
 * sheet stays empty — the exact symptom this module now refuses to produce.
 * `interpretSheetResponse` below inspects the *body* and only calls it a
 * success when the script confirms it wrote a row.
 */

const asText = (value) => (value === undefined || value === null ? '' : String(value));

const REQUEST_TIMEOUT_MS = 10000;
const MAX_ATTEMPTS = 2;

/** Flatten a booking into the exact columns the Sheet expects, in order. */
export function bookingToRow(booking = {}, { timestamp, clientIp } = {}) {
  return {
    timestamp: timestamp || new Date().toISOString(),
    booking_reference: asText(booking.booking_reference),
    customer_name: asText(booking.customer_name),
    customer_phone: asText(booking.customer_phone),
    customer_email: asText(booking.customer_email || booking.email),
    property_location: asText(booking.property_location),
    purpose: asText(booking.purpose),
    service_required: asText(booking.service_required),
    lead_engineer: asText(booking.lead_engineer),
    scheduled_date: asText(booking.scheduled_date),
    time_slot: asText(booking.time_slot),
    notes: asText(booking.notes),
    selected_equipment: asText(booking.selected_equipment),
    equipment_package_total: asText(booking.equipment_package_total),
    source_ip: asText(clientIp),
  };
}

/** Is the Google Sheet logger configured on this host? */
export function sheetLoggingConfigured(env = {}) {
  return Boolean(asText(env.GOOGLE_SHEETS_WEBHOOK_URL).trim());
}

/* ------------------------------------------------------------------ *
 * Secret fingerprinting
 *
 * The health endpoint and the Apps Script both publish a fingerprint of the
 * secret they hold. Comparing the two proves whether they match WITHOUT ever
 * putting the secret itself in an HTTP response, a log line or a screenshot.
 * FNV-1a (32-bit) is used because it is four lines of dependency-free code
 * that behaves identically in Node and in Apps Script.
 * ------------------------------------------------------------------ */

export function fingerprint(value) {
  const text = asText(value);
  if (!text) return 'none';
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ *
 * Webhook URL validation
 * ------------------------------------------------------------------ */

/**
 * Inspect the configured webhook URL and report anything that is known to
 * stop rows from reaching the sheet. Returns `{ ok, problems: [], warnings: [] }`.
 */
export function inspectWebhookUrl(rawUrl) {
  const url = asText(rawUrl).trim();
  const problems = [];
  const warnings = [];

  if (!url) {
    problems.push('GOOGLE_SHEETS_WEBHOOK_URL is empty or not set on this host.');
    return { ok: false, url, problems, warnings, scriptId: null };
  }

  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    problems.push('GOOGLE_SHEETS_WEBHOOK_URL is not a valid URL.');
    return { ok: false, url, problems, warnings, scriptId: null };
  }

  if (parsed.protocol !== 'https:') {
    problems.push('The webhook URL must start with https://');
  }
  if (!/(^|\.)google\.com$/.test(parsed.hostname)) {
    warnings.push(`The webhook host is ${parsed.hostname}, not script.google.com — double-check you pasted the Apps Script URL.`);
  }
  if (parsed.pathname.endsWith('/dev')) {
    problems.push(
      'The URL ends in /dev. That is the private "test" URL and it only works while you are signed in — ' +
        'redeploy and copy the /exec URL instead.'
    );
  } else if (!parsed.pathname.endsWith('/exec')) {
    problems.push('The URL does not end in /exec — copy the "Web app" URL shown after you click Deploy.');
  }
  if (/\s/.test(url)) {
    problems.push('The URL contains a space — it was probably pasted with a line break or a trailing blank.');
  }

  const match = parsed.pathname.match(/\/macros\/s\/([^/]+)\//);
  const scriptId = match ? match[1] : null;

  return { ok: problems.length === 0, url, problems, warnings, scriptId };
}

/** A safe-to-display version of the webhook URL (never the full deployment id). */
export function redactWebhookUrl(rawUrl) {
  const url = asText(rawUrl).trim();
  if (!url) return null;
  const { scriptId } = inspectWebhookUrl(url);
  if (!scriptId) return `${url.slice(0, 40)}…`;
  return `https://script.google.com/macros/s/${scriptId.slice(0, 6)}…${scriptId.slice(-4)}/exec`;
}

/* ------------------------------------------------------------------ *
 * Response interpretation
 * ------------------------------------------------------------------ */

function safeJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const looksLikeHtml = (raw) => /^\s*(<!doctype html|<html|<\?xml)/i.test(asText(raw));

/**
 * Decide, honestly, whether the Apps Script actually wrote the row.
 *
 * @returns {{ok: boolean, reason?: string, hint?: string, data?: object}}
 */
export function interpretSheetResponse(status, rawBody) {
  const raw = asText(rawBody);

  if (looksLikeHtml(raw)) {
    const signIn = /sign in|accounts\.google\.com|ServiceLogin|Google Account/i.test(raw);
    return {
      ok: false,
      reason: signIn
        ? 'Google answered with a sign-in page instead of running the script.'
        : 'Google answered with an HTML page instead of the script\'s JSON reply.',
      hint:
        'In the Apps Script editor open Deploy → Manage deployments → edit (pencil) and set ' +
        '"Who has access" to **Anyone** (not "Anyone with Google Account"), then Deploy again ' +
        'and copy the new /exec URL.',
    };
  }

  const data = safeJson(raw);

  if (data && data.ok === false) {
    const error = asText(data.error) || 'The Apps Script refused the request.';
    const secretProblem = /secret/i.test(error);
    return {
      ok: false,
      reason: error,
      hint: secretProblem
        ? 'GOOGLE_SHEETS_SECRET in Vercel does not match the SHARED_SECRET script property in Apps Script. ' +
          'Compare the two fingerprints shown by /api/booking-health?selftest=1.'
        : 'Open the Apps Script editor → Executions to see the failing run.',
      data,
    };
  }

  if (status >= 400) {
    return {
      ok: false,
      reason: `The Apps Script URL answered HTTP ${status}.`,
      hint:
        status === 404
          ? 'That deployment no longer exists. Deploy → Manage deployments → New deployment, then update GOOGLE_SHEETS_WEBHOOK_URL.'
          : 'Check Deploy → Manage deployments in the Apps Script editor.',
      data,
    };
  }

  if (data && data.ok === true) return { ok: true, data };

  // A plain non-JSON 200 (an older version of the script, or a proxy that
  // rewrote the body). Nothing says it failed, so accept it.
  return { ok: true, data: data || null };
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

async function withTimeout(fetchImpl, url, init, ms = REQUEST_TIMEOUT_MS) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ms) : null;
  try {
    return await fetchImpl(url, { ...init, signal: controller ? controller.signal : undefined });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const describe = (error) =>
  error?.name === 'AbortError'
    ? 'The Sheet webhook did not answer in time.'
    : error?.message || String(error);

/**
 * POST a JSON payload to the Apps Script and report honestly what happened.
 * Retries once on a transport error or a 5xx, because Apps Script cold starts
 * occasionally time out.
 */
async function postToScript({ url, payload, fetchImpl, attempts = MAX_ATTEMPTS }) {
  let last = { ok: false, reason: 'No attempt was made.' };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res;
    try {
      res = await withTimeout(fetchImpl, url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
      });
    } catch (error) {
      last = { ok: false, reason: describe(error), transport: true, attempt };
      continue; // retry
    }

    const status = typeof res.status === 'number' ? res.status : 0;
    const raw = await (typeof res.text === 'function' ? res.text().catch(() => '') : Promise.resolve(''));
    const verdict = interpretSheetResponse(status, raw);

    last = { ...verdict, status, attempt, body: raw.slice(0, 500) };

    if (verdict.ok) return last;
    // A 5xx is worth one retry; a rejected secret or a sign-in page is not.
    if (status < 500) return last;
  }

  return last;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Append one booking to the owner's Google Sheet. Never throws — the caller
 * gets a structured verdict and the booking response is unaffected either way.
 *
 * @returns {Promise<{configured: boolean, ok: boolean, skipped?: boolean, error?: string}>}
 */
export async function logBookingToSheet({ booking = {}, env = {}, fetchImpl, clientIp, timestamp } = {}) {
  const url = asText(env.GOOGLE_SHEETS_WEBHOOK_URL).trim();
  if (!url) {
    return {
      configured: false,
      ok: false,
      skipped: true,
      error: 'No GOOGLE_SHEETS_WEBHOOK_URL configured on this host.',
    };
  }

  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) {
    return { configured: true, ok: false, error: 'No fetch implementation available.' };
  }

  const inspection = inspectWebhookUrl(url);
  if (!inspection.ok) {
    // Still attempt the POST (the URL may work despite the warning), but carry
    // the diagnosis through so /api/booking-health can show it.
    //
    // A /dev URL, though, is guaranteed to fail — do not waste 10s on it.
    if (inspection.problems.some((p) => p.includes('/dev'))) {
      return { configured: true, ok: false, error: inspection.problems.join(' '), urlProblems: inspection.problems };
    }
  }

  const row = bookingToRow(booking, { timestamp, clientIp });
  const secret = asText(env.GOOGLE_SHEETS_SECRET).trim();

  const result = await postToScript({
    url,
    fetchImpl: doFetch,
    payload: {
      secret: secret || undefined,
      secretFingerprint: fingerprint(secret),
      mode: 'append',
      booking: row,
    },
  });

  if (result.ok) {
    return { configured: true, ok: true, status: result.status, attempts: result.attempt };
  }
  return {
    configured: true,
    ok: false,
    status: result.status,
    attempts: result.attempt,
    error: result.reason,
    hint: result.hint,
    urlProblems: inspection.problems.length ? inspection.problems : undefined,
  };
}

/**
 * Dry-run the whole path without relying on a real customer booking.
 *
 * Sends `mode:"ping"` so the v2 Apps Script validates the secret and reports
 * the sheet it would write to WITHOUT appending a row. An older v1 script does
 * not understand `mode` and will append one clearly-labelled test row instead,
 * which is itself a useful signal (and safe to delete).
 */
export async function pingSheet({ env = {}, fetchImpl } = {}) {
  const url = asText(env.GOOGLE_SHEETS_WEBHOOK_URL).trim();
  const secret = asText(env.GOOGLE_SHEETS_SECRET).trim();
  const inspection = inspectWebhookUrl(url);

  if (!url) {
    return { attempted: false, ok: false, reason: inspection.problems[0], urlInspection: inspection };
  }

  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { attempted: false, ok: false, reason: 'No fetch implementation available.' };

  if (inspection.problems.some((p) => p.includes('/dev'))) {
    return { attempted: false, ok: false, reason: inspection.problems.join(' '), urlInspection: inspection };
  }

  const result = await postToScript({
    url,
    fetchImpl: doFetch,
    payload: {
      secret: secret || undefined,
      secretFingerprint: fingerprint(secret),
      mode: 'ping',
      // Fallback shape for a v1 script that ignores `mode` and appends anyway.
      booking: {
        timestamp: new Date().toISOString(),
        booking_reference: 'SELF-TEST',
        customer_name: '— connection self-test, safe to delete —',
      },
    },
  });

  return {
    attempted: true,
    ok: result.ok,
    status: result.status,
    reason: result.ok ? undefined : result.reason,
    hint: result.ok ? undefined : result.hint,
    script: result.data || null,
    rawBody: result.body,
    urlInspection: inspection,
  };
}

export default logBookingToSheet;
