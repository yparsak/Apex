// Entrypoint. Loads env vars, fails fast if required config is missing,
// then starts the HTTP server.

require('dotenv').config();

const logger = require('./app/lib/logger');

if (!process.env.SESSION_SECRET) {
  logger.error('SESSION_SECRET is not set in the environment; refusing to start.');
  process.exit(1);
}

const app = require('./app/app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`Apex server listening on port ${PORT}`);
});
