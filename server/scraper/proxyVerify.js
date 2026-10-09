'use strict';

const https = require('https');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

// A tiny neutral endpoint (204, no body) to prove the proxy actually relays
// traffic. Do NOT probe Craigslist — it 403s datacenter proxies, which would
// mark working exits as dead; CL's own gating is handled per-request later.
const PROBE_URL = 'https://www.google.com/generate_204';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function agentFor(server) {
  return server.startsWith('socks') ? new SocksProxyAgent(server) : new HttpsProxyAgent(server);
}

// Resolves true if the proxy returns a usable HTTP response from Craigslist
// within `timeout`. Any error / timeout / non-2xx-3xx => dead.
function verifyOne(server, timeout = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let agent;
    try {
      agent = agentFor(server);
    } catch {
      return done(false);
    }
    const req = https.get(
      PROBE_URL,
      { agent, timeout, headers: { 'User-Agent': UA } },
      (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        res.destroy();
        done(ok);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
  });
}

// Verifies a list of {server,...} in parallel with bounded concurrency; returns
// the subset that are live.
async function verifyBatch(proxies, { concurrency = 100, timeout = 8000 } = {}) {
  const live = [];
  let i = 0;
  async function worker() {
    while (i < proxies.length) {
      const p = proxies[i++];
      if (await verifyOne(p.server, timeout)) live.push(p);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, proxies.length) }, worker));
  return live;
}

module.exports = { verifyOne, verifyBatch };
