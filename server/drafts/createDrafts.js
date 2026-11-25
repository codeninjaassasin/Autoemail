'use strict';

const accounts = require('../accounts');
const gmail = require('./gmail');
const graph = require('./graph');
const log = require('./log');

function parseRecipients(raw) {
  return String(raw || '')
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// One draft per recipient, round-robin across the selected accounts.
// Drafts only: nothing is ever sent. Each draft is logged for the reminder.
async function createDrafts({ accountIds, subject, bodyHtml, recipients, templateId }) {
  const selected = (Array.isArray(accountIds) ? accountIds : [])
    .map((id) => accounts.get(id))
    .filter(Boolean);

  if (selected.length === 0) throw new Error('No connected accounts selected.');
  const list = parseRecipients(recipients);
  if (list.length === 0) throw new Error('No recipients provided.');

  const results = [];
  const made = [];
  for (let i = 0; i < list.length; i++) {
    const to = list[i];
    const account = selected[i % selected.length];
    try {
      const create = account.provider === 'google' ? gmail.createDraft : graph.createDraft;
      const draft = await create(account, { to, subject, bodyHtml });
      made.push({ accountId: account.id, provider: account.provider, to, subject, templateId: templateId || null, ...draft });
      results.push({ to, account: account.emailAddress, ok: true, draftId: draft.draftId });
    } catch (err) {
      results.push({ to, account: account.emailAddress, ok: false, error: err.message });
    }
  }
  log.add(made);
  return results;
}

module.exports = { createDrafts, parseRecipients };
