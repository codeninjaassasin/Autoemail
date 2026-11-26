'use strict';

const { google } = require('googleapis');
const googleOauth = require('../oauth/google');

// RFC 2047: a header with non-ASCII text (an em dash, an accent) as base64 UTF-8.
function encodeHeader(value) {
  const v = String(value || '').replace(/[\r\n]+/g, ' ');
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function b64Lines(text) {
  return Buffer.from(String(text || ''), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
}

// multipart/alternative: the plain text (line for line as the template) and the
// HTML Gmail's editor opens. Both base64, so any text survives unchanged.
function buildRaw({ from, to, subject, bodyHtml, bodyText }) {
  const boundary = `=_ae_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const head = [
    `From: ${from}`,
    `To: ${String(to).replace(/[\r\n]+/g, '')}`,
    `Subject: ${encodeHeader(subject)}`,
    'MIME-Version: 1.0',
  ];
  const lines =
    bodyText == null
      ? [...head, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64Lines(bodyHtml)]
      : [
          ...head,
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          b64Lines(String(bodyText).replace(/\r?\n/g, '\r\n')),
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          b64Lines(bodyHtml),
          `--${boundary}--`,
          '',
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
async function createDraft(account, { to, subject, bodyHtml, bodyText }) {
  const gmail = await api(account);
  const raw = buildRaw({ from: account.emailAddress, to, subject, bodyHtml, bodyText });
  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });
  return { draftId: res.data.id, messageId: res.data.message?.id || null, threadId: res.data.message?.threadId || null };
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

// --- Replies (needs the gmail.metadata scope: headers only, no bodies) ---
const METADATA = 'https://www.googleapis.com/auth/gmail.metadata';
function canReadReplies(account) {
  return String(account.tokens?.scope || '').split(/\s+/).includes(METADATA);
}

function header(msg, name) {
  const h = (msg.payload?.headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}
function shape(msg) {
  return {
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds || [],
    from: header(msg, 'From'),
    subject: header(msg, 'Subject'),
    at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
    snippet: msg.snippet || '',
  };
}
const META = { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] };

// The mailbox's current history id: replies are looked for after it.
async function historyId(account) {
  const gmail = await api(account);
  return (await gmail.users.getProfile({ userId: 'me' })).data.historyId;
}

// Messages added since `startHistoryId`: { historyId, added: [{ id, threadId }] }.
// A 404 means the id is too old (about a week); the caller starts over.
async function historySince(account, startHistoryId) {
  const gmail = await api(account);
  const added = [];
  let pageToken;
  let latest = startHistoryId;
  do {
    const res = await gmail.users.history.list({ userId: 'me', startHistoryId, historyTypes: ['messageAdded'], maxResults: 500, pageToken });
    for (const h of res.data.history || [])
      for (const m of h.messagesAdded || []) added.push({ id: m.message.id, threadId: m.message.threadId });
    latest = res.data.historyId || latest;
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return { historyId: latest, added };
}

async function getMessage(account, id) {
  const gmail = await api(account);
  return shape((await gmail.users.messages.get({ userId: 'me', id, ...META })).data);
}

async function threadMessages(account, threadId) {
  const gmail = await api(account);
  return ((await gmail.users.threads.get({ userId: 'me', id: threadId, ...META })).data.messages || []).map(shape);
}

module.exports = { createDraft, listDrafts, draftLink, buildRaw, canReadReplies, historyId, historySince, getMessage, threadMessages };
