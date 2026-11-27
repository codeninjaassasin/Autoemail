'use strict';

// Sessions.
// - Members: anyone on the network uses the app without a password. Each
//   browser gets a member session automatically (cookie `ae_session`), so the
//   admin can see who is using the app and block a device.
// - Admin: /admin (session management) needs the admin password, kept hashed
//   in data/admin.json (server/adminPassword.js), signed in at /admin/login
//   (cookie `ae_admin`, separate from the member cookie).
// The server stores only a SHA-256 hash of each token (data/sessions.json), so
// the file alone can't be used to sign in. Blocking works per browser: a
// blocked device that clears its cookies gets a new session.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const adminPassword = require('./adminPassword');

const FILE = path.join(__dirname, '..', 'data', 'sessions.json');
const MEMBER_COOKIE = 'ae_session';
const ADMIN_COOKIE = 'ae_admin';
const MEMBER_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // cookie lifetime
const MEMBER_IDLE_DROP_MS = 30 * 24 * 60 * 60 * 1000; // forget members idle this long (unless blocked)
// An admin stays signed in while the browser keeps using the app: the session
// ends only after this long without a visit (the cookie is renewed on each page load).
const ADMIN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000; // lastSeenAt is updated at most once a minute
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 8; // wrong admin passwords per IP per window before a lockout

let sessions = null; // Map<hash, { hash, id, role, createdAt, lastSeenAt, ip, userAgent, blocked? }>
let saveTimer = null;
const failures = new Map(); // ip -> { count, first }

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function load() {
  if (sessions) return sessions;
  sessions = new Map();
  let dropped = 0;
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const now = Date.now();
    for (const s of Array.isArray(arr) ? arr : []) {
      if (!s || !s.hash) continue;
      if (s.role === 'user') s.role = 'member'; // sessions from the old user login
      if (s.role === 'admin' && s.v !== 2) continue; // old admin cookie name: unusable
      const idle = now - Date.parse(s.lastSeenAt || s.createdAt);
      if (s.role === 'member' && !s.blocked && idle > MEMBER_IDLE_DROP_MS) {
        dropped++;
        continue;
      }
      sessions.set(s.hash, s);
    }
  } catch {
    /* no sessions yet */
  }
  if (dropped) saveSoon();
  return sessions;
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...load().values()], null, 2), { mode: 0o600 });
    fs.renameSync(tmp, FILE);
  } catch {
    /* best effort */
  }
}
function saveSoon() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 2000);
}
process.on('exit', () => {
  if (saveTimer) saveNow();
});

// Constant-time password check (compares hashes so lengths always match).
function clientIp(req) {
  return String(req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

function lockedOut(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > FAIL_WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= FAIL_LIMIT;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > FAIL_WINDOW_MS) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function addCookie(res, name, token, maxAgeMs) {
  const parts = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeMs > 0 ? Math.floor(maxAgeMs / 1000) : 0}`];
  const prev = res.getHeader('Set-Cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('Set-Cookie', [...list, parts.join('; ')]);
}

function newSession(req, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const hash = sha256(token);
  const now = new Date().toISOString();
  const s = {
    hash,
    id: hash.slice(0, 12),
    role,
    createdAt: now,
    lastSeenAt: now,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
  };
  if (role === 'admin') s.v = 2;
  load().set(hash, s);
  return { token, s };
}

function touch(req, s) {
  if (Date.now() - Date.parse(s.lastSeenAt) > TOUCH_EVERY_MS) {
    s.lastSeenAt = new Date().toISOString();
    s.ip = clientIp(req);
    saveSoon();
  }
}

// The admin session for this request, or null.
function adminOf(req) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const s = load().get(hash);
  if (!s || s.role !== 'admin') return null;
  if (Date.now() - Date.parse(s.lastSeenAt || s.createdAt) > ADMIN_MAX_AGE_MS) {
    sessions.delete(hash);
    saveSoon();
    return null;
  }
  touch(req, s);
  return s;
}

// The member session for this request; a browser without one gets one.
function memberOf(req, res) {
  const token = parseCookies(req)[MEMBER_COOKIE];
  if (token) {
    const s = load().get(sha256(token));
    if (s && s.role === 'member') {
      touch(req, s);
      return s;
    }
  }
  const created = newSession(req, 'member');
  addCookie(res, MEMBER_COOKIE, created.token, MEMBER_MAX_AGE_MS);
  saveSoon();
  return created.s;
}

// Admin sign-in. Returns { ok } or { error, status }.
async function login(req, res, password) {
  const ip = clientIp(req);
  if (lockedOut(ip)) return { status: 429, error: 'Too many wrong passwords. Try again in a few minutes.' };
  if (!adminPassword.isSet()) return { status: 500, error: 'No admin password is set. Run: npm run admin-password' };
  if (!(await adminPassword.verify(password))) {
    noteFailure(ip);
    return { status: 401, error: 'Wrong password.' };
  }
  failures.delete(ip);
  const { token } = newSession(req, 'admin');
  saveNow();
  addCookie(res, ADMIN_COOKIE, token, ADMIN_MAX_AGE_MS);
  return { ok: true };
}

function logout(req, res) {
  const token = parseCookies(req)[ADMIN_COOKIE];
  if (token && load().delete(sha256(token))) saveNow();
  addCookie(res, ADMIN_COOKIE, '', 0);
}

function list() {
  return [...load().values()]
    .map(({ hash, ...s }) => s)
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
}

function byId(id) {
  for (const [hash, s] of load()) if (s.id === id) return { hash, s };
  return null;
}

// Forget a session: an admin is signed out; a member simply gets a new
// session on its next visit (use block to keep a device out).
function remove(id) {
  const hit = byId(id);
  if (!hit) return false;
  sessions.delete(hit.hash);
  saveNow();
  return true;
}

function setBlocked(id, blocked) {
  const hit = byId(id);
  if (!hit || hit.s.role !== 'member') return false;
  if (blocked) {
    hit.s.blocked = true;
    hit.s.blockedAt = new Date().toISOString();
  } else {
    delete hit.s.blocked;
    delete hit.s.blockedAt;
  }
  saveNow();
  return true;
}

// Sign out every admin session except `keepId`.
function signOutOtherAdmins(keepId) {
  let n = 0;
  for (const [hash, s] of load()) if (s.role === 'admin' && s.id !== keepId) (sessions.delete(hash), n++);
  if (n) saveNow();
  return n;
}

const LOGIN_PAGE = '/admin/login';
const ASSET = /\.(js|css|png|jpe?g|svg|ico|woff2?|map)$/i;
const BLOCKED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Access turned off</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:#eef1f4;color:#10151a;font:15px/1.5 system-ui,sans-serif}
@media (prefers-color-scheme: dark){body{background:#0f1418;color:#e6ecf0}}
div{max-width:420px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}</style></head>
<body><div><h1>Access turned off</h1><p>The admin turned off this device's access to autoemail. Ask them to turn it back on.</p></div></body></html>`;

// Middleware:
// - /admin/login: open.
// - /admin and /api/admin/*: admin session required.
// - everything else: open; the browser gets a member session, and a blocked
//   member is refused (an admin session overrides a block on the same browser).
//   Admin-only parts of the app (drafts, analytics, storage, unscraped posts)
//   are checked in server/index.js with req.admin.
function guard(req, res, next) {
  if (req.path === LOGIN_PAGE) return next();
  const admin = adminOf(req);
  req.admin = admin;
  // Keep a signed-in admin signed in: renew the cookie on every page load.
  if (admin && !ASSET.test(req.path) && !req.path.startsWith('/api/')) addCookie(res, ADMIN_COOKIE, parseCookies(req)[ADMIN_COOKIE], ADMIN_MAX_AGE_MS);
  const wantsAdmin = req.path === '/admin' || req.path.startsWith('/api/admin/');
  if (wantsAdmin) {
    if (admin) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Admin login required.', login: true });
    return res.redirect(302, `${LOGIN_PAGE}?next=${encodeURIComponent(req.originalUrl || '/admin')}`);
  }
  if ((ASSET.test(req.path) || req.path.startsWith('/api/')) && !parseCookies(req)[MEMBER_COOKIE]) {
    // Static files and API calls without a member cookie (scripts, tools)
    // don't create sessions; a browser always has one from loading the page.
    return next();
  }
  if (ASSET.test(req.path) && !admin) {
    // Static files: no new session per file, but a blocked browser gets none.
    const s = load().get(sha256(parseCookies(req)[MEMBER_COOKIE]));
    if (s && s.blocked) return res.status(403).end();
    return next();
  }
  const member = memberOf(req, res);
  req.member = member;
  if (member.blocked && !admin) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: 'Access turned off by the admin.', blocked: true });
    return res.status(403).type('html').send(BLOCKED_HTML);
  }
  return next();
}

module.exports = { guard, login, logout, list, remove, setBlocked, signOutOtherAdmins, adminOf, LOGIN_PAGE };
