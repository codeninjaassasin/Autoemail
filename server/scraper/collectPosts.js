'use strict';

const { httpGet } = require('./httpGet');

const PER_AREA_CAP = 300; // a CL static search page holds ~300 listings; take them all

function searchUrl(area, category, query) {
  const cat = category || 'sss'; // sss = all "for sale"
  const q = query ? `?query=${encodeURIComponent(query)}` : '';
  return `https://${area}.craigslist.org/search/${cat}${q}`;
}

function isBlocked(status, html) {
  return (
    status === 403 ||
    status === 429 ||
    /request has been blocked|been blocked|unusual traffic/i.test(html || '')
  );
}

// Extracts listing detail URLs from a search page's HTML. Modern CL links are
// absolute https://www.craigslist.org/view/d/<slug>/<id>; older regional pages
// use https://<sub>.craigslist.org/.../d/<slug>/<id>.html.
function listingUrls(html, area, cap) {
  const urls = [];
  const seen = new Set();
  const re = /https:\/\/[a-z0-9.-]+\.craigslist\.org\/[^\s"'<>]*\/d\/[^\s"'<>]+/gi;
  let m;
  while ((m = re.exec(html))) {
    let u = m[0].replace(/[\\"'<>].*$/, '');
    if (!/\/d\/[^/]+\/[^/]+$/i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    urls.push(u);
    if (urls.length >= cap) break;
  }
  return urls;
}

// Returns { urls, blocked }. No browser — plain HTTP, which Craigslist serves
// (200) while it 403-blocks headless browsers.
// Returns { urls, blocked, error }. A network error/timeout is retried with
// backoff; if it still fails, `error` is set so the caller does NOT mistake a
// failed fetch for an area with zero listings.
async function collectPosts(_ctx, { area, category, query, cap = PER_AREA_CAP, tries = 3 }) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const { status, html } = await httpGet(searchUrl(area, category, query), { timeout: 0 }); // no timeout
      if (isBlocked(status, html)) return { urls: [], blocked: true, error: null };
      if (status !== 200) throw new Error(`http ${status}`);
      return { urls: listingUrls(html, area, cap), blocked: false, error: null };
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  return { urls: [], blocked: false, error: lastErr ? lastErr.message : 'unknown' };
}

module.exports = { collectPosts, searchUrl, listingUrls, isBlocked, PER_AREA_CAP };
