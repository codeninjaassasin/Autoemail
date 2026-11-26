'use strict';

const gmail = require('./gmail');
const graph = require('./graph');
const log = require('./log');

// One draft in one account, logged for the reminder. Drafts only: nothing here sends.
async function createOne(account, { to, subject, bodyHtml, bodyText, templateId = null, contactId = null }) {
  const create = account.provider === 'google' ? gmail.createDraft : graph.createDraft;
  const draft = await create(account, { to, subject, bodyHtml, bodyText });
  const entry = { accountId: account.id, provider: account.provider, to, subject, templateId, ...draft };
  if (contactId) entry.contactId = contactId;
  return log.add([entry])[0];
}

module.exports = { createOne };
