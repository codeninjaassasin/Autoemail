const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const store = require('../store');
const { createMsalClient } = require('../providers/microsoftProvider');

const router = express.Router();
const pendingStates = new Set();
const SCOPES = ['Mail.ReadWrite', 'offline_access', 'User.Read'];

router.get('/connect', async (req, res) => {
  const state = crypto.randomUUID();
  pendingStates.add(state);

  const client = createMsalClient();
  const authUrl = await client.getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: config.microsoft.redirectUri,
    state,
  });

  res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) return res.status(400).send(`Microsoft OAuth error: ${error} - ${errorDescription || ''}`);
  if (!state || !pendingStates.has(state)) return res.status(400).send('Invalid or expired OAuth state.');
  pendingStates.delete(state);

  try {
    const client = createMsalClient();
    const result = await client.acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: config.microsoft.redirectUri,
    });

    // msal-node manages the refresh token internally in its cache, but doesn't
    // expose it directly. We pull it back out of the cache so we can persist
    // it ourselves and refresh via microsoftProvider.getValidAccessToken later.
    const tokenCache = client.getTokenCache().serialize();
    const refreshToken = JSON.parse(tokenCache).RefreshToken
      ? Object.values(JSON.parse(tokenCache).RefreshToken)[0].secret
      : null;

    store.addAccount({
      id: crypto.randomUUID(),
      provider: 'microsoft',
      emailAddress: result.account.username,
      accessToken: result.accessToken,
      refreshToken,
      expiresAt: result.expiresOn.getTime(),
      scope: result.scopes.join(' '),
    });

    res.redirect('/');
  } catch (err) {
    console.error('Microsoft OAuth callback failed:', err);
    res.status(500).send('Failed to connect Microsoft account. Check server logs for details.');
  }
});

module.exports = router;
