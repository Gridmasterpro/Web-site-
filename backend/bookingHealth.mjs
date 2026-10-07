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

import { fingerprint, inspectWebhookUrl, pingSheet, redactWebhookUrl } from './sheetLogger.mjs';
import { DEFAULT_FROM, DEFAULT_INBOX, resolveProvider } from './mailProvider.mjs';
import { customerConfirmationEnabled } from './confirmationMail.mjs';

const asText = (value) => (value === undefined || value === null ? '' : String(value));

// Light throttle so the public self-test cannot be hammered.
const selfTestHits = [];
const mailTestHits = [];
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
        ? 'Booking e-mails AND customer thank-you confirmations are sent from this host. Add ?mailtest=1 to this URL to verify the API key live (read-only, sends nothing).'
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

  const verdict = summarise(configuration, selftest);

  return json(200, {
    service: 'Grid Master booking backend',
    checkedAt: new Date().toISOString(),
    verdict,
    configuration,
    selftest,
    mailtest,
    docs: 'docs/customer-bookings-sheet-setup.md',
  });
}

export default handleBookingHealthRequest;
