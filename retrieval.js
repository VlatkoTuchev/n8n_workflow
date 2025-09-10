// ====================================================================================================
// Section: Imports and shared helpers
// - Retrieval layer for Postgres. See docs/CODE_OVERVIEW.md → "Postgres helpers — retrieval.js".
// ====================================================================================================
const { query, pool } = require('./db');
// Embeddings/KB removed: no longer importing './embed'

// ====================================================================================================
// Section: Chat sessions and messages
// - Session header and single-row JSON message storage per (session_id,user_id)
// ====================================================================================================
// [RT1] Sessions & messages
async function createChatSession({ userId, title }) {
  const res = await query(
    `INSERT INTO chat_session (user_id, title) VALUES ($1, $2) RETURNING id`,
    [userId || null, title || null]
  );
  return { id: res.rows[0].id };
}

// addSpokenLanguage removed

// ---------- Chat message persistence (single row per session_id,user_id with JSON conversation) ----------
/**
 * Append a turn to the aggregated JSON array in chat_message for (session_id,user_id).
 * Stored per item: role ('user'|'model'), text, UTC ISO time (at), epoch ms (ts),
 * timezone label (tz), formatted local time (at_local), and a computed assistant turn.
 */
async function addChatMessage({ sessionId, userId, role, content }) {
  const sid = sessionId || null;
  const uid = userId || null;
  const roleNorm = String(role || 'user').toLowerCase() === 'assistant' ? 'model' : 'user';
  const text = String(content || '');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Ensure row exists and lock it
    await client.query(
      `INSERT INTO chat_message (session_id, user_id, role, content, updated_at)
       VALUES ($1, $2, 'system', '[]'::jsonb, now())
       ON CONFLICT (session_id, user_id) DO NOTHING`,
      [sid, uid]
    );
    const sel = await client.query(
      `SELECT content FROM chat_message WHERE session_id = $1 AND user_id = $2 FOR UPDATE`,
      [sid, uid]
    );
    let messages = [];
    try {
      const c = sel.rows && sel.rows[0] ? sel.rows[0].content : [];
      if (Array.isArray(c)) messages = c; else if (typeof c === 'string') messages = JSON.parse(c || '[]'); else if (c && typeof c === 'object') messages = JSON.parse(JSON.stringify(c));
    } catch (_) { messages = []; }

    // Compute turn and timestamps (store UTC and convenient local info)
    const now = new Date();
    const nowIso = now.toISOString(); // canonical UTC
    const tz = String(process.env.APP_TIMEZONE || 'Europe/Skopje');
    let atLocal = null;
    try {
      atLocal = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).format(now).replace(',', '');
    } catch (_) { atLocal = null; }
    let turn = 1;
    if (roleNorm === 'model') {
      const modelCount = messages.reduce((n, m) => n + (m && m.role === 'model' ? 1 : 0), 0);
      turn = modelCount + 1;
    } else {
      const last = messages[messages.length - 1];
      turn = (last && typeof last.turn === 'number' && last.turn > 0) ? last.turn : 1;
    }
    messages.push({ turn, role: roleNorm, text, at: nowIso, ts: now.getTime(), tz, at_local: atLocal });

    // Save back
    await client.query(
      `UPDATE chat_message SET content = $3::jsonb, updated_at = now() WHERE session_id = $1 AND user_id = $2`,
      [sid, uid, JSON.stringify(messages)]
    );
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

// ====================================================================================================
// Section: Summaries and preferences (Postgres)
// - chat_session_summary holds the cumulative session summary used for continuity
// - user_language stores a single preferred language per user
// ====================================================================================================
async function getRecentMessages({ sessionId, n = 50 }) {
  const res = await query(
    `SELECT id, session_id, user_id, role, content, created_at
       FROM chat_message
      WHERE session_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [sessionId, Math.min(Math.max(n, 1), 200)]
  );
  return res.rows;
}

// [RT2] Summaries & preferences
async function saveSessionSummary({ sessionId, userId, summary }) {
  const res = await query(
    `INSERT INTO chat_session_summary (session_id, user_id, summary, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (session_id, user_id)
     DO UPDATE SET summary = EXCLUDED.summary, updated_at = now()
     RETURNING id, session_id, user_id, summary, created_at, updated_at`,
    [sessionId || null, userId || null, String(summary || '')]
  );
  return res.rows[0];
}

async function readLatestSummary({ userId }) {
  const res = await query(
      `SELECT id, session_id, summary, next_prompt, created_at
          FROM chat_session_summary
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    );
  return res.rows[0] || null;
}

// Preferred language (Postgres)
async function readPreferredLanguagePg({ userId }) {
  const res = await query(
    `SELECT preferred_language FROM user_language WHERE user_id = $1`,
    [userId]
  );
  return { language: (res.rows[0] && res.rows[0].preferred_language) || null };
}

async function setPreferredLanguagePg({ userId, language }) {
  const normalized = String(language || '').trim();
  if (!userId || !normalized) throw new Error('userId and language are required');
  await query(
    `INSERT INTO user_language (user_id, preferred_language, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET preferred_language = EXCLUDED.preferred_language, updated_at = now()`,
    [userId, normalized]
  );
  return { ok: true };
}

// ====================================================================================================
// Section: Users (identity records only)
// - KB functions removed (no embeddings / vector search in this setup)
// ====================================================================================================
// [RT3] Users & KB
async function createUser({ email }) {
  const res = await query(
    `INSERT INTO app_user (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email]
  );
  return { id: res.rows[0].id };
}

module.exports = {
  createUser,
  createChatSession,
  addChatMessage, getRecentMessages,
  saveSessionSummary, readLatestSummary,
  readPreferredLanguagePg, setPreferredLanguagePg,
  readAgentNamePg, setAgentNamePg,
  readAgentSettingsPg, setAgentSettingsPg,
  ensureMemoryTables, upsertUserMemoryItems, selectTopKUserMemory,
  setUserDigest, getUserDigest, getRecentSummaries
};

// ====================================================================================================
// Section: Lean memory tables & helpers
// - user_memory: atomic items ranked by pinned → stability → recency
// - user_digest: short rolling digest for voice session personalization
// ====================================================================================================
// [RT4] Memory & agent settings
async function ensureMemoryTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS user_memory (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES app_user(id) ON DELETE CASCADE,
      type text NOT NULL CHECK (type IN ('fact','preference','goal','progress','open_question')),
      statement text NOT NULL,
      first_seen date DEFAULT now(),
      last_seen date DEFAULT now(),
      stability text DEFAULT 'med',
      pinned boolean DEFAULT false,
      UNIQUE(user_id, statement)
    );
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS user_memory_user_type_last_idx
      ON user_memory(user_id, type, last_seen DESC);
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_digest (
      user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
      digest_text text,
      updated_at timestamptz DEFAULT now()
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS user_agent_settings (
      user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
      preferred_agent_name text,
      preferred_voice text,
      preferred_style text,
      updated_at timestamptz DEFAULT now()
    );
  `);
  await query(`ALTER TABLE user_agent_settings ADD COLUMN IF NOT EXISTS preferred_voice text`);
  await query(`ALTER TABLE user_agent_settings ADD COLUMN IF NOT EXISTS preferred_style text`);
}

async function upsertUserMemoryItems(userId, items = []) {
  if (!userId || !Array.isArray(items) || items.length === 0) return { upserted: 0 };
  let n = 0;
  for (const it of items) {
    const type = String(it.type || '').trim();
    const stmt = String(it.statement || '').trim();
    if (!type || !stmt) continue;
    const stability = (it.stability && String(it.stability).trim()) || null;
    const pinned = it.pinned === true;
    await query(
      `INSERT INTO user_memory (user_id, type, statement, stability, pinned)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, statement)
       DO UPDATE SET last_seen = now(),
                     stability = COALESCE(EXCLUDED.stability, user_memory.stability),
                     pinned = GREATEST(user_memory.pinned::int, EXCLUDED.pinned::int)::boolean`,
      [userId, type, stmt, stability, pinned]
    );
    n += 1;
  }
  return { upserted: n };
}

async function selectTopKUserMemory(userId, limits) {
  const defs = Object.assign({ fact: 6, preference: 6, goal: 5, progress: 5, open_question: 3 }, limits || {});
  const out = { facts: [], preferences: [], goals: [], progress: [], open_questions: [] };
  async function grab(t, k) {
    const res = await query(
      `SELECT statement, pinned, stability, last_seen
         FROM user_memory
        WHERE user_id = $1 AND type = $2
        ORDER BY pinned DESC,
                 CASE stability WHEN 'long' THEN 3 WHEN 'med' THEN 2 ELSE 1 END DESC,
                 last_seen DESC
        LIMIT $3`,
      [userId, t, Math.max(0, k)]
    );
    return res.rows || [];
  }
  out.facts = await grab('fact', defs.fact);
  out.preferences = await grab('preference', defs.preference);
  out.goals = await grab('goal', defs.goal);
  out.progress = await grab('progress', defs.progress);
  out.open_questions = await grab('open_question', defs.open_question);
  return out;
}

async function setUserDigest(userId, digestText) {
  await query(
    `INSERT INTO user_digest (user_id, digest_text, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id)
     DO UPDATE SET digest_text = EXCLUDED.digest_text, updated_at = now()`,
    [userId, digestText || null]
  );
  return { ok: true };
}

async function getUserDigest(userId) {
  const r = await query(`SELECT digest_text FROM user_digest WHERE user_id = $1`, [userId]);
  return (r.rows && r.rows[0] && r.rows[0].digest_text) || null;
}

async function getRecentSummaries(userId, n = 12) {
  const r = await query(
    `SELECT summary FROM chat_session_summary
      WHERE user_id = $1 AND summary IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [userId || null, Math.max(1, Math.min(20, n))]
  );
  return (r.rows || []).map(x => String(x.summary || ''));
}

async function readAgentNamePg({ userId }) {
  const res = await query(
    `SELECT preferred_agent_name FROM user_agent_settings WHERE user_id = $1`,
    [userId]
  );
  return { name: (res.rows[0] && res.rows[0].preferred_agent_name) || null };
}

async function setAgentNamePg({ userId, name }) {
  const normalized = String(name || '').trim();
  if (!userId || !normalized) throw new Error('userId and name are required');
  await query(
    `INSERT INTO user_agent_settings (user_id, preferred_agent_name, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET preferred_agent_name = EXCLUDED.preferred_agent_name, updated_at = now()`,
    [userId, normalized]
  );
  return { ok: true };
}

async function readAgentSettingsPg({ userId }) {
  const res = await query(
    `SELECT preferred_agent_name, preferred_voice, preferred_style FROM user_agent_settings WHERE user_id = $1`,
    [userId]
  );
  const row = res.rows && res.rows[0];
  return {
    name: row ? row.preferred_agent_name : null,
    voice: row ? row.preferred_voice : null,
    style: row ? row.preferred_style : null
  };
}

async function setAgentSettingsPg({ userId, name, voice, style }) {
  if (!userId) throw new Error('userId required');
  const normName = name != null ? String(name).trim() : null;
  const normVoice = voice != null ? String(voice).trim().toLowerCase() : null;
  const normStyle = style != null ? String(style).trim() : null;
  await query(
    `INSERT INTO user_agent_settings (user_id, preferred_agent_name, preferred_voice, preferred_style, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE SET
       preferred_agent_name = COALESCE(EXCLUDED.preferred_agent_name, user_agent_settings.preferred_agent_name),
       preferred_voice = COALESCE(EXCLUDED.preferred_voice, user_agent_settings.preferred_voice),
       preferred_style = COALESCE(EXCLUDED.preferred_style, user_agent_settings.preferred_style),
       updated_at = now()`,
    [userId, normName, normVoice, normStyle]
  );
  return { ok: true };
}
