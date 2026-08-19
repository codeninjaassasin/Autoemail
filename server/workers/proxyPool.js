const http = require('http');
const net = require('net');
const tls = require('tls');

// ProxyScrape's free list. Overridable so the same code can point at a paid
// endpoint later without changes here.
// Both protocols are pulled: the http list alone is ~1000 entries, and socks5
// adds ~500 more from a different population. Since most candidates fail, more
// sources is the cheapest way to find residential ones.
const LIST_URLS = (process.env.PROXY_LIST_URL
  ? [process.env.PROXY_LIST_URL]
  : ['http', 'socks5'].map(
      (proto) =>
        'https://api.proxyscrape.com/v4/free-proxy-list/get' +
        `?request=display_proxies&protocol=${proto}&proxy_format=protocolipport&format=text`
    ));

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

// A local WireGuard tunnel adds a hop and its own handshake, so the 8s that
// suits a direct HTTP proxy is short enough to fail identity lookups that
// would otherwise succeed.
const VALIDATE_TIMEOUT_MS = Number(
  process.env.PROXY_TIMEOUT_MS ?? (process.env.PROXY_STATIC ? 20000 : 8000)
);
// The free list is mostly dead, so a launch must be allowed to give up rather
// than walk all 1000 entries.
// Testing against Craigslist itself rejects far more than a generic liveness
// check did — correctly, but it means many more candidates before a hit. The
// list holds ~1000, so a wider search is cheap; batches run concurrently, so
// the cost is roughly one timeout per batch rather than per proxy.
const MAX_CANDIDATES = Number(process.env.PROXY_MAX_TRIES ?? 200);
const PROBE_BATCH = Number(process.env.PROXY_PROBE_BATCH ?? 40);
const LIST_TTL_MS = 10 * 60 * 1000;

// Craigslist blocks datacenter ranges wholesale — no real user browses from
// EC2 — so a cloud-hosted proxy is challenged no matter how healthy it is.
// This matters more than it looks: cloud proxies are the fast, stable ones,
// so a plain "does it work" check quietly selects for exactly the addresses
// that will be blocked. Residential ones are flakier but are the only sort
// that gets through.
const DATACENTER_ORG_RE =
  // `cloud` deliberately unanchored: Pfcloud, UCLOUD and friends are hosting
  // providers that a word-boundary match lets straight through.
  /amazon|aws|google|microsoft|azure|alibaba|tencent|digitalocean|ovh|hetzner|linode|vultr|contabo|choopa|leaseweb|m247|scaleway|oracle|fdcservers|timeweb|serverius|netcup|constant company|cloud|datacenter|data center|hosting|colo\b|vps|dedicated server/i;
const ALLOW_DATACENTER = process.env.PROXY_ALLOW_DATACENTER === '1';

function isDatacenter(org = '') {
  return DATACENTER_ORG_RE.test(org);
}

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

// A fixed set of proxies you control — local VPN containers, or anything else
// that isn't a scraped public list. These are never shuffled away or refetched,
// and the datacenter filter doesn't apply: you chose them deliberately, and a
// VPN exit is a hosting ASN by definition.
const STATIC_PROXIES = (process.env.PROXY_STATIC || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function usingStaticProxies() {
  return STATIC_PROXIES.length > 0;
}

async function fetchList(force = false) {
  if (usingStaticProxies()) return STATIC_PROXIES;

  const fresh = Date.now() - cachedAt < LIST_TTL_MS;
  if (!force && fresh && cachedList.length > 0) return cachedList;

  const texts = await Promise.all(
    LIST_URLS.map((u) =>
      fetch(u, { signal: AbortSignal.timeout(20000) })
        .then((r) => (r.ok ? r.text() : ''))
        // One source being down shouldn't take the others with it.
        .catch(() => '')
    )
  );
  const joined = texts.join('\n');
  if (!joined.trim()) throw new Error('Proxy list fetch failed: all sources empty');

  // Shuffled so concurrent runs don't march down the same dead prefix, and so
  // the two protocols interleave instead of http monopolising the first pass.
  cachedList = shuffle([
    ...new Set(
      joined
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^(https?|socks[45]):\/\/[\d.]+:\d+$/.test(l))
    ),
  ]);
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
/**
 * Opens a raw TCP tunnel to host:443 through a SOCKS5 proxy.
 *
 * Implemented directly because the protocol is short and it avoids a
 * dependency: greet with "no auth", then issue a CONNECT naming the host so
 * the proxy resolves it — resolving locally would leak our DNS and, for
 * Craigslist's anycast setup, can pick an address the proxy can't reach.
 */
function socks5Connect(proxyUrl, host, port = 443) {
  return new Promise((resolve) => {
    const url = new URL(proxyUrl);
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    let stage = 'greet';
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(null);
    };

    socket.setTimeout(VALIDATE_TIMEOUT_MS, fail);
    socket.on('error', fail);
    socket.on('close', fail);

    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])));

    socket.on('data', (chunk) => {
      if (settled) return;
      if (stage === 'greet') {
        // VER=5, METHOD=0 (no auth). Anything else and we can't proceed.
        if (chunk[0] !== 0x05 || chunk[1] !== 0x00) return fail();
        stage = 'connect';
        const name = Buffer.from(host, 'ascii');
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
          name,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ]);
        socket.write(req);
        return;
      }
      if (stage === 'connect') {
        // REP=0 means the tunnel is open; the socket is now a pipe to host.
        if (chunk[0] !== 0x05 || chunk[1] !== 0x00) return fail();
        settled = true;
        stage = 'open';
        socket.setTimeout(0);
        socket.removeAllListeners('data');
        socket.removeAllListeners('close');
        socket.removeAllListeners('error');
        socket.removeAllListeners('timeout');
        resolve(socket);
      }
    });
  });
}

/** Runs the TLS + GET half of a check over an already-open tunnel socket. */
function fetchOverSocket(socket, host, path) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const secure = tls.connect({ socket, servername: host }, () => {
      secure.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
          `User-Agent: ${BROWSER_UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`
      );
    });
    let raw = '';
    secure.setEncoding('utf8');
    secure.on('data', (c) => {
      raw += c;
      if (raw.length > 16384) secure.destroy();
    });
    const finish = () => done(raw || null);
    secure.on('end', finish);
    secure.on('close', finish);
    secure.on('error', () => done(null));
    secure.setTimeout(VALIDATE_TIMEOUT_MS, () => { secure.destroy(); done(null); });
  });
}

function tunnelFetch(proxyUrl, host, path) {
  // SOCKS proxies speak a different protocol entirely — an HTTP CONNECT to
  // one just gets dropped, which is why they were all being scored dead.
  if (proxyUrl.startsWith('socks')) {
    return socks5Connect(proxyUrl, host).then((socket) =>
      socket ? fetchOverSocket(socket, host, path) : null
    );
  }

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
            `User-Agent: ${BROWSER_UA}\r\n` +
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
        org: field(ident, 'org'),
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

    // A local tunnel's own address says nothing: reporting 127.0.0.1 as the
    // exit IP is worse than admitting we couldn't read it, because it looks
    // like a real answer.
    if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
      return {
        server: proxyUrl,
        ip: 'unknown',
        ipVerified: false,
        org: '',
        location: 'Local tunnel — exit not read',
      };
    }

    const info = await geoOf(host);
    return {
      server: proxyUrl,
      ip: host,
      ipVerified: false,
      org: info.org,
      location: info.location,
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
    return {
      org: j.org || '',
      location: [j.city, j.region, j.country].filter(Boolean).join(', ') || 'Unknown',
    };
  } catch {
    return { org: '', location: 'Unknown' };
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
let warmInFlight = null;

/**
 * Serialises warming. The preflight, the background top-up and the per-post
 * refill all call this, and letting two sweeps run at once would have them
 * walking the same cursor and double-probing the same candidates.
 */
async function warmPool(target = 4, log = () => {}) {
  if (warmInFlight) await warmInFlight.catch(() => {});
  if (verified.length >= target) {
    return {
      checked: 0,
      working: verified.length,
      target,
      proxies: verified.map((p) => ({ server: p.server, ip: p.ip, location: p.location, org: p.org, ipVerified: p.ipVerified })),
      listSize: cachedList.length,
      error: null,
    };
  }
  warmInFlight = warmPoolUncoordinated(target, log);
  try {
    return await warmInFlight;
  } finally {
    warmInFlight = null;
  }
}

async function warmPoolUncoordinated(target, log) {
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

  // A fixed list is worth exactly one pass — re-probing the same five entries
  // two hundred times just burns the timeout budget.
  const budget = usingStaticProxies() ? list.length : MAX_CANDIDATES;

  while (verified.length < target && report.checked < budget) {
    if (cursor >= list.length) {
      if (usingStaticProxies()) break;
      list = await fetchList(true).catch(() => list);
      cursor = 0;
      if (list.length === 0) break;
    }
    const batch = list.slice(cursor, cursor + PROBE_BATCH);
    cursor += batch.length;
    report.checked += batch.length;
    if (batch.length === 0) break;

    const live = (await Promise.all(batch.map((c) => validate(c)))).filter(Boolean);

    let rejected = 0;
    for (const p of live) {
      if (!ALLOW_DATACENTER && !usingStaticProxies() && isDatacenter(p.org)) {
        // Reachable, but Craigslist blocks the range on sight. Keeping it
        // would fill the pool with proxies guaranteed to be challenged.
        rejected += 1;
        report.datacenterRejected = (report.datacenterRejected ?? 0) + 1;
        continue;
      }
      // Several entries often share a host on different ports. Rotating onto
      // an address we're already using isn't a rotation, so keep one per IP.
      if (!verified.some((v) => v.ip === p.ip)) verified.push(p);
    }

    log(
      `Checked ${report.checked} — ${verified.length}/${target} usable` +
        (rejected ? `, ${rejected} rejected as datacenter` : '') + '.'
    );
  }

  report.working = verified.length;
  report.proxies = verified.map((p) => ({
    server: p.server,
    ip: p.ip,
    location: p.location,
    org: p.org,
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
