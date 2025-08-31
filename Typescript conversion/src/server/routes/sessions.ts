import { Router } from 'express';
import { z } from 'zod';
import { summarizeAndSaveSession } from '../services/summarization';

const router = Router();

router.post('/sessions/heartbeat', (req, res) => {
  // For now: accept and return ok (placeholder for presence tracking)
  res.json({ ok: true, ts: new Date().toISOString() });
});

router.post('/sessions/finalize', async (req, res) => {
  try {
    const body = z.object({ sessionId: z.string(), userId: z.string().nullable().optional() }).parse(req.body || {});
    const out = await summarizeAndSaveSession(body.sessionId, body.userId ?? null);
    res.json({ ok: true, ...out });
  } catch (e: any) {
    res.status(400).json({ error: 'bad_request', detail: e?.message });
  }
});

export default router;


