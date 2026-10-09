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
const contacts = require('./contacts');
const proxies = require('./proxies');
const areas = require('./data/areas');
const categories = require('./data/categories');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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
app.get('/api/contacts', (req, res) => res.json(contacts.list()));
app.post('/api/contacts/reload', (req, res) => res.json(contacts.reload()));
app.patch('/api/contacts/:id', (req, res) => {
  const row = contacts.setSent(req.params.id, req.body.sent);
  if (!row) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, row });
});
app.delete('/api/contacts/:id', (req, res) => {
  const ok = contacts.remove(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true });
});

// --- Tracer / status ---
app.get('/api/status', (req, res) => res.json(scraper.snapshot()));

// --- Proxy pool: archive old, build a fresh empty pool, fetch free proxies.
// Liveness verification happens continuously in the scraper's background
// supplier while a run is active.
app.post('/api/proxies/refresh', async (req, res) => {
  try {
    const { fetchFreeProxies } = require('./scraper/proxySource');
    if (req.query.rebuild !== '0') proxies.rebuild(); // archive old, start empty
    const { proxies: found, perSource } = await fetchFreeProxies();
    const added = proxies.addProxies(found);
    await proxies.flush();
    res.json({ ok: true, found: found.length, added, perSource, stats: proxies.stats() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Contacts: remove phone duplicates ---
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
        scrapedAt: 'ISOString',
      },
      counts: contacts.count(),
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
