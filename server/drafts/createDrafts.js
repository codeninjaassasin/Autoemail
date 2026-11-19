'use strict';

const accounts = require('../accounts');
const gmail = require('./gmail');
const graph = require('./graph');

function parseRecipients(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// One draft per recipient, round-robin across the selected accounts.
async function createDrafts({ accountIds, subject, bodyHtml, recipients }) {
  const selected = accountIds
    .map((id) => accounts.get(id))
    .filter(Boolean);

  if (selected.length === 0) throw new Error('No connected accounts selected.');
  const list = parseRecipients(recipients);
  if (list.length === 0) throw new Error('No recipients provided.');

  const results = [];
  for (let i = 0; i < list.length; i++) {
    const to = list[i];
    const account = selected[i % selected.length];
    try {
      const create = account.provider === 'google' ? gmail.createDraft : graph.createDraft;
      const draftId = await create(account, { to, subject, bodyHtml });
      results.push({ to, account: account.emailAddress, ok: true, draftId });
    } catch (err) {
      results.push({ to, account: account.emailAddress, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { createDrafts, parseRecipients };
