'use strict';

// Live figures tick when their value changes (finish.css .tick): the top bar
// strip, the telemetry readings, and the refresh strip. The first value an
// element shows is only remembered, so the page does not tick on load.
(function () {
  if (!window.MutationObserver) return;
  var last = new WeakMap();
  var FIGURES = '#tracer .v, #livestrip b, .refreshbar b';

  function remember(el) { last.set(el, el.textContent); }
  function tick(el) {
    var now = el.textContent;
    if (!last.has(el)) { last.set(el, now); return; }
    if (last.get(el) === now) return;
    last.set(el, now);
    el.classList.remove('tick');
    void el.offsetWidth; // restart the animation
    el.classList.add('tick');
  }

  function watch(root) {
    if (!root) return;
    root.querySelectorAll(FIGURES).forEach(remember);
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        var node = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        var el = node && node.closest(FIGURES);
        if (el) tick(el);
        // Elements added under the root (a strip rebuilt by app.js).
        m.addedNodes && m.addedNodes.forEach(function (n) {
          if (n.nodeType === 1) (n.matches(FIGURES) ? [n] : n.querySelectorAll(FIGURES)).forEach(function (e) { if (!last.has(e)) remember(e); });
        });
      });
    }).observe(root, { subtree: true, childList: true, characterData: true });
  }

  document.addEventListener('animationend', function (e) {
    if (e.animationName === 'tick') e.target.classList.remove('tick');
  });

  watch(document.getElementById('tracer'));
  watch(document.getElementById('livestrip'));
  watch(document.querySelector('.refreshbar'));
})();
