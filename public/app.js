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
const researchModalEl = document.getElementById('research-modal');
const researchModalBodyEl = document.getElementById('research-modal-body');
const researchModalCloseEl = document.getElementById('research-modal-close');

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
const areaCategoryEl = document.getElementById('area-category');

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
  researchErrorsEl.textContent = '';
  researchResultsEl.innerHTML  = '';

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
        areas:    Array.from(selectedAreas),
        category: areaCategoryEl.value,
      }),
    });
    const data = await res.json();
    renderResearchResults(
      data.results ?? [{ success: false, error: data.error ?? 'Unknown error' }]
    );
  } catch (err) {
    renderResearchResults([{ success: false, error: err.message }]);
  } finally {
    researchSubmitBtn.disabled    = false;
    researchSubmitBtn.textContent = 'Start Scraping';
  }
});

// ── Result rendering ─────────────────────────────────────────────
function renderResearchResults(results) {
  researchResultsEl.innerHTML  = '';
  researchModalBodyEl.innerHTML = '';

  for (const item of results) {
    // Summary row
    const row = document.createElement('div');
    row.className = `result-row ${item.success ? 'success' : 'error'}`;
    row.textContent = item.success
      ? `✓ [${item.area}] ${item.name ?? '(untitled)'} — email: ${item.contacts?.email ?? 'N/A'}`
      : `✗ ${item.url ?? item.area ?? '?'} — ${item.error}`;
    researchResultsEl.appendChild(row);

    // Modal card
    const card = document.createElement('div');
    card.className = 'modal-card';
    if (item.success) {
      const { email = '—', call = '—', message = '—' } = item.contacts ?? {};
      card.innerHTML = `
        <h4>${escapeHtml(item.name ?? '(untitled)')}</h4>
        <div class="modal-meta">
          <strong>Area:</strong> ${escapeHtml(item.area || '—')}<br>
          <strong>URL:</strong> <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener">${escapeHtml(item.url)}</a><br>
          <strong>Email:</strong> ${escapeHtml(email)}<br>
          <strong>Call:</strong> ${escapeHtml(call)}<br>
          <strong>Message:</strong> ${escapeHtml(message)}
        </div>`;
    } else {
      card.innerHTML = `
        <h4 style="color:var(--error)">Error</h4>
        <div class="modal-meta">
          ${item.url ? `<strong>URL:</strong> ${escapeHtml(item.url)}<br>` : ''}
          ${item.area ? `<strong>Area:</strong> ${escapeHtml(item.area)}<br>` : ''}
          ${escapeHtml(item.error ?? 'Unknown error')}
        </div>`;
    }
    researchModalBodyEl.appendChild(card);
  }

  if (results.length > 0) openResearchModal();
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

function openResearchModal() {
  researchModalEl.classList.add('open');
  researchModalEl.setAttribute('aria-hidden', 'false');
}
function closeResearchModal() {
  researchModalEl.classList.remove('open');
  researchModalEl.setAttribute('aria-hidden', 'true');
}
researchModalCloseEl.addEventListener('click', closeResearchModal);
researchModalEl.addEventListener('click', (e) => { if (e.target === researchModalEl) closeResearchModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeResearchModal(); });

loadAccounts();
