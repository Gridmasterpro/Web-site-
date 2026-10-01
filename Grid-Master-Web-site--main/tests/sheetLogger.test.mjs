/**
 * Tests for the Google Sheet booking logger and its wiring into the shared
 * booking handler. The logger must never change the booking response shape
 * or status code — it only ever adds the informational `logged` flag.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bookingToRow, sheetLoggingConfigured, logBookingToSheet } from '../server/sheetLogger.mjs';
import { handleBookingRequest } from '../server/handleBooking.mjs';

const BOOKING = {
  booking_reference: 'GM-SR-555555',
  customer_name: 'Bollapelly Meghana',
  customer_phone: '9391103814',
  customer_email: 'meghana@example.com',
  property_location: 'Jayashankar Bhupalapally',
  purpose: 'Home (Residential)',
  service_required: 'Full Package (Design + Install + Grid Integration)',
  scheduled_date: '2026-10-03',
  time_slot: '09:00 AM - 11:00 AM',
};

const postEvent = (booking, overrides = {}) => ({
  httpMethod: 'POST',
  headers: { 'x-forwarded-for': '203.0.113.21' },
  body: JSON.stringify(booking),
  ...overrides,
});

test('sheetLoggingConfigured reflects GOOGLE_SHEETS_WEBHOOK_URL', () => {
  assert.equal(sheetLoggingConfigured({}), false);
  assert.equal(sheetLoggingConfigured({ GOOGLE_SHEETS_WEBHOOK_URL: '' }), false);
  assert.equal(sheetLoggingConfigured({ GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/x' }), true);
});

test('bookingToRow maps every tracked customer field, including the address', () => {
  const row = bookingToRow(BOOKING, { timestamp: '2026-10-01T00:00:00.000Z', clientIp: '203.0.113.21' });
  assert.equal(row.customer_name, 'Bollapelly Meghana');
  assert.equal(row.customer_phone, '9391103814');
  assert.equal(row.customer_email, 'meghana@example.com');
  assert.equal(row.property_location, 'Jayashankar Bhupalapally');
  assert.equal(row.booking_reference, 'GM-SR-555555');
  assert.equal(row.timestamp, '2026-10-01T00:00:00.000Z');
  assert.equal(row.source_ip, '203.0.113.21');
});

test('logBookingToSheet is a silent no-op without GOOGLE_SHEETS_WEBHOOK_URL', async () => {
  let called = 0;
  const result = await logBookingToSheet({
    booking: BOOKING,
    env: {},
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => '' };
    },
  });
  assert.equal(result.configured, false);
  assert.equal(result.ok, false);
  assert.equal(called, 0);
});

test('logBookingToSheet posts the row to the configured webhook', async () => {
  const captured = [];
  const result = await logBookingToSheet({
    booking: BOOKING,
    env: { GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/abc/exec', GOOGLE_SHEETS_SECRET: 'shh' },
    fetchImpl: async (url, init) => {
      captured.push({ url, init });
      return { ok: true, status: 200, text: async () => 'OK' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://script.google.com/macros/s/abc/exec');
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.secret, 'shh');
  assert.equal(body.booking.customer_name, 'Bollapelly Meghana');
});

test('logBookingToSheet never throws when the webhook fails', async () => {
  const result = await logBookingToSheet({
    booking: BOOKING,
    env: { GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/abc/exec' },
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(result.configured, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /network down/);
});

/* ------------------------------------------------------------------ */
/* wiring into the booking handler                                     */
/* ------------------------------------------------------------------ */

test('a booking is logged to the sheet even when no mail provider is configured', async () => {
  const sheetCalls = [];
  const res = await handleBookingRequest(postEvent(BOOKING), {
    env: { GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/abc/exec' },
    fetchImpl: async (url) => {
      sheetCalls.push(url);
      return { ok: true, status: 200, text: async () => 'OK' };
    },
  });

  // The existing contract is untouched: still 501/configured:false so the
  // browser still falls back to FormSubmit exactly as before.
  assert.equal(res.statusCode, 501);
  const body = JSON.parse(res.body);
  assert.equal(body.configured, false);
  assert.equal(body.logged, true);
  assert.equal(sheetCalls.length, 1);
  assert.equal(sheetCalls[0], 'https://script.google.com/macros/s/abc/exec');
});

test('a booking is logged to the sheet alongside a successful e-mail send', async () => {
  const urls = [];
  const res = await handleBookingRequest(postEvent(BOOKING), {
    env: { RESEND_API_KEY: 're_test', GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/abc/exec' },
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => '{"id":"abc"}' };
    },
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.success, true);
  assert.equal(body.logged, true);
  assert.ok(urls.includes('https://api.resend.com/emails'));
  assert.ok(urls.includes('https://script.google.com/macros/s/abc/exec'));
});

test('a failed sheet webhook never breaks the booking response', async () => {
  const res = await handleBookingRequest(postEvent(BOOKING), {
    env: { RESEND_API_KEY: 're_test', GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/abc/exec' },
    fetchImpl: async (url) => {
      if (url.includes('script.google.com')) throw new Error('sheet is down');
      return { ok: true, status: 200, text: async () => '{"id":"abc"}' };
    },
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.success, true);
  assert.equal(body.logged, false);
});

test('without GOOGLE_SHEETS_WEBHOOK_URL the booking flow is byte-for-byte unchanged apart from `logged:false`', async () => {
  const res = await handleBookingRequest(postEvent(BOOKING), {
    env: { RESEND_API_KEY: 're_test' },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"id":"abc"}' }),
  });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.success, true);
  assert.equal(body.provider, 'resend');
  assert.equal(body.logged, false);
});
