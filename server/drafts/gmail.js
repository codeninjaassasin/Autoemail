'use strict';

const { google } = require('googleapis');
const googleOauth = require('../oauth/google');

function buildRaw({ from, to, subject, bodyHtml }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    '',
    bodyHtml,
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function createDraft(account, { to, subject, bodyHtml }) {
  const auth = await googleOauth.authorizedClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = buildRaw({ from: account.emailAddress, to, subject, bodyHtml });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });
  return res.data.id;
}

module.exports = { createDraft };
