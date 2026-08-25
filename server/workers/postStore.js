const fs = require('fs');
const path = require('path');

/**
 * Which posts have already been dealt with.
 *
 * The scrape runs forever now, re-polling the same listings for whatever is
 * new. Without a memory of what it has already done, every cycle would
 * re-scrape the same few hundred posts and the run would never advance.
 *
 * Two outcomes are recorded, and the distinction matters:
 *
 *   scraped — a contact was extracted. Nothing more to get.
 *   dead    — the reply panel opened cleanly and the poster had published
 *             nothing. That is a real answer, not a failure, and retrying it
 *             on another proxy would hold a worker forever for a post that
 *             can never satisfy it.
 *
 * A post that merely failed (CAPTCHA, timeout, dead proxy) is recorded as
 * neither, so the next cycle picks it up again — which is the whole point of
 * "retry until the contact is scraped".
 *
 * JSONL, appended a line at a time: this is written once per finished post
 * while dozens of workers are running, and it is only ever added to.
 */

const STORE_DIR = process.env.POST_STORE_DIR || path.join(__dirname, '..', '..', 'data');
const POSTS_FILE = path.join(STORE_DIR, 'posts.jsonl');

/**
 * How long before a post is worth opening again.
 *
 * A listing is not frozen once scraped: posters edit them, repost them, and
 * add a phone number they left off the first time. The listing page gives us
 * only the URL — the posted date lives on the post itself — so the only way to
 * notice an update is to open it again on a schedule and compare.
 *
 * Dead posts get a longer interval. "The poster published no contact" is a
 * real answer and usually a lasting one, but it is not permanent: the same
 * listing can gain a reply address later.
 */
const REFRESH_MS = Number(process.env.POST_REFRESH_MS ?? 6 * 60 * 60 * 1000);
const DEAD_REFRESH_MS = Number(process.env.POST_DEAD_REFRESH_MS ?? 24 * 60 * 60 * 1000);

// url -> { url, outcome, area, category, name, postedAt, emails, phones, at }
let posts = new Map();
let loaded = false;

function load() {
  if (loaded) return posts;
  loaded = true;
  try {
    for (const line of fs.readFileSync(POSTS_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        // Last write wins, so a post re-scraped later replaces the earlier
        // record rather than accumulating duplicates.
        if (row?.url) posts.set(row.url, row);
      } catch {
        // One corrupt line must not cost the whole file.
      }
    }
  } catch {
    // No store yet — nothing has been scraped.
  }
  return posts;
}

function append(row) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.appendFileSync(POSTS_FILE, `${JSON.stringify(row)}\n`);
  } catch (err) {
    console.error('[posts] could not append:', err.message);
  }
}

/** What we last recorded for this post, or null. */
function previous(url) {
  load();
  return posts.get(url) ?? null;
}

/**
 * Should this post be opened?
 *
 * Yes if it has never been seen, or if enough time has passed that it may have
 * changed. A post is no longer retired for good on its first answer — it is
 * re-read on a schedule so an edited listing, a repost, or a contact method
 * added after the fact is picked up.
 */
function shouldScrape(url) {
  load();
  const row = posts.get(url);
  if (!row) return true;
  // A removed listing is the one permanent answer. Re-opening it would only
  // find the same tombstone.
  if (row.outcome === 'gone') return false;

  const age = Date.now() - Date.parse(row.at ?? 0);
  if (!Number.isFinite(age)) return true;
  return age > (row.outcome === 'dead' ? DEAD_REFRESH_MS : REFRESH_MS);
}

/**
 * True when a re-read found something different from last time — a newer
 * posted date, or a contact set that has changed. Used only for reporting;
 * the record is rewritten either way.
 */
function hasChanged(url, { postedAt = null, emails = [], phones = [] } = {}) {
  const row = previous(url);
  if (!row) return true;

  const before = Date.parse(row.postedAt ?? 0);
  const now = Date.parse(postedAt ?? 0);
  if (Number.isFinite(before) && Number.isFinite(now) && now > before) return true;

  const same = (a = [], b = []) =>
    a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
  return !same(row.emails, emails) || !same(row.phones, phones);
}

/** Records a post whose contact details were extracted. */
function markScraped(url, info = {}) {
  load();
  if (!url) return;
  const row = {
    url,
    outcome: 'scraped',
    area: info.area ?? null,
    category: info.category ?? null,
    name: info.name ?? null,
    postedAt: info.postedAt ?? null,
    emails: info.emails ?? [],
    phones: info.phones ?? [],
    at: new Date().toISOString(),
  };
  posts.set(url, row);
  append(row);
}

/**
 * Records a post that genuinely publishes no contact.
 *
 * Only call this when the reply panel actually opened and was empty. A
 * CAPTCHA or a timeout is not evidence about the post, and marking those dead
 * would silently discard listings that a different exit would have returned.
 */
function markDead(url, info = {}) {
  load();
  if (!url) return;
  const row = {
    url,
    outcome: 'dead',
    area: info.area ?? null,
    category: info.category ?? null,
    name: info.name ?? null,
    postedAt: info.postedAt ?? null,
    emails: [],
    phones: [],
    at: new Date().toISOString(),
  };
  posts.set(url, row);
  append(row);
}

/**
 * Records a listing that no longer exists. Never re-opened — unlike a dead
 * post, which merely published no contact, a removed one is not coming back.
 */
function markGone(url, info = {}) {
  load();
  if (!url) return;
  const row = {
    url,
    outcome: 'gone',
    area: info.area ?? null,
    category: info.category ?? null,
    name: null,
    postedAt: null,
    emails: [],
    phones: [],
    at: new Date().toISOString(),
  };
  posts.set(url, row);
  append(row);
}

function stats() {
  load();
  let scraped = 0;
  let dead = 0;
  let gone = 0;
  let due = 0;
  for (const row of posts.values()) {
    if (row.outcome === 'scraped') scraped += 1;
    else if (row.outcome === 'dead') dead += 1;
    else if (row.outcome === 'gone') gone += 1;
    if (shouldScrape(row.url)) due += 1;
  }
  return { total: posts.size, scraped, dead, gone, due };
}

module.exports = {
  shouldScrape, previous, hasChanged, markScraped, markDead, markGone, stats,
  POSTS_FILE, REFRESH_MS, DEAD_REFRESH_MS,
};
