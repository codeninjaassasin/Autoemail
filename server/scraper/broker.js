'use strict';

// Proxy broker: fresh (never-tried) servers + a relax list (cooled, to be
// retried when their cooldown expires). No separate liveness check — a worker
// verifies a proxy by actually using it.
function makeBroker(cooldownMs) {
  const fresh = [];
  const relax = []; // { server, readyAt } in ascending readyAt order
  const known = new Set();
  return {
    addFresh(servers) {
      for (const s of servers) {
        if (known.has(s)) continue;
        known.add(s);
        fresh.push(s);
      }
    },
    // Servers to try before anything else already queued (proven proxies).
    addPriority(servers) {
      const add = servers.filter((s) => !known.has(s));
      for (const s of add) known.add(s);
      fresh.unshift(...add);
    },
    // Let a server that left the pool be added again if it comes back.
    forget(server) {
      known.delete(server);
    },
    // A proxy that failed/was-blocked: cool it, retry later.
    relaxProxy(server) {
      relax.push({ server, readyAt: Date.now() + cooldownMs });
    },
    // Lease the next proxy to try: a relax-ready one first, else a fresh one.
    lease() {
      const now = Date.now();
      if (relax.length && relax[0].readyAt <= now) return relax.shift().server;
      if (fresh.length) return fresh.shift();
      return null;
    },
    sizes() {
      return { fresh: fresh.length, relax: relax.length };
    },
  };
}

module.exports = { makeBroker };
