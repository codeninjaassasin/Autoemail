const store = require('./proxyStore');

/**
 * The handoff between verification and scraping.
 *
 * There is no ready list. A proxy that passes verification is handed straight
 * to a worker that is already waiting for one, and that worker begins scraping
 * through it immediately. Nothing sits in a queue.
 *
 * That matters because verification decays. A pool of "verified" proxies is
 * really a pool of proxies that were verified *at some point*: by the time one
 * is drawn it may be minutes stale and dead again. Handing each one straight to
 * the worker that asked for it means the evidence is seconds old.
 *
 * The flow is:
 *
 *   candidate ──verify──▶ pass ──▶ scraping ──CAPTCHA──▶ relaxing
 *                  │                                        │
 *                  └──▶ fail ──▶ blocked            (10 min, then re-verified
 *                                                     as a candidate again)
 *
 * Failure blocks the proxy for the run. The candidate lists are re-fetched
 * every cycle and are ~96% dead, so without this the same corpses are probed
 * over and over — the single largest waste in a long run.
 */

const RELAX_MS = Number(process.env.PROXY_RELAX_MS ?? 10 * 60 * 1000);

/**
 * How long a failed proxy stays blocked before it becomes a candidate again.
 *
 * Blocks used to be permanent, and that was the same mistake CAPTCHA-burns
 * were: treating a transient failure as a verdict. Measured, a probe's failure
 * rate depends heavily on how many run at once — 2.4% pass at a batch of 3000
 * against 9.4% at 300 — so a large share of blocks are false negatives caused
 * by our own concurrency, not by the proxy.
 *
 * It also does not add up. The source lists hold ~7,500 unique candidates and
 * yield ~340 new per minute, while probing consumes 400-1,800 per minute. With
 * permanent blocks the pool drains and a run that is supposed to go forever
 * runs out of things to try.
 *
 * Repeat failures back off exponentially, so a genuinely dead address is not
 * retried every half hour forever, and after enough attempts it is dropped for
 * good.
 */
const BLOCK_TTL_MS = Number(process.env.PROXY_BLOCK_TTL_MS ?? 30 * 60 * 1000);
const BLOCK_MAX_ATTEMPTS = Number(process.env.PROXY_BLOCK_MAX_ATTEMPTS ?? 4);

// Workers queued for a proxy, oldest first. The finder resolves these directly.
const waiters = [];
// server -> { ip, location, workerId, since, posts }
const leased = new Map();
// server -> { ip, location, readyAt, posts }
const relaxing = new Map();
// server -> { until, attempts, reason }. `until` is Infinity once a proxy has
// failed enough times to be considered genuinely dead.
const blocked = new Map();

let handedOut = 0;
let relaxedCount = 0;
let blockedCount = 0;
let returnedCount = 0;
let unblockedCount = 0;

/**
 * A worker asks for a proxy and waits until one is verified for it.
 *
 * Resolves with the lease, or null when the run is stopping. There is no
 * timeout: a worker with no proxy has nothing else it could usefully do, and
 * the finder is always working on the next batch.
 */
function waitForProxy(workerId) {
  return new Promise((resolve) => {
    waiters.push({ workerId, resolve });
  });
}

/**
 * Offers a freshly verified proxy to a waiting worker.
 *
 * Returns true when a worker took it. False means nobody was waiting — the
 * caller should pause rather than accumulate, since a proxy held back is a
 * proxy going stale.
 */
function offer(entry) {
  if (!entry?.server || blocked.has(entry.server) || leased.has(entry.server)) return false;
  const waiter = waiters.shift();
  if (!waiter) return false;

  leased.set(entry.server, {
    ip: entry.ip ?? 'unknown',
    location: entry.location ?? 'unknown',
    workerId: waiter.workerId,
    since: Date.now(),
    posts: 0,
  });
  handedOut += 1;
  waiter.resolve({
    server: entry.server,
    ip: entry.ip ?? 'unknown',
    location: entry.location ?? 'unknown',
    org: entry.org ?? '',
    proven: store.has(entry.server),
  });
  return true;
}

function hasWaiters() {
  return waiters.length > 0;
}

function waiterCount() {
  return waiters.length;
}

/** Wakes every waiting worker with null so a stop doesn't hang on them. */
function abortWaiters() {
  while (waiters.length) waiters.shift().resolve(null);
}

/** Counts a post completed on this lease — for the live readout. */
function noteUse(server) {
  const l = leased.get(server);
  if (l) l.posts += 1;
}

/**
 * Benches a challenged exit. After the relaxing period it becomes a candidate
 * again and is re-verified before any worker sees it — ten minutes is long
 * enough for a free proxy to have died meanwhile.
 */
function relax(server, info = {}) {
  if (!server) return false;
  const l = leased.get(server);
  leased.delete(server);
  if (blocked.has(server) || relaxing.has(server)) return false;
  relaxing.set(server, {
    ip: info.ip ?? l?.ip ?? 'unknown',
    location: info.location ?? l?.location ?? 'unknown',
    readyAt: Date.now() + RELAX_MS,
    posts: l?.posts ?? 0,
  });
  relaxedCount += 1;
  return true;
}

/**
 * Blocks a proxy for a while — it failed verification, or proved it cannot
 * carry traffic. The block expires and it becomes a candidate again, with each
 * repeat failure doubling the wait until it is finally dropped for good.
 */
function block(server, reason = 'failed') {
  if (!server) return false;
  leased.delete(server);
  relaxing.delete(server);

  const prev = blocked.get(server);
  const attempts = (prev?.attempts ?? 0) + 1;
  // Backing off: 30min, then 60, then 120, then never again.
  const until = attempts >= BLOCK_MAX_ATTEMPTS
    ? Infinity
    : Date.now() + BLOCK_TTL_MS * 2 ** (attempts - 1);

  blocked.set(server, { until, attempts, reason });
  if (!prev) blockedCount += 1;
  // Only a proxy that cannot carry traffic at all is worth forgetting from the
  // durable store; a probe that timed out under load proves nothing about it.
  if (reason === 'dead' && attempts >= BLOCK_MAX_ATTEMPTS) {
    store.remove(server);
    store.forget(server);
  }
  return !prev;
}

function isBlocked(server) {
  const b = blocked.get(server);
  if (!b) return false;
  if (b.until === Infinity) return true;
  if (b.until > Date.now()) return true;
  // Expired. Left in place so the attempt count survives — dropping the entry
  // would reset the backoff and a dead address would be retried forever at the
  // shortest interval.
  return false;
}

/**
 * Hands back the servers whose block has expired, so the finder can put them
 * at the back of the candidate queue for another attempt.
 */
function takeExpiredBlocks(limit = 500) {
  const now = Date.now();
  const out = [];
  for (const [server, b] of blocked) {
    if (out.length >= limit) break;
    if (b.until === Infinity || b.until > now) continue;
    // Push the next expiry out immediately, so a candidate that is queued but
    // not yet re-probed is not handed out again on the next sweep.
    b.until = now + BLOCK_TTL_MS * 2 ** b.attempts;
    out.push(server);
    unblockedCount += 1;
  }
  return out;
}

/**
 * Hands back the servers whose relaxing period has expired, so the finder can
 * put them back at the front of the candidate queue.
 */
function takeRelaxed() {
  const now = Date.now();
  const out = [];
  for (const [server, r] of relaxing) {
    if (r.readyAt > now) continue;
    relaxing.delete(server);
    if (blocked.has(server) || leased.has(server)) continue;
    out.push(server);
    returnedCount += 1;
  }
  return out;
}

/** Releases a lease without judgement — used when a worker shuts down. */
function release(server) {
  leased.delete(server);
}

/** A proxy produced a contact — promote it to the durable store, unbounded. */
function recordSuccess(exit) {
  if (!exit?.server) return;
  store.recordSuccess(exit);
}

function snapshot() {
  const now = Date.now();
  const working = [];
  for (const [server, l] of leased) {
    working.push({ server, ip: l.ip, location: l.location, forMs: now - l.since, posts: l.posts });
  }

  const resting = [];
  for (const [server, r] of relaxing) {
    resting.push({
      server, ip: r.ip, location: r.location,
      readyInMs: Math.max(0, r.readyAt - now),
      posts: r.posts,
      penalised: true,
    });
  }
  resting.sort((a, b) => a.readyInMs - b.readyInMs);

  return {
    poolSize: leased.size + relaxing.size,
    // Nothing is ever ready-and-waiting by design; this is the queue of
    // workers waiting for the finder, which is the number that matters.
    readyCount: 0,
    waiting: waiters.length,
    working,
    resting,
    idle: [],
    safe: store.proven().map((e) => ({
      server: e.server, ip: e.ip, location: e.location,
      successes: e.successes ?? 0, blocks: e.blocks ?? 0,
    })),
    droppedCount: blockedCount,
    // Split so a blocked pool that is recycling looks different from one that
    // is being permanently consumed.
    blockedNow: [...blocked.values()].filter((b) => b.until > now).length,
    blockedForGood: [...blocked.values()].filter((b) => b.until === Infinity).length,
    unblockedCount,
    relaxedCount,
    returnedCount,
    handedOut,
  };
}

function size() {
  return leased.size + relaxing.size;
}

function reset() {
  abortWaiters();
  leased.clear();
  relaxing.clear();
  blocked.clear();
  handedOut = 0;
  relaxedCount = 0;
  blockedCount = 0;
  returnedCount = 0;
  unblockedCount = 0;
}

module.exports = {
  waitForProxy, offer, hasWaiters, waiterCount, abortWaiters,
  relax, block, isBlocked, takeRelaxed, takeExpiredBlocks,
  release, recordSuccess, noteUse,
  snapshot, size, reset, store, RELAX_MS, BLOCK_TTL_MS,
};
