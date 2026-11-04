'use strict';

// Keeps the relay email of UNSENT contacts up to date. Independent of the main
// scrape: it has its own browser, its own on/off switch and keeps running
// whether or not a scrape is active. Proxies follow the main engine's rules
// (sticky while working, relax when blocked, dropped after 10 linear failures).
//
// Order of work: never-checked posts first, newest posted first; after that,
// whichever post was checked longest ago. A separate HTTP sweep marks dead
// listings Expired so the browser workers never spend proxies on them.

const { chromium } = require('playwright');
const config = require('../config');
const contacts = require('../contacts');
const proxies = require('../proxies');
const solver = require('./solver');
const { fetchFreeProxies } = require('./proxySource');
const { makeBroker } = require('./broker');
const { httpGet, UA } = require('./httpGet');
const { workPost, NET_ERR } = require('./workPost');

const WORKERS = 3;
const MIN_RECHECK_MS = 60 * 60 * 1000; // never re-visit a post within an hour
const SWEEP_LANES = 2;
const SWEEP_DELAY_MS = 300;
const SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // skip posts swept in the last day
const SWEEP_BLOCK_PAUSE_MS = 10 * 60 * 1000;
const PRIORITY_SEED_MS = 30000;
const SAME_PROXY_VISITS = 3; // visits per post on a proxy that reaches the page cleanly

const blankState = () => ({
  running: false,
  stopping: false,
  startedAt: null,
  workers: WORKERS,
  activeWorkers: 0,
  attempts: 0,
  gated: 0,
  confirmed: 0,
  changed: 0,
  unverified: 0,
  expired: 0,
  sweep: { running: false, total: 0, done: 0, expired: 0, failed: 0, pausedUntil: 0 },
  error: null,
});

let state = blankState();
let run = null; // the active run's context
let emit = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pause(ctx, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until && !ctx.stopped) await sleep(Math.min(250, ms));
}

const postedTime = (r) => (r.postedAt ? Date.parse(r.postedAt) || 0 : 0);

// Never-checked first (newest posted first), then oldest check first.
function comesBefore(a, b) {
  if (!a.checkedAt !== !b.checkedAt) return !a.checkedAt;
  if (!a.checkedAt) return postedTime(a) > postedTime(b);
  return Date.parse(a.checkedAt) < Date.parse(b.checkedAt);
}

function pickNext(busy) {
  const now = Date.now();
  let best = null;
  for (const r of contacts.list()) {
    if (r.sent || !r.url || r.refreshStatus === 'expired' || busy.has(r.url)) continue;
    if (r.checkedAt && now - Date.parse(r.checkedAt) < MIN_RECHECK_MS) continue;
    if (!best || comesBefore(r, best)) best = r;
  }
  return best;
}

// --- Proxies -----------------------------------------------------------------
// The pool is shared with the main scrape, so its verdicts apply here too: a
// proxy it dropped is skipped and one it cooled goes to this broker's relax list.
function leaseUsable(broker) {
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

async function proxySupply(ctx) {
  let lastSeed = 0;
  while (!ctx.stopped) {
    try {
      if (Date.now() - lastSeed >= PRIORITY_SEED_MS) {
        lastSeed = Date.now();
        ctx.broker.addPriority(proxies.usable().map((p) => p.server));
      }
      if (ctx.broker.sizes().fresh < WORKERS * 3) {
        const { proxies: found } = await fetchFreeProxies();
        proxies.addProxies(found);
        ctx.broker.addFresh(found.map((p) => p.server));
      }
    } catch (e) {
      emit({ type: 'warn', message: 'refresh proxies: ' + e.message });
    }
    await pause(ctx, 2000);
  }
}

async function liveBrowser(ctx) {
  if (ctx.browser && ctx.browser.isConnected()) return ctx.browser;
  if (!ctx.launching) {
    ctx.launching = chromium.launch({ headless: ctx.headless }).finally(() => {
      ctx.launching = null;
    });
  }
  ctx.browser = await ctx.launching;
  return ctx.browser;
}

async function acquire(ctx, hold) {
  const server = leaseUsable(ctx.broker);
  if (!server) return false;
  try {
    const browser = await liveBrowser(ctx);
    hold.context = await browser.newContext({ userAgent: UA, proxy: { server } });
    hold.proxy = server;
    return true;
  } catch {
    ctx.broker.relaxProxy(server);
    return false;
  }
}

async function release(ctx, hold, relaxIt) {
  if (hold.context) await hold.context.close().catch(() => {});
  if (hold.proxy && relaxIt) ctx.broker.relaxProxy(hold.proxy);
  hold.context = null;
  hold.proxy = null;
}

// A proxy can answer 404 itself, so "gone" is only final once a direct fetch agrees.
async function confirmedGone(url) {
  try {
    const { status } = await httpGet(url, { timeout: 30000 });
    return status === 404 || status === 410;
  } catch {
    return false;
  }
}

// --- Worker: stays on one post until it is settled -----------------------------
async function refreshOne(ctx, hold, url) {
  const tried = new Set();
  let revisit = false; // next visit reuses the held proxy on purpose
  let sameProxyVisits = 0;
  while (!ctx.stopped) {
    const stored = contacts.findByUrl(url);
    if (!stored || stored.sent) return; // deleted or marked sent meanwhile

    if (tried.size >= ctx.maxProxiesPerPost) {
      const row = contacts.setCheckStatus(url, 'unverified');
      state.unverified++;
      emit({ type: 'refresh-result', outcome: 'unverified', url, tried: tried.size });
      if (row) emit({ type: 'post', row });
      return;
    }

    if (!hold.proxy && !(await acquire(ctx, hold))) {
      await pause(ctx, 500);
      continue;
    }
    if (!revisit && tried.has(hold.proxy)) {
      await release(ctx, hold, true);
      continue;
    }
    if (!revisit) sameProxyVisits = 0;
    revisit = false;
    tried.add(hold.proxy);
    state.attempts++;

    let scraped;
    try {
      scraped = await workPost(hold.context, url, {
        solver,
        replyWaitMs: ctx.replyWaitMs,
        pageTimeoutMs: ctx.pageTimeoutMs,
      });
    } catch {
      await release(ctx, hold, true);
      continue;
    }
    if (ctx.stopped) return; // Stop closed the browser; that says nothing about the proxy
    if (!contacts.findByUrl(url)) return;

    const proxy = hold.proxy;
    const note = scraped.note || '';

    if (/http (404|410)/i.test(note)) {
      if (await confirmedGone(url)) {
        proxies.markSuccess(proxy);
        expire(url);
        return;
      }
      const dropped = proxies.markFail(proxy);
      await release(ctx, hold, !dropped);
      continue;
    }

    if (contacts.isRelay(scraped.relay)) {
      proxies.markSuccess(proxy);
      const before = stored.relay;
      const row = contacts.upsert(scraped, 'refresh');
      const changed = !!before && contacts.isRelay(before) && before !== scraped.relay;
      if (changed) state.changed++;
      else state.confirmed++;
      emit({ type: 'refresh-result', outcome: changed ? 'changed' : 'confirmed', url, from: before, to: scraped.relay, tried: tried.size });
      if (row) emit({ type: 'post', row });
      return;
    }

    // "An error occurred" is the captcha escalating, so it counts as a gate.
    if (scraped.captchaBlocked || /an error occurred/i.test(note)) {
      state.gated++;
      const dropped = proxies.markGated(proxy, ctx.blockCooldownMs);
      await release(ctx, hold, !dropped);
      continue;
    }
    if (NET_ERR.test(note)) {
      const dropped = proxies.markFail(proxy);
      await release(ctx, hold, !dropped);
      continue;
    }

    // Page reached, no gate, no relay. A post stored without a relay may only
    // offer a phone; that still settles it.
    proxies.markSuccess(proxy);
    if (!stored.relay && scraped.phones.length) {
      contacts.upsert(scraped, 'refresh');
      const row = contacts.setCheckStatus(url, 'fresh');
      state.confirmed++;
      emit({ type: 'refresh-result', outcome: 'confirmed', url, tried: tried.size });
      if (row) emit({ type: 'post', row });
      return;
    }
    // Otherwise the proxy was likely just slow: it got past the gate but the
    // reply wait ran out. Keep it (its context now has the page cached) and
    // visit again, as the main scrape does; only then move to another proxy.
    sameProxyVisits++;
    if (sameProxyVisits < SAME_PROXY_VISITS) {
      revisit = true;
      continue;
    }
    await release(ctx, hold, true);
  }
}

function expire(url) {
  const row = contacts.setCheckStatus(url, 'expired');
  state.expired++;
  emit({ type: 'refresh-result', outcome: 'expired', url });
  if (row) emit({ type: 'post', row });
}

async function refreshWorker(ctx) {
  state.activeWorkers++;
  const hold = { proxy: null, context: null };
  try {
    while (!ctx.stopped) {
      const job = pickNext(ctx.busy);
      if (!job) {
        await pause(ctx, 5000);
        continue;
      }
      ctx.busy.add(job.url);
      try {
        await refreshOne(ctx, hold, job.url);
      } finally {
        ctx.busy.delete(job.url);
      }
    }
  } finally {
    await release(ctx, hold, true);
    state.activeWorkers--;
  }
}

// --- HTTP sweep: finds dead listings without a browser, proxy or captcha --------
async function sweep(ctx) {
  const now = Date.now();
  const todo = contacts
    .list()
    .filter(
      (r) =>
        !r.sent &&
        r.url &&
        r.refreshStatus !== 'expired' &&
        !(r.aliveCheckedAt && now - Date.parse(r.aliveCheckedAt) < SWEEP_MAX_AGE_MS)
    )
    .sort((a, b) => postedTime(a) - postedTime(b)) // oldest are the likeliest dead
    .map((r) => r.url);

  const s = state.sweep;
  Object.assign(s, { running: true, total: todo.length, done: 0, expired: 0, failed: 0, pausedUntil: 0 });
  emit({ type: 'refresh-sweep', phase: 'start', total: todo.length });

  let i = 0;
  const lane = async () => {
    while (i < todo.length && !ctx.stopped) {
      if (s.pausedUntil > Date.now()) {
        await pause(ctx, 1000);
        continue;
      }
      const url = todo[i++];
      try {
        const { status } = await httpGet(url, { timeout: 30000 });
        if (status === 404 || status === 410) {
          contacts.setCheckStatus(url, 'expired', { save: false });
          state.expired++;
          s.expired++;
        } else if (status === 403 || status === 429) {
          i = Math.min(i, todo.indexOf(url)); // retry this post after the pause
          s.pausedUntil = Date.now() + SWEEP_BLOCK_PAUSE_MS;
          emit({ type: 'warn', message: `Refresh sweep got HTTP ${status}, pausing 10 min.` });
          continue;
        } else {
          contacts.markAlive(url);
        }
      } catch {
        s.failed++;
      }
      s.done++;
      if (s.done % 100 === 0) {
        contacts.persist();
        emit({ type: 'refresh-sweep', phase: 'progress', done: s.done, total: s.total, expired: s.expired });
        emit({ type: 'contacts-updated' });
      }
      await pause(ctx, SWEEP_DELAY_MS);
    }
  };
  await Promise.all(Array.from({ length: SWEEP_LANES }, lane));
  contacts.persist();
  s.running = false;
  emit({ type: 'refresh-sweep', phase: ctx.stopped ? 'stopped' : 'done', done: s.done, total: s.total, expired: s.expired, failed: s.failed });
  emit({ type: 'contacts-updated' });
}

// --- Run control ---------------------------------------------------------------
function start(params = {}, onEvent = () => {}) {
  if (state.running) return false;
  emit = onEvent;
  state = blankState();
  state.running = true;
  state.startedAt = Date.now();

  const blockCooldownMs = Math.max(60000, Math.min(Number(params.blockCooldownMs) || 600000, 3600000));
  const ctx = {
    stopped: false,
    busy: new Set(),
    broker: makeBroker(blockCooldownMs),
    blockCooldownMs,
    browser: null,
    launching: null,
    headless: params.headless === undefined ? config.headless : !!params.headless,
    replyWaitMs: Math.max(4000, Math.min(Number(params.replyWaitMs) || 25000, 120000)),
    pageTimeoutMs:
      params.pageTimeoutMs === undefined || params.pageTimeoutMs === ''
        ? 60000
        : Math.max(0, Number(params.pageTimeoutMs) || 0),
    maxProxiesPerPost: Math.max(10, Math.min(Number(params.maxProxiesPerPost) || 100, 2000)),
  };
  run = ctx;

  (async () => {
    try {
      await liveBrowser(ctx);
      emit({ type: 'refresh-started', workers: WORKERS, maxProxiesPerPost: ctx.maxProxiesPerPost });
      const tasks = [proxySupply(ctx), sweep(ctx)];
      for (let i = 0; i < WORKERS; i++) tasks.push(refreshWorker(ctx));
      await Promise.all(tasks);
    } catch (err) {
      if (!ctx.stopped) {
        state.error = err.message;
        emit({ type: 'error', message: 'refresh: ' + err.message });
      }
      ctx.stopped = true;
    } finally {
      if (ctx.launching) await ctx.launching.catch(() => {});
      if (ctx.browser) await ctx.browser.close().catch(() => {});
      await proxies.flush();
      contacts.persist();
      state.running = false;
      state.stopping = false;
      state.sweep.running = false;
      run = null;
      emit({ type: 'refresh-stopped', confirmed: state.confirmed, changed: state.changed, unverified: state.unverified, expired: state.expired, attempts: state.attempts });
    }
  })();
  return true;
}

function stop() {
  if (!run) return;
  run.stopped = true;
  state.stopping = true;
  // Closing the browser ends in-flight visits at once.
  if (run.browser) run.browser.close().catch(() => {});
}

function snapshot() {
  const c = { fresh: 0, unverified: 0, expired: 0, unchecked: 0, relayChanges: 0 };
  for (const r of contacts.list()) {
    c.relayChanges += r.relayChanges || 0;
    if (r.sent) continue;
    if (r.refreshStatus && c[r.refreshStatus] !== undefined) c[r.refreshStatus]++;
    else c.unchecked++;
  }
  const b = run ? run.broker.sizes() : { fresh: 0, relax: 0 };
  return { ...state, sweep: { ...state.sweep }, counts: c, proxyFresh: b.fresh, proxyRelax: b.relax };
}

module.exports = { start, stop, snapshot, WORKERS, comesBefore, pickNext };
