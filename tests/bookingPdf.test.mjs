/**
 * Tests for the branded booking receipt PDF (shared/bookingPdf.mjs) and the
 * model normalisation (shared/receiptModel.mjs) that feeds it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBookingReceiptPdf,
  sanitizePdfText,
  wrapText,
  estimateTextWidth,
  receiptFileName,
  pdfToBase64,
  PDF_PAGE,
} from '../shared/bookingPdf.mjs';
import { bookingPayloadToReceiptModel, displayDate, DEFAULT_COMPANY } from '../shared/receiptModel.mjs';

const PAYLOAD = {
  booking_reference: 'GM-SR-424242',
  customer_name: 'Bollapelly Meghana',
  customer_phone: '9391103814',
  customer_email: 'meghana@example.com',
  property_location: '12-34, Gandhi Road, Jayashankar Bhupalapally, Telangana 506169',
  purpose: 'Home (Residential)',
  service_required: 'Full Package (Design + Install + Grid Integration)',
  lead_engineer: 'GANDHAMANENI GOUTHAM (Head Engineer - Solar & Electrical)',
  scheduled_date: '2026-10-12',
  time_slot: '09:00 AM - 11:00 AM',
  notes: 'Roof size 900 sq ft',
  selected_equipment: '  - 550W Mono PERC Solar Panel x10 (₹14,500 / panel)\n  - 8 kW Hybrid Inverter x1 (₹85,000 / unit)',
  equipment_package_total: '₹2,30,000 (≈ $2,706)',
};

const modelFor = (payload = PAYLOAD, options = {}) =>
  bookingPayloadToReceiptModel(payload, {
    createdDate: '07 October 2026',
    status: { delivered: true, text: 'Booking e-mailed to the company.' },
    ...options,
  });

/* ------------------------------------------------------------------ */
/* text hygiene                                                        */
/* ------------------------------------------------------------------ */

test('sanitizePdfText rewrites the rupee sign and fancy punctuation', () => {
  assert.equal(sanitizePdfText('₹2,30,000'), 'Rs. 2,30,000');
  assert.equal(sanitizePdfText('≈ $2,706'), '~ $2,706');
  assert.equal(sanitizePdfText('em—dash en–dash “quotes” …'), 'em-dash en-dash "quotes" ...');
  assert.equal(sanitizePdfText('plain ASCII stays'), 'plain ASCII stays');
  assert.equal(sanitizePdfText(null), '');
});

test('wrapText breaks long values into fitting lines', () => {
  const long = 'twelve ' .repeat(60);
  const lines = wrapText(long, { size: 9.5, maxWidth: 200 });
  assert.ok(lines.length > 3, 'wrapped into multiple lines');
  for (const line of lines) {
    assert.ok(estimateTextWidth(line, 9.5) <= 200, `line fits: "${line}"`);
  }
  assert.deepEqual(wrapText('', { size: 10, maxWidth: 100 }), []);
});

/* ------------------------------------------------------------------ */
/* model normalisation                                                 */
/* ------------------------------------------------------------------ */

test('the receipt model maps every payload field', () => {
  const model = modelFor();
  assert.equal(model.reference, 'GM-SR-424242');
  assert.equal(model.createdDate, '07 October 2026');
  assert.equal(model.customer.name, 'Bollapelly Meghana');
  assert.equal(model.customer.email, 'meghana@example.com');
  assert.equal(model.booking.date, '12 October 2026');
  assert.equal(model.booking.timeSlot, '09:00 AM - 11:00 AM');
  assert.deepEqual(model.equipment.lines, [
    '550W Mono PERC Solar Panel x10 (₹14,500 / panel)',
    '8 kW Hybrid Inverter x1 (₹85,000 / unit)',
  ]);
  assert.equal(model.equipment.total, '₹2,30,000 (≈ $2,706)');
  assert.equal(model.company.name, DEFAULT_COMPANY.name);
  assert.equal(model.status.delivered, true);
});

test('a booking without equipment or notes stays tidy', () => {
  const { selected_equipment, equipment_package_total, notes, ...bare } = PAYLOAD;
  const model = modelFor({ ...bare, notes: 'None provided' });
  assert.deepEqual(model.equipment.lines, []);
  assert.equal(model.equipment.total, '');
  assert.equal(model.customer.notes, '');
});

test('displayDate formats ISO dates for humans and keeps anything else', () => {
  assert.equal(displayDate('2026-10-12'), '12 October 2026');
  assert.equal(displayDate('12 Oct 2026'), '12 Oct 2026');
  assert.equal(displayDate(''), '');
});

test('a Date object issue date is formatted for India', () => {
  const model = bookingPayloadToReceiptModel(PAYLOAD, { createdDate: new Date('2026-10-07T10:00:00Z') });
  assert.match(model.createdDate, /October 2026/);
});

/* ------------------------------------------------------------------ */
/* the PDF document itself                                             */
/* ------------------------------------------------------------------ */

test('the PDF is a structurally valid document', () => {
  const pdf = buildBookingReceiptPdf(modelFor());

  assert.ok(pdf.startsWith('%PDF-1.4'), 'PDF header');
  assert.ok(pdf.endsWith('%%EOF\n'), 'EOF marker');
  assert.match(pdf, /\/Type \/Catalog/);
  assert.match(pdf, /\/Count 1/, 'a full booking fits on one page');

  // Every byte must fit in latin-1 so Buffer.from(pdf, 'latin1') is exact.
  const maxCode = Math.max(...pdf.split('').map((c) => c.charCodeAt(0)));
  assert.ok(maxCode <= 255, `max charCode ${maxCode} ≤ 255`);

  // The cross-reference table must point at real "N 0 obj" lines.
  const xrefAt = pdf.lastIndexOf('startxref');
  const start = Number(pdf.slice(xrefAt).match(/startxref\s+(\d+)/)[1]);
  assert.ok(pdf.slice(start).startsWith('xref'), 'startxref points at the xref table');
});

test('the PDF contains all customer-visible booking details', () => {
  const pdf = buildBookingReceiptPdf(modelFor());
  for (const needle of [
    'GM-SR-424242',
    'Bollapelly Meghana',
    '9391103814',
    'meghana@example.com',
    '12 October 2026',
    '09:00 AM - 11:00 AM',
    'GANDHAMANENI GOUTHAM',
    'SITE VISIT SCHEDULED',
    'Rs. 2,30,000', // ₹ re-encoded for the PDF font
    'contactgridmaster@gmail.com',
  ]) {
    assert.ok(pdf.includes(needle), `receipt mentions ${needle}`);
  }
});

test('the generator is deterministic for the same input', () => {
  assert.equal(buildBookingReceiptPdf(modelFor()), buildBookingReceiptPdf(modelFor()));
});

test('very long equipment lists paginate instead of overflowing', () => {
  const equipment = Array.from(
    { length: 40 },
    (_, i) => `  - Solar Component ${i + 1} x${i + 2} (₹${(i + 1) * 1000} / unit)`
  ).join('\n');
  const pdf = buildBookingReceiptPdf(modelFor({ ...PAYLOAD, selected_equipment: equipment }));
  const pages = Number(pdf.match(/\/Count (\d+)/)[1]);
  assert.ok(pages >= 2, 'multi-page receipt');
  // Parentheses are escaped inside PDF literal strings: \(continued\).
  assert.match(pdf, /Booking receipt \\\(continued\\\)/);
});

test('receiptFileName is safe for every filesystem', () => {
  assert.equal(receiptFileName('GM-SR-424242'), 'GridMaster_Booking_GM-SR-424242.pdf');
  assert.equal(receiptFileName('we/ref#1'), 'GridMaster_Booking_weref1.pdf');
});

test('pdfToBase64 round-trips to the document start', () => {
  const pdf = buildBookingReceiptPdf(modelFor());
  const b64 = pdfToBase64(pdf);
  assert.equal(Buffer.from(b64, 'base64').subarray(0, 8).toString('latin1'), '%PDF-1.4');
});

test('A4 page geometry is exported for layout sanity checks', () => {
  assert.ok(Math.abs(PDF_PAGE.width - 595.28) < 0.01);
  assert.ok(Math.abs(PDF_PAGE.height - 841.89) < 0.01);
});
