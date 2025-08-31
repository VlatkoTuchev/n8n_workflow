import { query } from '../config/db';

export async function ensureMemoryTables() {
  await query(`CREATE TABLE IF NOT EXISTS user_memory (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid REFERENCES app_user(id) ON DELETE CASCADE,
    type text NOT NULL CHECK (type IN ('fact','preference','goal','progress','open_question')),
    statement text NOT NULL,
    first_seen date DEFAULT now(),
    last_seen date DEFAULT now(),
    stability text DEFAULT 'med',
    pinned boolean DEFAULT false,
    UNIQUE(user_id, statement)
  );`);
  await query(`CREATE TABLE IF NOT EXISTS user_digest (
    user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
    digest_text text,
    updated_at timestamptz DEFAULT now()
  );`);
}

export async function upsertUserMemoryItems(userId: string, items: Array<{ type: string; statement: string; stability?: string; pinned?: boolean }>) {
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
      [userId, type, stmt, stability, pinned],
    );
    n += 1;
  }
  return { upserted: n };
}

export async function selectTopKUserMemory(userId: string, limits?: Partial<Record<'fact'|'preference'|'goal'|'progress'|'open_question', number>>) {
  const defs = Object.assign({ fact: 6, preference: 6, goal: 5, progress: 5, open_question: 3 }, limits || {});
  async function grab(t: string, k: number) {
    const res = await query(
      `SELECT statement, pinned, stability, last_seen
         FROM user_memory
        WHERE user_id = $1 AND type = $2
        ORDER BY pinned DESC,
                 CASE stability WHEN 'long' THEN 3 WHEN 'med' THEN 2 ELSE 1 END DESC,
                 last_seen DESC
        LIMIT $3`,
      [userId, t, Math.max(0, k)],
    );
    return (res.rows as any) || [];
  }
  return {
    facts: await grab('fact', defs.fact!),
    preferences: await grab('preference', defs.preference!),
    goals: await grab('goal', defs.goal!),
    progress: await grab('progress', defs.progress!),
    open_questions: await grab('open_question', defs.open_question!),
  };
}

export async function setUserDigest(userId: string, digestText: string) {
  await query(
    `INSERT INTO user_digest (user_id, digest_text, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id)
     DO UPDATE SET digest_text = EXCLUDED.digest_text, updated_at = now()`,
    [userId, digestText || null],
  );
  return { ok: true };
}


