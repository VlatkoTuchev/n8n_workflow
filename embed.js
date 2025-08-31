// ====================================================================================================
// Section: OpenAI embeddings client
// - Provides embedText() used by KB storage and retrieval
// ====================================================================================================
const OpenAI = require('openai');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const DEFAULT_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';

// Generate embeddings for a string or array of strings
async function embedText(text) {
  const input = Array.isArray(text) ? text : [text];
  const resp = await client.embeddings.create({ model: DEFAULT_EMBEDDING_MODEL, input });
  return resp.data.map((d) => d.embedding);
}

module.exports = { embedText };
