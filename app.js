require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);

const authRoutes = require('./app/routes/auth');
const accountRoutes = require('./app/routes/account');
const homeRoutes = require('./app/routes/home');
const adminRoutes = require('./app/routes/admin');
const reposRoutes = require('./app/routes/repos');
const documentsRoutes = require('./app/routes/documents');
const apiAdminRoutes = require('./app/routes/apiAdmin');
const authProvider = require('./app/lib/auth/authProvider');
const { initProcessLogger } = require('./app/lib/logger');
const logRetention = require('./app/lib/logRetention');

const logger = initProcessLogger('app');
const app = express();

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.use(express.static(__dirname + '/public'));
app.use(express.urlencoded({ extended: false }));

// Manages its own connection pool, separate from app/lib/db.js's promise pool
// (this package needs callback-style mysql2, not mysql2/promise).
// Table name deliberately differs from the app's own `sessions` table
// (AI pipeline sessions) - see db/schema.sql.
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  schema: {
    tableName: 'express_sessions',
    columnNames: {
      session_id: 'session_id',
      expires: 'expires',
      data: 'data',
    },
  },
});

app.use(
  session({
    key: 'apex_session',
    secret: process.env.SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

// Exposed to every view via res.locals merge (see ROADMAP.md Phase 17) so
// partials/head's "Change Password" link can gate on it without every route
// handler threading it through render options.
app.use((req, res, next) => {
  res.locals.managesPasswordsLocally = authProvider.managesPasswordsLocally;
  next();
});

app.use(authRoutes);
app.use(accountRoutes);
app.use(homeRoutes);
app.use('/admin', adminRoutes);
app.use('/repos', reposRoutes);
app.use('/documents', documentsRoutes);
app.use('/api/admin', apiAdminRoutes);

logRetention.schedulePurge(logger);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  logger.info({ port }, 'Apex listening');
});
