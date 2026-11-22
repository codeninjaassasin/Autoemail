'use strict';

// Rebuild the proxy pool: archive it, keep verified proxies (ones that reached
// a listing in real use), remove unverified ones, and gather fresh free
// proxies. Used by the "Refresh proxies" button and by the scrape's automatic
// refresh when the pool goes stale.

const proxies = require('../proxies');
const { fetchFreeProxies } = require('./proxySource');

// mode: 'keep-verified' (default), 'empty' (archive and start empty), 'add'.
async function refreshPool(mode = 'keep-verified') {
  let pruned = null;
  if (mode === 'empty') proxies.rebuild();
  else if (mode === 'keep-verified') pruned = proxies.pruneUnverified();
  const { proxies: found, perSource } = await fetchFreeProxies();
  const added = proxies.addProxies(found);
  await proxies.flush();
  return { mode, pruned, found, added, perSource, stats: proxies.stats() };
}

module.exports = { refreshPool };
