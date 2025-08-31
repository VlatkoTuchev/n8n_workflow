import { query } from '../config/db';

export async function createChatSession(userId: string | null, title: string | null) {
  const res = await query<{ id: string }>(
    `INSERT INTO chat_session (user_id, title) VALUES ($1, $2) RETURNING id`,
    [userId, title],
  );
  return { id: (res.rows as any)[0].id as string };
}

export async function addChatMessage(params: {
  sessionId: string;
  userId: string | null;
  role: 'user' | 'assistant' | 'system' | 'model';
  content: string;
}) {
  const { sessionId, userId, role, content } = params;
  // single-row JSON aggregate pattern
  await query(
    `INSERT INTO chat_message (session_id, user_id, role, content, updated_at)
     VALUES ($1, $2, 'system', '[]'::jsonb, now())
     ON CONFLICT (session_id, user_id) DO NOTHING`,
    [sessionId, userId],
  );
  const sel = await query<{ content: any }>(
    `SELECT content FROM chat_message WHERE session_id = $1 AND user_id = $2 FOR UPDATE`,
    [sessionId, userId],
  );
  let messages: any[] = [];
  try {
    const c = (sel.rows as any)[0]?.content;
    if (Array.isArray(c)) messages = c;
    else if (typeof c === 'string') messages = JSON.parse(c || '[]');
    else if (c && typeof c === 'object') messages = JSON.parse(JSON.stringify(c));
  } catch {
    messages = [];
  }
  const nowIso = new Date().toISOString();
  const roleNorm = role === 'assistant' ? 'model' : role;
  messages.push({ turn: messages.length + 1, role: roleNorm, text: String(content || ''), at: nowIso });
  await query(
    `UPDATE chat_message SET content = $3::jsonb, updated_at = now() WHERE session_id = $1 AND user_id = $2`,
    [sessionId, userId, JSON.stringify(messages)],
  );
  return { ok: true };
}


