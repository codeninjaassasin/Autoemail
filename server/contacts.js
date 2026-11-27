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

// --- In-memory cache with change tracking --------------------------------------
// Every change stamps the row with a rising `rev`, and a delete leaves a
// tombstone, so a page can fetch only what changed since its last sync
// (changesSince). `byUrl` / `byId` make lookups O(1). Disk writes are batched:
// at most one write per SAVE_DEBOUNCE_MS, off the request path, plus a final
// synchronous write when the process exits.
const SAVE_DEBOUNCE_MS = 1500;
const TOMBSTONE_MAX = 5000;
let rev = 0; // highest rev handed out
let byUrl = new Map();
let byId = new Map();
let tombstones = []; // [{ id, url, rev }]
let saveTimer = null;
let saving = null;
let dirty = false;

function reindex() {
  byUrl = new Map();
  byId = new Map();
  for (const r of cache) {
    if (r.url) byUrl.set(r.url, r);
    if (r.id) byId.set(r.id, r);
  }
}

function load(force = false) {
  if (cache && !force) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(cache)) cache = [];
  } catch {
    cache = [];
  }
  // Fresh revs for this process: a page holding revs from before a restart
  // sees `rev` go backwards and does a full resync.
  rev = 0;
  for (const r of cache) r.rev = ++rev;
  tombstones = [];
  epoch = Date.now().toString(36);
  reindex();
  return cache;
}
let epoch = Date.now().toString(36); // changes on every (re)load: clients resync

// Mark a row changed (call after mutating it in place).
function touch(row) {
  if (!row) return row;
  row.rev = ++rev;
  return row;
}

function writeNow() {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, FILE);
  dirty = false;
}

async function writeAsync() {
  saveTimer = null;
  if (!dirty) return;
  dirty = false;
  const body = JSON.stringify(cache); // compact: ~40% faster than pretty-printed
  try {
    await fs.promises.mkdir(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, FILE);
  } catch {
    dirty = true;
    scheduleSave();
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saving = writeAsync().finally(() => (saving = null));
  }, SAVE_DEBOUNCE_MS);
}
const save = scheduleSave;

// Flush pending changes before the process exits (kill / Ctrl-C).
function flushSync() {
  if (!cache || !dirty) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    writeNow();
  } catch {
    /* nothing more we can do while exiting */
  }
}
process.on('exit', flushSync);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    flushSync();
    process.exit(0);
  });
}

function list() {
  return load();
}

// Rows changed after `since` (a rev), plus ids deleted since then. When the
// caller's epoch differs (server restarted / data reloaded) or its rev is too
// old for the tombstones kept, it gets everything (`full: true`).
function changesSince(since, clientEpoch) {
  load();
  const s = Number(since);
  const oldestTomb = tombstones.length ? tombstones[0].rev : 0;
  const full =
    clientEpoch !== epoch || !Number.isFinite(s) || s <= 0 || s > rev || (tombstones.length >= TOMBSTONE_MAX && s < oldestTomb);
  if (full) return { epoch, rev, full: true, rows: cache, deleted: [] };
  return {
    epoch,
    rev,
    full: false,
    rows: cache.filter((r) => r.rev > s),
    deleted: tombstones.filter((t) => t.rev > s).map((t) => t.id),
  };
}

function bury(row) {
  tombstones.push({ id: row.id, url: row.url, rev: ++rev });
  if (tombstones.length > TOMBSTONE_MAX) tombstones.splice(0, tombstones.length - TOMBSTONE_MAX);
}

// A scraped row is keyed by its listing url; re-scraping updates in place and
// preserves the manual `sent` flag. A row marked sent is never updated. A NEW row sharing a phone with an existing
// contact is treated as a duplicate and skipped (same advertiser reposting
// across areas/categories).
function upsert(row, source = 'scrape') {
  const rows = load();
  const existing = byUrl.get(row.url);
  const idx = existing ? rows.indexOf(existing) : -1;
  if (idx >= 0) {
    // A contact marked sent is final: no relay update, no freshness stamp.
    if (rows[idx].sent) return rows[idx];
    // Only non-empty incoming values overwrite: a re-scrape that came back
    // gated (relay null) or without a date must not wipe what was caught before.
    const patch = {};
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
      patch[k] = v;
    }
    const prev = rows[idx];
    const merged = { ...prev, ...patch, id: prev.id, sent: prev.sent };
    delete merged.unscraped; // kept for a post marked sent/red before it was scraped
    // Phones and emails accumulate; a replaced relay leaves the email list.
    const newRelay = isRelay(row.relay) ? row.relay : null;
    merged.phones = [...new Set([...(prev.phones || []), ...(row.phones || [])])];
    merged.emails = [...new Set([...(prev.emails || []), ...(row.emails || [])])].filter(
      (e) => !newRelay || e !== prev.relay || e === newRelay
    );
    if (newRelay) stampRelay(merged, prev.relay, newRelay, source);
    rows[idx] = merged;
    byUrl.set(merged.url, merged);
    byId.set(merged.id, merged);
    touch(merged);
    save();
    return merged;
  }
  if (row.phones && row.phones.length) {
    const taken = new Set();
    for (const r of rows) for (const ph of r.phones || []) taken.add(ph);
    if (row.phones.some((ph) => taken.has(ph))) return null; // duplicate phone
  }
  const added = { id: crypto.randomUUID(), sent: false, scrapedAt: new Date().toISOString(), ...row };
  if (isRelay(row.relay)) stampRelay(added, null, row.relay, source);
  rows.push(added);
  byUrl.set(added.url, added);
  byId.set(added.id, added);
  touch(added);
  save();
  return added;
}

// A contact row for a listed post that hasn't been scraped yet (`post` gives
// its title/area/category/date). Contact fields start empty.
function addFromPost(url, post = {}, extra = {}) {
  const row = {
    id: crypto.randomUUID(),
    sent: false,
    scrapedAt: new Date().toISOString(),
    url,
    title: post.title || '',
    emails: [],
    phones: [],
    relay: null,
    captchaBlocked: false,
    note: '',
    area: post.area || '',
    category: post.category || '',
    postedAt: post.postedAt || null, // the listed post's date (filled by server/postDates.js)
    ...extra,
  };
  load().push(row);
  byUrl.set(row.url, row);
  byId.set(row.id, row);
  return row;
}

// Manual entry from the list's pencil icon: a relay email and/or one phone.
// Creates the contact when the post hasn't been scraped yet (`post` gives its
// title/area/category). Returns { row } or { error }.
function setManual(url, { relay, phone }, post = {}) {
  const rows = load();
  let row = byUrl.get(url) || null;
  if (row && row.sent) return { error: 'This contact is marked sent.' };
  if (phone && rows.some((r) => r !== row && (r.phones || []).includes(phone))) {
    return { error: 'That phone number is already on another contact.' };
  }
  const now = new Date().toISOString();
  if (!row) row = addFromPost(url, post, { manual: true });
  if (relay) {
    row.relay = relay;
    row.emails = [...new Set([...(row.emails || []), relay])];
  }
  if (phone) row.phones = [...new Set([...(row.phones || []), phone])];
  if (!row.postedAt && post.postedAt) row.postedAt = post.postedAt;
  row.manualAt = now;
  if (row.unscraped) {
    delete row.unscraped;
    row.manual = true;
  }
  touch(row);
  save();
  return { row };
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
    const keptSet = new Set(kept);
    for (const r of rows) if (!keptSet.has(r)) bury(r);
    cache = kept;
    reindex();
    save();
  }
  return removed;
}

function findByUrl(url) {
  load();
  return byUrl.get(url) || null;
}

// Records the outcome of a refresh check: 'fresh' | 'unverified' | 'expired'.
// The stored relay is never touched here; `relayCheckedAt` keeps its last
// confirmed time, so an unverified row still shows how old its relay is.
function setCheckStatus(url, status, { save: saveNow = true } = {}) {
  const row = findByUrl(url);
  if (!row || row.sent || row.flagged) return null; // sent and red rows get no freshness checks
  row.checkedAt = new Date().toISOString();
  row.refreshStatus = status;
  touch(row);
  if (saveNow) save();
  else dirty = true;
  return row;
}

// The listing answered the HTTP sweep. Saved in batches by the caller.
function markAlive(url) {
  const row = findByUrl(url);
  if (row && !row.sent && !row.flagged) row.aliveCheckedAt = new Date().toISOString();
}

// Sent box and red mark (the ✕ button) of a contact. `flags` holds `sent`
// and/or `flagged`; a missing key is left as it is.
function setFlags(id, flags = {}) {
  load();
  const row = byId.get(id);
  if (!row) return null;
  if (flags.sent !== undefined) {
    // For Analytics (sent per day): now, or the time given (a draft that left Drafts).
    if (flags.sent && !row.sent) row.sentAt = flags.sentAt || new Date().toISOString();
    if (!flags.sent) delete row.sentAt;
    row.sent = !!flags.sent;
  } else if (flags.sentAt && row.sent) row.sentAt = flags.sentAt;
  if (flags.flagged !== undefined) {
    if (flags.flagged) {
      row.flagged = true;
      row.flaggedAt = new Date().toISOString();
    } else {
      delete row.flagged;
      delete row.flaggedAt;
    }
  }
  touch(row);
  save();
  return row;
}
// Records the automatic draft made for a contact (or a failed attempt), so the
// same post is never drafted twice. `info` null clears it.
// `merge` keeps the fields already there (e.g. the draft's later status).
function setAutoDraft(id, info, merge = false) {
  load();
  const row = byId.get(id);
  if (!row) return null;
  if (info) row.autoDraft = merge && row.autoDraft ? { ...row.autoDraft, ...info } : info;
  else delete row.autoDraft;
  touch(row);
  save();
  return row;
}
function setSent(id, sent) {
  return setFlags(id, { sent });
}

// Same, by post url: a listed post that isn't a contact yet becomes one
// (empty contact fields) so its sent box / red mark can be kept.
function setFlagsByUrl(url, flags, post) {
  load();
  // `unscraped` stays until the scraper (or a hand fill) gives it a contact.
  const row = byUrl.get(url) || (post ? addFromPost(url, post, { unscraped: true }) : null);
  return row ? setFlags(row.id, flags) : null;
}

function remove(id) {
  const rows = load();
  const row = byId.get(id);
  const idx = row ? rows.indexOf(row) : -1;
  if (idx < 0) return false;
  rows.splice(idx, 1);
  byId.delete(row.id);
  if (byUrl.get(row.url) === row) byUrl.delete(row.url);
  bury(row);
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
    for (const r of rows) if (!allowed.has(r.category)) bury(r);
    cache = kept;
    reindex();
    save();
  }
  return removed;
}

// Write the in-memory rows to disk (for callers that mutate rows in batches).
function persist() {
  load();
  save();
}

// Current change counter + epoch (cheap: lets callers memoize derived data).
function version() {
  load();
  return `${epoch}:${rev}`;
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
  setFlags,
  setAutoDraft,
  setFlagsByUrl,
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
  setManual,
  touch,
  changesSince,
  version,
  flushSync,
};
