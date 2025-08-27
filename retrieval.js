const { query } = require('./db');
const { embedText } = require('./embed');
const crypto = require('crypto');

async function retrieveMemories({ userId, queryText, topK = 6, kind }) {
  const [qvec] = await embedText(queryText);
  const vecLiteral = '[' + qvec.join(',') + ']';
  const whereKind = kind ? `AND kind = $3` : '';
  const params = kind ? [userId, vecLiteral, kind, topK] : [userId, vecLiteral, topK];
  const sql = `
    SELECT id, user_id, kind, text, metadata,
           1 - (embedding <=> $2::vector) AS score
    FROM user_memory
    WHERE user_id = $1 ${whereKind}
    ORDER BY embedding <-> $2::vector
    LIMIT $${kind ? 4 : 3}
  `;
  const res = await query(sql, params);
  return res.rows;
}

async function saveMemory({ userId, kind, text, metadata }) {
  const [vec] = await embedText(text);
  const vecLiteral = '[' + vec.join(',') + ']';
  const sql = `
    INSERT INTO user_memory (user_id, kind, text, embedding, metadata)
    VALUES ($1, $2, $3, $4::vector, $5)
    RETURNING id
  `;
  const res = await query(sql, [userId, kind, text, vecLiteral, metadata || {}]);
  return { id: res.rows[0].id };
}

async function editMemory({ id, userId, text, kind, metadata }) {
  let embeddingLiteral = null;
  if (typeof text === 'string' && text.trim().length > 0) {
    const [vec] = await embedText(text);
    embeddingLiteral = '[' + vec.join(',') + ']';
  }
  const sets = [];
  const params = [];
  let p = 1;
  if (text != null) { sets.push(`text = $${p++}`); params.push(text); }
  if (kind != null) { sets.push(`kind = $${p++}`); params.push(kind); }
  if (metadata != null) { sets.push(`metadata = $${p++}`); params.push(metadata); }
  if (embeddingLiteral != null) { sets.push(`embedding = $${p++}::vector`); params.push(embeddingLiteral); }
  if (sets.length === 0) return { id };
  params.push(id, userId);
  const sql = `UPDATE user_memory SET ${sets.join(', ')} WHERE id = $${p++} AND user_id = $${p} RETURNING id`;
  const res = await query(sql, params);
  if (!res.rows[0]) throw new Error('Not found');
  return { id: res.rows[0].id };
}

async function setPreferredLanguage({ userId, language }) {
  const normalized = String(language || '').trim();
  if (!userId || !normalized) throw new Error('userId and language are required');

  // Find latest personal memory that already stores preferred_language
  const existing = await query(
    `SELECT id, metadata FROM user_memory
     WHERE user_id = $1 AND kind = 'personal' AND (metadata->>'preferred_language') IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );

  const text = `preferred_language: ${normalized}`;

  if (existing.rows[0]) {
    const mem = existing.rows[0];
    const meta = Object.assign({}, mem.metadata || {});
    meta.preferred_language = normalized;
    return editMemory({ id: mem.id, userId, text, metadata: meta });
  }

  return saveMemory({ userId, kind: 'personal', text, metadata: { preferred_language: normalized } });
}

async function readPreferredLanguage({ userId }) {
  const res = await query(
    `SELECT metadata->>'preferred_language' AS language
     FROM user_memory
     WHERE user_id = $1 AND kind = 'personal' AND (metadata->>'preferred_language') IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return { language: (res.rows[0] && res.rows[0].language) || null };
}

async function createChatSession({ userId, title }) {
  const res = await query(
    `INSERT INTO chat_session (user_id, title) VALUES ($1, $2) RETURNING id`,
    [userId || null, title || null]
  );
  return { id: res.rows[0].id };
}

async function addSpokenLanguage({ userId, language }) {
  const sel = await query(
    `SELECT id, metadata FROM user_memory
     WHERE user_id = $1 AND kind = 'personal'
       AND ((metadata ? 'language_history') OR (metadata->>'preferred_language') IS NOT NULL)
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const normalized = String(language || '').trim();
  if (!sel.rows[0]) {
    return saveMemory({ userId, kind: 'personal', text: 'language_profile', metadata: { language_history: [normalized] } });
  }
  const mem = sel.rows[0];
  const meta = Object.assign({}, mem.metadata || {});
  const history = Array.isArray(meta.language_history) ? meta.language_history.slice() : [];
  if (!history.includes(normalized)) history.push(normalized);
  meta.language_history = history;
  return editMemory({ id: mem.id, userId, metadata: meta });
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
  retrieveMemories, saveMemory, editMemory,
  setPreferredLanguage, readPreferredLanguage, addSpokenLanguage,
  createUser, createKb, kbAddText, retrieveKb,
  createChatSession
};