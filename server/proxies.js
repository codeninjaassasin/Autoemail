'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'proxies.json');

const MAX_LINEAR_FAILS = 10; // dropped after this many CONSECUTIVE failures

let store = null; // { updatedAt, proxies: [...] }
let index = null; // Map<server, proxy>

function buildIndex() {
  index = new Map(store.proxies.map((p) => [p.server, p]));
}

function load(force = false) {
  if (store && !force) return store;
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!Array.isArray(store.proxies)) store.proxies = [];
  } catch {
    store = { updatedAt: null, proxies: [] };
  }
  buildIndex();
  return store;
}

let dirty = false;
let flushTimer = null;
const FLUSH_MS = 4000;

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
}

async function flush() {
  flushTimer = null;
  if (!store || !dirty) return;
  dirty = false;
  store.updatedAt = new Date().toISOString();
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(FILE, JSON.stringify(store, null, 2));
  } catch {
    dirty = true;
  }
}

// Archive the current pool to data/proxies.<timestamp>.json (kept, not deleted)
// and start a fresh empty pool.
function rebuild() {
  load();
  try {
    if (fs.existsSync(FILE) && store.proxies.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(FILE, path.join(DATA_DIR, `proxies.${stamp}.json`));
    }
  } catch {
    /* archiving is best-effort */
  }
  store = { updatedAt: new Date().toISOString(), proxies: [] };
  buildIndex();
  dirty = true;
  scheduleFlush();
}

// A proxy is "verified" once it has reached a listing cleanly in real use
// (markSuccess sets live and counts a success).
function isVerified(p) {
  return !!p.live || (p.successes || 0) > 0;
}

// Archive the current pool to data/proxies.<timestamp>.json, then keep only
// verified proxies and remove every unverified one. Returns { kept, removed }.
function pruneUnverified() {
  load();
  try {
    if (fs.existsSync(FILE) && store.proxies.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(FILE, path.join(DATA_DIR, `proxies.${stamp}.json`));
    }
  } catch {
    /* archiving is best-effort */
  }
  const before = store.proxies.length;
  store.proxies = store.proxies.filter(isVerified);
  buildIndex();
  dirty = true;
  scheduleFlush();
  return { kept: store.proxies.length, removed: before - store.proxies.length };
}

// Delete archived pools (data/proxies.<stamp>.json, made by pruneUnverified and
// rebuild) older than maxAgeMs. proxies.json itself is never touched. Returns
// { removed, freedBytes }.
const ARCHIVE_RE = /^proxies\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/;
function removeOldArchives(maxAgeMs = 24 * 60 * 60 * 1000) {
  let removed = 0;
  let freedBytes = 0;
  let names = [];
  try {
    names = fs.readdirSync(DATA_DIR).filter((n) => ARCHIVE_RE.test(n));
  } catch {
    return { removed, freedBytes };
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    const file = path.join(DATA_DIR, name);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs >= cutoff) continue;
      fs.unlinkSync(file);
      removed++;
      freedBytes += st.size;
    } catch {
      /* best effort */
    }
  }
  return { removed, freedBytes };
}

// Merge proxies. Accepts {server,proto,elite} objects or bare "host:port" /
// "proto://host:port" strings. Returns how many were newly added.
function addProxies(list) {
  load();
  let added = 0;
  for (const item of list) {
    let server;
    let proto = 'http';
    let elite = false;
    if (typeof item === 'string') {
      server = /^(https?|socks[45]):\/\//i.test(item) ? item : 'http://' + item;
      proto = server.split('://')[0];
    } else if (item && item.server) {
      server = item.server;
      proto = item.proto || server.split('://')[0] || 'http';
      elite = !!item.elite;
    } else continue;
    if (index.has(server)) {
      if (elite) index.get(server).elite = true;
      continue;
    }
    const rec = {
      server,
      proto,
      elite,
      live: false,
      successes: 0,
      blocks: 0,
      consecutiveFails: 0,
      cooldownUntil: 0,
      lastSuccess: null,
      lastBlock: null,
    };
    store.proxies.push(rec);
    index.set(server, rec);
    added++;
  }
  if (added) scheduleFlush();
  return added;
}

function find(server) {
  load();
  return index.get(server) || null;
}

function drop(server) {
  const i = store.proxies.findIndex((x) => x.server === server);
  if (i >= 0) store.proxies.splice(i, 1);
  index.delete(server);
}

function setLive(server, live) {
  const p = find(server);
  if (!p) return;
  p.live = !!live;
  scheduleFlush();
}

function markSuccess(server) {
  const p = find(server);
  if (!p) return;
  p.successes = (p.successes || 0) + 1;
  p.consecutiveFails = 0; // reset the linear-fail streak
  p.live = true; // proven to work by real use
  p.cooldownUntil = 0;
  p.lastSuccess = new Date().toISOString();
  scheduleFlush();
}

// A failure that does NOT cool the proxy (dead/slow/net). Drops it after
// MAX_LINEAR_FAILS consecutive failures.
function markFail(server) {
  const p = find(server);
  if (!p) return false;
  p.consecutiveFails = (p.consecutiveFails || 0) + 1;
  p.lastBlock = new Date().toISOString();
  if (p.consecutiveFails >= MAX_LINEAR_FAILS) {
    drop(server);
    scheduleFlush();
    return true; // dropped
  }
  scheduleFlush();
  return false;
}

// A gate/block: count as a failure AND park the proxy for cooldownMs.
function markGated(server, cooldownMs = 600000) {
  const p = find(server);
  if (!p) return false;
  p.blocks = (p.blocks || 0) + 1;
  p.cooldownUntil = Date.now() + cooldownMs;
  return markFail(server);
}

function isUsable(p, now) {
  return p.live && (p.cooldownUntil || 0) < now && (p.consecutiveFails || 0) < MAX_LINEAR_FAILS;
}

// Verified-live, not-cooled proxies, elite first then by success margin.
function usable() {
  const now = Date.now();
  return load()
    .proxies.filter((p) => isUsable(p, now))
    .sort((a, b) => {
      if (a.elite !== b.elite) return a.elite ? -1 : 1;
      return b.successes - b.blocks - (a.successes - a.blocks);
    });
}

// Unverified candidates (never liveness-checked yet), for the verifier to probe.
function unverified(limit = 500) {
  return load()
    .proxies.filter((p) => !p.live && (p.consecutiveFails || 0) === 0 && (p.cooldownUntil || 0) < Date.now())
    .slice(0, limit);
}

function stats() {
  const now = Date.now();
  const p = load().proxies;
  return {
    stored: p.length,
    live: p.filter((x) => x.live).length,
    usable: p.filter((x) => isUsable(x, now)).length,
    cooled: p.filter((x) => (x.cooldownUntil || 0) >= now).length,
    elite: p.filter((x) => x.elite).length,
    updatedAt: store.updatedAt,
  };
}

function remove(server) {
  load();
  drop(server);
  scheduleFlush();
}

module.exports = {
  load,
  flush,
  rebuild,
  pruneUnverified,
  removeOldArchives,
  addProxies,
  setLive,
  markSuccess,
  markFail,
  markGated,
  usable,
  unverified,
  stats,
  find,
  remove,
  MAX_LINEAR_FAILS,
};
