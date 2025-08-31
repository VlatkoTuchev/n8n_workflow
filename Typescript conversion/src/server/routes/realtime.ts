import { Router } from 'express';
import fetch from 'node-fetch';
import { env } from '../env';
import { REALTIME_MODEL } from '../config/openai';
import { BASE_INSTRUCTIONS, CONTINUITY_RULES } from '../agents/prompts';
import { buildInstructions } from '../agents/instructions';

const router = Router();

// Mint ephemeral session token via OpenAI Realtime Sessions API
router.all('/realtime/token', async (_req, res) => {
  try {
    const tz = 'Europe/Skopje';
    const nowIso = new Date().toISOString();
    const instructions = buildInstructions({
      base: BASE_INSTRUCTIONS,
      continuity: CONTINUITY_RULES,
      personalization: '',
      workingPack: '',
      recentSummaries: '',
      recentConvos: '',
      agentName: 'Nova',
      agentStyle: 'friendly, energetic, concise',
      preferredLanguage: null,
      tz,
      nowIso,
    });
    const upstream = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: JSON.stringify({
        model: REALTIME_MODEL,
        modalities: ['audio','text'],
        instructions,
        voice: 'alloy',
      }),
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(data);
    const token = (data as any)?.client_secret?.value;
    if (!token) return res.status(500).json({ error: 'No client token' });
    res.json({ token, instructions, preferredVoice: 'alloy' });
  } catch (e: any) {
    res.status(500).json({ error: 'token_failed', detail: e?.message });
  }
});

// SDP proxy
router.post('/realtime/sdp', async (req, res) => {
  try {
    const clientOfferSdp = typeof req.body === 'string' ? req.body : '';
    if (!clientOfferSdp) return res.status(400).send('Missing SDP');
    const authKey = (req.headers['x-openai-session-token'] as string)?.trim() || env.OPENAI_API_KEY;
    const upstream = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${authKey}`,
        'Content-Type': 'application/sdp',
        Accept: 'application/sdp',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: clientOfferSdp,
    });
    const answerSdp = await upstream.text();
    if (!upstream.ok) return res.status(upstream.status).set('Content-Type','text/plain').send(answerSdp || 'Upstream error');
    res.set('Content-Type', 'application/sdp');
    res.set('X-Session-Token-Used', req.headers['x-openai-session-token'] ? 'true' : 'false');
    res.send(answerSdp);
  } catch (e: any) {
    res.status(500).send('SDP proxy error');
  }
});

export default router;


