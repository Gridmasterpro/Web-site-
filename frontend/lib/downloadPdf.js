/**
 * Browser-side PDF download for the booking receipt.
 *
 * shared/bookingPdf.mjs builds the receipt as a latin-1 string (char codes
 * ≤ 0xFF); here we turn it into bytes, a Blob and an `<a download>` click.
 * No libraries — the whole receipt pipeline stays dependency-free.
 */

import { buildBookingReceiptPdf, receiptFileName } from '../../shared/bookingPdf.mjs';
import { bookingPayloadToReceiptModel } from '../../shared/receiptModel.mjs';
import { COMPANY_INFO } from '../data/solarData';

/** latin-1 PDF string → Uint8Array of raw bytes. */
export function pdfStringToBytes(pdf) {
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i += 1) bytes[i] = pdf.charCodeAt(i);
  return bytes;
}

/**
 * Build the branded receipt for a submitted booking payload. The company
 * identity comes from the site's single source of truth (COMPANY_INFO).
 * @returns {{pdf: string, filename: string}}
 */
export function buildReceiptPdfFromPayload(payload, { status } = {}) {
  const model = bookingPayloadToReceiptModel(payload, {
    createdDate: new Date(),
    status: status || {},
    company: {
      // `name` intentionally omitted — shared/receiptModel's letterhead
      // default "Grid Master Solar Systems" is the printed company name.
      tagline: COMPANY_INFO.tagline,
      email: COMPANY_INFO.email,
      phone: COMPANY_INFO.phoneDisplay,
      address: COMPANY_INFO.address,
    },
  });
  return { pdf: buildBookingReceiptPdf(model), filename: receiptFileName(model.reference) };
}

/** Trigger the browser download. Throws if Blob/object URLs are unavailable. */
export function downloadPdf(pdf, filename) {
  if (typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
    throw new Error('PDF downloads are not supported in this browser.');
  }
  const blob = new Blob([pdfStringToBytes(pdf)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Give the browser a beat to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
