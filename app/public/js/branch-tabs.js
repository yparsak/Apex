// Branch page enhancements (see ROADMAP.md Phase 32). Like branch-poll.js this
// only improves a page that is already complete without it: the tabs work via
// anchors + CSS :target, and the conversation simply opens at the top.
//
// 1. A hash naming a disabled or unknown tab falls back to Code.
// 2. The conversation opens scrolled to its newest message, and follows new
//    content only if the user was already at the bottom.
(function () {
  'use strict';

  var enabled = { code: true };
  var bar = document.querySelector('[data-tab-bar]');
  if (bar) {
    Array.prototype.forEach.call(bar.querySelectorAll('a[data-tab]'), function (a) {
      enabled[a.getAttribute('data-tab')] = true;
    });
  }

  var box = document.querySelector('[data-conversation]');
  var scrollToEnd = function () { if (box) box.scrollTop = box.scrollHeight; };

  var fixHash = function () {
    var key = window.location.hash.replace(/^#/, '');
    if (key && !enabled[key]) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search + '#code');
    }
  };
  fixHash();
  // The Code panel may have been display:none at load (#report), so scroll
  // again whenever the hash changes.
  window.addEventListener('hashchange', function () { fixHash(); scrollToEnd(); });

  if (!box) return;
  scrollToEnd();

  if (window.MutationObserver) {
    var atBottom = true;
    box.addEventListener('scroll', function () {
      atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
    });
    new MutationObserver(function () { if (atBottom) scrollToEnd(); })
      .observe(box, { childList: true, subtree: true, characterData: true });
  }
})();
