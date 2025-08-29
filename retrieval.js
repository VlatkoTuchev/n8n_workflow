const { query, pool } = require('./db');
const crypto = require('crypto');
const { embedText } = require('./embed');

async function createChatSession({ userId, title }) {
  const res = await query(
    `INSERT INTO chat_session (user_id, title) VALUES ($1, $2) RETURNING id`,
    [userId || null, title || null]
  );
  return { id: res.rows[0].id };
}

// addSpokenLanguage removed

// ---------- Chat message persistence (single row per session_id,user_id with JSON conversation) ----------
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

    // Compute turn
    const nowIso = new Date().toISOString();
    let turn = 1;
    if (roleNorm === 'model') {
      const modelCount = messages.reduce((n, m) => n + (m && m.role === 'model' ? 1 : 0), 0);
      turn = modelCount + 1;
    } else {
      const last = messages[messages.length - 1];
      turn = (last && typeof last.turn === 'number' && last.turn > 0) ? last.turn : 1;
    }
    messages.push({ turn, role: roleNorm, text, at: nowIso });

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

async function saveSessionSummary({ sessionId, userId, summary, nextPrompt }) {
  const res = await query(
    `INSERT INTO chat_session_summary (session_id, user_id, summary, next_prompt, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (session_id, user_id)
     DO UPDATE SET summary = EXCLUDED.summary, next_prompt = EXCLUDED.next_prompt, updated_at = now()
     RETURNING id, session_id, user_id, summary, next_prompt, created_at, updated_at`,
    [sessionId || null, userId || null, String(summary || ''), nextPrompt || null]
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

/* ---------- New: users + KB helpers ---------- */
async function createUser({ email }) {
  const res = await query(
    `INSERT INTO app_user (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email]
  );
  return { id: res.rows[0].id };
}

async function createKb({ ownerUserId, name, visibility = 'private' }) {
  const res = await query(
    `INSERT INTO kb (owner_user_id, name, visibility)
     VALUES ($1, $2, $3) RETURNING id`,
    [ownerUserId || null, name, visibility]
  );
  return { id: res.rows[0].id };
}

function chunkByChars(text, size = 1200, overlap = 200) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + size);
    out.push(text.slice(i, end));
    if (end === text.length) break;
    i = end - Math.min(overlap, size);
  }
  return out;
}

async function kbAddText({ kbId, title = 'Untitled', text, mimeType = 'text/plain', metadata }) {
  if (!kbId || !text) throw new Error('kbId and text are required');
  const docRes = await query(
    `INSERT INTO kb_document (kb_id, source_uri, title, mime_type, metadata)
     VALUES ($1, NULL, $2, $3, $4) RETURNING id`,
    [kbId, title, mimeType, metadata || {}]
  );
  const documentId = docRes.rows[0].id;

  const revRes = await query(
    `SELECT COALESCE(MAX(rev),0)+1 AS next_rev FROM kb_document_revision WHERE document_id = $1`,
    [documentId]
  );
  const rev = revRes.rows[0].next_rev;
  const sha = crypto.createHash('sha256').update(text, 'utf8').digest();

  const revInsert = await query(
    `INSERT INTO kb_document_revision (document_id, rev, content_sha256, chunking_params)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [documentId, rev, sha, { size: 1200, overlap: 200 }]
  );
  const revisionId = revInsert.rows[0].id;

  const chunks = chunkByChars(text, 1200, 200);
  const embeddings = await embedText(chunks);
  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const vecLiteral = '[' + embeddings[i].join(',') + ']';
    const tokenCount = Math.ceil(chunks[i].length / 4);
    await query(
      `INSERT INTO kb_chunk (revision_id, chunk_index, text, token_count, embedding, metadata)
       VALUES ($1, $2, $3, $4, $5::vector, $6)`,
      [revisionId, i, chunks[i], tokenCount, vecLiteral, {}]
    );
    inserted++;
  }
  return { documentId, revisionId, chunks: inserted };
}

async function retrieveKb({ kbId, queryText, topK = 8 }) {
  const [qvec] = await embedText(queryText);
  const vecLiteral = '[' + qvec.join(',') + ']';
  const res = await query(
    `
    SELECT c.id, d.title, c.text,
           1 - (c.embedding <=> $1::vector) AS score
    FROM kb_chunk c
    JOIN kb_document_revision r ON c.revision_id = r.id
    JOIN kb_document d ON r.document_id = d.id
    WHERE d.kb_id = $2
    ORDER BY c.embedding <-> $1::vector
    LIMIT $3
    `,
    [vecLiteral, kbId, topK]
  );
  return res.rows;
}

module.exports = {
  createUser, createKb, kbAddText, retrieveKb,
  createChatSession,
  addChatMessage, getRecentMessages,
  saveSessionSummary, readLatestSummary,
  readPreferredLanguagePg, setPreferredLanguagePg
};