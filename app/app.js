// Express app assembly. Env vars must already be loaded (see server.js)
// before this module is required, since session config reads SESSION_SECRET
// at require-time.

const path = require('path');
const express = require('express');
const session = require('express-session');
const authRoutes = require('./routes/auth');
const repoRoutes = require('./routes/repos');
const pageRoutes = require('./routes/pages');
const logger = require('./lib/logger');

const app = express();

// Server-rendered pages (Phase 2) - EJS views under app/views, static JS/CSS
// under app/public served at the root path (e.g. app/public/js/x.js -> /js/x.js).
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());

// Server-side sessions. Store: in-memory (express-session default MemoryStore)
// for this local-dev/prototype stage — deliberate choice, see SETUP.md.
// If a persistent store is added later, name its table/collection something
// other than `sessions` — that name is already taken by the async AI-agent
// job table in db/schema.sql and must not collide with it.
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

app.use('/auth', authRoutes);
app.use('/api/repos', repoRoutes);
app.use('/', pageRoutes);

app.get('/health', (req, res) => {
  res.json({ success: true, message: 'ok', data: {} });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found', error: {} });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('unhandled error', { error: err.message });
  res.status(500).json({ success: false, message: 'Internal server error', error: {} });
});

module.exports = app;
