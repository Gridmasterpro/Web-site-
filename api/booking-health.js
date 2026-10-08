/**
 * Vercel serverless function: GET /api/booking-health
 *
 * Read-only diagnosis of the booking → Google Sheet pipeline. Open it in a
 * browser to see whether this host is configured, and add `?selftest=1` to
 * have the backend talk to your Apps Script and report exactly what came back.
 *
 * No secret is ever included in the response — only an 8-character fingerprint
 * used to confirm that Vercel and Apps Script hold the same value.
 */

import { handleBookingHealthRequest } from '../backend/bookingHealth.mjs';

export default async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers?.host || 'localhost'}`);
  const queryStringParameters = Object.fromEntries(url.searchParams.entries());

  const result = await handleBookingHealthRequest(
    { httpMethod: req.method, headers: req.headers || {}, queryStringParameters },
    { env: process.env }
  );

  res.status(result.statusCode);
  Object.entries(result.headers).forEach(([key, value]) => res.setHeader(key, value));
  res.send(result.body);
}
