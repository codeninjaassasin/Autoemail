const quill = new Quill('#editor', { theme: 'snow' });

const accountsListEl = document.getElementById('accounts-list');
const accountErrorsEl = document.getElementById('account-errors');
const submitBtn = document.getElementById('submit-btn');
const recipientErrorsEl = document.getElementById('recipient-errors');
const resultsEl = document.getElementById('results');
const form = document.getElementById('draft-form');

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

loadAccounts();
