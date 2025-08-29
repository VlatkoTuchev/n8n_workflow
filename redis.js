const { createClient } = require('redis');

const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', (err) => console.error('Redis error:', err));

let connected = false;
async function connectRedis() {
  if (!connected) {
    await redis.connect();
    connected = true;
  }
  return redis;
}

async function addChatTurn(sessionId, role, content) {
  await connectRedis();
  const maxItems = Math.max(1, Number(process.env.CHAT_BUFFER_MAX || 500));
  const ttlSeconds = Math.max(60, Number(process.env.CHAT_BUFFER_TTL_SECONDS || 24 * 60 * 60));
  await redis.rPush(`chat:${sessionId}`, JSON.stringify({ role, content, ts: Date.now() }));
  await redis.lTrim(`chat:${sessionId}`, -maxItems, -1);
  await redis.expire(`chat:${sessionId}`, ttlSeconds);
  // Touch last-activity with same TTL for idle detection
  try {
    await redis.set(`chat:last_activity:${sessionId}`, String(Date.now()), { EX: ttlSeconds });
  } catch (_) {}
}

async function getRecentChat(sessionId, n = 20) {
  await connectRedis();
  const arr = await redis.lRange(`chat:${sessionId}`, -n, -1);
  return arr.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

async function getFullChat(sessionId) {
  await connectRedis();
  const arr = await redis.lRange(`chat:${sessionId}`, 0, -1);
  return arr.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

async function setSessionActivity(sessionId, userId) {
  await connectRedis();
  const ttlSeconds = Math.max(60, Number(process.env.CHAT_BUFFER_TTL_SECONDS || 24 * 60 * 60));
  await redis.set(`chat:last_activity:${sessionId}`, String(Date.now()), { EX: ttlSeconds });
  if (userId) {
    await redis.set(`chat:session_user:${sessionId}`, String(userId), { EX: ttlSeconds });
  }
}

async function getSessionActivity(sessionId) {
  await connectRedis();
  const ts = await redis.get(`chat:last_activity:${sessionId}`);
  return ts ? Number(ts) : null;
}

module.exports = { redis, connectRedis, addChatTurn, getRecentChat, getFullChat, setSessionActivity, getSessionActivity };