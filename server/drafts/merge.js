'use strict';

// Template fields filled from a scraped post:
//   {{title}}     the post title, without the " - <category>" Craigslist appends
//   {{city}}      the area's city (e.g. San Diego), {{state}} its state (CA)
//   {{category}}  the category name (e.g. resumes / job wanted)
//   {{link}}      the post's URL
//   {{posted}}    the posted date (e.g. Nov 25)
// Unknown fields are left as typed, so a typo shows in the draft for review.

const areas = require('../data/areas');
const categories = require('../data/categories');

const areaBySub = new Map(areas.map((a) => [a.sub, a]));
const catByCode = new Map(categories.map((c) => [c.code, c]));

const FIELDS = ['title', 'city', 'state', 'category', 'link', 'posted'];

function values(contact) {
  const area = areaBySub.get(contact.area) || {};
  const cat = catByCode.get(contact.category) || {};
  // Craigslist appends " - <category label>" (e.g. " - resumes / job wanted").
  let title = String(contact.title || '').trim();
  const cut = title.lastIndexOf(' - ');
  if (cut > 0 && cat.name && title.slice(cut + 3).toLowerCase().startsWith(cat.name.toLowerCase()))
    title = title.slice(0, cut).trim();
  const posted = contact.postedAt ? new Date(contact.postedAt) : null;
  return {
    title,
    city: area.city || area.name || contact.area || '',
    state: area.state || '',
    category: cat.name || contact.category || '',
    link: contact.url || '',
    posted: posted && !isNaN(posted) ? posted.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '',
  };
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function fill(text, vals) {
  return String(text || '').replace(/\{\{\s*([a-z]+)\s*\}\}/gi, (m, key) => {
    const k = key.toLowerCase();
    return FIELDS.includes(k) ? vals[k] : m;
  });
}

// Plain multi-line text -> the HTML Gmail's own editor writes: one <div> per
// line, <div><br></div> for a blank line, so the draft opens with exactly the
// lines of the template. Web addresses become links.
function textToHtml(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      if (!line.trim()) return '<div><br></div>';
      const html = escHtml(line)
        .replace(/ {2}/g, ' &nbsp;')
        .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => `<a href="${u}">${u}</a>`);
      return `<div>${html}</div>`;
    })
    .join('');
}

// { subject, bodyText, bodyHtml } for one contact from one template.
function render(template, contact) {
  const vals = values(contact);
  const bodyText = fill(template.body, vals).replace(/\r\n?/g, '\n');
  return { subject: fill(template.subject, vals).replace(/[\r\n]+/g, ' '), bodyText, bodyHtml: textToHtml(bodyText) };
}

module.exports = { render, values, textToHtml, FIELDS };
