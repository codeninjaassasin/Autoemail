'use strict';

const { chromium } = require('playwright');
const config = require('../config');
const contacts = require('../contacts');
const proxies = require('../proxies');
const solver = require('./solver');
const { fetchFreeProxies } = require('./proxySource');
const { collectPosts, PER_AREA_CAP } = require('./collectPosts');
const { workPost, NET_ERR } = require('./workPost');
const { makeBroker } = require('./broker');

let currentRunToken = 0;
let stopRequested = false;
let activeBrowser = null; // the current run's browser, so Stop can abort in-flight pages

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
  while (myToken === currentRunToken && !stopRequested) {
    try {
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

      const item = ctx.queue.shift();
      if (!item) {
        if (ctx.inFlight === 0 && !ctx.collecting) break;
        await sleep(200);
        continue;
      }
      ctx.inFlight++;
      state.queueRemaining = ctx.queue.length + ctx.inFlight;

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
          ctx.queue.push(item);
          if (gated || netErr) emit({ type: 'retry', url: item.url, attempt: item.attempts, reason: gated ? 'captcha' : row.note || 'fail' });
        }
      } catch (e) {
        if (ctx.useProxies) await dropProxy(true);
        ctx.queue.push(item);
      } finally {
        ctx.inFlight--;
        state.queueRemaining = ctx.queue.length + ctx.inFlight;
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
      queue,
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
              const { urls, blocked, error } = await collectPosts(null, { area, category, query: params.query, cap: PER_AREA_CAP });
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
              for (const url of urls) {
                if (seen.has(url) || ctx.pending.has(url)) continue;
                seen.add(url);
                ctx.pending.add(url);
                queue.push({ url, area, category, attempts: 0 });
                added++;
              }
              state.queueTotal += added;
              state.newThisCycle += added;
              state.seenTotal = seen.size;
              state.queueRemaining = queue.length + ctx.inFlight;
              emit({ type: 'collected', area, category, count: urls.length, added, cycle: state.cycles });
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
    await proxies.flush();
    if (myToken === currentRunToken) {
      stopRequested = false;
      state.running = false;
      state.activeWorkers = 0;
      emit = () => {};
    }
  }
}

module.exports = { runForever, stop, preflightBrowser, snapshot };
