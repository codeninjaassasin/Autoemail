'use strict';

const AREA_CODES = require('../data/areacodes');

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

// NANP phone: optional +1, then area [2-9]XX, exchange [2-9]XX, line XXXX.
// (?<!\d) / (?!\d) boundaries stop it slicing a 10-digit window out of a longer
// digit run (prices, IDs, zips, timestamps). Global + case-insensitive.
const PHONE_RE =
  /(?<![\d])(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?([2-9]\d{2})[\s.\-]?(\d{4})(?![\d])/g;

function emailsFrom(text) {
  const found = String(text || '').match(EMAIL_RE) || [];
  return dedupe(found.map((e) => e.toLowerCase()));
}

// Returns validated 10-digit NANP numbers. Rejects unassigned area codes,
// N11 exchanges, and the 555-01XX fictional range.
function phonesFrom(text) {
  const s = String(text || '');
  const out = [];
  let m;
  PHONE_RE.lastIndex = 0;
  while ((m = PHONE_RE.exec(s))) {
    const [, area, exch, line] = m;
    if (!AREA_CODES.has(area)) continue; // first 3 must be a real area code
    if (exch[1] === '1' && exch[2] === '1') continue; // N11 service code exchange
    if (exch === '555' && Number(line) >= 100 && Number(line) <= 199) continue; // 555-01XX fiction
    out.push(area + exch + line);
  }
  return dedupe(out);
}

// Posted date from a listing page: `posted: <time datetime="2026-09-15T12:37:54-0500">`.
// (A separate `updated:` time may follow — ignore it.) Returns ISO 8601 or null.
function postedFromHtml(html) {
  const s = String(html || '');
  const m =
    s.match(/posted:\s*<time[^>]*datetime=["']([^"']+)["']/i) ||
    s.match(/<time[^>]*class=["'][^"']*timeago[^"']*["'][^>]*datetime=["']([^"']+)["']/i);
  if (!m) return null;
  const d = new Date(m[1].replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); // -0500 -> -05:00
  return isNaN(d) ? null : d.toISOString();
}

// A Craigslist reply relay address, e.g. abc-123@job.craigslist.org.
function relayFrom(emails) {
  return emails.find((e) => /craigslist\.org$/i.test(e)) || null;
}

function dedupe(arr) {
  return [...new Set(arr)];
}

module.exports = { emailsFrom, phonesFrom, relayFrom, postedFromHtml, EMAIL_RE, PHONE_RE };
