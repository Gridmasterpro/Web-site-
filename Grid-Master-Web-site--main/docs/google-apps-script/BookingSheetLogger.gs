/**
 * Grid Master — Customer Booking Sheet Logger
 * ============================================
 * Paste this whole file into the Apps Script editor that is bound to your
 * Google Sheet (Extensions → Apps Script). Full click-by-click setup steps
 * are in ../customer-bookings-sheet-setup.md — do not skip Step 3 there
 * (setting the SHARED_SECRET script property) or anyone who finds your
 * deployment URL could write junk rows into your sheet.
 *
 * What it does
 * ------------
 * Your website's backend POSTs one JSON booking per customer to the URL this
 * script is deployed at. doPost() appends it as a new row at the bottom of
 * the "Bookings" sheet, creating the header row the first time it runs.
 * Nothing else on your site changes — this script only ever receives data,
 * it never calls back into your website.
 */

const SHEET_NAME = 'Bookings';

const COLUMNS = [
  ['timestamp', 'Received At'],
  ['booking_reference', 'Booking Reference'],
  ['customer_name', 'Customer Name'],
  ['customer_phone', 'Phone Number'],
  ['customer_email', 'Email Address'],
  ['property_location', 'Property Address'],
  ['purpose', 'Purpose'],
  ['service_required', 'Service Required'],
  ['lead_engineer', 'Lead Engineer'],
  ['scheduled_date', 'Scheduled Audit Date'],
  ['time_slot', 'Time Slot'],
  ['notes', 'Special Notes'],
  ['selected_equipment', 'Selected Equipment'],
  ['equipment_package_total', 'Equipment Package Total'],
  ['source_ip', 'Source IP'],
];

function doPost(e) {
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    const expectedSecret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (expectedSecret && payload.secret !== expectedSecret) {
      return respond({ ok: false, error: 'Invalid secret.' }, 401);
    }

    const booking = payload.booking && typeof payload.booking === 'object' ? payload.booking : payload;
    const sheet = getOrCreateSheet();
    const row = COLUMNS.map(([key]) =>
      key === 'timestamp' ? booking.timestamp || new Date().toISOString() : booking[key] || ''
    );
    sheet.appendRow(row);

    return respond({ ok: true });
  } catch (error) {
    return respond({ ok: false, error: String(error && error.message ? error.message : error) }, 500);
  }
}

/** Lets you open the deployment URL in a browser to confirm it is alive. */
function doGet() {
  return respond({ ok: true, message: 'Grid Master booking logger is running. POST a booking to log it.' });
}

function getOrCreateSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS.map(([, label]) => label));
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
  }
  return sheet;
}

function respond(data, status) {
  const output = ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
  // ContentService web apps cannot set a custom HTTP status code; the JSON
  // body's `ok` field is what the caller actually checks.
  return output;
}
