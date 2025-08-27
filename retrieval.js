const { query } = require('./db');
const { embedText } = require('./embed');

async function retrieveMemories({ userId, queryText, topK = 6, kind }) {
  const [qvec] = await embedText(queryText);
  // Convert JS array to Postgres vector literal
  const vecLiteral = '[' + qvec.join(',') + ']';
  const whereKind = kind ? `AND kind = $3` : '';
  const params = kind ? [userId, vecLiteral, kind, topK] : [userId, vecLiteral, topK];
  const sql = `
    SELECT id, user_id, kind, text, metadata_json,
           1 - (embedding <=> $2::vector) AS score
    FROM memories
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
    INSERT INTO memories (user_id, kind, text, embedding, metadata_json)
    VALUES ($1, $2, $3, $4::vector, $5)
    RETURNING id
  `;
  const res = await query(sql, [userId, kind, text, vecLiteral, metadata || {}]);
  return { id: res.rows[0].id };
}

module.exports = { retrieveMemories, saveMemory };
