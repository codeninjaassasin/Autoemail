'use strict';

// Admin (signed in at /admin/login) sees everything; a member sees the scraped
// list only. Set by the loader in index.html from /api/me; the server enforces it.
const IS_ADMIN = !!window.__IS_ADMIN__;

// ---------- Tabs ----------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'storage') loadFormat();
    if (btn.dataset.tab === 'analytics') loadAnalytics();
  });
});

// ---------- Accounts ----------
var accountsList = []; // var: read by the template dialog
async function loadAccounts() {
  try {
    accountsList = await (await fetch('/api/accounts')).json();
  } catch {
    return;
  }
  const ul = document.getElementById('accounts');
  ul.innerHTML = '';
  if (!accountsList.length) {
    ul.innerHTML = '<li class="sub">No accounts connected yet.</li>';
    return;
  }
  for (const a of accountsList) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="provider">${a.provider === 'google' ? 'Gmail' : 'Outlook'}</span><span class="acct-email">${esc(a.emailAddress)}</span>
      <a href="#" class="del" data-id="${esc(a.id)}">remove</a>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll('.del').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Remove this account? Its drafts already in Gmail stay there.')) return;
      await fetch(`/api/accounts/${el.dataset.id}`, { method: 'DELETE' });
      loadAccounts();
      loadReminders();
      loadAuto();
    })
  );
}
if (IS_ADMIN) loadAccounts();

// Connecting needs the provider's OAuth client in .env, and the OAuth reply
// comes back to the redirect address (localhost), so say so before the click.
(async () => {
  if (!IS_ADMIN) return;
  let s;
  try {
    s = await (await fetch('/api/connect/status')).json();
  } catch {
    return;
  }
  const note = document.getElementById('connectNote');
  const lines = [];
  const missing = [];
  for (const [key, id, name] of [['google', 'connectGoogle', 'Gmail'], ['microsoft', 'connectMicrosoft', 'Outlook']]) {
    const link = document.getElementById(id);
    if (!s[key].configured) {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      link.title = `${name} sign-in is not set up on this server yet.`;
      missing.push(name);
    }
  }
  if (missing.length === 2)
    lines.push("Gmail and Outlook sign-in aren't set up on this server yet: add their client IDs and secrets to .env, then restart.");
  else if (missing.length)
    lines.push(`${missing[0]} sign-in isn't set up on this server yet: add its client ID and secret to .env, then restart.`);
  const redirect = s.google.configured ? s.google.redirectUri : s.microsoft.configured ? s.microsoft.redirectUri : null;
  if (redirect) {
    const back = new URL(redirect);
    if (back.host !== location.host)
      lines.push(`Sign-in returns to ${back.origin}. Open this page at that address (on the server, or through an SSH tunnel) before connecting.`);
  }
  note.textContent = lines.join(' ');
  note.hidden = !lines.length;
})();

function agoText(iso) {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  const d = Math.floor(m / 1440);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}
function clockText(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${t}`;
}

// ---------- Templates ----------
// A list, and a dialog to write one (plain multi-line text, kept line for line
// in the draft) and pick the mailboxes that draft with it.
const tplList = document.getElementById('tplList');
const tplDialog = document.getElementById('tplDialog');
const tplForm = document.getElementById('tplForm');
const tplTitle = document.getElementById('tplDialogTitle');
const tplName = document.getElementById('tplName');
const subjectEl = document.getElementById('subject');
const tplBody = document.getElementById('tplBody');
const tplBoxes = document.getElementById('tplBoxes');
const tplErr = document.getElementById('tplErr');
const tplDelete = document.getElementById('tplDelete');
const tplSave = document.getElementById('tplSave');
var templatesList = []; // var: read by renderAuto, which may run first
let editingId = null;
let tplOpened = null; // the dialog's text when it opened, to warn before losing edits

const assignedTo = (templateId) =>
  autoData ? autoData.mailboxes.filter((m) => m.templateId === templateId) : [];

function renderTemplates() {
  if (!templatesList.length) {
    tplList.innerHTML = '<li class="sub">No templates yet. Make one, then tick the mailboxes that draft with it.</li>';
    return;
  }
  tplList.innerHTML = templatesList
    .map((t) => {
      const boxes = assignedTo(t.id);
      const first = (t.body || '').split('\n').find((l) => l.trim()) || '';
      return `<li>
        <div class="tpl-main">
          <span class="tpl-name">${esc(t.name)}</span>
          <span class="tpl-subj">${esc(t.subject)}</span>
          <span class="tpl-first">${esc(first)}</span>
        </div>
        <div class="tpl-boxes">${
          boxes.length
            ? boxes.map((m) => `<span class="tpl-box">${esc(m.email)}</span>`).join('')
            : '<span class="auto-dim">No mailbox</span>'
        }</div>
        <button type="button" class="btn btn--quiet btn--sm tpl-edit" data-id="${esc(t.id)}">Edit</button>
      </li>`;
    })
    .join('');
}

async function loadTemplates() {
  try {
    templatesList = await (await fetch('/api/templates')).json();
  } catch {
    return;
  }
  renderTemplates();
  if (autoData) renderAuto(autoData);
}
if (IS_ADMIN) loadTemplates();

const tplSnapshot = () =>
  JSON.stringify([tplName.value, subjectEl.value, tplBody.value, [...tplBoxes.querySelectorAll('input:checked')].map((c) => c.value)]);

function openTemplate(id) {
  const t = templatesList.find((x) => x.id === id) || null;
  editingId = t ? t.id : null;
  tplTitle.textContent = t ? 'Edit template' : 'New template';
  tplName.value = t ? t.name : '';
  subjectEl.value = t ? t.subject : '';
  tplBody.value = t ? t.body || '' : '';
  tplDelete.hidden = !t;
  tplErr.textContent = '';
  const mailboxes = autoData ? autoData.mailboxes : accountsList.map((a) => ({ accountId: a.id, email: a.emailAddress, templateId: null }));
  tplBoxes.innerHTML = mailboxes.length
    ? mailboxes
        .map((m) => {
          const other = m.templateId && m.templateId !== editingId ? templatesList.find((x) => x.id === m.templateId) : null;
          return `<label class="tplbox"><input type="checkbox" value="${esc(m.accountId)}"${t && m.templateId === t.id ? ' checked' : ''} />
            <span>${esc(m.email)}</span>${other ? `<span class="auto-dim">now uses ${esc(other.name)}</span>` : ''}</label>`;
        })
        .join('')
    : '<p class="dhint">Connect a Gmail account first.</p>';
  tplOpened = tplSnapshot();
  lastField = 'body';
  tplDialog.showModal();
  tplName.focus();
}

function closeTemplate(force) {
  if (!force && tplSnapshot() !== tplOpened && !confirm('Close without saving your changes?')) return;
  tplDialog.close();
}

document.getElementById('tplNew').addEventListener('click', () => openTemplate(null));
tplList.addEventListener('click', (e) => {
  const b = e.target.closest('.tpl-edit');
  if (b) openTemplate(b.dataset.id);
});
document.getElementById('tplCancel').addEventListener('click', () => closeTemplate(false));
tplDialog.addEventListener('cancel', (e) => {
  e.preventDefault(); // Escape: ask first if something changed
  closeTemplate(false);
});

tplForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  tplErr.textContent = '';
  const payload = { name: tplName.value.trim(), subject: subjectEl.value, body: tplBody.value };
  if (!payload.name) return (tplErr.textContent = 'Give the template a name.'), tplName.focus();
  if (!payload.subject.trim()) return (tplErr.textContent = 'Write a subject.'), subjectEl.focus();
  if (!payload.body.trim()) return (tplErr.textContent = 'Write the email body.'), tplBody.focus();
  tplSave.disabled = true;
  try {
    const r = await fetch(editingId ? `/api/templates/${encodeURIComponent(editingId)}` : '/api/templates', {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Could not save the template.');
    const id = data.template.id;
    // Mailboxes: ticked ones use this template; unticked ones that used it stop.
    const assignments = {};
    tplBoxes.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      const m = autoData && autoData.mailboxes.find((x) => x.accountId === cb.value);
      if (cb.checked) assignments[cb.value] = id;
      else if (m && m.templateId === id) assignments[cb.value] = null;
    });
    await loadTemplates();
    if (Object.keys(assignments).length) await saveAuto({ assignments });
    renderTemplates();
    tplDialog.close();
    showToast({ kicker: editingId ? 'Template updated' : 'Template saved', title: data.template.name, body: 'Drafts from now on use this text.' });
  } catch (err) {
    tplErr.textContent = err.message;
  } finally {
    tplSave.disabled = false;
  }
});

tplDelete.addEventListener('click', async () => {
  const t = templatesList.find((x) => x.id === editingId);
  if (!t) return;
  const inUse = assignedTo(t.id).map((m) => m.email);
  const warn = inUse.length ? `\n\n${inUse.join(', ')} will stop making automatic drafts.` : '';
  if (!confirm(`Delete the template "${t.name}"?${warn}`)) return;
  await fetch(`/api/templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
  tplDialog.close();
  await loadTemplates();
  loadAuto();
  showToast({ kicker: 'Template deleted', title: t.name, body: inUse.length ? 'Its mailboxes have no template now.' : 'It was not in use.' });
});

// Fields: click to insert where the cursor was, in the subject or the body.
const FIELD_NAMES = ['title', 'city', 'state', 'category', 'link', 'posted'];
const FIELD_HELP = {
  title: 'Post title, without the category Craigslist adds',
  city: 'City of the area, e.g. San Diego',
  state: 'State, e.g. CA',
  category: 'Category name, e.g. resumes',
  link: 'Link to the post',
  posted: 'Posted date, e.g. Nov 25',
};
let lastField = 'body';
subjectEl.addEventListener('focus', () => (lastField = 'subject'));
tplBody.addEventListener('focus', () => (lastField = 'body'));
const fieldBar = document.getElementById('fieldBar');
fieldBar.insertAdjacentHTML(
  'beforeend',
  FIELD_NAMES.map((f) => `<button type="button" class="field-chip" data-field="${f}" title="${FIELD_HELP[f]}">{{${f}}}</button>`).join('')
);
fieldBar.addEventListener('mousedown', (e) => {
  if (e.target.closest('.field-chip')) e.preventDefault(); // keep the cursor where it was
});
fieldBar.addEventListener('click', (e) => {
  const chip = e.target.closest('.field-chip');
  if (!chip) return;
  const token = `{{${chip.dataset.field}}}`;
  const el = lastField === 'subject' ? subjectEl : tplBody;
  const a = el.selectionStart ?? el.value.length;
  const b = el.selectionEnd ?? a;
  el.value = el.value.slice(0, a) + token + el.value.slice(b);
  el.focus();
  el.setSelectionRange(a + token.length, a + token.length);
});

// ---------- Drafted emails ----------
// Every draft the app made: still in Drafts (waiting for you to send it), or
// gone from Drafts (counted as sent). The server checks every 5 minutes.
const remindRows = document.getElementById('remindRows');
const remindErrs = document.getElementById('remindErrs');
const remindEmpty = document.getElementById('remindEmpty');
const remindCount = document.getElementById('remindCount');
const repliesNew = document.getElementById('repliesNew');
const repliesSeen = document.getElementById('repliesSeen');
const replyNote = document.getElementById('replyNote');
const baseTitle = document.title;
const remindSub = document.getElementById('remindSub');
const remindCheck = document.getElementById('remindCheck');
const draftsDue = document.getElementById('draftsDue');
let remindToastShown = false;

// "Jane Doe <jane@x.com>" -> "Jane Doe"; a bare address stays as it is.
function senderName(from) {
  const m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  return m ? m[1].trim() || m[2] : String(from || 'someone');
}

// ---------- Desktop alerts: new drafts to send, and replies ----------
// Switched on with the "Desktop alerts" toggle in the top bar (per browser).
// Each new draft raises one notification asking to send it soon, and each
// unread reply raises one; both are remembered in localStorage so a reload
// does not repeat them.
const ALERTS_KEY = 'autoemail.alerts';
const NOTIFIED_KEY = 'autoemail.notifiedReplies';
const NOTIFIED_DRAFTS_KEY = 'autoemail.notifiedDrafts';
const alertsToggle = document.getElementById('alertsToggle');
function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private window: works until reload */
  }
}
const notifiedSet = (key = NOTIFIED_KEY) => new Set(readJson(key, []));
const rememberNotified = (set, key = NOTIFIED_KEY) => writeJson(key, [...set].slice(-500));
const canNotify = () => 'Notification' in window && window.isSecureContext;
let alertPref = readJson(ALERTS_KEY, { on: false, since: null });
const alertsOn = () => !!alertPref.on && canNotify() && Notification.permission === 'granted';
function paintAlertsToggle() {
  alertsToggle.checked = alertsOn();
}
paintAlertsToggle();

function openDrafts() {
  window.focus();
  document.querySelector('.tabs button[data-tab="drafts"]').click();
}
const gmailDrafts = (d) =>
  d.provider === 'google' ? `https://mail.google.com/mail/u/${encodeURIComponent(d.account)}/#drafts` : 'https://outlook.office.com/mail/drafts';

function notify(title, body, tag, onClick, sticky) {
  if (!alertsOn()) return;
  try {
    const n = new Notification(title, { body, tag, icon: '/favicon.svg', requireInteraction: !!sticky });
    n.onclick = () => {
      onClick();
      n.close();
    };
  } catch {
    /* some browsers only notify from a service worker */
  }
}

alertsToggle.addEventListener('change', async () => {
  if (!alertsToggle.checked) {
    alertPref = { on: false, since: null };
    writeJson(ALERTS_KEY, alertPref);
    showToast({ kicker: 'Desktop alerts off', title: 'No more desktop notifications', body: 'Drafts and replies still show in the Drafts tab.' });
    return;
  }
  if (!canNotify()) {
    alertsToggle.checked = false;
    showToast({ kicker: 'Not available here', title: 'Desktop alerts need localhost', body: 'Open this page at http://localhost:4987 (for example through the SSH tunnel), then turn them on.', tone: 'bad' });
    return;
  }
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission().catch(() => 'denied');
  if (p !== 'granted') {
    alertsToggle.checked = false;
    showToast({ kicker: 'Desktop alerts off', title: 'The browser blocked them', body: "Allow notifications in this site's settings, then turn the toggle on again.", tone: 'bad' });
    return;
  }
  alertPref = { on: true, since: new Date().toISOString() };
  writeJson(ALERTS_KEY, alertPref);
  paintAlertsToggle();
  notify('Desktop alerts are on', 'You will be told when a draft is ready to send and when someone replies. Keep this page open in a tab.', 'alerts-on', () => window.focus());
  showToast({ kicker: 'Desktop alerts on', title: 'New drafts and replies will notify you', body: 'Keep this page open in a tab.' });
});

// A new draft: ask to send it soon. The notification stays until clicked, and
// opens that mailbox's Drafts in Gmail.
function alertNewDrafts(waiting) {
  if (!alertsOn()) return;
  const since = Date.parse(alertPref.since || 0) || 0;
  const seen = notifiedSet(NOTIFIED_DRAFTS_KEY);
  const fresh = waiting.filter((d) => Date.parse(d.createdAt) >= since && !seen.has(d.id));
  if (!fresh.length) return;
  if (fresh.length <= 3)
    for (const d of fresh)
      notify(
        'Draft ready: send it now',
        `${d.post ? d.post.title : d.subject || '(no subject)'}\nTo ${/@res\.craigslist\.org$/i.test(d.to) ? shortRelay(d.to) : d.to}, from ${d.account}`,
        `draft-${d.id}`,
        () => window.open(gmailDrafts(d), '_blank', 'noopener'),
        true
      );
  else notify(`${fresh.length} drafts ready to send`, 'Open Drafts in Gmail and send them soon.', 'drafts', openDrafts, true);
  showToast({
    kicker: 'Draft ready',
    title: fresh.length === 1 ? 'Send it from Gmail soon' : `${fresh.length} drafts ready to send`,
    body: fresh.length === 1 ? `To ${shortRelay(fresh[0].to)}, in ${fresh[0].account}` : 'See Drafted emails in the Drafts tab.',
  });
  fresh.forEach((d) => seen.add(d.id));
  rememberNotified(seen, NOTIFIED_DRAFTS_KEY);
}

function alertReplies(fresh) {
  if (fresh.length <= 3)
    for (const x of fresh) notify(`Reply from ${senderName(x.from)}`, `${x.subject || '(no subject)'}\nIn ${x.account}`, `reply-${x.id}`, openDrafts);
  else notify(`${fresh.length} new replies`, fresh.map((x) => senderName(x.from)).slice(0, 4).join(', '), 'replies', openDrafts);
}

function renderReplies(rp) {
  if (!rp) return;
  const k = rp.unread.length;
  repliesNew.hidden = !k;
  repliesNew.textContent = k ? `${k} new repl${k === 1 ? 'y' : 'ies'}` : '';
  document.title = k ? `(${k}) ${baseTitle}` : baseTitle;
  repliesSeen.hidden = !k;

  const seen = notifiedSet();
  const fresh = rp.unread.filter((x) => !seen.has(x.id));
  if (fresh.length) {
    alertReplies(fresh);
    showToast({
      kicker: 'New reply',
      title: fresh.length === 1 ? `From ${senderName(fresh[0].from)}` : `${fresh.length} new replies`,
      body: fresh.length === 1 ? `${fresh[0].subject || '(no subject)'}, in ${fresh[0].account}` : 'See Drafted emails in the Drafts tab.',
    });
    fresh.forEach((x) => seen.add(x.id));
    rememberNotified(seen);
  }

  const reconnect = rp.mailboxes.filter((m) => m.needsReconnect).map((m) => m.email);
  const failing = rp.mailboxes.filter((m) => m.error);
  const notes = [];
  if (reconnect.length)
    notes.push(`To notice replies, connect ${reconnect.join(', ')} again (Connect Gmail): the app needs one more permission, to read the sender and subject of new mail. It never reads message text.`);
  for (const m of failing) notes.push(`Replies in ${m.email} could not be checked: ${m.error}`);
  replyNote.textContent = notes.join(' ');
  replyNote.hidden = !notes.length;
  paintAlertsToggle(); // permission may have been revoked in the browser
}

repliesSeen.addEventListener('click', async () => {
  repliesSeen.disabled = true;
  try {
    await fetch('/api/replies/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await loadReminders();
  } finally {
    repliesSeen.disabled = false;
  }
});

// An address that may wrap only before its @.
const atBreak = (addr) => esc(addr).replace('@', '<wbr>@');

function renderReminders(r) {
  const n = r.waiting.length;
  draftsDue.hidden = !n;
  draftsDue.textContent = n ? String(n) : '';
  draftsDue.closest('button').title = n ? `${n} draft${n === 1 ? '' : 's'} waiting to be sent` : '';

  remindSub.textContent = r.checking
    ? 'Checking the Drafts folders…'
    : `${n ? `${n} waiting to be sent from Gmail.` : 'Nothing waiting to be sent.'} ${r.checkedAt ? `Checked ${agoText(r.checkedAt)}.` : ''}`;

  remindErrs.innerHTML = r.errors
    .map(
      (e) => `<li><span class="r-acct">${esc(e.account)}</span><span>${esc(e.error)}</span>
        <a class="btn btn--quiet btn--sm" href="/connect/${e.provider === 'google' ? 'google' : 'microsoft'}">Connect again</a></li>`
    )
    .join('');

  // Waiting drafts first, then the ones that left Drafts; newest first in each.
  const done = r.done || [];
  const row = (d, isDone, first) => {
    const old = !isDone && Date.now() - Date.parse(d.createdAt) > 86400000;
    const rp = d.replies;
    const status = rp && rp.unread
      ? `<span class="d-status is-reply-new" title="${rp.unread} unread repl${rp.unread === 1 ? 'y' : 'ies'}">New reply</span>`
      : rp
        ? '<span class="d-status is-reply">Replied</span>'
        : isDone
          ? `<span class="d-status is-sent"${d.goneAt ? ` title="Left Drafts ${esc(new Date(d.goneAt).toLocaleString())}"` : ''}>Sent</span>`
          : `<span class="d-status ${old ? 'is-old' : 'is-waiting'}" title="${old ? 'Waiting more than a day' : 'In Drafts, not sent yet'}">Waiting</span>`;
    const replyLine = rp
      ? `<span class="d-reply">Reply from ${esc(senderName(rp.last.from))}, ${agoText(rp.last.at)}${rp.count > 1 ? ` (${rp.count} replies)` : ''}${rp.last.snippet ? `: ${esc(rp.last.snippet)}` : ''}</span>`
      : '';
    const p = d.post;
    const title = p ? esc(p.title || '(untitled)') : '';
    const post = !p
      ? '<span class="auto-dim">Not from a post</span>'
      : `${p.url ? `<a class="title-clamp" href="${esc(p.url)}" target="_blank" rel="noopener" title="${title}">${title}</a>` : `<span class="title-clamp">${title}</span>`}<span class="d-area">${esc([p.place, p.posted ? 'posted ' + p.posted : ''].filter(Boolean).join(', '))}</span>`;
    return `<tr class="${[isDone && !rp ? 'is-done' : '', rp && rp.unread ? 'is-new-reply' : '', first ? 'group-start' : ''].filter(Boolean).join(' ')}">
      <td>${status}</td>
      <td class="d-when" title="${esc(new Date(d.createdAt).toLocaleString())}">${clockText(d.createdAt)}</td>
      <td class="d-post">${post}</td>
      <td class="d-subj">${esc(d.subject || '(no subject)')}${replyLine}</td>
      <td class="d-to" title="${esc(d.to)}">${atBreak(/@res\.craigslist\.org$/i.test(d.to) ? shortRelay(d.to) : d.to)}</td>
      <td class="d-box">${atBreak(d.account)}</td>
    </tr>`;
  };
  // Unread replies on top, then waiting drafts, then sent or deleted.
  const fresh = [...r.waiting.map((d) => [d, false]), ...done.map((d) => [d, true])]
    .filter(([d]) => d.replies && d.replies.unread)
    .sort((a, b) => String(b[0].replies.last.at).localeCompare(String(a[0].replies.last.at)));
  const isFresh = (d) => d.replies && d.replies.unread;
  const waitRest = r.waiting.filter((d) => !isFresh(d));
  const doneRest = done.filter((d) => !isFresh(d));
  remindRows.innerHTML =
    fresh.map(([d, isDone]) => row(d, isDone, false)).join('') +
    waitRest.map((d, i) => row(d, false, i === 0 && fresh.length > 0)).join('') +
    doneRest.map((d, i) => row(d, true, i === 0 && fresh.length + waitRest.length > 0)).join('');
  remindEmpty.hidden = r.waiting.length + done.length > 0;
  const replied = [...r.waiting, ...done].filter((d) => d.replies).length;
  remindCount.textContent = [`${n} waiting`, `${done.length} sent`, replied && `${replied} replied`].filter(Boolean).join(', ');
  renderReplies(r.replies);
  alertNewDrafts(r.waiting);

  if (n && !remindToastShown) {
    remindToastShown = true;
    showToast({
      kicker: 'Reminder',
      title: `${n} draft${n === 1 ? '' : 's'} waiting to be sent`,
      body: 'Open each one in Gmail, make it right, and send it yourself.',
    });
  }
}

async function loadReminders() {
  try {
    renderReminders(await (await fetch('/api/reminders')).json());
  } catch {
    /* offline: keep the last list */
  }
}
remindCheck.addEventListener('click', async () => {
  remindCheck.disabled = true;
  remindCheck.setAttribute('aria-busy', 'true');
  remindSub.textContent = 'Checking the Drafts folders…';
  try {
    renderReminders(await (await fetch('/api/reminders/check', { method: 'POST' })).json());
  } catch {
    remindSub.textContent = 'The check did not go through. Try again in a minute.';
  } finally {
    remindCheck.disabled = false;
    remindCheck.removeAttribute('aria-busy');
  }
});
if (IS_ADMIN) {
  loadReminders();
  setInterval(loadReminders, 30000);
}

// ---------- Automatic drafts ----------
// The server picks the mailbox for each new no-phone post under strict
// per-mailbox limits; this panel shows who is next and why. Never sends.
const autoRows = document.getElementById('autoRows');
const autoToggle = document.getElementById('autoToggle');
const autoState = document.getElementById('autoState');
const autoStats = document.getElementById('autoStats');
const autoMsg = document.getElementById('autoMsg');
const autoRecent = document.getElementById('autoRecent');
const limitDay = document.getElementById('limitDay');
const limitHour = document.getElementById('limitHour');
var autoData = null; // var: read by the template code, which may run first

const STATUS_TEXT = {
  free: 'Has room',
  rested: 'Has room, waits a turn',
  'hour-full': 'Hour limit reached',
  'day-full': '24-hour limit reached',
  paused: 'Paused',
  'no-template': 'No template',
};

function whyText(m) {
  if (m.status === 'hour-full' || m.status === 'day-full') return `${m.note} Room again at ${clockText(m.freeAt)}.`;
  if (m.status === 'paused') return `${m.note} Tries again at ${clockText(m.freeAt)}.`;
  if (m.status === 'free') return m.position === 1 ? `Gets the next post: ${autoData.next ? autoData.next.reason : ''}.` : `Gets a post after number ${m.position - 1}.`;
  return m.note;
}

function renderAuto(a) {
  if (!a) return;
  autoData = a;
  autoToggle.setAttribute('aria-pressed', String(a.enabled));
  autoToggle.textContent = a.enabled ? 'Turn off' : 'Turn on';
  autoState.textContent = a.enabled ? `On since ${clockText(a.enabledAt)}` : 'Off';
  autoState.classList.toggle('is-on', a.enabled);
  if (document.activeElement !== limitDay) limitDay.value = a.limits.perDay;
  if (document.activeElement !== limitHour) limitHour.value = a.limits.perHour;

  if (!a.mailboxes.length) {
    autoRows.innerHTML = '<tr><td colspan="6" class="sub">Connect a Gmail account to assign it a template.</td></tr>';
  } else {
    const opts = (sel) =>
      '<option value="">No template</option>' +
      templatesList.map((t) => `<option value="${esc(t.id)}"${t.id === sel ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
    const rows = [...a.mailboxes].sort((x, y) => (x.position || 99) - (y.position || 99) || x.email.localeCompare(y.email));
    autoRows.innerHTML = rows
      .map((m) => {
        const tone = m.position === 1 ? 'auto-on' : m.status === 'paused' ? 'auto-bad' : m.position ? '' : 'auto-dim';
        return `<tr class="${m.position === 1 ? 'is-next' : ''}">
          <td class="auto-turn" data-label="Turn">${m.position ? (m.position === 1 ? 'Next' : m.position) : 'Out'}</td>
          <td class="auto-mail">${esc(m.email)}</td>
          <td><select class="auto-tpl" data-account="${esc(m.accountId)}" aria-label="Template for ${esc(m.email)}">${opts(m.templateId)}</select></td>
          <td class="auto-num" data-label="Last hour">${m.hour} of ${a.limits.perHour}</td>
          <td class="auto-num" data-label="Last 24 h">${m.day} of ${a.limits.perDay}</td>
          <td class="auto-why"><span class="${tone}">${STATUS_TEXT[m.status] || ''}</span><span class="auto-note">${esc(whyText(m))}</span></td>
        </tr>`;
      })
      .join('');
  }

  autoRecent.innerHTML = a.recent.length
    ? a.recent
        .slice(0, 10)
        .map(
          (d) => `<li class="${d.ok ? '' : 'is-bad'}">
          <span class="rc-when">${clockText(d.at)}</span>
          <span class="rc-what">${esc(d.email)} ${d.ok ? 'drafted' : 'failed on'} <span class="rc-title">${esc(d.title || '(untitled)')}</span></span>
          <span class="rc-why">${d.ok ? 'Why: ' + esc(d.reason) : esc(d.error || '')}</span>
        </li>`
        )
        .join('')
    : '<li class="sub">No choices yet. Each draft adds a line here with the reason its mailbox was picked.</li>';

  const stat = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  autoStats.innerHTML =
    stat('Drafted', a.drafted) +
    stat('Waiting to draft', a.pending) +
    stat('Failed', a.failed) +
    stat('Last draft', a.lastDraftAt ? agoText(a.lastDraftAt) : 'none yet');

  autoMsg.classList.toggle('is-bad', false);
  if (a.lastError && Date.now() - Date.parse(a.lastError.at) < 6 * 3600000) {
    autoMsg.textContent = `Last problem, ${agoText(a.lastError.at)}, in ${a.lastError.account}: ${a.lastError.error}`;
    autoMsg.classList.add('is-bad');
  } else {
    autoMsg.textContent = '';
  }
  renderTemplates();
}

async function loadAuto() {
  try {
    renderAuto(await (await fetch('/api/automation')).json());
  } catch {
    /* offline: keep the last state */
  }
}

async function saveAuto(patch) {
  const r = await fetch('/api/automation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || 'Could not save.');
  renderAuto(data);
  return data;
}

autoToggle.addEventListener('click', async () => {
  const on = !(autoData && autoData.enabled);
  if (
    on &&
    !confirm(
      `Turn on automatic drafts?\n\nFrom now on, every newly scraped post with an email and no phone gets a draft, in the mailbox the rules pick (at most ${limitDay.value} per 24 hours and ${limitHour.value} per hour each). Posts already in the list are not drafted. Nothing is ever sent.`
    )
  )
    return;
  autoToggle.disabled = true;
  try {
    const a = await saveAuto({ enabled: on });
    showToast({
      kicker: on ? 'Automatic drafts on' : 'Automatic drafts off',
      title: on ? 'New no-phone posts will be drafted' : 'No new drafts will be made',
      body: on ? (a.next ? `Next mailbox: ${a.next.email}.` : a.waitReason || '') : 'Drafts already made stay in Gmail.',
    });
  } catch (err) {
    showToast({ kicker: 'Not changed', title: 'Automatic drafts', body: err.message, tone: 'bad' });
  } finally {
    autoToggle.disabled = false;
  }
});

async function saveLimits() {
  const perDay = Number(limitDay.value);
  const perHour = Number(limitHour.value);
  if (!autoData || (perDay === autoData.limits.perDay && perHour === autoData.limits.perHour)) return;
  try {
    await saveAuto({ limits: { perDay, perHour } });
    showToast({ kicker: 'Limits saved', title: `${perDay} per 24 hours, ${perHour} per hour`, body: 'For each mailbox, from now on.' });
  } catch (err) {
    showToast({ kicker: 'Limits not saved', title: 'Check the numbers', body: err.message, tone: 'bad' });
    limitDay.value = autoData.limits.perDay;
    limitHour.value = autoData.limits.perHour;
  }
}
limitDay.addEventListener('change', saveLimits);
limitHour.addEventListener('change', saveLimits);

autoRows.addEventListener('change', async (e) => {
  const sel = e.target.closest('.auto-tpl');
  if (!sel) return;
  sel.disabled = true;
  try {
    await saveAuto({ assignments: { [sel.dataset.account]: sel.value || null } });
    const name = sel.value ? sel.options[sel.selectedIndex].text : null;
    showToast({ kicker: 'Template assigned', title: name || 'No template', body: name ? 'This mailbox drafts with it.' : 'This mailbox makes no automatic drafts.' });
  } catch (err) {
    showToast({ kicker: 'Not assigned', title: 'Template', body: err.message, tone: 'bad' });
    loadAuto();
  }
});
if (IS_ADMIN) {
  loadAuto();
  setInterval(loadAuto, 30000);
}

// ---------- Multiselect component ----------
function makeMultiselect(el, items, { valueKey, labelFn, allowAdd, onChange = () => {} }) {
  const selected = new Set();
  let all = items.slice();
  const changed = () => onChange([...selected]);

  el.innerHTML = `
    <div class="ms-search">
      <input type="text" placeholder="Search…" />
      ${allowAdd ? '<button class="ms-add" title="Add custom">+</button>' : ''}
    </div>
    <div class="ms-actions">
      <a href="#" class="ms-all">Select all</a>
      <a href="#" class="ms-none">Clear</a>
      <span class="ms-count">0 selected</span>
    </div>
    <div class="ms-list"></div>`;

  const search = el.querySelector('.ms-search input');
  const listEl = el.querySelector('.ms-list');
  const countEl = el.querySelector('.ms-count');

  function label(it) {
    return labelFn(it);
  }
  function render() {
    const q = search.value.trim().toLowerCase();
    // Selected items first so a restored selection is visible at a glance.
    // (Ticking a box doesn't re-render, so items never jump while clicking.)
    const shown = all
      .filter((it) => !q || label(it).toLowerCase().includes(q) || it[valueKey].includes(q))
      .sort((a, b) => Number(selected.has(b[valueKey])) - Number(selected.has(a[valueKey])));
    listEl.innerHTML = shown
      .map((it) => {
        const v = it[valueKey];
        return `<label class="ms-item"><input type="checkbox" value="${v}" ${
          selected.has(v) ? 'checked' : ''
        }/> ${label(it)}</label>`;
      })
      .join('');
    listEl.querySelectorAll('input').forEach((cb) =>
      cb.addEventListener('change', () => {
        cb.checked ? selected.add(cb.value) : selected.delete(cb.value);
        updateCount();
        changed();
      })
    );
  }
  function updateCount() {
    countEl.textContent = `${selected.size} selected`;
  }

  search.addEventListener('input', render);
  el.querySelector('.ms-all').addEventListener('click', (e) => {
    e.preventDefault();
    const q = search.value.trim().toLowerCase();
    all
      .filter((it) => !q || label(it).toLowerCase().includes(q) || it[valueKey].includes(q))
      .forEach((it) => selected.add(it[valueKey]));
    render();
    updateCount();
    changed();
  });
  el.querySelector('.ms-none').addEventListener('click', (e) => {
    e.preventDefault();
    selected.clear();
    render();
    updateCount();
    changed();
  });
  if (allowAdd) {
    el.querySelector('.ms-add').addEventListener('click', () => {
      const v = (search.value.trim() || prompt('Add area subdomain (e.g. sfbay):') || '').trim();
      if (!v) return;
      if (!all.some((it) => it[valueKey] === v)) all.unshift({ [valueKey]: v, name: v + ' (custom)' });
      selected.add(v);
      search.value = '';
      render();
      updateCount();
      changed();
    });
  }

  render();
  updateCount();
  return {
    values: () => [...selected],
    // Restore a saved selection. Unknown values are re-added as custom entries.
    setValues(vals, { silent = true } = {}) {
      selected.clear();
      for (const v of vals || []) {
        if (!all.some((it) => it[valueKey] === v)) {
          if (!allowAdd) continue;
          all.unshift({ [valueKey]: v, name: v + ' (custom)' });
        }
        selected.add(v);
      }
      render();
      updateCount();
      if (!silent) changed();
    },
  };
}

// ---------- Shared UI state (stored on the server) ----------
// Area/category selections, run parameters, filters and panel states are saved
// on the server (data/settings.json), so every device that opens the page gets
// the same settings, and a change on one device shows up on the others within
// a few seconds. localStorage is only an offline fallback. If a run is active,
// the server's actual areas/categories win on page load.
// Exception: the results-list filters (sent tab, category, state, city, Has
// phone, freshness) are per device — saved in this browser only — so each
// device can filter differently.
const STORE_KEY = 'autoemail.scraper.v1';
const LOCAL_ONLY = ['filters', 'sentFilter'];
const CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36); // this tab
// This browser, across reloads: owns the refresh scope it started.
const DEVICE_ID = (() => {
  try {
    let id = localStorage.getItem('autoemail.deviceId');
    if (!id) localStorage.setItem('autoemail.deviceId', (id = 'd' + Math.random().toString(36).slice(2, 12)));
    return id;
  } catch {
    return CLIENT_ID;
  }
})();
const shared = window.__SHARED_SETTINGS__;
let settingsVersion = shared ? shared.version || 0 : 0;
const localPrefs = (() => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
  } catch {
    return {};
  }
})();
const pickKeys = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
const omitKeys = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !keys.includes(k)));
const sharedPrefs = omitKeys(shared && shared.prefs, LOCAL_ONLY);
const serverHasPrefs = Object.keys(sharedPrefs).length > 0;
// Filters: this browser's own; else (first time) the copy the server used to share.
const localFilters = { ...pickKeys(shared && shared.prefs, LOCAL_ONLY), ...pickKeys(localPrefs, LOCAL_ONLY) };
let prefs = { ...(serverHasPrefs ? sharedPrefs : omitKeys(localPrefs, LOCAL_ONLY)), ...localFilters };
let pendingPatch = {};
let prefsTimer = null;

function cacheLocally() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage unavailable — the server copy is the real one anyway */
  }
}
function writePrefs({ keepalive = false } = {}) {
  clearTimeout(prefsTimer);
  prefsTimer = null;
  cacheLocally();
  const patch = pendingPatch;
  if (!Object.keys(patch).length) return;
  pendingPatch = {};
  fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch, clientId: CLIENT_ID }),
    keepalive,
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
    .then((s) => {
      settingsVersion = Math.max(settingsVersion, s.version || 0);
    })
    .catch(() => {
      // Server unreachable: keep the change and send it with the next save.
      pendingPatch = { ...patch, ...pendingPatch };
      if (!prefsTimer) prefsTimer = setTimeout(writePrefs, 5000);
    });
}
function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  const sharedPart = omitKeys(patch, LOCAL_ONLY);
  if (!Object.keys(sharedPart).length) {
    cacheLocally(); // filters only: this browser, nothing to send
    return;
  }
  pendingPatch = { ...pendingPatch, ...sharedPart };
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(writePrefs, 300);
}
// Don't lose a pending save if the page is reloaded/closed right after a change.
window.addEventListener('pagehide', () => {
  if (prefsTimer) writePrefs({ keepalive: true });
});
cacheLocally(); // keep this browser's filters, even ones taken from the old shared copy
// First device after this update: move its browser-saved settings to the server.
if (shared && !serverHasPrefs && Object.keys(omitKeys(localPrefs, LOCAL_ONLY)).length) savePrefs(omitKeys(localPrefs, LOCAL_ONLY));
// Filters used to be shared: remove the old copy from the server.
if (shared && shared.prefs && LOCAL_ONLY.some((k) => shared.prefs[k] !== undefined)) {
  pendingPatch = { ...pendingPatch, ...Object.fromEntries(LOCAL_ONLY.map((k) => [k, null])) };
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(writePrefs, 300);
}

// Pick up changes saved by other devices.
async function pollSettings() {
  if (document.hidden) return;
  try {
    const s = await (await fetch('/api/settings', { cache: 'no-store' })).json();
    if (!s || (s.version || 0) <= settingsVersion) return;
    settingsVersion = s.version || 0;
    if (s.updatedBy === CLIENT_ID) return; // our own save coming back
    // Unsent local edits win over the incoming copy.
    // Unsent local edits win; this device's own filters are never replaced.
    prefs = { ...omitKeys(s.prefs, LOCAL_ONLY), ...pendingPatch, ...pickKeys(prefs, LOCAL_ONLY) };
    cacheLocally();
    applySharedPrefs();
  } catch {
    /* offline — try again next tick */
  }
}
setInterval(pollSettings, 3000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollSettings();
});

// Put the current `prefs` into every control (used when another device changes
// them). A field the user is typing in right now is left alone.
function applySharedPrefs() {
  const p = prefs.params || {};
  const active = document.activeElement;
  for (const id of PARAM_VALUES) {
    const el = document.getElementById(id);
    if (p[id] !== undefined && el !== active) el.value = p[id];
  }
  for (const id of PARAM_CHECKS) if (p[id] !== undefined) document.getElementById(id).checked = !!p[id];
  if (areasMs && Array.isArray(prefs.areas)) areasMs.setValues(prefs.areas);
  if (catsMs && Array.isArray(prefs.categories)) catsMs.setValues(prefs.categories);
  if (setupEl.open !== (prefs.setupOpen !== false)) setupEl.open = prefs.setupOpen !== false;
  applyTracerMode(!!prefs.tracerFull);
  applyTraceHidden(!!prefs.traceHidden);
  // List filters are per device: left as they are.
  updateRunSentence();
  renderRows();
}

const PARAM_VALUES = ['query', 'concurrency', 'maxProxiesPerPost', 'replyWait', 'pageTimeout', 'cycleDelay'];
const PARAM_CHECKS = ['loop', 'useProxies', 'headless'];
function readParams() {
  const p = {};
  for (const id of PARAM_VALUES) p[id] = document.getElementById(id).value;
  for (const id of PARAM_CHECKS) p[id] = document.getElementById(id).checked;
  return p;
}
(function restoreParams() {
  const p = prefs.params || {};
  for (const id of PARAM_VALUES) if (p[id] !== undefined) document.getElementById(id).value = p[id];
  for (const id of PARAM_CHECKS) if (p[id] !== undefined) document.getElementById(id).checked = !!p[id];
  for (const id of [...PARAM_VALUES, ...PARAM_CHECKS]) {
    const el = document.getElementById(id);
    const onEdit = () => {
      savePrefs({ params: readParams() });
      updateRunSentence();
    };
    el.addEventListener('input', onEdit);
    el.addEventListener('change', onEdit);
  }
})();

// ---------- Areas / categories ----------
const areaMeta = new Map(); // sub -> { name, city, state }
let catMeta = new Map(); // code -> name
const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas',
  KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico',
  NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma',
  OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};

let areasMs, catsMs;
(async () => {
  const areas = await (await fetch('/api/areas')).json();
  const cats = await (await fetch('/api/categories')).json();
  for (const a of areas) areaMeta.set(a.sub, a);
  catMeta = new Map(cats.map((c) => [c.code, c.name]));

  const persistSelection = () => {
    savePrefs({ areas: areasMs.values(), categories: catsMs.values() });
    updateRunSentence();
  };
  areasMs = makeMultiselect(document.getElementById('ms-areas'), areas, {
    valueKey: 'sub',
    labelFn: (a) => `${a.name} (${a.sub})`,
    allowAdd: true,
    onChange: persistSelection,
  });
  catsMs = makeMultiselect(document.getElementById('ms-categories'), cats, {
    valueKey: 'code',
    labelFn: (c) => `${c.name} [${c.code}] · ${c.group}`,
    allowAdd: false,
    onChange: persistSelection,
  });

  // Restore: server's live run first, else the last saved selection.
  let live = null;
  try {
    const s = await (await fetch('/api/status')).json();
    if (s.running && s.areas && s.areas.length) live = s;
  } catch {
    /* fall back to saved */
  }
  areasMs.setValues(live ? live.areas : prefs.areas || []); // unknown values come back as custom areas
  catsMs.setValues(live ? live.categories : prefs.categories || []);
  updateRunSentence();
  renderRows(); // location names are available now
})();

// The folded setup bar reads as one sentence describing the configured run.
function updateRunSentence() {
  const el = document.getElementById('runSentence');
  if (!el || !areasMs || !catsMs) return;
  const a = areasMs.values();
  const c = catsMs.values();
  if (!a.length) {
    el.textContent = 'Pick areas and categories to start.';
    return;
  }
  const esc2 = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  const areaPart = a.length <= 2 ? a.map((s) => (areaMeta.get(s) || { city: s }).city).join(' and ') : `${a.length} areas`;
  const catNames = c.map((code) => String(catMeta.get(code) || code).replace(/^all\s+/i, '').toLowerCase());
  const catPart = !c.length ? 'for-sale posts' : c.length <= 2 ? catNames.join(' and ') : `${c.length} categories`;
  const p = readParams();
  const ipPart = p.useProxies ? 'through the proxy pool' : 'on your own IP';
  const loopPart = p.loop ? `, repeating every ${p.cycleDelay || 45}s` : ', once';
  const visPart = p.headless ? '' : ' with the browser visible';
  el.innerHTML = `Scrape <b>${esc2(catPart)}</b> in <b>${esc2(areaPart)}</b> using <b>${esc2(p.concurrency || 1)} workers</b> ${ipPart}${loopPart}${visPart}.`;
}

// Setup panel: remember open/closed; folds itself when a run starts.
const setupEl = document.getElementById('setup');
if (prefs.setupOpen === false) setupEl.open = false;
setupEl.addEventListener('toggle', () => {
  if (setupEl.open === (prefs.setupOpen !== false)) return; // already saved (e.g. applied from another device)
  savePrefs({ setupOpen: setupEl.open });
});

// Telemetry strip: compact (one row) or all stats.
const tracerEl = document.getElementById('tracer');
const tracerToggle = document.getElementById('tracerToggle');
function applyTracerMode(full) {
  tracerEl.classList.toggle('compact', !full);
  tracerToggle.textContent = full ? 'Fewer stats' : 'All stats';
  tracerToggle.setAttribute('aria-expanded', String(full));
}
applyTracerMode(!!prefs.tracerFull);
tracerToggle.addEventListener('click', () => {
  const full = tracerEl.classList.contains('compact');
  applyTracerMode(full);
  savePrefs({ tracerFull: full });
});

// ---------- Tracer ----------
function fmtBytes(n) {
  if (!n) return '–';
  const mb = n / 1048576;
  return mb > 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(1) + ' MB';
}
function fmtDur(ms) {
  if (!ms) return '–';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h ? h + 'h ' : ''}${m ? m + 'm ' : ''}${s % 60}s`;
}
// Success rate of the last post visits (server: accuracy()). Low: the card
// turns red with the cause, and the top bar shows an alert.
// Why it is low: the failing share, named, so it never reads as the rate itself.
const RATE_CAUSE = {
  proxies: [(a) => `${Math.round((a.net / a.tries) * 100)}% proxy errors`, 'Most visits fail because the proxy cannot load the post. Refresh proxies or wait for verified ones.'],
  captcha: [(a) => `${Math.round((a.gated / a.tries) * 100)}% captcha`, 'Most visits hit a captcha. Proxies are being cooled; fewer workers may help.'],
  none: [() => 'pages load, nothing found', 'Pages load but no contact shows. Check the reply wait time.'],
};
function renderAccuracy(s) {
  const a = s.accuracy;
  const card = document.getElementById('stat-rate');
  const val = document.getElementById('t-rate');
  const why = document.getElementById('t-rate-why');
  const alertEl = document.getElementById('bar-alert');
  if (!a || !a.tries) {
    val.textContent = '–';
    card.classList.remove('is-low');
    why.hidden = true;
    alertEl.hidden = true;
    return;
  }
  const pct = Math.round(a.rate * 1000) / 10;
  const caught = a.relay + a.contact;
  val.textContent = `${pct}%`;
  const detail = `Success rate: ${pct}% of the last ${a.tries} visits caught a contact. ${a.relay} relays, ${a.contact} phone or email only, ${a.net} proxy failures, ${a.gated} captcha, ${a.noReply} no reply button, ${a.tries - caught - a.net - a.gated - a.noReply} nothing caught.`;
  card.title = detail;
  const low = a.low && s.running;
  card.classList.toggle('is-low', low);
  why.hidden = !low;
  const [cause, advice] = RATE_CAUSE[a.cause] || [() => '', ''];
  why.textContent = low ? cause(a) : '';
  if (low) card.title = `${detail} ${advice}`;
  alertEl.hidden = !low;
  if (low) {
    alertEl.innerHTML = `Low success <b>${pct}%</b>`;
    alertEl.title = `${detail} ${advice}`;
  }
}

async function pollStatus() {
  try {
    const s = await (await fetch('/api/status')).json();
    document.getElementById('t-status').textContent = s.running ? 'Running' : 'Idle';
    document.getElementById('tracer').classList.toggle('running', !!s.running);
    if (typeof setRunButtons === 'function') setRunButtons(!!s.running);
    if ((s.running || s.refresh.running || (s.postScrapes && s.postScrapes.active)) && typeof attachEvents === 'function') attachEvents();
    renderRefresh(s.refresh);
    applyPostScrapes(s.postScrapes);
    // topbar live strip
    const strip = document.getElementById('livestrip');
    strip.classList.toggle('running', !!s.running);
    document.getElementById('bar-status').textContent = s.running ? 'Running' : 'Idle';
    renderAccuracy(s);
    document.getElementById('bar-workers').textContent = `${s.activeWorkers}/${s.concurrency}`;
    document.getElementById('bar-queue').textContent = s.queueRemaining;
    document.getElementById('bar-stored').textContent = s.stored;
    document.getElementById('bar-ram').textContent = fmtBytes(s.memory.rss);
    document.getElementById('t-workers').textContent = `${s.activeWorkers} / ${s.concurrency}`;
    document.getElementById('t-queue').textContent = `${s.queueRemaining} / ${s.queueTotal}`;
    document.getElementById('t-attempts').textContent = s.attempts;
    document.getElementById('t-cycles').textContent = s.cycles ?? 0;
    document.getElementById('t-seen').textContent = s.seenTotal ?? 0;
    document.getElementById('t-stored').textContent = s.stored;
    document.getElementById('t-relays').textContent = s.relaysCaught ?? 0;
    document.getElementById('t-dropped').textContent = s.dropped;
    document.getElementById('t-parked').textContent = s.parked ?? 0;
    document.getElementById('t-gated').textContent = s.gated ?? 0;
    document.getElementById('t-solver').textContent = s.solver;
    document.getElementById('t-proxu').textContent = s.proxies.usable ?? 0;
    document.getElementById('t-proxlive').textContent = s.proxies.live ?? 0;
    document.getElementById('t-proxs').textContent = s.proxies.stored;
    document.getElementById('t-proxcool').textContent = s.proxies.cooled ?? 0;
    document.getElementById('t-proxfresh').textContent = s.proxyFresh ?? 0;
    document.getElementById('t-proxrelax').textContent = s.proxyRelax ?? 0;
    document.getElementById('t-newq').textContent = s.queueNew ?? 0;
    document.getElementById('t-autoref').textContent = s.autoRefreshes
      ? `${s.autoRefreshes}× · ${fmtAge(new Date(s.lastAutoRefreshAt).toISOString())}`
      : 'none yet';
    document.getElementById('t-contacts').textContent = s.contacts.total;
    document.getElementById('t-ram').textContent = fmtBytes(s.memory.rss);
    document.getElementById('t-heap').textContent = fmtBytes(s.memory.heapUsed);
    document.getElementById('t-uptime').textContent = s.running ? fmtDur(s.uptimeMs) : '–';
    document.getElementById('t-scope').textContent = `${s.areas.length} / ${s.categories.length}`;
  } catch {
    /* ignore */
  }
}
function renderRefresh(r) {
  const on = r.running && !r.stopping;
  document.getElementById('refreshToggle').checked = on;
  const stateEl = document.getElementById('r-state');
  stateEl.textContent = r.stopping ? 'stopping…' : on ? `${r.activeWorkers}/${r.workers} workers` : r.error ? `stopped: ${r.error}` : 'off';
  stateEl.classList.toggle('on', on);
  stateEl.classList.toggle('bad', !on && !!r.error);
  lastRefreshScope = r.running ? r.scope : null;
  refreshOwner = r.running && r.scope ? r.scope.owner : null;
  renderScope();
  document.getElementById('r-fresh').textContent = r.counts.fresh;
  document.getElementById('r-unverified').textContent = r.counts.unverified;
  document.getElementById('r-expired').textContent = r.counts.expired;
  document.getElementById('r-unchecked').textContent = r.counts.unchecked;
  document.getElementById('r-changes').textContent = r.counts.relayChanges;
  const paused = r.sweep.pausedUntil > Date.now();
  document.getElementById('r-sweep').textContent = r.sweep.running
    ? `expiry sweep ${r.sweep.done}/${r.sweep.total}${paused ? ' (paused)' : ''}`
    : '';
}

setInterval(pollStatus, 2000);
pollStatus();

// ---------- Contacts table ----------
let filter = 'all';
const tbody = document.querySelector('#scrapeTable tbody');
const stateFilterEl = document.getElementById('stateFilter');
const cityFilterEl = document.getElementById('cityFilter');
let stateFilter = (prefs.filters && prefs.filters.state) || '';
let cityFilter = (prefs.filters && prefs.filters.city) || '';
cityFilterEl.value = cityFilter;
const phoneOnlyEl = document.getElementById('phoneOnly');
let phoneOnly = !!(prefs.filters && prefs.filters.phoneOnly);
phoneOnlyEl.checked = phoneOnly;
const catFilterEl = document.getElementById('catFilter');
let catFilter = (prefs.filters && prefs.filters.category) || '';
const freshFilterEl = document.getElementById('freshFilter');
let freshFilter = (prefs.filters && prefs.filters.freshness) || '';
freshFilterEl.value = freshFilter;
// Posted date range (calendar inputs), as local days. The bounds in ms go to
// the server too, for the relay refresh scope.
const dateFromEl = document.getElementById('dateFrom');
const dateToEl = document.getElementById('dateTo');
const dateClearEl = document.getElementById('dateClear');
let dateFrom = (prefs.filters && prefs.filters.dateFrom) || '';
let dateTo = (prefs.filters && prefs.filters.dateTo) || '';
dateFromEl.value = dateFrom;
dateToEl.value = dateTo;
function dayStart(v, next = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3] + next).getTime() : null;
}
const dayEnd = (v) => (dayStart(v) === null ? null : dayStart(v, 1) - 1);
let postedFrom = dayStart(dateFrom);
let postedTo = dayEnd(dateTo);
function onDateChange() {
  dateFrom = dateFromEl.value;
  dateTo = dateToEl.value;
  if (dateFrom && dateTo && dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  dateFromEl.value = dateFrom;
  dateToEl.value = dateTo;
  dateToEl.min = dateFrom || '';
  dateFromEl.max = dateTo || '';
  postedFrom = dayStart(dateFrom);
  postedTo = dayEnd(dateTo);
  dateClearEl.hidden = !dateFrom && !dateTo;
  saveFilters();
  renderRows();
}
dateClearEl.hidden = !dateFrom && !dateTo;
dateFromEl.addEventListener('change', onDateChange);
dateToEl.addEventListener('change', onDateChange);
dateClearEl.addEventListener('click', () => {
  dateFromEl.value = '';
  dateToEl.value = '';
  onDateChange();
});
function matchesPosted(r) {
  if (postedFrom === null && postedTo === null) return true;
  const t = r.postedAt ? Date.parse(r.postedAt) : NaN;
  if (!Number.isFinite(t)) return false;
  return (postedFrom === null || t >= postedFrom) && (postedTo === null || t <= postedTo);
}
function saveFilters() {
  savePrefs({ filters: { state: stateFilter, city: cityFilter, phoneOnly, category: catFilter, freshness: freshFilter, dateFrom, dateTo, postedFrom, postedTo } });
  pushRefreshScope();
}

// --- Relay refresh scope: the list as THIS device filters it ---------------
// The device that turns refresh on owns its scope; while it runs, that
// device's filter changes (including the phone search) move the scope with it.
function currentScope() {
  return { filters: prefs.filters || {}, sentFilter: prefs.sentFilter || 'all', phone: phoneQuery || '' };
}
let refreshOwner = null; // DEVICE_ID that owns the running refresh, from /api/status
let lastRefreshScope = null; // server's scope while refresh runs
let localScopeCount = 0; // unsent, not-red, not-expired posts in this device's list
function renderScope() {
  const el = document.getElementById('r-scope');
  if (!el) return;
  const s = lastRefreshScope;
  if (s) {
    const who = s.owner === DEVICE_ID ? "this device's list" : "another device's list";
    el.innerHTML = `checking <b>${s.count}</b> in ${who}`;
    el.title = s.owner === DEVICE_ID
      ? 'Refresh follows the filters on this device.'
      : 'Refresh follows the filters of the device that turned it on. Turn it off and on here to use this list.';
  } else {
    el.innerHTML = `<b>${localScopeCount}</b> in this list`;
    el.title = 'Turning refresh on here checks the unsent posts this list shows; its filters set the scope.';
  }
}
let scopeTimer = null;
function pushRefreshScope() {
  if (refreshOwner !== DEVICE_ID) return;
  clearTimeout(scopeTimer);
  scopeTimer = setTimeout(() => {
    fetch('/api/refresh/scope', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: currentScope(), deviceId: DEVICE_ID }),
    }).catch(() => {});
  }, 400);
}
freshFilterEl.addEventListener('change', () => {
  freshFilter = freshFilterEl.value;
  saveFilters();
  renderRows();
});

// Category dropdown lists only categories present in the stored results, with counts.
function rebuildCategoryOptions() {
  const counts = new Map();
  for (const r of viewRows()) counts.set(r.category || '', (counts.get(r.category || '') || 0) + 1);
  const codes = [...counts.keys()].filter(Boolean).sort((a, b) =>
    String(catMeta.get(a) || a).localeCompare(String(catMeta.get(b) || b))
  );
  const html = ['<option value="">All categories</option>']
    .concat(codes.map((c) => `<option value="${esc(c)}">${esc(catMeta.get(c) || c)} (${counts.get(c)})</option>`))
    .join('');
  if (catFilterEl.dataset.html !== html) {
    catFilterEl.innerHTML = html;
    catFilterEl.dataset.html = html;
  }
  catFilterEl.value = catFilter;
  if (catFilterEl.value !== catFilter) catFilterEl.value = ''; // saved category no longer present
}
catFilterEl.addEventListener('change', () => {
  catFilter = catFilterEl.value;
  saveFilters();
  renderRows();
});

function locOf(r) {
  const m = areaMeta.get(r.area);
  return m ? m : { name: r.area || '', city: r.area || '', state: '' };
}

// State dropdown lists only states present in the stored results, with counts.
function rebuildStateOptions() {
  const counts = new Map();
  for (const r of viewRows()) {
    const st = locOf(r).state || '';
    counts.set(st, (counts.get(st) || 0) + 1);
  }
  const states = [...counts.keys()].filter(Boolean).sort((a, b) =>
    (STATE_NAMES[a] || a).localeCompare(STATE_NAMES[b] || b)
  );
  const opts = ['<option value="">All states</option>']
    .concat(states.map((st) => `<option value="${st}">${esc(STATE_NAMES[st] || st)} (${counts.get(st)})</option>`))
    .concat(counts.has('') ? [`<option value="__other">Other areas (${counts.get('')})</option>`] : []);
  const html = opts.join('');
  if (stateFilterEl.dataset.html !== html) {
    stateFilterEl.innerHTML = html;
    stateFilterEl.dataset.html = html;
  }
  stateFilterEl.value = stateFilter;
  if (stateFilterEl.value !== stateFilter) stateFilterEl.value = ''; // saved state no longer present
}

function matchesLocation(r) {
  const loc = locOf(r);
  if (stateFilter === '__other') {
    if (loc.state) return false;
  } else if (stateFilter && loc.state !== stateFilter) return false;
  if (cityFilter) {
    const q = cityFilter.toLowerCase();
    if (!`${loc.name} ${r.area || ''}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

stateFilterEl.addEventListener('change', () => {
  stateFilter = stateFilterEl.value;
  saveFilters();
  renderRows();
});
cityFilterEl.addEventListener('input', () => {
  cityFilter = cityFilterEl.value.trim();
  saveFilters();
  renderRows();
});
phoneOnlyEl.addEventListener('change', () => {
  phoneOnly = phoneOnlyEl.checked;
  saveFilters();
  renderRows();
});

// Phone lookup: matches any stored phone containing the typed digits, so
// "(555) 123-4567", "555.123", "+1 555 123 4567" and "4567" all work. Stored
// phones are bare 10-digit strings. Not saved to prefs — it's a one-off lookup.
const phoneFilterEl = document.getElementById('phoneFilter');
let phoneQuery = '';
function phoneDigits(raw) {
  const s = String(raw || '').trim();
  let d = s.replace(/\D/g, '');
  // Drop the country code: a full 11-digit 1XXXXXXXXXX, or an explicit "+1"/"1 " prefix.
  if ((d.length === 11 && d[0] === '1') || /^\+1|^1[\s.\-(]/.test(s)) d = d.slice(1);
  return d;
}
function matchesPhone(r) {
  if (!phoneQuery) return true;
  return (r.phones || []).some((p) => String(p).replace(/\D/g, '').includes(phoneQuery));
}
phoneFilterEl.addEventListener('input', () => {
  phoneQuery = phoneDigits(phoneFilterEl.value);
  renderRows();
  pushRefreshScope();
});

// --- Rendering: batched, windowed, delegated ---------------------------------
// renderRows() only schedules a paint (once per animation frame), so a burst
// of events costs one paint. The filtered + sorted list is kept in memory and
// only the first `renderLimit` rows go into the DOM; more are added as the
// sentinel row scrolls into view. Row buttons use one delegated listener.
const PAGE_ROWS = 200;
let renderLimit = PAGE_ROWS;
let renderQueued = false;
let lastFilterKey = '';
function renderRows() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    paintRows();
  });
}

// Data version: bumped on every change to rows/listedPosts.
let dataVer = 0;
function dataChanged() {
  dataVer++;
  saveListCache();
  renderRows();
}

let sortedMemo = { ver: -1, list: [] };
const postedKey = (r) => (r.postedAt ? Date.parse(r.postedAt) || -Infinity : -Infinity);
function sortedAll() {
  // Newest posted first; rows without a posted date go last. Sorted once per
  // data change, not per filter change or paint.
  if (sortedMemo.ver !== dataVer) {
    const list = viewRows().slice();
    for (const r of list) r._pk = postedKey(r);
    list.sort((a, b) => b._pk - a._pk);
    sortedMemo = { ver: dataVer, list };
  }
  return sortedMemo.list;
}

function rowHtml(r) {
  const loc = locOf(r);
  const title = esc(r.title || '(untitled)');
  const post = r.url
    ? `<a class="title-clamp" href="${esc(r.url)}" target="_blank" rel="noopener" title="${title}">${title}</a>`
    : `<span class="title-clamp" title="${title}">${title}</span>`;
  const others = (r.emails || []).filter((e) => e !== r.relay && !/craigslist\.org$/i.test(e));
  const relay = r.relay
    ? `<button type="button" class="relay-copy" data-copy="${esc(r.relay)}" title="${esc(r.relay)} — click to copy">${esc(shortRelay(r.relay))}</button>`
    : pencilCell(r, 'relay');
  const phones = (r.phones || []).length
    ? r.phones
        .map(
          (p) =>
            `<span class="phone-line">${fmtPhone(p)}<button type="button" class="phone-copy" data-id="${r.id}" data-phone="${esc(p)}" title="Copy and mark sent" aria-label="Copy ${esc(p)} and mark sent">${COPY_ICON}</button></span>`
        )
        .join('')
    : pencilCell(r, 'phone');
  // Rows are addressed by id (contacts) or url (listed posts not scraped yet).
  const key = r.id ? `data-id="${r.id}"` : `data-url="${esc(r.url)}"`;
  const sentCell = `<input type="checkbox" class="sent-cb" ${key} ${r.sent ? 'checked' : ''} aria-label="Mark sent"/>`;
  // A running job keeps its progress and stop button even after a visit stored
  // the ad's phone (the row is then no longer "not scraped").
  const job = r.url ? postJobs.get(r.url) : null;
  const checked = job
    ? `<span class="post-scraping">Scraping… ${job.tried} ${job.tried === 1 ? 'proxy' : 'proxies'}</span>`
    : !r.unscraped
      ? fmtChecked(r)
      : '<span class="posted-none">Not scraped</span>';
  // Any unsent post without a relay yet can be scraped now.
  const play = r.url && !r.sent && (job || !r.relay) ? playButton(r.url, job) : '';
  const flagLabel = r.flagged ? 'Clear the red mark' : 'Mark this row red';
  const del = `<button class="del-row${r.flagged ? ' on' : ''}" ${key} data-flagged="${r.flagged ? 1 : 0}" title="${flagLabel}" aria-label="${flagLabel}" aria-pressed="${r.flagged ? 'true' : 'false'}">✕</button>`;
  const note = r.unscraped ? '' : `${r.captchaBlocked ? 'captcha ' : ''}${r.manual ? 'filled by hand ' : ''}${r.note || ''}`;
  const cls = [r.unscraped ? 'row-unscraped' : '', r.flagged ? 'row-flagged' : ''].filter(Boolean).join(' ');
  return `<tr${cls ? ` class="${cls}"` : ''}>
      <td>${sentCell}</td>
      <td><span class="loc-name">${esc(loc.name)}</span><span class="loc-sub">${esc(r.area || '')} / ${esc(r.category || '')}</span></td>
      <td>${fmtPosted(r.postedAt)}</td>
      <td>${post}</td>
      <td>${relay}${draftChip(r)}</td>
      <td>${checked}</td>
      <td>${phones}</td>
      <td>${others.map(esc).join('<br>')}</td>
      <td><span class="note-clamp">${esc(note.trim())}</span></td>
      <td><span class="row-actions">${play}${del}</span></td></tr>`;
}

// The automatic draft made for this post: Drafted while it waits in Drafts,
// Sent once it left Drafts (or the row is marked sent).
function draftChip(r) {
  const d = r.autoDraft;
  if (!d || !d.draftId) return '';
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const box = esc(d.account || '');
  if (d.status === 'sent' || d.status === 'gone' || r.sent)
    return `<span class="draft-chip is-sent" title="Sent from ${box}${d.sentAt ? ' (left Drafts ' + esc(when(d.sentAt)) + ')' : ''}.">Sent</span>`;
  return `<span class="draft-chip" title="Draft made in ${box}${d.at ? ' on ' + esc(when(d.at)) : ''}. Review and send it from Gmail.">Drafted</span>`;
}

let currentFiltered = [];
function paintRows() {
  rebuildStateOptions();
  rebuildCategoryOptions();
  const effCat = catFilterEl.value; // '' if the saved category isn't present
  // All: every listed post (scraped or not) · Scraped: contacts · Unsent: All
  // minus sent · Sent: contacts marked sent.
  const all = sortedAll();
  const filtered = all.filter(
    (r) =>
      (filter === 'all' ? true : filter === 'scraped' ? !r.unscraped : filter === 'sent' ? r.sent : !r.sent) &&
      (!effCat || r.category === effCat) &&
      (!phoneOnly || (r.phones && r.phones.length > 0)) &&
      (!freshFilter || (!r.sent && !r.unscraped && (r.refreshStatus || 'unchecked') === freshFilter)) && // sent: no freshness
      matchesLocation(r) &&
      matchesPosted(r) &&
      matchesPhone(r)
  );
  currentFiltered = filtered;
  // A filter change starts the window over at the top; a data change keeps it.
  const filterKey = [filter, effCat, phoneOnly, freshFilter, stateFilter, cityFilter, phoneQuery, postedFrom, postedTo].join('|');
  if (filterKey !== lastFilterKey) {
    lastFilterKey = filterKey;
    renderLimit = PAGE_ROWS;
  }
  // What relay refresh would check if this device turned it on now.
  localScopeCount = filtered.filter((r) => !r.unscraped && !r.sent && !r.flagged && r.url && r.refreshStatus !== 'expired').length;
  renderScope();
  const shown = filtered.slice(0, renderLimit);
  const more = filtered.length - shown.length;
  tbody.innerHTML =
    shown.map(rowHtml).join('') +
    (more > 0
      ? `<tr class="more-row"><td colspan="10"><button type="button" class="btn btn--quiet btn--sm more-btn">Show ${Math.min(PAGE_ROWS, more)} more (${more} left)</button></td></tr>`
      : '');
  const sentinel = tbody.querySelector('.more-row');
  if (sentinel) moreObserver.observe(sentinel);
  document.getElementById('rowCount').textContent =
    filtered.length === all.length
      ? `${all.length} posts · ${rows.length} scraped`
      : `${filtered.length} of ${all.length} posts · ${rows.length} scraped`;
  const empty = document.getElementById('emptyState');
  if (empty) {
    empty.hidden = filtered.length > 0;
    empty.textContent = all.length
      ? phoneQuery
        ? 'No contacts match this phone number with the current filters. Set the other filters to All to search every record.'
        : 'No contacts match these filters. Clear the posted date, category, state, city, freshness or Has phone filter to see all.'
      : 'No posts yet. Pick areas and start a scrape — listed posts appear here, and their contacts fill in as they are scraped.';
  }
}

// Add the next page of rows (scroll reached the end, or "Show more").
function showMoreRows() {
  if (renderLimit >= currentFiltered.length) return;
  renderLimit += PAGE_ROWS;
  renderRows();
}
const moreObserver = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        moreObserver.disconnect();
        showMoreRows();
      }
    }
  },
  { rootMargin: '400px' }
);

// One listener for every row button (rows are re-created on each paint).
tbody.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t || !tbody.contains(t)) return;
  if (t.classList.contains('more-btn')) return showMoreRows();
  if (t.classList.contains('phone-copy')) return copyPhone(t);
  if (t.classList.contains('pencil')) return openManualEditor(t);
  if (t.classList.contains('post-scrape')) return togglePostScrape(t);
  if (t.classList.contains('relay-copy')) {
    try {
      await navigator.clipboard.writeText(t.dataset.copy);
      const prev = t.textContent;
      t.textContent = 'Copied';
      t.classList.add('copied');
      setTimeout(() => {
        t.textContent = prev;
        t.classList.remove('copied');
      }, 1200);
    } catch {
      window.prompt('Copy relay email:', t.dataset.copy);
    }
    return;
  }
  if (t.classList.contains('del-row')) {
    // ✕ toggles a red mark on the row (the record is kept).
    const on = t.dataset.flagged !== '1';
    await saveFlags(t.dataset, { flagged: on }, 'Red mark');
  }
});
// Save the sent box / red mark of a row: a contact by id, or a listed post
// that isn't scraped yet by url (the server makes it a contact). Contacts
// update at once and are undone if the server refuses.
async function saveFlags({ id, url }, flags, what) {
  const row = id ? rows.find((r) => r.id === id) : null;
  const before = row ? Object.fromEntries(Object.keys(flags).map((k) => [k, row[k]])) : null;
  if (row) {
    Object.assign(row, flags);
    dataChanged();
  }
  const res = await fetch(id ? `/api/contacts/${id}` : '/api/posts/flags', {
    method: id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(id ? flags : { url, ...flags }),
  }).catch(() => null);
  const data = res && res.ok ? await res.json().catch(() => null) : null;
  if (!data || !data.row) {
    if (row) {
      Object.assign(row, before);
      dataChanged();
    } else renderRows(); // puts an unscraped row's box back
    showToast({ kicker: 'Not saved', title: what, body: 'The server did not accept the change.', tone: 'bad' });
    return;
  }
  applyContactRows([data.row]);
}
tbody.addEventListener('change', (e) => {
  const cb = e.target;
  if (!cb.classList || !cb.classList.contains('sent-cb')) return;
  saveFlags(cb.dataset, { sent: cb.checked }, 'Sent flag');
});
// Posted date: "Sep 15" (+ year if not this year), age underneath, full time on hover.
function fmtPosted(iso) {
  if (!iso) return '<span class="posted-none">–</span>';
  const d = new Date(iso);
  if (isNaN(d)) return '<span class="posted-none">–</span>';
  const now = new Date();
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  const days = Math.floor((now - d) / 86400000);
  const age = days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
  return `<span class="posted-date" title="${esc(d.toLocaleString())}">${esc(d.toLocaleDateString(undefined, opts))}</span><span class="posted-age">${age}</span>`;
}

// Freshness badge plus the age of the last check; the hover gives relay age.
function fmtAge(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
  const days = Math.floor(mins / 1440);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
function fmtChecked(r) {
  if (r.sent) return '<span class="posted-none" title="Sent contacts are not freshness-checked">—</span>';
  if (!r.refreshStatus) return '<span class="posted-none">Not checked</span>';
  const labels = { fresh: 'Fresh', unverified: 'Unverified', expired: 'Expired' };
  const hover = r.relayCheckedAt
    ? `Relay last confirmed ${new Date(r.relayCheckedAt).toLocaleString()}`
    : 'Relay never confirmed from a live page';
  const age = r.checkedAt ? `<span class="posted-age">${fmtAge(r.checkedAt)}</span>` : '';
  return `<span class="fresh-badge ${esc(r.refreshStatus)}" title="${esc(hover)}">${esc(labels[r.refreshStatus] || r.refreshStatus)}</span>${age}`;
}

// "473b978176cb370cafac3287d23f8c53@res.craigslist.org" -> "473b97…8c53@res.craigslist.org"
function shortRelay(addr) {
  const [local, domain] = String(addr).split('@');
  if (!domain || local.length <= 12) return addr;
  return `${local.slice(0, 6)}…${local.slice(-4)}@${domain}`;
}
function fmtPhone(p) {
  const d = String(p).replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : esc(p);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// --- Phone copy: copies the number, shows a toast, marks the row sent ---
const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';

// Same "(555) 123-4567" form the table shows.
function phoneText(p) {
  const d = String(p).replace(/\D/g, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p);
}

// Clipboard API needs a secure context (localhost is one; a LAN IP over http
// is not), so fall back to a hidden textarea + execCommand.
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

const toastsEl = document.getElementById('toasts');
const TOAST_MS = 4000;
const TOAST_MAX = 3;
function showToast({ kicker, title, body, tone = 'ok' }) {
  const el = document.createElement('div');
  el.className = `toast ${tone}`;
  el.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
  const k = document.createElement('div');
  k.className = 'toast-kicker';
  k.textContent = kicker;
  const t = document.createElement('div');
  t.className = 'toast-title';
  t.textContent = title;
  const b = document.createElement('div');
  b.className = 'toast-body';
  b.textContent = body;
  el.append(k, t, b);
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  const timer = setTimeout(dismiss, TOAST_MS);
  el.addEventListener('click', dismiss);
  toastsEl.appendChild(el);
  while (toastsEl.children.length > TOAST_MAX) toastsEl.firstElementChild.remove();
}

async function copyPhone(btn) {
  const row = rows.find((r) => r.id === btn.dataset.id);
  const text = phoneText(btn.dataset.phone);
  const adTitle = (row && row.title) || '(untitled)';
  if (!(await copyText(text))) {
    showToast({ kicker: 'Copy failed · not marked sent', title: text, body: 'The browser blocked clipboard access. Copy the number by hand.', tone: 'bad' });
    return;
  }
  if (!row || row.sent) {
    showToast({ kicker: 'Copied', title: text, body: adTitle });
    return;
  }
  let marked = false;
  try {
    const res = await fetch(`/api/contacts/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sent: true }),
    });
    marked = res.ok;
  } catch {
    /* reported below */
  }
  if (marked) {
    row.sent = true;
    dataChanged();
    showToast({ kicker: 'Copied · marked sent', title: text, body: adTitle });
  } else {
    showToast({ kicker: "Copied · couldn't mark sent", title: text, body: adTitle, tone: 'bad' });
  }
}
function upsertRow(row) {
  applyContactRows([row]);
}

function setSentFilter(value) {
  filter = value;
  document.querySelectorAll('.filter').forEach((x) => x.classList.toggle('active', x.dataset.filter === value));
}
setSentFilter(prefs.sentFilter || 'all');
document.querySelectorAll('.filter').forEach((b) =>
  b.addEventListener('click', () => {
    setSentFilter(b.dataset.filter);
    savePrefs({ sentFilter: b.dataset.filter });
    renderRows();
    pushRefreshScope();
  })
);

// --- List cache --------------------------------------------------------------
// The page keeps the WHOLE list (every contact + every listed post) in memory
// and in IndexedDB; filtering happens here, never on the server. On open it
// paints from IndexedDB at once, then asks the server only for what changed
// (/api/sync with the last epoch/rev it has). Polled every few seconds and
// after scrape events, so other devices' changes show up without a reload.
let rows = []; // contacts
let listedPosts = []; // listed posts (the server's whole list; scraped ones are hidden by viewRows)
const listState = { ce: '', cr: 0, pe: '', pr: 0 };
const SYNC_MS = 4000;

function applyContactRows(changed, deletedIds = []) {
  if (!changed.length && !deletedIds.length) return false;
  const byId = new Map(rows.map((r, i) => [r.id, i]));
  for (const r of changed) {
    const i = byId.get(r.id);
    if (i !== undefined) rows[i] = r;
    else {
      // A row sent by a scrape event has no id match yet if it's new.
      const j = rows.findIndex((x) => x.url === r.url);
      if (j >= 0) rows[j] = { ...rows[j], ...r };
      else rows.push(r);
    }
  }
  if (deletedIds.length) {
    const gone = new Set(deletedIds);
    rows = rows.filter((r) => !gone.has(r.id));
  }
  dataChanged();
  return true;
}

function applyPostRows(changed, removedUrls = []) {
  if (!changed.length && !removedUrls.length) return false;
  const byUrl = new Map(listedPosts.map((p, i) => [p.url, i]));
  for (const p of changed) {
    const i = byUrl.get(p.url);
    if (i !== undefined) listedPosts[i] = p;
    else listedPosts.push(p);
  }
  if (removedUrls.length) {
    const gone = new Set(removedUrls);
    listedPosts = listedPosts.filter((p) => !gone.has(p.url));
  }
  dataChanged();
  return true;
}

let syncing = null;
async function syncList() {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const q = new URLSearchParams(listState).toString();
      const res = await fetch('/api/sync?' + q, { cache: 'no-store' });
      if (!res.ok) return;
      const d = await res.json();
      let changed = false;
      if (d.contacts.full) {
        rows = d.contacts.rows;
        changed = true;
      } else changed = applyContactRows(d.contacts.rows, d.contacts.deleted) || changed;
      if (d.posts.full) {
        listedPosts = d.posts.rows;
        changed = true;
      } else changed = applyPostRows(d.posts.rows, d.posts.removed) || changed;
      Object.assign(listState, { ce: d.contacts.epoch, cr: d.contacts.rev, pe: d.posts.epoch, pr: d.posts.rev });
      if (changed) dataChanged();
      else saveListCache();
    } catch {
      /* offline: keep showing the cached list */
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}
// Old name, kept for the event handlers below.
const loadContacts = syncList;
setInterval(() => {
  if (!document.hidden) syncList();
}, SYNC_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) syncList();
});

// IndexedDB: one record holding the list and the sync position.
const IDB_NAME = 'autoemail-cache';
function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
let cacheTimer = null;
function saveListCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(async () => {
    try {
      const db = await idb();
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ rows, listedPosts, listState: { ...listState }, savedAt: Date.now() }, 'list');
    } catch {
      /* private mode etc.: the page still works, it just loads from the server */
    }
  }, 8000); // a full copy costs ~50 ms: write it after things settle
}
async function loadListCache() {
  try {
    const db = await idb();
    const rec = await new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get('list');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if (rec && Array.isArray(rec.rows)) {
      rows = rec.rows;
      listedPosts = rec.listedPosts || [];
      Object.assign(listState, rec.listState || {});
      dataVer++;
      renderRows();
    }
  } catch {
    /* no cache yet */
  }
}

// --- All list: listed posts not scraped yet, shown next to the contacts ---
// Memoized per data version. Posts not seen on a search page for 3 days are
// treated as expired.
const LISTED_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
let viewMemo = { ver: -1, list: [] };
function viewRows() {
  if (viewMemo.ver === dataVer) return viewMemo.list;
  const have = new Set(rows.map((r) => r.url));
  const cutoff = Date.now() - LISTED_MAX_AGE_MS;
  const extra = listedPosts
    .filter((p) => !have.has(p.url) && !p.gone && !(p.lastSeenAt && Date.parse(p.lastSeenAt) < cutoff))
    .map((p) => ({ ...p, unscraped: true, id: null, sent: false, phones: [], emails: [], relay: null }));
  viewMemo = { ver: dataVer, list: extra.length ? rows.concat(extra) : rows };
  return viewMemo.list;
}

// --- ▶ Scrape one post now: a temporary server worker using usable proxies ---
const postJobs = new Map(); // url -> running job (from /api/status, all devices)
const myPostJobs = new Map(); // url -> start time, for jobs started on this device: toast their result
let postJobsKey = '';
const PLAY_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><path d="M5 3.2v9.6L12.6 8z" fill="currentColor"/></svg>';
const STOP_ICON = '<svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor"/></svg>';
function playButton(url, job) {
  const label = job ? 'Stop scraping this post' : 'Scrape this post now (usable proxies only)';
  return `<button type="button" class="post-scrape${job ? ' busy' : ''}" data-url="${esc(url)}" title="${label}" aria-label="${label}">${job ? STOP_ICON : PLAY_ICON}</button>`;
}
function postTitle(url) {
  const r = viewRows().find((x) => x.url === url);
  return (r && r.title) || url;
}
const POST_OUTCOMES = {
  scraped: ['Scraped', 'ok'],
  partial: ['Scraped · no relay', 'ok'],
  gone: ['Listing gone', 'bad'],
  duplicate: ['Duplicate · not stored', 'bad'],
  failed: ['Not scraped', 'bad'],
  'no-reply': ['No reply button', 'bad'],
  skipped: ['Skipped', 'ok'],
  stopped: ['Stopped', 'ok'],
};
function applyPostScrapes(ps) {
  if (!ps) return;
  const running = ps.jobs.filter((j) => !j.finishedAt);
  // A job this device started that the server no longer knows: it restarted.
  const known = new Set(ps.jobs.map((j) => j.url));
  for (const [url, at] of myPostJobs) {
    if (known.has(url) || Date.now() - at < 8000) continue;
    myPostJobs.delete(url);
    showToast({ kicker: 'Interrupted', title: postTitle(url), body: 'The server restarted while this post was being scraped. Press ▶ to try again.', tone: 'bad' });
  }
  for (const j of ps.jobs) {
    if (!j.finishedAt || !myPostJobs.has(j.url)) continue;
    myPostJobs.delete(j.url);
    const [kicker, tone] = POST_OUTCOMES[j.outcome] || [j.outcome, 'ok'];
    showToast({ kicker, title: postTitle(j.url), body: j.message, tone });
    loadContacts();
  }
  postJobs.clear();
  for (const j of running) postJobs.set(j.url, j);
  const key = running.map((j) => `${j.url}:${j.tried}`).join('|');
  if (key !== postJobsKey) {
    postJobsKey = key;
    renderRows();
  }
}
async function togglePostScrape(btn) {
  const url = btn.dataset.url;
  const busy = postJobs.has(url);
  btn.disabled = true;
  const res = await fetch(busy ? '/api/scrape/post/stop' : '/api/scrape/post', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }).catch(() => null);
  const data = res ? await res.json().catch(() => ({})) : {};
  if (!res || !res.ok || !data.ok) {
    btn.disabled = false;
    if (!busy) showToast({ kicker: 'Not started', title: postTitle(url), body: data.error || 'The server did not answer.', tone: 'bad' });
    return;
  }
  if (busy) {
    postJobs.delete(url);
    myPostJobs.delete(url); // no toast for a stop the user asked for
  } else {
    postJobs.set(url, { url, tried: 0 });
    myPostJobs.set(url, Date.now());
    attachEvents();
  }
  postJobsKey = '';
  renderRows();
  pollStatus();
}

// Pencil icon: fill a relay email or phone by hand.
const PENCIL_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M11.2 2.3l2.5 2.5-7.9 7.9-3.1.6.6-3.1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
function pencilCell(r, field) {
  if (r.sent) return `<span class="posted-none">${r.unscraped ? 'Not scraped' : '–'}</span>`;
  const label = field === 'relay' ? 'relay email' : 'phone number';
  return `<span class="manual-slot"><span class="manual-empty">${r.unscraped ? 'Not scraped' : '–'}</span><button type="button" class="pencil" data-url="${esc(r.url)}" data-field="${field}" title="Fill ${label} by hand" aria-label="Fill ${label} by hand">${PENCIL_ICON}</button></span>`;
}
function openManualEditor(btn) {
  const td = btn.closest('td');
  const field = btn.dataset.field;
  const url = btn.dataset.url;
  td.innerHTML = `<span class="manual-edit"><input type="${field === 'relay' ? 'email' : 'tel'}" class="manual-input" placeholder="${field === 'relay' ? 'name@example.com' : '(555) 123-4567'}" aria-label="${field === 'relay' ? 'Relay email' : 'Phone number'}"/><button type="button" class="manual-save" title="Save">✓</button><button type="button" class="manual-cancel" title="Cancel">✕</button></span>`;
  const input = td.querySelector('input');
  input.focus();
  const cancel = () => renderRows();
  const save = async () => {
    const value = input.value.trim();
    if (!value) return cancel();
    input.disabled = true;
    try {
      const res = await fetch('/api/contacts/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, [field]: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showToast({ kicker: 'Not saved', title: value, body: data.error || 'Could not save.', tone: 'bad' });
        input.disabled = false;
        input.focus();
        return;
      }
      showToast({ kicker: 'Saved', title: value, body: data.row.title || url });
      applyContactRows([data.row]);
    } catch (err) {
      showToast({ kicker: 'Not saved', title: value, body: err.message, tone: 'bad' });
      input.disabled = false;
    }
  };
  td.querySelector('.manual-save').addEventListener('click', save);
  td.querySelector('.manual-cancel').addEventListener('click', cancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    else if (e.key === 'Escape') cancel();
  });
}
// Paint from the browser cache at once, then catch up with the server.
loadListCache().then(syncList);

// Reload: the server re-reads its files; then fetch the whole list again.
document.getElementById('reloadData').addEventListener('click', async () => {
  await fetch('/api/contacts/reload', { method: 'POST' });
  Object.assign(listState, { ce: '', cr: 0, pe: '', pr: 0 });
  syncList();
});

document.getElementById('refreshProxies').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Fetching…';
  try {
    const r = await (await fetch('/api/proxies/refresh', { method: 'POST' })).json();
    if (r.ok) {
      const p = r.pruned ? `Kept ${r.pruned.kept} verified, removed ${r.pruned.removed} unverified.\n` : '';
      const a = r.archives && r.archives.removed
        ? `Deleted ${r.archives.removed} archived pool file(s) older than 1 day (${Math.round(r.archives.freedBytes / 1048576)} MB).\n`
        : '';
      alert(`${p}${a}Gathered ${r.found} proxies, ${r.added} new.\nStored ${r.stats.stored}. New proxies are verified by use while scraping.`);
    }
    else alert('Refresh failed: ' + r.error);
  } catch (err) {
    alert('Refresh failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
});

document.getElementById('dedupe').addEventListener('click', async () => {
  const r = await (await fetch('/api/contacts/dedupe', { method: 'POST' })).json();
  alert(`Removed ${r.removed} duplicate-phone contacts. ${r.count.total} remain.`);
  syncList();
});

// ---------- Scraper (server-side run; this page only attaches to its events) ----------
let es = null;
const log = document.getElementById('scrapeLog');
const resultsplit = document.getElementById('resultsplit');
const logToggleBtn = document.getElementById('logToggle');
function applyTraceHidden(hidden) {
  resultsplit.classList.toggle('trace-hidden', hidden);
  logToggleBtn.textContent = hidden ? 'Show trace' : 'Hide trace';
  logToggleBtn.setAttribute('aria-pressed', String(!hidden));
}
applyTraceHidden(!!prefs.traceHidden);
logToggleBtn.addEventListener('click', () => {
  const hidden = !resultsplit.classList.contains('trace-hidden');
  applyTraceHidden(hidden);
  savePrefs({ traceHidden: hidden });
});
// Bounded, batched log: keeps the last LOG_MAX lines and repaints at most once
// per frame. Appending to one ever-growing textContent froze the tab on long runs.
const LOG_MAX = 400;
const logLines = [];
let logDirty = false;
function paintLog() {
  logDirty = false;
  // Only auto-scroll if the reader is already at the bottom (don't yank them
  // away while they're reading older lines).
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  log.textContent = logLines.length ? logLines.join('\n') : 'Waiting for a run…';
  if (atBottom) log.scrollTop = log.scrollHeight;
}
function addLog(line) {
  logLines.push(line);
  if (logLines.length > LOG_MAX) logLines.splice(0, logLines.length - LOG_MAX);
  if (logDirty) return;
  logDirty = true;
  requestAnimationFrame(paintLog);
}
document.getElementById('logClear').addEventListener('click', () => {
  logLines.length = 0;
  paintLog();
});

function handleEvent(e) {
  if (e.type === 'post') {
    upsertRow(e.row);
    renderRows();
  } else if (e.type === 'done') {
    addLog(`Done. stored ${e.stored}, relays ${e.relays ?? 0}, dropped ${e.dropped}, parked ${e.parked ?? 0}, ${e.attempts} attempts.`);
    loadContacts();
  } else if (e.type === 'error') {
    addLog(`ERROR: ${e.message}`);
  } else if (e.type === 'aborted') {
    addLog(`⛔ ABORTED: ${e.message}`);
  } else if (e.type === 'blocked') {
    addLog(`⚠ BLOCKED by Craigslist on ${e.area}/${e.category}.`);
  } else if (e.type === 'cooldown') {
    addLog(`⏸ IP blocked — cooling down ${Math.round(e.cooldownMs / 1000)}s before retrying.`);
  } else if (e.type === 'collect-error') {
    addLog(`⚠ fetch failed ${e.area}/${e.category}: ${e.error}${e.willRetry ? ' — retrying at end of cycle' : ' — gave up this cycle'}`);
  } else if (e.type === 'proxies-fetched') {
    addLog(`proxies fetched: ${e.count} (stored ${e.stats.stored})`);
  } else if (e.type === 'proxies-auto-refresh') {
    addLog(`↻ proxy pool auto-refreshed (${e.reason}): kept ${e.kept} verified, removed ${e.removed} unverified, gathered ${e.found}${e.archivesRemoved ? `; deleted ${e.archivesRemoved} archived pool file(s) older than 1 day (${e.archiveMbFreed} MB)` : ''}`);
  } else if (e.type === 'parked') {
    addLog(`parked (tried ${e.tried} proxies): ${e.url}`);
  } else if (e.type === 'cycle-done') {
    addLog(`cycle ${e.cycle} done · ${e.newPosts} new posts · ${e.seen} seen`);
    loadContacts();
  } else if (e.type === 'retry') {
    addLog(`retry #${e.attempt} (${e.reason}): ${e.url}`);
  } else if (e.type === 'dropped') {
    addLog(`dropped (${e.reason || ''}): ${e.url}`);
  } else if (e.type === 'contacts-updated' || e.type === 'posts-updated') {
    loadContacts();
  } else if (e.type === 'warn') {
    addLog(`WARN: ${e.message}`);
  } else if (e.type === 'refresh-started') {
    addLog(`Refresh started: ${e.workers} workers, up to ${e.maxProxiesPerPost} proxies per post.`);
  } else if (e.type === 'refresh-stopped') {
    addLog(`Refresh stopped. ${e.confirmed} same, ${e.changed} changed, ${e.unverified} unverified, ${e.expired} expired, ${e.attempts} attempts.`);
    loadContacts();
  } else if (e.type === 'refresh-sweep') {
    if (e.phase === 'start') addLog(`Refresh sweep: checking ${e.total} listings for expiry.`);
    else addLog(`Refresh sweep ${e.phase}: ${e.done}/${e.total} checked, ${e.expired} expired.`);
  } else if (e.type === 'refresh-result') {
    const words = {
      confirmed: `relay same (${e.tried} proxies)`,
      changed: `RELAY CHANGED ${e.from} to ${e.to} (${e.tried} proxies)`,
      unverified: `unverified after ${e.tried} proxies`,
      expired: 'expired',
    };
    addLog(`refresh: ${words[e.outcome]}: ${e.url}`);
  } else if (e.type === 'post-scrape') {
    if (e.phase === 'start') addLog(`▶ scraping one post: ${e.url}`);
    else addLog(`▶ ${e.outcome}${e.tried ? ` (${e.tried} proxies)` : ''}: ${e.message} ${e.url}`);
  } else if (e.type !== 'collected') {
    addLog(JSON.stringify(e));
  }
}

// Attach to the server's event stream. If the connection drops (sleep, VPN
// toggle, refresh) the browser auto-reconnects; the run is unaffected.
function attachEvents() {
  if (es) return;
  es = new EventSource('/api/scrape/events');
  es.onmessage = (ev) => {
    try {
      handleEvent(JSON.parse(ev.data));
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    addLog('… stream interrupted — reconnecting (scraper keeps running on the server)');
  };
}

function setRunButtons(running) {
  document.getElementById('startScrape').disabled = running;
  document.getElementById('stopScrape').disabled = !running;
}

document.getElementById('startScrape').addEventListener('click', async () => {
  const areaVals = areasMs.values();
  if (!areaVals.length) return alert('Select at least one area.');
  const params = new URLSearchParams({
    areas: areaVals.join(','),
    categories: catsMs.values().join(','),
    query: document.getElementById('query').value,
    concurrency: document.getElementById('concurrency').value,
    maxProxiesPerPost: document.getElementById('maxProxiesPerPost').value,
    replyWaitMs: String((Number(document.getElementById('replyWait').value) || 25) * 1000),
    pageTimeoutMs: String(Math.max(0, Number(document.getElementById('pageTimeout').value) || 0) * 1000),
    loop: document.getElementById('loop').checked ? '1' : '0',
    cycleDelayMs: String((Number(document.getElementById('cycleDelay').value) || 45) * 1000),
    useProxies: document.getElementById('useProxies').checked ? '1' : '0',
    headless: document.getElementById('headless').checked ? '1' : '0',
  });
  logLines.length = 0;
  const r = await fetch(`/api/scrape/start?${params}`, { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) return alert(data.error || 'Could not start the run.');
  setRunButtons(true);
  attachEvents();
  setupEl.open = false; // fold setup into its one-line summary; results get the height
});

document.getElementById('stopScrape').addEventListener('click', async () => {
  await fetch('/api/scrape/stop', { method: 'POST' });
  addLog('Stop requested…');
});

// Relay refresh: its own switch, independent of Start/Stop. It reuses the run
// parameters above, but never the Workers field (it always runs 3 workers).
document.getElementById('refreshToggle').addEventListener('change', async (e) => {
  const on = e.target.checked;
  e.target.disabled = true;
  try {
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    if (on) {
      opts.body = JSON.stringify({
        headless: document.getElementById('headless').checked,
        maxProxiesPerPost: document.getElementById('maxProxiesPerPost').value,
        replyWaitMs: (Number(document.getElementById('replyWait').value) || 25) * 1000,
        pageTimeoutMs: Math.max(0, Number(document.getElementById('pageTimeout').value) || 0) * 1000,
        scope: currentScope(), // this device's filtered list
        deviceId: DEVICE_ID,
      });
    }
    const r = await fetch(`/api/refresh/${on ? 'start' : 'stop'}`, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) alert(data.error || 'Could not change the refresh switch.');
    attachEvents();
  } finally {
    e.target.disabled = false;
    pollStatus();
  }
});

// On page load: if a run is already going on the server, re-attach to it.
(async () => {
  try {
    const s = await (await fetch('/api/status')).json();
    setRunButtons(!!s.running);
    if (s.running) attachEvents();
  } catch {
    /* server not reachable yet */
  }
})();

// ---------- DB format ----------
async function loadFormat() {
  const data = await (await fetch('/api/db-format')).json();
  document.getElementById('dbFormat').textContent = JSON.stringify(data, null, 2);
}
document.getElementById('reloadFormat').addEventListener('click', loadFormat);
