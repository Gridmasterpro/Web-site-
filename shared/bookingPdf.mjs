/**
 * Branded booking receipt — a complete PDF generator with zero dependencies.
 *
 * Why hand-rolled?
 * ----------------
 * Every visitor who books must be able to download a proper PDF receipt, and
 * the backend must attach the very same PDF to the customer's confirmation
 * e-mail. Pulling in a client-side PDF library would add ~300 KB to the site
 * bundle for what is essentially one fixed layout; writing the PDF ourselves
 * keeps the website light, works identically in the browser and in Node (no
 * DOM, no canvas), and produces a deterministic file that the test-suite can
 * assert byte-for-byte.
 *
 * The output is a plain, uncompressed PDF 1.4 document built only on the
 * three Base-14 fonts every PDF viewer ships with (Helvetica regular, bold
 * and oblique). Binary data is represented as a JS string whose char codes
 * are all ≤ 0xFF ("latin-1 string"), so callers convert it like this:
 *
 *   Browser : new Blob([Uint8Array.from(pdf, (c) => c.charCodeAt(0))],
 *                      { type: 'application/pdf' })
 *   Server  : Buffer.from(pdf, 'latin1')          (see pdfToBase64)
 *
 * Caveat — the ₹ rupee sign does not exist in the classic PDF text encoding,
 * so `sanitizePdfText` rewrites it as "Rs. " (and normalises a handful of
 * other Unicode punctuation the site uses) before anything is drawn.
 */

export const PDF_PAGE = { width: 595.28, height: 841.89 }; // A4, in points

/* ------------------------------------------------------------------ *
 * Text hygiene — PDF Base-14 fonts speak Windows-1252, nothing fancier
 * ------------------------------------------------------------------ */

const UNICODE_REPLACEMENTS = new Map([
  ['₹', 'Rs. '],
  ['≈', '~'],
  ['–', '-'],
  ['—', '-'],
  ['‘', "'"],
  ['’', "'"],
  ['“', '"'],
  ['”', '"'],
  ['…', '...'],
  ['•', '\xB7'], // middle dot exists in Windows-1252
  ['✓', '\xB7'], // no checkmark glyph — fall back to a bullet
  ['✕', 'x'],
  ['→', '->'],
  ['←', '<-'],
  ['×', '\xD7'], // multiplication sign exists in Windows-1252
  ['\u00A0', ' '], // non-breaking space
]);

/**
 * Make any site string drawable: known punctuation is replaced, characters
 * that survive and still exceed latin-1 are dropped (never throw).
 */
export function sanitizePdfText(value) {
  let str = value === undefined || value === null ? '' : String(value);
  let out = '';
  for (const ch of str) {
    const mapped = UNICODE_REPLACEMENTS.get(ch);
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) {
      out += ch; // printable ASCII
    } else if (code >= 160 && code <= 255) {
      out += ch; // latin-1 supplement present in Windows-1252
    }
    // else: control char or unsupported Unicode — skip it
  }
  return out;
}

/** Escape a string for the PDF `( ... )` literal syntax. */
function escapePdfString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/* ------------------------------------------------------------------ *
 * Approximate Helvetica metrics — good enough to wrap receipt values
 * ------------------------------------------------------------------ */

function charUnits(ch) {
  const c = ch.codePointAt(0);
  if (c === 32) return 278; // space
  if (c >= 48 && c <= 57) return 556; // digits
  if (c >= 97 && c <= 122) {
    if ('iltfj'.includes(ch)) return 278;
    if (ch === 'm' || ch === 'w') return 833;
    return 510;
  }
  if (c >= 65 && c <= 90) {
    if (ch === 'I') return 278;
    if (ch === 'M' || ch === 'W') return 889;
    return 680;
  }
  if (".,:;'!|`".includes(ch)) return 278;
  if (ch === '-') return 333;
  if (ch === '/') return 300;
  if (ch === '@') return 1000;
  if (ch === '(' || ch === ')') return 333;
  return 560;
}

/** Estimated width of `str` at `size` pt. Slightly generous for bold text. */
export function estimateTextWidth(str, size, { bold = false } = {}) {
  let units = 0;
  for (const ch of String(str)) units += charUnits(ch);
  return (units / 1000) * size * (bold ? 1.04 : 1.0);
}

/** Greedy word-wrap; returns an array of lines, each fitting `maxWidth`. */
export function wrapText(value, { size, maxWidth, bold = false }) {
  const str = sanitizePdfText(value).replace(/\s+/g, ' ').trim();
  if (!str) return [];
  const words = str.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && estimateTextWidth(candidate, size, { bold }) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/* ------------------------------------------------------------------ *
 * Canvas — one page of vector drawing commands (y measured from the TOP)
 * ------------------------------------------------------------------ */

const FONT_IDS = { regular: 'F1', bold: 'F2', oblique: 'F3' };

const rgb = (r, g, b) => `${(r / 255).toFixed(3)} ${(g / 255).toFixed(3)} ${(b / 255).toFixed(3)}`;
const num = (value) => Math.round(value * 100) / 100;

class PageCanvas {
  constructor() {
    this.ops = [];
  }

  fillRect(x, yTop, width, height, [r, g, b]) {
    this.ops.push(`${rgb(r, g, b)} rg ${num(x)} ${num(PDF_PAGE.height - yTop - height)} ${num(width)} ${num(height)} re f`);
  }

  strokedRect(x, yTop, width, height, [r, g, b], lineWidth = 1) {
    this.ops.push(
      `${rgb(r, g, b)} RG ${num(lineWidth)} w ${num(x)} ${num(PDF_PAGE.height - yTop - height)} ${num(width)} ${num(height)} re S`
    );
  }

  hLine(x1, x2, yTop, [r, g, b], lineWidth = 1) {
    this.ops.push(
      `${rgb(r, g, b)} RG ${num(lineWidth)} w ${num(x1)} ${num(PDF_PAGE.height - yTop)} m ${num(x2)} ${num(PDF_PAGE.height - yTop)} l S`
    );
  }

  /** Draw text; x is left edge, yTop is the text BASELINE measured from the top. */
  text(x, yTop, value, { size = 10, font = 'regular', color = [15, 23, 42], align = 'left' } = {}) {
    const str = sanitizePdfText(value);
    if (!str) return;
    const bold = font === 'bold';
    let tx = x;
    if (align !== 'left') {
      const width = estimateTextWidth(str, size, { bold });
      tx = align === 'right' ? x - width : x - width / 2;
    }
    this.ops.push(
      `BT /${FONT_IDS[font]} ${num(size)} Tf ${rgb(...color)} rg 1 0 0 1 ${num(tx)} ${num(PDF_PAGE.height - yTop)} Tm (${escapePdfString(str)}) Tj ET`
    );
  }

  /** Right-aligned convenience wrapper. */
  textRight(xRight, yTop, value, options = {}) {
    this.text(xRight, yTop, value, { ...options, align: 'right' });
  }

  toStream() {
    return this.ops.join('\n');
  }
}

/* ------------------------------------------------------------------ *
 * Receipt painter
 * ------------------------------------------------------------------ */

const NAVY = [15, 23, 42];
const INK = [15, 23, 42];
const LABEL = [71, 85, 105];
const MUTED = [100, 116, 139];
const AMBER = [245, 158, 11];
const AMBER_DARK = [180, 83, 9];
const AMBER_PALE = [255, 251, 235];
const RULE = [226, 232, 240];
const WHITE = [255, 255, 255];
const GREEN = [5, 150, 105];
const GREEN_PALE = [236, 253, 245];

const MARGIN = 46;
const CONTENT_RIGHT = PDF_PAGE.width - MARGIN; // 549
const CONTENT_WIDTH = CONTENT_RIGHT - MARGIN; // 503
const LABEL_COL = 158;

function drawFooter(canvas) {
  const bandHeight = 64;
  const top = PDF_PAGE.height - bandHeight;
  canvas.fillRect(0, top, PDF_PAGE.width, bandHeight, NAVY);
  canvas.fillRect(0, top, PDF_PAGE.width, 2.5, AMBER);
  canvas.text(MARGIN, top + 24, 'Grid Master Solar Systems — contact our engineering desk', {
    size: 8.5,
    font: 'bold',
    color: WHITE,
  });
  canvas.textRight(CONTENT_RIGHT, top + 24, 'We call you within 24 hours to confirm.', {
    size: 8,
    color: AMBER,
  });
  return top;
}

function drawMainHeader(canvas, model) {
  const bandHeight = 86;
  canvas.fillRect(0, 0, PDF_PAGE.width, bandHeight, NAVY);
  canvas.fillRect(0, bandHeight, PDF_PAGE.width, 3, AMBER);
  canvas.text(MARGIN, 34, model.company.name.toUpperCase(), { size: 20, font: 'bold', color: AMBER });
  canvas.text(MARGIN, 52, model.company.tagline, { size: 8.5, color: [203, 213, 225] });
  canvas.textRight(CONTENT_RIGHT, 30, 'BOOKING RECEIPT', { size: 10.5, font: 'bold', color: AMBER });
  canvas.textRight(CONTENT_RIGHT, 44, 'Official customer copy', { size: 7.5, color: MUTED });
  canvas.textRight(CONTENT_RIGHT, 67, model.company.email, { size: 8, color: [203, 213, 225] });
  return bandHeight + 3;
}

function drawContinuationHeader(canvas, model) {
  const bandHeight = 40;
  canvas.fillRect(0, 0, PDF_PAGE.width, bandHeight, NAVY);
  canvas.fillRect(0, bandHeight, PDF_PAGE.width, 2, AMBER);
  canvas.text(MARGIN, 26, model.company.name.toUpperCase(), { size: 11, font: 'bold', color: AMBER });
  canvas.textRight(CONTENT_RIGHT, 26, `Booking receipt (continued) — ${model.reference}`, {
    size: 8,
    color: [203, 213, 225],
  });
  return bandHeight + 2;
}

/**
 * Render the whole receipt and return the PDF document as a latin-1 string.
 *
 * @param {Object} model output of shared/receiptModel.mjs :: bookingPayloadToReceiptModel
 */
export function buildBookingReceiptPdf(model) {
  if (!model || typeof model !== 'object') throw new Error('A receipt model is required.');
  const company = model.company || {};
  const customer = model.customer || {};
  const booking = model.booking || {};
  const equipment = model.equipment || { lines: [], total: '' };

  const pages = [];
  let canvas = new PageCanvas();
  pages.push(canvas);
  let y = drawMainHeader(canvas, model) + 16;

  const ensureSpace = (needed) => {
    if (y + needed > PDF_PAGE.height - 92) {
      canvas = new PageCanvas();
      pages.push(canvas);
      y = drawContinuationHeader(canvas, model) + 16;
    }
  };

  const sectionHeader = (title) => {
    ensureSpace(40);
    y += 10;
    canvas.text(MARGIN, y, title, { size: 9, font: 'bold', color: AMBER_DARK });
    y += 6;
    canvas.hLine(MARGIN, CONTENT_RIGHT, y, RULE, 0.8);
    y += 13;
  };

  const fieldRow = (label, value, { boldValue = false } = {}) => {
    const lines = wrapText(value || 'N/A', {
      size: 9.5,
      maxWidth: CONTENT_WIDTH - LABEL_COL - 10,
      bold: boldValue,
    });
    const blockHeight = Math.max(lines.length, 1) * 12.5 + 2;
    ensureSpace(blockHeight + 4);
    canvas.text(MARGIN, y, label, { size: 9.5, font: 'bold', color: LABEL });
    lines.forEach((line, i) => {
      canvas.text(MARGIN + LABEL_COL, y + i * 12.5, line, {
        size: 9.5,
        font: boldValue ? 'bold' : 'regular',
        color: INK,
      });
    });
    y += blockHeight;
  };

  /* ---------------- Reference badge ---------------- */
  const badgeTop = y;
  canvas.fillRect(MARGIN, badgeTop, CONTENT_WIDTH, 46, AMBER_PALE);
  canvas.strokedRect(MARGIN, badgeTop, CONTENT_WIDTH, 46, AMBER, 1.2);
  canvas.text(MARGIN + 14, badgeTop + 17, 'BOOKING REFERENCE', { size: 7.5, font: 'bold', color: MUTED });
  canvas.text(MARGIN + 14, badgeTop + 36, model.reference || 'N/A', { size: 15, font: 'bold', color: INK });
  canvas.textRight(CONTENT_RIGHT - 14, badgeTop + 17, 'DATE ISSUED', { size: 7.5, font: 'bold', color: MUTED });
  canvas.textRight(CONTENT_RIGHT - 14, badgeTop + 34, model.createdDate || '', { size: 10, font: 'bold', color: INK });
  y = badgeTop + 46;

  /* ---------------- Customer details ---------------- */
  sectionHeader('CUSTOMER DETAILS');
  fieldRow('Full Name', customer.name, { boldValue: true });
  fieldRow('Phone Number', customer.phone);
  fieldRow('E-mail Address', customer.email);
  fieldRow('Site Address', customer.address);

  /* ---------------- Project specifications ---------------- */
  sectionHeader('PROJECT SPECIFICATIONS');
  fieldRow('Scope of Work', booking.purpose);
  fieldRow('Service Required', booking.service);
  fieldRow('Site Visit Date', booking.date, { boldValue: true });
  fieldRow('Time Slot', booking.timeSlot, { boldValue: true });
  fieldRow('Lead Engineer', booking.engineer);
  if (String(customer.notes || '').trim()) {
    fieldRow('Special Notes', customer.notes);
  }

  /* ---------------- Equipment package (optional) ---------------- */
  if (equipment.lines.length > 0) {
    sectionHeader('SELECTED EQUIPMENT PACKAGE');
    for (const line of equipment.lines) {
      const wrapped = wrapText(line, { size: 9, maxWidth: CONTENT_WIDTH - 22 });
      ensureSpace(wrapped.length * 12 + 3);
      wrapped.forEach((textLine, i) => {
        canvas.text(MARGIN + 4, y + i * 12, `${i === 0 ? '\xB7 ' : '  '}${textLine}`, {
          size: 9,
          color: INK,
        });
      });
      y += wrapped.length * 12 + 3;
    }
    if (equipment.total) {
      ensureSpace(22);
      y += 5;
      canvas.hLine(MARGIN, CONTENT_RIGHT, y, RULE, 0.8);
      y += 14;
      canvas.text(MARGIN, y, 'Equipment Package Total', { size: 10, font: 'bold', color: LABEL });
      canvas.textRight(CONTENT_RIGHT, y, equipment.total, { size: 10.5, font: 'bold', color: AMBER_DARK });
      y += 8;
    }
  }

  /* ---------------- Site visit highlight ---------------- */
  const visitLines = wrapText(
    `${booking.engineer || 'Our engineer'} will visit your property on ${booking.date}, between ${booking.timeSlot}. ` +
      'Please keep the installation area accessible and a recent electricity bill handy.',
    { size: 9.5, maxWidth: CONTENT_WIDTH - 32 }
  );
  const statusLine = model.status?.text
    ? wrapText(model.status.text, { size: 8.5, maxWidth: CONTENT_WIDTH - 32 })
    : [];
  const boxHeight = 26 + visitLines.length * 12.5 + (statusLine.length ? statusLine.length * 11 + 8 : 0);
  ensureSpace(boxHeight + 12);
  y += 14;
  const boxTop = y;
  canvas.fillRect(MARGIN, boxTop, CONTENT_WIDTH, boxHeight, GREEN_PALE);
  canvas.strokedRect(MARGIN, boxTop, CONTENT_WIDTH, boxHeight, GREEN, 1.1);
  canvas.text(MARGIN + 12, boxTop + 17, 'SITE VISIT SCHEDULED', { size: 8.5, font: 'bold', color: GREEN });
  visitLines.forEach((line, i) => {
    canvas.text(MARGIN + 12, boxTop + 31 + i * 12.5, line, { size: 9.5, color: INK });
  });
  statusLine.forEach((line, i) => {
    canvas.text(MARGIN + 12, boxTop + 31 + visitLines.length * 12.5 + 7 + i * 11, line, {
      size: 8.5,
      font: 'oblique',
      color: LABEL,
    });
  });
  y = boxTop + boxHeight;

  /* ---------------- What happens next ---------------- */
  sectionHeader('WHAT HAPPENS NEXT');
  const steps = [
    '1.  Our team calls you within 24 hours to confirm this booking.',
    '2.  Free site audit and a 3D CAD design of your solar layout.',
    '3.  You receive a fixed, transparent quote before installation begins.',
  ];
  for (const step of steps) {
    ensureSpace(14);
    canvas.text(MARGIN + 4, y, step, { size: 9, color: INK });
    y += 13.5;
  }
  y += 6;
  ensureSpace(14);
  canvas.text(MARGIN, y, 'Show or quote your booking reference in all communication with our team.', {
    size: 8,
    font: 'oblique',
    color: MUTED,
  });

  /* ---------------- Footer (every page) ---------------- */
  for (const page of pages) {
    const top = drawFooter(page);
    page.text(MARGIN, top + 40, `${company.email}   \xB7   ${company.phone}   \xB7   ${company.address}`, {
      size: 7.5,
      color: [203, 213, 225],
    });
    page.text(MARGIN, top + 52, 'This is a computer-generated receipt from the Grid Master website and does not require a signature.', {
      size: 6.5,
      color: MUTED,
    });
  }

  return assemblePdf(pages, {
    title: `Grid Master Booking Receipt ${model.reference || ''}`.trim(),
  });
}

/* ------------------------------------------------------------------ *
 * Document assembly — objects, cross-reference table, trailer
 * ------------------------------------------------------------------ */

function assemblePdf(pageCanvases, { title } = {}) {
  const pageCount = pageCanvases.length;
  // Object numbering: 1 catalog, 2 pages, 3/4/5 fonts, then per page (page, content).
  const FONT_OBJECT = { regular: 3, bold: 4, oblique: 5 };
  const pageObjectId = (index) => 6 + index * 2;
  const contentObjectId = (index) => 7 + index * 2;
  const infoObjectId = 6 + pageCount * 2;

  const objects = [];
  const addObject = (id, body) => {
    objects[id] = `${id} 0 obj\n${body}\nendobj\n`;
  };

  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');

  const kids = pageCanvases.map((_, i) => `${pageObjectId(i)} 0 R`).join(' ');
  addObject(2, `<< /Type /Pages /Kids [ ${kids} ] /Count ${pageCount} >>`);

  addObject(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  addObject(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  addObject(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>');

  pageCanvases.forEach((canvas, i) => {
    const w = num(PDF_PAGE.width);
    const h = num(PDF_PAGE.height);
    addObject(
      pageObjectId(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${w} ${h} ] ` +
        `/Resources << /Font << /F1 ${FONT_OBJECT.regular} 0 R /F2 ${FONT_OBJECT.bold} 0 R /F3 ${FONT_OBJECT.oblique} 0 R >> >> ` +
        `/Contents ${contentObjectId(i)} 0 R >>`
    );
    const stream = canvas.toStream();
    addObject(contentObjectId(i), `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  addObject(
    infoObjectId,
    `<< /Producer (${escapePdfString(sanitizePdfText('Grid Master Solar Systems — Website Booking Engine'))}) ` +
      `/Title (${escapePdfString(sanitizePdfText(title || 'Grid Master Booking Receipt'))}) >>`
  );

  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [0];
  for (let id = 1; id <= infoObjectId; id += 1) {
    if (!objects[id]) throw new Error(`Internal error: missing PDF object ${id}`);
    offsets[id] = pdf.length;
    pdf += objects[id];
  }

  const xrefStart = pdf.length;
  const entries = infoObjectId + 1;
  let xref = `xref\n0 ${entries}\n0000000000 65535 f \n`;
  for (let id = 1; id <= infoObjectId; id += 1) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += xref;
  pdf +=
    `trailer\n<< /Size ${entries} /Root 1 0 R /Info ${infoObjectId} 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  return pdf;
}

/** Suggested download name for the receipt of a booking. */
export function receiptFileName(reference) {
  const ref = sanitizePdfText(reference || '').replace(/[^A-Za-z0-9-]/g, '') || 'receipt';
  return `GridMaster_Booking_${ref}.pdf`;
}

/**
 * Base64 for mail attachments. Prefers Node's Buffer (backend functions);
 * falls back to manual encoding so the module stays runnable anywhere.
 */
export function pdfToBase64(pdf, { BufferImpl } = {}) {
  const Buf = BufferImpl || (typeof Buffer !== 'undefined' ? Buffer : null);
  if (Buf) return Buf.from(pdf, 'latin1').toString('base64');
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < pdf.length; i += CHUNK) {
    binary += String.fromCharCode(...pdf.slice(i, i + CHUNK).split('').map((c) => c.charCodeAt(0)));
  }
  if (typeof btoa === 'function') return btoa(binary);
  throw new Error('Neither Buffer nor btoa is available to base64-encode the PDF.');
}
