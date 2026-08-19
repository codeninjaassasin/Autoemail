const http = require('http');

// ProxyScrape's free list. Overridable so the same code can point at a paid
// endpoint later without changes here.
const LIST_URL =
  process.env.PROXY_LIST_URL ||
  'https://api.proxyscrape.com/v4/free-proxy-list/get' +
    '?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text';

// Plain HTTP so a validation request can go through an HTTP proxy as a simple
// absolute-URI GET — no CONNECT tunnel, no extra dependency.
const GEO_HOST = 'ip-api.com';
const GEO_PATH = '/json/?fields=status,country,regionName,city,query';

const VALIDATE_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 8000);
// The free list is mostly dead, so a launch must be allowed to give up rather
// than walk all 1000 entries.
const MAX_CANDIDATES = Number(process.env.PROXY_MAX_TRIES ?? 60);
// Probed concurrently — see nextWorking. Kept modest so a run doesn't open
// dozens of sockets at once.
const PROBE_BATCH = Number(process.env.PROXY_PROBE_BATCH ?? 20);
const LIST_TTL_MS = 10 * 60 * 1000;

let cachedList = [];
let cachedAt = 0;
let cursor = 0;
// Proxies already proven live by a preflight check, waiting to be handed to a
// session. Draining this is what keeps a mid-run rotation instant.
let verified = [];

function shuffle(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function fetchList(force = false) {
  const fresh = Date.now() - cachedAt < LIST_TTL_MS;
  if (!force && fresh && cachedList.length > 0) return cachedList;

  const res = await fetch(LIST_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Proxy list fetch failed: HTTP ${res.status}`);
  const text = await res.text();

  // Shuffled so concurrent runs don't march down the same dead prefix.
  cachedList = shuffle(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\/[\d.]+:\d+$/.test(l))
  );
  cachedAt = Date.now();
  cursor = 0;
  return cachedList;
}

/**
 * Asks ip-api.com, through the proxy, what IP it sees. A proxy that answers
 * proves three things at once: it's alive, it forwards traffic, and it tells
 * us the exit IP we'll actually be presenting to Craigslist.
 *
 * Resolves to null for any failure — dead, refused, timed out, garbage body.
 */
function validate(proxyUrl) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(proxyUrl);
    } catch {
      return resolve(null);
    }

    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'GET',
        // Absolute-URI form: this is what makes it a proxy request.
        path: `http://${GEO_HOST}${GEO_PATH}`,
        headers: { Host: GEO_HOST, 'User-Agent': 'curl/8' },
        timeout: VALIDATE_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          // A misbehaving proxy can stream an error page indefinitely.
          if (body.length > 8192) req.destroy();
        });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            if (j.status !== 'success' || !j.query) return resolve(null);
            resolve({
              server: proxyUrl,
              ip: j.query,
              location: [j.city, j.regionName, j.country].filter(Boolean).join(', ') || 'Unknown',
            });
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * Returns the next proxy that actually works, or null once MAX_CANDIDATES
 * consecutive candidates have failed. Callers decide what to do with null —
 * this deliberately doesn't fall back to a direct connection on its own,
 * because that swap needs to be visible rather than silent.
 */
/**
 * Probes the list until `target` proxies have been proven live, and banks
 * them for later sessions.
 *
 * Run before scraping starts: a session that has to go hunting mid-run stalls
 * the scrape, and — more importantly — a run that can't rotate at all is worth
 * knowing about before spending twenty minutes discovering it post by post.
 *
 * Returns a report even when it finds nothing; callers surface that rather
 * than treating an empty pool as an error.
 */
async function warmPool(target = 4, log = () => {}) {
  const report = { checked: 0, working: 0, target, proxies: [], listSize: 0, error: null };

  let list;
  try {
    list = await fetchList();
  } catch (err) {
    report.error = err.message;
    log(`Proxy list unavailable: ${err.message}`);
    return report;
  }
  report.listSize = list.length;

  while (verified.length < target && report.checked < MAX_CANDIDATES) {
    if (cursor >= list.length) {
      list = await fetchList(true).catch(() => list);
      cursor = 0;
      if (list.length === 0) break;
    }
    const batch = list.slice(cursor, cursor + PROBE_BATCH);
    cursor += batch.length;
    report.checked += batch.length;
    if (batch.length === 0) break;

    const live = (await Promise.all(batch.map((c) => validate(c)))).filter(Boolean);
    verified.push(...live);
    log(`Checked ${report.checked} — ${verified.length}/${target} usable so far.`);
  }

  report.working = verified.length;
  report.proxies = verified.map((p) => ({ server: p.server, ip: p.ip, location: p.location }));
  return report;
}

async function nextWorking(log = () => {}) {
  // Spend a pre-checked proxy first — that's the whole point of checking.
  if (verified.length > 0) {
    const picked = verified.shift();
    log(
      `Using pre-checked proxy ${picked.server} — exit IP ${picked.ip} ` +
        `(${picked.location}); ${verified.length} left in the pool.`
    );
    return picked;
  }

  let list;
  try {
    list = await fetchList();
  } catch (err) {
    log(`Proxy list unavailable: ${err.message}`);
    return null;
  }
  if (list.length === 0) {
    log('Proxy list was empty.');
    return null;
  }

  // Most of the free list is dead, and each corpse costs a full timeout.
  // Checking a batch concurrently turns "20 × 8s worst case" into "8s", which
  // is the difference between a usable feature and minutes of dead air per
  // session.
  let tried = 0;
  while (tried < MAX_CANDIDATES) {
    if (cursor >= list.length) {
      // Wrapped without finding one; refetch in case the list has turned over.
      list = await fetchList(true).catch(() => list);
      cursor = 0;
      if (list.length === 0) break;
    }

    const batch = list.slice(cursor, cursor + PROBE_BATCH);
    cursor += batch.length;
    tried += batch.length;
    if (batch.length === 0) break;

    const settled = await Promise.all(batch.map((c) => validate(c)));
    const live = settled.filter(Boolean);
    if (live.length > 0) {
      // Any of them would do; taking the first keeps selection deterministic
      // for a given batch.
      const ok = live[0];
      log(
        `Proxy ${ok.server} is live — exit IP ${ok.ip} (${ok.location}); ` +
          `${batch.length - live.length} of ${batch.length} in that batch were dead.`
      );
      return ok;
    }
    log(`Batch of ${batch.length} all dead (${tried}/${MAX_CANDIDATES} checked).`);
  }

  log(`No working proxy found after ${tried} candidates.`);
  return null;
}

/** Reports the IP seen with no proxy, so a direct run is still identified. */
async function directIdentity() {
  try {
    const res = await fetch(`http://${GEO_HOST}${GEO_PATH}`, { signal: AbortSignal.timeout(8000) });
    const j = await res.json();
    if (j.status !== 'success') return { server: null, ip: 'unknown', location: 'Unknown' };
    return {
      server: null,
      ip: j.query,
      location: [j.city, j.regionName, j.country].filter(Boolean).join(', ') || 'Unknown',
    };
  } catch {
    return { server: null, ip: 'unknown', location: 'Unknown' };
  }
}

module.exports = { warmPool, nextWorking, directIdentity, validate, fetchList };
