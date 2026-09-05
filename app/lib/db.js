// DB connection module — mysql2 connection pool (MariaDB-compatible), configured
// entirely from env vars matching .env.example. Import `pool` or use `query()`
// as a thin convenience wrapper; keep raw SQL in the calling module.

const mysql = require('mysql2/promise');
const logger = require('./logger');

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function query(sql, params) {
  try {
    const [rows] = await pool.execute(sql, params);
    return rows;
  } catch (err) {
    logger.error('db query failed', { sql, error: err.message });
    throw err;
  }
}

module.exports = { pool, query };
