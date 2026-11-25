'use strict';

const { google } = require('googleapis');
const googleOauth = require('../oauth/google');

// RFC 2047: a header with non-ASCII text (an em dash, an accent) as base64 UTF-8.
function encodeHeader(value) {
  const v = String(value || '').replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function buildRaw({ from, to, subject, bodyHtml }) {
  const lines = [
    `From: ${from}`,
    `To: ${String(to).replace(/[\r\n]+/g, '')}`,
    `Subject: ${encodeHeader(subject)}`,
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

async function api(account) {
  const auth = await googleOauth.authorizedClient(account);
  return google.gmail({ version: 'v1', auth });
}

// Creates a draft only; nothing here sends mail.
async function createDraft(account, { to, subject, bodyHtml }) {
  const gmail = await api(account);
  const raw = buildRaw({ from: account.emailAddress, to, subject, bodyHtml });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });
  return { draftId: res.data.id, messageId: res.data.message?.id || null };
}

// Every draft in the account's Drafts folder: Map draftId -> { messageId }.
// Read-only; works with the gmail.compose scope the account was connected with.
async function listDrafts(account) {
  const gmail = await api(account);
  const present = new Map();
  let pageToken;
  do {
    const res = await gmail.users.drafts.list({ userId: 'me', maxResults: 500, pageToken });
    for (const d of res.data.drafts || []) present.set(d.id, { messageId: d.message?.id || null });
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return present;
}

// Opens the draft in Gmail's compose window, in that account's mailbox.
function draftLink(account, entry) {
  const box = `https://mail.google.com/mail/u/${encodeURIComponent(account.emailAddress)}/`;
  return entry.messageId ? `${box}#drafts?compose=${entry.messageId}` : `${box}#drafts`;
}

module.exports = { createDraft, listDrafts, draftLink };
