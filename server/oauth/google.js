'use strict';

const { google } = require('googleapis');
const config = require('../config');
const accounts = require('../accounts');

function client() {
  return new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri
  );
}

function authUrl(state) {
  return client().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: config.google.scope,
    state,
  });
}

async function handleCallback(code) {
  const oauth = client();
  const { tokens } = await oauth.getToken(code);
  oauth.setCredentials(tokens);

  // The address comes from Gmail's own profile: the gmail.compose scope allows
  // it, while the userinfo endpoint would need an extra email scope (401).
  const profile = await google.gmail({ version: 'v1', auth: oauth }).users.getProfile({ userId: 'me' });
  const emailAddress = profile.data.emailAddress;
  if (!emailAddress) throw new Error('Google did not return the account address.');

  return accounts.upsert({
    provider: 'google',
    emailAddress,
    tokens,
  });
}

// Returns an authorized OAuth2 client, persisting refreshed tokens.
async function authorizedClient(account) {
  const oauth = client();
  oauth.setCredentials(account.tokens);
  oauth.on('tokens', (t) => {
    const merged = { ...account.tokens, ...t };
    accounts.update(account.id, { tokens: merged });
  });
  return oauth;
}

module.exports = { authUrl, handleCallback, authorizedClient };
