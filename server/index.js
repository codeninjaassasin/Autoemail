'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');

const config = require('./config');
const accounts = require('./accounts');
const googleOauth = require('./oauth/google');
const microsoftOauth = require('./oauth/microsoft');
const { createDrafts } = require('./drafts/createDrafts');
const scraper = require('./scraper');
const refresher = require('./scraper/refresher');
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
app.get('/admin/login', (req, res) => {
  if (auth.adminOf(req)) return res.redirect(302, safeNext(req.query.next, LOGIN_TEXT.DEFAULT_NEXT));
  res.set('Cache-Control', 'no-store');
  res.type('html').send(renderView('login.html', LOGIN_TEXT));
});
app.post('/admin/login', (req, res) => {
  const b = req.body || {};
  const out = auth.login(req, res, String(b.password || ''));
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

// --- Draft creation ---
app.post('/api/drafts', async (req, res) => {
  try {
    const { accountIds, subject, bodyHtml, recipients } = req.body;
    const results = await createDrafts({ accountIds, subject, bodyHtml, recipients });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
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
app.get('/api/sync', (req, res) => {
  const q = req.query;
  sendJson(req, res, {
    contacts: contacts.changesSince(q.cr, q.ce),
    posts: posts.changesSince(q.pr, q.pe),
  });
});

app.get('/api/contacts', (req, res) => sendJson(req, res, contacts.list()));
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
app.get('/api/status', (req, res) => res.json({ ...scraper.snapshot(), refresh: refresher.snapshot() }));

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
    const { mode, pruned, found, added, perSource } = await refreshPool(req.query.mode || 'keep-verified');
    scraper.addProxies(found.map((p) => p.server), { reset: mode !== 'add' }); // feed a running scrape now
    res.json({ ok: true, mode, pruned, found: found.length, added, perSource, stats: proxies.stats() });
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
        sent: 'boolean (manual)',
        scrapedAt: 'ISOString (first time this listing was stored)',
        postedAt: 'ISOString | null (when the listing was posted on Craigslist)',
        refreshStatus: '"fresh" | "unverified" | "expired" | absent (not checked yet)',
        checkedAt: 'ISOString | absent (last check, any outcome)',
        relayCheckedAt: 'ISOString | absent (last time the relay was read from the live page)',
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

app.listen(config.port, () => {
  console.log(`Autoemail running at http://localhost:${config.port}`);
});
// Background: posted dates for listed posts not scraped yet (All list sorting).
require('./postDates').start(broadcast);
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
