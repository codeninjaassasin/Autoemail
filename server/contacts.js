'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'contacts.json');
const CHANGE_LOG = path.join(path.dirname(FILE), 'relay-changes.jsonl');

let cache = null;

function isRelay(addr) {
  return /@([a-z0-9-]+\.)*craigslist\.org$/i.test(addr || '');
}

// Stamps a row with a relay just read from the live page. A different relay
// than the stored one is logged, so the real change rate can be measured.
function stampRelay(row, previous, relay, source) {
  const now = new Date().toISOString();
  if (isRelay(previous) && previous !== relay) {
    row.relayChanges = (row.relayChanges || 0) + 1;
    row.relayChangedAt = now;
    ensureDir();
    fs.appendFileSync(
      CHANGE_LOG,
      JSON.stringify({ at: now, url: row.url, from: previous, to: relay, previousCheckAt: row.relayCheckedAt || null, source }) + '\n'
    );
  }
  row.relayCheckedAt = now;
  row.checkedAt = now;
  row.refreshStatus = 'fresh';
  row.captchaBlocked = false;
  row.note = '';
}

function ensureDir() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
}

function load(force = false) {
  if (cache && !force) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(cache)) cache = [];
  } catch {
    cache = [];
  }
  return cache;
}

function save() {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
}

function list() {
  return load();
}

// A scraped row is keyed by its listing url; re-scraping updates in place and
// preserves the manual `sent` flag. A NEW row sharing a phone with an existing
// contact is treated as a duplicate and skipped (same advertiser reposting
// across areas/categories).
function upsert(row, source = 'scrape') {
  const rows = load();
  const idx = rows.findIndex((r) => r.url === row.url);
  if (idx >= 0) {
    // Only non-empty incoming values overwrite: a re-scrape that came back
    // gated (relay null) or without a date must not wipe what was caught before.
    const patch = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      patch[k] = v;
    }
    const prev = rows[idx];
    const merged = { ...prev, ...patch, id: prev.id, sent: prev.sent };
    // Phones and emails accumulate; a replaced relay leaves the email list.
    const newRelay = isRelay(row.relay) ? row.relay : null;
    merged.phones = [...new Set([...(prev.phones || []), ...(row.phones || [])])];
    merged.emails = [...new Set([...(prev.emails || []), ...(row.emails || [])])].filter(
      (e) => !newRelay || e !== prev.relay || e === newRelay
    );
    if (newRelay) stampRelay(merged, prev.relay, newRelay, source);
    rows[idx] = merged;
    save();
    return merged;
  }
  if (row.phones && row.phones.length) {
    const existing = new Set();
    for (const r of rows) for (const ph of r.phones || []) existing.add(ph);
    if (row.phones.some((ph) => existing.has(ph))) return null; // duplicate phone
  }
  const added = { id: crypto.randomUUID(), sent: false, scrapedAt: new Date().toISOString(), ...row };
  if (isRelay(row.relay)) stampRelay(added, null, row.relay, source);
  rows.push(added);
  save();
  return added;
}

// Remove rows that share a phone with an earlier row (keeps the first). Returns
// how many were removed.
function dedupeByPhone() {
  const rows = load();
  const seen = new Set();
  const kept = [];
  let removed = 0;
  for (const r of rows) {
    const phones = r.phones || [];
    if (phones.length && phones.some((ph) => seen.has(ph))) {
      removed++;
      continue;
    }
    for (const ph of phones) seen.add(ph);
    kept.push(r);
  }
  if (removed) {
    cache = kept;
    save();
  }
  return removed;
}

function findByUrl(url) {
  return load().find((r) => r.url === url) || null;
}

// Records the outcome of a refresh check: 'fresh' | 'unverified' | 'expired'.
// The stored relay is never touched here; `relayCheckedAt` keeps its last
// confirmed time, so an unverified row still shows how old its relay is.
function setCheckStatus(url, status, { save: saveNow = true } = {}) {
  const row = findByUrl(url);
  if (!row) return null;
  row.checkedAt = new Date().toISOString();
  row.refreshStatus = status;
  if (saveNow) save();
  return row;
}

// The listing answered the HTTP sweep. Saved in batches by the caller.
function markAlive(url) {
  const row = findByUrl(url);
  if (row) row.aliveCheckedAt = new Date().toISOString();
}

function setSent(id, sent) {
  const rows = load();
  const row = rows.find((r) => r.id === id);
  if (!row) return null;
  row.sent = !!sent;
  save();
  return row;
}

function remove(id) {
  const rows = load();
  const idx = rows.findIndex((r) => r.id === id);
  if (idx < 0) return false;
  rows.splice(idx, 1);
  save();
  return true;
}

// Delete every contact whose category is not in `keep`. Returns removed count.
function keepOnlyCategories(keep) {
  const rows = load();
  const allowed = new Set(keep);
  const kept = rows.filter((r) => allowed.has(r.category));
  const removed = rows.length - kept.length;
  if (removed) {
    cache = kept;
    save();
  }
  return removed;
}

// Write the in-memory rows to disk (for callers that mutate rows in batches).
function persist() {
  load();
  save();
}

function reload() {
  return load(true);
}

function count() {
  const rows = load();
  return { total: rows.length, sent: rows.filter((r) => r.sent).length };
}

module.exports = {
  list,
  upsert,
  setSent,
  remove,
  reload,
  count,
  dedupeByPhone,
  keepOnlyCategories,
  persist,
  isRelay,
  findByUrl,
  setCheckStatus,
  markAlive,
};
