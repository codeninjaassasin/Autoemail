'use strict';

const { chromium } = require('playwright');
const config = require('../config');
const contacts = require('../contacts');
const proxies = require('../proxies');
const posts = require('../posts');
const solver = require('./solver');
const { fetchFreeProxies } = require('./proxySource');
const { collectPosts, PER_AREA_CAP } = require('./collectPosts');
const { workPost, NET_ERR } = require('./workPost');
const { makeBroker } = require('./broker');
const { refreshPool } = require('./proxyRefresh');

let currentRunToken = 0;
let stopRequested = false;
let activeBrowser = null; // the current run's browser, so Stop can abort in-flight pages
let activeCtx = null; // the current run's context, so new proxies reach its broker
const PRIORITY_SEED_MS = 30000; // how often verified proxies are pushed to the front
const AUTO_REFRESH_MS = 60 * 60 * 1000; // rebuild the proxy pool every hour of a run...
const AUTO_REFRESH_MIN_VERIFIED = 100; // ...or sooner when fewer verified proxies are usable
const AUTO_REFRESH_MIN_GAP_MS = 15 * 60 * 1000; // but never more often than this

const state = {
  running: false,
  startedAt: null,
  activeWorkers: 0,
  concurrency: 0,
  processed: 0,
  stored: 0,
  dropped: 0,
  parked: 0,
  attempts: 0,
  relaysCaught: 0,
  gated: 0,
  proxyFresh: 0,
  proxyRelax: 0,
  queueTotal: 0,
  queueRemaining: 0,
  queueNew: 0, // posts not stored yet, waiting (served first)
  newPostsFound: 0, // posts not stored yet, queued this run
  autoRefreshes: 0, // automatic proxy pool refreshes this run
  lastAutoRefreshAt: null,
  areas: [],
  categories: [],
  useProxies: false,
  solver: solver.isConfigured() ? solver.PROVIDER : 'none',
  loop: false,
  cycles: 0,
  newThisCycle: 0,
  seenTotal: 0,
  blocked: 0,
  lastBlockAt: null,
  lastEvent: null,
};

let emit = () => {};

function stop() {
  stopRequested = true;
  emit({ type: 'stopping' });
  // Closing the browser makes any in-flight page.goto / reply wait throw, so
  // workers exit immediately instead of finishing their current post.
  if (activeBrowser) activeBrowser.close().catch(() => {});
}

function snapshot() {
  return {
    ...state,
    uptimeMs: state.startedAt ? Date.now() - state.startedAt : 0,
    proxies: proxies.stats(),
    contacts: contacts.count(),
    memory: process.memoryUsage(),
    processUptimeSec: Math.round(process.uptime()),
  };
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function hasContact(row) {
  return (row.emails && row.emails.length) || (row.phones && row.phones.length) || row.relay;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function preflightBrowser(headless = config.headless) {
  try {
    const b = await chromium.launch({ headless });
    await b.close();
  } catch (err) {
    if (/Executable doesn'?t exist|browserType\.launch/i.test(err.message)) {
      throw new Error('Playwright browser is missing or mismatched. Run: npx playwright install chromium');
    }
    throw err;
  }
}

// Continuously scrape free proxies into the broker's fresh queue (no verify —
// workers prove them by use).
async function proxyProducer(ctx, myToken) {
  let lastSeed = 0;
  let lastAuto = Date.now(); // the run starts with whatever pool exists
  while (myToken === currentRunToken && !stopRequested) {
    try {
      // Automatic pool refresh: keep verified proxies, drop unverified ones,
      // gather a new list, and re-queue it in full. Hourly, or sooner when the
      // verified proxies run low.
      const sinceAuto = Date.now() - lastAuto;
      const verified = proxies.usable().length;
      if (sinceAuto >= AUTO_REFRESH_MS || (verified < AUTO_REFRESH_MIN_VERIFIED && sinceAuto >= AUTO_REFRESH_MIN_GAP_MS)) {
        lastAuto = Date.now();
        const reason = sinceAuto >= AUTO_REFRESH_MS ? 'hourly' : `only ${verified} verified proxies left`;
        const r = await refreshPool('keep-verified');
        ctx.broker.reset();
        ctx.broker.addPriority(proxies.usable().map((p) => p.server));
        ctx.broker.addFresh(r.found.map((p) => p.server));
        lastSeed = Date.now();
        state.autoRefreshes++;
        state.lastAutoRefreshAt = lastAuto;
        emit({ type: 'proxies-auto-refresh', reason, kept: r.pruned.kept, removed: r.pruned.removed, found: r.found.length, stats: r.stats });
      }
      // Verified proxies (proven by earlier use) go to the front of the queue.
      // The broker skips servers it already knows, so this adds only new ones.
      if (Date.now() - lastSeed >= PRIORITY_SEED_MS) {
        lastSeed = Date.now();
        ctx.broker.addPriority(proxies.usable().map((p) => p.server));
      }
      const { fresh } = ctx.broker.sizes();
      if (fresh < ctx.concurrency * 3) {
        const { proxies: found } = await fetchFreeProxies();
        proxies.addProxies(found);
        ctx.broker.addFresh(found.map((p) => p.server));
        emit({ type: 'proxies-fetched', count: found.length, stats: proxies.stats() });
      }
    } catch (e) {
      emit({ type: 'warn', message: 'proxy producer: ' + e.message });
    }
    const s = ctx.broker.sizes();
    state.proxyFresh = s.fresh;
    state.proxyRelax = s.relax;
    await sleep(2000);
  }
}

// --- Post queue: new posts first ---------------------------------------------
// Two tiers. `newQueue` holds posts not in the contact list yet; `queue` holds
// posts already stored (re-visited only to update their relay). Workers always
// take a new post when one is waiting. A post first listed after the run's
// first scan is the newest, so it goes to the FRONT of newQueue; a retried post
// goes to the back of its own tier.
function nextItem(ctx) {
  return ctx.newQueue.shift() || ctx.queue.shift() || null;
}
function requeue(ctx, item) {
  const row = item.isNew ? contacts.findByUrl(item.url) : null;
  if (item.isNew && (!row || row.unscraped)) ctx.newQueue.push(item);
  else ctx.queue.push(item);
}
function updateQueueState(ctx) {
  state.queueNew = ctx.newQueue.length;
  state.queueRemaining = ctx.newQueue.length + ctx.queue.length + ctx.inFlight;
}

// One worker: holds a proxy + context, keeps REUSING the same proxy across posts
// until it gets blocked/fails, then relaxes it and leases another. Drops a proxy
// after 10 consecutive failures (handled in proxies.markFail/markGated).
async function runWorker(ctx, myToken) {
  state.activeWorkers++;
  let proxy = null;
  let context = null;

  const dropProxy = async (relaxIt) => {
    if (context) await context.close().catch(() => {});
    context = null;
    if (proxy && relaxIt) ctx.broker.relaxProxy(proxy);
    proxy = null;
  };

  try {
    while (myToken === currentRunToken && !stopRequested) {
      // Ensure we hold a proxy (when proxy mode is on).
      if (ctx.useProxies && !proxy) {
        proxy = ctx.broker.lease();
        if (!proxy) {
          await sleep(500);
          continue;
        }
        try {
          context = await ctx.browser.newContext({ userAgent: UA, proxy: { server: proxy } });
        } catch {
          proxy = null;
          continue;
        }
      }

      const item = nextItem(ctx);
      if (!item) {
        if (ctx.inFlight === 0 && !ctx.collecting) break;
        await sleep(200);
        continue;
      }
      const storedRow = contacts.findByUrl(item.url);
      if (storedRow && storedRow.sent) {
        ctx.pending.delete(item.url); // marked sent while queued — drop it
        continue;
      }
      ctx.inFlight++;
      updateQueueState(ctx);

      try {
        item.attempts = (item.attempts || 0) + 1;
        state.attempts++;
        if (proxy) (item.tried || (item.tried = new Set())).add(proxy);

        let workContext = context;
        if (!ctx.useProxies) workContext = await ctx.browser.newContext({ userAgent: UA });

        const row = await workPost(workContext, item.url, { solver, replyWaitMs: ctx.replyWaitMs, pageTimeoutMs: ctx.pageTimeoutMs });
        row.area = item.area;
        row.category = item.category;
        state.processed++;
        if (!ctx.useProxies) await workContext.close().catch(() => {});

        const gated = row.captchaBlocked;
        const netErr = NET_ERR.test(row.note || '');
        const proxyWorked = !gated && !netErr; // reached the page cleanly

        // --- proxy outcome (sticky): keep a working proxy, relax a bad one ---
        if (ctx.useProxies && proxy) {
          if (proxyWorked) {
            proxies.markSuccess(proxy); // proven good -> stored live, keep using
          } else {
            if (gated) {
              state.gated++;
              const dropped = proxies.markGated(proxy, ctx.blockCooldownMs);
              await dropProxy(!dropped); // relax unless it hit 10 linear fails
            } else {
              const dropped = proxies.markFail(proxy);
              await dropProxy(!dropped);
            }
          }
        }

        // --- store any contact immediately ---
        if (hasContact(row)) {
          const saved = contacts.upsert(row);
          if (saved) {
            if (!item.stored) {
              item.stored = true;
              state.stored++;
            }
            if (row.relay && !item.relayCounted) {
              item.relayCounted = true;
              state.relaysCaught++;
            }
            emit({ type: 'post', row: saved });
          } else if (!item.stored) {
            item.terminal = 'duplicate';
          }
        }

        // --- post outcome: done on relay/gone/duplicate; else retry (another
        // proxy/worker), park after maxProxiesPerPost distinct proxies ---
        const gone = /http (404|410|401)/i.test(row.note || '');
        const triedCount = item.tried ? item.tried.size : item.attempts;
        if (row.relay || gone || item.terminal) {
          ctx.pending.delete(item.url); // finished — a later cycle may queue it again
          if (gone || item.terminal === 'duplicate') {
            state.dropped++;
            emit({ type: 'dropped', url: item.url, reason: gone ? 'gone' : item.terminal });
          }
        } else if (triedCount >= ctx.maxProxiesPerPost) {
          ctx.pending.delete(item.url);
          state.parked++;
          emit({ type: 'parked', url: item.url, tried: triedCount });
        } else {
          requeue(ctx, item);
          if (gated || netErr) emit({ type: 'retry', url: item.url, attempt: item.attempts, reason: gated ? 'captcha' : row.note || 'fail' });
        }
      } catch (e) {
        if (ctx.useProxies) await dropProxy(true);
        requeue(ctx, item);
      } finally {
        ctx.inFlight--;
        updateQueueState(ctx);
      }
    }
  } finally {
    if (context) await context.close().catch(() => {});
    state.activeWorkers--;
  }
}

async function runForever(params, onEvent = () => {}) {
  const myToken = ++currentRunToken;
  stopRequested = false;
  emit = (e) => {
    if (myToken === currentRunToken) {
      state.lastEvent = e.type;
      onEvent(e);
    }
  };

  const areas = (params.areas || []).map((a) => String(a).trim()).filter(Boolean);
  const categories = (params.categories || []).map((c) => String(c).trim()).filter(Boolean);
  if (!categories.length) categories.push('sss');
  const concurrency = Math.max(1, Math.min(Number(params.concurrency) || 10, 30));
  const loop = !!params.loop;
  const useProxies = !!params.useProxies;
  const headless = params.headless === undefined ? config.headless : !!params.headless;
  const pageTimeoutMs = params.pageTimeoutMs === undefined || params.pageTimeoutMs === '' ? 60000 : Math.max(0, Number(params.pageTimeoutMs) || 0);
  const replyWaitMs = Math.max(4000, Math.min(Number(params.replyWaitMs) || 25000, 120000));
  const cycleDelayMs = Math.max(5000, Math.min(Number(params.cycleDelayMs) || 45000, 600000));
  const blockCooldownMs = Math.max(60000, Math.min(Number(params.blockCooldownMs) || 600000, 3600000));
  const collectDelayMs = Math.max(0, Math.min(Number(params.collectDelayMs) || 400, 10000));
  const maxProxiesPerPost = Math.max(10, Math.min(Number(params.maxProxiesPerPost) || 100, 2000));

  Object.assign(state, {
    running: true,
    startedAt: Date.now(),
    activeWorkers: 0,
    processed: 0,
    stored: 0,
    dropped: 0,
    parked: 0,
    attempts: 0,
    relaysCaught: 0,
    gated: 0,
    proxyFresh: 0,
    proxyRelax: 0,
    concurrency,
    queueTotal: 0,
    queueRemaining: 0,
    queueNew: 0,
    newPostsFound: 0,
    autoRefreshes: 0,
    lastAutoRefreshAt: null,
    areas,
    categories,
    useProxies,
    solver: solver.isConfigured() ? solver.PROVIDER : 'none',
    loop,
    cycles: 0,
    newThisCycle: 0,
    seenTotal: 0,
    blocked: 0,
    lastBlockAt: null,
  });

  let browser = null;
  try {
    emit({ type: 'preflight' });
    await preflightBrowser(headless);
    browser = await chromium.launch({ headless });
    activeBrowser = browser;
    emit({ type: 'run-started', areas, categories, concurrency, loop, useProxies, headless, maxProxiesPerPost, solver: state.solver });

    const queue = [];
    const ctx = {
      queue, // posts already stored (relay re-visits)
      newQueue: [], // posts not stored yet — always served first
      everListed: new Set(), // every url seen in any scan this run
      inFlight: 0,
      collecting: true,
      // URLs currently queued or in flight. In loop mode a re-scan must not
      // re-add a post that's still waiting from an earlier cycle (that piled
      // up 100k+ duplicates and the workers could never catch up).
      pending: new Set(),
      browser,
      useProxies,
      replyWaitMs,
      pageTimeoutMs,
      blockCooldownMs,
      maxProxiesPerPost,
      concurrency,
      broker: makeBroker(blockCooldownMs),
    };

    activeCtx = ctx;
    const stopping = () => stopRequested || myToken !== currentRunToken;
    const producerP = useProxies ? proxyProducer(ctx, myToken) : Promise.resolve();

    // Post collector (HTTP, 300/area, loop re-scrapes).
    const collectorP = (async () => {
      try {
        do {
          state.cycles++;
          state.newThisCycle = 0;
          const seen = new Set();
          // Every area x category this cycle; failed fetches are re-appended once
          // so a timeout is retried at the end of the cycle instead of lost.
          const jobs = [];
          for (const area of areas) for (const category of categories) jobs.push({ area, category, retried: false });
          for (let j = 0; j < jobs.length; j++) {
            if (stopping()) break;
            {
              const { area, category } = jobs[j];
              const { urls, items, blocked, error } = await collectPosts(null, { area, category, query: params.query, cap: PER_AREA_CAP });
              if (items && items.length) posts.seen(items, { area, category }); // the All list shows every listed post
              if (error) {
                emit({ type: 'collect-error', area, category, error, willRetry: !jobs[j].retried });
                if (!jobs[j].retried) jobs.push({ area, category, retried: true });
                continue;
              }
              if (blocked) {
                state.blocked++;
                state.lastBlockAt = Date.now();
                emit({ type: 'blocked', area, category });
                if (!stopping()) await sleep(collectDelayMs);
                continue;
              }
              let added = 0;
              let addedNew = 0;
              // Posts already marked sent are done: never visit them again.
              const stored = new Map(contacts.list().map((r) => [r.url, r]));
              const justListed = []; // first listed since the run's first scan: newest
              for (const url of urls) {
                const row = stored.get(url);
                if (seen.has(url) || ctx.pending.has(url) || (row && row.sent)) continue;
                seen.add(url);
                ctx.pending.add(url);
                const firstSighting = !ctx.everListed.has(url);
                ctx.everListed.add(url);
                // A row marked sent/red before its first scrape is still a new post.
                const isNew = !row || !!row.unscraped;
                const item = { url, area, category, attempts: 0, isNew };
                if (isNew) {
                  addedNew++;
                  // The search page lists newest first, so keep page order.
                  if (firstSighting && state.cycles > 1) justListed.push(item);
                  else ctx.newQueue.push(item);
                } else queue.push(item);
                added++;
              }
              if (justListed.length) ctx.newQueue.unshift(...justListed);
              state.queueTotal += added;
              state.newThisCycle += added;
              state.newPostsFound += addedNew;
              state.seenTotal = seen.size;
              updateQueueState(ctx);
              emit({ type: 'collected', area, category, count: urls.length, added, addedNew, cycle: state.cycles });
              if (collectDelayMs && !stopping()) await sleep(collectDelayMs);
            }
          }
          emit({ type: 'cycle-done', cycle: state.cycles, newPosts: state.newThisCycle, seen: seen.size });
          if (loop && !stopping()) {
            const until = Date.now() + cycleDelayMs;
            while (Date.now() < until && !stopping()) await sleep(500);
          }
        } while (loop && !stopping());
      } finally {
        ctx.collecting = false;
        emit({ type: 'queued', total: state.queueTotal });
      }
    })();

    const workers = [];
    for (let i = 0; i < concurrency; i++) workers.push(runWorker(ctx, myToken));
    await Promise.all([collectorP, ...workers]);
    stopRequested = true;
    await producerP.catch(() => {});

    emit({ type: 'done', stored: state.stored, relays: state.relaysCaught, dropped: state.dropped, parked: state.parked, attempts: state.attempts });
    return contacts.list();
  } catch (err) {
    emit({ type: 'error', message: err.message });
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (activeBrowser === browser) activeBrowser = null;
    if (myToken === currentRunToken) activeCtx = null;
    await proxies.flush();
    await posts.flush();
    if (myToken === currentRunToken) {
      stopRequested = false;
      state.running = false;
      state.activeWorkers = 0;
      emit = () => {};
    }
  }
}

// Hand newly gathered proxies to a running scrape's broker (no-op when idle).
function addProxies(servers, { reset = false } = {}) {
  if (!activeCtx || !activeCtx.useProxies) return;
  if (reset) {
    // The pool was rebuilt: re-queue it in full, verified proxies first.
    activeCtx.broker.reset();
    activeCtx.broker.addPriority(proxies.usable().map((p) => p.server));
  }
  activeCtx.broker.addFresh(servers);
}

module.exports = { runForever, stop, preflightBrowser, snapshot, addProxies };
