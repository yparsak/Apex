// Sending a message on the branch page's Code tab (an enhancement over the
// plain form POST, which still works with this file blocked): the user's
// message is appended to the conversation straight away, followed by a
// placeholder carrying a spinner in place of the model's reply. The POST is
// sent with fetch; when it completes, the server-rendered conversation and
// the parts of the page that depend on it replace what is on screen, which
// removes the spinner. On a transport failure the form is submitted the
// normal way so the user never loses the page's ordinary behaviour.
(function () {
  'use strict';

  var form = document.querySelector('[data-message-form]');
  var box = document.querySelector('[data-conversation]');
  if (!form || !box || !window.fetch || !window.DOMParser) return;

  var SWAP = ['[data-conversation]', '.code-footer', '.requirements-panel', '[data-top-stepper]'];

  function row(role, label) {
    var div = document.createElement('div');
    div.className = 'message message-' + role;
    var who = document.createElement('span');
    who.className = 'message-role';
    who.textContent = label;
    div.appendChild(who);
    return div;
  }

  form.addEventListener('submit', function (ev) {
    var textarea = form.querySelector('textarea[name="text"]');
    var text = textarea.value.trim();
    if (!text) return;
    ev.preventDefault();

    var mine = row('user', form.getAttribute('data-user-label'));
    var body = document.createElement('span');
    body.className = 'message-text';
    body.textContent = text;
    mine.appendChild(body);

    var pending = row('assistant message-pending', form.getAttribute('data-ai-label'));
    var spin = document.createElement('img');
    spin.className = 'message-spinner';
    spin.src = form.getAttribute('data-spinner-src');
    spin.alt = 'Waiting for response';
    pending.appendChild(spin);

    box.appendChild(mine);
    box.appendChild(pending);

    var data = new URLSearchParams(new FormData(form));
    textarea.value = '';
    Array.prototype.forEach.call(form.elements, function (el) { el.disabled = true; });

    fetch(form.action, {
      method: 'POST',
      body: data,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }).then(function (res) {
      if (!res.ok) throw new Error('status ' + res.status);
      return res.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      SWAP.forEach(function (sel) {
        var fresh = doc.querySelector(sel);
        var old = document.querySelector(sel);
        if (fresh && old) old.replaceWith(fresh);
      });
      // A model/GitHub failure comes back as the page with an error line.
      var oldErr = document.querySelector('.branch-content > .error');
      if (oldErr) oldErr.remove();
      var err = doc.querySelector('.branch-content > .error');
      if (err) {
        var bar = document.querySelector('[data-tab-bar]');
        if (bar) bar.parentNode.insertBefore(err, bar);
      }
      var again = document.querySelector('[data-conversation]');
      if (again) again.scrollTop = again.scrollHeight;
      // Re-bind to the fresh form.
      var script = document.createElement('script');
      script.src = '/js/branch-send.js';
      document.body.appendChild(script);
    }).catch(function () {
      // Restore the text and fall back to an ordinary submit.
      textarea.value = text;
      Array.prototype.forEach.call(form.elements, function (el) { el.disabled = false; });
      form.submit();
    });
  });
})();
