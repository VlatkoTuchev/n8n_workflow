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

module.exports = { redis, connectRedis };
