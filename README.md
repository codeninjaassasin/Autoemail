# Autoemail

Local app that connects to your Gmail and Outlook (personal) accounts and creates one email draft per recipient from a single Subject/Body/recipient-list form. Drafts are created, never sent.

Also includes a Craigslist contact scraper that collects reply-contact details from public listings.

## Setup

```
npm install
cp .env.example .env
```

The file must be named exactly `.env` — `dotenv` does not read `env.env`, `.env.local`, or anything else, and the app will start with empty credentials and fail only once you try to connect an account.

### Choose your port first

`PORT` in `.env` (default `3000`) determines the OAuth redirect URIs the app sends. Pick it **before** registering credentials, because the URIs you register below must match it exactly.

Throughout this guide, replace `<PORT>` with your actual value.

### Google (Gmail)

1. Create a project at https://console.cloud.google.com/.
2. **APIs & Services → Library** → enable "Gmail API".
3. **APIs & Services → OAuth consent screen**: User type "External"; add scope `https://www.googleapis.com/auth/gmail.compose`; add your own Gmail address as a test user.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**, type **Web application**. Add redirect URI `http://localhost:<PORT>/oauth/google/callback`.
5. Copy the Client ID/Secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### Microsoft (personal Outlook.com / Hotmail accounts)

1. https://portal.azure.com/ → **Microsoft Entra ID → App registrations → New registration**.
2. Supported account types: **"Personal Microsoft accounts only"**.
3. Redirect URI, platform **Web**: `http://localhost:<PORT>/oauth/microsoft/callback`.
4. **Certificates & secrets → New client secret** → copy into `.env` as `MICROSOFT_CLIENT_SECRET`. Copy the Application (client) ID as `MICROSOFT_CLIENT_ID`.
5. **API permissions → Add a permission → Microsoft Graph → Delegated → `Mail.ReadWrite`**.

You can connect only one provider if you want — the app warns about missing credentials at startup but still runs.

### Craigslist scraper (optional)

The scraper drives a real browser via Playwright, whose browser binaries are **not** installed by `npm install`:

```
npx playwright install chromium
```

Skip this if you only need the draft creator. Without it, "Start Scraping" fails at browser launch.

## Run

```
npm run dev
```

Open `http://localhost:<PORT>` (the startup log prints the exact URL), connect your accounts, and fill in the form. Recipients accept one address per line or comma-separated. Each recipient gets its own draft with the same subject/body, distributed round-robin across the checked accounts.

## Troubleshooting

**`Error 400: redirect_uri_mismatch`** — the redirect URI registered with the provider doesn't exactly match what the app sends. The app derives it from `PORT`, so changing `PORT` after registering will break OAuth. Print what the app is actually sending:

```
node -e "console.log(require('./server/config').google.redirectUri)"
```

Then add that exact string to the provider's authorized redirect URIs. Match on scheme, host, port, and path is exact — `127.0.0.1` will not match `localhost`, and a trailing slash matters. Google can take a few minutes to propagate the change.

**`Invalid or expired OAuth state.`** — pending OAuth states are held in memory, so restarting the server mid-login invalidates them. `npm run dev` uses `node --watch` and restarts on every file save; just start the connect flow again.

**Missing env vars warning at startup** — `.env` is missing, misnamed, or has blank values. See Setup above.

## Notes

- Connected account tokens are stored in plaintext in `data/accounts.json` (gitignored). Treat that file as a credential.
- The server binds to all network interfaces and has no authentication, so anyone on your local network can reach it and use your connected accounts. Don't run it on untrusted networks.
- The page loads the Quill editor from `cdn.jsdelivr.net`. Apart from that, and calls to Google/Microsoft's own APIs, nothing leaves your machine.
- The scraper opens a visible browser window (set `HEADLESS=1` to suppress it) and processes listings sequentially inside a single HTTP request, capped at 25 per area. Expect a couple of minutes per area.
- Contacts come from two places: addresses and phone numbers the poster typed into the ad text, and the per-listing relay address (`…@job.craigslist.org`) read from Craigslist's own reply panel. Relay addresses route through Craigslist and expire.
- **Craigslist rate-limits this.** After roughly 50–80 listing views it starts returning an hCaptcha challenge on the reply endpoint, and contact details stop resolving. Affected rows are marked `captchaBlocked` with a note. There is no way around this in the app — scrape smaller batches, less often. Ad-text extraction is unaffected.
- Microsoft Graph has no draft-only permission scope; `Mail.ReadWrite` (the narrowest available) also grants broader mailbox access. Gmail's `gmail.compose` scope is narrower and covers drafts only.
