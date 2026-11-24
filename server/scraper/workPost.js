'use strict';

const { emailsFrom, phonesFrom, relayFrom, postedFromHtml } = require('./extract');

// A row.note matching this means the exit failed, not the post.
const NET_ERR = /blocked|403|429|Timeout|net::|listing failed|fetch failed|http [45]/i;

// Relay addresses / nonces contain long hex runs that a phone regex could
// misread; remove them before phone extraction.
function stripHashes(s) {
  return String(s || '').replace(/[0-9a-f]{16,}/gi, ' ').replace(/[A-Za-z0-9_-]{40,}/g, ' ');
}

// Reads contact out of the opened reply panel: mailto/tel links the panel
// reveals plus any email/phone in its text. Captures the relay email when the
// gate is open on this exit.
async function readReplyPanel(page, row) {
  const mailtos = await page
    .locator('a[href^="mailto:"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0]))
    .catch(() => []);
  const tels = await page
    .locator('a[href^="tel:"]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute('href') || '').replace(/^tel:/i, '')))
    .catch(() => []);
  const panelText = await page
    .locator('.reply-content, .reply-info, #replyContent, [class*="reply"]')
    .allInnerTexts()
    .then((a) => a.join(' '))
    .catch(() => '');

  const em = emailsFrom([...(mailtos || []), panelText].join(' '));
  const ph = phonesFrom([(tels || []).join(' '), stripHashes(panelText)].join(' '));
  if (em.length) {
    row.emails = [...new Set([...row.emails, ...em])];
    row.relay = relayFrom(row.emails) || row.relay || em[0];
  }
  if (ph.length) row.phones = [...new Set([...row.phones, ...ph])];
}

// Fetches a listing in a browser context (which carries the worker's proxy),
// extracts ad-body emails/phones, then opens the reply panel to capture the
// per-listing relay email + any phone the poster shares only through reply.
// Craigslist gates the reply endpoint with hCaptcha on most exits, but some
// proxy exits are served the contact directly — that is why the caller retries
// across proxies. Outcome flags:
//   row.relay          relay email captured (success)
//   row.captchaBlocked reply was hCaptcha-gated on this exit (rotate + retry)
//   row.note           block / network error marker
async function workPost(context, url, opts = {}) {
  const solver = opts.solver;
  const replyWaitMs = Math.max(4000, Math.min(Number(opts.replyWaitMs) || 25000, 120000));
  // Page-load timeout: 0 = no limit. Default 60s (slow links legitimately take >12s).
  const pageTimeoutMs = opts.pageTimeoutMs === 0 ? 0 : Math.max(5000, Number(opts.pageTimeoutMs) || 60000);
  const row = {
    url,
    title: '',
    postedAt: null,
    emails: [],
    phones: [],
    relay: null,
    captchaBlocked: false,
    note: '',
  };

  const page = await context.newPage();
  let replyGated = false;
  let replyEmail = null;
  let siteKey = null;
  const replyPhones = [];
  // Reply flow: POST /init -> {nonce} (or + siteKey_hCaptcha) ; POST /popup ->
  // {options:{emailOk,phoneOk,textOk,chatOk}} ; clicking an option header then
  // calls e.g. POST /mailto -> {"email":"<hash>@res.craigslist.org",...}.
  page.on('response', async (res) => {
    const u = res.url();
    if (!/\/reply\//i.test(u)) return;
    try {
      const body = await res.text();
      if (/siteKey_hCaptcha/i.test(body)) {
        replyGated = true;
        const m = body.match(/"siteKey_hCaptcha"\s*:\s*"([^"]+)"/i);
        if (m) siteKey = m[1];
      }
      const em = emailsFrom(body).filter((e) => /craigslist\.org$/i.test(e));
      if (em.length) replyEmail = em[0];
      // Any option endpoint may carry a phone (we don't guess its name). Skip
      // init/popup/mailto (nonces + hex hashes), and strip hex hashes first.
      const last = u.split('?')[0].split('/').pop().toLowerCase();
      if (!['init', 'popup', 'mailto'].includes(last)) {
        for (const p of phonesFrom(stripHashes(body))) replyPhones.push(p);
      }
    } catch {
      /* ignore */
    }
  });

  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pageTimeoutMs });
    const status = resp ? resp.status() : 0;
    const pageHtml = await page.content().catch(() => '');
    if (status === 403 || status === 429 || /request has been blocked|been blocked|unusual traffic/i.test(pageHtml)) {
      row.note = `blocked (${status || 'rate-limit'})`;
      return row;
    }
    if (status && (status === 404 || status === 410 || status === 401 || status === 404)) {
      row.note = `http ${status}`; // listing gone — terminal, do not retry
      return row;
    }

    row.title = (await page.title()).replace(/\s*-\s*craigslist.*$/i, '').trim();
    row.postedAt = postedFromHtml(pageHtml);

    const bodyText = await page
      .locator('#postingbody, section#postingbody, .postingbody')
      .first()
      .innerText()
      .catch(() => '');
    row.emails = emailsFrom(bodyText);
    row.phones = phonesFrom(bodyText);

    // Open the reply panel. A full-page "#curtain" loading overlay intercepts
    // the click until it hides, so wait for it (then force-click as a fallback).
    const replyBtn = page.locator('button.reply-button, .reply-button').first();
    if (await replyBtn.count()) {
      // Wait for the full page load so the reply JS bundle is initialised before
      // clicking — clicking on bare DOM can make CL's reply panel show
      // "An error occurred". Then let the #curtain overlay clear.
      await page.waitForLoadState('load', { timeout: pageTimeoutMs }).catch(() => {});
      await page.locator('#curtain').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(800);
      await replyBtn.click({ timeout: 15000 }).catch(() =>
        replyBtn.click({ force: true, timeout: 4000 }).catch(() => {})
      );
      // The reply modal can take several seconds to finish loading and render
      // the email/phone. Poll the panel until a contact appears (or a captcha is
      // shown, or the budget runs out) instead of reading it once, too early.
      const deadline = Date.now() + replyWaitMs;
      const opened = new Set();
      let captchaSince = 0;
      while (Date.now() < deadline) {
        // Once the gate passes, the panel lists option headers (email / call /
        // text / chat). The contact is only revealed after clicking each one.
        // Click EVERY option button, whatever its title (email, call, text,
        // chat, …). Tracked by position so untitled/new options are clicked too.
        // Option headers only (not inner buttons like "copy"), so expanding one
        // section never shifts another header's position.
        const headers = page.locator('.reply-option-header');
        const n = await headers.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          if (opened.has(i)) continue;
          opened.add(i);
          const h = headers.nth(i);
          if (!(await h.isVisible().catch(() => false))) continue;
          await h.click({ timeout: 8000 }).catch(() => {});
          await page.waitForResponse((r) => /\/reply\//i.test(r.url()), { timeout: 12000 }).catch(() => {});
          await page.waitForTimeout(1200);
        }
        await readReplyPanel(page, row);
        if (n > 0 && opened.size >= n && (replyEmail || row.relay || replyPhones.length)) break;
        if (replyEmail || row.relay) break;
        // hCaptcha iframe present: an invisible one may still pass and reveal the
        // options a moment later — only give up if it persists 8s with no options.
        const captchaShown = await page
          .locator('#captcha-goes-here-1 iframe, iframe[src*="hcaptcha"]')
          .count()
          .catch(() => 0);
        if (captchaShown && n === 0) {
          if (!captchaSince) captchaSince = Date.now();
          else if (Date.now() - captchaSince > 8000) break;
        }
        // CL's own failure message in the reply panel — record it and stop.
        const errText = await page
          .locator('.cl-reply-flap, .reply-flap, .reply-info')
          .first()
          .innerText()
          .catch(() => '');
        if (/an error occurred/i.test(errText)) {
          row.note = 'reply: an error occurred';
          break;
        }
        await page.waitForTimeout(700);
      }
    } else {
      row.noReply = true; // the post has no reply button (no relay to catch)
    }

    // Optional solver path (only if configured) to crack the gate for the relay.
    if (!replyEmail && replyGated && siteKey && solver && solver.isConfigured()) {
      try {
        const token = await solver.solveHcaptcha(siteKey, url);
        if (token) {
          await page.locator('button.reply-button, .reply-button').first().click({ timeout: 8000 }).catch(() => {});
          await page.waitForResponse((r) => /\/reply\//i.test(r.url()), { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(400);
        }
      } catch (e) {
        row.note = `solver error: ${e.message}`;
      }
    }

    if (replyPhones.length) row.phones = [...new Set([...row.phones, ...replyPhones])];
    if (replyEmail) {
      row.emails = [...new Set([...row.emails, replyEmail])];
      row.relay = relayFrom(row.emails) || replyEmail;
    } else if (replyGated) {
      row.captchaBlocked = true;
    }
  } catch (err) {
    row.note = `listing failed: ${err.message}`;
  } finally {
    await page.close().catch(() => {});
  }
  return row;
}

module.exports = { workPost, NET_ERR };
