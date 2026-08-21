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

let entries = new Map();
let loaded = false;

function load() {
  if (loaded) return entries;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    for (const e of raw.proxies ?? []) entries.set(e.server, e);
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
      JSON.stringify({ updatedAt: new Date().toISOString(), proxies: [...entries.values()] }, null, 2)
    );
  } catch (err) {
    console.error('[proxy store] could not save:', err.message);
  }
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
  const had = entries.delete(server);
  if (had) save();
  return had;
}

function stats() {
  load();
  const all = [...entries.values()];
  return {
    total: all.length,
    proven: all.filter((e) => e.blocks < BLOCK_LIMIT).length,
    totalSuccesses: all.reduce((n, e) => n + (e.successes ?? 0), 0),
    blockLimit: BLOCK_LIMIT,
  };
}

module.exports = { proven, size, has, recordSuccess, recordBlock, remove, stats, BLOCK_LIMIT, STORE_FILE };
