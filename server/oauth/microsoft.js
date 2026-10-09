'use strict';

const { ConfidentialClientApplication } = require('@azure/msal-node');
const config = require('../config');
const accounts = require('../accounts');

let cca;
function app() {
  if (!cca) {
    cca = new ConfidentialClientApplication({
      auth: {
        clientId: config.microsoft.clientId,
        clientSecret: config.microsoft.clientSecret,
        authority: config.microsoft.authority,
      },
    });
  }
  return cca;
}

async function authUrl(state) {
  return app().getAuthCodeUrl({
    scopes: config.microsoft.scope,
    redirectUri: config.microsoft.redirectUri,
    state,
    prompt: 'select_account',
  });
}

async function handleCallback(code) {
  const result = await app().acquireTokenByCode({
    code,
    scopes: config.microsoft.scope,
    redirectUri: config.microsoft.redirectUri,
  });

  const emailAddress =
    result.account.username || result.account.idTokenClaims?.email || result.account.name;

  return accounts.upsert({
    provider: 'microsoft',
    emailAddress,
    homeAccountId: result.account.homeAccountId,
    tokens: {
      accessToken: result.accessToken,
      expiresOn: result.expiresOn,
    },
  });
}

// MSAL silent flow via the persisted account in its token cache. Falls back to
// the last access token if the cache lookup misses.
async function accessToken(account) {
  try {
    const msalAccount = await app()
      .getTokenCache()
      .getAccountByHomeId(account.homeAccountId);
    if (msalAccount) {
      const result = await app().acquireTokenSilent({
        account: msalAccount,
        scopes: config.microsoft.scope,
      });
      accounts.update(account.id, {
        tokens: { accessToken: result.accessToken, expiresOn: result.expiresOn },
      });
      return result.accessToken;
    }
  } catch {
    // fall through
  }
  return account.tokens?.accessToken;
}

module.exports = { authUrl, handleCallback, accessToken };
