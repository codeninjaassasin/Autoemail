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
const researchResultsEl = document.getElementById('research-results');

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

function parseRecipients(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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

  const recipients = parseRecipients(document.getElementById('recipients').value);
  const invalid = recipients.filter((r) => !EMAIL_RE.test(r));
  if (invalid.length > 0) {
    recipientErrorsEl.textContent = `Invalid address${invalid.length > 1 ? 'es' : ''}: ${invalid.join(', ')}`;
    return;
  }
  if (recipients.length === 0) {
    recipientErrorsEl.textContent = 'Enter at least one recipient.';
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
    renderResults(data.results || [{ recipient: '(request)', success: false, error: data.error || 'Unknown error' }]);
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

// ── Area tag management ──────────────────────────────────────────
const areaTagsEl     = document.getElementById('area-tags');
const areaInputEl    = document.getElementById('area-input');
const areaAddBtnEl   = document.getElementById('area-add-btn');

const selectedAreas = new Set();

function addArea(raw) {
  // strip protocol/domain noise if someone pastes a full URL
  const area = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\.craigslist\.org.*/, '');
  if (!area) return;
  selectedAreas.add(area);
  renderAreaTags();
  areaInputEl.value = '';
}

function removeArea(area) {
  selectedAreas.delete(area);
  renderAreaTags();
}

function renderAreaTags() {
  areaTagsEl.innerHTML = '';
  for (const area of selectedAreas) {
    const tag = document.createElement('span');
    tag.className = 'area-tag';
    tag.innerHTML = `${escapeHtml(area)} <button type="button" data-area="${escapeHtml(area)}" aria-label="Remove ${escapeHtml(area)}">×</button>`;
    tag.querySelector('button').addEventListener('click', () => removeArea(area));
    areaTagsEl.appendChild(tag);
  }
}

areaAddBtnEl.addEventListener('click', () => addArea(areaInputEl.value));
areaInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addArea(areaInputEl.value); }
});

// ── Research submit ──────────────────────────────────────────────
researchSubmitBtn.addEventListener('click', async () => {
  console.log('YES');
  researchErrorsEl.textContent  = '';
  researchResultsEl.innerHTML   = '';
  researchHarvestEl.textContent = '';

  if (selectedAreas.size === 0) {
    researchErrorsEl.textContent = 'Add at least one area.';
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
        // No category: the server walks every top-level section.
        category: 'all',
      }),
    });
    const data = await res.json();
    const results = data.results ?? [{ success: false, error: data.error ?? 'Unknown error' }];
    renderResearchResults(results, data.proxyCheck);
    harvestEmails(results);
  } catch (err) {
    renderResearchResults([{ success: false, error: err.message }]);
  } finally {
    researchSubmitBtn.disabled    = false;
    researchSubmitBtn.textContent = 'Start Scraping';
  }
});

// ── Harvest scraped addresses into the recipient list ────────────
const recipientsEl      = document.getElementById('recipients');
const researchHarvestEl = document.getElementById('research-harvest');

/**
 * Appends every address the scrape found to the recipient box.
 *
 * Adding rather than replacing: the field is the user's own working list and
 * a scrape shouldn't wipe what they typed. Dedupe is case-insensitive and
 * covers both the existing contents and the scrape itself — the same employer
 * address turns up across several posts, and each duplicate would otherwise
 * become another draft to the same person.
 */
function harvestEmails(results) {
  const existing = parseRecipients(recipientsEl.value);
  const seen = new Set(existing.map((e) => e.toLowerCase()));

  const added = [];
  let duplicates = 0;

  for (const item of results) {
    for (const raw of item.contacts?.emails ?? []) {
      const email = String(raw).trim();
      // Extraction is heuristic, so anything malformed is dropped here rather
      // than left to fail one-by-one at draft time.
      if (!EMAIL_RE.test(email)) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) { duplicates += 1; continue; }
      seen.add(key);
      added.push(email);
    }
  }

  if (added.length > 0) {
    const prefix = existing.length > 0 ? `${existing.join('\n')}\n` : '';
    recipientsEl.value = prefix + added.join('\n');
  }

  renderHarvestSummary(added.length, duplicates, results);
}

function renderHarvestSummary(addedCount, duplicates, results) {
  const blocked = results.filter((r) => r.captchaBlocked).length;
  const parts = [];

  if (addedCount > 0) {
    parts.push(`Added ${addedCount} address${addedCount === 1 ? '' : 'es'} to the recipient list.`);
  } else {
    parts.push('No new addresses to add.');
  }
  if (duplicates > 0) parts.push(`${duplicates} already on the list.`);
  // A CAPTCHA means addresses exist but couldn't be read — distinct from a
  // listing that simply published no contact.
  if (blocked > 0) parts.push(`${blocked} blocked by CAPTCHA.`);

  researchHarvestEl.textContent = parts.join(' ');
  researchHarvestEl.style.color = addedCount > 0 ? 'var(--success, #2e7d32)' : 'var(--muted)';

  // The submit button is gated on having accounts connected, not recipients,
  // so nothing to re-enable here — but the list changed, so clear any stale
  // validation message sitting under it.
  if (addedCount > 0) recipientErrorsEl.textContent = '';
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

function renderResearchResults(results, proxyCheck) {
  researchResultsEl.innerHTML = '';

  const checkBox = renderProxyCheck(proxyCheck);
  if (checkBox) researchResultsEl.appendChild(checkBox);

  if (results.length === 0) return;

  const table = document.createElement('table');
  // Six columns squeeze the title into a narrow ribbon at panel width; a floor
  // keeps them readable and lets the wrapper scroll instead.
  table.style.cssText = 'width:100%;min-width:820px;border-collapse:collapse;font-size:0.85rem;';

  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  for (const label of ['Title', 'Recipient (mail)', 'Recipient (phone)', 'Posted', 'Exit IP', 'Location']) {
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
  for (const item of results) {
    const row = document.createElement('tr');

    if (!item.success) {
      // An area that failed outright has no per-post fields to line up under
      // the columns, so give it the full width rather than three empty cells.
      const td = cell(row, `✗ ${escapeHtml(item.area ?? item.url ?? '?')} — ${escapeHtml(item.error ?? 'Unknown error')}`);
      td.colSpan = 6;
      td.style.color = 'var(--error)';
      tbody.appendChild(row);
      continue;
    }

    const emails = item.contacts?.emails ?? [];
    const phones = item.contacts?.phones ?? [];
    // "Blocked" and "nothing published" both yield zero contacts but mean
    // opposite things — one is worth retrying, the other never will be.
    const emptyReason = item.captchaBlocked ? 'blocked by CAPTCHA' : 'none in ad text';

    cell(row,
      `<a href="${safeUrl(item.url)}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none;">` +
      `${escapeHtml(item.name ?? '(untitled)')}</a>` +
      `<div style="color:var(--muted);font-size:0.75rem;margin-top:0.15rem;">` +
      `${escapeHtml(item.area || '')}${item.categoryName ? ` · ${escapeHtml(item.categoryName)}` : ''}</div>`
    );

    cell(row,
      emails.length ? emails.map((e) => escapeHtml(e)).join('<br>') : emptyReason,
      { muted: emails.length === 0 }
    );

    cell(row,
      phones.length ? phones.map((p) => escapeHtml(p)).join('<br>') : '—',
      { muted: phones.length === 0 }
    );

    const posted = formatPosted(item.postedAt);
    cell(row, escapeHtml(posted.text), { muted: !item.postedAt, title: posted.title });

    // Sessions rotate mid-run, so this is per-row rather than per-run. A
    // direct row is called out: it means no rotation happened for that post.
    const exit = item.exit;
    cell(row,
      exit?.ip ? escapeHtml(exit.ip) + (exit.direct ? ' <span style="color:var(--error)">(direct)</span>' : '') : '—',
      { muted: !exit?.ip, title: exit?.server || (exit?.direct ? 'No proxy — direct connection' : '') }
    );
    cell(row, escapeHtml(exit?.location ?? '—'), { muted: !exit?.location });

    tbody.appendChild(row);
  }

  table.appendChild(tbody);

  researchResultsEl.appendChild(renderExitSummary(results));

  // Table can outgrow the panel on narrow windows; scroll it rather than the
  // page.
  const wrap = document.createElement('div');
  wrap.style.cssText = 'overflow-x:auto;border:1px solid var(--border);border-radius:8px;';
  wrap.appendChild(table);
  researchResultsEl.appendChild(wrap);
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

loadAccounts();
