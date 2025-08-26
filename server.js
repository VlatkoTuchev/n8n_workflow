const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

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