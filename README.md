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

## Run as a service and auto-deploy (VM)

On the VM the app runs as a systemd **user** service, `deploy/autoemail.service`, installed at `~/.config/systemd/user/autoemail.service`. It starts at boot (linger is on for the user), restarts on a crash, and after every start resumes a scrape with the settings saved from the UI (`scripts/start-scrape.js`).

```
node scripts/start-scrape.js --status   # is the server up, is a scrape running?
node scripts/start-scrape.js            # start a scrape only if none is running
systemctl --user restart autoemail      # restart server + scrape
journalctl --user -u autoemail -f       # live logs
```

**CI/CD.** `.github/workflows/deploy.yml` runs on every push to `main`: a syntax/load check on GitHub's machines, then a deploy job on a self-hosted runner on the VM that fast-forwards `/opt/autoemail` to `origin/main`, runs `npm ci` only when the lockfile changed, restarts the service and checks it came back. The VM is on a private network, so GitHub can't reach it; the runner on the VM polls GitHub instead.

One-time setup (needs a repo **admin**): GitHub → repo **Settings → Actions → Runners → New self-hosted runner**, copy the token after `--token`, then on the VM:

```
scripts/install-runner.sh <token>
```

The deploy refuses to run (and says why) when `/opt/autoemail` is not on `main` or has uncommitted changes to tracked files, so edits made directly on the VM are never overwritten. Develop on a branch elsewhere, or commit and push from the VM before merging.

The repo is public: under **Settings → Actions → General → Fork pull request workflows**, choose **Require approval for all external contributors**, so a fork's pull request can never run code on the VM's runner.

## Troubleshooting

**`Error 400: redirect_uri_mismatch`** — the redirect URI registered with the provider doesn't exactly match what the app sends. The app derives it from `PORT`, so changing `PORT` after registering will break OAuth. Print what the app is actually sending:

```
node -e "console.log(require('./server/config').google.redirectUri)"
```

Then add that exact string to the provider's authorized redirect URIs. Match on scheme, host, port, and path is exact — `127.0.0.1` will not match `localhost`, and a trailing slash matters. Google can take a few minutes to propagate the change.

**`Invalid or expired OAuth state.`** — pending OAuth states are held in memory, so restarting the server mid-login invalidates them. `npm run dev` uses `node --watch` and restarts on every file save; just start the connect flow again.

**Missing env vars warning at startup** — `.env` is missing, misnamed, or has blank values. See Setup above.

## Access and /admin

The app at `/` is open to everyone on your network — no password. Each browser gets its own member session (a cookie), so you can see who is using it. Only `/admin` is password-protected: sign in at `/admin/login` with the admin password from `.env`:

```
ADMIN_PASSWORD='...'
```

Wrap the value in single quotes if it contains `#` or spaces. `/admin` lists every member and admin session (device, IP, first seen, last active). **Block** turns a member browser's access off until you unblock it (it sees an "access turned off" page); **Remove** forgets a session; admin sessions can be signed out. A blocked browser that clears its cookies comes back as a new member, so blocking is a speed bump, not real security. Sessions live in `data/sessions.json`, which stores only a hash of each token. After 8 wrong admin passwords from one IP, that IP must wait 10 minutes.

## Notes

- Connected account tokens are stored in plaintext in `data/accounts.json` (gitignored). Treat that file as a credential.
- The server binds to all network interfaces and the app needs no password, so anyone on your network can use it (and your connected mail accounts). Only `/admin` is password-protected, over plain HTTP. Don't run it on untrusted networks.
- The page loads the Quill editor from `cdn.jsdelivr.net`. Apart from that, and calls to Google/Microsoft's own APIs, nothing leaves your machine.
- The scraper opens a visible browser window (set `HEADLESS=1` to suppress it) and processes listings sequentially inside a single HTTP request, capped at 25 per area. Expect a couple of minutes per area.
- Contacts come from two places: addresses and phone numbers the poster typed into the ad text, and the per-listing relay address (`…@job.craigslist.org`) read from Craigslist's own reply panel. Relay addresses route through Craigslist and expire.
- **Craigslist rate-limits this.** After roughly 50–80 listing views it starts returning an hCaptcha challenge on the reply endpoint, and contact details stop resolving. Affected rows are marked `captchaBlocked` with a note. There is no way around this in the app — scrape smaller batches, less often. Ad-text extraction is unaffected.
- UI settings (area/category selections, run parameters, panel states) are stored on the server in `data/settings.json`, so every device that opens the page gets the same settings, and a change on one device appears on the others within a few seconds. The results-list filters (All/Sent/Unsent, category, state, city, phone search, freshness, Has phone) are per device and stay in that browser.
- **Refresh unsent relays** is a separate switch above the results table. It runs 3 proxy workers over the unsent contacts the results list shows on the device that turned it on — that device's filters (Has phone, category, state, city, phone search, freshness, sent/unsent) set the scope, and its filter changes take effect live. Other devices see which list is being checked and can take over by switching refresh off and on. It runs with or without a scrape running: never-checked posts first (newest posted first), then whichever post was checked longest ago. A worker tries up to "Max proxies / post" proxies per post, then marks it Unverified and keeps the old relay. An HTTP sweep marks dead listings Expired, and they are never re-checked. Every relay change is appended to `data/relay-changes.jsonl`. The switch does not survive a server restart.
- The page keeps the whole list (every contact and listed post) in the browser — in memory and in IndexedDB — and does all filtering and sorting there. On open it paints from that cache at once, then fetches only what changed since its last sync (`GET /api/sync`, gzip-compressed); it re-syncs every 4 seconds, so a change made on one device shows on the others within a few seconds. Only the first 200 matching rows are drawn; more load as you scroll. The server keeps contacts in memory, writes them to disk at most every 1.5 s off the request path, and flushes on shutdown.
- The results list has four tabs. **All** lists every post the scrape has seen on a search page in the last 3 days, scraped or not (stored in `data/posts.json`; a background HTTP pass fills their posted dates and drops expired ones). **Scraped** lists only posts with a stored contact. **Unsent** is All minus sent. **Sent** lists contacts marked sent. A missing relay email or phone shows a pencil icon: click it to fill the field by hand (saved as a contact marked "filled by hand"; phones are validated and must not already belong to another contact).
- The scrape serves new posts first: a post not in the contact list yet always goes ahead of posts already stored, and a post first listed after the run's first scan goes to the very front. Stored posts are re-visited (relay update) only when no new post is waiting.
- While a scrape runs with the proxy pool, the pool is refreshed automatically every hour, or after 15 minutes when fewer than 100 verified proxies are usable: verified proxies are kept, unverified ones removed, and a fresh list gathered.
- **▶ Scrape this post** (on rows not scraped yet) starts a temporary worker on the server for that one post. It uses only **usable** proxies (verified by earlier use, not cooling down), best first, with the main scrape's proxy rules: a proxy that reaches the page is kept for up to 3 visits, a captcha cools it, a network error counts toward its 10-failure drop. It stops when the relay is caught, the listing is gone, or the usable proxies / "Max proxies / post" run out; anything found on the way (ad-text phone, email) is stored. Up to 5 run at once, independent of the main scrape and the refresh; the Checked column shows progress and clicking ■ stops it. Reply wait and page timeout come from the saved run settings.
- A contact marked sent is final: neither the refresh nor the main scrape visits or updates it again, and the Checked column shows "—" for it.
- Microsoft Graph has no draft-only permission scope; `Mail.ReadWrite` (the narrowest available) also grants broader mailbox access. Gmail's `gmail.compose` scope is narrower and covers drafts only.
