'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'contacts.json');

let cache = null;

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
function upsert(row) {
  const rows = load();
  const idx = rows.findIndex((r) => r.url === row.url);
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], ...row, id: rows[idx].id, sent: rows[idx].sent };
    save();
    return rows[idx];
  }
  if (row.phones && row.phones.length) {
    const existing = new Set();
    for (const r of rows) for (const ph of r.phones || []) existing.add(ph);
    if (row.phones.some((ph) => existing.has(ph))) return null; // duplicate phone
  }
  const added = { id: crypto.randomUUID(), sent: false, scrapedAt: new Date().toISOString(), ...row };
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

function reload() {
  return load(true);
}

function count() {
  const rows = load();
  return { total: rows.length, sent: rows.filter((r) => r.sent).length };
}

module.exports = { list, upsert, setSent, remove, reload, count, dedupeByPhone, keepOnlyCategories };
