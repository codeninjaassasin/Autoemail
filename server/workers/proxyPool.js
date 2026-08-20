const http = require('http');
const net = require('net');
const tls = require('tls');

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

// A proxy Craigslist has challenged will almost certainly be challenged again
// — the block is on the address. Leaving it in the pool means handing it to
// post after post, which looks like rotation while changing nothing.
const BURN_LIMIT = Number(process.env.PROXY_BURN_LIMIT ?? 2);

let verified = [];
let ring = 0;
const lastUsed = new Map();
const strikes = new Map();

function configured() {
  return PROXIES.length > 0;
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
async function warmPool(_target, log = () => {}) {
  if (warmInFlight) await warmInFlight.catch(() => {});
  warmInFlight = (async () => {
    const report = { checked: 0, working: 0, proxies: [], listSize: PROXIES.length, error: null };
    if (!configured()) {
      report.error = 'No tunnels configured (set PROXY_STATIC).';
      log(report.error);
      return report;
    }

    const results = await Promise.all(PROXIES.map((p) => validate(p)));
    report.checked = PROXIES.length;

    verified = [];
    for (const p of results.filter(Boolean)) {
      // Keyed on the tunnel address, not the exit: two tunnels whose exit
      // can't be read both report "unknown", and deduping on that collapsed
      // eight healthy tunnels into one.
      if (!verified.some((v) => v.server === p.server)) verified.push(p);
    }

    report.working = verified.length;
    report.proxies = verified.map((p) => ({
      server: p.server,
      ip: p.ip,
      location: p.location,
      org: p.org,
      ipVerified: p.ipVerified,
    }));
    log(`${report.working}/${report.checked} tunnels usable.`);
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
async function next() {
  if (verified.length === 0) return null;

  const now = Date.now();
  let best = null;
  let bestReady = Infinity;
  for (let i = 0; i < verified.length; i += 1) {
    const p = verified[(ring + i) % verified.length];
    const ready = (lastUsed.get(p.server) ?? 0) + PER_IP_COOLDOWN_MS;
    if (ready < bestReady) {
      best = p;
      bestReady = ready;
    }
    if (ready <= now) break; // already rested; no need to compare the rest
  }
  ring += 1;
  if (!best) return null;

  const startAt = Math.max(now, bestReady);
  lastUsed.set(best.server, startAt);

  const wait = startAt - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  return { ...best, waitedMs: wait };
}

/** Drops a tunnel that has stopped working. */
function markDead(server) {
  const before = verified.length;
  verified = verified.filter((p) => p.server !== server);
  strikes.delete(server);
  return before !== verified.length;
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
    markDead(server);
    return true;
  }
  return false;
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

module.exports = { warmPool, next, markDead, markChallenged, size, directIdentity, validate, configured };
