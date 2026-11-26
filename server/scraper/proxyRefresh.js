'use strict';

// Rebuild the proxy pool: archive it, keep verified proxies (ones that reached
// a listing in real use), remove unverified ones, and gather fresh free
// proxies. Used by the "Refresh proxies" button and by the scrape's automatic
// refresh when the pool goes stale.

const proxies = require('../proxies');
const { fetchFreeProxies } = require('./proxySource');

const ARCHIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // archived pools older than this are deleted

// mode: 'keep-verified' (default), 'empty' (archive and start empty), 'add'.
// Every refresh (button or automatic) also deletes archived pools
// (data/proxies.<time>.json) older than a day.
async function refreshPool(mode = 'keep-verified') {
  let pruned = null;
  if (mode === 'empty') proxies.rebuild();
  else if (mode === 'keep-verified') pruned = proxies.pruneUnverified();
  const archives = proxies.removeOldArchives(ARCHIVE_MAX_AGE_MS);
  const { proxies: found, perSource } = await fetchFreeProxies();
  const added = proxies.addProxies(found);
  await proxies.flush();
  return { mode, pruned, archives, found, added, perSource, stats: proxies.stats() };
}

module.exports = { refreshPool };
