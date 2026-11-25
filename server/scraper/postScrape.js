'use strict';

// Scrape ONE post on demand: the ▶ button on a row that isn't scraped yet.
// A click starts a job that RACES several usable proxies (verified by earlier
// use, not cooling down) on the post at once: RACE_LANES visits run in
// parallel, each on a different proxy, and the first relay wins and ends the
// rest. Proxies that have actually returned relays go first. Each proxy gets
// one visit, and a visit ends as soon as the reply request fails
// (failFastReply) instead of waiting out the reply wait. Proxy verdicts follow
// the main engine: reached the page = success, captcha = cooled, network or
// reply failure = a failure (dropped after 10 in a row).
// The job ends when the relay is caught, the post is gone, or it runs out of
// usable proxies / the per-post budget. Independent of the main scrape and the
// relay refresh; all jobs share one browser, closed when the last one ends.

const { launchBrowser } = require('./launch');
const config = require('../config');
const contacts = require('../contacts');
const posts = require('../posts');
const proxies = require('../proxies');
const settings = require('../settings');
const solver = require('./solver');
const { httpGet, UA } = require('./httpGet');
const { workPost, NET_ERR } = require('./workPost');

const MAX_JOBS = 5; // posts being scraped at once
const RACE_LANES = 4; // proxies tried in parallel on one post
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
    // Capped: with racing, an exit that can't load the page in 25 s is better
    // swapped for the next proxy than waited on.
    pageTimeoutMs: Math.min(25000, p.pageTimeout === undefined || p.pageTimeout === '' ? 60000 : Math.max(0, Number(p.pageTimeout) || 0) * 1000 || 25000),
    maxProxies: Math.max(10, Math.min(Number(p.maxProxiesPerPost) || 100, 2000)),
    blockCooldownMs: 600000,
    // No display (server/VM): a visible browser cannot open.
    headless: config.headless || !!p.headless || (process.platform === 'linux' && !process.env.DISPLAY),
  };
}

async function liveBrowser(headless) {
  if (browser && browser.isConnected()) return browser;
  if (!launching) {
    launching = launchBrowser({ headless }).finally(() => {
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

// Best usable proxy this job hasn't tried: the one that has returned the most
// relays, else the pool's own order (elite, then success margin). Re-read every
// time: the main scrape and the refresh change the pool's verdicts meanwhile.
function nextUsable(tried) {
  let best = null;
  for (const p of proxies.usable()) {
    if (tried.has(p.server)) continue;
    if (!best || (p.relays || 0) > (best.relays || 0)) best = p;
  }
  return best ? best.server : null;
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

// "12 proxies: 5 captcha, 4 reply blocked, 2 network error, 1 no relay"
function visitSummary(job) {
  const v = job.visits;
  const parts = [
    [v.captcha, 'captcha'],
    [v.replyBlocked, 'reply blocked'],
    [v.netError, 'network error'],
    [v.noRelay, 'page loaded, no relay'],
  ].filter(([n]) => n).map(([n, w]) => `${n} ${w}`);
  return parts.length ? ` Visits: ${parts.join(', ')}.` : '';
}

function finish(job, outcome, message) {
  if (job.finishedAt) return;
  if (outcome !== 'scraped' && outcome !== 'gone') message += visitSummary(job);
  Object.assign(job, { outcome, message, finishedAt: Date.now(), racing: 0 });
  if (job.abort) job.abort(); // end the other lanes' visits at once
  emit({ type: 'post-scrape', phase: 'result', url: job.url, outcome, message, tried: job.tried });
}

async function work(job) {
  const p = params();
  const tried = new Set();
  const open = new Set(); // contexts of visits in flight, closed when the job ends
  job.abort = () => {
    for (const c of open) c.close().catch(() => {});
  };
  let stored = false; // a contact (ad-text phone/email) was saved along the way
  let contextFails = 0;

  const lane = async () => {
    while (!job.finishedAt) {
      const current = contacts.findByUrl(job.url);
      if (current && current.sent) return finish(job, 'skipped', 'Marked sent meanwhile.');
      if (current && current.relay) return finish(job, 'scraped', 'Relay already caught (by the main scrape).');
      if (tried.size >= p.maxProxies) return;
      const server = nextUsable(tried);
      if (!server) return;
      tried.add(server);
      job.tried = tried.size;

      let context;
      try {
        const b = await liveBrowser(p.headless); // relaunched if it crashed
        context = await b.newContext({ userAgent: UA, proxy: { server } });
        contextFails = 0;
      } catch (err) {
        // A browser problem, not the proxy's fault: don't spend the proxy.
        tried.delete(server);
        job.tried = tried.size;
        if (++contextFails >= 3) return finish(job, 'failed', 'Browser error: ' + err.message);
        await sleep(1000);
        continue;
      }
      if (job.finishedAt) return context.close().catch(() => {});
      open.add(context);
      job.racing = open.size;
      let row = null;
      try {
        row = await workPost(context, job.url, {
          solver,
          replyWaitMs: p.replyWaitMs,
          pageTimeoutMs: p.pageTimeoutMs,
          failFastReply: true,
        });
      } catch {
        /* context closed under it */
      } finally {
        open.delete(context);
        job.racing = open.size;
        await context.close().catch(() => {});
      }
      if (job.finishedAt || !row) continue; // another lane won, or stopped

      const note = row.note || '';
      if (/http (404|410)/i.test(note)) {
        if (await confirmedGone(job.url)) {
          proxies.markSuccess(server);
          posts.update(job.url, { gone: true });
          return finish(job, 'gone', 'The listing is gone (deleted or expired).');
        }
        proxies.markFail(server);
        continue;
      }
      const gated = row.captchaBlocked || /an error occurred/i.test(note);
      if (gated) proxies.markGated(server, p.blockCooldownMs);
      else if (NET_ERR.test(note)) proxies.markFail(server);
      else proxies.markSuccess(server);
      if (row.relay) proxies.markRelay(server);
      const v = job.visits;
      if (row.relay) v.relay++;
      else if (gated) v.captcha++;
      else if (/^reply blocked/.test(note)) v.replyBlocked++;
      else if (NET_ERR.test(note)) v.netError++;
      else v.noRelay++;

      // Store what the visit found, as the main scrape does, even without the relay.
      if (hasContact(row) && !job.finishedAt) {
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
    }
  };

  try {
    await Promise.all(Array.from({ length: RACE_LANES }, lane));
    if (!job.finishedAt) {
      if (!tried.size) finish(job, 'failed', 'No usable proxies right now. Start a scrape with proxies on to verify some.');
      else if (tried.size >= p.maxProxies) finish(job, stored ? 'partial' : 'failed', `Tried ${tried.size} usable proxies (the per-post limit) without catching the relay.`);
      else finish(job, stored ? 'partial' : 'failed', `All usable proxies tried (${tried.size}) without catching the relay.`);
    }
  } catch (err) {
    finish(job, 'failed', err.message);
  } finally {
    job.abort();
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

  const job = { url, startedAt: Date.now(), tried: 0, racing: 0, visits: { relay: 0, captcha: 0, replyBlocked: 0, netError: 0, noRelay: 0 }, stopped: false, finishedAt: null, outcome: null, message: '' };
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
  return true;
}

function snapshot() {
  const now = Date.now();
  for (const [url, j] of jobs) if (j.finishedAt && now - j.finishedAt > RESULT_TTL_MS) jobs.delete(url);
  const list = [...jobs.values()].map(({ stopped, abort, ...j }) => j);
  return { max: MAX_JOBS, active: list.filter((j) => !j.finishedAt).length, jobs: list };
}

module.exports = { start, stop, snapshot, MAX_JOBS };
