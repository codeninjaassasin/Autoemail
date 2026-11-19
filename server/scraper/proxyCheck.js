'use strict';

const net = require('net');

// Raw TCP reachability probe. Deliberately NOT Playwright: it verifies the
// proxy socket answers even when the browser itself is broken, which is why a
// dead browser can masquerade as "proxies still verified". See the
// playwright-browser-version-mismatch note.
function check(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

async function verifyAll(proxies, { concurrency = 20 } = {}) {
  const alive = [];
  let i = 0;
  async function worker() {
    while (i < proxies.length) {
      const p = proxies[i++];
      if (await check(p.host, p.port)) alive.push(p);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return alive;
}

module.exports = { check, verifyAll };
