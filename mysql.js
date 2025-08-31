// ====================================================================================================
// Section: MySQL pool and query helper
// - Uses mysql2/promise; credentials via env vars (MYSQL_*). Primary source of truth data.
// ====================================================================================================
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'ai_cdc',
  password: process.env.MYSQL_PASSWORD || 'ai_cdc_pwd',
  database: process.env.MYSQL_DB || 'aiatwork',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Execute a prepared statement and return rows
async function query(sql, params) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

module.exports = { pool, query };
