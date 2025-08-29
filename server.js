const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();
const { query } = require('./db');
const { redis, connectRedis, addChatTurn, getRecentChat, getFullChat, setSessionActivity } = require('./redis');
const {
  createUser,
  createKb,
  kbAddText,
  retrieveKb,
  createChatSession,
  addChatMessage,
  getRecentMessages,
  saveSessionSummary,
  readLatestSummary,
  readPreferredLanguagePg,
  setPreferredLanguagePg
} = require('./retrieval');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const mysqlDb = require('./mysql');
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Append user/model turns to chat_session.conversation (JSON array) in realtime
async function updateSessionConversation(sessionId, role, content) {
  try {
    if (!sessionId || !content) return;
    const res = await query(`SELECT conversation FROM chat_session WHERE id = $1`, [sessionId]);
    let convo = [];
    try { convo = Array.isArray(res.rows?.[0]?.conversation) ? res.rows[0].conversation : JSON.parse(JSON.stringify(res.rows?.[0]?.conversation || [])); } catch (_) { convo = []; }
    const nowIso = new Date().toISOString();
    if (role === 'user') {
      convo.push({ user: String(content), model: null, created: nowIso });
    } else if (role === 'assistant') {
      let updated = false;
      for (let i = convo.length - 1; i >= 0; i--) {
        if (convo[i] && (convo[i].model == null)) { convo[i].model = String(content); updated = true; break; }
      }
      if (!updated) { convo.push({ user: null, model: String(content), created: nowIso }); }
    } else {
      convo.push({ user: null, model: String(content), created: nowIso });
    }
    const maxPairs = Math.max(1, Number(process.env.CONVERSATION_MAX_PAIRS || 200));
    if (convo.length > maxPairs) { convo = convo.slice(convo.length - maxPairs); }
    await query(`UPDATE chat_session SET conversation = $2 WHERE id = $1`, [sessionId, JSON.stringify(convo)]);
  } catch (_) { /* best-effort; do not block tool path */ }
}

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

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: ['application/sdp', 'text/plain'] }));
app.use(cookieParser());

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}
function authRequired(req, res, next) {
  const token = (req.cookies && req.cookies.auth) || (req.headers.authorization || '').replace(/^Bearer\s+/,'');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); return next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

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

    const upstream = await fetchImpl(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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
    res.send(answerSdp);
  } catch (err) {
    console.error('Realtime SDP proxy error:', err);
    res.status(500).send('Realtime SDP proxy error');
  }
});

// Mint a fresh ephemeral token using the permanent API key
app.all('/realtime/token', authRequired, async (req, res) => {
  try {
    console.log(`[realtime] ${req.method} /realtime/token`);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
    const fetchImpl = global.fetch || (async (...args) => (await import('node-fetch')).default(...args));
    // Build compact user context for instructions (no prior-session continuation)
    let contextSummary = '';
    try { contextSummary = await composeUserContextSummary(req.user?.email || null, req.user?.pgUserId || null); } catch (_) {}
    const baseInstructions = `Role & mission: You are a warm, upbeat learning companion and coach for user ${req.user?.pgUserId || 'unknown'}. Help the learner feel they belong, build confidence, and make steady progress.
Session start: Treat every new session as fresh. Do not continue a prior conversation. On the first response, greet the user by preferred name, acknowledge their context briefly, and ask exactly one open question. Do not say “welcome back” unless the user indicates a return.
Tone & style: Warm, non-judgmental, concise for voice. Offer choices; ask permission before advice. Use process praise; normalize struggle.
Conversation loop:
  1) Connect: Ask one open question; reflect and affirm.
  2) Plan: Offer 2–3 options; use Elicit–Provide–Elicit for tips.
  3) Practice: Small retrieval/practice; increase difficulty gradually.
  4) Feedback: Specific, process-focused; high standards + assurance.
  5) Reflect: What worked, what was tricky, what next.
  6) Next step: Propose a micro-goal and optional spaced review.
Personalization: Use the context below; prefer the user's language when present; request personal details only when relevant and with permission.
Question cadence: One open question per turn; keep turns 2–4 sentences; use examples; avoid jargon unless the learner prefers it.
Safety: Avoid probing sensitive info; be culturally respectful.
Do: invite choice, affirm effort, normalize struggle, summarize progress. Don't: lecture long or stack multiple questions.
Exit: Summarize wins + next tiny action; confirm a follow-up.`;
    const insParts = [baseInstructions];
    if (contextSummary) insParts.push(`Context for personalization:\n${contextSummary}`);
    let instructions = insParts.join('\n\n');
    const MAX_INS = 4000; if (instructions.length > MAX_INS) instructions = instructions.slice(0, MAX_INS - 3) + '...';

    // Optional debug log of what we inject (redacted/trimmed)
    try {
      const envVal = String(process.env.DEBUG_CONTEXT_LOG || '').toLowerCase();
      const dbgEnv = ['true','1','yes','on','full','all'].includes(envVal);
      const dbgQueryStr = String(req.query?.debug || '').toLowerCase();
      const dbgQuery = ['true','1','yes','on','full','all','raw'].includes(dbgQueryStr);
      const full = ['full','all','raw'].includes(envVal) || ['full','all','raw'].includes(dbgQueryStr);
      if (dbgEnv || dbgQuery) {
        const preview = (s, n=800) => (s ? String(s).slice(0, n) : '');
        console.log('================ [realtime.token context] ================');
        console.log('email:', req.user?.email || null);
        console.log('contextSummary.len:', (contextSummary || '').length);
        console.log(full ? 'contextSummary.full:' : 'contextSummary.preview:', full ? (contextSummary || '') : preview(contextSummary));
        console.log('instructions.len:', (instructions || '').length);
        console.log(full ? 'instructions.full:' : 'instructions.preview:', full ? (instructions || '') : preview(instructions, 1200));
        console.log('==========================================================');
      }
    } catch (_) {}

    const upstream = await fetchImpl('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: JSON.stringify({
        model,
        modalities: ['audio', 'text'],
        voice: 'alloy',
        // Provide soft context tying the realtime agent to the authenticated user
        instructions
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(data);
    const token = data?.client_secret?.value;
    if (!token) return res.status(500).json({ error: 'No client token in response' });
    res.json({ token });
  } catch (err) {
    console.error('Token endpoint error:', err);
    res.status(500).json({ error: 'Token endpoint error' });
  }
});

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

// Enriched profile from Postgres mirror tables (via view or direct joins)
app.get('/user/profile_enriched', authRequired, async (req, res) => {
  try {
    const email = req.user && req.user.email;
    if (!email) return res.status(400).json({ error: 'No email on token' });
    // Prefer a view if it exists; otherwise fall back to a safe join
    let row = null;
    try {
      const r = await query(
        `SELECT * FROM user_profile_enriched WHERE email = $1 LIMIT 1`,
        [email]
      );
      row = (r && r.rows && r.rows[0]) || null;
    } catch (_) {}
    if (!row) {
      const r2 = await query(
        `SELECT u.id, u.name, u.email, u.updated_at,
                ud.avatar, ud.onboarding_step
           FROM user_mysql_mirror u
      LEFT JOIN user_data_mysql_mirror ud ON ud.user_id = u.id
          WHERE u.email = $1
          LIMIT 1`,
        [email]
      );
      row = (r2 && r2.rows && r2.rows[0]) || null;
    }
    if (!row) return res.status(404).json({ error: 'Profile not found' });
    return res.json({ ok: true, profile: row });
  } catch (e) {
    console.error('profile_enriched error', e);
    res.status(500).json({ error: 'profile_enriched failed' });
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

// Tool execution endpoint (user memory + KB + preferences)
app.post('/tools/execute', authRequired, async (req, res) => {
  try {
    const { name, arguments: args } = req.body || {};
    const toolName = String(name || '').trim();
    if (!toolName) return res.status(400).json({ error: 'Missing tool name' });
    const authedUserId = (req.user && req.user.pgUserId) || null;
    
    // Lightweight observability to troubleshoot client → server tool calls
    try { console.log('[tools/execute]', toolName, Object.keys(args || {})); } catch (_) {}

    // Users
    if (toolName === 'create_user') {
      // Identity is provisioned at register/login; just return the authenticated id
      if (!authedUserId) return res.status(401).json({ error: 'Unauthorized' });
      return res.json({ ok: true, id: authedUserId });
    }

    // Knowledge base
    if (toolName === 'create_kb') {
      const { ownerUserId, name: kbName, visibility } = args || {};
      if (!kbName) return res.status(400).json({ error: 'name is required' });
      const out = await createKb({ ownerUserId, name: kbName, visibility });
      return res.json({ ok: true, id: out.id });
    }

    if (toolName === 'kb_add_text') {
      const { kbId, title, text, mimeType, metadata } = args || {};
      if (!kbId || !text) return res.status(400).json({ error: 'kbId and text are required' });
      const out = await kbAddText({ kbId, title, text, mimeType, metadata });
      return res.json({ ok: true, ...out });
    }

    if (toolName === 'retrieve_kb') {
      const { kbId, queryText, topK } = args || {};
      if (!kbId || !queryText) return res.status(400).json({ error: 'kbId and queryText are required' });
      const rows = await retrieveKb({ kbId, queryText, topK });
      return res.json({ ok: true, results: rows });
    }

    if (toolName === 'create_chat_session') {
      const { userId, title } = args || {};
      const out = await createChatSession({ userId, title });
      return res.json({ ok: true, id: out.id });
    }

    if (toolName === 'add_chat_turn' || toolName === 'addChatTurn') {
      const { sessionId, role, content } = args || {};
      if (!sessionId || !role || !content) return res.status(400).json({ error: 'sessionId, role, content required' });
      await addChatTurn(sessionId, role, content);
      try {
        let effUserId = authedUserId || null;
        if (!effUserId) {
          try {
            const r = await query(`SELECT user_id FROM chat_session WHERE id = $1`, [sessionId]);
            if (r.rows && r.rows[0] && r.rows[0].user_id) effUserId = r.rows[0].user_id;
          } catch (_) {}
        }
        await addChatMessage({ sessionId, userId: effUserId, role, content });
      } catch (e) {
        try { console.error('[add_chat_message error]', e && e.message ? e.message : e); } catch (_) {}
      }
      try { await updateSessionConversation(sessionId, String(role || '').toLowerCase(), content); } catch (_) {}
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
      const { sessionId, summary, nextPrompt, use_model, auto, from_messages } = args || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      // If explicitly requested (or summary omitted), summarize from chat_message via model
      if (use_model === true || auto === true || from_messages === true || !summary) {
        console.log('[summary] save_session_summary→summarizeAndSaveSession', { sessionId, user: authedUserId });
        const result = await summarizeAndSaveSession(sessionId, authedUserId);
        return res.json({ ok: true, ...result });
      }
      console.log('[summary] saving raw summary for session', sessionId, 'user', authedUserId);
      const out = await saveSessionSummary({ sessionId, userId: authedUserId, summary, nextPrompt });
      console.log('[summary] saved id', out.id);
      return res.json({ ok: true, id: out.id });
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

    if (toolName === 'get_user_profile_enriched') {
      const email = (req.user && req.user.email) || null;
      if (!email) return res.status(400).json({ error: 'No email on token' });
      let row = null;
      try {
        const r = await query(`SELECT * FROM user_profile_enriched WHERE email = $1 LIMIT 1`, [email]);
        row = (r && r.rows && r.rows[0]) || null;
      } catch (_) {}
      if (!row) {
        const r2 = await query(
          `SELECT u.id, u.name, u.email, u.updated_at,
                  ud.avatar, ud.onboarding_step
             FROM user_mysql_mirror u
        LEFT JOIN user_data_mysql_mirror ud ON ud.user_id = u.id
            WHERE u.email = $1
            LIMIT 1`,
          [email]
        );
        row = (r2 && r2.rows && r2.rows[0]) || null;
      }
      if (!row) return res.status(404).json({ error: 'Profile not found' });
      return res.json({ ok: true, profile: row });
    }

    return res.status(404).json({ error: 'Unknown tool', name: toolName });
  } catch (e) {
    console.error('Tool execute error:', e);
    res.status(500).json({ error: 'Tool execution failed', detail: e.message });
  }
});

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

app.post('/webhook', (req, res) => {
  const message = (req.body && req.body.message) || '';
  const reply = message ? `You said: ${message}` : 'Hello! I am listening.';
  res.json({ response: reply });
});

// ---- Session activity and finalization ----
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

  // 3) Ask OpenAI for a concise summary and a Next: line
  const sys = 'You write concise narrative session summaries (5–8 sentences). End with a final line that begins with "Next:" followed by one short sentence proposing how to continue next time. Do not include bullet points or lists.';
  const prompt = `Summarize the following conversation. ${userId ? `User ID: ${userId}.` : ''}\n\nConversation:\n${transcript}`;
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
  let nextPrompt = null;
  const m = summaryText.match(/\bNext:\s*(.+)$/mi);
  if (m) nextPrompt = m[1].trim();
  console.log('[summary] model_returned', { len: summaryText.length, nextPrompt });

  // 4) Persist via UPSERT and return stored row
  const saved = await saveSessionSummary({ sessionId, userId, summary: summaryText, nextPrompt });
  console.log('[summary] saved_row', { id: saved.id, sessionId: saved.session_id, userId: saved.user_id, updated_at: saved.updated_at });
  return { saved: true, id: saved.id, summary: saved.summary, nextPrompt: saved.next_prompt };
}
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
          await summarizeAndSaveSession(sessionId, userId);
          // Mark as processed to avoid repeats soon
          await redis.del(key);
        } catch (_) {}
      }
    } catch (e) {
      console.error('idle summarizer error', e);
    }
  }, Math.max(15_000, Number(process.env.IDLE_SUMMARIZER_INTERVAL_MS || 30_000)));
}

const PORT = process.env.PORT || 4400;
app.listen(PORT, () => console.log(`Static server running at http://localhost:${PORT}`));