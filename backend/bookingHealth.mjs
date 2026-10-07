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
import { resolveProvider } from './mailProvider.mjs';

const asText = (value) => (value === undefined || value === null ? '' : String(value));

// Light throttle so the public self-test cannot be hammered.
const selfTestHits = [];
const SELF_TEST_WINDOW_MS = 30 * 1000;

function selfTestThrottled(now = Date.now()) {
  while (selfTestHits.length && now - selfTestHits[0] > SELF_TEST_WINDOW_MS) selfTestHits.shift();
  if (selfTestHits.length >= 3) return true;
  selfTestHits.push(now);
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
export function describeConfiguration(env = {}) {
  const webhookUrl = asText(env.GOOGLE_SHEETS_WEBHOOK_URL).trim();
  const secret = asText(env.GOOGLE_SHEETS_SECRET).trim();
  const inspection = inspectWebhookUrl(webhookUrl);
  const provider = resolveProvider(env);

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
      note: provider.configured
        ? 'Booking e-mails are sent from this host.'
        : 'No MAIL_* variables set — bookings fall back to FormSubmit for e-mail. This does NOT affect sheet logging.',
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
 * Handle a GET /api/booking-health request.
 * Shape mirrors `handleBookingRequest` so both hosts can reuse it.
 */
export async function handleBookingHealthRequest(event, { env = {}, fetchImpl } = {}) {
  const method = (event.httpMethod || event.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return json(405, { ok: false, error: 'Use GET for the health check.' });
  }

  const query = event.queryStringParameters || event.query || {};
  const wantsSelfTest = ['1', 'true', 'yes'].includes(asText(query.selftest).toLowerCase());

  const configuration = describeConfiguration(env);

  let selftest = null;
  if (wantsSelfTest) {
    if (selfTestThrottled()) {
      selftest = { attempted: false, ok: false, reason: 'Self-test is throttled — wait 30 seconds and retry.' };
    } else {
      selftest = await pingSheet({ env, fetchImpl }).catch((error) => ({
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
    docs: 'docs/customer-bookings-sheet-setup.md',
  });
}

export default handleBookingHealthRequest;
