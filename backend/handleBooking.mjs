/**
 * Shared handler for the site's own booking mail relay.
 *
 * Used by `api/booking.js` (Vercel) and `netlify/functions/booking.mjs`.
 * Answers JSON in every case so the browser can decide what to do next:
 *
 *   200 {success:true}                booking handed to the mail provider
 *   501 {configured:false}            host has no MAIL_* variables — the browser
 *                                     falls back to FormSubmit automatically
 *   400 / 429 / 502                   validation / throttling / provider error
 */

import { sendBookingMail, resolveProvider } from './mailProvider.mjs';
import { logBookingToSheet } from './sheetLogger.mjs';

const MAX_BODY_BYTES = 32 * 1024;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 12;

// Best-effort in-memory throttle (per warm instance) — enough to stop a casual
// spam script from using the endpoint as an open relay.
const hits = new Map();

function throttled(key, now = Date.now()) {
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 500) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  }
  return recent.length > MAX_PER_WINDOW;
}

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

function clientIp(event) {
  const headers = event.headers || {};
  return (
    headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    headers['x-real-ip'] ||
    event.requestContext?.http?.sourceIp ||
    'unknown'
  );
}

export function validateBooking(booking) {
  if (!booking || typeof booking !== 'object') return 'Missing booking payload.';
  if (booking._honey) return 'Spam detected.';
  const name = String(booking.customer_name || '').trim();
  const phone = String(booking.customer_phone || '').trim();
  const email = String(booking.customer_email || booking.email || '').trim();
  if (name.length < 2) return 'A customer name is required.';
  if (phone.replace(/\D/g, '').length < 7) return 'A valid phone number is required.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'A valid customer email is required.';
  if (String(booking.property_location || '').trim().length < 3) return 'A property location is required.';
  return null;
}

export async function handleBookingRequest(event, { env = {}, fetchImpl } = {}) {
  const method = (event.httpMethod || event.method || 'POST').toUpperCase();
  if (method !== 'POST') return json(405, { success: false, error: 'Use POST for booking submissions.' });

  const rawBody = event.body || '';
  if (rawBody.length > MAX_BODY_BYTES) return json(413, { success: false, error: 'Booking payload too large.' });

  let booking;
  try {
    const parsed = JSON.parse(rawBody || '{}');
    booking = parsed?.booking && typeof parsed.booking === 'object' ? parsed.booking : parsed;
  } catch {
    return json(400, { success: false, error: 'Booking payload must be valid JSON.' });
  }

  const problem = validateBooking(booking);
  if (problem) return json(400, { success: false, error: problem });

  if (throttled(clientIp(event))) {
    return json(429, { success: false, error: 'Too many booking mails from this network. Please try again later.' });
  }

  // Log every validated booking to the owner's Google Sheet (if configured),
  // independently of whether a mail provider is set up. This never changes
  // the HTTP status or body shape the browser expects — a sheet failure is
  // swallowed here and only the `logged` flag reflects it.
  const sheetPromise = logBookingToSheet({ booking, env, fetchImpl, clientIp: clientIp(event) }).catch((error) => ({
    configured: sheetPromiseEnvConfigured(env),
    ok: false,
    error: error?.message || String(error),
  }));

  const provider = resolveProvider(env);
  if (!provider.configured) {
    const sheetResult = await sheetPromise;
    return json(501, {
      success: false,
      configured: false,
      logged: Boolean(sheetResult?.ok),
      ...sheetDiagnostics(sheetResult),
      error: 'No mail provider configured on this host — use the FormSubmit relay or set MAIL_* variables.',
    });
  }

  const [mailResult, sheetResult] = await Promise.all([
    sendBookingMail({ booking, env, fetchImpl }),
    sheetPromise,
  ]);

  if (mailResult.ok) {
    return json(200, {
      success: true,
      provider: mailResult.provider,
      to: mailResult.to || provider.to,
      logged: Boolean(sheetResult?.ok),
      ...sheetDiagnostics(sheetResult),
      message: `Booking e-mailed from the ${mailResult.provider} relay.`,
    });
  }
  return json(502, {
    success: false,
    provider: mailResult.provider,
    logged: Boolean(sheetResult?.ok),
    ...sheetDiagnostics(sheetResult),
    error: mailResult.error || 'The mail provider refused the booking.',
  });
}

function sheetPromiseEnvConfigured(env) {
  return Boolean(String(env?.GOOGLE_SHEETS_WEBHOOK_URL || '').trim());
}

/**
 * Surface *why* a sheet write failed, so the reason is visible in the browser's
 * Network tab instead of being swallowed. Only added when the logger is
 * configured and actually failed — a healthy or disabled logger adds nothing,
 * which keeps the response identical to before for every normal visitor.
 *
 * Never contains a secret: `sheetLogger` only ever returns descriptions.
 */
function sheetDiagnostics(sheetResult) {
  if (!sheetResult || sheetResult.ok || !sheetResult.configured) return {};
  const out = { logError: sheetResult.error };
  if (sheetResult.hint) out.logHint = sheetResult.hint;
  out.logHelp = 'Open /api/booking-health?selftest=1 for a full diagnosis.';
  return out;
}

export default handleBookingRequest;
