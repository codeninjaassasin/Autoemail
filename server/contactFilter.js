'use strict';

// The results-list filters, applied on the server, for the relay refresh scope.
// Filters are per device; the device that turns refresh on sends its own
// ({ filters, sentFilter, phone }). Mirrors the filter logic in public/app.js
// (renderRows / matchesLocation / matchesPhone) — keep the two in step.

const areas = require('./data/areas');

const areaMeta = new Map(areas.map((a) => [a.sub, a]));

function locOf(r) {
  return areaMeta.get(r.area) || { name: r.area || '', city: r.area || '', state: '' };
}

// Returns a predicate (row) => boolean for the given shared prefs. Pass all
// rows so a saved category that no row has is ignored, as the page does.
function makeFilter(prefs = {}, rows = null) {
  const f = prefs.filters || {};
  const sent = prefs.sentFilter || 'all';
  let category = f.category || '';
  if (category && rows && !rows.some((r) => r.category === category)) category = '';
  const phoneOnly = !!f.phoneOnly;
  const freshness = f.freshness || '';
  const state = f.state || '';
  const city = String(f.city || '').toLowerCase();
  const phone = String(prefs.phone || '').replace(/\D/g, ''); // phone search digits
  return (r) => {
    if (phone && !(r.phones || []).some((p) => String(p).replace(/\D/g, '').includes(phone))) return false;
    if (sent === 'sent' && !r.sent) return false;
    if (sent === 'unsent' && r.sent) return false;
    if (category && r.category !== category) return false;
    if (phoneOnly && !(r.phones && r.phones.length > 0)) return false;
    if (freshness && (r.sent || (r.refreshStatus || 'unchecked') !== freshness)) return false; // sent: no freshness
    const loc = locOf(r);
    if (state === '__other') {
      if (loc.state) return false;
    } else if (state && loc.state !== state) return false;
    if (city && !`${loc.name} ${r.area || ''}`.toLowerCase().includes(city)) return false;
    return true;
  };
}

// True when no filter narrows the list.
function isUnfiltered(prefs = {}) {
  const f = prefs.filters || {};
  return (prefs.sentFilter || 'all') === 'all' && !f.category && !f.phoneOnly && !f.freshness && !f.state && !f.city && !prefs.phone;
}

module.exports = { makeFilter, isUnfiltered };
