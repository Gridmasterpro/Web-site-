/**
 * Tests for the Google Sheet booking logger and its wiring into the shared
 * booking handler. The logger must never change the booking response shape
 * or status code — it only ever adds the informational `logged` flag.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { bookingToRow, sheetLoggingConfigured, logBookingToSheet } from '../backend/sheetLogger.mjs';
import { handleBookingRequest } from '../backend/handleBooking.mjs';

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

/* ------------------------------------------------------------------ */
/* silent-failure protection                                           */
/*                                                                     */
/* A Google Apps Script web app answers HTTP 200 for almost everything,*/
/* including the cases where it wrote nothing. These tests pin down    */
/* that we no longer report those as a success.                        */
/* ------------------------------------------------------------------ */

import {
  interpretSheetResponse,
  inspectWebhookUrl,
  redactWebhookUrl,
  fingerprint,
  pingSheet,
} from '../backend/sheetLogger.mjs';
import { describeConfiguration, summarise, handleBookingHealthRequest, pingMailProvider } from '../backend/bookingHealth.mjs';

const EXEC = 'https://script.google.com/macros/s/AKfycbxDEMO1234567890/exec';

test('a rejected secret is reported as a failure, not a success', async () => {
  const result = await logBookingToSheet({
    booking: BOOKING,
    env: { GOOGLE_SHEETS_WEBHOOK_URL: EXEC, GOOGLE_SHEETS_SECRET: 'wrong' },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, error: 'Invalid secret.' }),
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid secret/);
  assert.match(result.hint, /GOOGLE_SHEETS_SECRET/);
});

test('a Google sign-in page is reported as a failure, not a success', async () => {
  const result = await logBookingToSheet({
    booking: BOOKING,
    env: { GOOGLE_SHEETS_WEBHOOK_URL: EXEC },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => '<!DOCTYPE html><html><head><title>Sign in - Google Accounts</title></head></html>',
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /sign-in page/i);
  assert.match(result.hint, /Anyone/);
});

test('an explicit ok:true from the script is a success', async () => {
  const result = await logBookingToSheet({
    booking: BOOKING,
    env: { GOOGLE_SHEETS_WEBHOOK_URL: EXEC },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, rowNumber: 7 }) }),
  });
  assert.equal(result.ok, true);
});

test('a /dev URL is rejected up front instead of timing out', async () => {
  let called = 0;
  const result = await logBookingToSheet({
    booking: BOOKING,
    env: { GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/AKfycbxDEMO/dev' },
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(called, 0);
  assert.match(result.error, /\/dev/);
});

test('inspectWebhookUrl catches the URLs that cannot possibly work', () => {
  assert.equal(inspectWebhookUrl(EXEC).ok, true);
  assert.equal(inspectWebhookUrl('').ok, false);
  assert.equal(inspectWebhookUrl('not a url').ok, false);
  assert.match(inspectWebhookUrl('https://script.google.com/macros/s/a/dev').problems.join(' '), /\/dev/);
  assert.match(
    inspectWebhookUrl('https://script.google.com/macros/s/a/edit').problems.join(' '),
    /does not end in \/exec/
  );
});

test('a transient 5xx is retried once', async () => {
  let calls = 0;
  const result = await logBookingToSheet({
    booking: BOOKING,
    env: { GOOGLE_SHEETS_WEBHOOK_URL: EXEC },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 503, text: async () => 'temporarily unavailable' };
      return { ok: true, status: 200, text: async () => '{"ok":true}' };
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
});

test('the webhook URL is redacted and the secret is never exposed', () => {
  const redacted = redactWebhookUrl(EXEC);
  assert.ok(!redacted.includes('AKfycbxDEMO1234567890'));
  const config = describeConfiguration({ GOOGLE_SHEETS_WEBHOOK_URL: EXEC, GOOGLE_SHEETS_SECRET: 'super-secret' });
  const serialised = JSON.stringify(config);
  assert.ok(!serialised.includes('super-secret'));
  assert.equal(config.sheetLogging.GOOGLE_SHEETS_SECRET.fingerprint, fingerprint('super-secret'));
});

test('fingerprints match only for identical secrets', () => {
  assert.equal(fingerprint('abc'), fingerprint('abc'));
  assert.notEqual(fingerprint('abc'), fingerprint('abc '));
  assert.equal(fingerprint(''), 'none');
});

test('pingSheet does not write a row when the script understands ping mode', async () => {
  let sent = null;
  const result = await pingSheet({
    env: { GOOGLE_SHEETS_WEBHOOK_URL: EXEC, GOOGLE_SHEETS_SECRET: 'shh' },
    fetchImpl: async (url, init) => {
      sent = JSON.parse(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, mode: 'ping', dataRows: 12 }) };
    },
  });
  assert.equal(sent.mode, 'ping');
  assert.equal(result.ok, true);
  assert.equal(result.script.dataRows, 12);
});

/* ------------------------------------------------------------------ */
/* /api/booking-health                                                 */
/* ------------------------------------------------------------------ */

test('health endpoint flags a host with no webhook configured', async () => {
  const res = await handleBookingHealthRequest({ httpMethod: 'GET' }, { env: {} });
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.verdict.status, 'not-configured');
  assert.match(body.verdict.nextAction, /Redeploy/i);
});

test('health endpoint reports a healthy pipeline after a successful self-test', async () => {
  const res = await handleBookingHealthRequest(
    { httpMethod: 'GET', queryStringParameters: { selftest: '1' } },
    {
      env: { GOOGLE_SHEETS_WEBHOOK_URL: EXEC, GOOGLE_SHEETS_SECRET: 'shh' },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, mode: 'ping', secretFingerprint: fingerprint('shh') }),
      }),
    }
  );
  const body = JSON.parse(res.body);
  assert.equal(body.verdict.status, 'healthy');
  assert.equal(body.selftest.ok, true);
});

test('summarise explains a mismatched secret in plain English', () => {
  const config = describeConfiguration({ GOOGLE_SHEETS_WEBHOOK_URL: EXEC, GOOGLE_SHEETS_SECRET: 'a' });
  const verdict = summarise(config, { attempted: true, ok: false, reason: 'Invalid secret.', hint: 'Compare fingerprints.' });
  assert.equal(verdict.status, 'broken');
  assert.match(verdict.headline, /Invalid secret/);
});

/* ------------------------------------------------------------------ */
/* /api/booking-health — mail relay diagnostics                        */
/* ------------------------------------------------------------------ */

test('health endpoint reports the mail relay, its addresses and a masked key', () => {
  const config = describeConfiguration({
    BREVO_API_KEY: 'xkeysib-secret-1234',
    MAIL_FROM: 'Grid Master Solar Systems <contactgridmaster@gmail.com>',
    MAIL_TO: 'contactgridmaster@gmail.com',
  });

  assert.equal(config.mailRelay.configured, true);
  assert.equal(config.mailRelay.provider, 'brevo');
  assert.equal(config.mailRelay.from, 'Grid Master Solar Systems <contactgridmaster@gmail.com>');
  assert.equal(config.mailRelay.to, 'contactgridmaster@gmail.com');
  assert.equal(config.mailRelay.customerConfirmation, 'on');
  assert.equal(config.mailRelay.providerKey.variable, 'BREVO_API_KEY');
  assert.equal(config.mailRelay.providerKey.set, true);
  assert.equal(config.mailRelay.providerKey.tail, '…1234');
  // The full key must never appear anywhere in the report.
  assert.ok(!JSON.stringify(config).includes('xkeysib-secret-1234'));
});

test('health endpoint says "none" when no mail provider is configured', () => {
  const config = describeConfiguration({});
  assert.equal(config.mailRelay.configured, false);
  assert.equal(config.mailRelay.provider, 'none');
  assert.equal(config.mailRelay.providerKey.set, false);
});

test('?mailtest=1 pings Brevo read-only and confirms a valid key', async () => {
  const captured = [];
  const result = await pingMailProvider({
    env: { BREVO_API_KEY: 'xkeysib-good' },
    fetchImpl: async (url, init) => {
      captured.push({ url, init });
      return { ok: true, status: 200, text: async () => '{"email":"owner@grid.example"}' };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'brevo');
  assert.equal(result.accountEmail, 'owner@grid.example');
  assert.equal(captured[0].url, 'https://api.brevo.com/v3/account');
  assert.equal(captured[0].init.headers['api-key'], 'xkeysib-good');
});

test('?mailtest=1 explains a refused key in plain English', async () => {
  const result = await pingMailProvider({
    env: { BREVO_API_KEY: 'xkeysib-bad' },
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"message":"Key not found"}' }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /refused|regenerate/i);
});

test('mailtest is skipped honestly for providers without a read-only check', async () => {
  const result = await pingMailProvider({ env: {}, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(result.provider, 'none');
  assert.equal(result.attempted, false);
});

test('health endpoint reports which deployment and commit is answering', async () => {
  const res = await handleBookingHealthRequest(
    { httpMethod: 'GET' },
    { env: { VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890' } }
  );
  const body = JSON.parse(res.body);
  assert.deepEqual(body.deployment, { environment: 'preview', commit: 'abcdef1' });
});

test('mailtest gives the exact fix when Brevo blocks a valid key by IP', async () => {
  const fetchMock = async () => ({
    ok: false,
    status: 401,
    text: async () =>
      '{"message":"We have detected you are using an unrecognised IP address 103.129.228.18. If you performed this action make sure to add the new IP address in this link: https://app.brevo.com/security/authorised_ips","code":"unauthorized"}',
  });
  const result = await pingMailProvider({
    env: { BREVO_API_KEY: 'xkeysib-valid-but-ip-blocked' },
    fetchImpl: fetchMock,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Authorized IPs/);
  assert.match(result.reason, /security\/authorised_ips/);
  assert.match(result.reason, /VALID/);
});

test('mailtest also recognizes Brevo verify-new-IP blocks', async () => {
  const fetchMock = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"message":"Please verify a new IP address before making API calls","code":"unauthorized"}',
  });
  const result = await pingMailProvider({
    env: { BREVO_API_KEY: 'xkeysib-valid-but-new-ip-gate' },
    fetchImpl: fetchMock,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /IP security settings/);
  assert.match(result.reason, /authorised_ips/);
});

test('sendtest sends one sample booking mail to the company inbox and reports success', async () => {
  let sentBody = '';
  const fetchMock = async (url, init) => {
    if (String(url).includes('smtp/email')) sentBody = init.body;
    return { ok: true, status: 201, text: async () => '{"messageId":"<ok>"}' };
  };
  const res = await handleBookingHealthRequest(
    { httpMethod: 'GET', queryStringParameters: { sendtest: '1' } },
    { env: { BREVO_API_KEY: 'xkeysib-sendtest-ok' }, fetchImpl: fetchMock }
  );
  const body = JSON.parse(res.body);
  assert.equal(body.sendtest.ok, true);
  assert.equal(body.sendtest.provider, 'brevo');
  assert.equal(body.sendtest.to, 'contactgridmaster@gmail.com');
  const payload = JSON.parse(sentBody);
  assert.equal(payload.to[0].email, 'contactgridmaster@gmail.com');
  assert.match(payload.subject, /GM-SR-TEST/);
});

test('sendtest explains when Brevo accepts reads but refuses the send by IP', async () => {
  const fetchMock = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"message":"We have detected you are using an unrecognised IP address 203.0.113.9","code":"unauthorized"}',
  });
  const res = await handleBookingHealthRequest(
    { httpMethod: 'GET', queryStringParameters: { sendtest: '1' } },
    { env: { BREVO_API_KEY: 'xkeysib-sendtest-ipgate' }, fetchImpl: fetchMock }
  );
  const body = JSON.parse(res.body);
  assert.equal(body.sendtest.ok, false);
  assert.match(body.sendtest.reason, /refused the SEND/);
  assert.match(body.sendtest.reason, /Authorize/);
});

test('sendtest is not attempted without the parameter', async () => {
  const res = await handleBookingHealthRequest(
    { httpMethod: 'GET', queryStringParameters: {} },
    { env: { BREVO_API_KEY: 'x' }, fetchImpl: async () => { throw new Error('must not be called'); } }
  );
  const body = JSON.parse(res.body);
  assert.equal(body.sendtest, null);
});

test('fulltest exercises all four booking stages (PDF, sheet write, both mails) and succeeds when every one does', async () => {
  const fetchMock = async (url) => {
    if (String(url).includes('script.google.com')) {
      return { ok: true, status: 200, text: async () => '{"ok":true,"mode":"write","row":23}' };
    }
    return { ok: true, status: 201, text: async () => '{"messageId":"<ok>"}' };
  };
  const res = await handleBookingHealthRequest(
    { httpMethod: 'GET', queryStringParameters: { fulltest: '1' } },
    {
      env: { BREVO_API_KEY: 'xkeysib-fulltest', GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/AID/exec', GOOGLE_SHEETS_SECRET: 's' },
      fetchImpl: fetchMock,
    }
  );
  const body = JSON.parse(res.body);
  assert.equal(body.fulltest.ok, true);
  assert.equal(body.fulltest.stages.pdf.ok, true);
  assert.ok(body.fulltest.stages.pdf.bytes > 500);
  assert.equal(body.fulltest.stages.sheetWrite.ok, true);
  assert.equal(body.fulltest.stages.companyMail.ok, true);
  assert.equal(body.fulltest.stages.customerMail.ok, true);
});

test('fulltest pinpoints the failing stage without blaming the healthy ones', async () => {
  const fetchMock = async (url) => {
    if (String(url).includes('script.google.com')) {
      return { ok: true, status: 200, text: async () => '{"ok":false,"error":"Simulated sheet refusal"}' };
    }
    return { ok: true, status: 201, text: async () => '{"messageId":"<ok>"}' };
  };
  const res = await handleBookingHealthRequest(
    { httpMethod: 'GET', queryStringParameters: { fulltest: '1' } },
    {
      env: { BREVO_API_KEY: 'xkeysib-fulltest', GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/AID/exec', GOOGLE_SHEETS_SECRET: 's' },
      fetchImpl: fetchMock,
    }
  );
  const body = JSON.parse(res.body);
  assert.equal(body.fulltest.ok, false);
  assert.equal(body.fulltest.stages.sheetWrite.ok, false);
  assert.match(body.fulltest.stages.sheetWrite.error, /Simulated sheet refusal/);
  assert.equal(body.fulltest.stages.companyMail.ok, true);
  assert.equal(body.fulltest.stages.pdf.ok, true);
});
