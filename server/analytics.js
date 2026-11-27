'use strict';

// Day-by-day counts for the Analytics tab, bucketed in the viewer's time zone:
// posts first seen, contacts scraped (with a phone, with a relay), drafts made
// (still in Drafts, or sent), contacts marked sent, and replies.

const contacts = require('./contacts');
const posts = require('./posts');
const log = require('./drafts/log');
const replies = require('./drafts/replies');

const MAX_DAYS = 120;

function dayKeyer(tz) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  return (iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) ? fmt.format(t) : null; // YYYY-MM-DD
  };
}

function build({ tz, days }) {
  const n = Math.min(MAX_DAYS, Math.max(1, Number(days) || 30));
  const key = dayKeyer(tz);
  // The last n calendar days, oldest first, ending today in tz.
  const order = [];
  const seen = new Set();
  for (let t = Date.now(), guard = 0; order.length < n && guard < n + 3; t -= 86400000, guard++) {
    const k = key(new Date(t).toISOString());
    if (!seen.has(k)) seen.add(k), order.unshift(k);
  }
  const blank = () => ({ posts: 0, scraped: 0, phones: 0, relays: 0, drafted: 0, draftSent: 0, draftWaiting: 0, marked: 0, replies: 0 });
  const byDay = new Map(order.map((k) => [k, blank()]));
  const bump = (iso, field, by = 1) => {
    const d = byDay.get(key(iso));
    if (d) d[field] += by;
  };

  for (const p of posts.all()) bump(p.firstSeenAt, 'posts');
  let totalContacts = 0;
  let totalPhones = 0;
  for (const c of contacts.list()) {
    if (c.unscraped) continue;
    totalContacts++;
    const hasPhone = (c.phones || []).length > 0;
    if (hasPhone) totalPhones++;
    if (c.scrapedAt) {
      bump(c.scrapedAt, 'scraped');
      if (hasPhone) bump(c.scrapedAt, 'phones');
      if (c.relay) bump(c.scrapedAt, 'relays');
    }
    if (c.sent && c.sentAt) bump(c.sentAt, 'marked');
  }
  for (const e of log.all()) {
    bump(e.createdAt, 'drafted');
    bump(e.createdAt, e.status === 'waiting' ? 'draftWaiting' : 'draftSent'); // left Drafts: sent
  }
  for (const r of replies.all()) bump(r.at, 'replies');

  return {
    tz: tz || 'UTC',
    days: order.map((date) => ({ date, ...byDay.get(date) })),
    totals: { contacts: totalContacts, phones: totalPhones, waiting: log.waiting().length, unreadReplies: replies.summary().unread.length },
  };
}

// The page polls; one build per zone and range every 20 seconds is plenty.
const memo = new Map();
function cached(opts) {
  const k = `${opts.tz}|${opts.days}`;
  const hit = memo.get(k);
  if (hit && Date.now() - hit.at < 20000) return hit.value;
  const value = build(opts);
  memo.set(k, { at: Date.now(), value });
  if (memo.size > 20) memo.delete(memo.keys().next().value);
  return value;
}

module.exports = { build: cached };
