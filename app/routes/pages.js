// Server-rendered view routes (Phase 2). These are thin shells only - all
// data comes from the JSON API under /api/repos via app/public/js/*, never
// rendered directly into the template - so the API stays the single source
// of truth for both curl-level testing and the browser UI.
//
// Auth guard: page routes use a redirect-to-/login guard, NOT the JSON
// `requireAuth` middleware used by app/routes/repos.js - a browser
// navigating to a protected page unauthenticated should land on the login
// form, not see a raw {success:false} JSON body. The JSON API still 401s
// via the shared envelope, since its callers are fetch() calls that need a
// machine-readable status, not a redirect.

const express = require('express');

const router = express.Router();

function requirePageAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  return next();
}

router.get('/', (req, res) => res.redirect('/login'));

router.get('/login', (req, res) => {
  res.render('login');
});

router.get('/repos', requirePageAuth, (req, res) => {
  res.render('repos', { user: req.session.user });
});

router.get('/repos/:repoId/branches', requirePageAuth, (req, res) => {
  const repoId = Number(req.params.repoId);
  if (!Number.isInteger(repoId) || repoId <= 0) {
    return res.redirect('/repos');
  }
  return res.render('branches', { user: req.session.user, repoId });
});

module.exports = router;
