/**
 * Booking backend self-diagnosis — GET /api/booking-health
 *
 * Why this exists
 * ---------------
 * "Bookings are not showing up in the sheet" has half a dozen possible
 * causes, every one of which looks identical from the outside because a
 * Google Apps Script web app answers HTTP 200 even when it wrote nothing.
 * This endpoint turns that guesswork into one URL you can open in a browser.
 *
 *   /api/booking-health              → configuration report only (no writes)
 *   /api/booking-health?selftest=1   → ALSO pings the Apps Script live and
 *                                      reports exactly what came back
 *
 * It is deliberately read-only with respect to the website: nothing here is
 * imported by any page, so the site cannot be affected by it.
 *
 * Secrets are never echoed. The shared secret is reported only as an 8-character
 * fingerprint; the Apps Script reports the fingerprint of *its* copy, so you can
 * confirm the two match without either value ever being shown.
 */

import { fingerprint, inspectWebhookUrl, logBookingToSheet, pingSheet, redactWebhookUrl } from './sheetLogger.mjs';
import { DEFAULT_FROM, DEFAULT_INBOX, resolveProvider, sendBookingMail } from './mailProvider.mjs';
import { customerConfirmationEnabled, sendCustomerConfirmationMail } from './confirmationMail.mjs';
import { bookingPayloadToReceiptModel } from '../shared/receiptModel.mjs';
import { buildBookingReceiptPdf } from '../shared/bookingPdf.mjs';

const asText = (value) => (value === undefined || value === null ? '' : String(value));

// Light throttle so the public self-test cannot be hammered.
const selfTestHits = [];
const mailTestHits = [];
const sendTestHits = [];
const fullTestHits = [];
const SELF_TEST_WINDOW_MS = 30 * 1000;

function throttled(hits, now = Date.now()) {
  while (hits.length && now - hits[0] > SELF_TEST_WINDOW_MS) hits.shift();
  if (hits.length >= 3) return true;
  hits.push(now);
  return false;
}

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body, null, 2),
  };
}

/**
 * Build the configuration half of the report — no network calls.
 */
/** "BREVO_API_KEY=secret1234" → { set: true, tail: '…1234' } — never the value. */
function describeSecret(value) {
  const raw = asText(value).trim();
  return { set: Boolean(raw), length: raw.length, tail: raw ? `…${raw.slice(-4)}` : '' };
}

export function describeConfiguration(env = {}) {
  const webhookUrl = asText(env.GOOGLE_SHEETS_WEBHOOK_URL).trim();
  const secret = asText(env.GOOGLE_SHEETS_SECRET).trim();
  const inspection = inspectWebhookUrl(webhookUrl);
  const provider = resolveProvider(env);

  const keyVarFor = { brevo: 'BREVO_API_KEY', resend: 'RESEND_API_KEY', sendgrid: 'SENDGRID_API_KEY', web3forms: 'WEB3FORMS_KEY' };
  const keyVar = keyVarFor[provider.name];
  const from = asText(env.MAIL_FROM).trim() || DEFAULT_FROM;
  const to = asText(env.MAIL_TO).trim() || DEFAULT_INBOX;

  return {
    sheetLogging: {
      GOOGLE_SHEETS_WEBHOOK_URL: {
        set: Boolean(webhookUrl),
        value: redactWebhookUrl(webhookUrl),
        looksValid: inspection.ok,
        problems: inspection.problems,
        warnings: inspection.warnings,
      },
      GOOGLE_SHEETS_SECRET: {
        set: Boolean(secret),
        length: secret.length,
        fingerprint: fingerprint(secret),
        note: secret
          ? 'This fingerprint must match the one the Apps Script reports under script.secretFingerprint.'
          : 'No secret set here. That is allowed, but then the Apps Script must ALSO have no SHARED_SECRET property.',
      },
    },
    mailRelay: {
      configured: provider.configured,
      provider: provider.name,
      // `from`/`to` are the company's own public contact addresses — not secrets.
      from,
      to,
      customerConfirmation: customerConfirmationEnabled(env) ? 'on' : 'off',
      providerKey: keyVar ? { variable: keyVar, ...describeSecret(env[keyVar]) } : { variable: null, set: false },
      note: provider.configured
        ? 'Booking e-mails AND customer thank-you confirmations are sent from this host. Add ?mailtest=1 to verify the API key (read-only); ?sendtest=1 to send ONE test mail; ?fulltest=1 to run all four booking stages (PDF + sheet row + both mails).'
        : 'No MAIL_* variables set — bookings fall back to FormSubmit for e-mail (which can only reach the company inbox, never the customer). This does NOT affect sheet logging.',
    },
  };
}

/** Turn the raw findings into a plain-English verdict and next action. */
export function summarise(config, selftest) {
  const sheet = config.sheetLogging;

  if (!sheet.GOOGLE_SHEETS_WEBHOOK_URL.set) {
    return {
      status: 'not-configured',
      headline: 'This host has no GOOGLE_SHEETS_WEBHOOK_URL, so no booking can ever reach the sheet.',
      nextAction:
        'Vercel → your project → Settings → Environment Variables → add GOOGLE_SHEETS_WEBHOOK_URL ' +
        '(and GOOGLE_SHEETS_SECRET) for the Production environment, then Deployments → ⋯ → Redeploy. ' +
        'Environment variables only take effect on a NEW deployment.',
    };
  }

  if (!sheet.GOOGLE_SHEETS_WEBHOOK_URL.looksValid) {
    return {
      status: 'bad-url',
      headline: 'The configured webhook URL cannot work as it is.',
      nextAction: sheet.GOOGLE_SHEETS_WEBHOOK_URL.problems.join(' '),
    };
  }

  if (!selftest) {
    return {
      status: 'configured',
      headline: 'Configuration looks right. Add ?selftest=1 to this URL to test the live connection to your sheet.',
      nextAction: 'Open /api/booking-health?selftest=1',
    };
  }

  if (selftest.ok) {
    return {
      status: 'healthy',
      headline: 'The backend reached your Apps Script and it accepted the request. Bookings will be written to the sheet.',
      nextAction: 'Nothing — submit a real booking and the row should appear within a second.',
    };
  }

  return {
    status: 'broken',
    headline: selftest.reason || 'The Apps Script did not accept the request.',
    nextAction: selftest.hint || 'Open the Apps Script editor → Executions to see the failing run.',
  };
}

/**
 * Live, READ-ONLY check of the mail provider API key — calls a "give me my
 * account" endpoint, sends no e-mail, writes nothing. This is the fastest
 * way to tell an invalid-key problem apart from an unverified-sender one.
 */
const BREVO_IP_GATE = /unrecogni[sz]ed ip|authorised_ips|authorized ips|verify a new ip|new ip (address )?(detected|verification)/i;

/**
 * Run THE COMPLETE production pipeline a real booking runs — build the PDF
 * receipt, WRITE one clearly-marked row into the sheet, send the company
 * notification, and send the customer confirmation (with the PDF attached)
 * — then report every stage's verdict. This is the one diagnostic that can
 * answer "mails work in ?sendtest=1 but real bookings fail" mysteries,
 * because it exercises the two things only real bookings do (PDF build,
 * sheet write) plus both mails.
 *
 * Side effects, all labelled HEALTH-CHECK: one sheet row + up to two mails,
 * always addressed to the company inbox — never to a stranger. Throttled.
 */
export async function runFullPipelineDiagnosis({ env = {}, fetchImpl } = {}) {
  const provider = resolveProvider(env);
  const to = provider.to || DEFAULT_INBOX;
  const sample = {
    form_name: 'Grid Master health fulltest',
    customer_name: 'HEALTH-CHECK full test (not a customer)',
    customer_email: to,
    customer_phone: '0000000000',
    service_type: 'Diagnostics — full booking pipeline',
    booking_reference: 'GM-SR-HEALTH-CHK',
    purpose: 'Diagnostics',
    property_location: 'n/a',
    preferred_date: 'n/a',
    preferred_slot: 'n/a',
    details:
      'Artificial booking created by /api/booking-health?fulltest=1 to prove every stage of the real booking ' +
      'pipeline. The sheet row and the mails are marked HEALTH-CHECK and can be ignored or deleted.',
  };

  const stages = {};

  // Stage 1 — PDF receipt: the exact builder real bookings execute. Heavy,
  // and the ONE thing ?sendtest=1 does not cover.
  try {
    const model = bookingPayloadToReceiptModel(sample);
    const pdf = buildBookingReceiptPdf(model);
    const bytes = typeof pdf === 'string' ? pdf.length : (pdf?.byteLength ?? pdf?.length ?? 0);
    stages.pdf = { ok: true, bytes };
  } catch (error) {
    stages.pdf = { ok: false, error: error?.message || String(error) };
  }

  // Stage 2 — Sheet WRITE: pings prove reachability; only this proves an
  // actual row lands. The row is marked so it can be deleted afterwards.
  try {
    const logged = await logBookingToSheet({ booking: sample, env, fetchImpl, clientIp: 'health-fulltest' });
    stages.sheetWrite = {
      attempted: true,
      ok: logged?.ok === true,
      ...(logged?.error ? { error: logged.error } : {}),
      ...(logged?.ok ? { note: 'One row marked HEALTH-CHECK was appended — delete it from the sheet afterwards.' } : {}),
    };
  } catch (error) {
    stages.sheetWrite = { attempted: true, ok: false, error: error?.message || String(error) };
  }

  // Stage 3 — Company booking mail through the production path.
  const company = await sendBookingMail({ booking: sample, env, fetchImpl });
  stages.companyMail = {
    attempted: provider.configured,
    ok: company?.ok === true,
    provider: provider.name,
    to,
    ...(company?.error ? { error: company.error } : {}),
  };

  // Stage 4 — Customer confirmation WITH the generated PDF attached, also
  // addressed to the company inbox so diagnosis never e-mails strangers.
  const confirmation = await sendCustomerConfirmationMail({ booking: sample, env, fetchImpl }).catch((error) => ({
    ok: false,
    provider: provider.name,
    error: error?.message || String(error),
  }));
  stages.customerMail = {
    attempted: provider.configured,
    ok: confirmation?.ok === true,
    provider: provider.name,
    to,
    ...(confirmation?.error ? { error: confirmation.error } : {}),
    ...(confirmation?.reason ? { reason: confirmation.reason } : {}),
  };

  const ok = Boolean(stages.pdf.ok && stages.sheetWrite.ok && stages.companyMail.ok && stages.customerMail.ok);
  return {
    ok,
    note: ok
      ? 'All four stages of a real booking succeeded: PDF built, sheet row written, company mail accepted, customer confirmation (with PDF) accepted. The pipeline is healthy end-to-end.'
      : 'At least one stage failed — the stages below name exactly which one and why (pdf = receipt builder, sheetWrite = the marked test row, companyMail/customerMail = the two mails).',
    stages,
  };
}

/**
 * Send ONE test booking e-mail to the company inbox (MAIL_TO) through the
 * exact production send path — this is what /api/booking does, minus the
 * customer confirmation. Returns the provider's precise answer so a
 * "config looks right but mail never arrives" mystery becomes one readable
 * line. Never throws.
 */
export async function sendSampleBookingMail({ env = {}, fetchImpl } = {}) {
  const provider = resolveProvider(env);
  if (!provider.configured) {
    return { attempted: false, ok: false, provider: 'none', reason: 'No mail provider configured on this host.' };
  }
  const sample = {
    form_name: 'Grid Master health send-test',
    customer_name: 'Health send-test (not a customer)',
    customer_email: provider.to,
    customer_phone: '0000000000',
    service_type: 'Booking mail self-test',
    booking_reference: 'GM-SR-TEST',
    purpose: 'Diagnostics',
    property_location: 'n/a',
    preferred_date: 'n/a',
    preferred_slot: 'n/a',
    details:
      'This test mail was sent by /api/booking-health?sendtest=1 through the exact booking ' +
      'pipeline. If it reached the company inbox, booking e-mails work end-to-end.',
  };
  const result = await sendBookingMail({ booking: sample, env, fetchImpl });
  if (result.ok) {
    return {
      attempted: true,
      ok: true,
      provider: provider.name,
      to: provider.to,
      status: result.status,
      note: 'A test booking e-mail was accepted by the provider — it should land in the company inbox within seconds. If it does, booking mails work end-to-end.',
    };
  }
  if (provider.name === 'brevo' && BREVO_IP_GATE.test(result.error || '')) {
    return {
      attempted: true,
      ok: false,
      provider: provider.name,
      to: provider.to,
      status: result.status,
      reason:
        'Brevo accepted your key for READING but refused the SEND from this server\'s IP. ' +
        'Brevo Security → Authorized IPs: open the "Unauthorized IP addresses" tab, Select All → ' +
        'Authorize (Vercel rotates IPs), and keep the API-keys/SMTP-keys blocking toggles Deactivated. ' +
        `Raw answer: ${result.error}`,
    };
  }
  return {
    attempted: true,
    ok: false,
    provider: provider.name,
    to: provider.to,
    status: result.status,
    reason: result.error || 'The send failed without details.',
  };
}

export async function pingMailProvider({ env = {}, fetchImpl } = {}) {
  const provider = resolveProvider(env);
  if (!provider.configured) {
    return { attempted: false, ok: false, provider: 'none', reason: 'No mail provider configured on this host.' };
  }
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) return { attempted: false, ok: false, provider: provider.name, reason: 'No fetch available.' };

  const checks = {
    brevo: () => ({
      url: 'https://api.brevo.com/v3/account',
      init: { headers: { 'api-key': asText(env.BREVO_API_KEY).trim(), Accept: 'application/json' } },
    }),
    resend: () => ({
      url: 'https://api.resend.com/domains',
      init: { headers: { Authorization: `Bearer ${asText(env.RESEND_API_KEY).trim()}`, Accept: 'application/json' } },
    }),
    sendgrid: () => ({
      url: 'https://api.sendgrid.com/v3/scopes',
      init: { headers: { Authorization: `Bearer ${asText(env.SENDGRID_API_KEY).trim()}`, Accept: 'application/json' } },
    }),
  };

  const check = checks[provider.name];
  if (!check) {
    return {
      attempted: false,
      ok: null,
      provider: provider.name,
      reason: `No read-only key check exists for ${provider.name}. Submit a booking and read the "Show delivery details" line instead.`,
    };
  }

  try {
    const res = await doFetch(check().url, check().init);
    const raw = await res.text().catch(() => '');
    if (res.ok) {
      let accountEmail = '';
      try {
        accountEmail = JSON.parse(raw)?.email || '';
      } catch { /* not needed */ }
      return { attempted: true, ok: true, provider: provider.name, accountEmail, note: 'The API key is valid and accepted.' };
    }
    // Brevo answers 401 for a VALID key when the account's "Authorized IPs"
    // lock is on and this host's IP isn't whitelisted — serverless hosts
    // (Vercel, Netlify) rotate IPs on every redeploy/cold start, so the only
    // cure is disabling the lock (and any "verify new IP" style gate).
    if (provider.name === 'brevo' && /unrecogni[sz]ed ip|authorised_ips|authorized ips|verify a new ip|new ip (address )?(detected|verification)/i.test(raw)) {
      return {
        attempted: true,
        ok: false,
        provider: provider.name,
        status: res.status,
        reason:
          'The Brevo key is VALID, but your account\'s IP security settings (Authorized IPs / verify-new-IP) are blocking this server. ' +
          'Vercel calls from thousands of rotating IPs — a new one after every redeploy — so whitelisting or verifying IPs one-by-one can never work. ' +
          'Open https://app.brevo.com/security/authorised_ips and DISABLE IP authorization (behind "Security" → connection/IP settings), wait a minute, then re-test this URL.',
      };
    }
    return {
      attempted: true,
      ok: false,
      provider: provider.name,
      status: res.status,
      reason:
        res.status === 401 || res.status === 403
          ? `The ${provider.name} API key was refused (HTTP ${res.status}) — regenerate it and update the ${provider.name === 'brevo' ? 'BREVO_API_KEY' : provider.name === 'resend' ? 'RESEND_API_KEY' : 'SENDGRID_API_KEY'} variable, then redeploy.`
          : `The provider answered HTTP ${res.status}: ${raw.slice(0, 160)}`,
    };
  } catch (error) {
    return { attempted: true, ok: false, provider: provider.name, reason: error?.message || String(error) };
  }
}

/**
 * Handle a GET /api/booking-health request.
 * Shape mirrors `handleBookingRequest` so both hosts can reuse it.
 */
export async function handleBookingHealthRequest(event, { env = {}, fetchImpl } = {}) {
  const method = (event.httpMethod || event.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return json(405, { ok: false, error: 'Use GET for the health check.' });
  }

  const query = event.queryStringParameters || event.query || {};
  const flagOn = (value) => ['1', 'true', 'yes'].includes(asText(value).toLowerCase());
  const wantsSelfTest = flagOn(query.selftest);
  const wantsMailTest = flagOn(query.mailtest);
  const wantsSendTest = flagOn(query.sendtest);
  const wantsFullTest = flagOn(query.fulltest);

  const configuration = describeConfiguration(env);

  let selftest = null;
  if (wantsSelfTest) {
    if (throttled(selfTestHits)) {
      selftest = { attempted: false, ok: false, reason: 'Self-test is throttled — wait 30 seconds and retry.' };
    } else {
      selftest = await pingSheet({ env, fetchImpl }).catch((error) => ({
        attempted: true,
        ok: false,
        reason: error?.message || String(error),
      }));
    }
  }

  let mailtest = null;
  if (wantsMailTest) {
    if (throttled(mailTestHits)) {
      mailtest = { attempted: false, ok: false, reason: 'Mail key check is throttled — wait 30 seconds and retry.' };
    } else {
      mailtest = await pingMailProvider({ env, fetchImpl }).catch((error) => ({
        attempted: true,
        ok: false,
        reason: error?.message || String(error),
      }));
    }
  }

  let sendtest = null;
  if (wantsSendTest) {
    if (throttled(sendTestHits)) {
      sendtest = { attempted: false, ok: false, reason: 'Send test is throttled — wait 30 seconds and retry.' };
    } else {
      sendtest = await sendSampleBookingMail({ env, fetchImpl }).catch((error) => ({
        attempted: true,
        ok: false,
        reason: error?.message || String(error),
      }));
    }
  }

  let fulltest = null;
  if (wantsFullTest) {
    if (throttled(fullTestHits)) {
      fulltest = { attempted: false, ok: false, reason: 'Full pipeline test is throttled — wait 30 seconds and retry.' };
    } else {
      fulltest = await runFullPipelineDiagnosis({ env, fetchImpl }).catch((error) => ({
        attempted: true,
        ok: false,
        reason: error?.message || String(error),
      }));
    }
  }

  const verdict = summarise(configuration, selftest);

  return json(200, {
    service: 'Grid Master booking backend',
    checkedAt: new Date().toISOString(),
    // Which build answers this URL — invaluable when juggling preview URLs:
    // a change of environment variables only ever reaches a NEW deployment,
    // so the commit shown here must be at least as new as the variable edit.
    deployment: {
      environment: asText(env.VERCEL_ENV).trim() || 'unknown',
      commit: asText(env.VERCEL_GIT_COMMIT_SHA).trim().slice(0, 7) || 'unknown',
    },
    verdict,
    configuration,
    selftest,
    mailtest,
    sendtest,
    fulltest,
    docs: 'docs/customer-bookings-sheet-setup.md',
  });
}

export default handleBookingHealthRequest;
