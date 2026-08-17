const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
const config = require('../config');
const store = require('../store');
const { createOAuthClient } = require('../providers/googleProvider');

const router = express.Router();
const pendingStates = new Set();

router.get('/connect', (req, res) => {
  const state = crypto.randomUUID();
  pendingStates.add(state);

  const client = createOAuthClient();
  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [config.google.scope],
    state,
  });

  res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) return res.status(400).send(`Google OAuth error: ${error}`);
  if (!state || !pendingStates.has(state)) return res.status(400).send('Invalid or expired OAuth state.');
  pendingStates.delete(state);

  try {
    const client = createOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: client });
    const profile = await gmail.users.getProfile({ userId: 'me' });

    store.addAccount({
      id: crypto.randomUUID(),
      provider: 'google',
      emailAddress: profile.data.emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date,
      scope: tokens.scope,
    });

    res.redirect('/');
  } catch (err) {
    console.error('Google OAuth callback failed:', err);
    res.status(500).send('Failed to connect Google account. Check server logs for details.');
  }
});

module.exports = router;
