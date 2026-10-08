/**
 * Grid Master — Customer Booking Sheet Logger   (version 2)
 * ==========================================================
 * Paste this whole file into the Apps Script editor that is bound to your
 * Google Sheet (Extensions → Apps Script), replacing anything already there.
 * Full click-by-click setup is in ../customer-bookings-sheet-setup.md.
 *
 * What it does
 * ------------
 * Your website's backend POSTs one JSON booking per customer to the URL this
 * script is deployed at. doPost() appends it as a new row at the bottom of
 * the "Bookings" sheet, creating the header row the first time it runs.
 * Nothing else on your site changes — this script only ever receives data,
 * it never calls back into your website.
 *
 * What is new in version 2
 * ------------------------
 *  1. `mode:"ping"` — a dry run. /api/booking-health?selftest=1 uses it to
 *     prove the whole chain works WITHOUT adding a junk row to your sheet.
 *  2. Secret fingerprinting. The script reports an 8-character fingerprint of
 *     the secret it holds, so you can confirm it matches the one in Vercel
 *     without either value ever being displayed. This is the single most
 *     common reason rows stop appearing.
 *  3. Honest replies. A rejected write now says exactly why, and the website
 *     backend surfaces that instead of reporting a false success.
 *  4. `setupBookingSheet()` — run it once from the editor to create the sheet
 *     and headers and to confirm the script can actually write.
 */

const SHEET_NAME = 'Bookings';
const SCRIPT_VERSION = 2;

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

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

function doPost(e) {
  try {
    var payload = {};
    try {
      payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (parseError) {
      return respond({ ok: false, error: 'Request body was not valid JSON.', version: SCRIPT_VERSION });
    }

    // The secret may arrive in the JSON body or as a ?secret= query parameter.
    var provided = payload.secret;
    if (provided === undefined && e && e.parameter && e.parameter.secret) {
      provided = e.parameter.secret;
    }

    var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    var expectedFingerprint = fingerprint(expected);

    if (expected && String(provided || '') !== String(expected)) {
      return respond({
        ok: false,
        error: 'Invalid secret.',
        version: SCRIPT_VERSION,
        secretConfigured: true,
        secretFingerprint: expectedFingerprint,
        receivedFingerprint: fingerprint(provided),
        hint:
          'The SHARED_SECRET script property does not match GOOGLE_SHEETS_SECRET in Vercel. ' +
          'Make both identical (no quotes, no trailing spaces) and redeploy the site.',
      });
    }

    // ---- Dry run: prove the chain works without writing a row -------------
    if (payload.mode === 'ping') {
      var probe = getOrCreateSheet();
      return respond({
        ok: true,
        mode: 'ping',
        version: SCRIPT_VERSION,
        spreadsheetName: probe.getParent().getName(),
        sheetName: probe.getName(),
        dataRows: Math.max(0, probe.getLastRow() - 1),
        secretConfigured: Boolean(expected),
        secretFingerprint: expectedFingerprint,
        message: 'Connection is healthy. No row was written (ping mode).',
      });
    }

    // ---- Real booking ------------------------------------------------------
    var booking = payload.booking && typeof payload.booking === 'object' ? payload.booking : payload;
    var sheet = getOrCreateSheet();
    var row = COLUMNS.map(function (column) {
      var key = column[0];
      if (key === 'timestamp') return booking.timestamp || new Date().toISOString();
      return booking[key] === undefined || booking[key] === null ? '' : booking[key];
    });
    sheet.appendRow(row);

    return respond({
      ok: true,
      mode: 'append',
      version: SCRIPT_VERSION,
      sheetName: sheet.getName(),
      rowNumber: sheet.getLastRow(),
      secretFingerprint: expectedFingerprint,
    });
  } catch (error) {
    return respond({
      ok: false,
      version: SCRIPT_VERSION,
      error: String(error && error.message ? error.message : error),
      hint: 'Open the Apps Script editor → Executions for the full stack trace.',
    });
  }
}

/**
 * Lets you open the deployment URL in a browser to confirm it is alive.
 * If you see this JSON when you paste the /exec URL into a browser tab while
 * signed OUT (or in an incognito window), the deployment access setting is
 * correct. If you see a Google sign-in page instead, re-deploy with
 * "Who has access" = Anyone.
 */
function doGet() {
  var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  var info = { ok: true, version: SCRIPT_VERSION, message: 'Grid Master booking logger is running.' };
  try {
    var sheet = getOrCreateSheet();
    info.spreadsheetName = sheet.getParent().getName();
    info.sheetName = sheet.getName();
    info.dataRows = Math.max(0, sheet.getLastRow() - 1);
  } catch (error) {
    info.ok = false;
    info.error = String(error && error.message ? error.message : error);
  }
  info.secretConfigured = Boolean(expected);
  info.secretFingerprint = fingerprint(expected);
  return respond(info);
}

/* ------------------------------------------------------------------ *
 * One-time helper — run this from the editor after pasting the script
 * ------------------------------------------------------------------ */

/**
 * Select `setupBookingSheet` in the editor's function dropdown and press Run.
 * It creates the Bookings sheet with headers, writes then deletes a test row
 * to prove the script has permission, and logs the secret fingerprint.
 */
function setupBookingSheet() {
  var sheet = getOrCreateSheet();
  sheet.appendRow(COLUMNS.map(function () { return ''; }));
  sheet.deleteRow(sheet.getLastRow());

  var expected = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  Logger.log('Sheet ready: "%s" → tab "%s"', sheet.getParent().getName(), sheet.getName());
  Logger.log('SHARED_SECRET configured: %s', expected ? 'yes' : 'NO — set it in Project Settings → Script properties');
  Logger.log('Secret fingerprint: %s  (must equal the one shown by /api/booking-health)', fingerprint(expected));
  return 'OK';
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

function getOrCreateSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      'This script is not bound to a spreadsheet. Open your Google Sheet and use Extensions → Apps Script ' +
        'to create the script, rather than creating a standalone script at script.google.com.'
    );
  }
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);

  if (sheet.getLastRow() === 0) {
    sheet.appendRow(COLUMNS.map(function (column) { return column[1]; }));
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
  }
  return sheet;
}

/**
 * FNV-1a (32-bit). Identical implementation to `fingerprint()` in
 * server/sheetLogger.mjs, so the two sides can compare secrets safely.
 */
function fingerprint(value) {
  var text = value === undefined || value === null ? '' : String(value);
  if (!text) return 'none';
  var hash = 0x811c9dc5;
  for (var i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  var hex = hash.toString(16);
  while (hex.length < 8) hex = '0' + hex;
  return hex;
}

function respond(data) {
  // ContentService web apps cannot set a custom HTTP status code; the JSON
  // body's `ok` field is what the caller actually checks.
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
