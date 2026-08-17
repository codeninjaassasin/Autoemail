const { google } = require('googleapis');
const config = require('../config');
const store = require('../store');

function createOAuthClient() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

/**
 * Returns a fresh access token for the given account, refreshing and
 * persisting it first if it's expired or about to expire.
 */
async function getValidAccessToken(accountId) {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('Account not found');

  const client = createOAuthClient();
  client.setCredentials({
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expiry_date: account.expiresAt,
  });

  client.on('tokens', (tokens) => {
    const patch = { accessToken: tokens.access_token };
    if (tokens.expiry_date) patch.expiresAt = tokens.expiry_date;
    if (tokens.refresh_token) patch.refreshToken = tokens.refresh_token;
    store.updateAccount(accountId, patch);
  });

  const needsRefresh = !account.expiresAt || account.expiresAt - Date.now() < 60_000;
  if (needsRefresh) {
    const { credentials } = await client.refreshAccessToken();
    store.updateAccount(accountId, {
      accessToken: credentials.access_token,
      expiresAt: credentials.expiry_date,
    });
    return credentials.access_token;
  }

  return account.accessToken;
}

function buildMimeMessage({ to, subject, bodyHtml }) {
  const headers = [
    `To: ${to}`,
    `Subject: ${encodeSubject(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="UTF-8"',
  ].join('\r\n');
  return `${headers}\r\n\r\n${bodyHtml}`;
}

function encodeSubject(subject) {
  // Keep it simple/correct for non-ASCII subjects per RFC 2047.
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

async function createDraft({ accountId, to, subject, bodyHtml }) {
  const accessToken = await getValidAccessToken(accountId);
  const client = createOAuthClient();
  client.setCredentials({ access_token: accessToken });

  const gmail = google.gmail({ version: 'v1', auth: client });
  const raw = Buffer.from(buildMimeMessage({ to, subject, bodyHtml })).toString('base64url');

  const { data } = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message: { raw } },
  });

  return { draftId: data.id };
}

module.exports = { createOAuthClient, getValidAccessToken, createDraft };
