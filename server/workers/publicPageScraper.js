const { chromium } = require('playwright');
const proxyPool = require('./proxyPool');

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

// Each post runs on its own proxy and browser, so overlapping them raises
// throughput without raising the rate any single address presents.
const POST_CONCURRENCY = Number(process.env.POST_CONCURRENCY ?? 4);
// The reply panel is CAPTCHA-gated for automated clients, so this bounds a
// wait that usually ends in a challenge rather than a panel.
const REPLY_PANEL_TIMEOUT_MS = Number(process.env.REPLY_PANEL_TIMEOUT_MS ?? 6000);

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

// Craigslist pins its CAPTCHA to the browser session, so dropping the whole
// session and relaunching usually clears it. Cap the restarts: if the
// challenge follows us into a clean session the block is on the IP, and
// relaunching forever just stalls the run.
const MAX_SESSION_RESTARTS = 3;

// Every post gets its own browser on its own proxy. Attempts here are per
// post, not per run: a CAPTCHA or a dead proxy costs this post a retry on the
// next address and nothing more, so the run still reaches the full count.
const ATTEMPTS_PER_POST = Number(process.env.PROXY_ATTEMPTS_PER_POST ?? 5);
const LISTING_ATTEMPTS = Number(process.env.PROXY_LISTING_ATTEMPTS ?? 3);
// Off by default: a run set up to rotate should not quietly stop rotating.
const ALLOW_DIRECT_FALLBACK = process.env.ALLOW_DIRECT_FALLBACK === '1';
// A fixed set of tunnels is checked once and that's the pool. A public list
// is a different shape: entries die constantly, so the pool has to be topped
// up during the run or it drains to nothing.
const POOL_TARGET = Number(process.env.PROXY_POOL_TARGET ?? 12);
const POOL_MIN = Number(process.env.PROXY_POOL_MIN ?? 4);

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

// Craigslist's top-level sections. Scraping every one of them is what "all
// categories" means — the sub-categories underneath are reachable from these.
const ALL_CATEGORIES = [
  { code: 'ccc', name: 'community' },
  { code: 'eee', name: 'events' },
  { code: 'sss', name: 'for sale' },
  { code: 'ggg', name: 'gigs' },
  { code: 'hhh', name: 'housing' },
  { code: 'jjj', name: 'jobs' },
  { code: 'rrr', name: 'resumes' },
  { code: 'bbb', name: 'services' },
];

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
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // These live in the no-JS fallback list, which is present in the markup
    // but sits under a `display: none` parent — so wait for 'attached', not
    // the default 'visible', which would always time out.
    await page.waitForSelector(LISTING_POST_LINK, { state: 'attached', timeout: 15000 });
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
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector(BODY_SELECTOR, { timeout: 10000 });

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

/**
 * Opens a browser and reports the exit IP it will present.
 *
 * A rotated IP is the point of the proxy, so which one we ended up on is
 * recorded rather than assumed — a silent fall back to the direct connection
 * would look identical to a working rotation while changing nothing about the
 * block. Set USE_PROXY=0 to skip the pool entirely.
 */
async function pickExit(exclude = null) {
  let exit = { server: null, ip: 'unknown', location: 'Unknown', direct: true };
  let cached = null;

  if (process.env.USE_PROXY !== '0') {
    // Round-robin, not consume: the pool is nearly always smaller than the
    // number of posts, so entries have to come back around. This can block —
    // the pool rests each address between uses.
    const picked = await proxyPool.next({ exclude });
    if (picked) {
      if (picked.waitedMs > 0) {
        console.log(`   [proxy] Waited ${(picked.waitedMs / 1000).toFixed(0)}s for ${picked.ip} to cool down.`);
      }
      exit = { ...picked, direct: false };
    } else if (proxyPool.configured() && !ALLOW_DIRECT_FALLBACK) {
      // Silently switching to the user's own address is the wrong trade: it
      // stops rotating and puts their real IP in front of the site they were
      // rotating away from. A run configured for tunnels waits, or gives up on
      // that post, rather than quietly leaking.
      const waitS = Math.round(proxyPool.nextAvailableInMs() / 1000);
      console.log(
        `   [proxy] All ${proxyPool.size()} tunnels are resting` +
          (Number.isFinite(waitS) ? ` (next free in ~${waitS}s)` : '') +
          ' — skipping rather than going direct. Set ALLOW_DIRECT_FALLBACK=1 to change that.'
      );
      return null;
    } else {
      // Worth saying loudly: the run continues on the IP that was already
      // being blocked.
      console.log('   [proxy] No proxy available — this request goes out DIRECT.');
      cached = await directIdentityCached();
      exit = { ...cached, direct: true };
    }
  } else {
    cached = await directIdentityCached();
    exit = { ...cached, direct: true };
  }

  return exit;
}

// Rotation is per post now, so the direct-identity lookup would otherwise
// repeat on every one of them.
let directCache = null;
async function directIdentityCached() {
  if (!directCache) directCache = await proxyPool.directIdentity();
  return directCache;
}

/** Closes a session's browser, tolerating one that has already crashed. */
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
 * Scrapes one post, rotating to a different proxy for each attempt.
 *
 * A fresh browser per attempt is the point: new IP, empty cookies. So a
 * CAPTCHA and a dead proxy are handled the same way — try the next address —
 * and neither costs anything beyond this one post. A proxy that fails to
 * navigate is dropped from the pool rather than handed out again.
 *
 * Returns the first clean result, or the last attempt if none came clean, so
 * every post yields a row either way.
 */
async function scrapePostWithRotation(url, area, attemptsAllowed, onSession) {
  let last = null;
  // Each attempt for this post goes out on an address the post hasn't used.
  const tried = new Set();

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    const exit = await pickExit(tried);
    if (exit?.server) tried.add(exit.server);
    if (!exit) {
      // Every tunnel is resting. Report it against the post rather than
      // pretending it was scraped and found nothing.
      last = {
        url, area, success: false,
        error: tried.size
          ? `No untried exit available after ${tried.size} attempt(s).`
          : 'All tunnels were resting — no rotated exit available for this post.',
        exit: { server: null, ip: 'none', location: 'No tunnel available', direct: false },
      };
      break;
    }
    onSession?.(exit);
    // Reused, not rebuilt: the warm cookie jar is what keeps the reply panel
    // from being challenged.
    const session = await sessionFor(exit);

    const label = exit.direct ? 'direct' : `${exit.ip} (${exit.location})`;
    if (attempt > 1) console.log(`   [${area}] Retry ${attempt}/${attemptsAllowed} via ${label}`);

    const result = await runPost(session.context, url, area, exit);
    last = result;

    if (result.sessionFailed) {
      // Proven bad right now — stop offering it to later posts.
      await retireSession(exit);
      if (exit.server && proxyPool.markDead(exit.server)) {
        console.log(
          `   [proxy] Dropped ${exit.ip} from the pool ` +
            `(${proxyPool.size()} left): ${result.error.split('\n')[0].slice(0, 50)}`
        );
      }
      continue;
    }
    // Anything that didn't produce a usable read gets another exit. Retrying
    // was keyed on the error text looking like a network failure, so a post
    // that timed out waiting for its body — not a phrase isSessionFailure
    // matches — was written off after one attempt with its retries unspent.
    // Whether a failure is worth another address doesn't depend on how the
    // error was worded.
    if (!result.success) {
      if (attempt < attemptsAllowed) {
        console.log(
          `   [${area}] Failed on ${exit.ip} (${String(result.error).split('\n')[0].slice(0, 45)})` +
            ' — retrying on another exit.'
        );
      }
      continue;
    }

    // The panel failed to render and we couldn't confirm why. Worth another
    // exit, but not worth striking this one: a strike on a guess would bench
    // healthy tunnels.
    if (result.panelUnavailable && !result.captchaBlocked) {
      if (attempt < attemptsAllowed) {
        console.log(`   [${area}] Reply panel unavailable — retrying on another exit.`);
      }
      continue;
    }
    if (result.captchaBlocked) {
      // Craigslist blocks the address, not the request, so a challenged proxy
      // will keep being challenged. Strike it, and once it's burned it leaves
      // the pool — otherwise it gets handed to post after post, which looks
      // like rotation while changing nothing.
      if (exit.server && proxyPool.markChallenged(exit.server)) {
        console.log(
          `   [proxy] Burned ${exit.ip} — challenged repeatedly, ` +
            `dropped from the pool (${proxyPool.size()} left).`
        );
        await retireSession(exit);
      }
      continue; // a different IP may not be challenged
    }

    return result; // clean
  }

  return last;
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

async function scrapeAreas(areas = [], category = 'jjj', opts = {}) {
  // Check proxies before touching Craigslist. A session that goes hunting
  // mid-run stalls the scrape, and a run that can't rotate at all is worth
  // knowing about now rather than discovering post by post.
  let proxyCheck = null;
  if (process.env.USE_PROXY !== '0') {
    console.log('── Checking proxies before scraping ──');
    const t0 = Date.now();
    // The tunnels are a fixed, local set, so all of them are checked at once
    // and that's the whole pool — there is nothing more to discover later.
    proxyCheck = await proxyPool.warmPool(POOL_TARGET, (m) => console.log(`   [proxy] ${m}`));
    proxyCheck.elapsedMs = Date.now() - t0;

    if (proxyCheck.working === 0) {
      console.log(
        `   [proxy] No usable proxy out of ${proxyCheck.checked} checked — ` +
          'this run will go out on your own IP, unrotated.'
      );
    } else {
      console.log(
        `   [proxy] ${proxyCheck.working} usable proxy(s) ready ` +
          `from ${proxyCheck.checked} checked in ${(proxyCheck.elapsedMs / 1000).toFixed(0)}s:`
      );
      for (const p of proxyCheck.proxies) console.log(`      · ${p.ip} — ${p.location}`);
    }
  }
  // Hand the report back before the slow part begins, so a caller can show it
  // without waiting for the scrape.
  opts.onPreflight?.(proxyCheck);

  const results = [];
  const sessionsUsed = [];
  const noteSession = (e) => sessionsUsed.push({ ...e, at: new Date().toISOString() });

  // Shared so concurrent workers wait on one sweep rather than each starting
  // their own.
  let topUpInFlight = null;
  async function topUpIfThin() {
    if (!proxyPool.usingPublicLists?.()) return;
    if (proxyPool.size() >= POOL_MIN) return;
    if (topUpInFlight) return topUpInFlight;
    console.log(`   [proxy] Pool down to ${proxyPool.size()} — searching for more.`);
    topUpInFlight = proxyPool
      .warmPool(POOL_TARGET, (m) => console.log(`   [proxy] ${m}`))
      .finally(() => { topUpInFlight = null; });
    return topUpInFlight;
  }


  // An explicit category scrapes just that one; otherwise every section is
  // walked. The cap applies per area *and* per category, so eight sections
  // multiply the work — which is much of why the results are limited to
  // today's postings.
  const categories =
    category && category !== 'all'
      ? [{ code: category, name: category }]
      : ALL_CATEGORIES;

  for (const area of areas) {
   // Listings for every section are gathered first, then their posts are
   // interleaved. Draining one section before starting the next meant the bulk
   // classifieds — for-sale and housing run to hundreds of posts — consumed the
   // whole exit pool, and the sections further down the list were never
   // reached at all. Interleaving gives every section coverage from the start,
   // so a run that ends early ends with something from each.
   const queued = [];

   for (const cat of categories) {
    const category = cat.code;
    const label = categories.length > 1 ? `${area}/${cat.name}` : area;

    // Step 1: collect post URLs. The listing gets the same rotation treatment
    // as a post — a challenge or a dead proxy here costs the whole area, so
    // it's worth walking several addresses before giving up on it.
    let listing = null;
    let listingError = null;
    // Same rule as posts: each attempt at this listing uses an address the
    // listing hasn't already failed on.
    const triedForListing = new Set();

    for (let attempt = 1; attempt <= LISTING_ATTEMPTS; attempt += 1) {
      const exit = await pickExit(triedForListing);
      if (exit?.server) triedForListing.add(exit.server);
      if (!exit) {
        listingError = 'All tunnels were resting — no rotated exit available.';
        listing = null;
        break;
      }
      noteSession(exit);
      // Kept open rather than closed: fetching the listing is what warms this
      // exit's cookie jar, and the posts that follow inherit it. Discarding it
      // here is precisely the mistake that got every post challenged.
      const session = await sessionFor(exit);
      try {
        listing = await getPostUrls(area, category, session.context);
      } catch (err) {
        listingError = err.message;
        listing = null;
        if (exit.server && isSessionFailure(err.message)) {
          await retireSession(exit);
          proxyPool.markDead(exit.server);
          console.log(`   [proxy] Dropped ${exit.ip} (${proxyPool.size()} left) — listing failed.`);
        }
      }
      // Only a listing with actual URLs ends the retries. An empty result is
      // usually a proxy that reached a different or partial page rather than a
      // genuinely empty category, and treating it as an answer meant one bad
      // proxy wrote off the whole area on the first try.
      if (listing && !listing.challenged && listing.urls.length > 0) break;
      if (attempt < LISTING_ATTEMPTS) {
        const why = !listing ? 'navigation failed' : listing.challenged ? 'CAPTCHA' : 'no results';
        console.log(`   [${area}] Listing attempt ${attempt}/${LISTING_ATTEMPTS} (${why}) — trying another proxy.`);
      }
    }

    if (!listing) {
      results.push({ area, category, success: false, error: `Could not load listing page: ${listingError}` });
      continue;
    }
    if (listing.challenged) {
      // Distinct from "no listings": the area may well have posts, we just
      // can't see them. Saying so keeps it from reading as an empty area.
      results.push({
        area,
        category,
        success: false,
        captchaBlocked: true,
        error: `Craigslist served a CAPTCHA on the ${cat.name} search page across ${LISTING_ATTEMPTS} proxies.`,
      });
      continue;
    }
    if (listing.urls.length === 0) {
      // Without this the area contributes no rows at all and the UI shows
      // an empty result set that looks like success.
      // Common and unremarkable now that results are limited to today: a
      // quiet section simply has nothing new, which is not a failure.
      if (categories.length === 1) {
        results.push({ area, category, success: false, error: 'No listings found for this area/category.' });
      } else {
        console.log(`[${label}] nothing posted today.`);
      }
      continue;
    }

    // Queued rather than scraped here — see the note above the loop.
    for (const url of listing.urls) queued.push({ url, cat, category });
    console.log(`[${label}] ${listing.urls.length} posts queued.`);
   }

   if (queued.length === 0) continue;

   // Interleave: one post from each section in turn, so coverage is spread
   // rather than spent depth-first on whichever section happens to be biggest.
   const byCat = new Map();
   for (const item of queued) {
     if (!byCat.has(item.category)) byCat.set(item.category, []);
     byCat.get(item.category).push(item);
   }
   const lists = [...byCat.values()];
   const urls = [];
   for (let i = 0; urls.length < queued.length; i += 1) {
     for (const list of lists) if (i < list.length) urls.push(list[i]);
   }

   console.log(
     `[${area}] ${urls.length} posts across ${lists.length} section(s), interleaved ` +
       `(${proxyPool.size()} exits in the pool).`
   );
   opts.onCategory?.({ area, category: 'all', categoryName: 'all sections', planned: urls.length });

   const rows = new Array(urls.length);
   let cursor = 0;
   let done = 0;

   async function worker(slot) {
     // Stagger the openings so the workers don't all hit Craigslist on the
     // same instant, which would undo the pacing.
     await sleep(slot * (paceDelay() / POST_CONCURRENCY));

     while (true) {
       const i = cursor;
       cursor += 1;
       if (i >= urls.length) return;

       // Public-list entries die as the run goes; without this the pool
       // drains and every remaining post is skipped for want of an exit.
       await topUpIfThin();

       const { url, cat, category } = urls[i];
       const row = await scrapePostWithRotation(url, area, ATTEMPTS_PER_POST, noteSession);
       rows[i] = { ...row, category, categoryName: cat.name };
       // Hand it over immediately: a long run is worth watching as it goes,
       // not only once every category has finished.
       opts.onRow?.(rows[i]);
       done += 1;
       if (done % 10 === 0 || done === urls.length) {
         console.log(`   [${area}] ${done}/${urls.length} done.`);
       }

       // Pace per worker, so the aggregate rate scales with concurrency
       // rather than each worker sprinting.
       if (cursor < urls.length && PACE_MAX_MS > 0) await sleep(paceDelay());
     }
   }

   const workers = Math.min(POST_CONCURRENCY, urls.length);
   console.log(`[${area}] Running ${workers} post(s) at a time.`);
   await Promise.all(Array.from({ length: workers }, (_, s) => worker(s)));
   results.push(...rows.filter(Boolean));
  }

  // Browsers are held open for the whole run now, so closing them is the
  // run's job rather than each post's.
  await retireAllSessions();

  // Every row already carries its own `exit`, so the return shape is
  // unchanged; this is just the run-level readout.
  const distinct = new Map();
  for (const s of sessionsUsed) distinct.set(s.ip, s);
  console.log(
    `\n── Exit IPs: ${distinct.size} distinct across ${sessionsUsed.length} browser session(s) ──`
  );
  for (const s of distinct.values()) {
    console.log(`   ${s.ip} — ${s.location}${s.direct ? '  [DIRECT, no proxy]' : `  via ${s.server}`}`);
  }

  return results;
}

module.exports = { scrapeAreas, processSinglePost, getPostUrls, looksChallenged, extractContacts, ALL_CATEGORIES };