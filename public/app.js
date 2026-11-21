'use strict';

// ---------- Tabs ----------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'storage') loadFormat();
  });
});

// ---------- Quill ----------
const quill = new Quill('#editor', { theme: 'snow' });

// ---------- Accounts ----------
async function loadAccounts() {
  const list = await (await fetch('/api/accounts')).json();
  const ul = document.getElementById('accounts');
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = '<li class="sub">No accounts connected yet.</li>';
    return;
  }
  for (const a of list) {
    const li = document.createElement('li');
    li.innerHTML = `<input type="checkbox" value="${a.id}" checked />
      <span class="provider">${a.provider}</span><span>${a.emailAddress}</span>
      <a href="#" class="del" data-id="${a.id}">remove</a>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll('.del').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch(`/api/accounts/${el.dataset.id}`, { method: 'DELETE' });
      loadAccounts();
    })
  );
}
loadAccounts();

document.getElementById('create').addEventListener('click', async () => {
  const accountIds = [...document.querySelectorAll('#accounts input:checked')].map((c) => c.value);
  const out = document.getElementById('draftResult');
  out.hidden = false;
  out.textContent = 'Creating…';
  const data = await (
    await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accountIds,
        subject: document.getElementById('subject').value,
        bodyHtml: quill.root.innerHTML,
        recipients: document.getElementById('recipients').value,
      }),
    })
  ).json();
  out.textContent = data.ok
    ? data.results
        .map((r) => `${r.ok ? 'OK ' : 'ERR'} ${r.to} via ${r.account}${r.error ? ' — ' + r.error : ''}`)
        .join('\n')
    : `Error: ${data.error}`;
});

// ---------- Multiselect component ----------
function makeMultiselect(el, items, { valueKey, labelFn, allowAdd, onChange = () => {} }) {
  const selected = new Set();
  let all = items.slice();
  const changed = () => onChange([...selected]);

  el.innerHTML = `
    <div class="ms-search">
      <input type="text" placeholder="Search…" />
      ${allowAdd ? '<button class="ms-add" title="Add custom">+</button>' : ''}
    </div>
    <div class="ms-actions">
      <a href="#" class="ms-all">Select all</a>
      <a href="#" class="ms-none">Clear</a>
      <span class="ms-count">0 selected</span>
    </div>
    <div class="ms-list"></div>`;

  const search = el.querySelector('.ms-search input');
  const listEl = el.querySelector('.ms-list');
  const countEl = el.querySelector('.ms-count');

  function label(it) {
    return labelFn(it);
  }
  function render() {
    const q = search.value.trim().toLowerCase();
    // Selected items first so a restored selection is visible at a glance.
    // (Ticking a box doesn't re-render, so items never jump while clicking.)
    const shown = all
      .filter((it) => !q || label(it).toLowerCase().includes(q) || it[valueKey].includes(q))
      .sort((a, b) => Number(selected.has(b[valueKey])) - Number(selected.has(a[valueKey])));
    listEl.innerHTML = shown
      .map((it) => {
        const v = it[valueKey];
        return `<label class="ms-item"><input type="checkbox" value="${v}" ${
          selected.has(v) ? 'checked' : ''
        }/> ${label(it)}</label>`;
      })
      .join('');
    listEl.querySelectorAll('input').forEach((cb) =>
      cb.addEventListener('change', () => {
        cb.checked ? selected.add(cb.value) : selected.delete(cb.value);
        updateCount();
        changed();
      })
    );
  }
  function updateCount() {
    countEl.textContent = `${selected.size} selected`;
  }

  search.addEventListener('input', render);
  el.querySelector('.ms-all').addEventListener('click', (e) => {
    e.preventDefault();
    const q = search.value.trim().toLowerCase();
    all
      .filter((it) => !q || label(it).toLowerCase().includes(q) || it[valueKey].includes(q))
      .forEach((it) => selected.add(it[valueKey]));
    render();
    updateCount();
    changed();
  });
  el.querySelector('.ms-none').addEventListener('click', (e) => {
    e.preventDefault();
    selected.clear();
    render();
    updateCount();
    changed();
  });
  if (allowAdd) {
    el.querySelector('.ms-add').addEventListener('click', () => {
      const v = (search.value.trim() || prompt('Add area subdomain (e.g. sfbay):') || '').trim();
      if (!v) return;
      if (!all.some((it) => it[valueKey] === v)) all.unshift({ [valueKey]: v, name: v + ' (custom)' });
      selected.add(v);
      search.value = '';
      render();
      updateCount();
      changed();
    });
  }

  render();
  updateCount();
  return {
    values: () => [...selected],
    // Restore a saved selection. Unknown values are re-added as custom entries.
    setValues(vals, { silent = true } = {}) {
      selected.clear();
      for (const v of vals || []) {
        if (!all.some((it) => it[valueKey] === v)) {
          if (!allowAdd) continue;
          all.unshift({ [valueKey]: v, name: v + ' (custom)' });
        }
        selected.add(v);
      }
      render();
      updateCount();
      if (!silent) changed();
    },
  };
}

// ---------- Saved UI state (localStorage) ----------
// Area/category selections, run parameters, filters and panel states survive
// reloads. If a run is active, the server's actual areas/categories win.
const STORE_KEY = 'autoemail.scraper.v1';
let prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
})();
let prefsTimer = null;
function writePrefs() {
  clearTimeout(prefsTimer);
  prefsTimer = null;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — selections just won't persist */
  }
}
function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(writePrefs, 150);
}
// Don't lose a pending save if the page is reloaded/closed right after a change.
window.addEventListener('pagehide', () => {
  if (prefsTimer) writePrefs();
});

const PARAM_VALUES = ['query', 'concurrency', 'maxProxiesPerPost', 'replyWait', 'pageTimeout', 'cycleDelay'];
const PARAM_CHECKS = ['loop', 'useProxies', 'headless'];
function readParams() {
  const p = {};
  for (const id of PARAM_VALUES) p[id] = document.getElementById(id).value;
  for (const id of PARAM_CHECKS) p[id] = document.getElementById(id).checked;
  return p;
}
(function restoreParams() {
  const p = prefs.params || {};
  for (const id of PARAM_VALUES) if (p[id] !== undefined) document.getElementById(id).value = p[id];
  for (const id of PARAM_CHECKS) if (p[id] !== undefined) document.getElementById(id).checked = !!p[id];
  for (const id of [...PARAM_VALUES, ...PARAM_CHECKS]) {
    const el = document.getElementById(id);
    const onEdit = () => {
      savePrefs({ params: readParams() });
      updateRunSentence();
    };
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);
  }
})();

// ---------- Areas / categories ----------
const areaMeta = new Map(); // sub -> { name, city, state }
let catMeta = new Map(); // code -> name
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

let areasMs, catsMs;
(async () => {
  const areas = await (await fetch('/api/areas')).json();
  const cats = await (await fetch('/api/categories')).json();
  for (const a of areas) areaMeta.set(a.sub, a);
  catMeta = new Map(cats.map((c) => [c.code, c.name]));

  const persistSelection = () => {
    savePrefs({ areas: areasMs.values(), categories: catsMs.values() });
    updateRunSentence();
  };
  areasMs = makeMultiselect(document.getElementById('ms-areas'), areas, {
    valueKey: 'sub',
    labelFn: (a) => `${a.name} (${a.sub})`,
    allowAdd: true,
    onChange: persistSelection,
  });
  catsMs = makeMultiselect(document.getElementById('ms-categories'), cats, {
    valueKey: 'code',
    labelFn: (c) => `${c.name} [${c.code}] · ${c.group}`,
    allowAdd: false,
    onChange: persistSelection,
  });

  // Restore: server's live run first, else the last saved selection.
  let live = null;
  try {
    const s = await (await fetch('/api/status')).json();
    if (s.running && s.areas && s.areas.length) live = s;
  } catch {
    /* fall back to saved */
  }
  areasMs.setValues(live ? live.areas : prefs.areas || []); // unknown values come back as custom areas
  catsMs.setValues(live ? live.categories : prefs.categories || []);
  updateRunSentence();
  renderRows(); // location names are available now
})();

// The folded setup bar reads as one sentence describing the configured run.
function updateRunSentence() {
  const el = document.getElementById('runSentence');
  if (!el || !areasMs || !catsMs) return;
  const a = areasMs.values();
  const c = catsMs.values();
  if (!a.length) {
    el.textContent = 'Pick areas and categories to start.';
    return;
  }
  const esc2 = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const areaPart = a.length <= 2 ? a.map((s) => (areaMeta.get(s) || { city: s }).city).join(' and ') : `${a.length} areas`;
  const catNames = c.map((code) => String(catMeta.get(code) || code).replace(/^all\s+/i, '').toLowerCase());
  const catPart = !c.length ? 'for-sale posts' : c.length <= 2 ? catNames.join(' and ') : `${c.length} categories`;
  const p = readParams();
  const ipPart = p.useProxies ? 'through the proxy pool' : 'on your own IP';
  const loopPart = p.loop ? `, repeating every ${p.cycleDelay || 45}s` : ', once';
  const visPart = p.headless ? '' : ' with the browser visible';
  el.innerHTML = `Scrape <b>${esc2(catPart)}</b> in <b>${esc2(areaPart)}</b> using <b>${esc2(p.concurrency || 1)} workers</b> ${ipPart}${loopPart}${visPart}.`;
}

// Setup panel: remember open/closed; folds itself when a run starts.
const setupEl = document.getElementById('setup');
if (prefs.setupOpen === false) setupEl.open = false;
setupEl.addEventListener('toggle', () => savePrefs({ setupOpen: setupEl.open }));

// Telemetry strip: compact (one row) or all stats.
const tracerEl = document.getElementById('tracer');
const tracerToggle = document.getElementById('tracerToggle');
function applyTracerMode(full) {
  tracerEl.classList.toggle('compact', !full);
  tracerToggle.textContent = full ? 'Fewer stats' : 'All stats';
  tracerToggle.setAttribute('aria-expanded', String(full));
}
applyTracerMode(!!prefs.tracerFull);
tracerToggle.addEventListener('click', () => {
  const full = tracerEl.classList.contains('compact');
  applyTracerMode(full);
  savePrefs({ tracerFull: full });
});

// ---------- Tracer ----------
function fmtBytes(n) {
  if (!n) return '–';
  const mb = n / 1048576;
  return mb > 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}
function fmtDur(ms) {
  if (!ms) return '–';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? h + 'h ' : ''}${m ? m + 'm ' : ''}${s % 60}s`;
}
async function pollStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    document.getElementById('t-status').textContent = s.running ? 'running' : 'idle';
    document.getElementById('tracer').classList.toggle('running', !!s.running);
    if (typeof setRunButtons === 'function') setRunButtons(!!s.running);
    if ((s.running || s.refresh.running) && typeof attachEvents === 'function') attachEvents();
    renderRefresh(s.refresh);
    // topbar live strip
    const strip = document.getElementById('livestrip');
    strip.classList.toggle('running', !!s.running);
    document.getElementById('bar-status').textContent = s.running ? 'running' : 'idle';
    document.getElementById('bar-workers').textContent = `${s.activeWorkers}/${s.concurrency}`;
    document.getElementById('bar-queue').textContent = s.queueRemaining;
    document.getElementById('bar-stored').textContent = s.stored;
    document.getElementById('bar-ram').textContent = fmtBytes(s.memory.rss);
    document.getElementById('t-workers').textContent = `${s.activeWorkers} / ${s.concurrency}`;
    document.getElementById('t-queue').textContent = `${s.queueRemaining} / ${s.queueTotal}`;
    document.getElementById('t-attempts').textContent = s.attempts;
    document.getElementById('t-cycles').textContent = s.cycles ?? 0;
    document.getElementById('t-seen').textContent = s.seenTotal ?? 0;
    document.getElementById('t-stored').textContent = s.stored;
    document.getElementById('t-relays').textContent = s.relaysCaught ?? 0;
    document.getElementById('t-dropped').textContent = s.dropped;
    document.getElementById('t-parked').textContent = s.parked ?? 0;
    document.getElementById('t-gated').textContent = s.gated ?? 0;
    document.getElementById('t-solver').textContent = s.solver;
    document.getElementById('t-proxu').textContent = s.proxies.usable ?? 0;
    document.getElementById('t-proxlive').textContent = s.proxies.live ?? 0;
    document.getElementById('t-proxs').textContent = s.proxies.stored;
    document.getElementById('t-proxcool').textContent = s.proxies.cooled ?? 0;
    document.getElementById('t-proxfresh').textContent = s.proxyFresh ?? 0;
    document.getElementById('t-proxrelax').textContent = s.proxyRelax ?? 0;
    document.getElementById('t-contacts').textContent = s.contacts.total;
    document.getElementById('t-ram').textContent = fmtBytes(s.memory.rss);
    document.getElementById('t-heap').textContent = fmtBytes(s.memory.heapUsed);
    document.getElementById('t-uptime').textContent = s.running ? fmtDur(s.uptimeMs) : '–';
    document.getElementById('t-scope').textContent = `${s.areas.length} / ${s.categories.length}`;
  } catch {
    /* ignore */
  }
}
function renderRefresh(r) {
  const on = r.running && !r.stopping;
  document.getElementById('refreshToggle').checked = on;
  const stateEl = document.getElementById('r-state');
  stateEl.textContent = r.stopping ? 'stopping…' : on ? `${r.activeWorkers}/${r.workers} workers` : r.error ? `stopped: ${r.error}` : 'off';
  stateEl.classList.toggle('on', on);
  stateEl.classList.toggle('bad', !on && !!r.error);
  document.getElementById('r-fresh').textContent = r.counts.fresh;
  document.getElementById('r-unverified').textContent = r.counts.unverified;
  document.getElementById('r-expired').textContent = r.counts.expired;
  document.getElementById('r-unchecked').textContent = r.counts.unchecked;
  document.getElementById('r-changes').textContent = r.counts.relayChanges;
  const paused = r.sweep.pausedUntil > Date.now();
  document.getElementById('r-sweep').textContent = r.sweep.running
    ? `expiry sweep ${r.sweep.done}/${r.sweep.total}${paused ? ' (paused)' : ''}`
    : '';
}

setInterval(pollStatus, 2000);
pollStatus();

// ---------- Contacts table ----------
let rows = [];
let filter = 'all';
const tbody = document.querySelector('#scrapeTable tbody');
const stateFilterEl = document.getElementById('stateFilter');
const cityFilterEl = document.getElementById('cityFilter');
let stateFilter = (prefs.filters && prefs.filters.state) || '';
let cityFilter = (prefs.filters && prefs.filters.city) || '';
cityFilterEl.value = cityFilter;
const phoneOnlyEl = document.getElementById('phoneOnly');
let phoneOnly = !!(prefs.filters && prefs.filters.phoneOnly);
phoneOnlyEl.checked = phoneOnly;
const catFilterEl = document.getElementById('catFilter');
let catFilter = (prefs.filters && prefs.filters.category) || '';
const freshFilterEl = document.getElementById('freshFilter');
let freshFilter = (prefs.filters && prefs.filters.freshness) || '';
freshFilterEl.value = freshFilter;
function saveFilters() {
  savePrefs({ filters: { state: stateFilter, city: cityFilter, phoneOnly, category: catFilter, freshness: freshFilter } });
}
freshFilterEl.addEventListener('change', () => {
  freshFilter = freshFilterEl.value;
  saveFilters();
  renderRows();
});

// Category dropdown lists only categories present in the stored results, with counts.
function rebuildCategoryOptions() {
  const counts = new Map();
  for (const r of rows) counts.set(r.category || '', (counts.get(r.category || '') || 0) + 1);
  const codes = [...counts.keys()].filter(Boolean).sort((a, b) =>
    String(catMeta.get(a) || a).localeCompare(String(catMeta.get(b) || b))
  );
  const html = ['<option value="">All categories</option>']
    .concat(codes.map((c) => `<option value="${esc(c)}">${esc(catMeta.get(c) || c)} (${counts.get(c)})</option>`))
    .join('');
  if (catFilterEl.dataset.html !== html) {
    catFilterEl.innerHTML = html;
    catFilterEl.dataset.html = html;
  }
  catFilterEl.value = catFilter;
  if (catFilterEl.value !== catFilter) catFilterEl.value = ''; // saved category no longer present
}
catFilterEl.addEventListener('change', () => {
  catFilter = catFilterEl.value;
  saveFilters();
  renderRows();
});

function locOf(r) {
  const m = areaMeta.get(r.area);
  return m ? m : { name: r.area || '', city: r.area || '', state: '' };
}

// State dropdown lists only states present in the stored results, with counts.
function rebuildStateOptions() {
  const counts = new Map();
  for (const r of rows) {
    const st = locOf(r).state || '';
    counts.set(st, (counts.get(st) || 0) + 1);
  }
  const states = [...counts.keys()].filter(Boolean).sort((a, b) =>
    (STATE_NAMES[a] || a).localeCompare(STATE_NAMES[b] || b)
  );
  const opts = ['<option value="">All states</option>']
    .concat(states.map((st) => `<option value="${st}">${esc(STATE_NAMES[st] || st)} (${counts.get(st)})</option>`))
    .concat(counts.has('') ? [`<option value="__other">Other areas (${counts.get('')})</option>`] : []);
  const html = opts.join('');
  if (stateFilterEl.dataset.html !== html) {
    stateFilterEl.innerHTML = html;
    stateFilterEl.dataset.html = html;
  }
  stateFilterEl.value = stateFilter;
  if (stateFilterEl.value !== stateFilter) stateFilterEl.value = ''; // saved state no longer present
}

function matchesLocation(r) {
  const loc = locOf(r);
  if (stateFilter === '__other') {
    if (loc.state) return false;
  } else if (stateFilter && loc.state !== stateFilter) return false;
  if (cityFilter) {
    const q = cityFilter.toLowerCase();
    if (!`${loc.name} ${r.area || ''}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

stateFilterEl.addEventListener('change', () => {
  stateFilter = stateFilterEl.value;
  saveFilters();
  renderRows();
});
cityFilterEl.addEventListener('input', () => {
  cityFilter = cityFilterEl.value.trim();
  saveFilters();
  renderRows();
});
phoneOnlyEl.addEventListener('change', () => {
  phoneOnly = phoneOnlyEl.checked;
  saveFilters();
  renderRows();
});

// Phone lookup: matches any stored phone containing the typed digits, so
// "(555) 123-4567", "555.123", "+1 555 123 4567" and "4567" all work. Stored
// phones are bare 10-digit strings. Not saved to prefs — it's a one-off lookup.
const phoneFilterEl = document.getElementById('phoneFilter');
let phoneQuery = '';
function phoneDigits(raw) {
  const s = String(raw || '').trim();
  let d = s.replace(/\D/g, '');
  // Drop the country code: a full 11-digit 1XXXXXXXXXX, or an explicit "+1"/"1 " prefix.
  if ((d.length === 11 && d[0] === '1') || /^\+1|^1[\s.\-(]/.test(s)) d = d.slice(1);
  return d;
}
function matchesPhone(r) {
  if (!phoneQuery) return true;
  return (r.phones || []).some((p) => String(p).replace(/\D/g, '').includes(phoneQuery));
}
phoneFilterEl.addEventListener('input', () => {
  phoneQuery = phoneDigits(phoneFilterEl.value);
  renderRows();
});

function renderRows() {
  rebuildStateOptions();
  rebuildCategoryOptions();
  const effCat = catFilterEl.value; // '' if the saved category isn't present
  const filtered = rows.filter(
    (r) =>
      (filter === 'all' ? true : filter === 'sent' ? r.sent : !r.sent) &&
      (!effCat || r.category === effCat) &&
      (!phoneOnly || (r.phones && r.phones.length > 0)) &&
      (!freshFilter || (r.refreshStatus || 'unchecked') === freshFilter) &&
      matchesLocation(r) &&
      matchesPhone(r)
  ).sort((a, b) => {
    // Newest posted first; rows without a posted date go last.
    const ta = a.postedAt ? Date.parse(a.postedAt) : -Infinity;
    const tb = b.postedAt ? Date.parse(b.postedAt) : -Infinity;
    return tb - ta;
  });
  tbody.innerHTML = filtered
    .map((r) => {
      const loc = locOf(r);
      const title = esc(r.title || '(untitled)');
      const post = r.url
        ? `<a class="title-clamp" href="${esc(r.url)}" target="_blank" rel="noopener" title="${title}">${title}</a>`
        : `<span class="title-clamp" title="${title}">${title}</span>`;
      const others = (r.emails || []).filter((e) => e !== r.relay && !/craigslist\.org$/i.test(e));
      const relay = r.relay
        ? `<button type="button" class="relay-copy" data-copy="${esc(r.relay)}" title="${esc(r.relay)} — click to copy">${esc(shortRelay(r.relay))}</button>`
        : '';
      return `<tr>
      <td><input type="checkbox" class="sent-cb" data-id="${r.id}" ${r.sent ? 'checked' : ''} aria-label="Mark sent"/></td>
      <td><span class="loc-name">${esc(loc.name)}</span><span class="loc-sub">${esc(r.area || '')} / ${esc(r.category || '')}</span></td>
      <td>${fmtPosted(r.postedAt)}</td>
      <td>${post}</td>
      <td>${relay}</td>
      <td>${fmtChecked(r)}</td>
      <td>${(r.phones || [])
        .map(
          (p) =>
            `<span class="phone-line">${fmtPhone(p)}<button type="button" class="phone-copy" data-id="${r.id}" data-phone="${esc(p)}" title="Copy and mark sent" aria-label="Copy ${esc(p)} and mark sent">${COPY_ICON}</button></span>`
        )
        .join('')}</td>
      <td>${others.map(esc).join('<br>')}</td>
      <td><span class="note-clamp">${r.captchaBlocked ? 'captcha ' : ''}${esc(r.note || '')}</span></td>
      <td><button class="del-row" data-id="${r.id}" title="Delete record" aria-label="Delete record">✕</button></td></tr>`;
    })
    .join('');
  tbody.querySelectorAll('.relay-copy').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        const prev = btn.textContent;
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = prev;
          btn.classList.remove('copied');
        }, 1200);
      } catch {
        window.prompt('Copy relay email:', btn.dataset.copy);
      }
    })
  );
  tbody.querySelectorAll('.phone-copy').forEach((btn) => btn.addEventListener('click', () => copyPhone(btn)));
  tbody.querySelectorAll('.del-row').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const res = await fetch(`/api/contacts/${btn.dataset.id}`, { method: 'DELETE' });
      if (!res.ok) return;
      rows = rows.filter((r) => r.id !== btn.dataset.id);
      renderRows();
    })
  );
  tbody.querySelectorAll('.sent-cb').forEach((cb) =>
    cb.addEventListener('change', async () => {
      await fetch(`/api/contacts/${cb.dataset.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sent: cb.checked }),
      });
      const row = rows.find((r) => r.id === cb.dataset.id);
      if (row) row.sent = cb.checked;
      renderRows();
    })
  );
  document.getElementById('rowCount').textContent =
    filtered.length === rows.length ? `${rows.length} contacts` : `${filtered.length} of ${rows.length} contacts`;
  const empty = document.getElementById('emptyState');
  if (empty) {
    empty.hidden = filtered.length > 0;
    empty.textContent = rows.length
      ? phoneQuery
        ? 'No contacts match this phone number with the current filters. Set the other filters to All to search every record.'
        : 'No contacts match these filters. Clear the category, state, city, freshness or Has phone filter to see all.'
      : 'No contacts yet. Pick areas and start a scrape — only posts with a contact land here.';
  }
}
// Posted date: "Sep 15" (+ year if not this year), age underneath, full time on hover.
function fmtPosted(iso) {
  if (!iso) return '<span class="posted-none">–</span>';
  const d = new Date(iso);
  if (isNaN(d)) return '<span class="posted-none">–</span>';
  const now = new Date();
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  const days = Math.floor((now - d) / 86400000);
  const age = days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  return `<span class="posted-date" title="${esc(d.toLocaleString())}">${esc(d.toLocaleDateString(undefined, opts))}</span><span class="posted-age">${age}</span>`;
}

// Freshness badge plus the age of the last check; the hover gives relay age.
function fmtAge(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  const days = Math.floor(mins / 1440);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
function fmtChecked(r) {
  if (!r.refreshStatus) return '<span class="posted-none">Not checked</span>';
  const labels = { fresh: 'Fresh', unverified: 'Unverified', expired: 'Expired' };
  const hover = r.relayCheckedAt
    ? `Relay last confirmed ${new Date(r.relayCheckedAt).toLocaleString()}`
    : 'Relay never confirmed from a live page';
  const age = r.checkedAt ? `<span class="posted-age">${fmtAge(r.checkedAt)}</span>` : '';
  return `<span class="fresh-badge ${esc(r.refreshStatus)}" title="${esc(hover)}">${esc(labels[r.refreshStatus] || r.refreshStatus)}</span>${age}`;
}

// "473b978176cb370cafac3287d23f8c53@res.craigslist.org" -> "473b97…8c53@res.craigslist.org"
function shortRelay(addr) {
  const [local, domain] = String(addr).split('@');
  if (!domain || local.length <= 12) return addr;
  return `${local.slice(0, 6)}…${local.slice(-4)}@${domain}`;
}
function fmtPhone(p) {
  const d = String(p).replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : esc(p);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// --- Phone copy: copies the number, shows a toast, marks the row sent ---
const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

// Same "(555) 123-4567" form the table shows.
function phoneText(p) {
  const d = String(p).replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p);
}

// Clipboard API needs a secure context (localhost is one; a LAN IP over http
// is not), so fall back to a hidden textarea + execCommand.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

const toastsEl = document.getElementById('toasts');
const TOAST_MS = 4000;
const TOAST_MAX = 3;
function showToast({ kicker, title, body, tone = 'ok' }) {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
  const k = document.createElement('div');
  k.className = 'toast-kicker';
  k.textContent = kicker;
  const t = document.createElement('div');
  t.className = 'toast-title';
  t.textContent = title;
  const b = document.createElement('div');
  b.className = 'toast-body';
  b.textContent = body;
  el.append(k, t, b);
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  const timer = setTimeout(dismiss, TOAST_MS);
  el.addEventListener('click', dismiss);
  toastsEl.appendChild(el);
  while (toastsEl.children.length > TOAST_MAX) toastsEl.firstElementChild.remove();
}

async function copyPhone(btn) {
  const row = rows.find((r) => r.id === btn.dataset.id);
  const text = phoneText(btn.dataset.phone);
  const adTitle = (row && row.title) || '(untitled)';
  if (!(await copyText(text))) {
    showToast({ kicker: 'Copy failed · not marked sent', title: text, body: 'The browser blocked clipboard access. Copy the number by hand.', tone: 'bad' });
    return;
  }
  if (!row || row.sent) {
    showToast({ kicker: 'Copied', title: text, body: adTitle });
    return;
  }
  let marked = false;
  try {
    const res = await fetch(`/api/contacts/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sent: true }),
    });
    marked = res.ok;
  } catch {
    /* reported below */
  }
  if (marked) {
    row.sent = true;
    renderRows();
    showToast({ kicker: 'Copied · marked sent', title: text, body: adTitle });
  } else {
    showToast({ kicker: "Copied · couldn't mark sent", title: text, body: adTitle, tone: 'bad' });
  }
}
function upsertRow(row) {
  const i = rows.findIndex((r) => r.url === row.url);
  if (i >= 0) rows[i] = { ...rows[i], ...row };
  else rows.push(row);
}

function setSentFilter(value) {
  filter = value;
  document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x.dataset.filter === value));
}
setSentFilter(prefs.sentFilter || 'all');
document.querySelectorAll('.filter').forEach((b) =>
  b.addEventListener('click', () => {
    setSentFilter(b.dataset.filter);
    savePrefs({ sentFilter: b.dataset.filter });
    renderRows();
  })
);

async function loadContacts() {
  rows = await (await fetch('/api/contacts')).json();
  renderRows();
}
loadContacts();

document.getElementById('reloadData').addEventListener('click', async () => {
  rows = await (await fetch('/api/contacts/reload', { method: 'POST' })).json();
  renderRows();
});

document.getElementById('refreshProxies').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Fetching…';
  try {
    const r = await (await fetch('/api/proxies/refresh', { method: 'POST' })).json();
    if (r.ok) {
      const p = r.pruned ? `Kept ${r.pruned.kept} verified, removed ${r.pruned.removed} unverified.\n` : '';
      alert(`${p}Gathered ${r.found} proxies, ${r.added} new.\nStored ${r.stats.stored}. New proxies are verified by use while scraping.`);
    }
    else alert('Refresh failed: ' + r.error);
  } catch (err) {
    alert('Refresh failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
});

document.getElementById('dedupe').addEventListener('click', async () => {
  const r = await (await fetch('/api/contacts/dedupe', { method: 'POST' })).json();
  alert(`Removed ${r.removed} duplicate-phone contacts. ${r.count.total} remain.`);
  rows = await (await fetch('/api/contacts')).json();
  renderRows();
});

// ---------- Scraper (server-side run; this page only attaches to its events) ----------
let es = null;
const log = document.getElementById('scrapeLog');
const resultsplit = document.getElementById('resultsplit');
const logToggleBtn = document.getElementById('logToggle');
function applyTraceHidden(hidden) {
  resultsplit.classList.toggle('trace-hidden', hidden);
  logToggleBtn.textContent = hidden ? 'Show trace' : 'Hide trace';
  logToggleBtn.setAttribute('aria-pressed', String(!hidden));
}
applyTraceHidden(!!prefs.traceHidden);
logToggleBtn.addEventListener('click', () => {
  const hidden = !resultsplit.classList.contains('trace-hidden');
  applyTraceHidden(hidden);
  savePrefs({ traceHidden: hidden });
});
// Bounded, batched log: keeps the last LOG_MAX lines and repaints at most once
// per frame. Appending to one ever-growing textContent froze the tab on long runs.
const LOG_MAX = 400;
const logLines = [];
let logDirty = false;
function paintLog() {
  logDirty = false;
  // Only auto-scroll if the reader is already at the bottom (don't yank them
  // away while they're reading older lines).
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = logLines.length ? logLines.join('\n') : 'Waiting for a run…';
  if (atBottom) log.scrollTop = log.scrollHeight;
}
function addLog(line) {
  logLines.push(line);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  if (logDirty) return;
  logDirty = true;
  requestAnimationFrame(paintLog);
}
document.getElementById('logClear').addEventListener('click', () => {
  logLines.length = 0;
  paintLog();
});

function handleEvent(e) {
  if (e.type === 'post') {
    upsertRow(e.row);
    renderRows();
  } else if (e.type === 'done') {
    addLog(`Done. stored ${e.stored}, relays ${e.relays ?? 0}, dropped ${e.dropped}, parked ${e.parked ?? 0}, ${e.attempts} attempts.`);
    loadContacts();
  } else if (e.type === 'error') {
    addLog(`ERROR: ${e.message}`);
  } else if (e.type === 'aborted') {
    addLog(`⛔ ABORTED: ${e.message}`);
  } else if (e.type === 'blocked') {
    addLog(`⚠ BLOCKED by Craigslist on ${e.area}/${e.category}.`);
  } else if (e.type === 'cooldown') {
    addLog(`⏸ IP blocked — cooling down ${Math.round(e.cooldownMs / 1000)}s before retrying.`);
  } else if (e.type === 'collect-error') {
    addLog(`⚠ fetch failed ${e.area}/${e.category}: ${e.error}${e.willRetry ? ' — retrying at end of cycle' : ' — gave up this cycle'}`);
  } else if (e.type === 'proxies-fetched') {
    addLog(`proxies fetched: ${e.count} (stored ${e.stats.stored})`);
  } else if (e.type === 'parked') {
    addLog(`parked (tried ${e.tried} proxies): ${e.url}`);
  } else if (e.type === 'cycle-done') {
    addLog(`cycle ${e.cycle} done · ${e.newPosts} new posts · ${e.seen} seen`);
    loadContacts();
  } else if (e.type === 'retry') {
    addLog(`retry #${e.attempt} (${e.reason}): ${e.url}`);
  } else if (e.type === 'dropped') {
    addLog(`dropped (${e.reason || ''}): ${e.url}`);
  } else if (e.type === 'contacts-updated') {
    loadContacts();
  } else if (e.type === 'warn') {
    addLog(`WARN: ${e.message}`);
  } else if (e.type === 'refresh-started') {
    addLog(`Refresh started: ${e.workers} workers, up to ${e.maxProxiesPerPost} proxies per post.`);
  } else if (e.type === 'refresh-stopped') {
    addLog(`Refresh stopped. ${e.confirmed} same, ${e.changed} changed, ${e.unverified} unverified, ${e.expired} expired, ${e.attempts} attempts.`);
    loadContacts();
  } else if (e.type === 'refresh-sweep') {
    if (e.phase === 'start') addLog(`Refresh sweep: checking ${e.total} listings for expiry.`);
    else addLog(`Refresh sweep ${e.phase}: ${e.done}/${e.total} checked, ${e.expired} expired.`);
  } else if (e.type === 'refresh-result') {
    const words = {
      confirmed: `relay same (${e.tried} proxies)`,
      changed: `RELAY CHANGED ${e.from} to ${e.to} (${e.tried} proxies)`,
      unverified: `unverified after ${e.tried} proxies`,
      expired: 'expired',
    };
    addLog(`refresh: ${words[e.outcome]}: ${e.url}`);
  } else if (e.type !== 'collected') {
    addLog(JSON.stringify(e));
  }
}

// Attach to the server's event stream. If the connection drops (sleep, VPN
// toggle, refresh) the browser auto-reconnects; the run is unaffected.
function attachEvents() {
  if (es) return;
  es = new EventSource('/api/scrape/events');
  es.onmessage = (ev) => {
    try {
      handleEvent(JSON.parse(ev.data));
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    addLog('… stream interrupted — reconnecting (scraper keeps running on the server)');
  };
}

function setRunButtons(running) {
  document.getElementById('startScrape').disabled = running;
  document.getElementById('stopScrape').disabled = !running;
}

document.getElementById('startScrape').addEventListener('click', async () => {
  const areaVals = areasMs.values();
  if (!areaVals.length) return alert('Select at least one area.');
  const params = new URLSearchParams({
    areas: areaVals.join(','),
    categories: catsMs.values().join(','),
    query: document.getElementById('query').value,
    concurrency: document.getElementById('concurrency').value,
    maxProxiesPerPost: document.getElementById('maxProxiesPerPost').value,
    replyWaitMs: String((Number(document.getElementById('replyWait').value) || 25) * 1000),
    pageTimeoutMs: String(Math.max(0, Number(document.getElementById('pageTimeout').value) || 0) * 1000),
    loop: document.getElementById('loop').checked ? '1' : '0',
    cycleDelayMs: String((Number(document.getElementById('cycleDelay').value) || 45) * 1000),
    useProxies: document.getElementById('useProxies').checked ? '1' : '0',
    headless: document.getElementById('headless').checked ? '1' : '0',
  });
  logLines.length = 0;
  const r = await fetch(`/api/scrape/start?${params}`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) return alert(data.error || 'Could not start the run.');
  setRunButtons(true);
  attachEvents();
  setupEl.open = false; // fold setup into its one-line summary; results get the height
});

document.getElementById('stopScrape').addEventListener('click', async () => {
  await fetch('/api/scrape/stop', { method: 'POST' });
  addLog('Stop requested…');
});

// Relay refresh: its own switch, independent of Start/Stop. It reuses the run
// parameters above, but never the Workers field (it always runs 3 workers).
document.getElementById('refreshToggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  e.target.disabled = true;
  try {
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (on) {
      opts.body = JSON.stringify({
        headless: document.getElementById('headless').checked,
        maxProxiesPerPost: document.getElementById('maxProxiesPerPost').value,
        replyWaitMs: (Number(document.getElementById('replyWait').value) || 25) * 1000,
        pageTimeoutMs: Math.max(0, Number(document.getElementById('pageTimeout').value) || 0) * 1000,
      });
    }
    const r = await fetch(`/api/refresh/${on ? 'start' : 'stop'}`, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) alert(data.error || 'Could not change the refresh switch.');
    attachEvents();
  } finally {
    e.target.disabled = false;
    pollStatus();
  }
});

// On page load: if a run is already going on the server, re-attach to it.
(async () => {
  try {
    const s = await (await fetch('/api/status')).json();
    setRunButtons(!!s.running);
    if (s.running) attachEvents();
  } catch {
    /* server not reachable yet */
  }
})();

// ---------- DB format ----------
async function loadFormat() {
  const data = await (await fetch('/api/db-format')).json();
  document.getElementById('dbFormat').textContent = JSON.stringify(data, null, 2);
}
document.getElementById('reloadFormat').addEventListener('click', loadFormat);
