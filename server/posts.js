'use strict';

// Every post the scrape has seen on a search page, scraped or not, so the
// results list can show posts whose contact hasn't been caught yet.
// data/posts.json: [{ url, title, location, area, category, firstSeenAt, lastSeenAt }]

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'posts.json');
const FLUSH_MS = 5000;
// A post not seen on any search page for this long has most likely expired.
const LISTED_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

let cache = null; // Map<url, post>
let flushTimer = null;
// Change tracking, like contacts.js: each change stamps the post with a rising
// `rev`, so a page can fetch only what changed since its last sync.
let rev = 0;
let epoch = Date.now().toString(36);

function load() {
  if (cache) return cache;
  cache = new Map();
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) for (const p of arr) if (p && p.url) cache.set(p.url, p);
  } catch {
    /* no file yet */
  }
  for (const p of cache.values()) p.rev = ++rev;
  return cache;
}

function flushSync() {
  if (!cache || !flushTimer) return;
  clearTimeout(flushTimer);
  flushTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([...cache.values()]));
  } catch {
    /* exiting */
  }
}
process.on('exit', flushSync);

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}

async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!cache) return;
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify([...cache.values()]));
    await fsp.rename(tmp, FILE);
  } catch {
    scheduleFlush(); // try again later
  }
}

// Record posts from one search page: [{ url, title, location }].
function seen(items, { area, category }) {
  const map = load();
  const now = new Date().toISOString();
  for (const it of items) {
    if (!it || !it.url) continue;
    const prev = map.get(it.url);
    if (prev) {
      // lastSeenAt alone doesn't need a resync (the list only cares while it's
      // recent); a changed title/location does.
      const changed = (it.title && it.title !== prev.title) || (it.location && it.location !== prev.location) || prev.gone;
      prev.lastSeenAt = now;
      if (it.title) prev.title = it.title;
      if (it.location) prev.location = it.location;
      if (changed) prev.rev = ++rev;
    } else {
      map.set(it.url, { url: it.url, title: it.title || '', location: it.location || '', area, category, firstSeenAt: now, lastSeenAt: now, rev: ++rev });
    }
  }
  scheduleFlush();
}

function find(url) {
  return load().get(url) || null;
}

function update(url, patch) {
  const p = load().get(url);
  if (!p) return null;
  Object.assign(p, patch);
  p.rev = ++rev;
  scheduleFlush();
  return p;
}

// Posts still listed (seen on a search page recently, and not expired).
function listed() {
  const cutoff = Date.now() - LISTED_MAX_AGE_MS;
  return [...load().values()].filter((p) => !p.gone && Date.parse(p.lastSeenAt) >= cutoff);
}

// Listed posts changed after `since` (all of them when the epoch differs).
// Posts that expired or stopped being listed come back in `removed`.
function changesSince(since, clientEpoch) {
  const s = Number(since);
  const full = clientEpoch !== epoch || !Number.isFinite(s) || s <= 0 || s > rev;
  const cutoff = Date.now() - LISTED_MAX_AGE_MS;
  const all = [...load().values()];
  const isListed = (p) => !p.gone && Date.parse(p.lastSeenAt) >= cutoff;
  if (full) return { epoch, rev, full: true, rows: all.filter(isListed), removed: [] };
  const changed = all.filter((p) => p.rev > s);
  return { epoch, rev, full: false, rows: changed.filter(isListed), removed: changed.filter((p) => !isListed(p)).map((p) => p.url) };
}

module.exports = { seen, find, update, listed, flush, changesSince, FILE };
