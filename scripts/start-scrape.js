#!/usr/bin/env node
// Start a scrape with the settings saved from the UI (data/settings.json),
// unless one is already running. Same request the "Start Scraping" button sends.
//
//   node scripts/start-scrape.js            check, start if idle
//   node scripts/start-scrape.js --status   only report, never start
//
// Waits up to 60 s for the server to answer, so it can run right after the
// server starts (the systemd unit uses it as ExecStartPost).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const BASE = `http://127.0.0.1:${PORT}`;
const statusOnly = process.argv.includes('--status');

async function getStatus() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/status`);
      if (r.ok) return r.json();
    } catch {}
    if (statusOnly) break;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return null;
}

function paramsFromSettings() {
  const file = path.join(__dirname, '..', 'data', 'settings.json');
  const prefs = JSON.parse(fs.readFileSync(file, 'utf8')).prefs || {};
  const p = prefs.params || {};
  const sec = (v, dflt) => String((Number(v) || dflt) * 1000);
  return new URLSearchParams({
    areas: (prefs.areas || []).join(','),
    categories: (prefs.categories || []).join(','),
    query: p.query || '',
    concurrency: String(p.concurrency || 1),
    maxProxiesPerPost: String(p.maxProxiesPerPost || ''),
    replyWaitMs: sec(p.replyWait, 25),
    pageTimeoutMs: String(Math.max(0, Number(p.pageTimeout) || 0) * 1000),
    loop: p.loop ? '1' : '0',
    cycleDelayMs: sec(p.cycleDelay, 45),
    useProxies: p.useProxies ? '1' : '0',
    // No display (server/VM): a visible browser cannot open, so force headless.
    headless: p.headless || !process.env.DISPLAY ? '1' : '0',
  });
}

(async () => {
  const s = await getStatus();
  if (!s) {
    console.log(`Server is NOT running on port ${PORT}.`);
    process.exit(statusOnly ? 1 : 2);
  }
  if (s.running) {
    const min = Math.round((s.uptimeMs || 0) / 60000);
    const c = s.contacts || {};
    console.log(`Server is up. Scrape is ALREADY RUNNING (for ${min} min, ${c.total} contacts stored, ${c.sent} sent). Nothing to do.`);
    return;
  }
  if (statusOnly) {
    console.log(`Server is up. Scrape is NOT running (${(s.contacts || {}).total} contacts stored).`);
    return;
  }
  const params = paramsFromSettings();
  const areas = params.get('areas').split(',').filter(Boolean).length;
  const r = await fetch(`${BASE}/api/scrape/start?${params}`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    console.error(`Could not start the scrape: ${data.error || r.status}`);
    process.exit(1);
  }
  console.log(`Scrape started: ${areas} areas, ${params.get('concurrency')} workers, proxies ${params.get('useProxies') === '1' ? 'on' : 'off'}, loop ${params.get('loop') === '1' ? 'on' : 'off'}.`);
})();
