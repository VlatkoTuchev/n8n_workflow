import { Router } from 'express';
import { z } from 'zod';
import { selectTopKUserMemory } from '../services/memory';
import { readPreferredLanguage, readAgentSettings } from '../services/preferences';

const router = Router();

router.get('/user/profile', (_req, res) => res.status(501).json({ error: 'not_implemented' }));
router.get('/user/context', async (req, res) => {
  try {
    const q = z.object({ userId: z.string().optional() }).parse(req.query);
    const userId = q.userId || '';
    const memory = userId ? await selectTopKUserMemory(userId) : { facts: [], preferences: [], goals: [], progress: [], open_questions: [] };
    const lang = userId ? await readPreferredLanguage(userId) : { language: null };
    const settings = userId ? await readAgentSettings(userId) : { name: 'Nova', voice: 'alloy', style: 'friendly' };
    res.json({ ok: true, memory, language: lang.language, settings });
  } catch (e: any) {
    res.status(400).json({ error: 'bad_request', detail: e?.message });
  }
});

export default router;


