'use strict';

// "Scrape now" (the 👊 button on a row): works on ONE post right away, with
// several proxies in parallel, until its relay email (or another contact
// method) is caught. Independent of the main scrape and of relay refresh: it
// has its own browser and proxy broker, shared by every post being rushed.
//
// A post is settled when:
// - a relay email is caught;
// - two clean visits (no captcha gate) give a phone but no email (the post
//   offers no email);
// - two clean visits find no reply button (the post offers no reply at all);
// - the listing is gone (404/410, confirmed by a direct fetch);
// - it was marked sent, or Stop was pressed;
// - MAX_PROXIES proxies were tried or MAX_MS passed (gave up).
// A phone or email in the post body is stored as soon as any visit sees it.

const { launchBrowser } = require('./launch');
const config = require('../config');
const contacts = require('../contacts');
const posts = require('../posts');
const proxies = require('../proxies');
const solver = require('./solver');
const { fetchFreeProxies } = require('./proxySource');
const { makeBroker } = require('./broker');
const { httpGet, UA } = require('./httpGet');
const { workPost, NET_ERR } = require('./workPost');

const LANES = 8; // proxies working on one post at the same time
const MAX_JOBS = 3; // posts rushed at the same time
const MAX_PROXIES = 150;
const MAX_MS = 15 * 60 * 1000;
const SAME_PROXY_VISITS = 2; // visits on a proxy that reached the page cleanly
const BLOCK_COOLDOWN_MS = 10 * 60 * 1000;
const REPLY_WAIT_MS = 25000;
const PAGE_TIMEOUT_MS = 30000; // shorter than the main scrape: a slow proxy is replaced sooner
const SEED_MS = 30000;
const RECENT_MAX = 30;

const jobs = new Map(); // url -> job
const recent = []; // finished jobs, newest last
let broker = null;
let browser = null;
let launching = null;
let supplyRunning = false;
let emit = () => {};
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasBodyContact = (row) =>
  (row.phones && row.phones.length) || (row.emails || []).some((e) => !/craigslist\.org$/i.test(e));

async function liveBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (!launching) {
    launching = launchBrowser({ headless: config.headless }).finally(() => {
      launching = null;
    });
  }
  browser = await launching;
  return browser;
}

function leaseUsable() {
  for (;;) {
    const server = broker.lease();
    if (!server) return null;
    const p = proxies.find(server);
    if (!p) {
      broker.forget(server);
      continue;
    }
    if ((p.cooldownUntil || 0) > Date.now()) {
      broker.relaxProxy(server);
      continue;
    }
    return server;
  }
}

// Feeds the broker while any post is being rushed: proven proxies first, then
// freshly gathered ones.
async function proxySupply() {
  if (supplyRunning) return;
  supplyRunning = true;
  let lastSeed = 0;
  try {
    while (jobs.size) {
      try {
        if (Date.now() - lastSeed >= SEED_MS) {
          lastSeed = Date.now();
          broker.addPriority(proxies.usable().map((p) => p.server));
        }
        if (broker.sizes().fresh < LANES * jobs.size * 2) {
          const { proxies: found } = await fetchFreeProxies();
          proxies.addProxies(found);
          broker.addFresh(found.map((p) => p.server));
        }
      } catch (e) {
        emit({ type: 'warn', message: 'scrape-now proxies: ' + e.message });
      }
      await sleep(2000);
    }
  } finally {
    supplyRunning = false;
  }
}

async function confirmedGone(url) {
  try {
    const { status } = await httpGet(url, { timeout: 30000 });
    return status === 404 || status === 410;
  } catch {
    return false;
  }
}

// Store what a visit found. A post that isn't a contact yet gets its area and
// category from the listed post.
function store(job, scraped) {
  const listed = posts.find(job.url) || {};
  const row = { ...scraped };
  delete row.noReply;
  if (!row.title) delete row.title;
  if (!row.postedAt) row.postedAt = listed.postedAt || null;
  const existing = contacts.findByUrl(job.url);
  if (!existing) {
    row.area = job.area || listed.area || '';
    row.category = job.category || listed.category || '';
    if (!row.title) row.title = listed.title || '';
  }
  const saved = contacts.upsert(row, 'scrape-now');
  if (saved) emit({ type: 'post', row: saved });
  return saved;
}

function finish(job, outcome, extra = {}) {
  if (job.outcome) return;
  job.outcome = outcome;
  job.stopped = true;
  for (const ctx of job.contexts) ctx.close().catch(() => {});
  jobs.delete(job.url);
  const row = contacts.findByUrl(job.url);
  const result = {
    id: job.id,
    url: job.url,
    outcome,
    tried: job.tried.size,
    visits: job.visits,
    ms: Date.now() - job.startedAt,
    finishedAt: Date.now(),
    relay: row ? row.relay || null : null,
    phones: row ? row.phones || [] : [],
    ...extra,
  };
  recent.push(result);
  if (recent.length > RECENT_MAX) recent.shift();
  emit({ type: 'rush-result', ...result });
  if (!jobs.size) {
    // Nothing left to rush: free the browser.
    const b = browser;
    browser = null;
    if (b) b.close().catch(() => {});
    Promise.resolve(proxies.flush()).catch(() => {});
    contacts.persist();
  }
}

// Ends the job when it was marked sent, deleted, stopped, or ran out of budget.
function checkEnd(job) {
  if (job.stopped) return true;
  const row = contacts.findByUrl(job.url);
  if (row && row.sent) {
    finish(job, 'sent');
    return true;
  }
  if (job.tried.size >= MAX_PROXIES || Date.now() - job.startedAt > MAX_MS) {
    finish(job, 'gave-up');
    return true;
  }
  return false;
}

async function lane(job) {
  let context = null;
  let proxy = null;
  let sameVisits = 0;
  let revisit = false;
  // Let go of the held proxy: 'relax' cools it, 'back' returns it to the
  // queue (still good), 'none' forgets it (the pool dropped it).
  const drop = async (how) => {
    if (context) {
      job.contexts.delete(context);
      await context.close().catch(() => {});
    }
    if (proxy && how === 'relax') broker.relaxProxy(proxy);
    if (proxy && how === 'back') broker.giveBack(proxy);
    context = null;
    proxy = null;
  };
  const verdict = (dropped) => (dropped ? 'none' : 'relax');
  try {
    while (!checkEnd(job)) {
      if (!proxy) {
        const server = leaseUsable();
        if (!server) {
          job.waits++; // no proxy ready: waiting for the supply
          await sleep(500);
          continue;
        }
        if (job.tried.has(server)) {
          broker.relaxProxy(server);
          await sleep(50);
          continue;
        }
        try {
          context = await (await liveBrowser()).newContext({ userAgent: UA, proxy: { server } });
        } catch (e) {
          // The browser failed, not the proxy: give the proxy back.
          job.lastError = String((e && e.message) || e).split('\n')[0].slice(0, 200);
          broker.giveBack(server);
          await sleep(1000);
          continue;
        }
        proxy = server;
        job.contexts.add(context);
        job.tried.add(server);
        sameVisits = 0;
      }
      if (!revisit) sameVisits = 0;
      revisit = false;
      job.visits++;

      let scraped;
      try {
        scraped = await workPost(context, job.url, { solver, replyWaitMs: REPLY_WAIT_MS, pageTimeoutMs: PAGE_TIMEOUT_MS });
      } catch {
        await drop('relax');
        continue;
      }
      if (job.stopped) return;
      const note = scraped.note || '';

      if (/http (404|410)/i.test(note)) {
        if (await confirmedGone(job.url)) {
          proxies.markSuccess(proxy);
          if (contacts.findByUrl(job.url)) contacts.setCheckStatus(job.url, 'expired');
          finish(job, 'gone');
          return;
        }
        await drop(verdict(proxies.markFail(proxy)));
        continue;
      }

      if (contacts.isRelay(scraped.relay)) {
        proxies.markSuccess(proxy);
        const before = (contacts.findByUrl(job.url) || {}).relay || null;
        if (!store(job, scraped)) return void finish(job, 'duplicate');
        contacts.setCheckStatus(job.url, 'fresh');
        finish(job, 'relay', { changed: !!before && before !== scraped.relay, from: before });
        await drop('back');
        return;
      }

      // Contacts in the post body are kept even when the reply panel is gated.
      // A NEW post whose phone is already on another contact is a duplicate.
      if (hasBodyContact(scraped) && !store(job, scraped)) return void finish(job, 'duplicate');

      const gated = scraped.captchaBlocked || /an error occurred/i.test(note);
      if (gated) {
        job.gated++;
        await drop(verdict(proxies.markGated(proxy, BLOCK_COOLDOWN_MS)));
        continue;
      }
      if (NET_ERR.test(note) || /^blocked/i.test(note) || /^listing failed/i.test(note)) {
        job.failed++;
        await drop(verdict(proxies.markFail(proxy)));
        continue;
      }

      // Page reached cleanly.
      proxies.markSuccess(proxy);
      if (scraped.phones.length && !scraped.noReply && ++job.cleanNoRelay >= 2) {
        // Two clean visits gave a phone but no email: the post offers no
        // email (one visit could just be a slow reply panel).
        finish(job, store(job, scraped) ? 'phone' : 'duplicate');
        await drop('back');
        return;
      }
      if (scraped.noReply) {
        job.noReply++;
        if (job.noReply >= 2) {
          finish(job, hasBodyContact(scraped) ? 'phone' : 'no-reply');
          await drop('back');
          return;
        }
        await drop('back'); // ask a second proxy to be sure
        continue;
      }
      // Slow proxy: past the gate, but the reply wait ran out. Try it again.
      sameVisits++;
      if (sameVisits < SAME_PROXY_VISITS) {
        revisit = true;
        continue;
      }
      await drop('relax');
    }
  } finally {
    await drop(job.outcome && job.outcome !== 'error' ? 'back' : 'relax');
    // A lane that was launching the browser when the last job ended may have
    // opened a new one: close it.
    if (!jobs.size && browser) {
      const b = browser;
      browser = null;
      b.close().catch(() => {});
    }
  }
}

// Start rushing a post. Returns { ok, job } or { error, status }.
function start(url, onEvent) {
  if (onEvent) emit = onEvent;
  url = String(url || '');
  if (!/^https?:\/\/[^/]*craigslist\.org\//i.test(url)) return { status: 400, error: 'Not a Craigslist post.' };
  if (jobs.has(url)) return { ok: true, job: view(jobs.get(url)) };
  const row = contacts.findByUrl(url);
  const listed = posts.find(url);
  if (!row && !listed) return { status: 404, error: 'Unknown post.' };
  if (row && row.sent) return { status: 409, error: 'This post is marked sent.' };
  if (jobs.size >= MAX_JOBS) return { status: 429, error: `Already scraping ${MAX_JOBS} posts now. Wait for one to finish.` };
  if (!broker) broker = makeBroker(BLOCK_COOLDOWN_MS);
  const job = {
    id: ++seq,
    url,
    area: (row && row.area) || (listed && listed.area) || '',
    category: (row && row.category) || (listed && listed.category) || '',
    startedAt: Date.now(),
    tried: new Set(),
    contexts: new Set(),
    visits: 0,
    gated: 0,
    failed: 0,
    waits: 0,
    lastError: null,
    noReply: 0,
    cleanNoRelay: 0,
    stopped: false,
    outcome: null,
  };
  jobs.set(url, job);
  broker.addPriority(proxies.usable().map((p) => p.server));
  proxySupply();
  emit({ type: 'rush-started', url, lanes: LANES });
  for (let i = 0; i < LANES; i++) {
    lane(job).catch((e) => {
      if (!job.outcome) finish(job, 'error', { error: e.message });
    });
  }
  return { ok: true, job: view(job) };
}

function stop(url) {
  const job = jobs.get(String(url || ''));
  if (!job) return false;
  finish(job, 'stopped');
  return true;
}

function view(job) {
  return { id: job.id, url: job.url, startedAt: job.startedAt, tried: job.tried.size, visits: job.visits, gated: job.gated, failed: job.failed,
    waits: job.waits, lastError: job.lastError, queue: broker ? broker.sizes() : null };
}

function snapshot() {
  return { lanes: LANES, maxJobs: MAX_JOBS, maxProxies: MAX_PROXIES, jobs: [...jobs.values()].map(view), recent: recent.slice(-10) };
}

module.exports = { start, stop, snapshot };
