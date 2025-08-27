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
  await redis.rPush(`chat:${sessionId}`, JSON.stringify({ role, content, ts: Date.now() }));
  await redis.lTrim(`chat:${sessionId}`, -20, -1);
  await redis.expire(`chat:${sessionId}`, 60 * 60);
}

async function getRecentChat(sessionId, n = 20) {
  await connectRedis();
  const arr = await redis.lRange(`chat:${sessionId}`, -n, -1);
  return arr.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

module.exports = { redis, connectRedis, addChatTurn, getRecentChat };