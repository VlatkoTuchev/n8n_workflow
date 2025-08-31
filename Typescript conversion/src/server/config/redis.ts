import { createClient } from 'redis';
import { env } from '../env';

export const redis = createClient({ url: env.REDIS_URL });
let ready = false;

redis.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Redis error:', err);
});

export async function connectRedis() {
  if (!ready) {
    await redis.connect();
    ready = true;
  }
  return redis;
}


