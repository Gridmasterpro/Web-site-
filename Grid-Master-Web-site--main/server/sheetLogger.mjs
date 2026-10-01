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
 *   GOOGLE_SHEETS_WEBHOOK_URL   the Apps Script "exec" URL from Path C of
 *                               docs/customer-bookings-sheet-setup.md
 *   GOOGLE_SHEETS_SECRET        (recommended) a shared secret the script
 *                               checks before writing, so the public exec URL
 *                               cannot be used by strangers to fill the sheet
 *
 * Without GOOGLE_SHEETS_WEBHOOK_URL this module is a silent no-op.
 */

const asText = (value) => (value === undefined || value === null ? '' : String(value));

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

async function withTimeout(fetchImpl, url, init, ms = 10000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ms) : null;
  try {
    return await fetchImpl(url, { ...init, signal: controller ? controller.signal : undefined });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Append one booking to the owner's Google Sheet. Never throws — the caller
 * gets a structured verdict and the booking response is unaffected either way.
 *
 * @returns {Promise<{configured: boolean, ok: boolean, skipped?: boolean, error?: string}>}
 */
export async function logBookingToSheet({ booking = {}, env = {}, fetchImpl, clientIp, timestamp } = {}) {
  const url = asText(env.GOOGLE_SHEETS_WEBHOOK_URL).trim();
  if (!url) {
    return { configured: false, ok: false, skipped: true, error: 'No GOOGLE_SHEETS_WEBHOOK_URL configured on this host.' };
  }

  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) {
    return { configured: true, ok: false, error: 'No fetch implementation available.' };
  }

  const row = bookingToRow(booking, { timestamp, clientIp });
  const secret = asText(env.GOOGLE_SHEETS_SECRET).trim();

  try {
    const res = await withTimeout(doFetch, url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ secret: secret || undefined, booking: row }),
    });
    const raw = await res.text().catch(() => '');
    if (res.ok) {
      return { configured: true, ok: true, status: res.status, message: raw.slice(0, 300) };
    }
    return { configured: true, ok: false, status: res.status, error: raw.slice(0, 300) || `Sheet webhook answered HTTP ${res.status}.` };
  } catch (error) {
    return {
      configured: true,
      ok: false,
      error: error?.name === 'AbortError' ? 'The Sheet webhook did not answer in time.' : error?.message || String(error),
    };
  }
}

export default logBookingToSheet;
