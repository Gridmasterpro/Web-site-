/**
 * One receipt model for both sides of the booking flow.
 *
 * The booking form (frontend/lib/bookingMail.js) builds a flat payload object
 * — `booking_reference`, `customer_name`, … — that is mailed to the company.
 * Two different consumers now need that same information in printable form:
 *
 *   - the browser, to let the customer download a branded PDF receipt
 *     (shared/bookingPdf.mjs), and
 *   - the backend, to attach the identical PDF to the customer's
 *     confirmation e-mail (backend/confirmationMail.mjs).
 *
 * This module is the single normalisation point so the PDF the customer
 * downloads and the PDF arriving in their inbox always match.
 */

/** Company identity printed on the receipt — mirrors COMPANY_INFO on the site. */
export const DEFAULT_COMPANY = {
  name: 'Grid Master Solar Systems',
  tagline: 'Precision Solar Engineering, 3D Array Design & Seamless Grid Integration',
  email: 'contactgridmaster@gmail.com',
  phone: '+91 72007 45180',
  address: 'Solar Tech Park, Suite 402, Clean Energy Corridor, Hyderabad',
};

const text = (value) => (value === undefined || value === null ? '' : String(value));

/** "2026-10-07" → "07 October 2026" (safe fall-back to the raw string). */
export function displayDate(value) {
  const raw = text(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return raw;
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const month = months[Number(match[2]) - 1];
  return month ? `${match[3]} ${month} ${match[1]}` : raw;
}

/**
 * Normalise a booking payload into the model the PDF builder consumes.
 *
 * @param {Object} payload  the booking payload (buildBookingPayload output)
 * @param {Object} [options]
 * @param {Object} [options.company]      overrides for DEFAULT_COMPANY
 * @param {string|Date} [options.createdDate]  stamp on the receipt; Date
 *                                             objects are formatted for India
 * @param {{delivered?: boolean, text?: string}} [options.status]
 *        one quiet status line (e.g. where the booking e-mail was delivered)
 */
export function bookingPayloadToReceiptModel(payload = {}, options = {}) {
  const { company = {}, createdDate, status = {} } = options;

  let issued = text(createdDate).trim();
  if (createdDate instanceof Date && !Number.isNaN(createdDate.getTime())) {
    issued = createdDate.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
  }

  const equipmentLines = text(payload.selected_equipment)
    .split('\n')
    .map((line) => line.replace(/^\s*[-\xB7•]\s*/, '').trim())
    .filter((line) => line !== '');

  return {
    reference: text(payload.booking_reference).trim() || 'GM-SR-000000',
    createdDate: issued,
    customer: {
      name: text(payload.customer_name).trim(),
      phone: text(payload.customer_phone).trim(),
      email: text(payload.customer_email || payload.email).trim(),
      address: text(payload.property_location).trim(),
      notes: text(payload.notes).trim() === 'None provided' ? '' : text(payload.notes).trim(),
    },
    booking: {
      purpose: text(payload.purpose).trim(),
      service: text(payload.service_required).trim(),
      date: displayDate(payload.scheduled_date),
      timeSlot: text(payload.time_slot).trim(),
      engineer: text(payload.lead_engineer).trim(),
    },
    equipment: {
      lines: equipmentLines,
      total: text(payload.equipment_package_total).trim(),
    },
    status: {
      delivered: status.delivered === true,
      text: text(status.text).trim(),
    },
    company: { ...DEFAULT_COMPANY, ...company },
  };
}
