'use strict';

// Analytics tab: day-by-day counts from GET /api/analytics, bucketed in this
// browser's time zone. Today's figures lead as tiles; two stacked column
// charts (contacts scraped by phone or not, drafts by what became of them);
// a table view holds every number. Charts are plain SVG; the tooltip follows
// the pointer or the arrow keys.
(function () {
  var TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
  var root = document.getElementById('analytics');
  if (!root) return;
  var tiles = document.getElementById('anTiles');
  var rowsEl = document.getElementById('anRows');
  var tip = document.getElementById('anTip');
  var days = 14;
  try { days = Number(localStorage.getItem('autoemail.analyticsDays')) || 14; } catch (e) { /* default */ }
  var data = null;
  var loading = false;
  var timer = null;

  var SCRAPE = [
    { key: 'phones', name: 'With phone', color: 'var(--viz-1)' },
    { key: 'emailOnly', name: 'Email only', color: 'var(--viz-2)' },
  ];
  var DRAFT = [
    { key: 'draftSent', name: 'Sent', color: 'var(--viz-1)' },
    { key: 'draftWaiting', name: 'Still in Drafts', color: 'var(--viz-2)' },
  ];

  var nf = new Intl.NumberFormat();
  var num = function (n) { return nf.format(n || 0); };
  function compact(n) {
    if (n >= 10000) return (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'K';
    return nf.format(n);
  }
  function parseDay(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  var dayLong = function (s) { return parseDay(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
  var dayShort = function (s) { return parseDay(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  var SVG = 'http://www.w3.org/2000/svg';
  function s(tag, attrs) {
    var e = document.createElementNS(SVG, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  // ---------- Tiles ----------
  function tile(label, value, note, hero) {
    var t = el('div', 'an-tile' + (hero ? ' is-hero' : ''));
    t.appendChild(el('span', 'an-tile-k', label));
    t.appendChild(el('span', 'an-tile-v', num(value)));
    if (note) t.appendChild(el('span', 'an-tile-n', note));
    return t;
  }
  function delta(today, yesterday) {
    var d = today - yesterday;
    if (!d) return 'same as yesterday';
    return num(Math.abs(d)) + (d > 0 ? ' more' : ' fewer') + ' than yesterday';
  }
  function renderTiles() {
    var list = data.days;
    var t = list[list.length - 1];
    var y = list[list.length - 2] || {};
    var sum = function (k) { return list.reduce(function (a, d) { return a + (d[k] || 0); }, 0); };
    tiles.replaceChildren(
      tile('Scraped today', t.scraped, delta(t.scraped, y.scraped || 0) + ', ' + num(sum('scraped')) + ' in ' + list.length + ' days', true),
      tile('Phones today', t.phones, delta(t.phones, y.phones || 0) + ', ' + num(sum('phones')) + ' in ' + list.length + ' days'),
      tile('Drafted today', t.drafted, num(sum('drafted')) + ' in ' + list.length + ' days'),
      tile('Sent today', t.marked, 'contacts marked sent, ' + num(sum('marked')) + ' in ' + list.length + ' days'),
      tile('Waiting in Drafts', data.totals.waiting, data.totals.waiting ? 'send them from Gmail' : 'nothing to send'),
      tile('Replies today', t.replies, data.totals.unreadReplies ? num(data.totals.unreadReplies) + ' unread' : 'none unread')
    );
  }

  // ---------- Stacked columns ----------
  // Top of the y axis: four clean steps just above the tallest column.
  function niceMax(v) {
    if (v <= 4) return 4;
    var raw = v / 4;
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var steps = p < 10 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10];
    for (var i = 0; i < steps.length; i++) if (steps[i] * p >= raw) return steps[i] * p * 4;
    return 40 * p;
  }

  function legend(target, series) {
    var box = document.getElementById(target);
    box.replaceChildren.apply(box, series.map(function (x) {
      var item = el('span', 'an-key');
      var sw = el('span', 'an-swatch');
      sw.style.background = x.color;
      item.appendChild(sw);
      item.appendChild(document.createTextNode(x.name));
      return item;
    }));
  }

  function columns(target, series, list) {
    var box = document.getElementById(target);
    var W = Math.max(280, box.clientWidth || 600);
    var H = 240;
    var m = { t: 22, r: 8, b: 26, l: 40 };
    var iw = W - m.l - m.r;
    var ih = H - m.t - m.b;
    var totals = list.map(function (d) { return series.reduce(function (a, x) { return a + (d[x.key] || 0); }, 0); });
    var max = niceMax(Math.max.apply(null, totals.concat([1])));
    var band = iw / list.length;
    var bw = Math.max(2, Math.min(24, band - 4));
    var y = function (v) { return m.t + ih - (v / max) * ih; };

    var svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', tabindex: '0', class: 'an-svg' });
    svg.setAttribute('aria-label', box.closest('figure').querySelector('h3').textContent + ', ' + list.length + ' days. Use the arrow keys to read each day.');
    // Grid and y ticks
    for (var i = 0; i <= 4; i++) {
      var v = (max / 4) * i;
      var gy = Math.round(y(v)) + 0.5;
      svg.appendChild(s('line', { x1: m.l, x2: W - m.r, y1: gy, y2: gy, class: i ? 'an-gridline' : 'an-base' }));
      var tl = s('text', { x: m.l - 8, y: gy + 4, class: 'an-tick', 'text-anchor': 'end' });
      tl.textContent = compact(v);
      svg.appendChild(tl);
    }
    // X labels: as many as fit
    var every = Math.max(1, Math.ceil(56 / band));
    list.forEach(function (d, i) {
      if ((list.length - 1 - i) % every) return;
      var xl = s('text', { x: m.l + band * i + band / 2, y: H - 8, class: 'an-tick', 'text-anchor': 'middle' });
      xl.textContent = dayShort(d.date);
      svg.appendChild(xl);
    });
    // Bars: segments from the baseline up, 2px surface gap, rounded top on the last one
    var cols = [];
    list.forEach(function (d, i) {
      var g = s('g', { class: 'an-col' });
      var x = m.l + band * i + (band - bw) / 2;
      var base = y(0);
      var shown = series.filter(function (sr) { return d[sr.key] > 0; });
      shown.forEach(function (sr, j) {
        var h = (d[sr.key] / max) * ih;
        var top = base - h;
        var hh = Math.max(1, h - (j > 0 ? 2 : 0)); // 2px surface gap under each upper segment
        var r = j === shown.length - 1 ? Math.min(4, hh, bw / 2) : 0;
        var yTop = top;
        var path = r
          ? 'M' + x + ',' + (yTop + hh) + 'V' + (yTop + r) + 'Q' + x + ',' + yTop + ' ' + (x + r) + ',' + yTop + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + yTop + ' ' + (x + bw) + ',' + (yTop + r) + 'V' + (yTop + hh) + 'Z'
          : 'M' + x + ',' + (yTop + hh) + 'V' + yTop + 'H' + (x + bw) + 'V' + (yTop + hh) + 'Z';
        var seg = s('path', { d: path });
        seg.style.fill = sr.color;
        g.appendChild(seg);
        base = top;
      });
      // Hit area: the whole day band
      g.appendChild(s('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, class: 'an-hit' }));
      svg.appendChild(g);
      cols.push({ g: g, cx: m.l + band * i + band / 2, top: y(totals[i]) });
    });
    // One direct label: today's total on its cap
    var last = list.length - 1;
    var cap = s('text', { x: cols[last].cx, y: cols[last].top - 6, class: 'an-cap', 'text-anchor': list.length > 1 ? 'end' : 'middle' });
    if (list.length > 1) cap.setAttribute('x', Math.min(W - m.r, cols[last].cx + bw / 2));
    cap.textContent = num(totals[last]);
    svg.appendChild(cap);

    function show(i, evt) {
      cols.forEach(function (c, k) { c.g.classList.toggle('is-hover', k === i); });
      var d = list[i];
      tip.replaceChildren();
      tip.appendChild(el('span', 'an-tip-day', dayLong(d.date)));
      series.forEach(function (sr) {
        var row = el('span', 'an-tip-row');
        var key = el('span', 'an-tip-key');
        key.style.background = sr.color;
        row.appendChild(key);
        row.appendChild(el('b', '', num(d[sr.key])));
        row.appendChild(document.createTextNode(' ' + sr.name));
        tip.appendChild(row);
      });
      var tot = el('span', 'an-tip-row an-tip-total');
      tot.appendChild(el('b', '', num(totals[i])));
      tot.appendChild(document.createTextNode(' in all'));
      tip.appendChild(tot);
      tip.hidden = false;
      var rect = svg.getBoundingClientRect();
      var px = rect.left + (cols[i].cx / W) * rect.width;
      var py = rect.top + (Math.max(m.t, cols[i].top) / H) * rect.height;
      var tw = tip.offsetWidth;
      var left = Math.min(window.innerWidth - tw - 8, Math.max(8, px - tw / 2));
      tip.style.left = left + 'px';
      tip.style.top = Math.max(8, py - tip.offsetHeight - 10) + 'px';
      svg.dataset.at = i;
    }
    function hide() {
      cols.forEach(function (c) { c.g.classList.remove('is-hover'); });
      tip.hidden = true;
    }
    svg.addEventListener('pointermove', function (e) {
      var rect = svg.getBoundingClientRect();
      var x = ((e.clientX - rect.left) / rect.width) * W - m.l;
      var i = Math.floor(x / band);
      if (i < 0 || i >= list.length) return hide();
      show(i, e);
    });
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', function (e) {
      var i = svg.dataset.at === undefined ? last + 1 : Number(svg.dataset.at);
      if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
      else if (e.key === 'ArrowRight') i = Math.min(last, i + 1);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = last;
      else if (e.key === 'Escape') return hide();
      else return;
      e.preventDefault();
      show(Math.min(last, i));
    });
    box.replaceChildren(svg);
  }

  // ---------- Table view ----------
  function renderTable() {
    var cells = ['posts', 'scraped', 'phones', 'relays', 'drafted', 'draftSent', 'draftWaiting', 'marked', 'replies'];
    rowsEl.replaceChildren.apply(rowsEl, data.days.slice().reverse().map(function (d) {
      var tr = el('tr');
      tr.appendChild(el('td', 'an-day', dayLong(d.date)));
      cells.forEach(function (k) { tr.appendChild(el('td', 'an-num', num(d[k]))); });
      return tr;
    }));
  }

  function render() {
    if (!data) return;
    var list = data.days.map(function (d) {
      var c = Object.assign({}, d);
      c.emailOnly = Math.max(0, d.scraped - d.phones);
      return c;
    });
    renderTiles();
    legend('anLegendScrape', SCRAPE);
    legend('anLegendDraft', DRAFT);
    columns('anScrape', SCRAPE, list);
    columns('anDraft', DRAFT, list);
    renderTable();
  }

  function load() {
    if (loading) return;
    loading = true;
    root.classList.add('is-loading');
    fetch('/api/analytics?tz=' + encodeURIComponent(TZ) + '&days=' + days)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.days) {
          data = d;
          render();
        }
      })
      .catch(function () {
        if (!data) tiles.textContent = 'The numbers did not load. They retry in 30 seconds.';
      })
      .finally(function () {
        loading = false;
        root.classList.remove('is-loading');
      });
  }

  window.loadAnalytics = function () {
    load();
    clearInterval(timer);
    timer = setInterval(function () {
      if (root.classList.contains('active') && !document.hidden) load();
    }, 30000);
  };

  root.querySelectorAll('.an-range [data-days]').forEach(function (b) {
    b.classList.toggle('active', Number(b.dataset.days) === days);
    b.setAttribute('aria-pressed', String(Number(b.dataset.days) === days));
    b.addEventListener('click', function () {
      days = Number(b.dataset.days);
      try { localStorage.setItem('autoemail.analyticsDays', String(days)); } catch (e) { /* fine */ }
      root.querySelectorAll('.an-range [data-days]').forEach(function (x) {
        x.classList.toggle('active', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      load();
    });
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (root.classList.contains('active')) render(); }, 150);
  });
})();
