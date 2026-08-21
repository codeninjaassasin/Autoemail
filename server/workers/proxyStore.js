const fs = require('fs');
const path = require('path');

/**
 * Remembers which proxies have actually produced a contact.
 *
 * Reachability says a proxy can load Craigslist; it says nothing about whether
 * the reply panel will open through it, which is the only thing that matters.
 * A proxy earns its place here by extracting a real address, and loses it by
 * being challenged repeatedly — so the list is built from outcomes rather than
 * from a liveness check, and survives restarts instead of being rediscovered
 * from a mostly-dead public list every run.
 */

const STORE_DIR = path.join(__dirname, '..', '..', 'data');
const STORE_FILE = path.join(STORE_DIR, 'proxies.json');

// Blocks tolerated before a proxy is dropped. Challenges happen to good
// proxies too, so one bad post shouldn't retire one that has been earning.
const BLOCK_LIMIT = Number(process.env.PROXY_BLOCK_LIMIT ?? 10);

// Reachable-but-unproven proxies are kept too, with an expiry. Finding them is
// the expensive part of a run — hundreds of candidates probed to fill a pool —
// and discarding that at every restart meant paying for the same sweep over
// and over. They expire because free proxies die: a stale entry is worse than
// no entry, since it costs a timeout before it's discovered.
const REACHABLE_TTL_MS = Number(process.env.PROXY_REACHABLE_TTL_MS ?? 60 * 60 * 1000);

let entries = new Map();
let reachable = new Map();
let loaded = false;

function load() {
  if (loaded) return entries;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const e of raw.proxies ?? []) entries.set(e.server, e);
    const cutoff = Date.now() - REACHABLE_TTL_MS;
    for (const e of raw.reachable ?? []) {
      if ((e.checkedAt ?? 0) >= cutoff) reachable.set(e.server, e);
    }
  } catch {
    // No store yet, or it's unreadable — start empty rather than fail the run.
  }
  return entries;
}

/**
 * Written straight through, not deferred.
 *
 * Saves used to be coalesced behind a 2s unref'd timer, which meant a pending
 * write was dropped whenever the process exited first — a run that proved ten
 * proxies persisted none of them, and every later run started from nothing.
 * The file holds a few dozen small entries and changes at most once per post,
 * so batching bought nothing and cost the entire feature.
 */
function save() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(
      STORE_FILE,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          proxies: [...entries.values()],
          reachable: [...reachable.values()],
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error('[proxy store] could not save:', err.message);
  }
}

/**
 * Records a proxy that passed validation but hasn't produced a contact yet.
 * Saves the cost of rediscovering it after a restart.
 */
function recordReachable(p) {
  load();
  if (!p?.server) return;
  reachable.set(p.server, {
    server: p.server,
    ip: p.ip,
    location: p.location,
    org: p.org,
    ipVerified: p.ipVerified,
    checkedAt: Date.now(),
  });
  save();
}

/** Reachable proxies still inside their expiry, minus any already proven. */
function freshReachable() {
  load();
  const cutoff = Date.now() - REACHABLE_TTL_MS;
  return [...reachable.values()].filter(
    (e) => (e.checkedAt ?? 0) >= cutoff && !entries.has(e.server)
  );
}

function forget(server) {
  load();
  const had = reachable.delete(server);
  if (had) save();
  return had;
}

/** Proxies that have produced a contact and haven't been retired. */
function proven() {
  load();
  return [...entries.values()].filter((e) => e.blocks < BLOCK_LIMIT);
}

function size() {
  return proven().length;
}

function has(server) {
  load();
  return entries.has(server);
}

/** Records a proxy that produced a contact. */
function recordSuccess({ server, ip, location, org }) {
  load();
  const e = entries.get(server) ?? { server, ip, location, org, successes: 0, blocks: 0 };
  e.successes += 1;
  e.ip = ip ?? e.ip;
  e.location = location ?? e.location;
  e.lastSuccess = new Date().toISOString();
  // A proxy that works again has earned back some of its record — otherwise a
  // long-serving one accumulates blocks forever and is retired despite still
  // producing.
  if (e.blocks > 0) e.blocks -= 1;
  entries.set(server, e);
  save();
  return e;
}

/**
 * Records a block against a proxy. Returns true once it has been blocked
 * enough times to be retired.
 */
function recordBlock(server) {
  load();
  const e = entries.get(server);
  if (!e) return false;
  e.blocks += 1;
  e.lastBlock = new Date().toISOString();
  entries.set(server, e);
  save();
  if (e.blocks >= BLOCK_LIMIT) {
    entries.delete(server);
    save();
    return true;
  }
  return false;
}

function remove(server) {
  load();
  const had = entries.delete(server) | reachable.delete(server);
  if (had) save();
  return Boolean(had);
}

function stats() {
  load();
  const all = [...entries.values()];
  return {
    total: all.length,
    proven: all.filter((e) => e.blocks < BLOCK_LIMIT).length,
    reachable: freshReachable().length,
    totalSuccesses: all.reduce((n, e) => n + (e.successes ?? 0), 0),
    blockLimit: BLOCK_LIMIT,
  };
}

module.exports = {
  proven, size, has, recordSuccess, recordBlock, remove, stats,
  recordReachable, freshReachable, forget,
  BLOCK_LIMIT, STORE_FILE,
};
