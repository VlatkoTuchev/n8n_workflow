const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const cors = require('cors');

const API = 'https://tavusapi.com/v2';
const API_KEY = 'b6e8a92c4e0f46468e56d19d3305d56e';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

app.post('/api/conversations', async (req, res) => {
  const r = await fetch(`${API}/conversations`, {
    method: 'POST',
    headers: {'Content-Type':'application/json','x-api-key': API_KEY},
    body: JSON.stringify(req.body)
  });
  const t = await r.text();
  res.status(r.status).send(t);
});

// Generic proxy: forwards any /api/* to Tavus v2 with API key
app.use('/api', async (req, res) => {
  const targetUrl = `${API}${req.originalUrl.replace(/^\/api/, '')}`;
  try {
    const r = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      },
      body: ['GET','HEAD','DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body)
    });
    const text = await r.text();
    res.status(r.status).send(text);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  const r = await fetch(`${API}/conversations/${req.params.id}`, {
    method: 'DELETE',
    headers: {'x-api-key': API_KEY}
  });
  const t = await r.text();
  res.status(r.status).send(t);
});

app.listen(4000, () => console.log('Proxy on http://localhost:4000'));