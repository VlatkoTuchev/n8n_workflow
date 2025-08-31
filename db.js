// ====================================================================================================
// Section: Postgres pool and query helper
// - Centralized pg Pool configured via DATABASE_URL
// ====================================================================================================
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('connect', (client) => {
  client.query(`SET TIME ZONE '${process.env.APP_TIMEZONE || 'Europe/Skopje'}'`).catch(() => {});
});

// Simple helper to borrow a client, run a single query, and release
async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}

module.exports = { pool, query };
