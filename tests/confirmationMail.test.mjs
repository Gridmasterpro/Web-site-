/**
 * Tests for the customer thank-you confirmation mail with the PDF receipt
 * (backend/confirmationMail.mjs) and its wiring into the booking handler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIRMATION_ENV_VAR,
  customerConfirmationEnabled,
  renderCustomerConfirmationMail,
  sendCustomerConfirmationMail,
  confirmationStatus,
} from '../backend/confirmationMail.mjs';
import { handleBookingRequest } from '../backend/handleBooking.mjs';
import { DEFAULT_INBOX } from '../backend/mailProvider.mjs';

const BOOKING = {
  booking_reference: 'GM-SR-424242',
  customer_name: 'Bollapelly Meghana',
  customer_phone: '9391103814',
  customer_email: 'meghana@example.com',
  property_location: 'Jayashankar Bhupalapally',
  purpose: 'Home (Residential)',
  service_required: 'Full Package (Design + Install + Grid Integration)',
  lead_engineer: 'GANDHAMANENI GOUTHAM (Head Engineer - Solar & Electrical)',
  scheduled_date: '2026-10-12',
  time_slot: '09:00 AM - 11:00 AM',
  notes: 'Roof size 900 sq ft',
};

const postEvent = (booking, overrides = {}) => ({
  httpMethod: 'POST',
  headers: { 'x-forwarded-for': '203.0.113.7' },
  body: JSON.stringify(booking),
  ...overrides,
});

const okFetch = (captured = []) => async (url, init) => {
  captured.push({ url, init });
  return { status: 200, ok: true, text: async () => '{"id":"abc"}' };
};

/* ------------------------------------------------------------------ */
/* feature switch                                                      */
/* ------------------------------------------------------------------ */

test('the confirmation is enabled by default and off via the kill switch', () => {
  assert.equal(customerConfirmationEnabled({}), true);
  assert.equal(customerConfirmationEnabled({ [CONFIRMATION_ENV_VAR]: 'on' }), true);
  for (const off of ['off', '0', 'false', 'no', 'disabled', 'OFF']) {
    assert.equal(customerConfirmationEnabled({ [CONFIRMATION_ENV_VAR]: off }), false, `value "${off}" disables it`);
  }
});

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

test('the confirmation mail thanks the customer and states the visit details', () => {
  const mail = renderCustomerConfirmationMail(BOOKING, { now: new Date('2026-10-07T10:00:00Z') });

  assert.match(mail.subject, /Thank you Bollapelly/);
  assert.match(mail.subject, /GM-SR-424242/);
  assert.match(mail.subject, /12 October 2026/);
  assert.equal(mail.to, 'meghana@example.com');
  assert.equal(mail.replyTo, DEFAULT_INBOX, 'replies go back to the company');

  for (const needle of [
    'GM-SR-424242',
    '12 October 2026',
    '09:00 AM - 11:00 AM',
    'GANDHAMANENI GOUTHAM',
    'will visit your',
    'GridMaster_Booking_GM-SR-424242.pdf',
    'Jayashankar Bhupalapally',
  ]) {
    assert.ok(mail.textBody.includes(needle), `text body mentions ${needle}`);
  }

  for (const needle of ['Booking Confirmed', 'SITE VISIT SCHEDULED', 'GM-SR-424242', 'Grid Master Solar Systems']) {
    assert.ok(mail.htmlBody.includes(needle), `html body mentions ${needle}`);
  }
});

test('the attached PDF is the same branded receipt the site offers', () => {
  const mail = renderCustomerConfirmationMail(BOOKING, { now: new Date('2026-10-07T10:00:00Z') });

  assert.equal(mail.attachments.length, 1);
  const [attachment] = mail.attachments;
  assert.equal(attachment.filename, 'GridMaster_Booking_GM-SR-424242.pdf');
  assert.equal(attachment.contentType, 'application/pdf');

  const pdf = Buffer.from(attachment.contentBase64, 'base64').toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.ok(pdf.includes('GM-SR-424242'));
  assert.ok(pdf.includes('Bollapelly Meghana'));
  assert.ok(pdf.includes('SITE VISIT SCHEDULED'));
});

test('customer input is escaped in the confirmation HTML', () => {
  const mail = renderCustomerConfirmationMail({ ...BOOKING, customer_name: '<b>Meghana</b>' });
  assert.ok(!mail.htmlBody.includes('<b>Meghana</b>'));
  assert.match(mail.htmlBody, /&lt;b&gt;Meghana&lt;\/b&gt;/);
});

/* ------------------------------------------------------------------ */
/* provider delivery                                                   */
/* ------------------------------------------------------------------ */

test('Brevo receives the confirmation with the PDF attachment for the customer', async () => {
  const captured = [];
  const result = await sendCustomerConfirmationMail({
    booking: BOOKING,
    env: { BREVO_API_KEY: 'xkeysib-test', MAIL_TO: 'bookings@grid.example' },
    fetchImpl: okFetch(captured),
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'brevo');
  assert.equal(result.to, 'meghana@example.com');
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://api.brevo.com/v3/smtp/email');

  const body = JSON.parse(captured[0].init.body);
  assert.deepEqual(body.to, [{ email: 'meghana@example.com' }]);
  assert.deepEqual(body.replyTo, { email: 'bookings@grid.example' });
  assert.equal(body.sender.name, 'Grid Master Solar Systems');
  assert.equal(body.attachment.length, 1);
  assert.equal(body.attachment[0].name, 'GridMaster_Booking_GM-SR-424242.pdf');
  assert.ok(Buffer.from(body.attachment[0].content, 'base64').toString('latin1').startsWith('%PDF-1.4'));
});

test('Resend and SendGrid map the attachment into their own shapes', async () => {
  const resendCalls = [];
  const resend = await sendCustomerConfirmationMail({
    booking: BOOKING,
    env: { RESEND_API_KEY: 're_test', MAIL_FROM: 'Grid Master <bookings@grid.example>' },
    fetchImpl: okFetch(resendCalls),
  });
  assert.equal(resend.ok, true);
  const resendBody = JSON.parse(resendCalls[0].init.body);
  assert.deepEqual(resendBody.to, ['meghana@example.com']);
  assert.equal(resendBody.from, 'Grid Master Solar Systems <bookings@grid.example>');
  assert.equal(resendBody.attachments[0].filename, 'GridMaster_Booking_GM-SR-424242.pdf');
  assert.ok(resendBody.attachments[0].content.length > 1000);

  const sendgridCalls = [];
  const sendgrid = await sendCustomerConfirmationMail({
    booking: BOOKING,
    env: { SENDGRID_API_KEY: 'SG.test' },
    fetchImpl: okFetch(sendgridCalls),
  });
  assert.equal(sendgrid.ok, true);
  const sendgridBody = JSON.parse(sendgridCalls[0].init.body);
  assert.deepEqual(sendgridBody.personalizations, [{ to: [{ email: 'meghana@example.com' }] }]);
  assert.equal(sendgridBody.attachments[0].type, 'application/pdf');
  assert.equal(sendgridBody.attachments[0].disposition, 'attachment');
});

test('Web3Forms cannot mail customers — the confirmation is skipped, not faked', async () => {
  let called = 0;
  const result = await sendCustomerConfirmationMail({
    booking: BOOKING,
    env: { WEB3FORMS_KEY: 'uuid' },
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => '' };
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(called, 0, 'no request is made to the provider');
  assert.match(result.reason, /cannot e-mail the customer/i);
  assert.equal(confirmationStatus(result), 'unsupported');
});

test('the kill switch and missing recipient are reported honestly', async () => {
  const off = await sendCustomerConfirmationMail({
    booking: BOOKING,
    env: { BREVO_API_KEY: 'k', [CONFIRMATION_ENV_VAR]: 'off' },
    fetchImpl: okFetch(),
  });
  assert.equal(off.skipped, true);
  assert.equal(confirmationStatus(off), 'disabled');

  const noRecipient = await sendCustomerConfirmationMail({
    booking: { ...BOOKING, customer_email: '', email: '' },
    env: { BREVO_API_KEY: 'k' },
    fetchImpl: okFetch(),
  });
  assert.equal(noRecipient.skipped, true);
  assert.equal(confirmationStatus(noRecipient), 'skipped');

  const noProvider = await sendCustomerConfirmationMail({ booking: BOOKING, env: {}, fetchImpl: okFetch() });
  assert.equal(noProvider.configured, false);
});

/* ------------------------------------------------------------------ */
/* handler integration                                                 */
/* ------------------------------------------------------------------ */

test('the booking handler sends company mail AND customer confirmation together', async () => {
  const captured = [];
  const res = await handleBookingRequest(postEvent(BOOKING), {
    env: { BREVO_API_KEY: 'xkeysib-test' },
    fetchImpl: okFetch(captured),
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.success, true);
  assert.deepEqual(body.customerMail, {
    sent: true,
    status: 'sent',
    to: 'meghana@example.com',
  });
  assert.match(body.message, /confirmation with the PDF receipt/);

  assert.equal(captured.length, 2, 'one call for the company, one for the customer');
  const recipients = captured.map((call) => JSON.parse(call.init.body).to[0].email).sort();
  assert.deepEqual(recipients, [DEFAULT_INBOX, 'meghana@example.com'].sort());
});

test('a failed confirmation never breaks the booking itself', async () => {
  const res = await handleBookingRequest(postEvent(BOOKING), {
    env: { BREVO_API_KEY: 'xkeysib-test' },
    fetchImpl: async (url, init) => {
      const isCustomer = JSON.parse(init.body).to?.[0]?.email === 'meghana@example.com';
      if (isCustomer) {
        return { status: 400, ok: false, text: async () => '{"message":"sender not verified"}' };
      }
      return { status: 200, ok: true, text: async () => '{"id":"ok"}' };
    },
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.success, true, 'the booking itself is still delivered');
  assert.equal(body.customerMail.sent, false);
  assert.equal(body.customerMail.status, 'failed');
  assert.match(body.customerMail.error, /sender not verified/);
});

test('the kill switch still answers 200 and says why no confirmation went out', async () => {
  const captured = [];
  const res = await handleBookingRequest(postEvent(BOOKING), {
    env: { BREVO_API_KEY: 'xkeysib-test', [CONFIRMATION_ENV_VAR]: 'off' },
    fetchImpl: okFetch(captured),
  });

  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.success, true);
  assert.equal(body.customerMail.status, 'disabled');
  assert.equal(body.customerMail.sent, false);
  assert.equal(captured.length, 1, 'only the company mail was sent');
});
