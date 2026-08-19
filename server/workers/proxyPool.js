const http = require('http');
const tls = require('tls');

// ProxyScrape's free list. Overridable so the same code can point at a paid
// endpoint later without changes here.
const LIST_URL =
  process.env.PROXY_LIST_URL ||
  'https://api.proxyscrape.com/v4/free-proxy-list/get' +
    '?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text';

// Checked over HTTPS, deliberately. Craigslist is HTTPS-only, so the browser
// reaches it by asking the proxy to CONNECT-tunnel — a capability plenty of
// free HTTP proxies lack even while happily forwarding plain HTTP. Validating
// over HTTP passes those, and the browser then dies with
// ERR_TUNNEL_CONNECTION_FAILED. So the check has to use the same path the
// scraper will.
const GEO_HOST = 'ipinfo.io';
const GEO_PATH = '/json';
// The host the scraper actually needs to reach; reachability is proven against
// this and nothing else.
const TARGET_HOST = process.env.PROXY_TARGET_HOST || 'www.craigslist.org';

const VALIDATE_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 8000);
// The free list is mostly dead, so a launch must be allowed to give up rather
// than walk all 1000 entries.
// Testing against Craigslist itself rejects far more than a generic liveness
// check did — correctly, but it means many more candidates before a hit. The
// list holds ~1000, so a wider search is cheap; batches run concurrently, so
// the cost is roughly one timeout per batch rather than per proxy.
const MAX_CANDIDATES = Number(process.env.PROXY_MAX_TRIES ?? 200);
const PROBE_BATCH = Number(process.env.PROXY_PROBE_BATCH ?? 40);
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

/** Pulls a field out of a raw HTTP response without un-chunking it first. */
function field(raw, name) {
  const m = raw.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : '';
}

/**
 * Opens a CONNECT tunnel through the proxy and fetches ipinfo.io over TLS
 * inside it — the exact sequence the browser performs against Craigslist.
 *
 * Succeeding proves everything that matters in one shot: the proxy is alive,
 * it grants CONNECT, TLS survives the hop, and the JSON names the exit IP we
 * will actually present. Anything less than the full sequence is a proxy the
 * scraper can't use.
 *
 * Resolves to null for any failure — dead, refused, no CONNECT, TLS reset,
 * timeout, garbage body.
 */
function tunnelFetch(proxyUrl, host, path) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(proxyUrl);
    } catch {
      return resolve(null);
    }

    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };

    const req = http.request({
      host: url.hostname,
      port: url.port,
      method: 'CONNECT',
      path: `${host}:443`,
      headers: { Host: `${host}:443` },
      timeout: VALIDATE_TIMEOUT_MS,
    });

    req.on('connect', (res, socket) => {
      // Anything but 200 means the proxy declined to tunnel.
      if (res.statusCode !== 200) {
        socket.destroy();
        return done(null);
      }

      const secure = tls.connect({ socket, servername: host }, () => {
        secure.write(
          `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
            'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
            'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n' +
            'Accept: */*\r\nConnection: close\r\n\r\n'
        );
      });

      let raw = '';
      secure.setEncoding('utf8');
      secure.on('data', (c) => {
        raw += c;
        // A misbehaving proxy can stream an error page indefinitely.
        if (raw.length > 16384) secure.destroy();
      });
      const finish = () => done(raw || null);
      secure.on('end', finish);
      secure.on('close', finish);
      secure.on('error', () => done(null));
      secure.setTimeout(VALIDATE_TIMEOUT_MS, () => { secure.destroy(); done(null); });
    });

    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    req.end();
  });
}

function validate(proxyUrl) {
  // Reachability is tested against Craigslist itself, not a stand-in. Proxies
  // routinely tunnel to one host and get reset by another — Craigslist drops
  // connections from addresses it already knows — so a proxy proven against
  // ipinfo.io still dies in the browser. Only the real target settles it.
  //
  // Identity runs alongside but is best-effort: a proxy that reaches
  // Craigslist is usable even when the geo lookup won't answer, and rejecting
  // it over a missing label would throw away the thing we were looking for.
  return Promise.all([
    tunnelFetch(proxyUrl, TARGET_HOST, '/'),
    tunnelFetch(proxyUrl, GEO_HOST, GEO_PATH),
  ]).then(async ([reach, ident]) => {
    if (!reach || !/^HTTP\/[\d.]+ \d{3}/.test(reach)) return null;

    const ip = ident ? field(ident, 'ip') : '';
    if (ip) {
      return {
        server: proxyUrl,
        ip,
        ipVerified: true,
        location:
          [field(ident, 'city'), field(ident, 'region'), field(ident, 'country')]
            .filter(Boolean)
            .join(', ') || 'Unknown',
      };
    }

    // Many of these proxies only permit certain destinations, so the echo
    // service is unreachable even though Craigslist isn't. Rather than report
    // "unknown", fall back to the proxy's own address — usually but not always
    // the exit — geolocated from here, and mark it unverified so the
    // distinction survives into the UI.
    const host = new URL(proxyUrl).hostname;
    return {
      server: proxyUrl,
      ip: host,
      ipVerified: false,
      location: await geoOf(host),
    };
  });
}

/** Geolocates an address over our own connection, not through the proxy. */
async function geoOf(ip) {
  try {
    const res = await fetch(`https://${GEO_HOST}/${ip}${GEO_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    const j = await res.json();
    return [j.city, j.region, j.country].filter(Boolean).join(', ') || 'Unknown';
  } catch {
    return 'Unknown';
  }
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
    // Several entries often share a host on different ports. Rotating onto an
    // address we're already using isn't a rotation, so keep one per IP.
    for (const p of live) {
      if (!verified.some((v) => v.ip === p.ip)) verified.push(p);
    }
    log(`Checked ${report.checked} — ${verified.length}/${target} usable so far.`);
  }

  report.working = verified.length;
  report.proxies = verified.map((p) => ({
    server: p.server,
    ip: p.ip,
    location: p.location,
    ipVerified: p.ipVerified,
  }));
  return report;
}

let ring = 0;

/**
 * Hands out the next proxy round-robin without consuming it.
 *
 * Rotation is per post, and the pool is almost always smaller than the number
 * of posts, so entries have to come back around rather than being spent once.
 */
function next() {
  if (verified.length === 0) return null;
  const picked = verified[ring % verified.length];
  ring += 1;
  return picked;
}

/** Drops a proxy that has stopped working, so it isn't handed out again. */
function markDead(server) {
  const before = verified.length;
  verified = verified.filter((p) => p.server !== server);
  strikes.delete(server);
  return before !== verified.length;
}

// A proxy Craigslist has challenged will almost certainly be challenged again
// — the block is on the address. Leaving it in the pool means handing it to
// post after post, which looks like rotation while changing nothing.
const BURN_LIMIT = Number(process.env.PROXY_BURN_LIMIT ?? 2);
const strikes = new Map();

/**
 * Records a CAPTCHA against a proxy. Returns true once it has been challenged
 * enough times to be considered burned, at which point it leaves the pool.
 */
function markChallenged(server) {
  const n = (strikes.get(server) ?? 0) + 1;
  strikes.set(server, n);
  if (n >= BURN_LIMIT) {
    markDead(server);
    return true;
  }
  return false;
}

/** How many verified proxies are currently available. */
function size() {
  return verified.length;
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
    const res = await fetch(`https://${GEO_HOST}${GEO_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (!j.ip) return { server: null, ip: 'unknown', location: 'Unknown' };
    return {
      server: null,
      ip: j.ip,
      location: [j.city, j.region, j.country].filter(Boolean).join(', ') || 'Unknown',
    };
  } catch {
    return { server: null, ip: 'unknown', location: 'Unknown' };
  }
}

module.exports = { warmPool, next, markDead, markChallenged, size, nextWorking, directIdentity, validate, fetchList };
