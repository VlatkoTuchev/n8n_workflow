// ====================================================================================================
// Section: Imports, environment, and shared clients
// ====================================================================================================
const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();
const { query } = require('./db');
const { redis, connectRedis, addChatTurn, getRecentChat, getFullChat, setSessionActivity } = require('./redis');
const {
  createUser,
  createChatSession,
  addChatMessage,
  getRecentMessages,
  saveSessionSummary,
  readLatestSummary,
  readPreferredLanguagePg,
  setPreferredLanguagePg,
  readAgentNamePg,
  setAgentNamePg,
  readAgentSettingsPg,
  setAgentSettingsPg,
  ensureMemoryTables,
  upsertUserMemoryItems,
  selectTopKUserMemory,
  setUserDigest,
  getUserDigest,
  getRecentSummaries
} = require('./retrieval');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const mysqlDb = require('./mysql');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ----------------------------------------------------------------------------------------------------
// Helper: Ensure a corresponding MySQL users row exists for the authenticated email
// This keeps CDC mirrors (user_mysql_mirror) populated when app_user is created first.
async function ensureMysqlUserForEmail(email, nameHint) {
  try {
    if (!email) return;
    const rows = await mysqlDb.query(`SELECT id FROM users WHERE email=? LIMIT 1`, [email]);
    if (rows && rows.length) return; // exists
    // Create with a random strong password hash (not used for login if SSO); can be reset later
    const randomPwd = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const hash = await bcrypt.hash(randomPwd, 10);
    const name = nameHint || (email.includes('@') ? email.split('@')[0] : 'User');
    await mysqlDb.query(
      `INSERT INTO users (name,email,password,created_at,updated_at) VALUES (?,?,?,?,NOW())`,
      [name, email, hash, new Date()]
    );
  } catch (_) {}
}

// ====================================================================================================
// Section: Context composition (reads Postgres mirrors)
// - Builds a compact, human-readable personalization context for instructions
// ====================================================================================================
// Compose a concise, human-readable context summary for the authenticated user
async function composeUserContextSummary(email, pgUserId) {
  try {
    if (!email) return '';
    const userRes = await query(`SELECT id, name, email FROM user_mysql_mirror WHERE email = $1 LIMIT 1`, [email]);
    const u = userRes?.rows?.[0];
    if (!u) return '';
    const uid = u.id;
    // Prefer language from app table (Postgres UUID)
    let preferredLang = null;
    // Continuation anchor derived from most recent user's message
    let anchorText = null;
    let anchorWhenLocal = null;
    let anchorWhenIso = null;
    try {
      if (pgUserId) {
        const lang = await query(`SELECT preferred_language FROM user_language WHERE user_id = $1`, [pgUserId]);
        preferredLang = lang?.rows?.[0]?.preferred_language || null;
      }
    } catch (_) {}

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
    const MAX = 1200; // keep concise for realtime token
    if (out.length > MAX) out = out.slice(0, MAX - 3) + '...';
    return out;
  } catch (_) {
    return '';
  }
}

// ====================================================================================================
// Section: Express app and middleware (CORS/JSON/cookies)
// ====================================================================================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: ['application/sdp', 'text/plain'] }));
app.use(cookieParser());

// Ensure lean memory tables exist at startup (no-op if present)
(async () => {
  try { await ensureMemoryTables(); } catch (e) { try { console.warn('ensureMemoryTables failed', e?.message || e); } catch (_) {} }
})();

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}
function authRequired(req, res, next) {
  const token = (req.cookies && req.cookies.auth) || (req.headers.authorization || '').replace(/^Bearer\s+/,'');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); return next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

// ====================================================================================================
// Section: Realtime WebRTC SDP exchange proxy
// - Accepts SDP offer, proxies to OpenAI, returns SDP answer
// ====================================================================================================
// Realtime WebRTC SDP exchange proxy to OpenAI (place before static routing)
// Accept SDP over POST; respond with OpenAI's SDP answer
app.all('/realtime/sdp', authRequired, async (req, res) => {
  try {
    console.log(`[realtime] ${req.method} /realtime/sdp content-type=${req.headers['content-type']}`);
    const clientOfferSdp = typeof req.body === 'string' ? req.body : (req.body && req.body.toString ? req.body.toString() : '');
    if (!clientOfferSdp) {
      return res.status(400).send('Missing SDP');
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).send('OPENAI_API_KEY not configured');
    }

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';

    const fetchImpl = global.fetch || (async (...args) => (await import('node-fetch')).default(...args));

    // Prefer client-provided ephemeral token for Authorization (includes server-built instructions)
    const clientEphemeral = (req.headers['x-openai-session-token'] || '').toString().trim();
    if (!clientEphemeral) {
      console.warn('[realtime/sdp] Missing X-OpenAI-Session-Token header; falling back to API key (no per-user instructions)');
    }
    const authKey = clientEphemeral || apiKey;
    const upstream = await fetchImpl(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authKey}`,
        'Content-Type': 'application/sdp',
        'Accept': 'application/sdp',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: clientOfferSdp
    });

    const answerSdp = await upstream.text();
    if (!upstream.ok) {
      console.error('OpenAI Realtime error:', upstream.status, answerSdp);
      res.status(upstream.status).set('Content-Type', 'text/plain').send(answerSdp || 'Upstream error');
      return;
    }
    res.set('Content-Type', 'application/sdp');
    res.set('X-Session-Token-Used', clientEphemeral ? 'true' : 'false');
    res.send(answerSdp);
  } catch (err) {
    console.error('Realtime SDP proxy error:', err);
    res.status(500).send('Realtime SDP proxy error');
  }
});

// ====================================================================================================
// Section: Realtime client token minting
// - Injects Working Memory Pack + user context into instructions
// ====================================================================================================
// Mint a fresh ephemeral token using the permanent API key
app.all('/realtime/token', authRequired, async (req, res) => {
  try {
    console.log(`[realtime] ${req.method} /realtime/token`);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
    const fetchImpl = global.fetch || (async (...args) => (await import('node-fetch')).default(...args));
    // Ensure user exists in MySQL so CDC mirrors have the user row
    try { await ensureMysqlUserForEmail(req.user?.email || null, null); } catch(_) {}
    // Build compact user context for instructions (no prior-session continuation)
    let contextSummary = '';
    try { contextSummary = await composeUserContextSummary(req.user?.email || null, req.user?.pgUserId || null); } catch (_) {}
    // Preferred language guardrail (always respond in user's preferred language unless they confirm a change)
    let preferredLanguage = null;
    try {
      if (req.user?.pgUserId) {
        const langRow = await readPreferredLanguagePg({ userId: req.user.pgUserId });
        preferredLanguage = langRow && langRow.language ? String(langRow.language) : null;
      }
    } catch (_) {}
    // Read agent personalization (persisted per user)
    let preferredVoice = 'alloy';
    let agentName = null;
    let agentStyle = null;
    try {
      if (req.user?.pgUserId) {
        const settings = await readAgentSettingsPg({ userId: req.user.pgUserId });
        const v = settings && settings.voice ? String(settings.voice).toLowerCase() : null;
        if (v === 'alloy' || v === 'cedar') preferredVoice = v;
        agentName = settings && settings.name ? String(settings.name) : null;
        agentStyle = settings && settings.style ? String(settings.style) : null;
      }
    } catch (_) {}
    // Compose Working Memory Pack from user_memory (if available)
    let workingPack = '';
    try {
      const top = await selectTopKUserMemory(req.user?.pgUserId || null, null);
      const lines = [];
      function pushSection(title, rows) {
        if (!rows || rows.length === 0) return;
        lines.push(`${title}:`);
        for (const r of rows) { lines.push(`- ${r.statement}`); }
        lines.push('');
      }
      pushSection('Facts', top?.facts);
      pushSection('Preferences', top?.preferences);
      pushSection('Goals', top?.goals);
      pushSection('Progress', top?.progress);
      pushSection('Open Questions', top?.open_questions);
      workingPack = lines.join('\n').trim();
    } catch (_) {}
    // Build last summaries (newest first), deduplicate and filter for recency and off-topic drift
    let recentSummariesBlock = '';
    try {
      const rs = await query(
        `SELECT summary, created_at FROM chat_session_summary
           WHERE user_id = $1 AND summary IS NOT NULL
           ORDER BY created_at DESC
           LIMIT 6`,
        [req.user?.pgUserId || null]
      );
      if (rs && rs.rows && rs.rows.length) {
        const kept = [];
        const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g,' ').replace(/\s+/g,' ').trim();
        function jaccard(a, b) {
          const sa = new Set(a.split(' '));
          const sb = new Set(b.split(' '));
          const inter = new Set([...sa].filter(x => sb.has(x)));
          const uni = new Set([...sa, ...sb]);
          return uni.size ? inter.size / uni.size : 0;
        }
        for (let i = 0; i < rs.rows.length; i++) {
          const txt = String(rs.rows[i].summary || '').trim();
          const n = norm(txt);
          let similar = false;
          for (const k of kept) {
            if (jaccard(n, k.n) >= 0.82) { similar = true; break; }
          }
          if (!similar) kept.push({ n, row: rs.rows[i] });
          if (kept.length >= 1) break; // keep only the single clearest recent summary
        }
        if (kept.length) {
          // Recency and topic filters
          const row = kept[0].row;
          const created = row.created_at ? new Date(row.created_at) : null;
          const ageMin = created ? Math.floor((Date.now() - created.getTime())/60000) : null;
          const textLower = String(row.summary || '').toLowerCase();
          const offTopicHints = ['fitness','workout','morning routine','diet'];
          const offTopic = offTopicHints.some(t => textLower.includes(t));
          if (ageMin != null && ageMin <= 360 && !offTopic) {
            const iso = created ? created.toISOString() : 'unknown-date';
            recentSummariesBlock = `S1 [${iso}]: ${String(row.summary || '').trim()}`;
          } else {
            recentSummariesBlock = '';
          }
        }
      }
    } catch (_) {}

    // Build last 2 conversation excerpts (from chat_message JSON) for smooth continuation
    let recentConvosBlock = '';
    let lastConversationUpdatedAt = null;
    // Try to fetch display name for meta-guidance
    let userDisplayName = null;
    try {
      if (req.user?.email) {
        const r = await query(`SELECT name FROM user_mysql_mirror WHERE email = $1 LIMIT 1`, [req.user.email]);
        userDisplayName = (r && r.rows && r.rows[0] && r.rows[0].name) || null;
      }
      if (!userDisplayName && req.user?.email) {
        userDisplayName = String(req.user.email).split('@')[0];
      }
    } catch (_) {}
    // Placeholders for strict continuation anchor derived from the last user message
    let anchorText = null;
    let anchorWhenLocal = null;
    let anchorWhenIso = null;
    try {
      const excerptSessions = Math.max(1, Math.min(10, Number(process.env.CONVO_EXCERPT_SESSIONS || 8)));
      const tailTurns = Math.max(6, Math.min(30, Number(process.env.CONVO_TAIL_TURNS || 18)));
      const rows = await query(
        `SELECT content, updated_at
           FROM chat_message
          WHERE user_id = $1
          ORDER BY updated_at DESC
          LIMIT ${excerptSessions}`,
        [req.user?.pgUserId || null]
      );
      if (rows && rows.rows && rows.rows.length) {
        const chunks = [];
        for (let i = 0; i < rows.rows.length; i++) {
          const r = rows.rows[i];
          const updated = r.updated_at ? new Date(r.updated_at) : null;
          if (i === 0) lastConversationUpdatedAt = updated;
          let arr = [];
          try { arr = Array.isArray(r.content) ? r.content : JSON.parse(r.content || '[]'); } catch (_) { arr = []; }
          // Take the last N turns for continuity (configurable)
          const tail = Array.isArray(arr) ? arr.slice(-tailTurns) : [];
          let hasUserTurn = false;
          // Compute anchor from the last USER message (only on most recent row)
          if (i === 0 && Array.isArray(arr) && arr.length) {
            for (let j = arr.length - 1; j >= 0; j--) {
              const m = arr[j];
              if (m && (m.role === 'user' || m.role === 'User')) {
                const tz = String(process.env.APP_TIMEZONE || 'Europe/Skopje');
                anchorText = (m.text != null ? String(m.text) : String(m?.content || '')).trim();
                if (m && typeof m.at_local === 'string' && m.at_local.trim()) {
                  anchorWhenLocal = `${m.at_local} ${tz}`;
                } else if (m && typeof m.at === 'string' && m.at.trim()) {
                  try { const d = new Date(m.at); const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }); anchorWhenLocal = `${fmt.format(d)} ${tz}`; anchorWhenIso = d.toISOString(); } catch(_) {}
                }
                break;
              }
            }
          }
          const lines = tail.map(m => {
            const role = (m && m.role === 'model') ? 'Assistant' : 'User';
            if (role === 'User') hasUserTurn = true;
            const text = (m && m.text != null) ? String(m.text) : String(m?.content || '');
            // Prefer local timestamp if present in stored JSON
            const tz = String(process.env.APP_TIMEZONE || 'Europe/Skopje');
            let whenLocal = null;
            if (m && typeof m.at_local === 'string' && m.at_local.trim()) {
              whenLocal = `${m.at_local} ${tz}`;
            } else if (m && typeof m.at === 'string' && m.at.trim()) {
              try {
                const d = new Date(m.at);
                const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12: false });
                whenLocal = `${fmt.format(d)} ${tz}`;
              } catch(_) { whenLocal = null; }
            }
            const prefix = whenLocal ? `${role} [${whenLocal}]` : role;
            return `${prefix}: ${text.trim()}`;
          });
          const iso = updated ? updated.toISOString() : 'unknown-date';
          let updatedLocal = null;
          try {
            if (updated) {
              updatedLocal = new Intl.DateTimeFormat('en-GB', { timeZone: String(process.env.APP_TIMEZONE || 'Europe/Skopje'), year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(updated);
            }
          } catch(_) { updatedLocal = null; }
          const header = updatedLocal ? `Conversation [${iso} | local ${updatedLocal}]` : `Conversation [${iso}]`;
          if (hasUserTurn) {
            chunks.push(`${header}\n${lines.join('\n')}`);
          }
        }
        recentConvosBlock = chunks.join('\n\n');
      }
    } catch (_) {}
    const baseInstructions = `Identity & personality: By default you are Nova, a friendly, upbeat learning companion with a touch of humor. If an "Agent name policy" is provided in these instructions, use that name instead of Nova. If an "Agent style preference" is provided, adopt that style while keeping responses clear and concise. You continue conversations smoothly, as if we just paused and resumed. You adapt to the learner’s level and mood, stay practical, and keep the pace comfortable.

Environment: Voice‑first in the Compenion AI web app. Speak clearly. Keep turns short (2–4 sentences), natural, and easy to follow.

Tone: Warm, human, a bit playful. Use brief affirmations ("Got it", "I see"). Small fillers are okay in moderation. Use short pauses with "..." to pace speech. Encourage, never lecture.

Primary goal: Help the learner move forward in their studies. Use memory (facts, preferences, goals, progress, open questions), recent summaries, and excerpts to personalize. On a fresh session, greet first and ask where they want to focus; only continue prior threads after they confirm.

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
   - Keep content appropriate for an educational assistant; avoid small talk that suggests physical presence.
   - Do NOT say that you can see through the users camera feed also do NOT mention the camera at all and users background.
  
   Tool use (if available):
   - Use get_user_context for details on upcoming/attended/favorites/quizzes and recent event transcripts when needed
   - Use set_preferred_language when the learner asks to change language
   - For set_agent_settings (name, voice, style):
        * Always use the user's configured settings (do not fall back to defaults).
        * After changing voice or style, explicitly tell the user to reload the page so the new settings apply to the next session. Keep it to one short line (e.g., "Settings updated — please reload the page to apply the new voice.").
        * Do NOT claim the change is live now and do NOT say “let me know how it sounds”; changes take effect only after a reload/new session.
      - Use open_code_assist_chat when the learner asks for coding help (e.g., “variables in Python”). Provide a compact title, short problem summary, one focused code block, and a concise explanation with 2–4 bullet actions. Do NOT read the code aloud; instead speak a brief 1–2 sentence summary and let the panel carry the details. If the learner asks about the panel’s content, use the provided panel preview (code_preview, explanation) to answer succinctly; reference variable names or line positions, but avoid reading the full code.
      - For a new topic/segment (e.g., “now show classes”), call open_code_assist_chat again to APPEND a new block below the previous one so the user can scroll through a growing lesson.
      - Use update_code_assist_chat to refine the existing panel dynamically (append/replace code or explanation, add steps). By default it edits the latest block; pass block_index to target an earlier block. Keep spoken output brief while the panel updates visually.
      - For event follow‑ups: If the learner attended a course recently, offer a short quiz. Use get_event_quiz to fetch existing MCQs and submit_event_quiz to grade and persist results. Keep spoken guidance brief and encouraging. If no quiz is found, say so and offer a summary or practice instead.
      - Quiz coaching policy (never reveal answers): Do NOT state or imply the correct option (letter/text) before or after the learner answers. Instead, coach with one concise hint at a time, ask what they think, and encourage elimination or justification. If the learner insists on the answer, politely decline and offer a tip or reference to the course material. After submission, acknowledge the score without listing which items were right/wrong; offer a short follow‑up (e.g., “Want a hint for any question?” or “Shall we review the relevant section?”).
      - When the learner asks for a course summary (attended or not), call get_event_summary with an event_id or a title. If a summary exists, keep spoken output to one short line and rely on the on‑screen summary panel for details.
      - Do NOT use the code assist panel for quizzes. Quizzes must appear in the dedicated quiz modal only.
   - Prefer memory/digest first; use tools after the greeting and only between turns

Safety & inclusion: Be culturally respectful; avoid probing sensitive info; normalize struggle; praise effort and strategy.`;
    const now = new Date();
    const nowIso = now.toISOString();
    const tz = String(process.env.APP_TIMEZONE || 'Europe/Skopje');
    let nowLocal = '';
    try {
      nowLocal = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      }).format(now);
    } catch (_) { nowLocal = now.toLocaleString('en-GB'); }
    const hasHistory = Boolean((recentSummariesBlock && recentSummariesBlock.length) || (recentConvosBlock && recentConvosBlock.length));
    const continuityBlock = hasHistory
      ? `Continuity:\n- You DO have prior context in this prompt.\n- Continue from the newest summary/excerpt.\n- Reference at most one prior detail.\n- Do NOT claim memory beyond what is shown here.`
      : `Continuity:\n- This is the FIRST interaction; there is NO previous session.\n- Do NOT say we spoke before. Do NOT invent past details.\n- Start fresh with a concise, engaging opener and one question.`;

    const insParts = [
      baseInstructions,
      continuityBlock,
      (preferredLanguage ? `Language Policy:\n- RESPOND ONLY IN ${preferredLanguage}.\n- Do NOT switch languages unless the user explicitly asks to change language.\n- If the user asks to change, briefly confirm, call set_preferred_language, and continue in the new language immediately thereafter.\n- If incoming speech is in a different language, ask a one-line confirmation before switching.` : null),
      `Current date/time (${tz}): ${nowLocal}`,
      `Current date/time (UTC): ${nowIso}`
    ];
    if (agentName) insParts.push(`Agent name policy:\n- Your current name is "${agentName}" (this is the ASSISTANT'S name).\n- When asked your name, answer using this name verbatim (e.g., "I'm ${agentName}").\n- NEVER address the learner by this name.\n- Override any earlier mentions or defaults (do NOT use "Nova" unless this policy sets it).\n- If the learner asks to change it, confirm and adapt.`);
    if (agentStyle) insParts.push(`Agent style preference:\n- Maintain this baseline style across turns: ${agentStyle}.\n- Keep responses clear, concise, and on-task while reflecting the style.\n- If the learner asks to change it, confirm and adapt.`);
    if (contextSummary) insParts.push(`Context for personalization:\n${contextSummary}`);
    // Provide a clear user display name for greetings to avoid confusing the assistant name with the user name
    if (userDisplayName) {
      insParts.push(`User identity:\n- Preferred display name for the learner: ${userDisplayName}.\n- Use this name (or second-person "you"). Do NOT call the learner by your own agent name.`);
    }
    if (hasHistory && recentSummariesBlock) insParts.push(`Recent session summaries (NEWEST FIRST; prefer newest on conflict):\n${recentSummariesBlock}`);
    if (hasHistory && workingPack) insParts.push(`Working Memory Pack (use naturally; do not restate verbatim):\n${workingPack}`);
    if (hasHistory && recentConvosBlock) {
      insParts.push(`Recent conversation excerpts (most recent first):\n${recentConvosBlock}`);
      insParts.push(
        `Guidance: These are the last conversations that you and ${userDisplayName || 'the user'} had in the previous session. Smoothly continue from there with variety and light humor. Do not restate the entire memory.`
      );
    } else {
      insParts.push(
        `Guidance: There is no prior conversation for this user. START FRESH.
Welcome policy (FIRST CONTACT ONLY):
- Sound genuinely excited and warm.
- Introduce yourself with a friendly, memorable name (e.g., “Hi! I’m Nova—your learning companion”).
- Explicitly offer to change your name if the user prefers (“If you want me to go by a different name, just tell me”).
- In 1–2 short sentences, give an upbeat welcome and invite a first step or question.
- Keep it natural—avoid stock phrases like “Hi there,” and vary the opening line.`
      );
    }
    // If available, include a strict continuation anchor from the user's last message
    if (anchorText) {
      const tag = anchorWhenLocal ? `[${anchorWhenLocal}]` : '';
      insParts.push(`Continuation anchor (for follow‑up after first turn):\n- Last user message ${tag}: \"${anchorText}\"\n- Use this anchor to continue ONLY after the learner confirms they want to resume. Do NOT use it on the very first response.`);
    } else {
      insParts.push(`If no explicit last-user anchor is available:\n- Do NOT assume prior topics.\n- Ask ONE short clarifying question to locate where to continue (e.g., “Want to pick up from our last topic or start fresh?”).`);
    }
    // Add recency-aware and post-reload + refresh-count greeting guidance (placed after core guidance to override tone)
    try {
      const postReload = (() => { try { const v = String(req.query?.post_settings_reload || '').toLowerCase(); return v === '1' || v === 'true' || v === 'yes'; } catch (_) { return false; } })();
      const postReloadWhy = (() => { try { return String(req.query?.post_settings_reload_why || '').toLowerCase(); } catch (_) { return ''; } })();
      const refreshCount = (() => { try { return Number(req.query?.refresh_count || 0) || 0; } catch(_) { return 0; } })();
      const sinceLastMs = (() => { try { const v = Number(req.query?.since_last_ms || ''); return isNaN(v) ? null : v; } catch(_) { return null; } })();
      let recencyMinutes = null;
      if (lastConversationUpdatedAt) {
        const diffMs = Date.now() - lastConversationUpdatedAt.getTime();
        recencyMinutes = Math.floor(diffMs / 60000);
      }
      const lines = [];
      lines.push('First-turn dynamics (recency & reload):');
      if (postReload) {
        const why = (postReloadWhy === 'voice' || postReloadWhy === 'style' || postReloadWhy === 'both') ? postReloadWhy : 'voice';
        const what = (why === 'both') ? 'voice and style' : why;
        lines.push(`- The user just reloaded after changing ${what}. Start with a brief, natural check that the new ${what} feels right (one short line), then continue without re‑introducing yourself.`);
        lines.push('- Avoid generic greetings like “Hi there” or “Hello again.” If recent, acknowledge the quick return.');
      }
      // Refresh count heuristics from the client (last 2 minutes)
      if (refreshCount && refreshCount >= 3) {
        lines.push('- The page has been refreshed multiple times in a short window; optionally add a playful one-liner about refreshing, then continue. Keep it kind and brief.');
      } else if (sinceLastMs != null && sinceLastMs <= 90_000) {
        lines.push('- Return is very recent (≤90s); acknowledge timing in one short line and pick up the thread immediately.');
      }
      if (recencyMinutes != null) {
        lines.push(`- Last conversation updated ~${recencyMinutes} min ago. Adjust tone:`);
        if (recencyMinutes <= 5) lines.push('  * <=5 min: note they’re back fast (1 short line), then continue.');
        else if (recencyMinutes <= 120) lines.push('  * <=120 min: light “welcome back,” then pick up the thread immediately.');
        else if (recencyMinutes <= 1440) lines.push('  * <=24h: warmly note the break; proceed without long recap.');
        else lines.push('  * >24h: offer a one‑line recap or ask if they want a quick update.');
      } else {
        lines.push('- No timestamp available: use a concise, non‑repetitive opener and continue quickly.');
      }
      lines.push('- Vary openings across sessions; avoid repeating phrasing. Keep it fresh and human.');
      // Enforce a concrete first-turn behavior to avoid jumping into mid-topic
      lines.push('- FIRST SENTENCE MUST be a brief, natural greeting (use the learner’s display name if provided). Never start mid-task, with tool requests, or with device/mic checks.');
      lines.push('- On the very first turn: do NOT reference prior content. Ask ONE short question: “Continue where we left off or start something new?” and wait for the user’s preference.');
      lines.push('- If the learner explicitly asks “what did we last talk about?”, answer with a 1–2 line summary drawn ONLY from the most recent excerpt, then ask a single follow‑up question.');
      insParts.push(lines.join('\n'));
    } catch (_) {}
    const instructionsFull = insParts.join('\n\n');
    // Send full instructions without truncation per request
    let instructions = instructionsFull;

    // Optional debug log of what we inject (full when debug is enabled)
    try {
      const envVal = String(process.env.DEBUG_CONTEXT_LOG || '').toLowerCase();
      const dbgEnv = ['true','1','yes','on','full','all','raw'].includes(envVal);
      const dbgQueryStr = String(req.query?.debug || '').toLowerCase();
      const dbgQuery = ['true','1','yes','on','full','all','raw'].includes(dbgQueryStr);
      // When any debug flag is present, always print FULL content
      if (dbgEnv || dbgQuery) {
        console.log('================ [realtime.token context] ================');
        console.log('email:', req.user?.email || null);
        console.log('contextSummary.len:', (contextSummary || '').length);
        console.log('contextSummary.full:', contextSummary || '');
        console.log('instructions.len.full:', (instructionsFull || '').length);
        console.log('instructions.len.sent:', (instructions || '').length);
        console.log('instructions.full (unsent, pre-trim):', instructionsFull || '');
        console.log('==========================================================');
      }
    } catch (_) {}

    async function postSessionWithRetry(payload, attempts = 2) {
      let lastErr = null;
      const timeoutMs = Math.max(3000, Number(process.env.REALTIME_TOKEN_TIMEOUT_MS || 10000));
      for (let i = 1; i <= attempts; i++) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const resp = await fetchImpl('https://api.openai.com/v1/realtime/sessions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'OpenAI-Beta': 'realtime=v1'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          });
          clearTimeout(t);
          return resp;
        } catch (e) {
          clearTimeout(t);
          lastErr = e;
          if (i < attempts) { await new Promise(r => setTimeout(r, 600 * i)); continue; }
          throw e;
        }
      }
      throw lastErr || new Error('realtime session post failed');
    }

    const upstream = await postSessionWithRetry({
      model,
      modalities: ['audio', 'text'],
      voice: preferredVoice,
      // Provide soft context tying the realtime agent to the authenticated user
      instructions
    });
    let data = null;
    try { data = await upstream.json(); } catch (_) { data = null; }
    if (!upstream.ok) return res.status(upstream.status || 502).json(data || { error: 'upstream_failed' });
    const token = data?.client_secret?.value;
    if (!token) return res.status(500).json({ error: 'No client token in response' });
    res.json({ token, hasHistory, preferredVoice });
  } catch (err) {
    console.error('Token endpoint error:', err);
    res.status(500).json({ error: 'Token endpoint error' });
  }
});

// ====================================================================================================
// Section: Auth endpoints (register/login/logout)
// - Bridges identities across Postgres app_user and MySQL users/registrants
// ====================================================================================================
// Register: creates MySQL registrant + user, and Postgres app_user (bridged)
app.post('/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });

    // 1) Hash password
    const hash = await bcrypt.hash(String(password), 10);

    // 2) Ensure Postgres app_user exists (source of truth for identity)
    const created = await createUser({ email }); // from retrieval.js
    const pgUserId = created.id;

    // 3) Upsert MySQL users (for login) and registrants (business record)
    await mysqlDb.query(
      `INSERT INTO users (name,email,password,created_at,updated_at)
       VALUES (?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE name=VALUES(name), password=VALUES(password), updated_at=NOW()`,
      [name, email, hash, new Date()]
    );

    const rows = await mysqlDb.query(
      `SELECT id FROM registrants WHERE email = ? LIMIT 1`,
      [email]
    );
    if (rows.length === 0) {
      await mysqlDb.query(
        `INSERT INTO registrants (name,email,phone,additional_info,has_registered,created_at,updated_at)
         VALUES (?,?,?,?,1,NOW(),NOW())`,
        [name, email, phone || null, JSON.stringify({ source: 'ai_companion', pg_user_id: pgUserId })]
      );
    } else {
      await mysqlDb.query(
        `UPDATE registrants
           SET name=?, phone=?, additional_info=JSON_SET(COALESCE(additional_info,'{}'),'$.pg_user_id', ?), updated_at=NOW()
         WHERE id=?`,
        [name, phone || null, pgUserId, rows[0].id]
      );
    }

    // 4) Issue session
    const token = signToken({ email, pgUserId });
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('auth', token, { httpOnly: true, sameSite: 'Lax', secure: isProd, maxAge: 7*24*3600*1000 });
    return res.json({ ok: true, email, pgUserId });
  } catch (e) {
    console.error('register error', e);
    res.status(500).json({ error: 'registration failed' });
  }
});

// Login with MySQL users table
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const users = await mysqlDb.query(`SELECT id,name,email,password FROM users WHERE email=? LIMIT 1`, [email]);
    if (users.length === 0) return res.status(401).json({ error: 'invalid credentials' });

    const ok = await bcrypt.compare(String(password), users[0].password || '');
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    let pgUserId = null;
    const reg = await mysqlDb.query(`SELECT id, additional_info FROM registrants WHERE email=? LIMIT 1`, [email]);
    if (reg.length && reg[0].additional_info && reg[0].additional_info.pg_user_id) {
      pgUserId = reg[0].additional_info.pg_user_id;
    } else {
      // create in Postgres and store link in MySQL
      const created = await createUser({ email });
      pgUserId = created.id;
      if (reg.length) {
        await mysqlDb.query(
          `UPDATE registrants SET additional_info=JSON_SET(COALESCE(additional_info,'{}'),'$.pg_user_id', ?), updated_at=NOW() WHERE id=?`,
          [pgUserId, reg[0].id]
        );
      } else {
        await mysqlDb.query(
          `INSERT INTO registrants (name,email,additional_info,has_registered,created_at,updated_at)
           VALUES (?,?,JSON_OBJECT('pg_user_id', ?),1,NOW(),NOW())`,
          [email.split('@')[0], email, pgUserId]
        );
      }
    }

    const token = signToken({ email, pgUserId });
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('auth', token, { httpOnly: true, sameSite: 'Lax', secure: isProd, maxAge: 7*24*3600*1000 });
    return res.json({ ok: true, email, pgUserId });
  } catch (e) {
    console.error('login error', e);
    res.status(500).json({ error: 'login failed' });
  }
});

// Logout and attempt background finalize of latest session
app.post('/auth/logout', async (req, res) => {
  try {
    // Attempt to finalize the latest session for this user before logging out
    let pgUserId = null;
    try {
      const token = (req.cookies && req.cookies.auth) || '';
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      pgUserId = decoded?.pgUserId || null;
    } catch (_) {}

    if (pgUserId) {
      try {
        const row = await query(
          `SELECT id FROM chat_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [pgUserId]
        );
        if (row && row.rows && row.rows[0]) {
          const sid = row.rows[0].id;
          console.log('[summary] logout_finalize (bg)', { sessionId: sid, userId: pgUserId });
          // Fire-and-forget in background so logout returns immediately
          setImmediate(() => {
            summarizeAndSaveSession(sid, pgUserId).catch((e) => {
              try { console.warn('logout finalize failed', e?.message || e); } catch (_) {}
            });
          });
        }
      } catch (_) {}
    }
  } finally {
    res.clearCookie('auth');
    res.json({ ok: true });
  }
});

// ====================================================================================================
// Section: Me and profile endpoints (MySQL + Postgres mirrors)
// ====================================================================================================
app.get('/me', authRequired, (req, res) => {
  res.json({ ok: true, ...req.user });
});

// Basic profile for the authenticated user from MySQL
app.get('/user/profile', authRequired, async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) return res.status(400).json({ error: 'No email on token' });
    const rows = await mysqlDb.query(
      `SELECT id,name,email,created_at,updated_at FROM users WHERE email=? LIMIT 1`,
      [email]
    );
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
    const u = rows[0];
    let extras = null;
    try {
      const d = await mysqlDb.query(
        `SELECT onboarding_step,avatar,ai_avatar,onboarding_completed_at FROM user_data WHERE user_id=? LIMIT 1`,
        [u.id]
      );
      if (d && d.length) extras = d[0];
    } catch (_) {}
    return res.json({ ok: true, profile: { id: u.id, name: u.name, email: u.email, created_at: u.created_at, updated_at: u.updated_at, ...(extras || {}) } });
  } catch (e) {
    console.error('profile error', e);
    res.status(500).json({ error: 'profile failed' });
  }
});

// Deep user context for personalization (reads Postgres mirrors)
app.get('/user/context', authRequired, async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) return res.status(400).json({ error: 'No email on token' });

    // Resolve MySQL numeric user_id from mirrored users
    const ures = await query(`SELECT id FROM user_mysql_mirror WHERE email = $1 LIMIT 1`, [email]);
    const mysqlUserId = ures?.rows?.[0]?.id || null;
    if (!mysqlUserId) return res.status(404).json({ error: 'User not mirrored yet' });

    // Upcoming events user is registered/favorited for (start_at in future)
    const upcoming = await query(
      `SELECT e.id, e.title, e.description, e.start_at, e.length, e.category_id
         FROM events_mysql_mirror e
         LEFT JOIN event_user_favorites_mysql_mirror f ON f.event_id = e.id AND f.user_id = $1
         LEFT JOIN event_attendances_mysql_mirror a ON a.event_id = e.id AND a.user_id = $1
        WHERE e.start_at > now()
          AND (f.user_id IS NOT NULL OR a.user_id IS NOT NULL)
        ORDER BY e.start_at ASC
        LIMIT 50`,
      [mysqlUserId]
    );

    // Most recent attended events
    const attended = await query(
      `SELECT e.id, e.title, e.start_at, a.joined_at, a.left_at, a.duration
         FROM event_attendances_mysql_mirror a
         JOIN events_mysql_mirror e ON e.id = a.event_id
        WHERE a.user_id = $1
        ORDER BY COALESCE(a.left_at, a.joined_at) DESC
        LIMIT 50`,
      [mysqlUserId]
    );

  // Materials for user's attended or favorited events
  const materials = await query(
      `SELECT m.event_id, m.title, m.type, m.data, m.created_at
         FROM event_materials_mysql_mirror m
         WHERE m.event_id IN (
           SELECT event_id FROM event_attendances_mysql_mirror WHERE user_id = $1
           UNION
           SELECT event_id FROM event_user_favorites_mysql_mirror WHERE user_id = $1
         )
        ORDER BY m.created_at DESC
        LIMIT 200`,
      [mysqlUserId]
  );

  // Transcripts for events the user attended (limit 5 newest)
  let transcripts = null;
  try {
    transcripts = await query(
      `SELECT t.event_id, e.title, t.transcript, t.created_at
         FROM events_transcript_mysql_mirror t
         JOIN events_mysql_mirror e ON e.id = t.event_id
        WHERE t.event_id IN (
          SELECT event_id FROM event_attendances_mysql_mirror WHERE user_id = $1
        )
        ORDER BY t.created_at DESC
        LIMIT 5`,
      [mysqlUserId]
    );
  } catch (_) { transcripts = { rows: [] }; }

    // Quiz attempts and responses
    const quizAttempts = await query(
      `SELECT qa.id, qa.event_quiz_id, qa.attempt_number, qa.score_percentage, qa.passed, qa.started_at, qa.completed_at
         FROM event_quiz_attempts_mysql_mirror qa
        WHERE qa.user_id = $1
        ORDER BY qa.started_at DESC
        LIMIT 100`,
      [mysqlUserId]
    );
    const quizResponses = await query(
      `SELECT r.event_quiz_attempt_id, r.event_quiz_question_id, r.selected_option_index, r.is_correct, r.answered_at
         FROM event_quiz_responses_mysql_mirror r
        WHERE r.event_quiz_attempt_id IN (
          SELECT id FROM event_quiz_attempts_mysql_mirror WHERE user_id = $1
        )
        ORDER BY r.answered_at DESC
        LIMIT 1000`,
      [mysqlUserId]
    );

    // Webinar Q&A by user
    const webinarQA = await query(
      `SELECT q.event_id, q.question, q.answer, q.is_answered, q.created_at, q.updated_at
         FROM event_webinar_questions_mysql_mirror q
        WHERE q.user_id = $1 OR q.email = $2
        ORDER BY q.created_at DESC
        LIMIT 200`,
      [mysqlUserId, email]
    );

    // NPS feedback
    const nps = await query(
      `SELECT n.event_id, n.event_rating, n.lecturer_rating, n.created_at
         FROM event_nps_responses_mysql_mirror n
        WHERE n.user_id = $1
        ORDER BY n.created_at DESC
        LIMIT 200`,
      [mysqlUserId]
    );

    // Certificates
    const certificates = await query(
      `SELECT c.event_id, c.certificate, c.status, c.created_at
         FROM event_certificates_mysql_mirror c
        WHERE c.user_id = $1
        ORDER BY c.created_at DESC
        LIMIT 200`,
      [mysqlUserId]
    );

    // Preferred categories from recent events
    const categories = await query(
      `SELECT DISTINCT c.id, c.title, c.color
         FROM categories_mysql_mirror c
         JOIN events_mysql_mirror e ON e.category_id = c.id
         JOIN event_attendances_mysql_mirror a ON a.event_id = e.id
        WHERE a.user_id = $1
        ORDER BY c.title ASC
        LIMIT 100`,
      [mysqlUserId]
    );

    return res.json({ ok: true, user_id: mysqlUserId,
      upcoming_events: upcoming.rows,
      attended_events: attended.rows,
      materials: materials.rows,
      transcripts: transcripts.rows,
      quiz_attempts: quizAttempts.rows,
      quiz_responses: quizResponses.rows,
      webinar_qa: webinarQA.rows,
      nps: nps.rows,
      certificates: certificates.rows,
      categories: categories.rows
    });
  } catch (e) {
    console.error('user_context error', e);
    res.status(500).json({ error: 'context failed' });
  }
});

// ====================================================================================================
// Section: Health
// ====================================================================================================
// Health check for Postgres and Redis
app.get('/health', async (_req, res) => {
  try {
    await connectRedis();
    const pong = await redis.ping();
    const result = await query('SELECT now() AS now');
    const dbTime = result && result.rows && result.rows[0] ? result.rows[0].now : null;
    res.json({ ok: true, redis: pong, dbTime });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====================================================================================================
// Section: Tool execution endpoint (user memory + KB + preferences)
// ====================================================================================================
// Tool execution endpoint (user memory + KB + preferences)
app.post('/tools/execute', authRequired, async (req, res) => {
  try {
    const { name, arguments: args } = req.body || {};
    const toolName = String(name || '').trim();
    if (!toolName) return res.status(400).json({ error: 'Missing tool name' });
    if (toolName === 'fetch_chat_history') {
      const { range, from, to, sessions } = args || {};
      const userId = (req.user && req.user.pgUserId) || null;
      if (!userId) return res.status(401).json({ error: 'Unauthorized' });
      // Mode 1: last N conversations (sessions param)
      if (Number(sessions) && Number(sessions) > 0) {
        const n = Math.min(10, Math.max(1, Number(sessions)));
        const rs = await query(
          `SELECT session_id, content, updated_at
             FROM chat_message
            WHERE user_id = $1
            ORDER BY updated_at DESC
            LIMIT $2`,
          [userId, n]
        );
        const out = (rs.rows || []).map(r => ({
          session_id: r.session_id,
          updated_at: r.updated_at,
          content: r.content
        }));
        return res.json({ ok: true, sessions: out });
      }
      // Mode 2: date range (default last_week)
      const now = new Date();
      let start = null, end = null;
      try {
        if (String(range || '').toLowerCase() === 'yesterday') {
          end = new Date();
          start = new Date(now.getTime() - 24*3600*1000);
        } else if (String(range || '').toLowerCase() === 'last_week') {
          end = new Date();
          start = new Date(now.getTime() - 7*24*3600*1000);
        } else if (String(range || '').toLowerCase() === 'custom') {
          start = from ? new Date(from) : null;
          end = to ? new Date(to) : null;
        }
      } catch (_) {}
      if (!start) start = new Date(now.getTime() - 7*24*3600*1000);
      if (!end) end = now;
      const rows = await query(
        `SELECT session_id, user_id, role, content, created_at
           FROM chat_message
          WHERE user_id = $1 AND created_at BETWEEN $2 AND $3
          ORDER BY created_at ASC`,
        [userId, start.toISOString(), end.toISOString()]
      );
      return res.json({ ok: true, items: rows.rows || [], from: start.toISOString(), to: end.toISOString() });
    }
    const authedUserId = (req.user && req.user.pgUserId) || null;
    
    // Lightweight observability to troubleshoot client → server tool calls
    try { console.log('[tools/execute]', toolName, Object.keys(args || {})); } catch (_) {}

    if (toolName === 'create_chat_session') {
      const title = (args && args.title) ? args.title : 'WebRTC Session';
      if (!authedUserId) return res.status(401).json({ error: 'Unauthorized' });
      const out = await createChatSession({ userId: authedUserId, title });
      return res.json({ ok: true, id: out.id });
    }

    if (toolName === 'add_chat_turn' || toolName === 'addChatTurn') {
      const { sessionId, role, content } = args || {};
      if (!sessionId || !role || !content) return res.status(400).json({ error: 'sessionId, role, content required' });
      await addChatTurn(sessionId, role, content);
      try {
        const owner = authedUserId || (await (async () => {
          try { const r = await query(`SELECT user_id FROM chat_session WHERE id = $1`, [sessionId]); return (r.rows && r.rows[0] && r.rows[0].user_id) || null; } catch (_) { return null; }
        })());
        await addChatMessage({ sessionId, userId: owner, role, content });
      } catch (e) {
        try { console.error('[add_chat_message error]', e && e.message ? e.message : e); } catch (_) {}
      }
      // Conversation persistence handled by addChatTurn (Redis) and addChatMessage (Postgres)
      return res.json({ ok: true });
    }

    if (toolName === 'get_recent_chat' || toolName === 'getRecentChat') {
      const { sessionId, n } = args || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const items = await getRecentChat(sessionId, n || 20);
      let dbItems = [];
      try { dbItems = await getRecentMessages({ sessionId, n: n || 50 }); } catch (_) {}
      return res.json({ ok: true, items, dbItems });
    }

    if (toolName === 'save_session_summary') {
      const { sessionId, summary, use_model, auto, from_messages } = args || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      // If explicitly requested (or summary omitted), summarize from chat_message via model
      if (use_model === true || auto === true || from_messages === true || !summary) {
        console.log('[summary] save_session_summary→summarizeAndSaveSession', { sessionId, user: authedUserId });
        const result = await summarizeAndSaveSession(sessionId, authedUserId);
        return res.json({ ok: true, ...result });
      }
      console.log('[summary] saving raw summary for session', sessionId, 'user', authedUserId);
      const out = await saveSessionSummary({ sessionId, userId: authedUserId, summary });
      console.log('[summary] saved id', out.id);
      return res.json({ ok: true, id: out.id });
    }

    if (toolName === 'enter_event') {
      try {
        const { event_id, sessionId } = args || {};
        const eid = Number(event_id);
        if (!eid || isNaN(eid)) return res.status(400).json({ ok:false, error:'event_id required' });
        const userEmail = (req.user && req.user.email) || null;
        if (!userEmail) return res.status(401).json({ ok:false, error:'auth_required' });
        // Ensure MySQL user exists and fetch numeric id
        let mysqlUserId = null;
        try { const u = await mysqlDb.query(`SELECT id FROM users WHERE email=? LIMIT 1`, [userEmail]); if (u && u.length) mysqlUserId = u[0].id; } catch(_) {}
        if (!mysqlUserId) { try { await ensureMysqlUserForEmail(userEmail, null); } catch(_) {}
          try { const u2 = await mysqlDb.query(`SELECT id FROM users WHERE email=? LIMIT 1`, [userEmail]); if (u2 && u2.length) mysqlUserId = u2[0].id; } catch(_) {}
        }
        if (!mysqlUserId) return res.status(500).json({ ok:false, error:'user_not_in_mysql' });

        // Idempotent create/update of attendance
        let attendanceId = null;
        try {
          const existing = await mysqlDb.query(`SELECT id FROM event_attendances WHERE user_id=? AND event_id=? LIMIT 1`, [mysqlUserId, eid]);
          if (existing && existing.length) {
            attendanceId = existing[0].id;
            await mysqlDb.query(`UPDATE event_attendances SET joined_at=COALESCE(joined_at, NOW()), left_at=NULL, updated_at=NOW() WHERE id=?`, [attendanceId]);
          } else {
            await mysqlDb.query(`INSERT INTO event_attendances (user_id, event_id, joined_at, created_at, updated_at) VALUES (?,?,NOW(),NOW(),NOW())`, [mysqlUserId, eid]);
            const r2 = await mysqlDb.query(`SELECT id FROM event_attendances WHERE user_id=? AND event_id=? ORDER BY id DESC LIMIT 1`, [mysqlUserId, eid]);
            attendanceId = r2 && r2.length ? r2[0].id : null;
          }
        } catch (e) {
          // Fallback: try minimal insert without timestamps
          try {
            await mysqlDb.query(`INSERT INTO event_attendances (user_id, event_id) VALUES (?,?)`, [mysqlUserId, eid]);
          } catch(_) {}
        }

        // Optional: log to chat for realtime awareness
        try {
          if (sessionId) {
            await addChatTurn(sessionId, 'user', `I entered event ${eid}.`);
            try { await addChatMessage({ sessionId, userId: authedUserId, role: 'user', content: `I entered event ${eid}.` }); } catch(_) {}
          }
        } catch (_) {}

        return res.json({ ok:true, attendance_id: attendanceId, event_id: eid, user_id: mysqlUserId });
      } catch (e) {
        console.error('enter_event error', e);
        return res.status(500).json({ ok:false, error:'enter_event_failed' });
      }
    }

    // Add to favorites/wishlist (MySQL: event_user_favorites); mirrored to Postgres
    if (toolName === 'user_favourite' || toolName === 'user_favorite' || toolName === 'favorite_event' || toolName === 'favourite_event') {
      try {
        const { event_id } = args || {};
        const eid = Number(event_id);
        if (!eid || isNaN(eid)) return res.status(400).json({ ok:false, error:'event_id required' });
        const userEmail = (req.user && req.user.email) || null;
        if (!userEmail) return res.status(401).json({ ok:false, error:'auth_required' });
        // Resolve/create MySQL user id
        let mysqlUserId = null;
        try { const u = await mysqlDb.query(`SELECT id FROM users WHERE email=? LIMIT 1`, [userEmail]); if (u && u.length) mysqlUserId = u[0].id; } catch(_) {}
        if (!mysqlUserId) { try { await ensureMysqlUserForEmail(userEmail, null); } catch(_) {}
          try { const u2 = await mysqlDb.query(`SELECT id FROM users WHERE email=? LIMIT 1`, [userEmail]); if (u2 && u2.length) mysqlUserId = u2[0].id; } catch(_) {}
        }
        if (!mysqlUserId) return res.status(500).json({ ok:false, error:'user_not_in_mysql' });

        // Idempotent favorite insert
        let favoriteId = null;
        try {
          const existing = await mysqlDb.query(`SELECT id FROM event_user_favorites WHERE user_id=? AND event_id=? LIMIT 1`, [mysqlUserId, eid]);
          if (existing && existing.length) {
            favoriteId = existing[0].id;
            await mysqlDb.query(`UPDATE event_user_favorites SET updated_at=NOW() WHERE id=?`, [favoriteId]);
          } else {
            await mysqlDb.query(`INSERT INTO event_user_favorites (user_id, event_id, created_at, updated_at) VALUES (?,?,NOW(),NOW())`, [mysqlUserId, eid]);
            const r2 = await mysqlDb.query(`SELECT id FROM event_user_favorites WHERE user_id=? AND event_id=? ORDER BY id DESC LIMIT 1`, [mysqlUserId, eid]);
            favoriteId = r2 && r2.length ? r2[0].id : null;
          }
        } catch (e) {
          console.warn('user_favourite insert failed', e?.message || e);
        }

        return res.json({ ok:true, favorite_id: favoriteId, event_id: eid, user_id: mysqlUserId });
      } catch (e) {
        console.error('user_favourite error', e);
        return res.status(500).json({ ok:false, error:'user_favourite_failed' });
      }
    }

    if (toolName === 'summarize_session' || toolName === 'finalize_session') {
      const { sessionId } = args || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const result = await summarizeAndSaveSession(sessionId, authedUserId);
      return res.json({ ok: true, ...result });
    }

    if (toolName === 'read_latest_summary') {
      if (!authedUserId) return res.status(400).json({ error: 'userId is required' });
      const row = await readLatestSummary({ userId: authedUserId });
      return res.json({ ok: true, summary: row });
    }

    if (toolName === 'read_preferred_language') {
      if (!authedUserId) return res.status(400).json({ error: 'userId is required' });
      const out = await readPreferredLanguagePg({ userId: authedUserId });
      return res.json({ ok: true, language: out.language });
    }

    if (toolName === 'set_preferred_language') {
      const { language } = args || {};
      if (!authedUserId || !language) return res.status(400).json({ error: 'userId and language are required' });
      await setPreferredLanguagePg({ userId: authedUserId, language });
      return res.json({ ok: true });
    }

    // Add one or more user memory items (fact, preference, goal, progress, open_question)
    if (toolName === 'add_user_memory' || toolName === 'user_memory_add' || toolName === 'save_user_memory') {
      try {
        if (!authedUserId) return res.status(401).json({ ok:false, error:'auth_required' });
        const { type, statement, items, pinned, stability } = args || {};
        let payload = [];
        if (Array.isArray(items) && items.length) {
          payload = items;
        } else if (type && statement) {
          payload = [{ type: String(type), statement: String(statement), pinned: !!pinned, stability: stability ? String(stability) : undefined }];
        }
        if (!payload.length) return res.status(400).json({ ok:false, error:'missing_items' });
        await ensureMemoryTables();
        const result = await upsertUserMemoryItems(authedUserId, payload);
        return res.json({ ok:true, upserted: result.upserted || 0 });
      } catch (e) {
        console.error('add_user_memory error', e);
        return res.status(500).json({ ok:false, error:'add_user_memory_failed' });
      }
    }

    // Read user memory items (optionally filter by type, limit)
    if (toolName === 'get_user_memory' || toolName === 'list_user_memory') {
      try {
        if (!authedUserId) return res.status(401).json({ ok:false, error:'auth_required' });
        const { type, limit } = args || {};
        const k = Math.max(1, Math.min(200, Number(limit) || 50));
        const params = [authedUserId];
        let sql = `SELECT type, statement, first_seen, last_seen, pinned, stability FROM user_memory WHERE user_id = $1`;
        if (type && String(type).trim()) { sql += ` AND type = $2`; params.push(String(type).trim()); }
        sql += ` ORDER BY pinned DESC, last_seen DESC LIMIT ${k}`;
        const r = await query(sql, params);
        return res.json({ ok:true, user_id: authedUserId, items: r.rows || [] });
      } catch (e) {
        console.error('get_user_memory error', e);
        return res.status(500).json({ ok:false, error:'get_user_memory_failed' });
      }
    }

    if (toolName === 'read_agent_name') {
      if (!authedUserId) return res.status(400).json({ error: 'userId is required' });
      const out = await readAgentNamePg({ userId: authedUserId });
      return res.json({ ok: true, name: out.name });
    }

    if (toolName === 'set_agent_name') {
      const { name } = args || {};
      if (!authedUserId || !name) return res.status(400).json({ error: 'userId and name are required' });
      await setAgentNamePg({ userId: authedUserId, name });
      return res.json({ ok: true });
    }

    if (toolName === 'read_agent_settings') {
      const { userId } = args || {};
      const targetUserId = userId || authedUserId;
      if (!authedUserId) return res.status(400).json({ error: 'auth required' });
      if (!targetUserId) return res.status(400).json({ error: 'userId is required' });
      // Enforce: caller can only read their own settings
      if (String(targetUserId) !== String(authedUserId)) return res.status(403).json({ error: 'forbidden' });
      const out = await readAgentSettingsPg({ userId: targetUserId });
      return res.json({ ok: true, ...out });
    }

    if (toolName === 'set_agent_settings') {
      const { userId: userIdArg, name, voice, style } = args || {};
      const targetUserId = userIdArg || authedUserId;
      if (!authedUserId) return res.status(400).json({ error: 'auth required' });
      if (!targetUserId) return res.status(400).json({ error: 'userId is required' });
      // Enforce: can only set own settings
      if (String(targetUserId) !== String(authedUserId)) return res.status(403).json({ error: 'forbidden' });
      await setAgentSettingsPg({ userId: targetUserId, name, voice, style });
      return res.json({ ok: true, reload_required: true, message: 'Settings updated. Please reload the page to apply voice/style changes to the next session.' });
    }

    if (toolName === 'list_courses') {
      try {
        // Discover available columns to robustly build results
        const colsRes = await query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'events_mysql_mirror'`
        );
        const cols = new Set((colsRes.rows || []).map(r => r.column_name));
        // We'll build from Postgres mirror when present, then merge any missing items from MySQL (fallback)

        const selectCols = ['id'];
        const titleCol = cols.has('title') ? 'title' : (cols.has('name') ? 'name' : null);
        if (titleCol) selectCols.push(titleCol);
        const maybeCols = ['start_at','starts_at','start_datetime','event_start','datetime','scheduled_at','event_date','start_date','date','start_time','time'];
        const present = maybeCols.filter(c => cols.has(c));
        selectCols.push(...present);
        let items = [];
        const tz = String(process.env.APP_TIMEZONE || 'Europe/Skopje');
        const now = new Date();
        function computeRelative(start) {
          if (!start) return { starts_in_days: null, starts_in_weeks: null, starts_in_human: null };
          const diffMs = start.getTime() - now.getTime();
          if (diffMs <= 0) return { starts_in_days: 0, starts_in_weeks: 0, starts_in_human: 'started' };
          const days = Math.ceil(diffMs / (24*3600*1000));
          const weeks = Math.floor(days / 7);
          let human = '';
          if (days < 1) {
            const hrs = Math.max(1, Math.round(diffMs / (3600*1000)));
            human = `in ${hrs} hour${hrs===1?'':'s'}`;
          } else if (days < 14) {
            human = `in ${days} day${days===1?'':'s'}`;
          } else {
            human = `in ${weeks} week${weeks===1?'':'s'}`;
          }
          return { starts_in_days: days, starts_in_weeks: weeks, starts_in_human: human };
        }
        if (cols.size > 0) {
          const sql = `SELECT ${selectCols.join(', ')} FROM events_mysql_mirror`;
          const ev = await query(sql);
          items = (ev.rows || []).map(row => {
            const title = titleCol ? row[titleCol] : (row.title || row.name || `Course ${row.id || ''}`);
            // Derive a start Date
            let start = null;
            const val = (k) => (k && row[k] != null ? String(row[k]) : null);
            const datePart = val('event_date') || val('start_date') || val('date');
            const timePart = val('start_time') || val('time');
            const directTs = val('start_at') || val('starts_at') || val('start_datetime') || val('event_start') || val('datetime') || val('scheduled_at');
            if (directTs) {
              const d = new Date(directTs);
              if (!isNaN(d)) start = d;
            } else if (datePart && timePart) {
              const d = new Date(`${datePart} ${timePart}`);
              if (!isNaN(d)) start = d;
            } else if (datePart) {
              const d = new Date(`${datePart}T00:00:00`);
              if (!isNaN(d)) start = d;
            }
            const status = start ? (start.getTime() > now.getTime() ? 'upcoming' : (start.toDateString() === now.toDateString() ? 'today' : 'past')) : 'unknown';
            let start_local = null, start_date_local = null, start_time_local = null, start_weekday_local = null;
            try {
              if (start) {
                start_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(start);
                start_date_local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(start);
                start_time_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour:'2-digit', minute:'2-digit' }).format(start);
                start_weekday_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(start);
              }
            } catch (_) {}
            const rel = computeRelative(start);
            return { id: row.id || null, title, start_iso: start ? start.toISOString() : null, start_local, start_date_local, start_time_local, start_weekday_local, timezone: tz, status, ...rel };
          });
        }

        // Fallback/merge from MySQL when mirror is missing or lagging
        try {
          const mysqlRows = await mysqlDb.query(`SELECT id, title, start_at FROM events ORDER BY start_at ASC`);
          const map = new Map();
          for (const it of items) { if (it && it.id != null) map.set(String(it.id), it); }
          for (const r of (mysqlRows || [])) {
            const key = String(r.id);
            if (!map.has(key)) {
              const title = r.title || `Course ${r.id || ''}`;
              const start = r.start_at ? new Date(r.start_at) : null;
              const status = start ? (start.getTime() > now.getTime() ? 'upcoming' : (start.toDateString() === now.toDateString() ? 'today' : 'past')) : 'unknown';
              let start_local = null, start_date_local = null, start_time_local = null, start_weekday_local = null;
              try {
                if (start) {
                  start_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(start);
                  start_date_local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(start);
                  start_time_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour:'2-digit', minute:'2-digit' }).format(start);
                  start_weekday_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(start);
                }
              } catch(_) {}
              const rel = computeRelative(start);
              map.set(key, { id: r.id, title, start_iso: start ? start.toISOString() : null, start_local, start_date_local, start_time_local, start_weekday_local, timezone: tz, status, ...rel });
            }
          }
          items = Array.from(map.values());
        } catch (_) { /* ignore MySQL fallback errors */ }
        // Sort upcoming first by time asc, then today, then past by time desc
        items.sort((a,b) => {
          const rank = (s) => s === 'upcoming' ? 0 : (s === 'today' ? 1 : (s === 'past' ? 2 : 3));
          const ra = rank(a.status), rb = rank(b.status);
          if (ra !== rb) return ra - rb;
          const ta = a.start_iso ? Date.parse(a.start_iso) : 0;
          const tb = b.start_iso ? Date.parse(b.start_iso) : 0;
          return ra === 2 ? tb - ta : ta - tb; // past: latest first; others: earliest first
        });
        const out = { ok: true, counts: { total: items.length, upcoming: items.filter(i=>i.status==='upcoming').length, past: items.filter(i=>i.status==='past').length }, items };
        return res.json(out);
      } catch (e) {
        console.error('list_courses error', e);
        return res.status(500).json({ ok: false, error: 'list_courses_failed' });
      }
    }

    if (toolName === 'recommend_courses') {
      try {
        const { limit, days_ahead } = args || {};
        const lim = Math.min(10, Math.max(1, Number(limit) || 3));
        const ahead = Math.min(180, Math.max(1, Number(days_ahead) || 60));
        // Use list_courses-like aggregator and filter upcoming within N days
        const listRes = await (async () => {
          const colsRes = await query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='events_mysql_mirror'`);
          const cols = new Set((colsRes.rows || []).map(r=>r.column_name));
          const selectCols = ['id'];
          const titleCol = cols.has('title') ? 'title' : (cols.has('name') ? 'name' : null);
          if (titleCol) selectCols.push(titleCol);
          const maybeCols = ['start_at','starts_at','start_datetime','event_start','datetime','scheduled_at','event_date','start_date','date','start_time','time'];
          const present = maybeCols.filter(c => cols.has(c));
          selectCols.push(...present);
          let items = [];
          if (cols.size > 0) {
            const sql = `SELECT ${selectCols.join(', ')} FROM events_mysql_mirror`;
            const ev = await query(sql);
            items = (ev.rows || []).map(row => {
              const title = titleCol ? row[titleCol] : (row.title || row.name || `Course ${row.id || ''}`);
              let start = null;
              const val = (k) => (k && row[k] != null ? String(row[k]) : null);
              const datePart = val('event_date') || val('start_date') || val('date');
              const timePart = val('start_time') || val('time');
              const directTs = val('start_at') || val('starts_at') || val('start_datetime') || val('event_start') || val('datetime') || val('scheduled_at');
              if (directTs) { const d = new Date(directTs); if (!isNaN(d)) start = d; }
              else if (datePart && timePart) { const d = new Date(`${datePart} ${timePart}`); if (!isNaN(d)) start = d; }
              else if (datePart) { const d = new Date(`${datePart}T00:00:00`); if (!isNaN(d)) start = d; }
              return { id: row.id || null, title, start };
            });
          }
          // MySQL fallback/merge
          try {
            const mysqlRows = await mysqlDb.query(`SELECT id, title, start_at FROM events ORDER BY start_at ASC`);
            const map = new Map();
            for (const it of items) { if (it && it.id != null) map.set(String(it.id), it); }
            for (const r of (mysqlRows || [])) {
              const key = String(r.id);
              if (!map.has(key)) {
                const start = r.start_at ? new Date(r.start_at) : null;
                map.set(key, { id: r.id, title: r.title || `Course ${r.id || ''}`, start });
              }
            }
            items = Array.from(map.values());
          } catch (_) {}
          return { ok: true, items };
        })();
        const now = new Date();
        const futureLimit = new Date(now.getTime() + ahead*24*3600*1000);
        const tz = String(process.env.APP_TIMEZONE || 'Europe/Skopje');
        const upcoming = (listRes.items || [])
          .filter(x => x.start && x.start > now && x.start <= futureLimit)
          .sort((a,b)=>a.start-b.start)
          .slice(0, lim)
          .map(x => {
            let start_local = null, start_date_local = null, start_time_local = null, start_weekday_local = null;
            try {
              start_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(x.start);
              start_date_local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(x.start);
              start_time_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour:'2-digit', minute:'2-digit' }).format(x.start);
              start_weekday_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(x.start);
            } catch (_) {}
            const diffMs = x.start.getTime() - now.getTime();
            let starts_in_days = null, starts_in_weeks = null, starts_in_human = null;
            if (diffMs <= 0) { starts_in_days = 0; starts_in_weeks = 0; starts_in_human = 'started'; }
            else {
              starts_in_days = Math.ceil(diffMs / (24*3600*1000));
              starts_in_weeks = Math.floor(starts_in_days / 7);
              if (starts_in_days < 1) {
                const hrs = Math.max(1, Math.round(diffMs / (3600*1000)));
                starts_in_human = `in ${hrs} hour${hrs===1?'':'s'}`;
              } else if (starts_in_days < 14) {
                starts_in_human = `in ${starts_in_days} day${starts_in_days===1?'':'s'}`;
              } else {
                starts_in_human = `in ${starts_in_weeks} week${starts_in_weeks===1?'':'s'}`;
              }
            }
            return { id: x.id, title: x.title, start_iso: x.start.toISOString(), start_local, start_date_local, start_time_local, start_weekday_local, timezone: tz, starts_in_days, starts_in_weeks, starts_in_human };
          });
        return res.json({ ok: true, recommended: upcoming, window_days: ahead, timezone: tz });
      } catch (e) {
        console.error('recommend_courses error', e);
        return res.status(500).json({ ok: false, error: 'recommend_courses_failed' });
      }
    }

    // Get details (date/time) for a specific course by id or title
    if (toolName === 'get_event_details') {
      try {
        let { event_id, title } = args || {};
        let eid = Number(event_id);
        const titleStr = title && String(title).trim() ? String(title).trim() : null;
        let row = null;
        // Try Postgres mirror first
        try {
          if (eid) {
            row = await query(`SELECT id, title, name, start_at, starts_at, start_datetime, event_start, datetime, scheduled_at, event_date, start_date, date, start_time, time FROM events_mysql_mirror WHERE id = $1 LIMIT 1`, [eid]);
            row = (row.rows && row.rows[0]) || null;
          } else if (titleStr) {
            row = await query(`SELECT id, title, name, start_at, starts_at, start_datetime, event_start, datetime, scheduled_at, event_date, start_date, date, start_time, time FROM events_mysql_mirror WHERE LOWER(title) = LOWER($1) OR LOWER(name) = LOWER($1) OR LOWER(title) LIKE LOWER('%' || $1 || '%') ORDER BY id DESC LIMIT 1`, [titleStr]);
            row = (row.rows && row.rows[0]) || null;
          }
        } catch (_) { row = null; }
        // Fallback MySQL
        if (!row) {
          try {
            if (eid) {
              const m = await mysqlDb.query(`SELECT id, title, start_at FROM events WHERE id=? LIMIT 1`, [eid]);
              row = (m && m[0]) || null;
            } else if (titleStr) {
              const m = await mysqlDb.query(`SELECT id, title, start_at FROM events WHERE LOWER(title)=LOWER(?) OR LOWER(title) LIKE CONCAT('%', LOWER(?), '%') ORDER BY id DESC LIMIT 1`, [titleStr, titleStr]);
              row = (m && m[0]) || null;
            }
          } catch (_) { row = null; }
        }
        if (!row) return res.status(404).json({ ok:false, error:'event_not_found' });

        // Normalize title and start
        const titleOut = row.title || row.name || (titleStr || null);
        const val = (k) => (k && row[k] != null ? String(row[k]) : null);
        let start = null;
        const directTs = val('start_at') || val('starts_at') || val('start_datetime') || val('event_start') || val('datetime') || val('scheduled_at');
        const datePart = val('event_date') || val('start_date') || val('date');
        const timePart = val('start_time') || val('time');
        if (directTs) {
          const d = new Date(directTs); if (!isNaN(d)) start = d;
        } else if (datePart && timePart) {
          const d = new Date(`${datePart} ${timePart}`); if (!isNaN(d)) start = d;
        } else if (datePart) {
          const d = new Date(`${datePart}T00:00:00`); if (!isNaN(d)) start = d;
        }

        const tz = String(process.env.APP_TIMEZONE || 'Europe/Skopje');
        const now = new Date();
        let start_local = null, start_date_local = null, start_time_local = null, start_weekday_local = null, status = 'unknown';
        try {
          if (start) {
            status = start.getTime() > now.getTime() ? 'upcoming' : (start.toDateString() === now.toDateString() ? 'today' : 'past');
            start_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(start);
            start_date_local = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(start);
            start_time_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour:'2-digit', minute:'2-digit' }).format(start);
            start_weekday_local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short' }).format(start);
          }
        } catch (_) {}
        let starts_in_days = null, starts_in_weeks = null, starts_in_human = null;
        if (start) {
          const diffMs = start.getTime() - now.getTime();
          if (diffMs <= 0) { starts_in_days = 0; starts_in_weeks = 0; starts_in_human = 'started'; }
          else {
            starts_in_days = Math.ceil(diffMs / (24*3600*1000));
            starts_in_weeks = Math.floor(starts_in_days / 7);
            if (starts_in_days < 1) {
              const hrs = Math.max(1, Math.round(diffMs / (3600*1000)));
              starts_in_human = `in ${hrs} hour${hrs===1?'':'s'}`;
            } else if (starts_in_days < 14) {
              starts_in_human = `in ${starts_in_days} day${starts_in_days===1?'':'s'}`;
            } else {
              starts_in_human = `in ${starts_in_weeks} week${starts_in_weeks===1?'':'s'}`;
            }
          }
        }

        return res.json({ ok:true, event: { id: row.id || eid || null, title: titleOut, start_iso: start ? start.toISOString() : null, start_local, start_date_local, start_time_local, start_weekday_local, timezone: tz, status, starts_in_days, starts_in_weeks, starts_in_human } });
      } catch (e) {
        console.error('get_event_details error', e);
        return res.status(500).json({ ok:false, error:'get_event_details_failed' });
      }
    }

    // NOTE: Quiz generation removed; quizzes are retrieved from Postgres mirror tables

    if (toolName === 'get_event_quiz') {
      try {
        const { event_id } = args || {};
        const eid = Number(event_id);
        if (!eid || isNaN(eid)) return res.status(400).json({ ok:false, error:'event_id required' });
        // Read quiz metadata and questions from Postgres mirrors
        const qh = await query(`SELECT id FROM event_quizzes_mysql_mirror WHERE event_id = $1 ORDER BY id DESC LIMIT 1`, [eid]);
        const quizId = qh && qh.rows && qh.rows[0] && qh.rows[0].id;
        if (!quizId) return res.status(404).json({ ok:false, error:'quiz_not_found' });
        const rows = await query(`SELECT id, question, options FROM event_quiz_questions_mysql_mirror WHERE event_quiz_id = $1 ORDER BY id ASC`, [quizId]);
        const items = (rows.rows || []).map(r => ({ id: r.id, question: r.question, options: (typeof r.options === 'string' ? JSON.parse(r.options) : r.options) }));
        // Limit to 5 questions if larger
        const limited = items.slice(0, 5);
        return res.json({ ok:true, event_id: eid, quiz_id: quizId, questions: limited });
      } catch (e) {
        console.error('get_event_quiz error', e);
        return res.status(500).json({ ok:false, error:'get_event_quiz_failed' });
      }
    }

    if (toolName === 'get_event_summary') {
      try {
        let { event_id, title } = args || {};
        let eid = Number(event_id);
        if (!eid || isNaN(eid)) eid = null;
        const titleStr = (title && String(title).trim()) || null;

        // Resolve event id by title if needed (Postgres mirror then MySQL)
        if (!eid && titleStr) {
          // 1) Exact match (mirror)
          try {
            const r = await query(`SELECT id FROM events_mysql_mirror WHERE LOWER(title) = LOWER($1) OR LOWER(name) = LOWER($1) LIMIT 1`, [titleStr]);
            if (r && r.rows && r.rows.length) eid = Number(r.rows[0].id);
          } catch (_) {}
          // 2) LIKE '%title%'
          if (!eid) {
            try {
              const r = await query(`SELECT id FROM events_mysql_mirror WHERE LOWER(title) LIKE '%' || LOWER($1) || '%' OR LOWER(name) LIKE '%' || LOWER($1) || '%' ORDER BY id DESC LIMIT 1`, [titleStr]);
              if (r && r.rows && r.rows.length) eid = Number(r.rows[0].id);
            } catch (_) {}
          }
          // 3) Tokenized OR search
          if (!eid) {
            try {
              const toks = String(titleStr).toLowerCase().replace(/[^a-z0-9\s]+/g,' ').split(/\s+/).filter(w => w && w.length >= 3);
              if (toks.length) {
                const clauses = [];
                const params = [];
                toks.forEach((t) => {
                  params.push(`%${t}%`);
                  const p1 = params.length; // index for title pattern
                  params.push(`%${t}%`);
                  const p2 = params.length; // index for name pattern
                  clauses.push(`LOWER(title) LIKE $${p1} OR LOWER(name) LIKE $${p2}`);
                });
                const sql = `SELECT id, title FROM events_mysql_mirror WHERE ${clauses.join(' OR ')} ORDER BY id DESC LIMIT 5`;
                const r = await query(sql, params);
                if (r && r.rows && r.rows.length) {
                  // pick the row with most tokens matched (simple scoring)
                  let best = r.rows[0];
                  let bestScore = -1;
                  for (const row of r.rows) {
                    const title = String(row.title || '').toLowerCase();
                    let sc = 0; for (const t of toks) { if (title.includes(t)) sc++; }
                    if (sc > bestScore) { bestScore = sc; best = row; }
                  }
                  eid = Number(best.id);
                }
              }
            } catch (_) {}
          }
          // 4) MySQL fallback by LIKE
          if (!eid) {
            try {
              const m = await mysqlDb.query(`SELECT id FROM events WHERE LOWER(title)=LOWER(?) OR LOWER(title) LIKE CONCAT('%', LOWER(?), '%') ORDER BY id DESC LIMIT 1`, [titleStr, titleStr]);
              if (m && m.length) eid = Number(m[0].id);
            } catch (_) {}
          }
        }

        if (!eid) return res.status(400).json({ ok:false, error:'event_id_or_title_required' });

        // Fetch latest summary from Postgres mirror (preferred) then MySQL
        let row = null;
        try {
          const s = await query(`SELECT id, event_id, summary, summary_full, updated_at FROM events_summary_mysql_mirror WHERE event_id = $1 ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`, [eid]);
          row = (s && s.rows && s.rows[0]) || null;
        } catch (_) { row = null; }
        if (!row) {
          try {
            const s2 = await mysqlDb.query(`SELECT id, event_id, summary, summary_full, updated_at FROM events_summary WHERE event_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`, [eid]);
            row = (s2 && s2[0]) || null;
          } catch (_) { row = null; }
        }

        // Determine event title
        let eventTitle = null;
        try {
          const tr = await query(`SELECT title, name FROM events_mysql_mirror WHERE id = $1 LIMIT 1`, [eid]);
          if (tr && tr.rows && tr.rows[0]) eventTitle = tr.rows[0].title || tr.rows[0].name || null;
        } catch (_) {}
        if (!eventTitle) {
          try {
            const rr = await mysqlDb.query(`SELECT title FROM events WHERE id = ? LIMIT 1`, [eid]);
            if (rr && rr[0] && rr[0].title) eventTitle = rr[0].title;
          } catch (_) {}
        }

        if (!row) {
          // Graceful fallback: construct a short summary from event details (mirror → MySQL)
          let ev = null;
          try {
            const r = await query(`SELECT id, title, name, description, learning_objectives, skills_covered, practical_use, start_at FROM events_mysql_mirror WHERE id = $1 LIMIT 1`, [eid]);
            ev = (r && r.rows && r.rows[0]) || null;
          } catch (_) { ev = null; }
          if (!ev) {
            try {
              const m = await mysqlDb.query(`SELECT id, title, description, start_at FROM events WHERE id = ? LIMIT 1`, [eid]);
              ev = (m && m[0]) || null;
            } catch (_) { ev = null; }
          }
          const titleOut2 = (ev && (ev.title || ev.name)) || eventTitle || 'Course';
          const desc = (ev && ev.description) ? String(ev.description) : '';
          const lo = ev && ev.learning_objectives ? (typeof ev.learning_objectives === 'string' ? ev.learning_objectives : JSON.stringify(ev.learning_objectives)) : '';
          const skills = ev && ev.skills_covered ? (typeof ev.skills_covered === 'string' ? ev.skills_covered : JSON.stringify(ev.skills_covered)) : '';
          const start = ev && ev.start_at ? new Date(ev.start_at) : null;
          const tz = String(process.env.APP_TIMEZONE || 'Europe/Skopje');
          let when = '';
          try { if (start) { when = new Intl.DateTimeFormat('en-GB',{ timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(start); } } catch(_) {}
          const parts = [];
          parts.push(`<h3 style="margin:0 0 8px">${titleOut2}</h3>`);
          if (when) parts.push(`<div style="opacity:.8;margin:0 0 8px">Starts: ${when} (${tz})</div>`);
          if (desc) parts.push(`<p style="line-height:1.55;margin:0 0 10px">${desc}</p>`);
          if (lo) parts.push(`<div style="margin:10px 0"><strong>Learning objectives</strong><pre style="white-space:pre-wrap">${lo}</pre></div>`);
          if (skills) parts.push(`<div style="margin:10px 0"><strong>Skills covered</strong><pre style="white-space:pre-wrap">${skills}</pre></div>`);
          const html = parts.join('\n') || '<div>No details available.</div>';
          return res.json({ ok:true, found:true, event_id: eid, event_title: titleOut2, summary_html: html, generated: true });
        }
        const html = String(row.summary_full || row.summary || '').trim();
        return res.json({ ok:true, found:true, event_id: eid, event_title: eventTitle || null, summary_html: html, updated_at: row.updated_at || null });
      } catch (e) {
        console.error('get_event_summary error', e);
        return res.status(500).json({ ok:false, error:'get_event_summary_failed' });
      }
    }

    if (toolName === 'submit_event_quiz') {
      try {
        const { event_id, answers } = args || {};
        const eid = Number(event_id);
        if (!eid || isNaN(eid)) return res.status(400).json({ ok:false, error:'event_id required' });
        if (!answers || typeof answers !== 'object') return res.status(400).json({ ok:false, error:'answers object required' });

        const qr = await query(`SELECT id FROM event_quizzes_mysql_mirror WHERE event_id = $1 ORDER BY id DESC LIMIT 1`, [eid]);
        const quizId = (qr && qr.rows && qr.rows[0] && qr.rows[0].id) || null;
        if (!quizId) return res.status(404).json({ ok:false, error:'quiz_not_found' });
        const qsRes = await query(`SELECT id, correct_option_index FROM event_quiz_questions_mysql_mirror WHERE event_quiz_id = $1 ORDER BY id ASC`, [quizId]);
        const qsAll = qsRes.rows || [];
        if (!qsAll.length) return res.status(404).json({ ok:false, error:'questions_not_found' });
        // Keep the same subset the client shows (first 5)
        const qs = qsAll.slice(0, 5);

        // Resolve MySQL numeric user_id for attempts/responses
        const userEmail = (req.user && req.user.email) || null;
        if (!userEmail) return res.status(401).json({ ok:false, error:'auth_required' });
        let mysqlUserId = null;
        try {
          const urows = await mysqlDb.query(`SELECT id FROM users WHERE email=? LIMIT 1`, [userEmail]);
          if (urows && urows.length) mysqlUserId = urows[0].id;
        } catch (_) {}
        if (!mysqlUserId) {
          try { await ensureMysqlUserForEmail(userEmail, null); } catch(_) {}
          try {
            const u2 = await mysqlDb.query(`SELECT id FROM users WHERE email=? LIMIT 1`, [userEmail]);
            if (u2 && u2.length) mysqlUserId = u2[0].id;
          } catch(_) {}
        }
        if (!mysqlUserId) return res.status(500).json({ ok:false, error:'user_not_in_mysql' });

        // Compute attempt number
        let attemptNo = 1;
        try {
          const ar = await mysqlDb.query(`SELECT COALESCE(MAX(attempt_number),0)+1 AS n FROM event_quiz_attempts WHERE user_id=? AND event_quiz_id=?`, [mysqlUserId, quizId]);
          attemptNo = (ar && ar[0] && ar[0].n) || 1;
        } catch(_) {}

        // Insert attempt header (include optional questions_shown_ids if present in schema)
        let hasQuestionsShown = false;
        try {
          const cols = await mysqlDb.query(`SHOW COLUMNS FROM event_quiz_attempts`);
          hasQuestionsShown = Array.isArray(cols) && cols.some(c => String(c.Field || '').toLowerCase() === 'questions_shown_ids');
        } catch (_) { hasQuestionsShown = false; }
        if (hasQuestionsShown) {
          const shown = JSON.stringify(qs.map(q => q.id));
          await mysqlDb.query(
            `INSERT INTO event_quiz_attempts (user_id, event_quiz_id, attempt_number, questions_shown_ids, score_percentage, passed, started_at, completed_at, created_at, updated_at)
             VALUES (?,?,?,?,0,0,NOW(),NOW(),NOW(),NOW())`,
            [mysqlUserId, quizId, attemptNo, shown]
          );
        } else {
          await mysqlDb.query(
            `INSERT INTO event_quiz_attempts (user_id, event_quiz_id, attempt_number, score_percentage, passed, started_at, completed_at, created_at, updated_at)
             VALUES (?,?,?,0,0,NOW(),NOW(),NOW(),NOW())`,
            [mysqlUserId, quizId, attemptNo]
          );
        }
        const attemptIdRow = await mysqlDb.query(`SELECT id FROM event_quiz_attempts WHERE user_id=? AND event_quiz_id=? ORDER BY id DESC LIMIT 1`, [mysqlUserId, quizId]);
        const attemptId = attemptIdRow && attemptIdRow[0] && attemptIdRow[0].id;

        // Grade
        let correct = 0;
        for (const q of qs) {
          const qid = q.id;
          const sel = Number(answers[qid]);
          const ok = (!Number.isNaN(sel) && sel === Number(q.correct_option_index));
          if (ok) correct++;
          if (!isNaN(sel)) {
            await mysqlDb.query(`INSERT INTO event_quiz_responses (event_quiz_attempt_id, event_quiz_question_id, selected_option_index, is_correct, answered_at, created_at, updated_at) VALUES (?,?,?,?,NOW(),NOW(),NOW())`, [attemptId, qid, sel, ok ? 1 : 0]);
          }
        }
        const pct = Math.round((correct / Math.max(1, qs.length)) * 100);
        const passed = pct >= 70 ? 1 : 0;
        await mysqlDb.query(`UPDATE event_quiz_attempts SET score_percentage=?, passed=?, completed_at=NOW(), updated_at=NOW() WHERE id=?`, [pct, passed, attemptId]);
        return res.json({ ok:true, attempt_id: attemptId, score: pct, passed: !!passed, total: qs.length, correct });
      } catch (e) {
        console.error('submit_event_quiz error', e);
        return res.status(500).json({ ok:false, error:'submit_event_quiz_failed' });
      }
    }

    if (toolName === 'get_user_profile') {
      // Fetch the authenticated user's profile from MySQL (name, email, plus basic extras)
      const email = (req.user && req.user.email) || null;
      if (!email) return res.status(400).json({ error: 'No email on token' });
      const rows = await mysqlDb.query(
        `SELECT id,name,email,created_at,updated_at FROM users WHERE email=? LIMIT 1`,
        [email]
      );
      if (!rows || rows.length === 0) return res.status(404).json({ error: 'Profile not found' });
      const u = rows[0];
      let extras = null;
      try {
        const d = await mysqlDb.query(
          `SELECT onboarding_step,avatar,ai_avatar,onboarding_completed_at FROM user_data WHERE user_id=? LIMIT 1`,
          [u.id]
        );
        if (d && d.length) extras = d[0];
      } catch (_) {}
      return res.json({ ok: true, profile: { id: u.id, name: u.name, email: u.email, created_at: u.created_at, updated_at: u.updated_at, ...(extras || {}) } });
    }

    return res.status(404).json({ error: 'Unknown tool', name: toolName });
  } catch (e) {
    console.error('Tool execute error:', e);
    res.status(500).json({ error: 'Tool execution failed', detail: e.message });
  }
});

// ====================================================================================================
// Section: Admin utilities (protected)
// ====================================================================================================
// Admin: delete memories for a user (or truncate all). Protected by ADMIN_TOKEN.
app.post('/tools/admin/delete_memories', async (req, res) => {
  try {
    const adminToken = process.env.ADMIN_TOKEN;
    const provided = req.headers['x-admin-token'] || (req.body && req.body.token);
    if (!adminToken) return res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
    if (!provided || provided !== adminToken) return res.status(403).json({ error: 'Forbidden' });

    const { userId, all } = req.body || {};
    if (all === true) {
      await query('TRUNCATE TABLE user_memory');
      return res.json({ ok: true, deleted: 'all' });
    }
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const result = await query('DELETE FROM user_memory WHERE user_id = $1', [userId]);
    return res.json({ ok: true, deleted: result.rowCount || 0 });
  } catch (e) {
    console.error('Admin delete memories error:', e);
    res.status(500).json({ error: 'Delete failed', detail: e.message });
  }
});

// ====================================================================================================
// Section: Static assets and HTML routes
// ====================================================================================================
// Serve node_modules for browser ESM imports (read-only)
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

// Serve the entire workspace statically so GLB and HTML can be loaded via HTTP
app.use(express.static(__dirname));

// Friendly routes for explicit login/signup pages
app.get('/login', (_req, res) => {
  return res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/signup', (_req, res) => {
  return res.sendFile(path.join(__dirname, 'signup.html'));
});

// Default route to open the companion page easily
app.get('/', (req, res) => {
  try {
    const token = (req.cookies && req.cookies.auth) || '';
    jwt.verify(token, process.env.JWT_SECRET);
    return res.sendFile(path.join(__dirname, 'compenion_ai.html'));
  } catch {
    return res.sendFile(path.join(__dirname, 'login.html'));
  }
});

// Lightweight demo webhook
app.post('/webhook', (req, res) => {
  const message = (req.body && req.body.message) || '';
  const reply = message ? `You said: ${message}` : 'Hello! I am listening.';
  res.json({ response: reply });
});

// ====================================================================================================
// Section: Summarization pipeline (finalization)
// - Builds cumulative summary, extracts atomic items, rebuilds digest
// ====================================================================================================
async function summarizeAndSaveSession(sessionId, userId) {
  console.log('[summary] summarizeAndSaveSession:start', { sessionId, userId });
  // 1) Prefer aggregated JSON from chat_message for this session
  let transcript = '';
  try {
    const agg = await query(
      `SELECT content FROM chat_message WHERE session_id = $1 AND ($2::uuid IS NULL OR user_id = $2) LIMIT 1`,
      [sessionId, userId || null]
    );
    const arr = agg.rows && agg.rows[0] && Array.isArray(agg.rows[0].content) ? agg.rows[0].content : null;
    if (arr && arr.length) {
      transcript = arr.map(m => `${m.role === 'model' ? 'Assistant' : 'User'}: ${String(m.text || '').trim()}`).join('\n');
    }
  } catch (_) {}
  // 1b) Fallback to Redis buffer, then message table rows if aggregated JSON is missing
  if (!transcript) {
    const redisItems = await getFullChat(sessionId);
    let convo = redisItems;
    if (!convo || convo.length === 0) {
      try {
        const dbItems = await query(
          `SELECT role, content, created_at FROM chat_message WHERE session_id = $1 ORDER BY created_at ASC`,
          [sessionId]
        );
        convo = dbItems.rows.map(r => ({ role: r.role, content: r.content, ts: new Date(r.created_at).getTime() }));
      } catch (_) { convo = []; }
    }
    if (!convo || convo.length === 0) return { saved: false, reason: 'no_conversation' };
    transcript = convo.map(item => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${String(item.content || '').trim()}`).join('\n');
  }
  // 1c) If still empty and userId is known, load latest conversation row by user
  if (!transcript && userId) {
    try {
      const latest = await query(
        `SELECT content FROM chat_message WHERE user_id = $1 ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
        [userId]
      );
      const arr = latest.rows && latest.rows[0] && Array.isArray(latest.rows[0].content) ? latest.rows[0].content : null;
      if (arr && arr.length) {
        transcript = arr.map(m => `${m.role === 'model' ? 'Assistant' : 'User'}: ${String(m.text || '').trim()}`).join('\n');
      }
    } catch (_) {}
  }
  console.log('[summary] transcript_ready', { sessionId, userId, length: transcript.length, preview: transcript.slice(0, 180) });

  // 3) Ask OpenAI for a cumulative summary: last N dated summaries + this transcript
  let priorSummaries = '';
  try {
    const hist = await query(
      `SELECT summary, created_at FROM chat_session_summary
         WHERE user_id = $1 AND summary IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 5`,
      [userId || null]
    );
    if (hist && hist.rows && hist.rows.length) {
      const nowMs = Date.now();
      priorSummaries = hist.rows.map((r, i) => {
        const ts = r.created_at ? new Date(r.created_at) : null;
        const iso = ts ? ts.toISOString().slice(0,10) : 'unknown-date';
        let age = '';
        try { if (ts) { const d = Math.floor((nowMs - ts.getTime())/86400000); age = ` (${d}d ago)`; } } catch(_) {}
        return `[${iso}] S${i+1}${age}: ${String(r.summary || '').trim()}`;
      }).join('\n\n');
    }
  } catch (_) {}
  const sys = 'You write an internal cumulative memory note for the assistant (not a reply to the user). Merge prior dated summaries (most recent first) with the current transcript into ONE coherent memory capturing ONLY durable items: facts, preferences, goals, progress, and open questions.\n\nRules:\n- Length: 150–300 words (~900–1,400 characters).\n- No greetings, no questions, do not address the user, no instructions.\n- Use ONLY information explicitly present in the provided transcript OR clearly repeated in the newest prior summaries. Do NOT infer or invent new details. If unsure, omit.\n- Prefer newest information when conflicts arise; drop the older.\n- Drop items older than ~90 days unless reaffirmed today or in the last 30 days.\n- De-duplicate paraphrases; keep the clearest single form.\n- Avoid sensitive personal topics (e.g., health/fitness) unless explicitly present in the transcript.\n- Ignore chit‑chat, filler, and tool/procedure meta.';
  const prompt = `${userId ? `User ID: ${userId}.` : ''}\n\nPrior dated summaries (most recent first; up to 5):\n${priorSummaries || '(none)'}\n\nCurrent conversation transcript:\n${transcript}\n\nWrite one cumulative memory now. Plain text only.`;
  const model = process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o';
  const completion = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: prompt }
    ],
    temperature: 0.3,
    max_tokens: 600
  });
  const summaryText = (completion.choices?.[0]?.message?.content || '').trim();
  if (!summaryText) return { saved: false, reason: 'summary_failed' };
  console.log('[summary] model_returned', { len: summaryText.length });

  // 4) Persist via UPSERT and return stored row
  const saved = await saveSessionSummary({ sessionId, userId, summary: summaryText });
  console.log('[summary] saved_row', { id: saved.id, sessionId: saved.session_id, userId: saved.user_id, updated_at: saved.updated_at });

  // 5) Extract atomic memory items via model and upsert; rebuild short digest
  try {
    const extractSys = 'Extract atomic user memory items as strict JSON. Source of truth is ONLY the provided transcript/summary. Do NOT invent, infer, or guess. Keep only stable facts, preferences, goals, progress, and open questions explicitly stated by the user. If none, return an empty list. Max 25 items total. No chit-chat. Schema: { items: [ { type:"fact|preference|goal|progress|open_question", statement:string, stability?:"short|med|long", pinned?:boolean } ] }.';
    const extractPrompt = `Input cumulative summary (may include prior info):\n${summaryText}\n\nReturn ONLY JSON with the schema.`;
    const extract = await openai.chat.completions.create({
      model: process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o',
      messages: [
        { role: 'system', content: extractSys },
        { role: 'user', content: extractPrompt }
      ],
      temperature: 0,
      max_tokens: 400
    });
    let items = [];
    try { items = JSON.parse(extract.choices?.[0]?.message?.content || '{}')?.items || []; } catch (_) { items = []; }
    // Lightweight hallucination guard: keep items that share content words with the transcript
    if (Array.isArray(items) && items.length) {
      const stop = new Set(['the','a','an','and','or','but','if','then','with','of','for','to','in','on','at','by','from','is','are','was','were','it','this','that','these','those','as','be','can','could','should','would','has','have','had','do','does','did','you','your','i','we','they','he','she']);
      const words = (s) => String(s||'').toLowerCase().replace(/[^a-z0-9\s]+/g,' ').split(/\s+/).filter(w => w && !stop.has(w) && w.length >= 4);
      const tset = new Set(words(transcript));
      const filtered = items.filter(it => {
        const toks = words(it.statement);
        // keep if any significant token appears in transcript
        return toks.some(w => tset.has(w));
      });
      if (filtered.length) await upsertUserMemoryItems(userId, filtered);
    }
  } catch (e) { try { console.warn('memory extract failed', e?.message || e); } catch (_) {} }

  try {
    const recents = await getRecentSummaries(userId, 12);
    const digestSys = 'Produce a 150–300 token rolling digest of the user\'s recent sessions. Emphasize changes and new developments. Keep only durable facts, active preferences, goals, current progress, and open questions. Prefer newest when conflicts occur. No greetings or questions.';
    const digestPrompt = recents && recents.length ? recents.map((t,i)=>`S${i+1}: ${t}`).join('\n\n') : '(none)';
    const dig = await openai.chat.completions.create({
      model: process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o',
      messages: [ { role: 'system', content: digestSys }, { role: 'user', content: digestPrompt } ],
      temperature: 0.2,
      max_tokens: 320
    });
    const digestText = (dig.choices?.[0]?.message?.content || '').trim();
    if (digestText) await setUserDigest(userId, digestText);
  } catch (e) { try { console.warn('digest build failed', e?.message || e); } catch (_) {} }

  return { saved: true, id: saved.id, summary: saved.summary };
}
// Keep-alive during active sessions (used by idle summarizer)
app.post('/sessions/heartbeat', authRequired, async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    await setSessionActivity(sessionId, req.user?.pgUserId);
    res.json({ ok: true });
  } catch (e) {
    console.error('heartbeat error', e);
    res.status(500).json({ error: 'heartbeat failed' });
  }
});

// Explicit session finalization (foreground or queued background)
app.post('/sessions/finalize', authRequired, async (req, res) => {
  try {
    let { sessionId, background } = req.body || {};
    // If the client couldn't pass a sessionId (e.g., unload beacons), fall back to the user's latest session
    if (!sessionId) {
      try {
        const row = await query(
          `SELECT id FROM chat_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [req.user?.pgUserId || null]
        );
        if (row && row.rows && row.rows[0]) sessionId = row.rows[0].id;
      } catch (_) {}
      if (!sessionId) return res.status(400).json({ error: 'sessionId required and no recent session found for user' });
    }
    const userId = req.user?.pgUserId || null;
    if (String(background).toLowerCase() === 'true' || background === true) {
      console.log('[summary] /sessions/finalize (bg) queued', { sessionId, userId });
      setImmediate(() => {
        summarizeAndSaveSession(sessionId, userId).catch((e) => {
          try { console.warn('finalize (bg) failed', e?.message || e); } catch (_) {}
        });
      });
      return res.json({ ok: true, queued: true });
    } else {
      console.log('[summary] /sessions/finalize invoked', { sessionId, userId });
      const result = await summarizeAndSaveSession(sessionId, userId);
      console.log('[summary] /sessions/finalize result', result);
      return res.json({ ok: true, ...result });
    }
  } catch (e) {
    console.error('finalize error', e);
    res.status(500).json({ error: 'finalize failed' });
  }
});

// ====================================================================================================
// Section: Idle summarizer
// - Finalizes sessions after inactivity with backoff on failure
// ====================================================================================================
// Idle summarizer (enabled by default; set ENABLE_IDLE_SUMMARIZER=false to disable)
if (String(process.env.ENABLE_IDLE_SUMMARIZER || 'true').toLowerCase() !== 'false') {
  // 60s default idle window
  const IDLE_MS = Math.max(60_000, Number(process.env.SESSION_IDLE_MS || 60_000));
  setInterval(async () => {
    try {
      await connectRedis();
      const now = Date.now();
      for await (const key of redis.scanIterator({ MATCH: 'chat:last_activity:*', COUNT: 100 })) {
        try {
          const tsStr = await redis.get(key);
          const ts = tsStr ? Number(tsStr) : 0;
          if (!ts || (now - ts) < IDLE_MS) continue;
          const sessionId = key.split(':').pop();
          // Skip if already summarized
          const existing = await query(
            `SELECT id FROM chat_session_summary WHERE session_id = $1 LIMIT 1`,
            [sessionId]
          );
          if (existing.rows && existing.rows[0]) { try { await redis.del(key); } catch (_) {} continue; }
          // Attempt to read userId from cookie mapping, else null
          let userId = null;
          try { userId = await redis.get(`chat:session_user:${sessionId}`); } catch (_) {}
          console.log('[summary] idle_finalizer running', { sessionId, userId });
          const result = await summarizeAndSaveSession(sessionId, userId);
          // Delete the idle key only on successful save; otherwise back off after a few failures
          if (result && result.saved) {
          await redis.del(key);
          } else {
            try {
              const failKey = `chat:last_activity_fail:${sessionId}`;
              const nStr = await redis.incr(failKey);
              const n = Number(nStr || 0);
              await redis.expire(failKey, 3600); // 1h window
              if (n >= 3) {
                // Give up for now to prevent hot loops; clear markers
                await redis.del(key);
                await redis.del(failKey);
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
    } catch (e) {
      console.error('idle summarizer error', e);
    }
  }, Math.max(15_000, Number(process.env.IDLE_SUMMARIZER_INTERVAL_MS || 30_000)));
}

// ====================================================================================================
// Section: Startup
// ====================================================================================================
const PORT = process.env.PORT || 4400;
app.listen(PORT, () => console.log(`Static server running at http://localhost:${PORT}`));
