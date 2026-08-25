const { chromium } = require('playwright');
const os = require('os');
const { execSync } = require('child_process');
const proxyLease = require('./proxyLease');
const proxyFinder = require('./proxyFinder');
const postStore = require('./postStore');
const contactStore = require('./contactStore');

// ── Selectors — update these if Craigslist changes its markup ─────
// Verified against live craigslist markup. The old per-subdomain search
// URL (https://{area}.craigslist.org/search/{cat}) now 301s to the
// canonical www URL below, so we request that directly.
const LISTING_POST_LINK = '.cl-static-search-result a';  // links on the search results page
const NAME_SELECTOR     = '#titletextonly';
const REPLY_BTN         = 'button.reply-button';
const BODY_SELECTOR     = 'section#postingbody';
// Clicking REPLY_BTN renders one tab per contact method the poster enabled
// ("email", and where offered "call"/"text"). The value only appears after
// the tab itself is clicked.
const REPLY_OPTION      = 'button.reply-option-header';
const REPLY_EMAIL_LINK  = '.reply-email-address a[href^="mailto:"]';
const REPLY_CONTENT     = '.reply-content';
// The search page has no /init call to inspect, so a challenge there is
// spotted from the markup the challenge widget leaves behind.
const CAPTCHA_MARKERS   = [
  'iframe[src*="hcaptcha"]',
  'iframe[src*="recaptcha"]',
  'script[src*="hcaptcha"]',
  '.h-captcha',
  '#px-captcha',
];
// ─────────────────────────────────────────────────────────────────

// Deliberately narrow: an area with genuinely zero listings must not read as
// a challenge, or we'd relaunch the browser over an empty category.
const CAPTCHA_TEXT_RE = /(?:are you a human|verify you(?:'re| are) (?:a )?human|unusual traffic|access denied|blocked)/i;

// What Craigslist says when a listing is no longer there. Deliberately
// specific: a false positive here deletes contacts we already collected.
const POST_GONE_RE =
  /(?:this posting has been (?:deleted|flagged for removal)|this posting has expired|posting has been deleted by its author|this post has been (?:deleted|removed))/i;

/**
 * True when the page is a tombstone rather than a listing.
 *
 * Checked before waiting for the posting body, because a removed post has no
 * body and would otherwise be indistinguishable from a slow proxy.
 */
async function isPostGone(page) {
  const text = await page.innerText('body').catch(() => '');
  if (!text) return false;
  // Only the top of the page: the phrase can appear inside an unrelated ad
  // body further down, and a false positive costs us real contacts.
  return POST_GONE_RE.test(text.slice(0, 1200));
}

/** True if the page currently shows a bot challenge rather than content. */
async function looksChallenged(page) {
  for (const sel of CAPTCHA_MARKERS) {
    if (await page.$(sel).catch(() => null)) return true;
  }
  const text = await page.innerText('body').catch(() => '');
  return CAPTCHA_TEXT_RE.test(text);
}

// Per area *and* per category. 0 means take everything the search returns —
// safe now that a scrape runs as a background job rather than inside the
// request that started it, which is what the old cap existed to protect.
const RAW_MAX = Number(process.env.MAX_POSTS_PER_AREA ?? 0);
const MAX_POSTS_PER_AREA = RAW_MAX > 0 ? RAW_MAX : Infinity;

// Hitting posts back to back is a bot signal on its own, independent of which
// address they come from — no human opens 25 listings in 90 seconds. The gap
// is randomised because a precise interval is itself a pattern.
const PACE_MIN_MS = Number(process.env.PACE_MIN_MS ?? 5000);
const PACE_MAX_MS = Number(process.env.PACE_MAX_MS ?? 15000);

function paceDelay() {
  const lo = Math.min(PACE_MIN_MS, PACE_MAX_MS);
  const hi = Math.max(PACE_MIN_MS, PACE_MAX_MS);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Trace ─────────────────────────────────────────────────────────
// Everything interesting a run does — a proxy dying, a CAPTCHA, a retry —
// only ever reached the terminal. Mirroring it to the caller is what lets the
// UI show why a run is slow instead of just that it is.
//
// Module-level rather than threaded through every function: the proxy pool is
// already a shared singleton, so two concurrent runs would interfere anyway.
let emit = () => {};
function trace(level, msg) {
  emit({ level, msg, at: Date.now() });
}

// ── Stop ──────────────────────────────────────────────────────────
// Cooperative rather than a kill: workers finish the page they are on, the
// browsers get closed, and the rows already collected are returned. Tearing
// the run down mid-post would leak a Chromium per worker and lose contacts
// that were a moment from being saved.
//
// Module-level for the same reason `emit` is — the proxy pool is a singleton,
// so only one run is meaningfully in flight at a time.
let stopRequested = false;
function requestStop() {
  if (stopRequested) return false;
  stopRequested = true;
  proxyFinder.stop();
  // A worker parked on waitForProxy has no timeout to fall out of.
  proxyLease.abortWaiters();
  trace('phase', 'stop requested — finishing in-flight posts');
  return true;
}
function stopping() {
  return stopRequested;
}

/**
 * A sleep that gives up early when the run is stopping.
 *
 * The pacing gap is up to fifteen seconds and every worker sits in one; a
 * plain sleep would make Stop look ignored for that long.
 */
async function sleepUnlessStopped(ms) {
  const step = 250;
  for (let waited = 0; waited < ms; waited += step) {
    if (stopRequested) return;
    await sleep(Math.min(step, ms - waited));
  }
}

// How many posts run at once is no longer a number anyone picked — see
// canSpawnWorker below, which grows the worker set until memory says stop.
//
// The reply panel is CAPTCHA-gated for automated clients, so this bounds a
// wait that usually ends in a challenge rather than a panel.
// Six seconds was tuned against WireGuard tunnels. Through public proxies it
// cut off pages that were still loading: a 28-post run produced 22 "panel
// didn't open" and zero contacts, and the same settings at 20s produced five
// contacts in 20 posts with the failures roughly halved. A wait that expires
// early is indistinguishable from a page that never loads, and the cost of
// waiting is far smaller than the cost of discarding a working proxy.
const REPLY_PANEL_TIMEOUT_MS = Number(process.env.REPLY_PANEL_TIMEOUT_MS ?? 20000);
// Page waits were tuned against fast tunnels. Public proxies are slower by an
// order of magnitude, and a wait that expires early is indistinguishable from
// a page that never loads — so these are adjustable rather than baked in.
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS ?? 40000);
const BODY_TIMEOUT_MS = Number(process.env.BODY_TIMEOUT_MS ?? 25000);

// Playwright's Chromium announces itself: navigator.webdriver is true, the
// automation switch is on, and several APIs are missing or stubbed. Craigslist
// reads those, so a rotated IP alone doesn't help if the browser still says
// "I am a robot" on arrival.
const LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--no-sandbox',
];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Applied before any page script runs, so the values are already in place when
// Craigslist's own fingerprinting executes.
const STEALTH_INIT = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  // Headless Chromium reports no chrome runtime; real Chrome always has one.
  window.chrome = window.chrome || { runtime: {} };
  const query = window.navigator.permissions?.query;
  if (query) {
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : query(p);
  }
};

// There is no per-post attempt ceiling any more. A post is released on one of
// exactly two answers — a contact was extracted, or the reply panel opened and
// the poster had published nothing. A challenge, a timeout or a dead exit is
// none of those: it costs the *proxy*, never the post, and the worker comes
// straight back round on a different address.
//
// Attempts at a listing page still need a bound, since a section that cannot
// be read is a section with nothing to queue rather than a post to insist on.
const LISTING_ATTEMPTS = Number(process.env.PROXY_LISTING_ATTEMPTS ?? 5);

// Chromium reports a broken proxy as a net:: error on navigation. Any of
// these means the session is gone, not that this one post is unlucky —
// retrying the next post on the same browser just reproduces it.
function isSessionFailure(message = '') {
  return (
    /net::ERR_/i.test(message) ||
    /ERR_(TUNNEL|PROXY|CONNECTION|EMPTY|ABORTED|TIMED_OUT|SOCKET)/i.test(message) ||
    /page\.goto: Timeout/i.test(message) ||
    /frame was detached/i.test(message)
  );
}
// Relaunching instantly lands straight back on the rate limit that triggered
// the challenge, so let the old session go cold first.
const SESSION_COOLDOWN_MS = Number(process.env.CAPTCHA_COOLDOWN_MS ?? 15000);

const AREA_RE     = /^[a-z0-9-]+$/;
const CATEGORY_RE = /^[a-z0-9]+$/;

// Craigslist's top-level sections, split by which side of the market they sit
// on. This tool writes to people, so the ones worth scraping are where
// individuals are offering themselves or their goods — not where businesses
// are advertising work or property.
const CATEGORY_NAMES = {
  ccc: 'community',
  eee: 'events',
  sss: 'for sale',
  ggg: 'gigs',
  hhh: 'housing',
  jjj: 'jobs',
  rrr: 'resumes',
  bbb: 'services',
};

// Default: people who want to be paid.
//   resumes  — individuals looking for work, the primary target
//   for sale — individuals selling possessions, often for quick cash
// Everything else is the wrong side of the market: jobs and gigs are employers
// offering work, housing is landlords, community and events are neither.
// Override with CATEGORIES=rrr,bbb,sss or similar.
const DEFAULT_CATEGORY_CODES = ['rrr', 'sss'];

const ALL_CATEGORIES = (process.env.CATEGORIES || DEFAULT_CATEGORY_CODES.join(','))
  .split(',')
  .map((c) => c.trim().toLowerCase())
  .filter(Boolean)
  .map((code) => ({ code, name: CATEGORY_NAMES[code] || code }));

/**
 * Turns whatever the caller asked for into the sections to walk.
 *
 * The UI now picks sections explicitly, so a list is the normal case. A bare
 * string still works for the old single-category callers, and 'all' or nothing
 * falls back to the set configured in CATEGORIES.
 */
function resolveCategories(requested) {
  const codes = Array.isArray(requested)
    ? requested
    : requested && requested !== 'all'
      ? [requested]
      : null;
  if (!codes || codes.length === 0) return ALL_CATEGORIES;

  const seen = new Set();
  const picked = [];
  for (const raw of codes) {
    const code = String(raw).trim().toLowerCase();
    // Invalid codes are dropped rather than passed to buildSearchUrl, which
    // would throw and take the whole run down over one bad checkbox.
    if (!CATEGORY_RE.test(code) || seen.has(code)) continue;
    seen.add(code);
    picked.push({ code, name: CATEGORY_NAMES[code] || code });
  }
  return picked.length > 0 ? picked : ALL_CATEGORIES;
}

// Filtering at the source rather than after the fact: it cuts a Seattle jobs
// search from 320 results to 44, so the cap per category spends its budget on
// listings that are actually current instead of months-old ones.
const TODAY_ONLY = process.env.POSTED_TODAY !== '0';

function buildSearchUrl(area, category) {
  // Both values land in a URL, so reject anything that could redirect the
  // browser to another host.
  if (!AREA_RE.test(area)) throw new Error(`Invalid area: ${area}`);
  if (!CATEGORY_RE.test(category)) throw new Error(`Invalid category: ${category}`);
  return (
    `https://www.craigslist.org/search/area/${area}?cat=${category}` +
    (TODAY_ONLY ? '&postedToday=1' : '')
  );
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Area code and exchange can't start with 0/1. The negative lookahead stops
// us slicing a 10-digit phone out of a longer run of digits.
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?([2-9]\d{2})[-.\s]?(\d{4})(?!\d)/g;

// Posters routinely obfuscate to dodge Craigslist's own filters. The literal
// must be bracketed or whitespace-delimited on BOTH sides — matching a bare
// "at"/"dot" turns jmscorporation.com into jmscorpor@ion.com.
const AT_RE  = /(^|\s)[([{]?\s*(?:at|@)\s*[)\]}]?(\s|$)/gi;
const DOT_RE = /(^|\s)[([{]?\s*(?:dot|\.)\s*[)\]}]?(\s|$)/gi;

function deobfuscate(text) {
  return text.replace(AT_RE, '@').replace(DOT_RE, '.');
}

// Shared company mailboxes rather than a person. A draft to jobs@ or info@
// lands in a queue somebody triages, which is the opposite of what this list
// is for — so they're kept, but kept separate.
const ROLE_MAILBOXES = new Set([
  'jobs', 'job', 'hiring', 'hire', 'recruiting', 'recruiter', 'recruitment',
  'careers', 'career', 'hr', 'humanresources', 'staffing', 'talent',
  'info', 'information', 'contact', 'contactus', 'admin', 'administrator',
  'office', 'team', 'support', 'help', 'helpdesk', 'service', 'services',
  'sales', 'marketing', 'billing', 'accounts', 'accounting', 'invoices',
  'inquiries', 'enquiries', 'inquiry', 'enquiry', 'general',
  'noreply', 'no-reply', 'donotreply', 'mail', 'email', 'webmaster',
  'hello', 'hey', 'inbox', 'reception', 'frontdesk', 'apply', 'applications',
  'resume', 'resumes', 'cv', 'work', 'employment', 'manager', 'management',
]);

/**
 * True when the address is a shared company mailbox rather than a person.
 *
 * Craigslist relays are per-post and reach the individual who posted, so they
 * count as personal however opaque the local part looks.
 */
function isRoleMailbox(email) {
  if (/@(?:reply|res|job)\.craigslist\.org$/i.test(email)) return false;
  const local = email.split('@')[0].toLowerCase().replace(/[._-]/g, '');
  return ROLE_MAILBOXES.has(local);
}

const PROSE_BEFORE_AT = new Set([
  'out', 'back', 'here', 'there', 'now', 'today', 'available', 'located',
  'based', 'located', 'working', 'work', 'apply', 'arrive', 'meet', 'look',
  'looking', 'open', 'hiring', 'starting', 'more', 'us', 'and', 'or',
]);

function extractContacts(body) {
  // A bare Craigslist post id is 10 digits and parses as a valid phone number,
  // so drop it before scanning.
  const stripped = body.replace(/\bpost(?:ing)?\s*id\s*:?\s*\d+/gi, ' ');
  const text = deobfuscate(stripped);

  // Addresses written out literally are trusted as-is. The stopword guard
  // applies only to ones deobfuscation invented, so a real `apply@corp.com`
  // survives while "apply at corp.com" prose does not.
  const literal = new Set(stripped.match(EMAIL_RE) || []);
  const found = [...new Set([...literal, ...(text.match(EMAIL_RE) || [])])]
    // Body-text relays are redundant; we read the canonical one off the
    // reply panel instead.
    .filter((e) => !/craigslist\.org$/i.test(e))
    // No mailbox lives at a www host. These are manufactured by
    // deobfuscation — "apply online at www.example.com" becomes
    // online@www.example.com — and one such address was a third of a run's
    // harvest, feeding a draft to a mailbox that doesn't exist.
    .filter((e) => !/@www\./i.test(e))
    .filter((e) => literal.has(e) || !PROSE_BEFORE_AT.has(e.split('@')[0].toLowerCase()));

  // Split rather than discard: a shared company mailbox is still a real
  // address and worth seeing, it just shouldn't be treated as a person to
  // write to. Only `emails` feeds the recipient list.
  const phones = [...new Set((text.match(PHONE_RE) || []).map((p) => p.trim()))];
  return {
    emails: found.filter((e) => !isRoleMailbox(e)),
    roleEmails: found.filter(isRoleMailbox),
    phones,
  };
}

/**
 * Drives Craigslist's reply panel: click "reply", then click each contact tab
 * the poster enabled and read the value it reveals. Emails come back as a
 * per-post relay address (…@job.craigslist.org) rather than the poster's own.
 * Returns empty lists if the post has no reply button or the panel stalls.
 */
async function readReplyPanel(page, area) {
  const out = { emails: [], phones: [], challenged: false };
  const replyBtn = await page.$(REPLY_BTN);
  if (!replyBtn) {
    // Silent here would be indistinguishable from "poster published nothing",
    // and this is also how a markup change would first show up.
    console.log(`   [${area}] No reply button on this post.`);
    return out;
  }

  // Craigslist escalates to hCaptcha once it decides a client is automated;
  // /init then carries a siteKey and the panel never fills. Detect that so
  // the caller can report it instead of silently returning nothing.
  const onResponse = async (res) => {
    if (!/\/reply\/.*\/init/.test(res.url())) return;
    try {
      if (/siteKey_hCaptcha/.test(await res.text())) out.challenged = true;
    } catch { /* body already consumed */ }
  };
  page.on('response', onResponse);

  try {
    await replyBtn.click();
    // Race the panel against the challenge widget instead of waiting out the
    // full timeout. Craigslist gates this panel behind hCaptcha for automated
    // clients, so the overwhelmingly common outcome is a challenge that shows
    // up in a second or two — waiting ten more for a panel that isn't coming
    // was the single largest cost in a run.
    const outcome = await Promise.race([
      page.waitForSelector(REPLY_OPTION, { timeout: REPLY_PANEL_TIMEOUT_MS }).then(() => 'panel', () => 'gone'),
      page.waitForSelector(CAPTCHA_MARKERS.join(','), { timeout: REPLY_PANEL_TIMEOUT_MS }).then(() => 'captcha', () => 'gone'),
    ]);
    if (outcome !== 'panel') {
      if (outcome === 'captcha') out.challenged = true;
      throw new Error('reply panel unavailable');
    }
  } catch {
    // The /init sniff above has to await the response body, which can resolve
    // after this 10s wait has already given up — so a real challenge shows up
    // as "panel didn't open". The DOM is authoritative, but the challenge
    // widget is injected a beat after the panel fails, so give it a moment to
    // appear rather than asking too early and recording the wrong cause.
    if (!out.challenged) out.challenged = await looksChallenged(page);
    // A panel that didn't render and no challenge we could see. The panel is
    // gated behind hCaptcha, so this is almost always a challenge the
    // detectors missed rather than a post with nothing to show — the /init
    // sniff needs the response body in time, and the widget markup needs to
    // have rendered before we look. Flagged so the caller retries on another
    // exit instead of accepting "no contact" from a read that never happened.
    out.panelUnavailable = !out.challenged;
    console.log(
      out.challenged
        ? `   [${area}] Craigslist served a CAPTCHA — contact details withheld.`
        : `   [${area}] Reply panel didn't open — treating as blocked.`
    );
    return out;
  } finally {
    page.off('response', onResponse);
  }

  const count = await page.locator(REPLY_OPTION).count();
  for (let i = 0; i < count; i += 1) {
    const tab = page.locator(REPLY_OPTION).nth(i);
    const label = (await tab.innerText().catch(() => '')).trim().toLowerCase();
    try {
      await tab.click({ timeout: 5000 });
      if (label.includes('email')) {
        // The address is the mailto href; its query string carries a prefilled
        // subject/body we don't want.
        await page.waitForSelector(REPLY_EMAIL_LINK, { timeout: 8000 });
        const href = await page.getAttribute(REPLY_EMAIL_LINK, 'href');
        const address = decodeURIComponent((href || '').replace(/^mailto:/, '').split('?')[0]).trim();
        if (address && !out.emails.includes(address)) out.emails.push(address);
      } else {
        // "call"/"text" tabs render the number as plain text.
        await page.waitForTimeout(1500);
        const text = await page.locator(REPLY_CONTENT).allInnerTexts().catch(() => []);
        for (const ph of extractContacts(text.join('\n')).phones) {
          if (!out.phones.includes(ph)) out.phones.push(ph);
        }
      }
    } catch {
      console.log(`   [${area}] Reply tab "${label}" revealed nothing.`);
    }
  }
  return out;
}

async function getPostUrls(area, category, ctx) {
  const listingUrl = buildSearchUrl(area, category);
  const page = await ctx.newPage();
  try {
    // Deliberately outside the timeout handling below: a navigation that fails
    // is a broken proxy, not an empty category, and conflating the two got a
    // dead proxy reported as "no listings" — which then looked like a real
    // answer and ended the retries.
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // These live in the no-JS fallback list, which is present in the markup
    // but sits under a `display: none` parent — so wait for 'attached', not
    // the default 'visible', which would always time out.
    await page.waitForSelector(LISTING_POST_LINK, { state: 'attached', timeout: NAV_TIMEOUT_MS });
    const urls = await page.$$eval(LISTING_POST_LINK, (links) =>
      links.map((a) => a.href).filter(Boolean)
    );
    const capped = urls.slice(0, MAX_POSTS_PER_AREA);
    console.log(
      `[${area}] Found ${urls.length} posts` +
        (urls.length > capped.length ? `, processing first ${capped.length}.` : '.')
    );
    return { urls: capped, challenged: false };
  } catch (err) {
    // A navigation failure means the proxy is gone; propagate so the caller
    // drops it and tries another. Only a selector timeout on a page that did
    // load can be read as "empty or challenged".
    if (err.name === 'TimeoutError' && !isSessionFailure(err.message)) {
      // The results list never appearing means either an empty category or a
      // challenge standing in front of it — those need opposite responses, so
      // check before reporting.
      if (await looksChallenged(page)) {
        console.log(`[${area}] Search page served a CAPTCHA instead of results.`);
        return { urls: [], challenged: true };
      }
      console.log(`[${area}] No results on ${listingUrl}`);
      return { urls: [], challenged: false };
    }
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Reads the post's publish date as an ISO string, or null if absent.
 *
 * The page carries several identical `time.date.timeago` elements — the post
 * date appears twice and the last one is "updated" — so pick by the adjacent
 * label rather than by position, which would silently return the edit date on
 * any post that has been touched since publishing.
 */
async function readPostedDate(page) {
  return page
    .evaluate(() => {
      const rows = [...document.querySelectorAll('.postinginfo')];
      const posted = rows.find((r) => /^\s*posted:/i.test(r.textContent));
      const el = (posted ?? document.body).querySelector('time[datetime]');
      return el ? el.getAttribute('datetime') : null;
    })
    .catch(() => null);
}

async function processSinglePost(postUrl, page, area) {
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  // A listing that is gone has no posting body, so without this check it looks
  // exactly like a slow page: the wait below times out, the exit gets blamed
  // and relaxed, and the post is retried forever across the whole pool. Craig-
  // slist says so plainly in the markup, so ask before waiting.
  if (await isPostGone(page)) {
    console.log(`   [${area}] Listing is gone (deleted, expired or flagged).`);
    return { area, url: postUrl, name: null, gone: true, success: true };
  }

  await page.waitForSelector(BODY_SELECTOR, { timeout: BODY_TIMEOUT_MS });

  // 1. Name
  let name = 'Unknown';
  const titleEl = await page.$(NAME_SELECTOR);
  if (titleEl) {
    name = (await titleEl.textContent()).trim();
  } else {
    const h = await page.$('h1, h2');
    if (h) name = (await h.textContent()).trim();
  }

  // 2. Body text
  const bodyEl = await page.$(BODY_SELECTOR);
  const body = bodyEl ? (await bodyEl.innerText()).trim() : '';

  // 3. Contact details, from two independent sources.
  //
  // (a) the ad text — direct addresses the poster typed in. Scan the body
  //     only: surrounding page chrome carries the numeric post id, which
  //     otherwise parses as a phone number.
  const contacts = extractContacts(body);

  // (b) Craigslist's own reply panel, which yields a per-post relay address.
  const viaReply = await readReplyPanel(page, area);
  for (const e of viaReply.emails) {
    const bucket = isRoleMailbox(e) ? contacts.roleEmails : contacts.emails;
    if (!bucket.includes(e)) bucket.push(e);
  }
  for (const ph of viaReply.phones) if (!contacts.phones.includes(ph)) contacts.phones.push(ph);

  const found = contacts.emails.length + contacts.phones.length;

  console.log(
    `   ✅ [${area}] ${name}` + (found ? ` — ${contacts.emails.concat(contacts.phones).join(', ')}` : ' — no contact in body')
  );
  return {
    area,
    name,
    url: postUrl,
    postedAt: await readPostedDate(page),
    body,
    contacts,
    contactsAvailable: found > 0,
    captchaBlocked: viaReply.challenged,
    panelUnavailable: Boolean(viaReply.panelUnavailable),
    contactNote: viaReply.challenged
      ? 'Craigslist served a CAPTCHA, so the reply address could not be read. Slow down or open the listing manually.'
      : found > 0
        ? 'Found in the ad text or reply panel.'
        : 'No contact published for this listing.',
    success: true,
  };
}

async function closeSession(session) {
  if (session?.browser) await session.browser.close().catch(() => {});
}

// One live session per exit, kept warm across posts.
//
// A fresh browser per post was the single largest cause of challenges: it
// arrives at a listing with an empty cookie jar, which no real visitor does —
// people reach a post from the search page carrying the cookies it set.
// Measured directly: a fresh context per post was challenged on every attempt,
// while reusing one context opened the panel on every attempt through the same
// proxies. Keyed by proxy so rotation still gives each exit its own identity.
const liveSessions = new Map();

async function sessionFor(exit) {
  const key = exit.server || 'direct';
  const existing = liveSessions.get(key);
  if (existing) return existing;

  const browser = await chromium.launch({
    headless: process.env.HEADLESS === '1',
    args: LAUNCH_ARGS,
    ...(exit.server ? { proxy: { server: exit.server } } : {}),
  });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    deviceScaleFactor: 2,
  });
  await context.addInitScript(STEALTH_INIT);

  // Arrive at the site before arriving at a post.
  //
  // Reusing a context only helps the one exit that happened to fetch a
  // listing; every other exit's first navigation was a post page with an
  // empty cookie jar, which is the condition that gets challenged. With a
  // handful of exits enough of them were warmed by listing fetches to
  // partly mask it — with two dozen, almost every session started cold and
  // essentially every post was challenged.
  //
  // Cost is one extra page load per exit, once, for the whole run.
  const warm = await context.newPage();
  try {
    await warm.goto('https://www.craigslist.org/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await warm.waitForTimeout(1500 + Math.floor(Math.random() * 1500));
  } catch {
    // A tunnel too slow to load the homepage will fail on posts too; let the
    // post attempt report it rather than failing here.
  } finally {
    await warm.close().catch(() => {});
  }

  const session = { browser, context, exit };
  liveSessions.set(key, session);
  return session;
}

/** Drops a session whose exit has died or been burned. */
async function retireSession(exit) {
  const key = exit.server || 'direct';
  const s = liveSessions.get(key);
  if (!s) return;
  liveSessions.delete(key);
  await closeSession(s);
}

async function retireAllSessions() {
  const all = [...liveSessions.values()];
  liveSessions.clear();
  await Promise.all(all.map(closeSession));
}

/**
 * Runs one post on its own page, turning any failure into a result row.
 * `exit` is stamped on the row so each result records the IP it came through
 * — sessions rotate mid-run, so this varies from row to row.
 */
async function runPost(ctx, url, area, exit) {
  const page = await ctx.newPage();
  try {
    const result = await processSinglePost(url, page, area);
    return { ...(result ?? { url, area, success: false, error: 'No reply button or modal' }), exit };
  } catch (err) {
    console.error(`[${area}] Post failed: ${url}`, err.message);
    return {
      url,
      area,
      success: false,
      error: err.message,
      sessionFailed: isSessionFailure(err.message),
      exit,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
// ── Orchestration ─────────────────────────────────────────────────
//
// Two subsystems that do not wait on each other:
//
//   proxyFinder  →  keeps the ready list topped up, forever, uncapped
//   post workers →  take a lease from the ready list, work posts through it
//                   until it is challenged, swap, repeat — forever
//
// A worker is bound to a *post*, not to a proxy. It does not release the post
// until the contact is scraped or the post is proven to have none; a CAPTCHA
// or a timeout costs it a proxy, never the post.

/**
 * How many workers to run.
 *
 * Each holds a Chromium, so this is bounded by memory rather than by a number
 * anyone picked. Free memory is sampled as workers spawn, and the pool stops
 * growing when it drops below the floor — so it settles wherever the machine
 * can actually sustain it and recovers as browsers are retired.
 */
const MEM_FLOOR_MB = Number(process.env.WORKER_MEM_FLOOR_MB ?? 2000);
// Per-browser estimate used to hold back a reserve while workers are still
// warming up; available memory does not drop until a browser has loaded.
const MEM_PER_WORKER_MB = Number(process.env.WORKER_MEM_PER_MB ?? 220);
// Share of total RAM the run may claim. The ceiling this implies is the
// backstop; the live availability check below is what actually paces growth.
const MEM_FRACTION = Number(process.env.WORKER_MEM_FRACTION ?? 0.5);
const WORKER_MIN = Number(process.env.WORKER_MIN ?? 4);

/**
 * The ceiling that actually binds — proxy supply, not memory.
 *
 * Memory said 74 on this machine and 74 is what it ran. Measured over twelve
 * minutes: every worker starved for three minutes straight (held=0, wait=74),
 * 94% of leased exits completed zero posts, and the whole run produced 13
 * emails. Free proxy lists verify at ~2% pool-wide and cannot feed that many
 * browsers; the extra workers sat in waitForProxy holding a Chromium each.
 *
 * Fewer workers also probe less concurrently, and the probe pass rate is
 * strongly concurrency-sensitive — so a smaller set should waste fewer good
 * exits on false negatives as well.
 */
const WORKER_MAX = Number(process.env.WORKER_MAX ?? 15);
const MEM_CEILING = Math.max(
  WORKER_MIN,
  Math.floor(((os.totalmem() / (1024 * 1024)) * MEM_FRACTION) / MEM_PER_WORKER_MB)
);
// Memory is still a bound, just no longer the binding one on a big machine.
const WORKER_HARD_MAX = Number(process.env.WORKER_HARD_MAX ?? Math.min(WORKER_MAX, MEM_CEILING));

/**
 * Memory actually available, in MB.
 *
 * `os.freemem()` is unusable on macOS: it counts only wholly free pages, so a
 * 32GB machine sitting at 71% free reports 219MB. Gating on it pinned the
 * worker set to its minimum and the adaptive sizing never engaged at all.
 * Darwin gets vm_stat instead, where free + inactive + speculative is the
 * figure that matches what the OS will actually hand out.
 */
let memCache = { at: 0, mb: 0 };
function availableMemMB() {
  const now = Date.now();
  if (now - memCache.at < 3000) return memCache.mb;

  let mb;
  if (process.platform === 'darwin') {
    try {
      const out = execSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
      const pageSize = Number(out.match(/page size of (\d+)/)?.[1] ?? 4096);
      const pages = (label) => Number(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
      const free = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative')
        + pages('Pages purgeable');
      mb = Math.floor((free * pageSize) / (1024 * 1024));
    } catch {
      mb = Math.floor(os.freemem() / (1024 * 1024));
    }
  } else {
    mb = Math.floor(os.freemem() / (1024 * 1024));
  }

  memCache = { at: now, mb };
  return mb;
}
// How often the listing loop goes back for newly posted listings.
const LISTING_REFRESH_MS = Number(process.env.LISTING_REFRESH_MS ?? 5 * 60 * 1000);

const freeMemMB = availableMemMB;

/** True while there is memory headroom for another browser. */
function canSpawnWorker(current) {
  if (current >= WORKER_HARD_MAX) return false;
  if (current < WORKER_MIN) return true;
  // Reserve for the browsers already spawned but not yet resident.
  return availableMemMB() - MEM_PER_WORKER_MB > MEM_FLOOR_MB;
}

/**
 * Works one post to a conclusion, holding its proxy lease across attempts.
 *
 * Returns the lease to carry into the next post, or null when it was burned.
 * The post is only finished on one of two real answers:
 *
 *   a contact was extracted, or
 *   the reply panel opened and the poster had published nothing
 *
 * Everything else — challenge, timeout, dead exit — swaps the proxy and tries
 * again. There is no attempt ceiling: that is what "until the contact is
 * scraped" means.
 */
async function workPost(item, lease, workerId, opts) {
  const { url, area, category, categoryName } = item;
  // How much this lease has earned before it was challenged — the number that
  // says whether holding a proxy across posts is paying off.
  let leasePosts = lease?.posts ?? 0;

  while (!stopRequested) {
    // Ask the finder for an exit and wait for one to be verified for us.
    // There is no list to draw from — the proxy arrives seconds after it was
    // proved against Craigslist, which is the whole point of the handoff.
    if (!lease) {
      lease = await proxyLease.waitForProxy(workerId);
      if (!lease) break; // stopping
    }
    if (stopRequested) break;

    let session;
    try {
      session = await sessionFor(lease);
    } catch (err) {
      // The browser would not even launch through this exit.
      proxyLease.block(lease.server, 'dead');
      trace('drop', `blocked ${lease.ip} — browser launch failed`);
      await retireSession(lease);
      lease = null;
      continue;
    }

    const result = await runPost(session.context, url, area, lease);

    // ── The exit died ────────────────────────────────────────────
    if (result.sessionFailed) {
      await retireSession(lease);
      if (proxyLease.block(lease.server, 'dead')) {
        trace('drop', `blocked ${lease.ip} — cannot carry traffic`);
      }
      lease = null;
      continue;
    }

    // ── Craigslist challenged this address ───────────────────────
    // Not a verdict on the proxy: it has been asking too fast, and the same
    // exit answers again once it has been left alone. So it is benched for
    // the relaxing period and rejoins the ready list afterwards for a fresh
    // session, rather than being thrown away.
    if (result.captchaBlocked) {
      await retireSession(lease);
      proxyLease.store.recordBlock(lease.server);
      if (proxyLease.relax(lease.server, lease)) {
        trace(
          'captcha',
          `CAPTCHA on ${lease.ip} after ${leasePosts} post(s) — relaxing ` +
            `${Math.round(proxyLease.RELAX_MS / 60000)}min`
        );
      }
      lease = null;
      leasePosts = 0;
      continue;
    }

    // ── Read never completed ─────────────────────────────────────
    // A panel that did not render, or a navigation that failed. Says nothing
    // about the post, so swap the exit and come back to it. Treated as a
    // challenge we could not see rather than a dead proxy: the panel is
    // CAPTCHA-gated, so this is overwhelmingly a challenge the detectors
    // missed, and dropping the exit for it would discard working proxies.
    if (!result.success || result.panelUnavailable) {
      await retireSession(lease);
      proxyLease.relax(lease.server, lease);
      trace('retry', `${lease.ip} gave no read — relaxing it, post stays queued`);
      lease = null;
      leasePosts = 0;
      continue;
    }

    // ── The listing is gone ──────────────────────────────────────
    // Deleted, expired or flagged. Its contacts go with it: a Craigslist relay
    // address stops routing the moment the post does, so leaving it in the
    // recipient list means drafting to an address that bounces.
    if (result.gone) {
      proxyLease.noteUse(lease.server);
      leasePosts += 1;
      const dropped = contactStore.removeForPost(url);
      postStore.markGone(url, { area, category });
      const n = dropped.emails.length + dropped.phones.length;
      trace(
        'drop',
        n > 0
          ? `listing removed — dropped ${[...dropped.emails, ...dropped.phones].join(', ')}`
          : 'listing removed — nothing had been collected from it'
      );
      opts.onRow?.({ ...result, category, categoryName, removedContacts: dropped });
      return lease;
    }

    // ── A real answer ────────────────────────────────────────────
    const emails = result.contacts?.emails ?? [];
    const phones = result.contacts?.phones ?? [];
    const row = { ...result, category, categoryName };

    if (emails.length + phones.length > 0) {
      // The proxy proved itself in the only way that counts. It keeps its
      // lease and goes straight on to the next post.
      proxyLease.recordSuccess(lease);
      proxyLease.noteUse(lease.server);
      leasePosts += 1;

      // A re-read that found something different is worth calling out: it is
      // an edited or reposted listing, which is the reason re-reads exist.
      const seenBefore = postStore.previous(url);
      const changed = postStore.hasChanged(url, { postedAt: result.postedAt, emails, phones });
      postStore.markScraped(url, {
        area, category, name: result.name, postedAt: result.postedAt, emails, phones,
      });
      row.rescraped = Boolean(seenBefore);
      row.changed = changed;

      if (seenBefore && changed) {
        trace('contact', `updated ${[...emails, ...phones][0]} — listing changed since last read`);
      } else if (!seenBefore) {
        trace('contact', `${[...emails, ...phones][0]} via ${lease.ip}`);
      }
      opts.onRow?.(row);
      return lease;
    }

    // The panel opened and there was nothing behind it. A genuine answer:
    // record it so no worker ever picks this post up again.
    proxyLease.noteUse(lease.server);
    leasePosts += 1;
    postStore.markDead(url, { area, category, name: result.name, postedAt: result.postedAt });
    trace('empty', `no contact published — post closed`);
    opts.onRow?.(row);
    return lease;
  }

  return lease;
}

/**
 * One worker: pulls posts off the queue and works each to a conclusion,
 * carrying its proxy lease from post to post.
 */
async function postWorker(workerId, queue, opts, counters) {
  let lease = null;
  try {
    while (!stopRequested) {
      const item = queue.shift();
      if (!item) return;
      // Re-checked here as well as at queue time: a post can be settled by
      // another worker between being queued and being picked up.
      if (!postStore.shouldScrape(item.url)) continue;

      lease = await workPost(item, lease, workerId, opts);
      if (stopRequested) break;

      counters.finished += 1;
      opts.onStats?.({ finishedPosts: counters.finished });
      // Pacing is per worker, so the aggregate rate scales with how many are
      // running rather than each one sprinting through its queue.
      if (PACE_MAX_MS > 0) await sleepUnlessStopped(paceDelay());
    }
  } finally {
    if (lease) proxyLease.release(lease.server);
  }
}

/**
 * Collects the posts worth doing for one area and section.
 *
 * Listing fetches get a lease of their own and give it straight back — they
 * are cheap, and holding an exit for one page would starve the post workers.
 */
async function collectPosts(area, cat, opts) {
  const out = [];
  let attempts = 0;

  while (attempts < LISTING_ATTEMPTS && !stopRequested) {
    attempts += 1;
    // Listing fetches queue for a verified exit like any worker does.
    const lease = await proxyLease.waitForProxy(`listing:${area}/${cat.code}`);
    if (!lease) break; // stopping

    try {
      const session = await sessionFor(lease);
      const listing = await getPostUrls(area, cat.code, session.context);
      if (listing.challenged) {
        await retireSession(lease);
        proxyLease.relax(lease.server, lease);
        trace('captcha', `CAPTCHA on the ${area}/${cat.name} listing — relaxing that exit`);
        continue;
      }
      for (const url of listing.urls) {
        if (postStore.shouldScrape(url)) {
          out.push({ url, area, category: cat.code, categoryName: cat.name });
        }
      }
      proxyLease.release(lease.server);
      return out;
    } catch (err) {
      await retireSession(lease);
      // Same split as posts: a proxy that cannot carry traffic goes, one that
      // merely gave a bad read is rested and comes back.
      if (isSessionFailure(err.message)) proxyLease.block(lease.server, 'dead');
      else proxyLease.relax(lease.server, lease);
      trace('retry', `${area}/${cat.name} listing failed on ${lease.ip} — another exit`);
    }
  }
  return out;
}

/**
 * The run. Never completes on its own — it cycles until stop is requested.
 *
 * Each cycle re-reads the listings, queues whatever the post store has not
 * already settled, and works the queue down. When the queue empties it waits
 * out the refresh interval and goes round again, picking up newly posted
 * listings.
 */
async function runForever(areas = [], category = 'all', opts = {}) {
  stopRequested = false;
  emit = opts.onEvent ?? (() => {});
  proxyLease.reset();

  const categories = resolveCategories(category);
  const counters = { finished: 0, queued: 0, cycles: 0 };
  const stats = (patch) => opts.onStats?.(patch);

  stats({ phase: 'finding proxies', area: null, totalPosts: 0, finishedPosts: 0, cycles: 0 });
  trace('phase', `run started — ${areas.join(', ')} × ${categories.map((c) => c.name).join(', ')}`);

  // The finder is driven by demand: it verifies only while somebody is
  // waiting, and hands each pass straight to the worker that asked.
  proxyFinder.start({
    broker: proxyLease,
    log: (m) => trace('pool', m),
  });

  const queue = [];

  while (!stopRequested) {
    counters.cycles += 1;
    stats({ phase: 'reading listings', cycles: counters.cycles });

    // ── Refill ───────────────────────────────────────────────────
    for (const area of areas) {
      if (stopRequested) break;
      for (const cat of categories) {
        if (stopRequested) break;
        stats({ area, phase: 'reading listings' });
        const found = await collectPosts(area, cat, opts);
        queue.push(...found);
        counters.queued += found.length;
        if (found.length > 0) {
          trace('phase', `${area}/${cat.name}: ${found.length} new post(s) queued`);
        }
        stats({ totalPosts: counters.queued, queueDepth: queue.length });
      }
    }

    if (queue.length === 0) {
      // Everything already settled. Wait for new listings rather than
      // spinning through the same finished posts.
      stats({ phase: 'waiting for new listings', area: null, queueDepth: 0 });
      trace('phase', `nothing new — next listing sweep in ${Math.round(LISTING_REFRESH_MS / 1000)}s`);
      await sleepUnlessStopped(LISTING_REFRESH_MS);
      continue;
    }

    // ── Drain ────────────────────────────────────────────────────
    stats({ phase: 'scraping' });
    const running = new Set();
    let nextId = 0;

    while ((queue.length > 0 || running.size > 0) && !stopRequested) {
      // Grow the worker set while memory allows and there is work waiting.
      while (queue.length > 0 && canSpawnWorker(running.size) && !stopRequested) {
        const id = `w${nextId += 1}`;
        const p = postWorker(id, queue, opts, counters).finally(() => running.delete(p));
        running.add(p);
        stats({ workers: running.size, freeMemMB: freeMemMB() });
      }

      if (running.size === 0) {
        // No headroom at all. Wait for a browser to be retired.
        await sleepUnlessStopped(2000);
        continue;
      }
      // Wake as soon as any worker finishes, so the set is topped straight up.
      await Promise.race([...running, sleepUnlessStopped(2000)]);
      stats({
        workers: running.size,
        queueDepth: queue.length,
        waiting: proxyLease.waiterCount(),
        freeMemMB: freeMemMB(),
      });
    }

    await Promise.allSettled([...running]);
  }

  proxyFinder.stop();
  // Wake anything still queued for a proxy, or those awaits never settle.
  proxyLease.abortWaiters();
  await retireAllSessions();
  stats({ phase: 'stopped', area: null, workers: 0, finishedPosts: counters.finished });
  trace('phase', `run stopped — ${counters.finished} posts finished over ${counters.cycles} cycle(s)`);
  emit = () => {};
  return [];
}

module.exports = {
  runForever,
  // Kept for the tests and for anything driving a single post directly.
  processSinglePost, getPostUrls, looksChallenged, extractContacts,
  ALL_CATEGORIES, CATEGORY_NAMES, DEFAULT_CATEGORY_CODES, resolveCategories,
  requestStop, stopping,
};
