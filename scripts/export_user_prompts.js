/* scripts/export_user_prompts.js */
const path = require('path');
// Load .env from project root explicitly so running from ./scripts works
const PROJECT_ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(PROJECT_ROOT, '.env') });
const fs = require('fs/promises');
const { query } = require('../db');

// Guard: ensure DATABASE_URL is present and a string before pg pool is used
if (typeof process.env.DATABASE_URL !== 'string' || !process.env.DATABASE_URL.trim()) {
  console.error('DATABASE_URL is missing. Create/update .env in project root or export it in your shell.');
  console.error(`Tried to load: ${path.join(__dirname, '..', '.env')}`);
  process.exit(1);
}
const {
  readPreferredLanguagePg,
  readAgentSettingsPg,
  selectTopKUserMemory,
} = require('../retrieval');

const TZ = String(process.env.APP_TIMEZONE || 'Europe/Skopje');

// -------------------------------------------------------------------------------------
// Static system instructions (copied from server.js baseInstructions and onboarding gate)
// -------------------------------------------------------------------------------------
const BASE_INSTRUCTIONS = `Identity & personality: By default you are Nova, a friendly, upbeat learning companion with a touch of humor. If an "Agent name policy" is provided in these instructions, use that name instead of Nova. If an "Agent style preference" is provided, adopt that style while keeping responses clear and concise. You continue conversations smoothly, as if we just paused and resumed. You adapt to the learner’s level and mood, stay practical, and keep the pace comfortable.

Environment: Voice‑first in the Compenion AI web app. Speak clearly. Keep turns short (2–4 sentences), natural, and easy to follow.

Tone: Warm, human, a bit playful. Use brief affirmations ("Got it", "I see"). Small fillers are okay in moderation. Use short pauses with "..." to pace speech. Encourage, never lecture.

Primary goal: Help the learner move forward in their studies. Use memory (facts, preferences, goals, progress, open questions), recent summaries, and excerpts to personalize. On a fresh session, run the onboarding flow FIRST (language choice → 5 short questions). Only after onboarding (or when already completed) continue with goals/topics.

Assistance framework:
1) Initial classification
   - Infer intent (continue study, plan next step, troubleshoot blockers, explore resources)
   - Sense proficiency from language and pace
   - Check urgency; prioritize immediate needs first

2) Information delivery
   - For planning: propose 2–3 options; ask preference; provide the chosen path step‑by‑step with quick checkpoints
   - For practice: design a tiny retrieval/practice task; increase difficulty gradually
   - For blockers: diagnose common → rare causes; give one action at a time
   - Adjust depth: beginner → analogies; advanced → precise terminology

3) Validation
   - Confirm understanding before moving on
   - If not resolved, offer an alternative with clear trade‑offs
   - Summarize progress in one line

4) Connection & continuation
   - Reference prior goals or progress when relevant
   - Link to upcoming events or materials when helpful
   - End with a clear next micro‑step and optional follow‑up

Platform scope:
   - Your recommendations MUST stay within this platform’s catalog and data.
   - Do NOT mention or recommend external platforms (e.g., Coursera, Udemy, edX) unless the user explicitly asks. If asked, explain your scope is limited to this platform and offer in‑platform alternatives.

Data sourcing rules:
   - For course listings, dates, or recommendations, you MUST call the provided tools:
     * list_courses to retrieve available courses and start times
     * recommend_courses to suggest upcoming items within a date window
     * get_event_details when referencing a single specific course by title or id (to obtain exact local date/time and relative start like “in 5 days”)
   - Do NOT invent courses or dates. If tools return nothing, say you don’t have matching items.
   - NEVER reveal database schemas, table names, or SQL details. Provide only user‑facing summaries.
   - Tool interaction style: briefly say what you’re fetching (one short line), then, when results arrive, immediately continue speaking with a concise summary. Do not fall silent or wait for the user to say “continue”.

Tool usage etiquette (no pre‑announcement):
   - Do NOT pre‑announce tool calls (no “checking that…”). Call tools silently.
   - After results arrive, immediately continue speaking with a concise outcome (1–3 short sentences). Never wait in silence for the user to prompt you.
   - If the tool returns nothing or an error, say so in one short line and propose the next best step.
   - Do not read raw JSON, long tables, or HTML aloud; summarize in natural language.

Course listing flow (catalog and upcoming):
   - If the learner asks for “upcoming courses”, “what’s available”, or similar ⇒ call list_courses first to get the full catalog (includes upcoming/today/past). Report counts briefly.
   - Present 3–5 upcoming items (soonest first) with: title, start_date_local, start_time_local, timezone, and starts_in_human.
   - If helpful, include 1–2 recent past items to provide context (clearly marked “past”).
   - When the learner chooses one, call get_event_details for exact local time and get_event_summary to open the summary panel. Keep spoken output to a short highlight and next step.

External interest redirect (stay in‑platform):
   - If the learner mentions taking a course on another platform (e.g., Coursera, Udemy, YouTube), politely steer back to this platform.
   - Before recommending, call list_courses to fetch what we offer right now. Briefly state the total/upcoming counts.
   - Pick 3 relevant upcoming items by topical keywords from the learner’s request (filter titles; if none match, choose 3 generally useful upcoming items).
   - Read a concise recommendation: title + local date/time + starts_in_human for the top 1–2. Offer to open the summary or mark attendance.
   - Never recommend external providers; if the learner insists, restate scope and provide our best in‑platform alternatives.

Memory capture (lean, durable facts only):
   - When the learner states a clear personal fact, preference, goal, progress update, or open question, persist it via add_user_memory.
   - Call add_user_memory with one of these types: 'fact' | 'preference' | 'goal' | 'progress' | 'open_question'. Provide a short, neutral statement (e.g., "User prefers dark mode.").
   - Pin sparingly (pinned:true) for very important stable items (e.g., name preference). Use stability: 'short' | 'med' | 'long' when helpful.
   - To review what’s stored, call get_user_memory (optionally with { type, limit }).

Date/time accuracy (strict):
   - When speaking the date/time for a specific course, you MUST read them directly from tool fields without re‑converting:
     * Prefer get_event_details.event.start_date_local + get_event_details.event.start_time_local + (event.timezone)
     * Alternatively, for list/recommend results use item.start_date_local + item.start_time_local + (item.timezone)
   - Do NOT recompute, translate, or guess dates from titles or summaries. If any doubt, call get_event_details again before speaking.
   - Always include the relative start (item.starts_in_human) when available (e.g., “in 6 days”).

Onboarding (first session only; required):
   - Purpose: collect a few short answers to personalize guidance and recommend the best courses. Say this plainly in the first line.
   - Flow (one question per turn; wait for the user’s answer each time; keep it natural and dynamic; provide 2–3 example answers, not full option lists; after each answer, immediately persist it using add_user_memory and then ask the next question):
      1) Language choice: Ask “Would you like to continue in English or switch languages?” Offer examples in the line (e.g., Macedonian, Albanian, Serbian, Greek). If a language is already saved, confirm they want to keep it; if they choose another, call set_preferred_language and continue in that language.
      2) Primary outcome with AI (goal): examples — “Automate repetitive tasks”, “Improve team performance”, “Learn AI from scratch”. Save with type:"goal".
      3) Work area (role/domain): examples — “Leadership/Management”, “Sales & Business Dev”, “Tech/IT/Data”. Save with type:"fact".
      4) Current AI level: examples — “beginner”, “sometimes use AI at work”, “advanced workflows”. Save with type:"fact".
      5) Why now (motivation): examples — “better opportunities”, “increase income”, “stay competitive”. Save with type:"preference".
      6) Monthly learning pace: examples — “light (2/mo)”, “standard (4/mo)”, “intensive (8/mo)”. Save with type:"preference".
   - After Q6, briefly recap (one line) and immediately fetch candidate courses: call recommend_courses with { limit: 4, days_ahead: 45, past_days: 21 }. It returns two lists: upcoming and recent_past, each item with title, local date/time, starts_in_human and summary_excerpt. YOU choose the single best course based on title + summary_excerpt (time does NOT matter). If it’s past, speak: “Oh — you just missed ‘{title}’ {starts_in_human}. You can rewatch the recording and see the materials — want me to open its summary?” If it’s upcoming, speak: “Great timing — the best fit is ‘{title}’ on {date} at {time} ({tz}), {starts_in_human}. Want me to mark you as attending?” Then mention 1–2 upcoming items next and end with a clear yes/no.
   - Do NOT move to general chat until you collect at least one answer for each of the 6 questions above (use get_user_memory to see what’s missing). Be encouraging but brief.

Proactive course guidance (reduce churn):
   - When the learner mentions a goal, blocker, or interest (even implicitly), gently steer toward a relevant upcoming course on this platform.
   - Action pattern (voice first, keep it natural and short):
      1) If needed, ask ONE clarifying line to infer the topic/level.
      2) Call recommend_courses with { limit: 3, days_ahead: 45 } OR list_courses and filter by title keywords.
      3) Pick 1–2 best matches (soonest first). For the top match, call get_event_details to get exact local date/time and relative start, and optionally get_event_summary for a 1–2 line "you’ll learn" blurb.
      4) Present the recommendation: title + local start date/time + relative (“in 6 days”) + 1‑line benefit tied to the learner’s situation.
      5) Ask a friendly yes/no: “Want me to mark you as attending?” If yes, call enter_event with event_id. If no, offer the next best option or ask what would help more.
   - Keep tone encouraging and career‑oriented (how it helps on the job). Never overwhelm: at most 2 items at once.

First turn policy:
   - Do NOT assume continuity. For the first response in a new session: greet naturally (use preferred name) and ask ONE short question such as “Want to pick up where we left off or start something new?” or “What would you like to learn today?”. Do not reference prior content yet.
   - If return is very recent (minutes), you may acknowledge timing in one short phrase, then ask the question above.
   - After the learner indicates “continue/resume”, use the provided excerpts/memory to smoothly pick up the last thread.

  Guardrails:
   - Stay focused on the learner’s topics and progress; avoid speculation
   - Do NOT introduce personal topics (e.g., health/fitness) unless the user raises them or they are present in the provided memory/excerpts
   - Do NOT perform device/audio checks or say phrases like “I can hear you”, “testing mic”, or “I’m listening” — simply begin the conversation naturally
   - Be transparent if unsure and ask a clarifying question
   - Never claim to read private data; use only provided memory/context
   - Don’t restate the entire memory pack; weave it naturally
   - Ask only one question at a time; avoid stacked questions
   - Do NOT claim vision, camera access, or physical awareness. Never say you can see the user, their surroundings, or real‑time actions. You only perceive text and user audio transcripts.
   - Do NOT imply monitoring or surveillance.
   - Keep content appropriate for an educational assistant; avoid small talk that suggests physical presence.`;

const ONBOARDING_GATE = `Top Priority — Onboarding Gate:
- You must treat onboarding as REQUIRED when starting a new session or when answers are missing.
- Required order:
  0) Language choice — Ask if they prefer English or another language (examples: Macedonian, Albanian, Serbian, Greek). Wait for the answer; if they choose another, call set_preferred_language and continue in that language.
  1) Primary outcome with AI (save as goal).
  2) Work area / domain (save as fact).
  3) Current AI level (save as fact).
  4) Why now / motivation (save as preference).
  5) Monthly learning pace (save as preference).
- One question per turn. After each answer, immediately call add_user_memory with { type, statement }.
- Do NOT proceed to general topics or recommendations until all five answers are captured. After the last answer, list 2–3 upcoming matching courses and offer to open a summary or mark attendance.`;

const LANGUAGE_POLICY_DEFAULT = `Language Policy (no preference saved):
- On the very first turn you MUST ask: “Would you like to continue in English, or switch languages?” Offer examples inline (e.g., Macedonian, Albanian, Serbian, Greek).
- Wait for the answer. If they choose a language, call set_preferred_language and then continue in that language for the rest of onboarding.
- Until a choice is made, speak in English.`;

function fmtLocal(d) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
    }).format(d);
  } catch { return d.toISOString(); }
}

// Copy of server.js → composeUserContextSummary (kept concise)
async function composeUserContextSummary(email, pgUserId) {
  try {
    if (!email) return '';
    const userRes = await query(`SELECT id, name, email FROM user_mysql_mirror WHERE email = $1 LIMIT 1`, [email]);
    const u = userRes?.rows?.[0];
    if (!u) return '';
    const uid = u.id;

    let preferredLang = null;
    try {
      if (pgUserId) {
        const lang = await query(`SELECT preferred_language FROM user_language WHERE user_id = $1`, [pgUserId]);
        preferredLang = lang?.rows?.[0]?.preferred_language || null;
      }
    } catch {}

    const [cats, upcomingMine, attended, attempts, favs, webinarSample, upcomingAll] = await Promise.all([
      query(
        `SELECT c.title, COUNT(*) AS n
           FROM categories_mysql_mirror c
           JOIN events_mysql_mirror e ON e.category_id = c.id
           JOIN event_attendances_mysql_mirror a ON a.event_id = e.id
          WHERE a.user_id = $1
          GROUP BY c.title
          ORDER BY n DESC, c.title ASC
          LIMIT 5`,
        [uid]
      ),
      query(
        `SELECT e.title, e.start_at
           FROM events_mysql_mirror e
           LEFT JOIN event_user_favorites_mysql_mirror f ON f.event_id = e.id AND f.user_id = $1
           LEFT JOIN event_attendances_mysql_mirror a ON a.event_id = e.id AND a.user_id = $1
          WHERE e.start_at > now() AND (f.user_id IS NOT NULL OR a.user_id IS NOT NULL)
          ORDER BY e.start_at ASC
          LIMIT 5`,
        [uid]
      ),
      query(
        `SELECT e.title
           FROM event_attendances_mysql_mirror a
           JOIN events_mysql_mirror e ON e.id = a.event_id
          WHERE a.user_id = $1
          ORDER BY COALESCE(a.left_at, a.joined_at) DESC
          LIMIT 5`,
        [uid]
      ),
      query(
        `SELECT event_quiz_id, score_percentage, passed
           FROM event_quiz_attempts_mysql_mirror
          WHERE user_id = $1
          ORDER BY started_at DESC
          LIMIT 5`,
        [uid]
      ),
      query(
        `SELECT e.title
           FROM event_user_favorites_mysql_mirror f
           JOIN events_mysql_mirror e ON e.id = f.event_id
          WHERE f.user_id = $1
          ORDER BY f.created_at DESC
          LIMIT 5`,
        [uid]
      ),
      query(
        `SELECT q.question
           FROM event_webinar_questions_mysql_mirror q
          WHERE q.event_id IN (
            SELECT event_id FROM event_attendances_mysql_mirror WHERE user_id = $1
          )
          ORDER BY q.created_at DESC
          LIMIT 5`,
        [uid]
      ),
      query(
        `SELECT title, start_at
           FROM events_mysql_mirror
          WHERE start_at > now() AND COALESCE(is_public,1)=1
          ORDER BY start_at ASC
          LIMIT 5`
      )
    ]);

    const categories = (cats?.rows || []).map(r => r.title).filter(Boolean);
    const upcomingMineStr = (upcomingMine?.rows || []).map(r => `${r.title}`).join(' | ');
    const upcomingAllStr = (upcomingAll?.rows || []).map(r => `${r.title}`).join(' | ');
    const attendedStr = (attended?.rows || []).map(r => r.title).join(' | ');
    const quizzesStr = (attempts?.rows || []).map(a => `${a.event_quiz_id}:${a.score_percentage}%${a.passed ? '✓' : '✗'}`).join(' | ');
    const favsStr = (favs?.rows || []).map(r => r.title).join(' | ');
    const webinarSampleStr = (webinarSample?.rows || []).map(r => r.question).join(' | ');

    const parts = [];
    parts.push(`User Name: ${u.name || ''} <${u.email || ''}>`);
    if (preferredLang) parts.push(`Preferred language: ${preferredLang}`);
    if (categories.length) parts.push(`Categories: ${categories.join(', ')}`);
    if (upcomingMineStr) parts.push(`Upcoming Courses (yours): ${upcomingMineStr}`);
    if (upcomingAllStr) parts.push(`Upcoming Courses (new): ${upcomingAllStr}`);
    if (attendedStr) parts.push(`Attended Course: ${attendedStr}`);
    if (favsStr) parts.push(`Favorites Courses: ${favsStr}`);
    if (quizzesStr) parts.push(`Quizzes (recent): ${quizzesStr}`);
    if (webinarSampleStr) parts.push(`Webinar Qs (recent): ${webinarSampleStr}`);
    let out = parts.join('\n');
    const MAX = 1200;
    if (out.length > MAX) out = out.slice(0, MAX - 3) + '...';
    return out;
  } catch {
    return '';
  }
}

async function buildInstructionsForUser({ email, userId }) {
  // Preferred language
  let preferredLanguage = null;
  try {
    const langRow = await readPreferredLanguagePg({ userId });
    preferredLanguage = langRow && langRow.language ? String(langRow.language) : null;
  } catch {}

  // Agent settings
  let agentName = null;
  let agentStyle = null;
  try {
    const settings = await readAgentSettingsPg({ userId });
    agentName = settings?.name || null;
    agentStyle = settings?.style || null;
  } catch {}

  // Working memory
  let workingPack = '';
  try {
    const top = await selectTopKUserMemory(userId, null);
    const lines = [];
    const pushSection = (title, rows) => {
      if (!rows || rows.length === 0) return;
      lines.push(`${title}:`);
      for (const r of rows) lines.push(`- ${r.statement}`);
      lines.push('');
    };
    pushSection('Facts', top?.facts);
    pushSection('Preferences', top?.preferences);
    pushSection('Goals', top?.goals);
    pushSection('Progress', top?.progress);
    pushSection('Open Questions', top?.open_questions);
    workingPack = lines.join('\n').trim();
  } catch {}

  // Recent summary (dedup + recency filter like server)
  let recentSummariesBlock = '';
  try {
    const rs = await query(
      `SELECT summary, created_at FROM chat_session_summary
         WHERE user_id = $1 AND summary IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 6`,
      [userId]
    );
    if (rs?.rows?.length) {
      const kept = [];
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\\s]+/g,' ').replace(/\\s+/g,' ').trim();
      const jaccard = (a,b) => {
        const sa = new Set(a.split(' ')); const sb = new Set(b.split(' '));
        const inter = new Set([...sa].filter(x => sb.has(x)));
        const uni = new Set([...sa, ...sb]);
        return uni.size ? inter.size / uni.size : 0;
      };
      for (const row of rs.rows) {
        const txt = String(row.summary || '').trim();
        const n = norm(txt);
        let similar = false;
        for (const k of kept) { if (jaccard(n, k.n) >= 0.82) { similar = true; break; } }
        if (!similar) kept.push({ n, row });
        if (kept.length >= 1) break;
      }
      if (kept.length) {
        const row = kept[0].row;
        const created = row.created_at ? new Date(row.created_at) : null;
        const ageMin = created ? Math.floor((Date.now() - created.getTime())/60000) : null;
        const textLower = String(row.summary || '').toLowerCase();
        const offTopicHints = ['fitness','workout','morning routine','diet'];
        const offTopic = offTopicHints.some(t => textLower.includes(t));
        if (ageMin != null && ageMin <= 360 && !offTopic) {
          recentSummariesBlock = `S1 [${created ? created.toISOString() : 'unknown-date'}]: ${String(row.summary || '').trim()}`;
        }
      }
    }
  } catch {}

  // Last conversation (full transcript) + anchor
  let recentConvosBlock = '';
  let lastConversationUpdatedAt = null;
  let userDisplayName = null;
  let anchorText = null;
  let anchorWhenLocal = null;

  try {
    if (email) {
      const r = await query(`SELECT name FROM user_mysql_mirror WHERE email = $1 LIMIT 1`, [email]);
      userDisplayName = (r && r.rows && r.rows[0] && r.rows[0].name) || email.split('@')[0] || null;
    }
  } catch {
    userDisplayName = email ? email.split('@')[0] : null;
  }

  try {
    // Exporter behavior: include ONLY the most recent session and include ALL turns
    const rows = await query(
      `SELECT content, updated_at
         FROM chat_message
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT 1`,
      [userId]
    );
    if (rows?.rows?.length) {
      const r = rows.rows[0];
      const updated = r.updated_at ? new Date(r.updated_at) : null;
      lastConversationUpdatedAt = updated;
      let arr = [];
      try { arr = Array.isArray(r.content) ? r.content : JSON.parse(r.content || '[]'); } catch { arr = []; }
      // Compute anchor from the last USER message
      if (Array.isArray(arr) && arr.length) {
        for (let j = arr.length - 1; j >= 0; j--) {
          const m = arr[j];
          if (m && (m.role === 'user' || m.role === 'User')) {
            anchorText = (m.text != null ? String(m.text) : String(m?.content || '')).trim();
            if (m && typeof m.at_local === 'string' && m.at_local.trim()) {
              anchorWhenLocal = `${m.at_local} ${TZ}`;
            }
            break;
          }
        }
      }
      // Render full transcript for the last conversation
      const lines = (Array.isArray(arr) ? arr : []).map(m => {
        const role = (m && m.role === 'model') ? 'Assistant' : 'User';
        const text = (m && m.text != null) ? String(m.text) : String(m?.content || '');
        let whenLocal = null;
        if (m && typeof m.at_local === 'string' && m.at_local.trim()) {
          whenLocal = `${m.at_local} ${TZ}`;
        }
        const prefix = whenLocal ? `${role} [${whenLocal}]` : role;
        return `${prefix}: ${text.trim()}`;
      });
      const header = updated ? `Last conversation [${updated.toISOString()} | local ${fmtLocal(updated)}]` : `Last conversation`;
      recentConvosBlock = `${header}\n${lines.join('\n')}`;
    }
  } catch {}

  const baseInstructions = `Identity & personality: By default you are Nova, a friendly, upbeat learning companion with a touch of humor. ... (same as server)`;
  const now = new Date();
  const nowIso = now.toISOString();
  const nowLocal = fmtLocal(now);

  const hasHistory = Boolean((recentSummariesBlock && recentSummariesBlock.length) || (recentConvosBlock && recentConvosBlock.length));
  const continuityBlock = hasHistory
    ? `Continuity:\n- You DO have prior context in this prompt.\n- Continue from the newest summary/excerpt.\n- Reference at most one prior detail.\n- Do NOT claim memory beyond what is shown here.`
    : `Continuity:\n- This is the FIRST interaction; there is NO previous session.\n- Do NOT say we spoke before. Do NOT invent past details.\n- Start fresh with a concise, engaging opener and one question.`;

  const insParts = [
    BASE_INSTRUCTIONS,
    ONBOARDING_GATE,
    continuityBlock,
    preferredLanguage
      ? `Language Policy:\n- RESPOND ONLY IN ${preferredLanguage} after language choice is confirmed.\n- Do NOT switch languages unless the user explicitly asks to change language.\n- If incoming speech is in a different language, ask a one-line confirmation before switching.`
      : LANGUAGE_POLICY_DEFAULT,
    `Current date/time (${TZ}): ${nowLocal}`,
    `Current date/time (UTC): ${nowIso}`
  ];
  if (agentName) insParts.push(`Agent name policy:\n- Your current name is "${agentName}". ...`);
  if (agentStyle) insParts.push(`Agent style preference:\n- Maintain this baseline style across turns: ${agentStyle}. ...`);
  const contextSummary = await composeUserContextSummary(email, userId);
  if (contextSummary) insParts.push(`Context for personalization:\n${contextSummary}`);
  if (email) insParts.push(`User identity:\n- Preferred display name for the learner: ${userDisplayName || email.split('@')[0]}.`);
  if (hasHistory && recentSummariesBlock) insParts.push(`Recent session summaries (NEWEST FIRST; prefer newest on conflict):\n${recentSummariesBlock}`);
  if (hasHistory && workingPack) insParts.push(`Working Memory Pack (use naturally; do not restate verbatim):\n${workingPack}`);
  if (hasHistory && recentConvosBlock) insParts.push(`Last conversation (full transcript):\n${recentConvosBlock}`);
  if (anchorText) {
    insParts.push(`Continuation anchor (for follow‑up after first turn):\n- Last user message ${anchorWhenLocal ? `[${anchorWhenLocal}]` : ''}: "${anchorText}"`);
  }

  return insParts.join('\n\n');
}

function safeName(email, id) {
  if (email) return email.replace(/[^a-z0-9@._+-]/gi, '_');
  return String(id || '').replace(/[^a-z0-9-_]/gi, '_');
}

async function main() {
  const sysDir = path.join(PROJECT_ROOT, 'scripts', 'exports', 'system_instructions');
  const userDir = path.join(PROJECT_ROOT, 'scripts', 'exports', 'user_prompts');
  await Promise.all([
    fs.mkdir(sysDir, { recursive: true }),
    fs.mkdir(userDir, { recursive: true })
  ]);

  // Always (over)write the current static system instructions so we know
  // exactly what is sent alongside per-user context.
  const sysFile = path.join(sysDir, 'system_instructions.txt');
  const sysContent = [
    BASE_INSTRUCTIONS,
    ONBOARDING_GATE,
    LANGUAGE_POLICY_DEFAULT
  ].join('\n\n');
  await fs.writeFile(sysFile, sysContent, 'utf8');
  try { console.log(`System instructions: ${sysFile}`); } catch (_) {}

  const usersRes = await query(`SELECT id, email FROM app_user WHERE email IS NOT NULL AND email <> '' ORDER BY email ASC`);
  const users = usersRes?.rows || [];
  console.log(`Exporting prompts for ${users.length} users...`);

  // Gentle concurrency
  const BATCH = 5;
  for (let i = 0; i < users.length; i += BATCH) {
    const slice = users.slice(i, i + BATCH);
    await Promise.all(slice.map(async (u) => {
      try {
        const instructions = await buildInstructionsForUser({ email: u.email, userId: u.id });
        const file = path.join(userDir, `${safeName(u.email, u.id)}.txt`);
        await fs.writeFile(file, instructions, 'utf8');
        console.log(`Wrote ${file}`);
      } catch (e) {
        console.error(`Failed ${u.email || u.id}:`, e?.message || e);
      }
    }));
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});