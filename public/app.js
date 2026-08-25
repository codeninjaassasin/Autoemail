const quill = new Quill('#editor', { theme: 'snow' });

const accountsListEl = document.getElementById('accounts-list');
const accountErrorsEl = document.getElementById('account-errors');
const submitBtn = document.getElementById('submit-btn');
const recipientErrorsEl = document.getElementById('recipient-errors');
const resultsEl = document.getElementById('results');
const form = document.getElementById('draft-form');
const researchUrlsEl = document.getElementById('research-urls');
const researchErrorsEl = document.getElementById('research-errors');
const researchSubmitBtn = document.getElementById('research-submit-btn');
const researchStopBtn = document.getElementById('research-stop-btn');
const researchResultsEl = document.getElementById('research-results');
const liveStatusEl = document.getElementById('live-status');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROVIDER_LABELS = { google: 'Google', microsoft: 'Microsoft' };

async function loadAccounts() {
  const res = await fetch('/api/accounts');
  const accounts = await res.json();
  renderAccounts(accounts);
  submitBtn.disabled = accounts.length === 0;
}

function renderAccounts(accounts) {
  accountsListEl.innerHTML = '';
  if (accounts.length === 0) {
    accountsListEl.innerHTML = '<div class="empty-state">No accounts connected yet.</div>';
    return;
  }
  for (const account of accounts) {
    const row = document.createElement('div');
    row.className = 'account-row';
    row.innerHTML = `
      <label class="label">
        <input type="checkbox" data-account-id="${account.id}" checked />
        <span class="provider-badge">${PROVIDER_LABELS[account.provider] || account.provider}</span>${account.emailAddress}
      </label>
      <button type="button" class="secondary" data-id="${account.id}">Disconnect</button>
    `;
    row.querySelector('button').addEventListener('click', () => disconnectAccount(account.id));
    accountsListEl.appendChild(row);
  }
}

function getCheckedAccountIds() {
  return Array.from(accountsListEl.querySelectorAll('input[type="checkbox"]:checked')).map(
    (el) => el.dataset.accountId
  );
}

async function disconnectAccount(id) {
  await fetch(`/api/accounts/${id}/disconnect`, { method: 'POST' });
  loadAccounts();
}


form.addEventListener('submit', async (e) => {
  e.preventDefault();
  recipientErrorsEl.textContent = '';
  accountErrorsEl.textContent = '';
  resultsEl.innerHTML = '';

  const fromAccountIds = getCheckedAccountIds();
  if (fromAccountIds.length === 0) {
    accountErrorsEl.textContent = 'Check at least one account to send from.';
    return;
  }

  // The scraped table is the recipient list; there is no separate field to
  // read, so nothing can drift out of sync with what's on screen.
  const recipients = selectedRecipients().filter((r) => EMAIL_RE.test(r));
  if (recipients.length === 0) {
    recipientErrorsEl.textContent =
      'No recipients selected — scrape below, then tick rows that have an email.';
    return;
  }

  const payload = {
    fromAccountIds,
    subject: document.getElementById('subject').value,
    bodyHtml: quill.root.innerHTML,
    recipients,
  };

  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating drafts…';

  try {
    const res = await fetch('/api/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const rows = data.results || [{ recipient: '(request)', success: false, error: data.error || 'Unknown error' }];
    renderResults(rows);

    // Drop the ones that became drafts. Leaving them selected would send a
    // second draft to the same person on the next click, and the table is the
    // recipient list — so what's left in it is what still needs writing to.
    const drafted = rows.filter((r) => r.success).map((r) => String(r.recipient).toLowerCase());
    for (const e of drafted) draftedEmails.add(e);
    if (drafted.length) {
      // Redrawing is enough — the render filters on `draftedEmails`, so a row
      // whose addresses have all been written to drops out on its own, and one
      // with an address left keeps it. Pruning `lastResults` as well would
      // achieve nothing, since the next poll replaces it wholesale anyway.
      //
      // In the saved view the server has just moved those addresses out of
      // pending, so re-read it rather than redrawing a stale list.
      if (savedView) showSavedContacts(savedView.kind);
      else renderResearchResults(lastResults, lastProxyCheck, lastProgress);
      // The counts on the cards changed too.
      loadContactStore();
    }
  } catch (err) {
    renderResults([{ recipient: '(request)', success: false, error: err.message }]);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Drafts';
  }
});

function renderResults(results) {
  resultsEl.innerHTML = '';
  for (const r of results) {
    const row = document.createElement('div');
    row.className = `result-row ${r.success ? 'success' : 'error'}`;
    const via = r.accountEmail ? ` (via ${PROVIDER_LABELS[r.provider] || r.provider} — ${r.accountEmail})` : '';
    row.textContent = r.success
      ? `✓ ${r.recipient} — Draft created${via}`
      : `✗ ${r.recipient} — ${r.error}${via}`;
    resultsEl.appendChild(row);
  }
}

// ── Area and section pickers ─────────────────────────────────────
/**
 * Two checkbox dropdowns. Only what is ticked gets scraped — there is no
 * hidden "all sections" default any more, so the request says exactly what the
 * screen shows.
 *
 * Areas are editable: the Add row at the top of the dropdown appends to the
 * list and ticks the new entry, because adding one is how you say you want it.
 * The list and both selections persist, so a reload doesn't cost you the setup.
 */
const AREA_SEED = [
  'sfbay', 'losangeles', 'newyork', 'chicago', 'seattle', 'boston', 'denver',
  'atlanta', 'miami', 'dallas', 'houston', 'phoenix', 'portland', 'sandiego',
  'sacramento', 'minneapolis', 'philadelphia', 'austin', 'lasvegas', 'raleigh',
  'nashville', 'detroit', 'cleveland', 'pittsburgh',
];
// Same shape the server validates with (AREA_RE) — rejecting here means a bad
// code never becomes a request that fails halfway through a run.
const AREA_RE = /^[a-z0-9-]+$/;
const LS = { areas: 'autoemail.areas', areaSel: 'autoemail.areasSelected', catSel: 'autoemail.catsSelected' };

const readLS = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};
const writeLS = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

let areaOptions = readLS(LS.areas, AREA_SEED.slice());
const selectedAreas = new Set(readLS(LS.areaSel, []));
let catOptions = [];
const selectedCats = new Set(readLS(LS.catSel, []));

const areaListEl = document.getElementById('area-list');
const areaCountEl = document.getElementById('area-count');
const areaInputEl = document.getElementById('area-input');
const areaAddBtnEl = document.getElementById('area-add-btn');
const areaAddErrEl = document.getElementById('area-add-error');
const catListEl = document.getElementById('cat-list');
const catCountEl = document.getElementById('cat-count');
const pickerSummaryEl = document.getElementById('picker-summary');

function renderAreaList() {
  areaListEl.innerHTML = '';
  if (areaOptions.length === 0) {
    areaListEl.innerHTML = '<div class="ms-empty">No areas yet — add one above.</div>';
  }
  for (const area of areaOptions) {
    const row = document.createElement('label');
    row.className = 'ms-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedAreas.has(area);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedAreas.add(area);
      else selectedAreas.delete(area);
      writeLS(LS.areaSel, [...selectedAreas]);
      updatePickerSummary();
    });

    const name = document.createElement('span');
    name.className = 'ms-name';
    name.textContent = area;

    // Removing takes it off the list entirely; unticking just excludes it from
    // the next run. Two different intentions, two different controls.
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ms-remove';
    del.textContent = '×';
    del.title = `Remove ${area} from the list`;
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      areaOptions = areaOptions.filter((a) => a !== area);
      selectedAreas.delete(area);
      writeLS(LS.areas, areaOptions);
      writeLS(LS.areaSel, [...selectedAreas]);
      renderAreaList();
      updatePickerSummary();
    });

    row.append(cb, name, del);
    areaListEl.appendChild(row);
  }
  updatePickerSummary();
}

function renderCatList() {
  catListEl.innerHTML = '';
  if (catOptions.length === 0) {
    catListEl.innerHTML = '<div class="ms-empty">Loading sections…</div>';
    return;
  }
  for (const cat of catOptions) {
    const row = document.createElement('label');
    row.className = 'ms-item';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selectedCats.has(cat.code);
    cb.addEventListener('change', () => {
      if (cb.checked) selectedCats.add(cat.code);
      else selectedCats.delete(cat.code);
      writeLS(LS.catSel, [...selectedCats]);
      updatePickerSummary();
    });

    const name = document.createElement('span');
    name.className = 'ms-name';
    name.textContent = cat.name;

    const code = document.createElement('span');
    code.className = 'ms-sub';
    code.textContent = cat.code;

    row.append(cb, name, code);
    catListEl.appendChild(row);
  }
  updatePickerSummary();
}

function updatePickerSummary() {
  areaCountEl.textContent = String(selectedAreas.size);
  areaCountEl.classList.toggle('empty', selectedAreas.size === 0);
  catCountEl.textContent = String(selectedCats.size);
  catCountEl.classList.toggle('empty', selectedCats.size === 0);

  if (!pickerSummaryEl) return;
  if (selectedAreas.size === 0 || selectedCats.size === 0) {
    pickerSummaryEl.textContent = 'Tick at least one area and one section to scrape.';
    pickerSummaryEl.style.color = 'var(--muted)';
    return;
  }
  const names = catOptions.filter((c) => selectedCats.has(c.code)).map((c) => c.name);
  pickerSummaryEl.textContent =
    `${selectedAreas.size} area${selectedAreas.size === 1 ? '' : 's'} × ` +
    `${names.length} section${names.length === 1 ? '' : 's'} (${names.join(', ')})`;
  pickerSummaryEl.style.color = 'var(--muted)';
}

function addArea(raw) {
  // Tolerate a pasted URL — "https://sfbay.craigslist.org/..." is the shape
  // people actually have to hand.
  const area = String(raw)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.craigslist\.org.*$/, '')
    .replace(/\/.*$/, '');

  areaAddErrEl.textContent = '';
  if (!area) return;
  if (!AREA_RE.test(area)) {
    areaAddErrEl.textContent = 'Letters, numbers and hyphens only.';
    return;
  }
  if (!areaOptions.includes(area)) {
    areaOptions.push(area);
    writeLS(LS.areas, areaOptions);
  }
  selectedAreas.add(area);
  writeLS(LS.areaSel, [...selectedAreas]);
  areaInputEl.value = '';
  renderAreaList();
}

areaAddBtnEl.addEventListener('click', () => addArea(areaInputEl.value));
areaInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addArea(areaInputEl.value); }
});

// Open/close, and close on any click that isn't inside the dropdown — a panel
// that only shuts via its own button gets left hanging over the results.
function wireDropdown(toggleId, panelId) {
  const toggle = document.getElementById(toggleId);
  const panel = document.getElementById(panelId);
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = panel.hidden;
    for (const p of document.querySelectorAll('.ms-panel')) {
      p.hidden = true;
      p.previousElementSibling?.setAttribute('aria-expanded', 'false');
    }
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
}
wireDropdown('area-toggle', 'area-panel');
wireDropdown('cat-toggle', 'cat-panel');

document.addEventListener('click', () => {
  for (const p of document.querySelectorAll('.ms-panel')) {
    p.hidden = true;
    p.previousElementSibling?.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  for (const p of document.querySelectorAll('.ms-panel')) p.hidden = true;
});

for (const btn of document.querySelectorAll('[data-all], [data-none]')) {
  btn.addEventListener('click', () => {
    const which = btn.dataset.all ?? btn.dataset.none;
    const selectAll = Boolean(btn.dataset.all);
    if (which === 'area') {
      selectedAreas.clear();
      if (selectAll) for (const a of areaOptions) selectedAreas.add(a);
      writeLS(LS.areaSel, [...selectedAreas]);
      renderAreaList();
    } else {
      selectedCats.clear();
      if (selectAll) for (const c of catOptions) selectedCats.add(c.code);
      writeLS(LS.catSel, [...selectedCats]);
      renderCatList();
    }
  });
}

/** Sections come from the server so the list can't drift from the scraper's. */
async function loadCategories() {
  try {
    const res = await fetch('/api/research/categories');
    if (!res.ok) throw new Error('could not load sections');
    const data = await res.json();
    catOptions = data.categories ?? [];
    // First visit only: adopt the server's defaults. After that the user's
    // choice wins, including a deliberate "none of the defaults".
    if (localStorage.getItem(LS.catSel) === null) {
      for (const c of catOptions) if (c.selected) selectedCats.add(c.code);
      writeLS(LS.catSel, [...selectedCats]);
    }
  } catch {
    catOptions = [];
  }
  renderCatList();
}

// ── Research submit ──────────────────────────────────────────────
researchSubmitBtn.addEventListener('click', async () => {
  researchErrorsEl.textContent  = '';
  researchResultsEl.innerHTML   = '';

  if (selectedAreas.size === 0) {
    researchErrorsEl.textContent = 'Tick at least one area in the Areas dropdown.';
    return;
  }
  if (selectedCats.size === 0) {
    researchErrorsEl.textContent = 'Tick at least one section in the Sections dropdown.';
    return;
  }

  researchSubmitBtn.disabled    = true;
  researchSubmitBtn.textContent = 'Scraping…';

  try {
    const res = await fetch('/api/research/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        areas: Array.from(selectedAreas),
        // Exactly what's ticked — the server no longer fills in a default set.
        categories: Array.from(selectedCats),
      }),
    });
    const data = await res.json();
    if (!data.jobId) throw new Error(data.error ?? 'Could not start the scrape.');

    currentJobId = data.jobId;
    researchStopBtn.hidden = false;
    researchStopBtn.disabled = false;
    researchStopBtn.textContent = 'Stop';

    await followJob(data.jobId);
  } catch (err) {
    renderResearchResults([{ success: false, error: err.message }]);
  } finally {
    currentJobId = null;
    researchStopBtn.hidden = true;
    researchSubmitBtn.disabled    = false;
    researchSubmitBtn.textContent = 'Start Scraping';
  }
});

let currentJobId = null;

/**
 * Asks the server to wind the run down.
 *
 * The button disables itself rather than waiting for a confirmation, because
 * the stop is cooperative — workers finish the post they are on, so there is a
 * gap between asking and stopping that would otherwise look like nothing
 * happened.
 */
researchStopBtn.addEventListener('click', async () => {
  if (!currentJobId) return;
  researchStopBtn.disabled = true;
  researchStopBtn.textContent = 'Stopping…';
  try {
    const res = await fetch(`/api/research/scrape/${currentJobId}/stop`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      researchErrorsEl.textContent = data.error ?? 'Could not stop the scrape.';
      // Already finished on its own — the poll will tidy the button up.
      if (data.status && data.status !== 'running') return;
      researchStopBtn.disabled = false;
      researchStopBtn.textContent = 'Stop';
    }
  } catch (err) {
    researchErrorsEl.textContent = err.message;
    researchStopBtn.disabled = false;
    researchStopBtn.textContent = 'Stop';
  }
});

/**
 * Polls a running scrape and redraws as rows land.
 *
 * An uncapped area is hundreds of listings, so the run outlives any single
 * request — the table fills in progressively rather than appearing at the end,
 * and closing the tab doesn't stop the job.
 */
async function followJob(jobId) {
  let seen = -1;
  traceEvents.length = 0;
  let sinceEvent = 0;

  for (;;) {
    // Only the events this page hasn't got yet; the server keeps a ring buffer
    // and re-sending it whole every two seconds would both waste the response
    // and make repeats indistinguishable from new activity.
    const res = await fetch(`/api/research/scrape/${jobId}?sinceEvent=${sinceEvent}`);
    if (!res.ok) throw new Error((await res.json()).error ?? 'Lost track of the scrape.');
    const job = await res.json();

    for (const e of job.events ?? []) traceEvents.push(e);
    if (traceEvents.length > TRACE_LIMIT) traceEvents.splice(0, traceEvents.length - TRACE_LIMIT);
    sinceEvent = job.eventSeq ?? sinceEvent;

    // The panel is redrawn every poll — exits move in and out of rotation
    // constantly, and it holds no state of the user's to clobber.
    renderLiveStatus(job);

    // Redraw only when something changed; the table carries tick state, so
    // needless redraws would clear selections the user has already made.
    // While the saved store is on screen, leave the table alone entirely.
    if (job.completed !== seen && !savedView) {
      seen = job.completed;
      renderResearchResults(job.results, job.proxyCheck, {
        status: job.status,
        completed: job.completed,
        planned: job.planned,
        label: job.currentLabel,
        elapsedMs: job.elapsedMs,
      });
    }

    if (job.status !== 'running') {
      // One last redraw regardless of the row count, so the final tally shows
      // the real outcome. Gating on `completed` changing meant a run whose
      // last poll added no rows kept its "Scraping…" line forever.
      if (!savedView) {
        renderResearchResults(job.results, job.proxyCheck, {
          status: job.status,
          completed: job.completed,
          planned: job.planned,
          label: job.currentLabel,
          elapsedMs: job.elapsedMs,
        });
      }
      if (job.status === 'failed') researchErrorsEl.textContent = job.error ?? 'Scrape failed.';
      return;
    }
    // Reflect a stop asked for elsewhere — another tab, or a reload mid-run.
    if (job.stopRequested && !researchStopBtn.disabled) {
      researchStopBtn.disabled = true;
      researchStopBtn.textContent = 'Stopping…';
    }
    // While stopping, the count that matters is how many posts are still in
    // flight — that is what the wait is actually bounded by, and watching it
    // drain is the difference between "winding down" and "hung".
    const inFlight = job.proxies?.working?.length ?? 0;
    researchSubmitBtn.textContent = job.stopRequested
      ? `Stopping… ${inFlight} in flight`
      : `Scraping… ${job.stats?.finishedPosts ?? job.completed}`;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── Live status panel ────────────────────────────────────────────
// Accumulated across polls, since each poll only carries what's new.
const traceEvents = [];
const TRACE_LIMIT = 400;
// Kept between polls so the counts don't blank out on a response that
// predates the first contact.
let lastContactCounts = null;

/**
 * The right-hand readout of a run in flight.
 *
 * Redrawn on every poll, independently of the results table — the table is
 * only rebuilt when a row lands, because rebuilding it clears tick state, and
 * the exits change far more often than the rows do.
 */
function renderLiveStatus(job) {
  const p = job?.proxies ?? { working: [], resting: [], idle: [], safe: [], poolSize: 0 };
  const s = job?.stats ?? { phase: 'idle', area: null, totalPosts: 0, finishedPosts: 0 };

  liveStatusEl.innerHTML = '';

  const phaseLabels = {
    starting: 'Starting…',
    'finding proxies': 'Finding proxies…',
    'reading listings': 'Reading listings…',
    scraping: 'Scraping posts…',
    'waiting for new listings': 'Waiting for new listings…',
    finished: 'Finished',
    stopped: 'Stopped',
    failed: 'Failed',
    idle: 'Idle — no run yet',
  };

  const running = job?.status === 'running';
  const head = document.createElement('div');
  head.style.cssText = 'font-size:0.85rem;font-weight:600;margin-bottom:0.7rem;';
  head.style.color = running ? 'var(--accent)' : 'var(--muted)';
  head.textContent = job?.stopRequested && running
    ? `Stopping… ${p.working.length} post${p.working.length === 1 ? '' : 's'} still in flight`
    : (phaseLabels[s.phase] ?? s.phase);
  liveStatusEl.appendChild(head);

  // Counters. Total is what the listings queued; finished is what has come
  // back, however it came back — a post with no contact is still finished.
  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  const stat = (key, value, wide = false, onClick = null) => {
    const el = document.createElement('div');
    el.className = wide ? 'stat wide' : 'stat';
    el.innerHTML = `<span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(value)}</span>`;
    if (onClick) {
      el.classList.add('clickable');
      el.tabIndex = 0;
      el.title = 'Click to list these in the table';
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
      });
    }
    grid.appendChild(el);
  };
  stat('City', s.area || '—', true);
  stat('Queued', String(s.queueDepth ?? 0));
  stat('Finished', String(s.finishedPosts ?? 0));
  // The run never ends, so these describe how hard it is working rather than
  // how far through it is — there is no "through".
  stat('Workers', String(s.workers ?? 0));
  stat('Free RAM', s.freeMemMB ? `${(s.freeMemMB / 1024).toFixed(1)} GB` : '—');

  // Rate and ETA, from the run's own elapsed time rather than wall clock, so
  // reopening the page mid-run doesn't restart the measurement.
  const mins = (job?.elapsedMs ?? 0) / 60000;
  const rate = mins > 0 ? (s.finishedPosts ?? 0) / mins : 0;
  const left = Math.max(0, (s.totalPosts ?? 0) - (s.finishedPosts ?? 0));
  stat('Rate', rate > 0 ? `${rate.toFixed(1)}/min` : '—');
  stat('ETA', running && rate > 0 && left > 0 ? formatDuration((left / rate) * 60000) : '—');

  // What's on disk, not what's on screen: these keep counting across runs and
  // survive a restart, which is the whole point of writing them out.
  const c = job?.contacts ?? lastContactCounts;
  if (c) {
    lastContactCounts = c;
    // Clickable only when there is something to show — a card that opens an
    // empty table teaches you nothing.
    stat('Saved emails', `${c.pending} pending`, false,
      c.pending > 0 ? () => showSavedContacts('emails') : null);
    stat('Saved phones', String(c.phones), false,
      c.phones > 0 ? () => showSavedContacts('phones') : null);
  }
  liveStatusEl.appendChild(grid);

  // What the finished posts actually produced. "Finished" alone can't tell a
  // productive run from one that is being challenged on every post.
  const rows = job?.results ?? [];
  const tally = { contact: 0, empty: 0, captcha: 0, failed: 0 };
  let attemptSum = 0;
  let attemptRows = 0;
  for (const r of rows) {
    if (typeof r.attempts === 'number') { attemptSum += r.attempts; attemptRows += 1; }
    if (!r.success) { tally.failed += 1; continue; }
    if ((r.contacts?.emails?.length ?? 0) + (r.contacts?.phones?.length ?? 0) > 0) tally.contact += 1;
    else if (r.captchaBlocked) tally.captcha += 1;
    else tally.empty += 1;
  }

  const outcomes = document.createElement('div');
  outcomes.className = 'outcome-row';
  const outcome = (label, n, cls, title) => {
    const el = document.createElement('div');
    el.className = `outcome ${cls}`;
    el.title = title;
    el.innerHTML = `<span class="n">${n}</span><span class="l">${escapeHtml(label)}</span>`;
    outcomes.appendChild(el);
  };
  outcome('contact', tally.contact, 'good', 'Posts that yielded an email or phone');
  outcome('none', tally.empty, 'dim', 'Reply panel opened and the poster published nothing — a dead post');
  outcome('captcha', tally.captcha, 'warn', 'Blocked by a challenge on every exit tried');
  outcome('failed', tally.failed, 'bad', 'Never produced a usable read');
  liveStatusEl.appendChild(outcomes);

  // Attempts per post is the clearest read on how hard rotation is working:
  // near 1 means exits are healthy, high means most are being challenged.
  const avg = document.createElement('div');
  avg.style.cssText = 'font-size:0.72rem;color:var(--muted);margin:-0.4rem 0 0.85rem;';
  avg.textContent = attemptRows
    ? `${(attemptSum / attemptRows).toFixed(1)} exits per post on average`
    : 'No completed posts yet.';
  liveStatusEl.appendChild(avg);

  const group = (title, count, items, render) => {
    const box = document.createElement('div');
    box.className = 'ip-group';
    const h = document.createElement('h4');
    h.innerHTML = `<span>${escapeHtml(title)}</span><span>${count}</span>`;
    box.appendChild(h);
    const list = document.createElement('div');
    list.className = 'ip-list';
    if (items.length === 0) {
      const none = document.createElement('span');
      none.className = 'ip-empty';
      none.textContent = '—';
      list.appendChild(none);
    } else {
      for (const item of items) list.appendChild(render(item));
    }
    box.appendChild(list);
    liveStatusEl.appendChild(box);
  };

  const chip = (text, cls, title) => {
    const el = document.createElement('span');
    el.className = `ip ${cls}`;
    el.textContent = text;
    if (title) el.title = title;
    return el;
  };

  // Leased to a worker. A lease is held across many posts now, so the post
  // count is the useful number — it says how much this exit has earned before
  // Craigslist noticed it.
  group('Working now', p.working.length, p.working, (w) =>
    chip(
      w.posts > 0 ? `${w.ip || '?'} ·${w.posts}` : (w.ip || '?'),
      'working',
      `${w.location || 'Unknown'} — held ${Math.round((w.forMs ?? 0) / 1000)}s, ${w.posts ?? 0} post(s) done`
    )
  );

  // Challenged, and sitting out the relaxing period before rejoining the
  // ready list. Not burned — Craigslist throttles an address that asked too
  // fast, and the same exit answers again once left alone.
  group('Relaxing', p.resting.length, p.resting, (r) =>
    chip(
      `${r.ip || '?'} ${Math.ceil((r.readyInMs ?? 0) / 60000)}m`,
      'resting penalised',
      `${r.location || 'Unknown'} — challenged after ${r.posts ?? 0} post(s), ` +
        `back in ${Math.ceil((r.readyInMs ?? 0) / 1000)}s`
    )
  );

  // No ready list by design — a verified proxy goes straight to a worker.
  // What queues instead is workers, so that is what gets reported.
  const waiting = p.waiting ?? 0;
  const waitBox = document.createElement('div');
  waitBox.className = 'ip-group';
  waitBox.innerHTML =
    `<h4><span>Workers waiting</span><span>${waiting}</span></h4>` +
    `<div class="ip-empty">${waiting > 0
      ? 'Queued for the next verified proxy — discovery is the limit.'
      : 'Every worker has an exit; discovery is keeping up.'}</div>`;
  liveStatusEl.appendChild(waitBox);

  // The store: exits that have actually produced a contact and survive
  // restarts. These are the ones worth having.
  group('Safe (stored)', p.safe.length, p.safe, (e) =>
    chip(e.ip || '?', 'safe', `${e.location || 'Unknown'} — ${e.successes} success(es), ${e.blocks} block(s)`)
  );

  // The two subsystems, reported separately — the finder runs whether or not
  // scraping is making progress, and a stall in one shouldn't look like the
  // other is broken.
  const foot = document.createElement('div');
  foot.style.cssText = 'font-size:0.72rem;color:var(--muted);border-top:1px solid var(--border);padding-top:0.5rem;margin-bottom:0.85rem;line-height:1.5;';
  const f = job?.finder;
  const posts = job?.posts;
  foot.innerHTML =
    `${p.poolSize} exit${p.poolSize === 1 ? '' : 's'} in rotation` +
    (p.relaxedCount ? ` · ${p.relaxedCount} relaxed` : '') +
    (p.returnedCount ? ` (${p.returnedCount} back)` : '') +
    (p.blockedNow ? ` · ${p.blockedNow} blocked` : '') +
    (p.blockedForGood ? ` (${p.blockedForGood} for good)` : '') +
    (p.unblockedCount ? ` · ${p.unblockedCount} retried` : '') +
    (f ? `<br>finder: ${f.probed ?? 0} probed, ${f.accepted ?? 0} verified` +
         (f.unclaimed ? `, ${f.unclaimed} unclaimed` : '') +
         (f.running ? '' : ' (stopped)') : '') +
    (posts ? `<br>posts: ${posts.scraped} scraped, ${posts.dead} dead` + (posts.gone ? `, ${posts.gone} removed` : "") + (posts.due ? ` · ${posts.due} due re-read` : "") : '') +
    (s.cycles ? ` · cycle ${s.cycles}` : '');
  liveStatusEl.appendChild(foot);

  // The activity feed. Everything above is a number; this is the why behind
  // it — which exit was challenged, what got retried, when the pool was swept.
  const logBox = document.createElement('div');
  logBox.className = 'ip-group';
  const logHead = document.createElement('h4');
  logHead.innerHTML = `<span>Activity</span><span>${traceEvents.length}</span>`;
  logBox.appendChild(logHead);

  const log = document.createElement('div');
  log.className = 'trace-log';
  if (traceEvents.length === 0) {
    log.innerHTML = '<span class="ip-empty">Nothing yet.</span>';
  } else {
    // Newest first: a feed you have to scroll to the bottom of to see the
    // latest line is useless while something is going wrong.
    for (const e of traceEvents.slice(-120).reverse()) {
      const line = document.createElement('div');
      line.className = `trace trace-${e.level}`;
      const t = new Date(e.at).toLocaleTimeString([], { hour12: false });
      line.innerHTML = `<span class="t">${escapeHtml(t)}</span> ${escapeHtml(e.msg)}`;
      log.appendChild(line);
    }
  }
  logBox.appendChild(log);
  liveStatusEl.appendChild(logBox);
}

/** ms as a compact "4m 12s" / "38s". */
function formatDuration(ms) {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ${secs % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ── Result rendering ─────────────────────────────────────────────
/** Renders an ISO timestamp as a short local date, plus how long ago it was. */
function formatPosted(iso) {
  if (!iso) return { text: '—', title: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { text: '—', title: String(iso) };

  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  // Age is the point of showing a date here — a listing from March is far
  // less worth writing to than one from this morning.
  const age = days <= 0 ? 'today' : days === 1 ? '1d ago' : `${days}d ago`;
  const text = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return { text: `${text} (${age})`, title: d.toLocaleString() };
}

/**
 * Run-level readout of which exit IPs were actually used, derived from the
 * rows. Counting posts per IP is the point: it shows whether rotation really
 * happened or the whole run went out through one address.
 */
/** Pre-scrape proxy check readout: how many were probed, how many usable. */
function renderProxyCheck(check) {
  if (!check) return null;
  const box = document.createElement('div');
  box.style.cssText =
    'margin-bottom:0.6rem;padding:0.5rem 0.7rem;border:1px solid var(--border);' +
    'border-radius:8px;font-size:0.8rem;background:var(--bg);';

  if (check.error) {
    box.style.color = 'var(--error)';
    box.textContent = `Proxy check failed: ${check.error}`;
    return box;
  }

  const secs = check.elapsedMs ? ` in ${(check.elapsedMs / 1000).toFixed(0)}s` : '';
  const head = document.createElement('div');
  head.innerHTML =
    `Proxy check — probed <strong>${check.checked}</strong> of ${check.listSize}${secs}, ` +
    `<strong>${check.working}</strong> usable`;
  head.style.color = check.working > 0 ? 'var(--success, #1a8a4a)' : 'var(--error)';
  box.appendChild(head);

  if (check.working === 0) {
    const warn = document.createElement('div');
    warn.style.cssText = 'color:var(--error);margin-top:0.25rem;';
    warn.textContent = 'No usable proxy — this run went out on your own IP, unrotated.';
    box.appendChild(warn);
  } else {
    for (const p of check.proxies) {
      const line = document.createElement('div');
      line.style.color = 'var(--muted)';
      // Unverified means the echo service was unreachable through that proxy,
      // so this is its own address rather than a confirmed exit.
      // The network matters more than the city: Craigslist blocks by ASN, so
      // an ISP name is a good sign and a hosting one is not.
      line.innerHTML =
        `<code>${escapeHtml(p.ip)}</code> — ${escapeHtml(p.location || 'Unknown')}` +
        (p.org ? ` · ${escapeHtml(p.org.replace(/^AS\d+\s*/, ''))}` : '') +
        (p.ipVerified === false ? ' <span title="Proxy address; exit IP not confirmed">(unconfirmed)</span>' : '');
      box.appendChild(line);
    }
  }
  return box;
}

function renderExitSummary(results) {
  const byIp = new Map();
  for (const r of results) {
    const ip = r.exit?.ip;
    if (!ip) continue;
    if (!byIp.has(ip)) byIp.set(ip, { ...r.exit, count: 0 });
    byIp.get(ip).count += 1;
  }

  const box = document.createElement('div');
  box.style.cssText =
    'margin-bottom:0.6rem;padding:0.5rem 0.7rem;border:1px solid var(--border);' +
    'border-radius:8px;font-size:0.8rem;background:var(--bg);';

  if (byIp.size === 0) {
    box.style.color = 'var(--muted)';
    box.textContent = 'No exit IP recorded for this run.';
    return box;
  }

  const anyDirect = [...byIp.values()].some((e) => e.direct);
  const head = document.createElement('div');
  head.style.cssText = 'color:var(--muted);margin-bottom:0.35rem;';
  head.textContent = `Exit IPs used — ${byIp.size} address${byIp.size === 1 ? '' : 'es'} across ${results.length} row${results.length === 1 ? '' : 's'}`;
  box.appendChild(head);

  for (const e of byIp.values()) {
    const line = document.createElement('div');
    line.innerHTML =
      `<code>${escapeHtml(e.ip)}</code> — ${escapeHtml(e.location || 'Unknown')} ` +
      `<span style="color:var(--muted)">(${e.count} post${e.count === 1 ? '' : 's'})</span>` +
      (e.direct
        ? ' <span style="color:var(--error)">direct — no proxy</span>'
        : ` <span style="color:var(--muted)">via ${escapeHtml(e.server || '')}</span>`);
    box.appendChild(line);
  }

  if (anyDirect) {
    const warn = document.createElement('div');
    warn.style.cssText = 'color:var(--error);margin-top:0.35rem;';
    warn.textContent =
      'Some rows went out on the direct connection — no working proxy was available, so those were not rotated.';
    box.appendChild(warn);
  }
  return box;
}

function cell(row, html, opts = {}) {
  const td = document.createElement('td');
  td.innerHTML = html;
  if (opts.muted) td.style.color = 'var(--muted)';
  if (opts.title) td.title = opts.title;
  td.style.padding = '0.5rem 0.6rem';
  td.style.borderTop = '1px solid var(--border)';
  td.style.verticalAlign = 'top';
  row.appendChild(td);
  return td;
}

let lastResults = [];
let lastProxyCheck = null;
let lastProgress = null;
// Non-null while the table is showing the saved store rather than this run's
// rows. A poll must not redraw over it — the user asked to look at something
// else, and having it vanish two seconds later would be its own bug.
let savedView = null;

/**
 * Lists the saved store in the results table.
 *
 * The rows are shaped exactly like scraped ones, so the existing renderer,
 * the tick boxes, the drafted filter and Create Drafts all work unchanged —
 * a saved address is a recipient like any other.
 */
async function showSavedContacts(kind) {
  researchErrorsEl.textContent = '';
  try {
    const res = await fetch(`/api/research/contacts/${kind}`);
    if (!res.ok) throw new Error((await res.json()).error ?? 'Could not read the saved contacts.');
    const data = await res.json();

    const rows = (data.entries ?? []).map((e) => ({
      success: true,
      url: e.url,
      name: e.name,
      area: e.area,
      postedAt: e.postedAt,
      contacts: kind === 'emails'
        ? { emails: [e.value], phones: [] }
        : { emails: [], phones: [e.value] },
    }));

    savedView = { kind, count: rows.length };
    renderResearchResults(rows, null, null);
  } catch (err) {
    researchErrorsEl.textContent = err.message;
  }
}

function exitSavedView() {
  savedView = null;
  renderResearchResults(lastResults, lastProxyCheck, lastProgress);
}

function renderResearchResults(results, proxyCheck, progress = null) {
  // Only the live run is cached — caching the saved view here would make
  // "back to results" restore the very thing you were leaving.
  if (!savedView) {
    lastResults = results;
    lastProxyCheck = proxyCheck;
    lastProgress = progress;
  }
  researchResultsEl.innerHTML = '';

  if (savedView) {
    const banner = document.createElement('div');
    banner.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;gap:0.75rem;' +
      'margin-bottom:0.6rem;padding:0.5rem 0.7rem;border:1px solid var(--accent);' +
      'border-radius:8px;font-size:0.82rem;background:var(--bg);';
    const what = savedView.kind === 'emails' ? 'saved email addresses' : 'saved phone numbers';
    const text = document.createElement('span');
    text.innerHTML = `Showing <strong>${savedView.count}</strong> ${escapeHtml(what)} from disk.`;
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'secondary';
    back.textContent = 'Back to results';
    back.style.color = 'var(--accent)';
    back.addEventListener('click', exitSavedView);
    banner.append(text, back);
    researchResultsEl.appendChild(banner);
  }

  const checkBox = renderProxyCheck(proxyCheck);
  if (checkBox) researchResultsEl.appendChild(checkBox);

  const bar = renderProgress(progress);
  if (bar) researchResultsEl.appendChild(bar);

  // Only listings that can actually be contacted. A row with neither an email
  // nor a phone has nothing to act on, and this table is the recipient list
  // now — not a log of everything the scrape touched.
  const contactable = results.filter(
    (r) =>
      r.success &&
      // Drafted rows leave the list: their addresses have been written to, and
      // leaving them in invites a second draft to the same person.
      !isFullyDrafted(r) &&
      (remainingEmails(r).length > 0 || (r.contacts?.phones?.length ?? 0) > 0)
  );

  const skipped = results.length - contactable.length;
  const note = document.createElement('div');
  note.style.cssText = 'font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem;';
  if (savedView) {
    const noLink = contactable.filter((r) => !r.url).length;
    note.textContent = `${contactable.length} row${contactable.length === 1 ? '' : 's'}` +
      (skipped ? ` · ${skipped} already drafted, hidden` : '') +
      (noLink ? ` · ${noLink} saved before links were recorded` : '');
  } else {
    note.textContent = contactable.length
      ? `${contactable.length} contactable listing${contactable.length === 1 ? '' : 's'}` +
        (skipped ? ` · ${skipped} without contact details, hidden` : '')
      : `No contactable listings${skipped ? ` — ${skipped} had no contact details` : ''}.`;
  }
  researchResultsEl.appendChild(note);

  // The exit readout describes a run; it means nothing for rows read off disk.
  if (!savedView) researchResultsEl.appendChild(renderExitSummary(results));
  if (contactable.length === 0) {
    updateRecipientSummary();
    return;
  }

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;min-width:560px;border-collapse:collapse;font-size:0.85rem;';

  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  for (const label of ['', 'Email', 'Phone', 'Posted', 'Link']) {
    const th = document.createElement('th');
    th.textContent = label;
    th.style.cssText =
      'text-align:left;padding:0.5rem 0.6rem;font-size:0.75rem;text-transform:uppercase;' +
      'letter-spacing:0.04em;color:var(--muted);border-bottom:1px solid var(--border);white-space:nowrap;';
    hrow.appendChild(th);
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const item of contactable) {
    // Drafted addresses are dropped from the row, not just from the run: a row
    // that still has a second address stays, showing only what's left to write.
    const emails = remainingEmails(item);
    const phones = item.contacts?.phones ?? [];
    const row = document.createElement('tr');

    // Tick box drives the recipient list. Rows with no email are shown for
    // their phone number but can't be written to, so the box is disabled.
    const pick = document.createElement('td');
    pick.style.cssText = 'padding:0.5rem 0.6rem;border-top:1px solid var(--border);vertical-align:top;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    // Default on, unless this row was deliberately unticked earlier — a
    // redraw must not re-select something the user removed.
    cb.checked = emails.length > 0 && !emails.some((e) => untickedEmails.has(e.toLowerCase()));
    cb.disabled = emails.length === 0;
    cb.dataset.emails = emails.join(',');
    cb.title = item.name || '';
    cb.addEventListener('change', () => {
      for (const e of emails) {
        if (cb.checked) untickedEmails.delete(e.toLowerCase());
        else untickedEmails.add(e.toLowerCase());
      }
      updateRecipientSummary();
    });
    pick.appendChild(cb);
    row.appendChild(pick);

    cell(row,
      emails.length
        ? emails.map((e) =>
            `<a href="${safeUrl(item.url)}" target="_blank" rel="noopener" title="${escapeHtml(item.name || '')}"` +
            ` style="color:var(--accent);text-decoration:none;">${escapeHtml(e)}</a>`
          ).join('<br>')
        : '—',
      { muted: emails.length === 0 }
    );

    cell(row, phones.length ? phones.map(escapeHtml).join('<br>') : '—', { muted: phones.length === 0 });

    const posted = formatPosted(item.postedAt);
    cell(row, escapeHtml(posted.text), { muted: !item.postedAt, title: posted.title });

    // The listing itself. Saved contacts recorded before provenance existed
    // have no url — those show a dash rather than a link to nowhere.
    const href = safeUrl(item.url);
    cell(
      row,
      item.url && href !== '#'
        ? `<a href="${href}" target="_blank" rel="noopener"` +
          ` style="color:var(--accent);text-decoration:underline;">link</a>`
        : '—',
      { muted: !item.url, title: item.name || '' }
    );

    tbody.appendChild(row);
  }
  table.appendChild(tbody);

  const wrap = document.createElement('div');
  wrap.style.cssText = 'overflow-x:auto;border:1px solid var(--border);border-radius:8px;';
  wrap.appendChild(table);
  researchResultsEl.appendChild(wrap);

  updateRecipientSummary();
}

// The table is rebuilt on every poll while a scrape streams in, so tick state
// and already-drafted rows have to live outside it — otherwise a redraw two
// seconds later would silently undo the user's selection.
const untickedEmails = new Set();
const draftedEmails = new Set();

/** A row's addresses minus any that already became a draft. */
function remainingEmails(item) {
  return (item?.contacts?.emails ?? []).filter((e) => !draftedEmails.has(e.toLowerCase()));
}

/**
 * True once every address on the row has been written to.
 *
 * Per address rather than per row: when one of a row's two addresses drafted
 * and the other failed, treating the row as undrafted put the successful one
 * back on screen, ticked, ready to be drafted a second time.
 */
function isFullyDrafted(item) {
  const all = item?.contacts?.emails ?? [];
  return all.length > 0 && remainingEmails(item).length === 0;
}

/** Progress line for a run that is still going, or its final tally. */
function renderProgress(p) {
  if (!p) return null;
  const el = document.createElement('div');
  el.style.cssText =
    'margin-bottom:0.6rem;padding:0.5rem 0.7rem;border:1px solid var(--border);' +
    'border-radius:8px;font-size:0.8rem;background:var(--bg);';
  const secs = Math.round((p.elapsedMs ?? 0) / 1000);
  const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;

  // There is no total to count towards any more — the run cycles until it is
  // stopped, so elapsed time and throughput are the only honest figures.
  if (p.status === 'running') {
    el.innerHTML =
      `<strong>Running…</strong> ${p.completed} contact row${p.completed === 1 ? '' : 's'} · ${time}` +
      (p.label ? ` · <span style="color:var(--muted)">${escapeHtml(p.label)}</span>` : '');
  } else {
    el.style.color = 'var(--muted)';
    el.innerHTML =
      `<strong>${p.status === 'failed' ? 'Failed' : 'Stopped'}</strong> — ` +
      `${p.completed} contact row${p.completed === 1 ? '' : 's'} in ${time}. Everything found is saved.`;
  }
  return el;
}

/** Every address ticked in the table — this is the recipient list. */
function selectedRecipients() {
  const out = [];
  for (const cb of researchResultsEl.querySelectorAll('input[type="checkbox"]:checked')) {
    for (const e of (cb.dataset.emails || '').split(',').filter(Boolean)) {
      if (!out.some((x) => x.toLowerCase() === e.toLowerCase())) out.push(e);
    }
  }
  return out;
}

function updateRecipientSummary() {
  const el = document.getElementById('recipient-summary');
  if (!el) return;
  const n = selectedRecipients().length;
  el.textContent = n
    ? `${n} address${n === 1 ? '' : 'es'} selected from the table below.`
    : 'Scrape below, then tick the rows you want. Selected addresses become the recipients.';
  el.style.color = n ? 'var(--success, #1a8a4a)' : 'var(--muted)';
}

// ── Modal open/close ─────────────────────────────────────────────
function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Scraped hrefs are third-party data — escaping alone wouldn't stop a
// `javascript:` URL, so only let http(s) through.
function safeUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:' ? escapeHtml(u.href) : '#';
  } catch {
    return '#';
  }
}

/**
 * Seeds the drafted set from disk.
 *
 * Without this the filter was browser memory only, so reloading the page put
 * every already-drafted row back in the table, ticked and ready to be sent a
 * second time.
 */
async function loadContactStore() {
  try {
    const res = await fetch('/api/research/contacts');
    if (!res.ok) return;
    const data = await res.json();
    for (const e of data.drafted ?? []) draftedEmails.add(String(e).toLowerCase());
    lastContactCounts = { pending: data.pending, drafted: data.drafted?.length ?? 0, phones: data.phones };
    renderLiveStatus(null);
  } catch {
    // A missing store is not an error — it just means nothing scraped yet.
  }
}

loadAccounts();
// Drawn empty at load so the column reads as "nothing running yet" rather
// than as a panel that failed to appear.
renderLiveStatus(null);
loadContactStore();
renderAreaList();
loadCategories();
