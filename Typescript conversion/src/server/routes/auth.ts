import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { mysqlQuery } from '../config/mysql';
import { query } from '../config/db';

const router = Router();

function signToken(payload: any) {
  const secret = process.env.JWT_SECRET || 'dev_secret_change_me';
  return (jwt as any).sign(payload, secret, { expiresIn: '7d' });
}

router.post('/auth/register', async (req: Request, res: Response) => {
  try {
    const { name, email, password, phone } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
    const hash = await bcrypt.hash(String(password), 10);

    // Ensure Postgres app_user exists (simple upsert)
    const created = await query<{ id: string }>(
      `INSERT INTO app_user (email) VALUES ($1)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`,
      [email]
    );
    const pgUserId = (created.rows as any)[0].id as string;

    // Upsert into MySQL users and registrants
    await mysqlQuery(
      `INSERT INTO users (name,email,password,created_at,updated_at)
       VALUES (?,?,?,?,NOW())
       ON DUPLICATE KEY UPDATE name=VALUES(name), password=VALUES(password), updated_at=NOW()`,
      [name, email, hash, new Date()]
    );
    const reg = await mysqlQuery<any>(`SELECT id, additional_info FROM registrants WHERE email=? LIMIT 1`, [email]);
    if (reg.length === 0) {
      await mysqlQuery(
        `INSERT INTO registrants (name,email,phone,additional_info,has_registered,created_at,updated_at)
         VALUES (?,?,?,?,1,NOW(),NOW())`,
        [name, email, phone || null, JSON.stringify({ source: 'ai_companion', pg_user_id: pgUserId })]
      );
    } else {
      await mysqlQuery(
        `UPDATE registrants SET name=?, phone=?, additional_info=JSON_SET(COALESCE(additional_info,'{}'),'$.pg_user_id', ?), updated_at=NOW() WHERE id=?`,
        [name, phone || null, pgUserId, (reg as any)[0].id]
      );
    }

    const token = signToken({ email, pgUserId });
    const isProd = String(process.env.NODE_ENV).toLowerCase() === 'production';
    res.cookie('auth', token, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 7*24*3600*1000 });
    return res.json({ ok: true, email, pgUserId });
  } catch (e: any) {
    console.error('register error', e?.message || e);
    return res.status(500).json({ error: 'registration failed' });
  }
});

router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const users = await mysqlQuery<any>(`SELECT id,name,email,password FROM users WHERE email=? LIMIT 1`, [email]);
    if (!users.length) return res.status(401).json({ error: 'invalid credentials' });
    const ok = await bcrypt.compare(String(password), users[0].password || '');
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });

    // Link to Postgres user id via registrants.additional_info.pg_user_id, create if missing
    let pgUserId: string | null = null;
    const reg = await mysqlQuery<any>(`SELECT id, additional_info FROM registrants WHERE email=? LIMIT 1`, [email]);
    if (reg.length && (reg[0].additional_info as any)?.pg_user_id) {
      pgUserId = (reg[0].additional_info as any).pg_user_id;
    } else {
      const created = await query<{ id: string }>(
        `INSERT INTO app_user (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email
         RETURNING id`,
        [email]
      );
      pgUserId = (created.rows as any)[0].id as string;
      if (reg.length) {
        await mysqlQuery(
          `UPDATE registrants SET additional_info=JSON_SET(COALESCE(additional_info,'{}'),'$.pg_user_id', ?), updated_at=NOW() WHERE id=?`,
          [pgUserId, reg[0].id]
        );
      } else {
        await mysqlQuery(
          `INSERT INTO registrants (name,email,additional_info,has_registered,created_at,updated_at)
           VALUES (?,?,JSON_OBJECT('pg_user_id', ?),1,NOW(),NOW())`,
          [String(email).split('@')[0], email, pgUserId]
        );
      }
    }

    const token = signToken({ email, pgUserId });
    const isProd = String(process.env.NODE_ENV).toLowerCase() === 'production';
    res.cookie('auth', token, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 7*24*3600*1000 });
    return res.json({ ok: true, email, pgUserId });
  } catch (e: any) {
    console.error('login error', e?.message || e);
    return res.status(500).json({ error: 'login failed' });
  }
});
router.post('/auth/logout', (_req, res) => res.json({ ok: true }));
router.get('/me', (_req, res) => res.json({ ok: true }));

export default router;


