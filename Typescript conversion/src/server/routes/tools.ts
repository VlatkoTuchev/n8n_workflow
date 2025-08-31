import { Router } from 'express';
import { z } from 'zod';
import { recommendCourses, listCourses } from '../services/courses';
import { createChatSession, addChatMessage } from '../services/chat';
import { readPreferredLanguage, setPreferredLanguage, readAgentSettings, setAgentSettings } from '../services/preferences';
import { summarizeAndSaveSession } from '../services/summarization';

const router = Router();

const bodySchema = z.object({ name: z.string(), arguments: z.any().optional() });

router.post('/tools/execute', async (req, res) => {
  try {
    const { name, arguments: args } = bodySchema.parse(req.body || {});
    switch (name) {
      case 'create_chat_session': {
        const title = (args && args.title) ? String(args.title) : 'WebRTC Session';
        const out = await createChatSession(null, title);
        return res.json({ ok: true, id: out.id });
      }
      case 'add_chat_turn': {
        const sch = z.object({ sessionId: z.string(), role: z.string(), content: z.string() });
        const a = sch.parse(args || {});
        await addChatMessage({ sessionId: a.sessionId, userId: null, role: a.role as any, content: a.content });
        return res.json({ ok: true });
      }
      case 'list_courses': {
        const items = await listCourses();
        return res.json({ ok: true, items });
      }
      case 'recommend_courses': {
        const sch = z.object({ limit: z.number().optional(), days_ahead: z.number().optional() });
        const a = sch.parse(args || {});
        const recommended = await recommendCourses(a.limit, a.days_ahead);
        return res.json({ ok: true, recommended });
      }
      case 'read_preferred_language': {
        const sch = z.object({ userId: z.string() });
        const a = sch.parse(args || {});
        const out = await readPreferredLanguage(a.userId);
        return res.json({ ok: true, language: out.language });
      }
      case 'set_preferred_language': {
        const sch = z.object({ userId: z.string(), language: z.string() });
        const a = sch.parse(args || {});
        await setPreferredLanguage(a.userId, a.language);
        return res.json({ ok: true });
      }
      case 'read_agent_settings': {
        const sch = z.object({ userId: z.string() });
        const a = sch.parse(args || {});
        const out = await readAgentSettings(a.userId);
        return res.json({ ok: true, ...out });
      }
      case 'set_agent_settings': {
        const sch = z.object({ userId: z.string(), name: z.string().optional(), voice: z.string().optional(), style: z.string().optional() });
        const a = sch.parse(args || {});
        await setAgentSettings(a.userId, { name: a.name, voice: a.voice, style: a.style });
        return res.json({ ok: true });
      }
      case 'summarize_session':
      case 'finalize_session': {
        const sch = z.object({ sessionId: z.string(), userId: z.string().nullable().optional() });
        const a = sch.parse(args || {});
        const out = await summarizeAndSaveSession(a.sessionId, a.userId ?? null);
        return res.json({ ok: true, ...out });
      }
      default:
        return res.status(404).json({ error: 'Unknown tool', name });
    }
  } catch (e: any) {
    return res.status(400).json({ error: 'bad_request', detail: e?.message });
  }
});

export default router;


