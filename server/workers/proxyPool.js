const http = require('http');
const net = require('net');
const tls = require('tls');
const store = require('./proxyStore');

/**
 * A pool of proxies you run yourself — the wireproxy tunnels generated from
 * the Surfshark configs by scripts/build-wireproxy.js.
 *
 * Public proxy lists used to be scraped here too. They were dropped: the
 * usable ones were overwhelmingly cloud-hosted addresses Craigslist blocks by
 * range, they died mid-run constantly, and the ones that survived had already
 * been burned by whoever else was using the same public list. Every part of
 * that machinery — fetching, shuffling, batch probing, datacenter filtering —
 * existed to sift a supply that was never going to work.
 */

// Where the tunnels are, e.g. socks5://127.0.0.1:9001,socks5://127.0.0.1:9002
const PROXIES = (process.env.PROXY_STATIC || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Public proxy lists, used when no tunnels are configured.
//
// These were dropped once — most entries are dead and the survivors are
// shared with everyone else using the same list. They're back because the
// reason scraping failed then turned out to be a cold cookie jar, not the
// addresses: the warm-session fix landed after they were removed, so they
// have never actually been tried with a working scraper. Several sources
// rather than one because the hit rate is low and they overlap heavily.
const LIST_URLS = (process.env.PROXY_LIST_URLS || [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=protocolipport&format=text',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=socks5&proxy_format=protocolipport&format=text',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt',
  'https://api.openproxylist.xyz/http.txt',
].join(',')).split(',').map((u) => u.trim()).filter(Boolean);

// How many candidates a single sweep will probe before giving up, and how
// many at once. Most are dead and each corpse costs a full timeout, so the
// batch is what makes this bearable at all.
// 0 means walk the entire candidate list. Anything less leaves usable
// proxies undiscovered while the run starves for exits.
const RAW_MAX_TRIES = Number(process.env.PROXY_MAX_TRIES ?? 0);
const MAX_CANDIDATES = RAW_MAX_TRIES > 0 ? RAW_MAX_TRIES : Infinity;
const PROBE_BATCH = Number(process.env.PROXY_PROBE_BATCH ?? 50);
const LIST_TTL_MS = 15 * 60 * 1000;

let cachedList = [];
let cachedAt = 0;
let cursor = 0;

function shuffle(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Every source merged, deduped and shuffled. One source failing is fine. */
async function fetchList(force = false) {
  if (PROXIES.length > 0) return PROXIES;
  if (!force && Date.now() - cachedAt < LIST_TTL_MS && cachedList.length > 0) return cachedList;

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

  cachedList = shuffle([...seen]);
  cachedAt = Date.now();
  cursor = 0;
  return cachedList;
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Reachability is proven against Craigslist itself. A proxy can tunnel to one
// host and be reset by another — Craigslist drops connections from addresses
// it knows — so only the real target settles whether it's usable.
const TARGET_HOST = process.env.PROXY_TARGET_HOST || 'www.craigslist.org';

// The exit IP comes from a bare echo: a fraction of the bytes of a geo
// payload, which is the difference between reading it through a slow tunnel
// and timing out. Location is looked up afterwards, directly.
const ECHO_HOST = 'api.ipify.org';
const ECHO_PATH = '/?format=json';
const GEO_HOST = 'ipinfo.io';
const GEO_PATH = '/json';

// A local WireGuard tunnel adds a hop and its own handshake, so this is
// generous by the standards of a direct connection.
const VALIDATE_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 20000);

// What burns an address is how fast it is asked, not how many times in total:
// one exit answered a cold request fine, was challenged through six
// back-to-back ones, then answered again after sitting idle.
const PER_IP_COOLDOWN_MS = Number(process.env.PROXY_IP_COOLDOWN_MS ?? 30000);

// A proxy Craigslist has just challenged will be challenged again if handed
// straight back, so it's taken out of rotation — but only for a while. These
// recover: the same exit answered again after sitting idle. Dropping them for
// good emptied the pool mid-run and sent the rest of the posts out on the
// user's own address, which is worse than waiting.
const BURN_LIMIT = Number(process.env.PROXY_BURN_LIMIT ?? 2);
const PENALTY_MS = Number(process.env.PROXY_PENALTY_MS ?? 10 * 60 * 1000);

// How long a draw will wait for a rested tunnel before giving up on rotating.
const MAX_WAIT_MS = Number(process.env.PROXY_MAX_WAIT_MS ?? 5 * 60 * 1000);

let verified = [];
let ring = 0;
const lastUsed = new Map();
const strikes = new Map();
const penaltyUntil = new Map();

function configured() {
  return PROXIES.length > 0 || LIST_URLS.length > 0;
}

/** True when running on public lists rather than tunnels you control. */
function usingPublicLists() {
  return PROXIES.length === 0 && LIST_URLS.length > 0;
}

/** Pulls a field out of a raw HTTP response without un-chunking it first. */
function field(raw, name) {
  const m = raw.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : '';
}

/**
 * Opens a raw TCP tunnel to host:443 through a SOCKS5 proxy.
 *
 * Implemented directly because the protocol is short and it avoids a
 * dependency: greet with "no auth", then CONNECT naming the host so the proxy
 * resolves it — resolving locally would leak DNS and, for an anycast host, can
 * pick an address the proxy can't reach.
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
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
            name,
            Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          ])
        );
        return;
      }
      if (stage === 'connect') {
        // REP=0 means the tunnel is open; the socket is now a pipe to host.
        if (chunk[0] !== 0x05 || chunk[1] !== 0x00) return fail();
        settled = true;
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
      // A misbehaving proxy can stream an error page indefinitely.
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
  if (proxyUrl.startsWith('socks')) {
    return socks5Connect(proxyUrl, host).then((socket) =>
      socket ? fetchOverSocket(socket, host, path) : null
    );
  }

  // HTTP proxy: CONNECT, then TLS inside the tunnel.
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
      if (res.statusCode !== 200) {
        socket.destroy();
        return done(null);
      }
      fetchOverSocket(socket, host, path).then(done);
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
    req.end();
  });
}

/** Geolocates an address over our own connection, not through the tunnel. */
async function geoOf(ip) {
  try {
    const res = await fetch(`https://${GEO_HOST}/${ip}${GEO_PATH}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
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
 * Checks one tunnel: can it reach Craigslist, and what address does it
 * present? Resolves to null if it can't reach the target — identity is
 * best-effort, since a tunnel that works is worth keeping even when the echo
 * can't be read.
 */
async function validate(proxyUrl) {
  const [reach, ident] = await Promise.all([
    tunnelFetch(proxyUrl, TARGET_HOST, '/'),
    tunnelFetch(proxyUrl, ECHO_HOST, ECHO_PATH),
  ]);
  if (!reach || !/^HTTP\/[\d.]+ \d{3}/.test(reach)) return null;

  const ip = ident ? field(ident, 'ip') : '';
  if (!ip) {
    return { server: proxyUrl, ip: 'unknown', ipVerified: false, org: '', location: 'Exit not read' };
  }
  const info = await geoOf(ip);
  return { server: proxyUrl, ip, ipVerified: true, org: info.org, location: info.location };
}

let warmInFlight = null;

/**
 * Checks every configured tunnel and keeps the ones that work.
 *
 * All of them are probed concurrently — there are a handful, not a thousand,
 * and they're local.
 */
async function warmPool(target = 8, log = () => {}) {
  if (warmInFlight) await warmInFlight.catch(() => {});
  warmInFlight = (async () => {
    const report = { checked: 0, working: 0, target, proxies: [], listSize: 0, error: null };

    let list;
    try {
      list = await fetchList();
    } catch (err) {
      report.error = err.message;
      log(report.error);
      return report;
    }
    report.listSize = list.length;
    if (list.length === 0) {
      report.error = 'No proxies configured or fetched.';
      log(report.error);
      return report;
    }

    // Proxies that have already produced a contact go straight in — they were
    // proven by outcome, which is stronger than any liveness check, and
    // re-probing them each run would throw that away.
    let seeded = 0;
    let recalled = 0;
    for (const e of store.proven()) {
      if (!verified.some((v) => v.server === e.server)) {
        verified.push({ server: e.server, ip: e.ip, location: e.location, org: e.org, ipVerified: true });
        seeded += 1;
      }
    }
    // Reachable-but-unproven ones come back too. Finding these is what makes a
    // cold start expensive — hundreds of candidates probed to fill a pool — and
    // rediscovering the same ones every restart was pure repetition.
    for (const e of store.freshReachable()) {
      if (!verified.some((v) => v.server === e.server)) {
        verified.push({ server: e.server, ip: e.ip, location: e.location, org: e.org, ipVerified: e.ipVerified });
        recalled += 1;
      }
    }
    if (recalled > 0) log(`${recalled} reachable recalled from the store.`);
    // Count what the store contributed, not the size of the live pool. The
    // pool persists across top-ups, so reporting its size here read as "the
    // store is working" when the store was in fact empty.
    if (seeded > 0) log(`${seeded} seeded from the store (${verified.length} in the pool).`);

    // A fixed set you control is worth one full pass; a public list of
    // thousands is swept until enough live ones are found.
    if (PROXIES.length > 0) {
      const results = await Promise.all(PROXIES.map((p) => validate(p)));
      report.checked = PROXIES.length;
      verified = [];
      for (const p of results.filter(Boolean)) {
        if (!verified.some((v) => v.server === p.server)) verified.push(p);
      }
    } else {
      // Keep whatever is already alive; top up around it.
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
        for (const p of live) {
          // Worth remembering even before it produces anything: the probing
          // is the expensive part, and this is what stops the next run
          // repeating it.
          store.recordReachable(p);
          // Dedupe on the exit where it's known — several entries often share
          // one — and on the address otherwise.
          const dupe = verified.some((v) =>
            p.ip && p.ip !== 'unknown' ? v.ip === p.ip : v.server === p.server
          );
          if (!dupe) verified.push(p);
        }
        log(`checked ${report.checked}/${list.length} — ${verified.length}/${target} usable`);
      }
    }

    report.working = verified.length;
    report.proxies = verified.map((p) => ({
      server: p.server,
      ip: p.ip,
      location: p.location,
      org: p.org,
      ipVerified: p.ipVerified,
    }));
    log(`${report.working} proxies ready (from ${report.checked} checked).`);
    return report;
  })();

  try {
    return await warmInFlight;
  } finally {
    warmInFlight = null;
  }
}

/**
 * Hands out the next tunnel round-robin, waiting if the one it lands on is
 * still cooling down.
 *
 * Reservation happens before the wait, so concurrent callers see the slot as
 * taken and spread across different tunnels rather than queueing on one.
 */
async function next({ exclude = null } = {}) {
  // `exclude` holds the exits a single post has already tried. Retries landed
  // on different addresses only because the one just used was still cooling —
  // true whenever the pool is large, and false exactly when it isn't, which is
  // when retrying elsewhere matters most.
  const eligible = exclude ? verified.filter((p) => !exclude.has(p.server)) : verified;
  if (eligible.length === 0) return null;

  const now = Date.now();
  let best = null;
  let bestReady = Infinity;
  for (let i = 0; i < eligible.length; i += 1) {
    const p = eligible[(ring + i) % eligible.length];
    // Eligible once it has both rested since its last use and served out any
    // penalty from being challenged.
    const ready = Math.max(
      (lastUsed.get(p.server) ?? 0) + PER_IP_COOLDOWN_MS,
      penaltyUntil.get(p.server) ?? 0
    );
    if (ready < bestReady) {
      best = p;
      bestReady = ready;
    }
    if (ready <= now) break; // already rested; no need to compare the rest
  }
  ring += 1;
  if (!best) return null;

  const wait = Math.max(0, bestReady - now);
  // Waiting out a penalty is the point, but not indefinitely: past this the
  // caller decides what to do rather than the pool stalling the run.
  if (wait > MAX_WAIT_MS) return null;

  lastUsed.set(best.server, Math.max(now, bestReady));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return { ...best, waitedMs: wait };
}

/** Drops a tunnel that has stopped working. */
function markDead(server) {
  const before = verified.length;
  verified = verified.filter((p) => p.server !== server);
  strikes.delete(server);
  penaltyUntil.delete(server);
  // A proxy that can't carry traffic isn't worth remembering, whatever it
  // produced before — in either tier.
  store.remove(server);
  store.forget(server);
  return before !== verified.length;
}

/** A proxy produced a contact — remember it for future runs. */
function recordSuccess(exit) {
  if (!exit?.server) return;
  store.recordSuccess(exit);
}

/**
 * A proxy was challenged. Counted against its record, and retired once it has
 * been blocked past the limit.
 */
function recordBlock(server) {
  if (!server) return false;
  const retired = store.recordBlock(server);
  if (retired) {
    verified = verified.filter((p) => p.server !== server);
    penaltyUntil.delete(server);
    strikes.delete(server);
  }
  return retired;
}

/**
 * Records a CAPTCHA against a tunnel. Returns true once it has been
 * challenged enough times to be considered burned, at which point it leaves
 * the pool.
 */
function markChallenged(server) {
  const n = (strikes.get(server) ?? 0) + 1;
  strikes.set(server, n);
  if (n >= BURN_LIMIT) {
    // Benched, not discarded — it stays in the pool and comes back once the
    // penalty expires. Strikes reset with it, so a tunnel that misbehaves
    // again later gets the same allowance rather than being condemned by
    // history.
    penaltyUntil.set(server, Date.now() + PENALTY_MS);
    strikes.delete(server);
    return true;
  }
  return false;
}

/** Seconds until the soonest tunnel is eligible again — for reporting. */
function nextAvailableInMs() {
  if (verified.length === 0) return Infinity;
  const now = Date.now();
  return Math.max(
    0,
    Math.min(
      ...verified.map((p) =>
        Math.max(
          (lastUsed.get(p.server) ?? 0) + PER_IP_COOLDOWN_MS,
          penaltyUntil.get(p.server) ?? 0
        )
      )
    ) - now
  );
}

function size() {
  return verified.length;
}

/** Reports the IP seen with no tunnel, so a direct run is still identified. */
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

module.exports = {
  warmPool, next, markDead, markChallenged, size, directIdentity, validate, configured,
  nextAvailableInMs, usingPublicLists, fetchList, recordSuccess, recordBlock, store,
};
