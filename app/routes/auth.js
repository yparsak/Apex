const express = require('express');
const authProvider = require('../lib/auth/authProvider');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await authProvider.authenticate({ username, password });

  if (!user) {
    return res.render('login', { error: 'Invalid username or password.' });
  }

  req.session.user = user;
  res.redirect('/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
