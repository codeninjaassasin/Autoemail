'use strict';

const microsoftOauth = require('../oauth/microsoft');

async function createDraft(account, { to, subject, bodyHtml }) {
  const token = await microsoftOauth.accessToken(account);
  if (!token) throw new Error('No Microsoft access token — reconnect the account.');

  const res = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
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
  return data.id;
}

module.exports = { createDraft };
