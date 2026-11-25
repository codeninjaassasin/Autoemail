'use strict';

const microsoftOauth = require('../oauth/microsoft');

async function token(account) {
  const t = await microsoftOauth.accessToken(account);
  if (!t) throw new Error('No Microsoft access token — reconnect the account.');
  return t;
}

// Creates a draft only; nothing here sends mail.
async function createDraft(account, { to, subject, bodyHtml }) {
  const res = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await token(account)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subject,
      body: { contentType: 'HTML', content: bodyHtml },
      toRecipients: [{ emailAddress: { address: to } }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph draft create failed (${res.status}): ${text}`);
  }
  const data = await res.json();
  return { draftId: data.id, webLink: data.webLink || null };
}

// Every message in the Drafts folder: Map id -> { webLink }. Read-only.
async function listDrafts(account) {
  const auth = `Bearer ${await token(account)}`;
  const present = new Map();
  let url = 'https://graph.microsoft.com/v1.0/me/mailFolders/drafts/messages?$select=id,webLink&$top=100';
  while (url) {
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) throw new Error(`Graph drafts list failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    for (const m of data.value || []) present.set(m.id, { webLink: m.webLink || null });
    url = data['@odata.nextLink'] || null;
  }
  return present;
}

function draftLink(account, entry) {
  return entry.webLink || 'https://outlook.live.com/mail/0/drafts';
}

module.exports = { createDraft, listDrafts, draftLink };
