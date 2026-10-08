/**
 * Customer thank-you / confirmation mail.
 *
 * The moment a booking is accepted, the customer receives a mail FROM THE
 * COMPANY (the configured MAIL_FROM sender) that:
 *
 *   - thanks them by name,
 *   - states exactly which team member visits, on which date and time slot,
 *   - attaches their official booking receipt as a branded PDF — the very
 *     same file the website offers as a download (shared/bookingPdf.mjs), and
 *   - tells them how to prepare and how to reach us.
 *
 * Provider notes
 * --------------
 * Brevo / Resend / SendGrid / a custom webhook can all carry a base64 PDF
 * attachment to an arbitrary recipient. Web3Forms cannot — it only ever mails
 * the site owner — so confirmations are reported as `unsupported` there and
 * the booking itself is unaffected.
 *
 * Kill switch: set CUSTOMER_CONFIRMATION_EMAIL=off to stop sending these
 * without touching anything else.
 */

import { buildBookingReceiptPdf, pdfToBase64, receiptFileName } from '../shared/bookingPdf.mjs';
import { bookingPayloadToReceiptModel, DEFAULT_COMPANY } from '../shared/receiptModel.mjs';
import { DEFAULT_INBOX, resolveProvider, sendProviderMail } from './mailProvider.mjs';

export const CONFIRMATION_ENV_VAR = 'CUSTOMER_CONFIRMATION_EMAIL';

const asText = (value) => (value === undefined || value === null ? '' : String(value));
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** CUSTOMER_CONFIRMATION_EMAIL=off (or 0/false/no) disables the feature. */
export function customerConfirmationEnabled(env = {}) {
  const raw = asText(env[CONFIRMATION_ENV_VAR]).trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

const escapeHtml = (value) =>
  asText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function firstName(fullName) {
  const first = asText(fullName).trim().split(/\s+/)[0];
  return first || 'there';
}

/**
 * Build the customer-facing mail (subject, text, HTML, PDF attachment).
 *
 * @param {Object} booking the booking payload the website submitted
 * @param {Object} [options]
 * @param {string} [options.companyInbox]  mail sent from / replied-to inbox
 * @param {Date}   [options.now]           issue date stamped on the PDF
 * @param {Object} [options.company]       identity overrides (tests)
 */
export function renderCustomerConfirmationMail(booking = {}, options = {}) {
  const { companyInbox = DEFAULT_INBOX, now = new Date(), company = {} } = options;
  const model = bookingPayloadToReceiptModel(booking, { createdDate: now, company });
  const { reference } = model;
  const name = firstName(model.customer.name);
  const filename = receiptFileName(reference);

  const summary = [
    ['Booking reference', reference],
    ['Service', model.booking.service],
    ['Scope', model.booking.purpose],
    ['Site visit date', model.booking.date],
    ['Time slot', model.booking.timeSlot],
    ['Team member visiting', model.booking.engineer],
    ['Property address', model.customer.address],
    ...(model.equipment.lines.length
      ? [['Equipment package', `${model.equipment.lines.length} item(s)${model.equipment.total ? ` — ${model.equipment.total}` : ''}`]]
      : []),
  ].filter(([, value]) => asText(value).trim() !== '');

  const subject = `Thank you ${name} — Booking Confirmed [${reference}] — site visit on ${model.booking.date || 'your chosen date'}`;

  const textBody = [
    'GRID MASTER SOLAR SYSTEMS — BOOKING CONFIRMATION',
    '================================================',
    '',
    `Dear ${name},`,
    '',
    `Thank you for booking with ${model.company.name}! Your request has been received`,
    'and your site visit is scheduled as follows:',
    '',
    ...summary.map(([label, value]) => `  ${label.padEnd(22)} : ${value}`),
    '',
    `Our team member ${model.booking.engineer || 'from the Grid Master engineering team'} will visit your`,
    `property on ${model.booking.date || 'the scheduled date'} between ${model.booking.timeSlot || 'the scheduled slot'}.`,
    'Please keep the installation area accessible and a recent electricity bill handy.',
    '',
    `Your official booking receipt is attached to this e-mail as a PDF file`,
    `(${filename}). Please keep it safe and quote your booking reference in all`,
    'communication with us.',
    '',
    'What happens next:',
    '  1. Our team calls you within 24 hours to confirm this booking.',
    '  2. Free site audit and a 3D CAD design of your solar layout.',
    '  3. You receive a fixed, transparent quote before installation begins.',
    '',
    `Need to change anything? Reply to this e-mail or call ${model.company.phone}.`,
    '',
    'Warm regards,',
    'Team Grid Master Solar Systems',
    `${model.company.email}  |  ${model.company.phone}`,
    model.company.address,
  ].join('\n');

  const summaryRows = summary
    .map(
      ([label, value], index) => `<tr>
        <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;background:${index % 2 ? '#f8fafc' : '#ffffff'};color:#475569;font-weight:600;width:40%;font-size:13px">${escapeHtml(label)}</td>
        <td style="padding:9px 14px;border-bottom:1px solid #e2e8f0;background:${index % 2 ? '#f8fafc' : '#ffffff'};color:#0f172a;font-size:13px">${escapeHtml(value)}</td>
      </tr>`
    )
    .join('');

  const htmlBody = `<!doctype html><html><body style="margin:0;background:#f1f5f9;padding:24px;font-family:Segoe UI,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">
    <tr><td style="background:#0f172a;padding:24px 28px;border-bottom:3px solid #f59e0b">
      <p style="margin:0;color:#fbbf24;font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700">Grid Master Solar Systems</p>
      <h1 style="margin:8px 0 0;color:#ffffff;font-size:22px">Booking Confirmed — Thank You!</h1>
      <p style="margin:8px 0 0;color:#94a3b8;font-size:12px">Reference <strong style="color:#fbbf24">${escapeHtml(reference)}</strong></p>
    </td></tr>
    <tr><td style="padding:24px 28px 8px">
      <p style="margin:0 0 12px;font-size:14px;color:#0f172a">Dear <strong>${escapeHtml(name)}</strong>,</p>
      <p style="margin:0 0 18px;font-size:13.5px;line-height:1.6;color:#334155">Thank you for choosing <strong>Grid Master Solar Systems</strong>. Your booking is confirmed and our team member will visit your property at the time you selected:</p>

      <table role="presentation" width="100%" style="border-collapse:collapse;background:#ecfdf5;border:1px solid #10b981;border-radius:12px;margin:0 0 18px">
        <tr><td style="padding:16px 18px">
          <p style="margin:0;color:#047857;font-size:11px;font-weight:700;letter-spacing:.08em">SITE VISIT SCHEDULED</p>
          <p style="margin:6px 0 0;color:#0f172a;font-size:14px;font-weight:700">${escapeHtml(model.booking.engineer || 'Grid Master engineering team')}</p>
          <p style="margin:4px 0 0;color:#334155;font-size:13px">${escapeHtml(model.booking.date)} &middot; ${escapeHtml(model.booking.timeSlot)}</p>
        </td></tr>
      </table>

      <table role="presentation" width="100%" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;margin:0 0 18px">
        ${summaryRows}
      </table>

      <table role="presentation" width="100%" style="border-collapse:collapse;background:#fffbeb;border:1px solid #f59e0b;border-radius:12px;margin:0 0 18px">
        <tr><td style="padding:14px 18px;font-size:13px;color:#334155;line-height:1.55">
          <strong style="color:#b45309">PDF receipt attached:</strong> your official booking receipt is attached to this e-mail
          (<strong>${escapeHtml(filename)}</strong>). Please keep it safe and quote your reference in all communication with us.
        </td></tr>
      </table>

      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#0f172a">What happens next</p>
      <table role="presentation" width="100%" style="border-collapse:collapse;font-size:13px;color:#334155">
        <tr><td style="padding:4px 0">1.&nbsp; Our team calls you within 24 hours to confirm this booking.</td></tr>
        <tr><td style="padding:4px 0">2.&nbsp; Free site audit and a 3D CAD design of your solar layout.</td></tr>
        <tr><td style="padding:4px 0">3.&nbsp; You receive a fixed, transparent quote before installation begins.</td></tr>
      </table>

      <p style="margin:18px 0 0;font-size:13px;color:#334155;line-height:1.6">Need to change the date or time? Just reply to this e-mail or call
      <strong>${escapeHtml(model.company.phone)}</strong> — we are happy to help.</p>
      <p style="margin:14px 0 24px;font-size:13px;color:#334155">Warm regards,<br/><strong>Team ${escapeHtml(model.company.name)}</strong></p>
    </td></tr>
    <tr><td style="background:#0f172a;padding:16px 28px">
      <p style="margin:0;color:#cbd5e1;font-size:11.5px">${escapeHtml(model.company.email)} &nbsp;&middot;&nbsp; ${escapeHtml(model.company.phone)}</p>
      <p style="margin:4px 0 0;color:#64748b;font-size:11px">${escapeHtml(model.company.address)}</p>
    </td></tr>
  </table>
</body></html>`;

  const pdf = buildBookingReceiptPdf(model);

  return {
    subject,
    textBody,
    htmlBody,
    to: model.customer.email,
    replyTo: companyInbox || model.company.email,
    // The customer-facing mail shows the branded sender name, not "Website".
    fromName: model.company.name,
    attachments: [
      {
        filename,
        contentType: 'application/pdf',
        contentBase64: pdfToBase64(pdf),
      },
    ],
  };
}

/**
 * Send the thank-you mail to the customer through the configured provider.
 * Never throws — a failure here must never break the booking itself.
 *
 * @returns {Promise<{configured: boolean, ok: boolean, skipped?: boolean, status?: string,
 *                    provider: string, to?: string, error?: string, reason?: string}>}
 */
export async function sendCustomerConfirmationMail({ booking = {}, env = {}, fetchImpl } = {}) {
  const provider = resolveProvider(env);
  if (!provider.configured) {
    return { configured: false, ok: false, provider: provider.name, reason: provider.reason };
  }
  if (!customerConfirmationEnabled(env)) {
    return { configured: true, ok: false, skipped: true, provider: provider.name, reason: `disabled by ${CONFIRMATION_ENV_VAR}` };
  }
  if (provider.canChooseRecipient === false) {
    return {
      configured: true,
      ok: false,
      skipped: true,
      provider: provider.name,
      reason: `${provider.name} can only deliver mail to the site owner — it cannot e-mail the customer. Use Brevo, Resend or SendGrid for customer confirmations.`,
    };
  }

  const recipient = asText(booking.customer_email || booking.email).trim();
  if (!VALID_EMAIL.test(recipient)) {
    return { configured: true, ok: false, skipped: true, provider: provider.name, reason: 'no valid customer e-mail on the booking' };
  }

  const mail = renderCustomerConfirmationMail(booking, { companyInbox: provider.to });
  mail.to = recipient;
  mail.replyTo = provider.to;

  const result = await sendProviderMail(provider, mail, booking, { fetchImpl });
  return { ...result, to: recipient };
}

/**
 * Compact label for the HTTP response so the website can tell the customer
 * exactly what happened to their confirmation mail.
 */
export function confirmationStatus(result) {
  if (!result || typeof result !== 'object') return 'unknown';
  if (result.ok) return 'sent';
  if (result.skipped) {
    if (/disabled by/.test(result.reason || '')) return 'disabled';
    if (/only deliver mail to the site owner/.test(result.reason || '')) return 'unsupported';
    return 'skipped';
  }
  return 'failed';
}
