const http = require('http');
const net = require('net');
const tls = require('tls');

/**
 * Does this proxy actually work?
 *
 * Recovered wholesale from the old pool. A TCP connect only proves something
 * is listening; it says nothing about whether the far end forwards HTTPS, or
 * whether Craigslist will answer it. Roughly eighty per cent of the failures a
 * TCP-gated pool produced were ERR_TIMED_OUT from proxies that connected
 * happily and could not tunnel — each one holding a scraping worker for the
 * full navigation timeout. Paying for a real check here is cheaper than
 * paying for it with a worker.
 */
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

module.exports = { validate, tunnelFetch, TARGET_HOST };
