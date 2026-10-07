/**
 * Netlify function: GET /.netlify/functions/booking-health
 *
 * Same read-only diagnosis as `api/booking-health.js` on Vercel.
 * `netlify.toml` also exposes it at /api/booking-health so one URL works
 * on both hosts.
 */

import { handleBookingHealthRequest } from '../../backend/bookingHealth.mjs';

export async function handler(event) {
  const result = await handleBookingHealthRequest(event, { env: process.env });
  return {
    statusCode: result.statusCode,
    headers: result.headers,
    body: result.body,
  };
}

export default handler;
