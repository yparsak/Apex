// App-wide lock gate (see ROADMAP.md Phase 22). Serves the maintenance page
// instead of the requested route whenever appLock.js reports a lock, from
// either source (an admin maintenance window, or an empty/fully-disabled model
// catalog).
//
// Admins are deliberately NOT blocked. If /admin were gated, the no-model lock
// would be unrecoverable by construction: a fresh install has no models, so the
// lock engages immediately, and the only page that can add one would be behind
// it. /login is open for the same reason - an admin has to be able to get in to
// unlock. Both still get res.locals.appLock, so views/partials/head.ejs can
// show a banner and a locked site is never invisible to the person who can
// change it.
//
// Static assets never reach here: express.static is mounted ahead of the
// session middleware this gate sits behind (see app.js).
const appLock = require('../lib/appLock');

// Prefix match, so sub-paths are covered too (/admin/models, /api/admin/locks).
const BYPASS_PREFIXES = ['/admin', '/api/admin', '/login', '/logout'];

function isBypassed(path) {
  return BYPASS_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

module.exports = async function appLockGate(req, res, next) {
  let state;
  try {
    state = await appLock.getLockState();
  } catch (err) {
    // A failed lock read must not take the site down - a DB blip here would
    // otherwise be indistinguishable from "locked" and block every request.
    // Failing open matches the rest of this codebase's degrade-don't-block
    // posture, and the no-model case it might wrongly let through is caught
    // again downstream by the adapter's own required-model check.
    return next();
  }

  // Set before the early returns, so the banner renders on the pages that
  // bypass the block (every admin page, and the login form) as well as on the
  // ones an admin is passing straight through.
  res.locals.appLock = state.locked ? state : null;

  if (!state.locked) return next();
  if (isBypassed(req.path)) return next();
  if (req.session && req.session.user && req.session.user.isAdmin) return next();

  // Cleared for the blocked case specifically: views/maintenance.ejs includes
  // partials/head, so leaving it set would stack the red banner directly above
  // a page that already states the same message - and the banner is worded for
  // someone who got THROUGH a locked app ("here's what everyone else is
  // seeing"), which is exactly backwards for the person being blocked.
  res.locals.appLock = null;

  // 503 + Retry-After rather than a 200: a maintenance window that reports
  // itself as healthy is invisible to any monitor or reverse proxy in front of
  // this app.
  res.status(503);
  res.set('Retry-After', '300');

  // An API client gets JSON, not an HTML page it would have to scrape to find
  // out what happened.
  if (req.path.startsWith('/api/')) {
    return res.json({ error: 'service_unavailable', reason: state.reason, message: state.message });
  }

  return res.render('maintenance', {
    title: 'Maintenance',
    user: req.session ? req.session.user : null,
    lock: state,
  });
};
