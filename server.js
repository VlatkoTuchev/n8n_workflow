const express = require('express');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ type: ['application/sdp', 'text/plain'] }));

// Realtime WebRTC SDP exchange proxy to OpenAI (place before static routing)
// Accept SDP over POST; respond with OpenAI's SDP answer
app.all('/realtime/sdp', async (req, res) => {
  try {
    console.log(`[realtime] ${req.method} /realtime/sdp content-type=${req.headers['content-type']}`);
    const clientOfferSdp = typeof req.body === 'string' ? req.body : (req.body && req.body.toString ? req.body.toString() : '');
    if (!clientOfferSdp) {
      return res.status(400).send('Missing SDP');
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).send('OPENAI_API_KEY not configured');
    }

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-10-21';

    const fetchImpl = global.fetch || (async (...args) => (await import('node-fetch')).default(...args));

    const upstream = await fetchImpl(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
        'Accept': 'application/sdp',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: clientOfferSdp
    });

    const answerSdp = await upstream.text();
    if (!upstream.ok) {
      console.error('OpenAI Realtime error:', upstream.status, answerSdp);
      res.status(upstream.status).set('Content-Type', 'text/plain').send(answerSdp || 'Upstream error');
      return;
    }
    res.set('Content-Type', 'application/sdp');
    res.send(answerSdp);
  } catch (err) {
    console.error('Realtime SDP proxy error:', err);
    res.status(500).send('Realtime SDP proxy error');
  }
});

// Mint a fresh ephemeral token using the permanent API key
app.all('/realtime/token', async (_req, res) => {
  try {
    console.log(`[realtime] ${_req.method} /realtime/token`);
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
    const fetchImpl = global.fetch || (async (...args) => (await import('node-fetch')).default(...args));
    const upstream = await fetchImpl('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1'
      },
      body: JSON.stringify({
        model,
        modalities: ['audio', 'text'],
        voice: 'alloy',
        instructions: 'You are a friendly assistant.'
      })
    });
    const data = await upstream.json();
    if (!upstream.ok) return res.status(upstream.status).json(data);
    const token = data?.client_secret?.value;
    if (!token) return res.status(500).json({ error: 'No client token in response' });
    res.json({ token });
  } catch (err) {
    console.error('Token endpoint error:', err);
    res.status(500).json({ error: 'Token endpoint error' });
  }
});

// Serve node_modules for browser ESM imports (read-only)
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

// Serve the entire workspace statically so GLB and HTML can be loaded via HTTP
app.use(express.static(__dirname));

// Default route to open the companion page easily
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'compenion_ai.html'));
});

// Simple local webhook fallback to make Jarvis respond even without n8n configured
app.post('/webhook', (req, res) => {
  const message = (req.body && req.body.message) || '';
  const reply = message ? `You said: ${message}` : 'Hello! I am listening.';
  res.json({ response: reply });
});


const PORT = process.env.PORT || 4400;
app.listen(PORT, () => console.log(`Static server running at http://localhost:${PORT}`));