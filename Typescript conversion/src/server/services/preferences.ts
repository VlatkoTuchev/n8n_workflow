import { query } from '../config/db';

export async function readPreferredLanguage(userId: string) {
  const res = await query<{ preferred_language: string }>(
    `SELECT preferred_language FROM user_language WHERE user_id = $1`,
    [userId],
  );
  const row = (res.rows as any)[0];
  return { language: row ? row.preferred_language : null };
}

export async function setPreferredLanguage(userId: string, language: string) {
  await query(
    `INSERT INTO user_language (user_id, preferred_language, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id) DO UPDATE SET preferred_language = EXCLUDED.preferred_language, updated_at = now()`,
    [userId, language.trim()],
  );
  return { ok: true };
}

export async function readAgentSettings(userId: string) {
  const res = await query<{ preferred_agent_name: string; preferred_voice: string; preferred_style: string }>(
    `SELECT preferred_agent_name, preferred_voice, preferred_style FROM user_agent_settings WHERE user_id = $1`,
    [userId],
  );
  const row = (res.rows as any)[0];
  return {
    name: row ? row.preferred_agent_name : null,
    voice: row ? row.preferred_voice : null,
    style: row ? row.preferred_style : null,
  };
}

export async function setAgentSettings(userId: string, opts: { name?: string | null; voice?: string | null; style?: string | null }) {
  const normName = opts.name != null ? String(opts.name).trim() : null;
  const normVoice = opts.voice != null ? String(opts.voice).trim().toLowerCase() : null;
  const normStyle = opts.style != null ? String(opts.style).trim() : null;
  await query(
    `INSERT INTO user_agent_settings (user_id, preferred_agent_name, preferred_voice, preferred_style, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (user_id) DO UPDATE SET
       preferred_agent_name = COALESCE(EXCLUDED.preferred_agent_name, user_agent_settings.preferred_agent_name),
       preferred_voice = COALESCE(EXCLUDED.preferred_voice, user_agent_settings.preferred_voice),
       preferred_style = COALESCE(EXCLUDED.preferred_style, user_agent_settings.preferred_style),
       updated_at = now()`,
    [userId, normName, normVoice, normStyle],
  );
  return { ok: true };
}


