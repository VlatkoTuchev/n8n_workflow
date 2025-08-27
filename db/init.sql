CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS vector;

-- Core identities
CREATE TABLE IF NOT EXISTS app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  title text,
  created_at timestamptz DEFAULT now()
);

-- Personal long-term memory
CREATE TABLE IF NOT EXISTS user_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('personal','learning','task','kb')),
  text text NOT NULL,
  embedding vector(1536) NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_memory_user_id_idx ON user_memory(user_id);
CREATE INDEX IF NOT EXISTS user_memory_kind_idx ON user_memory(user_id, kind);
CREATE INDEX IF NOT EXISTS user_memory_embedding_idx
  ON user_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS user_memory_meta_gin ON user_memory USING gin (metadata);

-- Knowledge base
CREATE TABLE IF NOT EXISTS kb (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  name text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private','org','public')) DEFAULT 'private',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kb_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id uuid NOT NULL REFERENCES kb(id) ON DELETE CASCADE,
  source_uri text,
  title text,
  mime_type text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_document_kb_idx ON kb_document(kb_id);
CREATE INDEX IF NOT EXISTS kb_document_meta_gin ON kb_document USING gin (metadata);

CREATE TABLE IF NOT EXISTS kb_document_revision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES kb_document(id) ON DELETE CASCADE,
  rev int NOT NULL,
  content_sha256 bytea NOT NULL,
  chunking_params jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(document_id, rev)
);

CREATE TABLE IF NOT EXISTS kb_chunk (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES kb_document_revision(id) ON DELETE CASCADE,
  chunk_index int NOT NULL,
  text text NOT NULL,
  token_count int CHECK (token_count >= 0),
  embedding vector(1536) NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now(),
  UNIQUE(revision_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS kb_chunk_rev_idx ON kb_chunk(revision_id, chunk_index);
CREATE INDEX IF NOT EXISTS kb_chunk_meta_gin ON kb_chunk USING gin (metadata);
CREATE INDEX IF NOT EXISTS kb_chunk_embedding_idx
  ON kb_chunk USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Retrieval audit
CREATE TABLE IF NOT EXISTS retrieval_query (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  kb_id uuid REFERENCES kb(id) ON DELETE SET NULL,
  query_text text NOT NULL,
  query_embedding vector(1536) NOT NULL,
  filters jsonb DEFAULT '{}'::jsonb,
  top_k int DEFAULT 6,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS retrieval_result (
  query_id uuid REFERENCES retrieval_query(id) ON DELETE CASCADE,
  chunk_id uuid REFERENCES kb_chunk(id) ON DELETE CASCADE,
  score double precision NOT NULL,
  rank int NOT NULL,
  PRIMARY KEY (query_id, chunk_id)
);