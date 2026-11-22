'use strict';

// Fills the posted date of listed posts that haven't been scraped yet, so the
// All list can sort them with the rest. Plain HTTP (no browser, no proxy, no
// captcha): the listing page carries `posted: <time datetime=...>`. A listing
// that answers 404/410 has expired and leaves the list.

const posts = require('./posts');
const contacts = require('./contacts');
const { httpGet } = require('./scraper/httpGet');
const { postedFromHtml } = require('./scraper/extract');

const LANES = 2;
const DELAY_MS = 400;
const IDLE_MS = 60000; // nothing to do: look again in a minute
const BLOCK_PAUSE_MS = 10 * 60 * 1000;
const RETRY_FAILED_MS = 60 * 60 * 1000;

let started = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function todo() {
  const stored = new Set(contacts.list().map((r) => r.url));
  const now = Date.now();
  return posts
    .listed()
    .filter((p) => !p.postedAt && !p.gone && !stored.has(p.url))
    .filter((p) => !(p.dateFailedAt && now - Date.parse(p.dateFailedAt) < RETRY_FAILED_MS))
    .map((p) => p.url);
}

async function loop(onEvent) {
  let pausedUntil = 0;
  for (;;) {
    const urls = todo();
    if (!urls.length) {
      await sleep(IDLE_MS);
      continue;
    }
    let i = 0;
    let filled = 0;
    const lane = async () => {
      while (i < urls.length) {
        if (pausedUntil > Date.now()) {
          await sleep(1000);
          continue;
        }
        const url = urls[i++];
        const p = posts.find(url);
        if (!p || p.postedAt || contacts.findByUrl(url)) continue;
        try {
          const { status, html } = await httpGet(url, { timeout: 30000 });
          if (status === 404 || status === 410) posts.update(url, { gone: true });
          else if (status === 403 || status === 429) {
            pausedUntil = Date.now() + BLOCK_PAUSE_MS;
            onEvent({ type: 'warn', message: `Posted-date fill got HTTP ${status}, pausing 10 min.` });
          } else {
            const postedAt = postedFromHtml(html);
            if (postedAt) {
              posts.update(url, { postedAt });
              filled++;
            } else posts.update(url, { dateFailedAt: new Date().toISOString() });
          }
        } catch {
          posts.update(url, { dateFailedAt: new Date().toISOString() });
        }
        await sleep(DELAY_MS);
      }
    };
    await Promise.all(Array.from({ length: LANES }, lane));
    if (filled) onEvent({ type: 'posts-updated', filled });
  }
}

function start(onEvent = () => {}) {
  if (started) return;
  started = true;
  loop(onEvent).catch(() => {
    started = false;
  });
}

module.exports = { start };
