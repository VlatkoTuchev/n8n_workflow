CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- vector extension and KB tables removed (no embeddings in this setup)

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

-- Complete message log for sessions
CREATE TABLE IF NOT EXISTS chat_message (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES chat_session(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  role text,
  content jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(session_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_message_session_idx ON chat_message(session_id, created_at DESC);

-- Per-session summarization persisted for continuity across logins
CREATE TABLE IF NOT EXISTS chat_session_summary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES chat_session(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  summary text NOT NULL,
  next_prompt text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chat_session_summary_user_idx ON chat_session_summary(user_id, created_at DESC);

-- User preferred language per account (Postgres)
CREATE TABLE IF NOT EXISTS user_language (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  preferred_language text NOT NULL,
  updated_at timestamptz DEFAULT now()
);

-- Knowledge base, embeddings, and retrieval audit removed

-- ------------------------------------------------------------
-- Mirror table performance indexes (reference)
-- These indexes optimize common filters/joins/sorts used by the
-- personalization endpoints. Safe to run multiple times.
-- ------------------------------------------------------------

-- Users
CREATE INDEX IF NOT EXISTS idx_user_mysql_mirror_email
  ON public.user_mysql_mirror (email);

-- Events.start_at: create a plain index on the column (works whether it's text or timestamp)
DO $$
DECLARE t regtype;
BEGIN
  SELECT atttypid
  INTO t
  FROM pg_attribute
  WHERE attrelid = 'public.events_mysql_mirror'::regclass
    AND attname  = 'start_at'
    AND NOT attisdropped;

  IF t IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_events_mysql_mirror_start_at ON public.events_mysql_mirror (start_at)';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_events_mysql_mirror_category_id
  ON public.events_mysql_mirror (category_id);

-- Attendances (user filter; text sort by effective time)
CREATE INDEX IF NOT EXISTS idx_event_att_user_event
  ON public.event_attendances_mysql_mirror (user_id, event_id);

CREATE INDEX IF NOT EXISTS idx_event_att_user_effective_text
  ON public.event_attendances_mysql_mirror (
    user_id,
    (COALESCE(left_at, joined_at)) DESC
  );

-- Favorites (user filter; text sort by created_at)
CREATE INDEX IF NOT EXISTS idx_event_user_fav_user_event
  ON public.event_user_favorites_mysql_mirror (user_id, event_id);

CREATE INDEX IF NOT EXISTS idx_event_user_fav_user_created_text
  ON public.event_user_favorites_mysql_mirror (
    user_id,
    created_at DESC
  );

-- Webinar questions (user/email/event filters; text sort by created_at)
CREATE INDEX IF NOT EXISTS idx_webinar_q_user_created_text
  ON public.event_webinar_questions_mysql_mirror (
    user_id,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_webinar_q_email_created_text
  ON public.event_webinar_questions_mysql_mirror (
    email,
    created_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_webinar_q_event_created_text
  ON public.event_webinar_questions_mysql_mirror (
    event_id,
    created_at DESC
  );

-- NPS (user filter; text sort by created_at)
CREATE INDEX IF NOT EXISTS idx_nps_user_created_text
  ON public.event_nps_responses_mysql_mirror (
    user_id,
    created_at DESC
  );

-- Certificates (user filter; text sort by created_at)
CREATE INDEX IF NOT EXISTS idx_cert_user_created_text
  ON public.event_certificates_mysql_mirror (
    user_id,
    created_at DESC
  );

-- Quiz attempts / responses (filters; text sort by time)
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_user_started_text
  ON public.event_quiz_attempts_mysql_mirror (
    user_id,
    started_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_quiz_responses_attempt_answered_text
  ON public.event_quiz_responses_mysql_mirror (
    event_quiz_attempt_id,
    answered_at DESC
  );
