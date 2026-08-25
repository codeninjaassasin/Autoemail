const store = require('./proxyStore');
const { validate } = require('./proxyCheck');

/**
 * The proxy discovery worker.
 *
 * Runs on its own, independently of scraping, for as long as the run lasts.
 * Its only job is to keep the ready list topped up: fetch candidate lists,
 * throw out the obvious corpses, append whatever survives. It never blocks a
 * scraping worker and it never stops on its own.
 *
 * The gate is a real HTTPS fetch of Craigslist through the proxy, not a TCP
 * connect. The connect-only version filled the ready list with thousands of
 * entries that answered a socket and could not tunnel: ~80% of scraping
 * failures were ERR_TIMED_OUT, each holding a worker for a full navigation
 * timeout. Checking here costs seconds of a probe; not checking cost minutes
 * of a worker. Every entry that reaches the ready list has now loaded the
 * real target.
 *
 * It still proves less than the scrape does — whether the *reply panel* opens
 * is only knowable by trying — so the workers remain the final arbiter.
 */

const LIST_URLS = (process.env.PROXY_LIST_URLS || [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=text',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
  'https://api.openproxylist.xyz/http.txt',
].join(',')).split(',').map((u) => u.trim()).filter(Boolean);

// Batch width does NOT set discovery throughput — that was measured and it is
// wrong. The finder only probes while a worker is waiting, so supply is gated
// by demand: verified proxies per 4.3 minutes came out at 191 / 192 / 187 /
// 185 for batches of 500 / 1000 / 1000 / 3000. Flat.
//
// What width does change is how many candidates are destroyed to get them.
// Concurrency makes probes time out that would otherwise pass, and since a
// failed probe blocks that proxy for the run, a wide batch permanently
// discards good exits on a false negative:
//
//   batch  pass rate  burned per verified  candidates/min
//     300      9.4%              11              404
//     500      7.6%              13              584
//    1000      4.0-4.6%          22              932
//    3000      2.4%              41            1,771
//
// So the narrowest width that keeps workers fed is the right one. Post
// throughput varied 12-41 across these runs with no relation to batch — that
// is dominated by which exits happen to arrive and how long they survive.
//
// The reason width matters at all is supply: the source lists hold ~7,500
// unique candidates and yield only ~340 genuinely new ones per minute. Every
// width above consumes faster than that, so with blocks that never expire the
// pool drains — in five minutes at 3000, in five hours at 300.
const PROBE_BATCH = Number(process.env.PROXY_PROBE_BATCH ?? 300);
// How long to wait before re-fetching the source lists once every candidate
// from the current copy has been probed. The lists themselves only change
// every few minutes, so hammering them buys nothing.
const REFETCH_IDLE_MS = Number(process.env.PROXY_REFETCH_IDLE_MS ?? 60_000);
// How long to wait for a worker to come asking before probing more. There is
// nowhere to put a verified proxy that nobody wants, so the finder idles
// rather than proving exits that will be stale by the time they are used.
const IDLE_POLL_MS = Number(process.env.PROXY_IDLE_POLL_MS ?? 500);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false;
let stopped = false;
let cycles = 0;
let probed = 0;
let accepted = 0;
// Verified, but no worker was waiting at that instant. A non-zero figure here
// means discovery is outrunning scraping.
let unclaimed = 0;
let lastMessage = 'idle';

/** Merged, deduped, shuffled candidate list from every source. */
async function fetchCandidates() {
  const texts = await Promise.all(
    LIST_URLS.map((u) =>
      fetch(u, { signal: AbortSignal.timeout(25000) })
        .then((r) => (r.ok ? r.text() : ''))
        .catch(() => '')
    )
  );

  const seen = new Set();
  for (const line of texts.join('\n').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // Sources differ: some prefix a scheme, most are bare host:port.
    const m = t.match(/^(?:(https?|socks[45]):\/\/)?((?:[0-9]{1,3}\.){3}[0-9]{1,3}:[0-9]{2,5})$/);
    if (m) seen.add(`${m[1] || 'http'}://${m[2]}`);
  }

  const out = [...seen];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Kept for the tests: the connect-only gate this replaced.
const net = require('net');
function isListening(proxyUrl, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(proxyUrl);
    } catch {
      return resolve(false);
    }
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
    socket.on('close', () => done(false));
  });
}

/**
 * Starts the finder. Returns immediately; the work continues in the
 * background until stop() is called.
 *
 * `sink` receives each batch of proxies that passed the connect check.
 */
function start({ broker, log = () => {} } = {}) {
  if (running) return;
  running = true;
  stopped = false;

  // Candidates waiting to be probed. Relaxed exits are pushed to the front:
  // they have already produced work, so they are the best bet in the queue.
  let queue = [];

  (async () => {
    // Proven-by-outcome exits go first. They were proved by producing a
    // contact, which no probe can establish — but they are still verified on
    // the way through, since one may have died since the last run.
    for (const e of store.proven()) queue.push(e.server);
    if (queue.length > 0) log(`${queue.length} proven proxies queued first from the store`);

    while (!stopped) {
      // Anything whose relaxing period expired goes back to the front.
      const returned = broker.takeRelaxed();
      if (returned.length > 0) {
        queue.unshift(...returned);
        log(`${returned.length} relaxed exit(s) back in the queue for re-verification`);
      }

      if (queue.length === 0) {
        cycles += 1;
        let fetched = [];
        try {
          fetched = await fetchCandidates();
        } catch (err) {
          log(`list fetch failed: ${err.message}`);
        }
        // Currently-blocked candidates are skipped; the lists are re-fetched
        // every cycle and are overwhelmingly dead, so without this the same
        // corpses are re-probed immediately.
        queue = fetched.filter((c) => !broker.isBlocked(c));

        // Blocks expire. The lists only yield ~340 genuinely new candidates a
        // minute against 400+ consumed, so without recycling these the pool
        // drains and a forever-run runs out of things to try. They go at the
        // back — fresh candidates are the better bet.
        const retry = broker.takeExpiredBlocks();
        if (retry.length > 0) {
          queue.push(...retry);
          log(`${retry.length} expired block(s) back in the queue for another attempt`);
        }

        if (queue.length === 0) {
          lastMessage = 'no unblocked candidates — waiting for the lists to change';
          log(lastMessage);
          await sleep(REFETCH_IDLE_MS);
          continue;
        }
        log(`cycle ${cycles}: ${queue.length} candidates (${fetched.length - queue.length} still blocked)`);
      }

      // Nothing to hand a verified proxy to. Verifying now would only produce
      // one that is stale by the time a worker asks, so idle instead.
      if (!broker.hasWaiters()) {
        lastMessage = 'no workers waiting — discovery idle';
        await sleep(IDLE_POLL_MS);
        continue;
      }

      const batch = queue.splice(0, PROBE_BATCH);

      // Each probe hands its result over the moment it resolves, rather than
      // the batch being collected first. Waiting for the batch meant a proxy
      // verified in one second sat unused until the slowest of its thousand
      // batch-mates timed out twenty seconds later — by which point the
      // evidence for it was the stalest in the set.
      await Promise.all(batch.map(async (candidate) => {
        const p = await validate(candidate).catch(() => null);
        probed += 1;
        if (stopped) return;

        if (!p) {
          // Failed verification — blocked, never probed again this run.
          broker.block(candidate, 'failed');
          return;
        }
        accepted += 1;
        store.recordReachable(p);
        // Straight to a waiting worker. If none is waiting the proxy is let
        // go rather than shelved: a verified proxy nobody wanted at the
        // moment it was proved is worth less than the next freshly proved one.
        if (!broker.offer(p)) unclaimed += 1;
      }));
      if (stopped) break;

      lastMessage =
        `probed ${probed}, ${accepted} verified (${((accepted / probed) * 100).toFixed(1)}%), ` +
        `${broker.waiterCount()} worker(s) waiting`;
      log(lastMessage);
    }

    running = false;
    log('proxy finder stopped');
  })().catch((err) => {
    running = false;
    console.error('[proxy finder] crashed:', err.message);
  });
}

function stop() {
  stopped = true;
}

function status() {
  return { running, cycles, probed, accepted, unclaimed, lastMessage };
}

module.exports = { start, stop, status, isListening, fetchCandidates };
