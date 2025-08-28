const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();
const { query } = require('./db');
const { redis, connectRedis, addChatTurn, getRecentChat } = require('./redis');
const {
  retrieveMemories,
  saveMemory,
  editMemory,
  setPreferredLanguage,
  readPreferredLanguage,
  addSpokenLanguage,
  createUser,
  createKb,
  kbAddText,
  retrieveKb,
  createChatSession
} = require('./retrieval');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const mysqlDb = require('./mysql');

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

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-10-21';

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
    console.log(`[realtime] ${_req.method} /realtime/token`);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
    const fetchImpl = global.fetch || (async (...args) => (await import('node-fetch')).default(...args));
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
        instructions: `You are a friendly assistant for user ${req.user?.pgUserId || 'unknown'}. Use tools to store and retrieve memories strictly for this user.`
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

app.post('/auth/logout', (req, res) => {
  res.clearCookie('auth'); res.json({ ok: true });
});

app.get('/me', authRequired, (req, res) => {
  res.json({ ok: true, ...req.user });
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

    // User memory
    if (toolName === 'retrieve_memories') {
      const { queryText, topK, kind } = args || {};
      if (!authedUserId || !queryText) return res.status(400).json({ error: 'userId and queryText are required' });
      const rows = await retrieveMemories({ userId: authedUserId, queryText, topK, kind });
      return res.json({ ok: true, results: rows });
    }

    if (toolName === 'save_memory') {
      const { kind, text, metadata } = args || {};
      if (!authedUserId || !kind || !text) return res.status(400).json({ error: 'userId, kind and text are required' });

      // If the payload is actually updating preferred_language, route to upsert logic instead of inserting duplicates
      const metaLang = metadata && typeof metadata === 'object' ? (metadata.preferred_language || metadata.preferredLanguage) : undefined;
      let textLang = undefined;
      try {
        const m = String(text || '').match(/preferred[_\s-]?language\s*[:=]\s*([A-Za-zÀ-ÖØ-öø-ÿ\- ]{2,30})/i);
        if (m && m[1]) textLang = m[1].trim();
      } catch (_) {}

      const inferredLang = String(metaLang || textLang || '').trim();
      if (inferredLang) {
        const out = await setPreferredLanguage({ userId, language: inferredLang });
        return res.json({ ok: true, id: out.id, upserted: 'preferred_language' });
      }

      const out = await saveMemory({ userId: authedUserId, kind, text, metadata });
      return res.json({ ok: true, id: out.id });
    }

    if (toolName === 'edit_memory') {
      const { id, text, kind, metadata } = args || {};
      if (!id || !authedUserId) return res.status(400).json({ error: 'id and userId are required' });
      const out = await editMemory({ id, userId: authedUserId, text, kind, metadata });
      return res.json({ ok: true, id: out.id });
    }

    if (toolName === 'set_preferred_language' || toolName === 'setPreferredLanguage') {
      const { language } = args || {};
      if (!authedUserId || !language) return res.status(400).json({ error: 'userId and language are required' });
      const out = await setPreferredLanguage({ userId: authedUserId, language });
      return res.json({ ok: true, id: out.id });
    }

    if (toolName === 'read_preferred_language' || toolName === 'readPreferredLanguage') {
      if (!authedUserId) return res.status(400).json({ error: 'userId is required' });
      const out = await readPreferredLanguage({ userId: authedUserId });
      return res.json({ ok: true, language: out.language });
    }

    if (toolName === 'add_spoken_language' || toolName === 'addSpokenLanguage') {
      const { language } = args || {};
      if (!authedUserId || !language) return res.status(400).json({ error: 'userId and language are required' });
      const out = await addSpokenLanguage({ userId: authedUserId, language });
      return res.json({ ok: true, id: out.id });
    }

    if (toolName === 'add_chat_turn' || toolName === 'addChatTurn') {
      const { sessionId, role, content } = args || {};
      if (!sessionId || !role || !content) return res.status(400).json({ error: 'sessionId, role, content required' });
      await addChatTurn(sessionId, role, content);
      return res.json({ ok: true });
    }

    if (toolName === 'get_recent_chat' || toolName === 'getRecentChat') {
      const { sessionId, n } = args || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
      const items = await getRecentChat(sessionId, n || 20);
      return res.json({ ok: true, items });
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

const PORT = process.env.PORT || 4400;
app.listen(PORT, () => console.log(`Static server running at http://localhost:${PORT}`));