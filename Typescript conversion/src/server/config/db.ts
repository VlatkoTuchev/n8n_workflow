import { Pool } from 'pg';
import { env } from '../env';

export const pg = new Pool({ connectionString: env.DATABASE_URL });

pg.on('connect', (client) => {
  const tz = 'Europe/Skopje';
  client.query(`SET TIME ZONE '${tz}'`).catch(() => {});
});

export async function query<T = any>(text: string, params?: any[]) {
  const client = await pg.connect();
  try {
    const res = await client.query<T>(text, params);
    return res;
  } finally {
    client.release();
  }
}


