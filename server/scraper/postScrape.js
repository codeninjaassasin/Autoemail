'use strict';

// Scrape ONE post on demand: the ▶ button on a row that isn't scraped yet.
// Every request gets its own temporary worker, which uses only USABLE proxies
// from the shared pool (verified by earlier use, not cooling down), best
// first. Proxy verdicts follow the main engine: a proxy that reaches the page
// is kept (marked success) for up to SAME_PROXY_VISITS visits, a captcha gate
// cools it, a network error counts a failure (dropped after 10 in a row).
// The worker ends when the relay is caught, the post is gone, or it runs out
// of usable proxies / the per-post budget. Independent of the main scrape and
// the relay refresh; all temporary workers share one browser, closed when the
// last of them finishes.

const { chromium } = require('playwright');
const config = require('../config');
const contacts = require('../contacts');
const posts = require('../posts');
const proxies = require('../proxies');
const settings = require('../settings');
const solver = require('./solver');
const { httpGet, UA } = require('./httpGet');
const { workPost, NET_ERR } = require('./workPost');

const MAX_JOBS = 5; // temporary workers at once
const SAME_PROXY_VISITS = 3; // visits on a proxy that reaches the page cleanly
const RESULT_TTL_MS = 10 * 60 * 1000; // finished jobs stay in the status this long

const jobs = new Map(); // url -> job
let browser = null;
let launching = null;
let emit = () => {};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasContact = (r) => (r.emails && r.emails.length) || (r.phones && r.phones.length) || r.relay;
const active = () => [...jobs.values()].filter((j) => !j.finishedAt);

// Run parameters: the ones saved from the UI's setup panel.
function params() {
  const p = (settings.get().prefs || {}).params || {};
  return {
    replyWaitMs: Math.max(4000, Math.min((Number(p.replyWait) || 25) * 1000, 120000)),
    pageTimeoutMs: p.pageTimeout === undefined || p.pageTimeout === '' ? 60000 : Math.max(0, Number(p.pageTimeout) || 0) * 1000,
    maxProxies: Math.max(10, Math.min(Number(p.maxProxiesPerPost) || 100, 2000)),
    blockCooldownMs: 600000,
    // No display (server/VM): a visible browser cannot open.
    headless: config.headless || !!p.headless || (process.platform === 'linux' && !process.env.DISPLAY),
  };
}

async function liveBrowser(headless) {
  if (browser && browser.isConnected()) return browser;
  if (!launching) {
    launching = chromium.launch({ headless }).finally(() => {
      launching = null;
    });
  }
  browser = await launching;
  return browser;
}

async function closeBrowserIfIdle() {
  if (active().length || !browser) return;
  const b = browser;
  browser = null;
  await b.close().catch(() => {});
}

// Best usable proxy this job hasn't tried. Re-read every time: the main scrape
// and the refresh change the pool's verdicts while this job runs.
function nextUsable(tried) {
  for (const p of proxies.usable()) if (!tried.has(p.server)) return p.server;
  return null;
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

function finish(job, outcome, message) {
  if (job.finishedAt) return;
  Object.assign(job, { outcome, message, finishedAt: Date.now(), proxy: null });
  emit({ type: 'post-scrape', phase: 'result', url: job.url, outcome, message, tried: job.tried });
}

async function work(job) {
  const p = params();
  const tried = new Set();
  let hold = null; // { server, context }
  let cleanVisits = 0;
  let stored = false; // a contact (ad-text phone/email) was saved along the way
  const release = async () => {
    if (hold) await hold.context.close().catch(() => {});
    hold = null;
  };
  job.abort = release; // Stop closes the context, which ends an in-flight visit at once
  let contextFails = 0;
  try {
    while (!job.stopped) {
      const current = contacts.findByUrl(job.url);
      if (current && current.sent) return finish(job, 'skipped', 'Marked sent meanwhile.');
      if (current && current.relay) return finish(job, 'scraped', 'Relay already caught (by the main scrape).');

      if (!hold) {
        if (tried.size >= p.maxProxies) {
          return finish(job, stored ? 'partial' : 'failed', `Tried ${tried.size} usable proxies (the per-post limit) without catching the relay.`);
        }
        const server = nextUsable(tried);
        if (!server) {
          if (!tried.size) return finish(job, 'failed', 'No usable proxies right now. Start a scrape with proxies on to verify some.');
          return finish(job, stored ? 'partial' : 'failed', `All usable proxies tried (${tried.size}) without catching the relay.`);
        }
        try {
          const b = await liveBrowser(p.headless); // relaunched if it crashed
          hold = { server, context: await b.newContext({ userAgent: UA, proxy: { server } }) };
          contextFails = 0;
        } catch (err) {
          // A browser problem, not the proxy's fault: don't spend the proxy.
          if (++contextFails >= 3) return finish(job, 'failed', 'Browser error: ' + err.message);
          await sleep(1000);
          continue;
        }
        tried.add(server);
        job.tried = tried.size;
        cleanVisits = 0;
      }
      job.proxy = hold.server;

      let row;
      try {
        row = await workPost(hold.context, job.url, { solver, replyWaitMs: p.replyWaitMs, pageTimeoutMs: p.pageTimeoutMs });
      } catch {
        await release();
        continue;
      }
      if (job.stopped) return;
      const server = hold.server;
      const note = row.note || '';

      if (/http (404|410)/i.test(note)) {
        if (await confirmedGone(job.url)) {
          proxies.markSuccess(server);
          posts.update(job.url, { gone: true });
          return finish(job, 'gone', 'The listing is gone (deleted or expired).');
        }
        proxies.markFail(server);
        await release();
        continue;
      }

      const gated = row.captchaBlocked || /an error occurred/i.test(note);
      const netErr = !gated && NET_ERR.test(note);
      if (gated) proxies.markGated(server, p.blockCooldownMs);
      else if (netErr) proxies.markFail(server);
      else proxies.markSuccess(server);

      // Store what the visit found, as the main scrape does, even without the relay.
      if (hasContact(row)) {
        const post = posts.find(job.url) || current || {};
        row.area = post.area || '';
        row.category = post.category || '';
        if (!row.title) row.title = post.title || '';
        const saved = contacts.upsert(row);
        if (!saved) return finish(job, 'duplicate', 'Skipped: its phone already belongs to another contact.');
        stored = true;
        emit({ type: 'post', row: saved });
        if (saved.relay) return finish(job, 'scraped', `Relay caught after ${tried.size} ${tried.size === 1 ? 'proxy' : 'proxies'}.`);
      }

      if (gated || netErr) {
        await release(); // next usable proxy
        continue;
      }
      // Reached the page cleanly but no relay yet: likely a slow exit. Visit
      // again on the same proxy (its context has the page cached), then move on.
      cleanVisits++;
      if (cleanVisits >= SAME_PROXY_VISITS) await release();
      else await sleep(500);
    }
    finish(job, 'stopped', 'Stopped.');
  } catch (err) {
    finish(job, 'failed', err.message);
  } finally {
    await release();
    await closeBrowserIfIdle();
  }
}

// Start a temporary worker for one post. Returns { ok } or { error, status }.
function start(url, onEvent) {
  if (onEvent) emit = onEvent;
  url = String(url || '');
  const known = posts.find(url) || contacts.findByUrl(url);
  if (!known) return { error: 'Unknown post.', status: 404 };
  const row = contacts.findByUrl(url);
  if (row && row.sent) return { error: 'This post is marked sent.', status: 409 };
  const prev = jobs.get(url);
  if (prev && !prev.finishedAt) return { error: 'This post is already being scraped.', status: 409 };
  if (active().length >= MAX_JOBS) return { error: `${MAX_JOBS} posts are already being scraped. Wait for one to finish.`, status: 429 };
  if (!proxies.usable().length) return { error: 'No usable proxies right now. Start a scrape with proxies on to verify some.', status: 409 };

  const job = { url, startedAt: Date.now(), tried: 0, proxy: null, stopped: false, finishedAt: null, outcome: null, message: '' };
  jobs.set(url, job);
  emit({ type: 'post-scrape', phase: 'start', url });
  work(job);
  return { ok: true };
}

function stop(url) {
  const job = jobs.get(String(url || ''));
  if (!job || job.finishedAt) return false;
  job.stopped = true;
  finish(job, 'stopped', 'Stopped.');
  if (job.abort) job.abort();
  return true;
}

function snapshot() {
  const now = Date.now();
  for (const [url, j] of jobs) if (j.finishedAt && now - j.finishedAt > RESULT_TTL_MS) jobs.delete(url);
  const list = [...jobs.values()].map(({ stopped, abort, ...j }) => j);
  return { max: MAX_JOBS, active: list.filter((j) => !j.finishedAt).length, jobs: list };
}

module.exports = { start, stop, snapshot, MAX_JOBS };
