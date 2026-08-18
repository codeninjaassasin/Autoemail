const { chromium } = require('playwright');

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
// ─────────────────────────────────────────────────────────────────

// A single search page serves ~300 results and each post costs several
// seconds, so cap the work per area — the whole scrape runs inside one
// HTTP request and will otherwise outlive any client timeout.
const MAX_POSTS_PER_AREA = 25;

const AREA_RE     = /^[a-z0-9-]+$/;
const CATEGORY_RE = /^[a-z0-9]+$/;

function buildSearchUrl(area, category) {
  // Both values land in a URL, so reject anything that could redirect the
  // browser to another host.
  if (!AREA_RE.test(area)) throw new Error(`Invalid area: ${area}`);
  if (!CATEGORY_RE.test(category)) throw new Error(`Invalid category: ${category}`);
  return `https://www.craigslist.org/search/area/${area}?cat=${category}`;
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
  const emails = [...new Set([...literal, ...(text.match(EMAIL_RE) || [])])]
    // Body-text relays are redundant; we read the canonical one off the
    // reply panel instead.
    .filter((e) => !/craigslist\.org$/i.test(e))
    .filter((e) => literal.has(e) || !PROSE_BEFORE_AT.has(e.split('@')[0].toLowerCase()));
  const phones = [...new Set((text.match(PHONE_RE) || []).map((p) => p.trim()))];
  return { emails, phones };
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
  if (!replyBtn) return out;

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
    await page.waitForSelector(REPLY_OPTION, { timeout: 10000 });
  } catch {
    console.log(
      out.challenged
        ? `   [${area}] Craigslist served a CAPTCHA — contact details withheld.`
        : `   [${area}] Reply panel didn't open.`
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

async function getPostUrls(area, category, browser) {
  const listingUrl = buildSearchUrl(area, category);
  const page = await browser.newPage();
  try {
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
    return capped;
  } catch (err) {
    if (err.name === 'TimeoutError') {
      console.log(`[${area}] No results on ${listingUrl}`);
      return [];
    }
    throw err;
  } finally {
    await page.close();
  }
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
  for (const e of viaReply.emails) if (!contacts.emails.includes(e)) contacts.emails.push(e);
  for (const ph of viaReply.phones) if (!contacts.phones.includes(ph)) contacts.phones.push(ph);

  const found = contacts.emails.length + contacts.phones.length;

  console.log(
    `   ✅ [${area}] ${name}` + (found ? ` — ${contacts.emails.concat(contacts.phones).join(', ')}` : ' — no contact in body')
  );
  return {
    area,
    name,
    url: postUrl,
    body,
    contacts,
    contactsAvailable: found > 0,
    captchaBlocked: viaReply.challenged,
    contactNote: viaReply.challenged
      ? 'Craigslist served a CAPTCHA, so the reply address could not be read. Slow down or open the listing manually.'
      : found > 0
        ? 'Found in the ad text or reply panel.'
        : 'No contact published for this listing.',
    success: true,
  };
}

async function scrapeAreas(areas = [], category = 'jjj') {
  // Visible by default so you can watch it work; set HEADLESS=1 to suppress.
  const browser = await chromium.launch({ headless: process.env.HEADLESS === '1' });
  const results = [];

  try {
    for (const area of areas) {
      // Step 1: collect post URLs for this area
      let postUrls = [];
      try {
        postUrls = await getPostUrls(area, category, browser);
      } catch (err) {
        console.error(`[${area}] Listing page failed:`, err.message);
        results.push({ area, success: false, error: `Could not load listing page: ${err.message}` });
        continue;
      }

      if (postUrls.length === 0) {
        // Without this the area contributes no rows at all and the UI shows
        // an empty result set that looks like success.
        results.push({ area, success: false, error: 'No listings found for this area/category.' });
        continue;
      }

      // Step 2: process each post
      for (const url of postUrls) {
        const page = await browser.newPage();
        try {
          const result = await processSinglePost(url, page, area);
          results.push(result ?? { url, area, success: false, error: 'No reply button or modal' });
        } catch (err) {
          console.error(`[${area}] Post failed: ${url}`, err.message);
          results.push({ url, area, success: false, error: err.message });
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

module.exports = { scrapeAreas, processSinglePost };