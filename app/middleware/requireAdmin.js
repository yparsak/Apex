function requireAdmin(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (!req.session.user.isAdmin) {
    return res.status(403).send('Forbidden: admin access required.');
  }
  next();
}

module.exports = requireAdmin;
