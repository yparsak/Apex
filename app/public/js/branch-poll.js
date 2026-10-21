// Keeps the branch page's pipeline stepper current while a run is in flight
// (see ROADMAP.md Phase 31). This is the first client-side JavaScript in
// Apex, so the shape of it is the precedent for the ones that follow:
//
// - It is an enhancement over a page that is already correct at render time
//   and correct again after a refresh. With this file blocked or broken the
//   user loses live updates and nothing else.
// - It only writes to elements the view rendered for it (data-* hooks), and
//   it never creates a control. Nothing here starts, stops or changes a
//   pipeline; the only request it makes is a GET.
// - It stops for good at the first terminal status, and it says so in the
//   indicator whenever it stops for any other reason. An indicator that
//   cannot report its own failure is worse than none.
(function () {
  'use strict';

  // document.currentScript is set while a deferred classic script runs; the
  // querySelector is the fallback, not the main path.
  var script = document.currentScript || document.querySelector('script[data-status-url]');
  if (!script) return;

  var statusUrl = script.getAttribute('data-status-url');
  if (!statusUrl) return;

  // The worker's own tick, handed over by the server (see
  // app/lib/pipelinePolling.js). Polling faster than the worker asks the
  // database for changes that cannot have happened yet, so a missing or
  // nonsensical value falls back up to 5s rather than down.
  var intervalMs = Number(script.getAttribute('data-poll-interval'));
  if (!isFinite(intervalMs) || intervalMs < 1000) intervalMs = 5000;

  // Three consecutive transport failures, then stop and say so. A single
  // blip during a deploy or a dropped wifi packet should not take the page
  // out of live mode; a server that is actually gone should not be retried
  // for ever.
  var MAX_CONSECUTIVE_FAILURES = 3;

  var indicator = document.querySelector('[data-poll-indicator]');
  var indicatorText = document.querySelector('[data-poll-text]');
  var statusLine = document.querySelector('[data-pipeline-status]');
  var elapsedLine = document.querySelector('[data-pipeline-elapsed]');
  var stallLine = document.querySelector('[data-pipeline-stall]');
  var topStepper = document.querySelector('[data-top-stepper]');
  var subStepper = document.querySelector('[data-sub-stepper]');

  var timer = null;
  var failures = 0;
  var stopped = false;
  var inFlight = false;
  // Distinguishes the one resumable stop (tab went to the background) from
  // every permanent one (terminal status, dead server, refusal). Sharing the
  // indicator's state class between the two would let a resume restart
  // polling after a run had already finished.
  var pausedForHidden = false;

  function setIndicator(state, text) {
    if (!indicator) return;
    indicator.classList.remove('poll-active', 'poll-idle', 'poll-error');
    indicator.classList.add(state);
    if (indicatorText) indicatorText.textContent = text;
  }

  function clockTime(iso) {
    var when = iso ? new Date(iso) : new Date();
    if (isNaN(when.getTime())) when = new Date();
    return when.toLocaleTimeString();
  }

  // Every exit from live mode goes through here, so there is exactly one
  // place that can leave the timer running or the indicator animating over
  // data nobody is refreshing any more.
  function stop(state, text) {
    stopped = true;
    pausedForHidden = false;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    setIndicator(state, text);
  }

  function schedule() {
    if (stopped) return;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(poll, intervalMs);
  }

  function renderSteps(list, steps) {
    if (!list || !steps) return;
    // Rebuilt rather than diffed: five <li>s of text is not worth the
    // bookkeeping, and a full rebuild cannot drift from the server's view
    // the way a partial update can.
    var html = '';
    for (var i = 0; i < steps.length; i += 1) {
      var step = steps[i];
      html +=
        '<li class="step step-' +
        String(step.state).replace(/[^a-z]/g, '') +
        '">' +
        String(step.label).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
        '</li>';
    }
    list.innerHTML = html;
  }

  function apply(data) {
    if (statusLine) {
      statusLine.textContent = 'Status: ' + data.status;
      statusLine.className = 'pipeline-status pipeline-' + String(data.status).replace(/[^a-z_]/g, '');
    }

    renderSteps(topStepper, data.topStepper);

    if (subStepper) {
      if (data.subStepper && data.subStepper.length) {
        renderSteps(subStepper, data.subStepper);
        subStepper.hidden = false;
      } else {
        subStepper.hidden = true;
      }
    }

    if (elapsedLine && data.elapsedLabel) {
      elapsedLine.textContent = (data.status === 'queued' ? 'Queued for ' : 'Running for ') + data.elapsedLabel;
      elapsedLine.hidden = false;
    }

    // The stall note is the one thing here that must win over the
    // indicator: a live dot ticking over an unchanging status reads as
    // progress, which is exactly the misreading this phase exists to stop.
    if (stallLine) {
      if (data.stallMessage) {
        stallLine.textContent = data.stallMessage;
        stallLine.hidden = false;
      } else {
        stallLine.hidden = true;
        stallLine.textContent = '';
      }
    }
  }

  function poll() {
    if (stopped || inFlight) return;

    // A background tab is not being watched, and browsers throttle its
    // timers anyway - so say "not updating" rather than animate behind the
    // user's back. visibilitychange below picks it straight back up.
    if (document.hidden) {
      stop('poll-idle', 'Not updating while this tab is in the background — it resumes when you come back.');
      pausedForHidden = true;
      return;
    }

    inFlight = true;
    window
      .fetch(statusUrl, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      })
      .then(function (res) {
        // A 403, 404 or a redirect to /login is an answer, not a blip:
        // retrying it cannot change it, so this stops on the first one.
        if (!res.ok) {
          stop('poll-error', 'Stopped watching (the server answered ' + res.status + ') — refresh this page.');
          return null;
        }
        // An expired login, or a session this user no longer has on the
        // branch, answers 200 with a *redirect already followed* to an HTML
        // page (see requireAuth and loadBranchSession). Parsing that as JSON
        // would fail three times and then blame the network, so the
        // content-type is checked and treated as the permanent answer it is.
        var contentType = res.headers.get('content-type') || '';
        if (contentType.indexOf('application/json') === -1) {
          stop('poll-error', 'Stopped watching — this page needs a refresh (you may have been signed out).');
          return null;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data || stopped) return;
        failures = 0;
        apply(data);

        if (data.terminal) {
          // One full reload, because completion also brings the build and
          // test logs, the commit SHA, the failure actions and a released
          // pipeline lock - and a server-side render is the only way all of
          // those arrive consistent with each other.
          stop('poll-idle', 'Run finished — reloading the page…');
          window.location.reload();
          return;
        }

        setIndicator('poll-active', 'Watching this run — last checked ' + clockTime(data.checkedAt) + '.');
        schedule();
      })
      .catch(function () {
        if (stopped) return;
        failures += 1;
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          stop('poll-error', 'Not updating — could not reach the server. Refresh this page.');
          return;
        }
        setIndicator('poll-error', 'Could not reach the server — retrying (' + failures + '/' + MAX_CONSECUTIVE_FAILURES + ').');
        schedule();
      })
      .then(function () {
        inFlight = false;
      });
  }

  // fetch is the only modern API this depends on; on a browser without it the
  // page simply stays the snapshot it already is.
  if (typeof window.fetch !== 'function') return;

  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !pausedForHidden) return;
    pausedForHidden = false;
    stopped = false;
    poll();
  });

  setIndicator('poll-active', 'Watching this run — checking every ' + Math.round(intervalMs / 1000) + 's.');
  schedule();
})();
