import { openai, SUMMARY_MODEL } from '../config/openai';
import { query } from '../config/db';
import { upsertUserMemoryItems, setUserDigest } from './memory';

export async function summarizeAndSaveSession(sessionId: string, userId: string | null) {
  // Attempt transcript from chat_message JSON aggregate
  let transcript = '';
  try {
    const agg = await query<{ content: any }>(
      `SELECT content FROM chat_message WHERE session_id = $1 AND ($2::uuid IS NULL OR user_id = $2) LIMIT 1`,
      [sessionId, userId || null],
    );
    const arr = (agg.rows as any)[0]?.content;
    if (arr && Array.isArray(arr)) transcript = arr.map((m: any) => `${m.role === 'model' ? 'Assistant' : 'User'}: ${String(m.text || '').trim()}`).join('\n');
  } catch {}
  if (!transcript) return { saved: false, reason: 'no_conversation' } as const;

  // Prior summaries (latest first)
  let priorSummaries = '';
  try {
    const hist = await query<{ summary: string; created_at: string }>(
      `SELECT summary, created_at FROM chat_session_summary WHERE user_id = $1 AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 12`,
      [userId || null],
    );
    if ((hist.rows as any).length) {
      priorSummaries = (hist.rows as any)
        .map((r: any, i: number) => `[${new Date(r.created_at).toISOString().slice(0,10)}] S${i+1}: ${String(r.summary || '').trim()}`)
        .join('\n\n');
    }
  } catch {}

  const sys = 'You write an internal cumulative memory note for the assistant (not a reply to the user). Keep only durable items: facts, preferences, goals, progress, and open questions. Length: 150–300 words. No questions or greetings.';
  const prompt = `${userId ? `User ID: ${userId}.` : ''}\n\nPrior summaries (newest first):\n${priorSummaries || '(none)'}\n\nCurrent transcript:\n${transcript}\n\nWrite one cumulative memory now. Plain text only.`;
  const completion = await openai.chat.completions.create({
    model: SUMMARY_MODEL,
    messages: [ { role: 'system', content: sys }, { role: 'user', content: prompt } ],
    temperature: 0.3,
    max_tokens: 600,
  });
  const summaryText = (completion.choices?.[0]?.message?.content || '').trim();
  if (!summaryText) return { saved: false, reason: 'summary_failed' } as const;

  const saved = await query(
    `INSERT INTO chat_session_summary (session_id, user_id, summary, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (session_id, user_id) DO UPDATE SET summary = EXCLUDED.summary, updated_at = now() RETURNING id, summary`,
    [sessionId, userId, summaryText],
  );
  const savedRow = (saved.rows as any)[0];

  // Extract atomic memory
  try {
    const extractSys = 'Extract atomic user memory items as strict JSON. Schema: { items: [ { type:"fact|preference|goal|progress|open_question", statement:string, stability?:"short|med|long", pinned?:boolean } ] }';
    const extract = await openai.chat.completions.create({
      model: SUMMARY_MODEL,
      messages: [ { role: 'system', content: extractSys }, { role: 'user', content: summaryText } ],
      temperature: 0,
      max_tokens: 400,
    });
    let items: any[] = [];
    try { items = JSON.parse(extract.choices?.[0]?.message?.content || '{}')?.items || []; } catch {}
    if (items.length && userId) await upsertUserMemoryItems(userId, items);
  } catch {}

  // Rebuild digest
  try {
    const recents = await query<{ summary: string }>(
      `SELECT summary FROM chat_session_summary WHERE user_id=$1 AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 12`,
      [userId || null],
    );
    const digestPrompt = (recents.rows as any).map((r: any, i: number) => `S${i+1}: ${String(r.summary || '')}`).join('\n\n') || '(none)';
    const digestSys = 'Produce a 150–300 token rolling digest of the user\'s recent sessions. No greetings or questions.';
    const dig = await openai.chat.completions.create({
      model: SUMMARY_MODEL,
      messages: [ { role: 'system', content: digestSys }, { role: 'user', content: digestPrompt } ],
      temperature: 0.2,
      max_tokens: 320,
    });
    const digestText = (dig.choices?.[0]?.message?.content || '').trim();
    if (digestText && userId) await setUserDigest(userId, digestText);
  } catch {}

  return { saved: true, id: savedRow.id, summary: savedRow.summary } as const;
}


