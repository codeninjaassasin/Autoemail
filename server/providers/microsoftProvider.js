const { ConfidentialClientApplication } = require('@azure/msal-node');
const config = require('../config');
const store = require('../store');

const SCOPES = ['Mail.ReadWrite'];

function createMsalClient() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.microsoft.clientId,
      authority: config.microsoft.authority,
      clientSecret: config.microsoft.clientSecret,
    },
  });
}

/**
 * Returns a fresh access token for the given account, refreshing and
 * persisting it first if it's expired or about to expire.
 */
async function getValidAccessToken(accountId) {
  const account = store.getAccount(accountId);
  if (!account) throw new Error('Account not found');

  const needsRefresh = !account.expiresAt || account.expiresAt - Date.now() < 60_000;
  if (!needsRefresh) return account.accessToken;

  const client = createMsalClient();
  const result = await client.acquireTokenByRefreshToken({
    refreshToken: account.refreshToken,
    scopes: SCOPES,
  });

  const patch = { accessToken: result.accessToken, expiresAt: result.expiresOn.getTime() };
  // msal-node doesn't return a new refresh token from this call; the original stays valid.
  store.updateAccount(accountId, patch);
  return result.accessToken;
}

async function createDraft({ accountId, to, subject, bodyHtml }) {
  const accessToken = await getValidAccessToken(accountId);

  const response = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      subject,
      body: { contentType: 'HTML', content: bodyHtml },
      toRecipients: [{ emailAddress: { address: to } }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Graph API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return { draftId: data.id };
}

module.exports = { createMsalClient, getValidAccessToken, createDraft };
