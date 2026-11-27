'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const accounts = require('./accounts');
const googleOauth = require('./oauth/google');
const microsoftOauth = require('./oauth/microsoft');
const draftLog = require('./drafts/log');
const reminders = require('./drafts/reminders');
const autoDrafts = require('./drafts/auto');
const replies = require('./drafts/replies');
const templates = require('./templates');
const scraper = require('./scraper');
const refresher = require('./scraper/refresher');
const postScrape = require('./scraper/postScrape');
const contacts = require('./contacts');
const proxies = require('./proxies');
const settings = require('./settings');
const posts = require('./posts');
const areas = require('./data/areas');
const categories = require('./data/categories');

const app = express();
app.use(express.json({ limit: '2mb' }));

// --- Login: nothing on this port is served without a session ----------------
const fs = require('fs');
const auth = require('./auth');
const VIEWS = path.join(__dirname, 'views');
const LOGIN_TEXT = {
  TITLE: 'Admin sign in',
  TAG: 'admin',
  HEADING: 'Admin sign in',
  SUB: 'Enter the admin password to manage sessions.',
  DEFAULT_NEXT: '/admin',
  ALT: '<a href="/">Back to the app</a>',
};
function renderView(file, vars) {
  let html = fs.readFileSync(path.join(VIEWS, file), 'utf8');
  for (const [k, v] of Object.entries(vars)) html = html.split(`{{${k}}}`).join(v);
  return html;
}
// Only same-site paths may be used as the after-login destination.
function safeNext(next, fallback) {
  const n = String(next || '');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n : fallback;
}
// The app is open to everyone (each browser gets a member session); only
// /admin needs the admin password. See server/auth.js.
app.use(auth.guard);

// Admin-only parts of the app: Gmail accounts and connecting them, templates,
// automatic drafts, drafted emails, replies, analytics, the storage format, and
// listed posts not scraped yet. Members (no password) see the scraped list only.
const ADMIN_ONLY = /^\/(api\/(accounts|templates|analytics|automation|reminders|replies|db-format|connect|posts)(\/|$)|connect\/|oauth\/)/;
app.use((req, res, next) => {
  if (req.admin || !ADMIN_ONLY.test(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Admin sign-in required.', admin: true });
  return res.redirect(302, `${auth.LOGIN_PAGE}?next=/`);
});
// Who is asking: the page shows the admin-only tabs only to an admin.
app.get('/api/me', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ admin: !!req.admin });
});
const isScraped = (row) => row && !row.unscraped;
app.get('/admin/login', (req, res) => {
  if (auth.adminOf(req)) return res.redirect(302, safeNext(req.query.next, LOGIN_TEXT.DEFAULT_NEXT));
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderView('login.html', LOGIN_TEXT));
});
app.post('/admin/login', async (req, res) => {
  const b = req.body || {};
  let out;
  try {
    out = await auth.login(req, res, String(b.password || ''));
  } catch (err) {
    console.error('[admin] sign-in failed:', err.message);
    out = { status: 500, error: 'Sign-in failed on the server.' };
  }
  if (!out.ok) return res.status(out.status).json({ ok: false, error: out.error });
  res.json({ ok: true, next: safeNext(b.next, LOGIN_TEXT.DEFAULT_NEXT) });
});
// Old links from the removed app login.
app.get('/login', (req, res) => res.redirect(302, '/'));
app.post('/admin/logout', (req, res) => {
  auth.logout(req, res);
  res.json({ ok: true });
});

// --- /admin: session management (admin only; enforced by auth.guard) ---
app.get('/admin', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(VIEWS, 'admin.html'));
});
app.get('/api/admin/sessions', (req, res) => {
  const me = req.admin.id;
  res.json({ ok: true, sessions: auth.list().map((s) => ({ ...s, current: s.id === me })) });
});
app.delete('/api/admin/sessions/:id', (req, res) => {
  if (!auth.remove(req.params.id)) return res.status(404).json({ ok: false, error: 'Session not found.' });
  res.json({ ok: true });
});
app.post('/api/admin/sessions/:id/block', (req, res) => {
  const blocked = (req.body || {}).blocked !== false;
  if (!auth.setBlocked(req.params.id, blocked)) return res.status(404).json({ ok: false, error: 'Member session not found.' });
  res.json({ ok: true, blocked });
});
app.post('/api/admin/sessions/sign-out-admins', (req, res) => {
  res.json({ ok: true, removed: auth.signOutOtherAdmins(req.admin.id) });
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg'));

// Pending OAuth states, in memory. Restarting the server mid-login invalidates them.
const pendingStates = new Map();
function newState(provider) {
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, { provider, at: Date.now() });
  return state;
}
function consumeState(state, provider) {
  const entry = pendingStates.get(state);
  pendingStates.delete(state);
  return entry && entry.provider === provider;
}

app.get('/api/accounts', (req, res) => res.json(accounts.list()));
app.delete('/api/accounts/:id', (req, res) => {
  accounts.remove(req.params.id);
  draftLog.forgetAccount(req.params.id);
  autoDrafts.forgetAccount(req.params.id);
  replies.forgetAccount(req.params.id);
  res.json({ ok: true });
});

// --- Reference data ---
app.get('/api/areas', (req, res) => res.json(areas));
app.get('/api/categories', (req, res) => res.json(categories));

// --- OAuth connect ---
app.get('/connect/google', (req, res) => {
  if (!config.google.clientId) return res.status(400).send('Google credentials not configured.');
  res.redirect(googleOauth.authUrl(newState('google')));
});
app.get('/connect/microsoft', async (req, res) => {
  if (!config.microsoft.clientId)
    return res.status(400).send('Microsoft credentials not configured.');
  res.redirect(await microsoftOauth.authUrl(newState('microsoft')));
});
app.get('/oauth/google/callback', async (req, res) => {
  try {
    if (!consumeState(req.query.state, 'google'))
      return res.status(400).send('Invalid or expired OAuth state.');
    await googleOauth.handleCallback(req.query.code);
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`Google OAuth failed: ${err.message}`);
  }
});
app.get('/oauth/microsoft/callback', async (req, res) => {
  try {
    if (!consumeState(req.query.state, 'microsoft'))
      return res.status(400).send('Invalid or expired OAuth state.');
    await microsoftOauth.handleCallback(req.query.code);
    res.redirect('/');
  } catch (err) {
    res.status(500).send(`Microsoft OAuth failed: ${err.message}`);
  }
});

// Which providers can be connected (credentials present) and the redirect
// address Google/Microsoft send the browser back to.
app.get('/api/connect/status', (req, res) =>
  res.json({
    google: { configured: !!(config.google.clientId && config.google.clientSecret), redirectUri: config.google.redirectUri },
    microsoft: { configured: !!(config.microsoft.clientId && config.microsoft.clientSecret), redirectUri: config.microsoft.redirectUri },
  })
);

// --- Email templates ---
app.get('/api/templates', (req, res) => res.json(templates.list()));
app.post('/api/templates', (req, res) => {
  try {
    res.json({ ok: true, template: templates.create(req.body) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
app.put('/api/templates/:id', (req, res) => {
  try {
    res.json({ ok: true, template: templates.update(req.params.id, req.body) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
app.delete('/api/templates/:id', (req, res) => {
  const ok = templates.remove(req.params.id);
  autoDrafts.forgetTemplate(req.params.id); // its mailboxes stop drafting
  res.json({ ok });
});

// --- Automatic drafts: new no-phone posts -> one draft from the mailbox's template. Never sends. ---
app.get('/api/analytics', (req, res) => {
  try {
    res.json(require('./analytics').build({ tz: String(req.query.tz || ''), days: req.query.days }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/api/automation', (req, res) => res.json(autoDrafts.summary()));
app.put('/api/automation', (req, res) => {
  try {
    res.json({ ok: true, ...autoDrafts.configure(req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Draft reminders: drafts this app made that still sit unsent. Read-only. ---
app.get('/api/reminders', (req, res) => res.json({ ...reminders.summary(), replies: replies.summary() }));

// Replies to sent drafts (headers only): mark read, or check now.
app.post('/api/replies/seen', (req, res) => res.json({ ok: true, marked: replies.markSeen(req.body?.ids), replies: replies.summary() }));
app.post('/api/replies/check', async (req, res) => {
  await replies.check().catch(() => {});
  res.json({ ...reminders.summary(), replies: replies.summary() });
});
app.post('/api/reminders/check', async (req, res) => {
  await Promise.all([reminders.check().catch(() => {}), replies.check().catch(() => {})]);
  res.json({ ...reminders.summary(), replies: replies.summary() });
});

// --- Contacts store ---
// JSON body, gzip-compressed (off the event loop) when large and accepted.
// The full list is ~6.6 MB raw and ~1 MB gzipped, which matters over Wi-Fi.
const zlib = require('zlib');
function sendJson(req, res, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  if (body.length < 32 * 1024 || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return res.send(body);
  zlib.gzip(body, { level: 5 }, (err, gz) => {
    if (err) return res.send(body);
    res.set('Content-Encoding', 'gzip');
    res.set('Vary', 'Accept-Encoding');
    res.send(gz);
  });
}

// --- List cache sync: the page keeps the whole list (contacts + listed posts)
// in its own cache and asks only for what changed since its last sync.
// Query: ce/cr = contacts epoch/rev, pe/pr = posts epoch/rev (omit for all).
// Members get only scraped contacts and no listed posts. Their sync position
// carries an "m:" epoch, so a browser that switches between member and admin
// gets a full list for its new view.
app.get('/api/sync', (req, res) => {
  const q = req.query;
  if (req.admin) {
    return sendJson(req, res, {
      contacts: contacts.changesSince(q.cr, q.ce),
      posts: posts.changesSince(q.pr, q.pe),
    });
  }
  const ce = String(q.ce || '');
  const c = contacts.changesSince(q.cr, ce.startsWith('m:') ? ce.slice(2) : undefined);
  const hidden = c.full ? [] : c.rows.filter((r) => !isScraped(r)).map((r) => r.id);
  sendJson(req, res, {
    contacts: { ...c, epoch: 'm:' + c.epoch, rows: c.rows.filter(isScraped), deleted: c.deleted.concat(hidden) },
    posts: { epoch: 'm', rev: 0, full: q.pe !== 'm', rows: [], removed: [] },
  });
});

app.get('/api/contacts', (req, res) => sendJson(req, res, req.admin ? contacts.list() : contacts.list().filter(isScraped)));
// A member may change only the rows it can see (scraped ones).
const memberMayTouch = (req, row) => req.admin || isScraped(row);
app.post('/api/contacts/reload', (req, res) => {
  contacts.reload(); // re-read data/contacts.json (pages resync: new epoch)
  res.json({ ok: true, count: contacts.count() });
});
// Body: { sent?, flagged? } (sent box, red mark).
const pickFlags = (b = {}) => {
  const f = {};
  if (b.sent !== undefined) f.sent = !!b.sent;
  if (b.flagged !== undefined) f.flagged = !!b.flagged;
  return f;
};
app.patch('/api/contacts/:id', (req, res) => {
  const target = contacts.list().find((r) => r.id === req.params.id);
  if (target && !memberMayTouch(req, target)) return res.status(401).json({ ok: false, error: 'Admin sign-in required.', admin: true });
  const row = contacts.setFlags(req.params.id, pickFlags(req.body));
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, row });
});
// Same for a listed post that isn't a contact yet: { url, sent?, flagged? }.
app.post('/api/posts/flags', (req, res) => {
  const url = String((req.body || {}).url || '');
  const flags = pickFlags(req.body);
  if (!Object.keys(flags).length) return res.status(400).json({ ok: false, error: 'Nothing to change.' });
  const row = contacts.setFlagsByUrl(url, flags, posts.find(url));
  if (!row) return res.status(404).json({ ok: false, error: 'Unknown post.' });
  res.json({ ok: true, row });
});
// Listed posts whose contact hasn't been scraped yet (the All list shows them
// next to the contacts, with empty fields to fill by hand).
app.get('/api/posts', (req, res) => {
  const stored = new Set(contacts.list().map((r) => r.url));
  sendJson(req, res, posts.listed().filter((p) => !stored.has(p.url)));
});
// Fill a relay email and/or phone by hand (pencil icon in the list).
app.post('/api/contacts/manual', (req, res) => {
  const b = req.body || {};
  const url = String(b.url || '');
  const existing = contacts.findByUrl(url);
  const post = posts.find(url);
  if (!existing && !post) return res.status(404).json({ ok: false, error: 'Unknown post.' });
  if (!req.admin && !isScraped(existing)) return res.status(401).json({ ok: false, error: 'Admin sign-in required.', admin: true });
  const relay = b.relay === undefined ? null : String(b.relay).trim().toLowerCase();
  if (relay !== null && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(relay)) {
    return res.status(400).json({ ok: false, error: 'That is not an email address.' });
  }
  let phone = null;
  if (b.phone !== undefined) {
    const { phonesFrom } = require('./scraper/extract');
    const digits = String(b.phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    phone = phonesFrom(digits)[0] || null;
    if (!phone || digits.length !== 10) return res.status(400).json({ ok: false, error: 'That is not a valid US phone number.' });
  }
  if (!relay && !phone) return res.status(400).json({ ok: false, error: 'Nothing to save.' });
  const out = contacts.setManual(url, { relay, phone }, post || {});
  if (out.error) return res.status(409).json({ ok: false, error: out.error });
  res.json({ ok: true, row: out.row });
});
app.delete('/api/contacts/:id', (req, res) => {
  const target = contacts.list().find((r) => r.id === req.params.id);
  if (target && !memberMayTouch(req, target)) return res.status(401).json({ ok: false, error: 'Admin sign-in required.', admin: true });
  const ok = contacts.remove(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true });
});

// --- Shared UI settings (same for every device that opens the page) ---
app.get('/api/settings', (req, res) => res.json(settings.get()));
const saveSettings = (req, res) => {
  const b = req.body || {};
  res.json(settings.patch(b.patch, b.clientId));
};
app.put('/api/settings', saveSettings);
app.post('/api/settings', saveSettings);

// --- Tracer / status ---
app.get('/api/status', (req, res) =>
  res.json({ ...scraper.snapshot(), refresh: refresher.snapshot(), postScrapes: postScrape.snapshot() })
);

// --- Scrape one post now (▶ on a row not scraped yet): a temporary worker
// that uses only usable proxies. Independent of the main run and the refresh.
app.post('/api/scrape/post', (req, res) => {
  if (!req.admin && !isScraped(contacts.findByUrl(String((req.body || {}).url || ''))))
    return res.status(401).json({ ok: false, error: 'Admin sign-in required.', admin: true });
  const r = postScrape.start((req.body || {}).url, broadcast);
  if (r.error) return res.status(r.status || 400).json({ ok: false, error: r.error });
  res.json({ ok: true });
});
app.post('/api/scrape/post/stop', (req, res) => {
  res.json({ ok: postScrape.stop((req.body || {}).url) });
});

// --- Relay refresh for unsent contacts (separate from the scrape run) ---
app.post('/api/refresh/start', (req, res) => {
  const b = req.body || {};
  const started = refresher.start(
    {
      headless: b.headless,
      replyWaitMs: b.replyWaitMs,
      pageTimeoutMs: b.pageTimeoutMs,
      maxProxiesPerPost: b.maxProxiesPerPost,
      scope: b.scope, // the starting device's list filters
      deviceId: b.deviceId,
    },
    broadcast
  );
  if (!started) return res.status(409).json({ ok: false, error: 'Refresh is already running.' });
  res.json({ ok: true });
});
// The device that started refresh moves its scope as it changes its filters.
app.put('/api/refresh/scope', (req, res) => {
  const b = req.body || {};
  const ok = refresher.setScope(b.scope, b.deviceId);
  if (!ok) return res.status(409).json({ ok: false, error: 'Refresh was started on another device.' });
  res.json({ ok: true });
});
app.post('/api/refresh/stop', (req, res) => {
  refresher.stop();
  res.json({ ok: true });
});

// --- Proxy pool: archive the pool, keep verified proxies (ones that reached a
// listing in real use), remove unverified ones, and fetch fresh free proxies.
// ?mode=empty archives and starts an empty pool instead; ?mode=add only adds.
// New proxies are verified by use while a run is active.
app.post('/api/proxies/refresh', async (req, res) => {
  try {
    const { refreshPool } = require('./scraper/proxyRefresh');
    const { mode, pruned, archives, found, added, perSource } = await refreshPool(req.query.mode || 'keep-verified');
    scraper.addProxies(found.map((p) => p.server), { reset: mode !== 'add' }); // feed a running scrape now
    res.json({ ok: true, mode, pruned, archives, found: found.length, added, perSource, stats: proxies.stats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Contacts: remove phone duplicates ---
// Backfill `postedAt` for stored contacts that don't have it, by fetching each
// listing over plain HTTP (no browser). Runs in the background; progress goes
// to the live trace. Expired listings (404/410) are left blank.
let backfill = null; // { total, done, filled, gone, failed }
app.post('/api/contacts/backfill-posted', (req, res) => {
  if (backfill) return res.status(409).json({ ok: false, error: 'Backfill already running', backfill });
  const { httpGet } = require('./scraper/httpGet');
  const { postedFromHtml } = require('./scraper/extract');
  const todo = contacts.list().filter((r) => !r.postedAt && r.url);
  backfill = { total: todo.length, done: 0, filled: 0, gone: 0, failed: 0 };
  res.json({ ok: true, total: todo.length });
  broadcast({ type: 'warn', message: `Filling posted dates for ${todo.length} contacts…` });
  (async () => {
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const r = todo[i++];
        try {
          const { status, html } = await httpGet(r.url, { timeout: 30000 });
          if (status === 404 || status === 410) backfill.gone++;
          else {
            const d = postedFromHtml(html);
            if (d) {
              r.postedAt = d; // row object lives in the contacts cache
              contacts.touch(r);
              backfill.filled++;
            } else backfill.failed++;
          }
        } catch {
          backfill.failed++;
        }
        backfill.done++;
        if (backfill.done % 25 === 0) {
          contacts.persist();
          broadcast({ type: 'warn', message: `Posted dates: ${backfill.done}/${backfill.total} checked, ${backfill.filled} filled` });
        }
        await new Promise((ok) => setTimeout(ok, 250));
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    contacts.persist();
    broadcast({
      type: 'warn',
      message: `Posted dates done: ${backfill.filled} filled, ${backfill.gone} listings expired, ${backfill.failed} unreadable.`,
    });
    broadcast({ type: 'contacts-updated' });
    backfill = null;
  })().catch(() => {
    backfill = null;
  });
});

// Keep only the given categories (?keep=rrr,ggg); delete everything else.
app.post('/api/contacts/prune', (req, res) => {
  const keep = String(req.query.keep || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!keep.length) return res.status(400).json({ ok: false, error: 'Pass ?keep=<category codes>' });
  const removed = contacts.keepOnlyCategories(keep);
  res.json({ ok: true, removed, count: contacts.count() });
});

app.post('/api/contacts/dedupe', (req, res) => {
  const removed = contacts.dedupeByPhone();
  res.json({ ok: true, removed, count: contacts.count() });
});

// --- DB storage format (self-describing schema of the on-disk stores) ---
app.get('/api/db-format', (req, res) => {
  const p = proxies.stats();
  res.json({
    'data/accounts.json': {
      description: 'Connected OAuth accounts (plaintext tokens — treat as a credential).',
      shape: 'Array<Account>',
      record: {
        id: 'uuid',
        provider: '"google" | "microsoft"',
        emailAddress: 'string',
        tokens: 'provider token object (google: {access_token, refresh_token, expiry_date}; microsoft: {accessToken, expiresOn})',
        homeAccountId: 'string (microsoft only)',
      },
    },
    'data/templates.json': {
      description: 'Email templates, edited in the Drafts tab and assigned to mailboxes. The body is plain text; its lines are kept line for line in the draft.',
      shape: 'Array<Template>',
      record: { id: 'uuid', name: 'string (unique)', subject: 'string with {{fields}}', body: 'multi-line text with {{fields}}', createdAt: 'ISOString', updatedAt: 'ISOString' },
      count: templates.list().length,
    },
    'data/automation.json': {
      description: 'Automatic drafts: on/off, when it was switched on (only posts scraped after that are drafted), the per-mailbox limits, the template assigned to each mailbox, each mailbox\'s draft times in the last 24 hours, and the recent choices with their reasons. Each drafted contact gets an `autoDraft` field in contacts.json.',
      shape: '{ enabled, enabledAt, limits: { perDay, perHour }, assignments: { [accountId]: { templateId } }, usage: { [accountId]: ISOString[] }, lastAccountId, recent: Array<{ at, ok, email, template, title, to, reason, error? }>, drafted, failed, lastDraftAt, lastError }',
    },
    'data/replies.json': {
      description: 'Replies to sent drafts, found every minute from each Gmail\'s change history (gmail.metadata scope: sender, subject, date; never the body). Unread ones badge the Drafts tab and raise a desktop notification until marked read.',
      shape: '{ accounts: { [accountId]: { historyId, checkedAt, error } }, replies: Array<{ id, accountId, logId, contactId, threadId, from, subject, snippet, at, foundAt, seenAt }> }',
    },
    'data/drafts.json': {
      description: 'Drafts this app created, for the reminder. The app never sends; a draft is "gone" once it leaves the Drafts folder (sent or deleted by you). Gone entries (left Drafts: counted as sent) are kept a year (Analytics counts drafts per day from them).',
      shape: 'Array<DraftEntry>',
      record: {
        id: 'uuid', accountId: 'uuid', provider: '"google" | "microsoft"', to: 'string', subject: 'string', templateId: 'uuid | null',
        draftId: 'provider draft id', messageId: 'string (google: current message id)', threadId: 'string (google: the thread replies arrive in)', webLink: 'string (microsoft)',
        status: '"waiting" | "gone"', createdAt: 'ISOString', goneAt: 'ISOString',
      },
      count: draftLog.all().length,
      waiting: draftLog.waiting().length,
    },
    'data/proxies.json': {
      description: 'Proxy pool with success/block history.',
      shape: '{ updatedAt: ISOString, proxies: Array<Proxy> }',
      record: {
        server: 'http://host:port',
        ip: 'string',
        location: 'string',
        org: 'string',
        successes: 'number',
        blocks: 'number',
        lastSuccess: 'ISOString',
        lastBlock: 'ISOString',
      },
      counts: p,
    },
    'data/contacts.json': {
      description: 'Scraped listing contacts. `sent` is a manual flag toggled in the UI.',
      shape: 'Array<Contact>',
      record: {
        id: 'uuid',
        url: 'listing url (unique key)',
        area: 'craigslist subdomain',
        category: 'category code',
        title: 'string',
        emails: 'string[]',
        phones: 'string[]',
        relay: 'string | null (…@job.craigslist.org)',
        captchaBlocked: 'boolean',
        note: 'string',
        sent: 'boolean (manual, or set when its automatic draft was sent)',
        sentAt: 'ISOString, when it was marked sent (Analytics)',
        scrapedAt: 'ISOString (first time this listing was stored)',
        postedAt: 'ISOString | null (when the listing was posted on Craigslist)',
        refreshStatus: '"fresh" | "unverified" | "expired" | absent (not checked yet)',
        checkedAt: 'ISOString | absent (last check, any outcome)',
        relayCheckedAt: 'ISOString | absent (last time the relay was read from the live page)',
        autoDraft: '{ at, accountId, account, templateId, to, draftId, logId, status?: "sent", sentAt? } once an automatic draft was made (status "sent" once it left Drafts) | { fails, error, at, to } after failed tries | absent',
        relayChangedAt: 'ISOString | absent (last time the relay was found changed)',
        relayChanges: 'number | absent (times the relay was found changed)',
        aliveCheckedAt: 'ISOString | absent (last HTTP sweep that found the listing alive)',
      },
      counts: contacts.count(),
    },
    'data/relay-changes.jsonl': {
      description: 'Append-only log with one line per relay change.',
      shape: 'JSON Lines',
      record: {
        at: 'ISOString',
        url: 'listing url',
        from: 'previous relay',
        to: 'new relay',
        previousCheckAt: 'ISOString | null (when the previous relay was last confirmed)',
        source: '"refresh" | "scrape"',
      },
    },
  });
});

// --- Scraper: the run lives on the SERVER, independent of any browser tab.
// Start it with POST /api/scrape/start; pages only attach to the event stream
// (GET /api/scrape/events). Closing/refreshing a tab never stops the run —
// only POST /api/scrape/stop does.
const subscribers = new Set();
const recentEvents = []; // backlog replayed to a page that (re)attaches
const RECENT_MAX = 200;
function broadcast(e) {
  recentEvents.push(e);
  if (recentEvents.length > RECENT_MAX) recentEvents.shift();
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of subscribers) res.write(line);
}

function paramsFrom(q) {
  return {
    areas: String(q.areas || '').split(',').filter(Boolean),
    categories: String(q.categories || '').split(',').filter(Boolean),
    query: q.query || '',
    concurrency: q.concurrency,
    useProxies: q.useProxies === '1',
    headless: q.headless === undefined ? undefined : q.headless === '1',
    loop: q.loop === '1',
    replyWaitMs: q.replyWaitMs,
    pageTimeoutMs: q.pageTimeoutMs,
    cycleDelayMs: q.cycleDelayMs,
    blockCooldownMs: q.blockCooldownMs,
    collectDelayMs: q.collectDelayMs,
    maxProxiesPerPost: q.maxProxiesPerPost,
  };
}

app.post('/api/scrape/start', (req, res) => {
  if (scraper.snapshot().running) return res.status(409).json({ ok: false, error: 'A run is already in progress — Stop it first.' });
  const params = paramsFrom({ ...req.query, ...(req.body || {}) });
  if (!params.areas.length) return res.status(400).json({ ok: false, error: 'Select at least one area.' });
  recentEvents.length = 0;
  // Fire-and-forget: the run outlives this request.
  scraper.runForever(params, broadcast).catch(() => {});
  res.json({ ok: true });
});

app.get('/api/scrape/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 3000\n\n'); // browser auto-reconnects after 3s if dropped
  for (const e of recentEvents) res.write(`data: ${JSON.stringify(e)}\n\n`);
  subscribers.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000); // keep-alive
  req.on('close', () => {
    clearInterval(ping);
    subscribers.delete(res); // detach only — the run keeps going
  });
});

app.post('/api/scrape/stop', (req, res) => {
  scraper.stop();
  res.json({ ok: true });
});

const missing = config.missingEnv();
if (missing.length) {
  console.log(
    `Warning: missing env vars: ${missing.join(', ')}. Copy .env.example to .env and fill in your OAuth credentials before connecting accounts. See README.md for setup steps.`
  );
}

// Move a legacy ADMIN_PASSWORD from .env into data/admin.json (hashed), once.
require('./adminPassword').migrateFromEnv().catch((err) => console.error('[admin] password migration failed:', err.message));

app.listen(config.port, () => {
  console.log(`Autoemail running at http://localhost:${config.port}`);
});
// Background: posted dates for listed posts not scraped yet (All list sorting).
require('./postDates').start(broadcast);
// Background: every 15 min, check which drafts this app made are still unsent.
reminders.start();
// Background: draft new no-phone posts from the assigned templates (when switched on).
autoDrafts.start();
replies.start();
// Repair: a contact without a posted date takes it from its listed post, if
// known (contacts filled by hand used to be saved without one).
{
  let fixed = 0;
  for (const r of contacts.list()) {
    if (r.postedAt) continue;
    const p = posts.find(r.url);
    if (p && p.postedAt) {
      r.postedAt = p.postedAt;
      contacts.touch(r);
      fixed++;
    }
  }
  if (fixed) {
    contacts.persist();
    console.log(`Filled the posted date of ${fixed} contact(s) from listed posts.`);
  }
}
