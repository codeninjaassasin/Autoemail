const { chromium } = require('playwright');

// ── Selectors — update these if Craigslist changes its markup ─────
const LISTING_POST_LINK = 'a.posting-title';          // links on the search results page
const NAME_SELECTOR     = 'h2#title';
const REPLY_BTN         = 'a.reply_button';
const MODAL             = '#replymodal';
const EMAIL_BTN         = 'a.reply-email';
const EMAIL_TEXT        = '#reply-email-address';
const CALL_BTN          = 'a.reply-call';
const CALL_TEXT         = '#reply-phone';
const MSG_BTN           = 'a.reply-message';
const MSG_TEXT          = '#reply-message';
// ─────────────────────────────────────────────────────────────────

async function getPostUrls(area, category, browser) {
  const listingUrl = `https://${area}.craigslist.org/search/${category}`;
  const page = await browser.newPage();
  try {
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const urls = await page.$$eval(LISTING_POST_LINK, (links) =>
      links.map((a) => a.href).filter(Boolean)
    );
    console.log(`[${area}] Found ${urls.length} posts.`);
    return urls;
  } finally {
    await page.close();
  }
}

async function processSinglePost(postUrl, page, area) {
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForSelector('section#postingbody', { timeout: 10000 });

  // 1. Name
  let name = 'Unknown';
  const titleEl = await page.$(NAME_SELECTOR);
  if (titleEl) {
    name = (await titleEl.textContent()).trim();
  } else {
    const h = await page.$('h1, h2');
    if (h) name = (await h.textContent()).trim();
  }

  // 2. Reply button
  const replyBtn = await page.$(REPLY_BTN);
  if (!replyBtn) {
    console.log(`   [${area}] No reply button — ${postUrl}`);
    return null;
  }
  await replyBtn.click();

  // 3. Modal
  try {
    await page.waitForSelector(MODAL, { timeout: 5000 });
  } catch {
    console.log(`   [${area}] Modal didn't open — ${postUrl}`);
    return null;
  }

  const contacts = {};

  async function tryTab(btnSel, textSel, key) {
    const btn = await page.$(btnSel);
    if (!btn) return;
    await btn.click();
    try {
      await page.waitForSelector(textSel, { timeout: 3000 });
      const el = await page.$(textSel);
      if (el) contacts[key] = (await el.textContent()).trim();
    } catch { /* tab not present */ }
  }

  await tryTab(EMAIL_BTN, EMAIL_TEXT, 'email');
  await tryTab(CALL_BTN,  CALL_TEXT,  'call');
  await tryTab(MSG_BTN,   MSG_TEXT,   'message');

  // Close modal
  const closeBtn = await page.$('button.close, .close-modal');
  if (closeBtn) await closeBtn.click();
  else await page.keyboard.press('Escape');

  console.log(`   ✅ [${area}] ${name} — email: ${contacts.email ?? 'N/A'}`);
  return { area, name, url: postUrl, contacts, success: true };
}

async function scrapeAreas(areas = [], category = 'jjj') {
  const browser = await chromium.launch({ headless: false }); // false = visible browser
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