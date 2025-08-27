const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

async function embedText(text) {
  const input = Array.isArray(text) ? text : [text];
  const resp = await client.embeddings.create({ model: DEFAULT_EMBEDDING_MODEL, input });
  return resp.data.map((d) => d.embedding);
}

module.exports = { embedText };
