# Autoemail

Local app that connects to your Gmail and Outlook (personal) accounts and creates one email draft per recipient from a single Subject/Body/recipient-list form. Drafts are created, never sent.

## Setup

```
npm install
cp .env.example .env
```

### Google (Gmail)

1. Create a project at https://console.cloud.google.com/.
2. **APIs & Services → Library** → enable "Gmail API".
3. **APIs & Services → OAuth consent screen**: User type "External"; add scope `https://www.googleapis.com/auth/gmail.compose`; add your own Gmail address as a test user.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**, type **Web application**. Add redirect URI `http://localhost:3000/oauth/google/callback`.
5. Copy the Client ID/Secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

### Microsoft (personal Outlook.com / Hotmail accounts)

1. https://portal.azure.com/ → **Microsoft Entra ID → App registrations → New registration**.
2. Supported account types: **"Personal Microsoft accounts only"**.
3. Redirect URI, platform **Web**: `http://localhost:3000/oauth/microsoft/callback`.
4. **Certificates & secrets → New client secret** → copy into `.env` as `MICROSOFT_CLIENT_SECRET`. Copy the Application (client) ID as `MICROSOFT_CLIENT_ID`.
5. **API permissions → Add a permission → Microsoft Graph → Delegated → `Mail.ReadWrite`**.

## Run

```
npm run dev
```

Open http://localhost:3000, connect your accounts, and fill in the form. Recipients accept one address per line or comma-separated. Each recipient gets its own draft with the same subject/body.

## Notes

- Connected account tokens are stored locally in `data/accounts.json` (gitignored) — nothing leaves your machine except calls to Google/Microsoft's own APIs.
- Microsoft Graph has no draft-only permission scope; `Mail.ReadWrite` (the narrowest available) also grants broader mailbox access. Gmail's `gmail.compose` scope is narrower and covers drafts only.
