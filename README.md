# AI Learning Companion – Project Guide

A full-stack, realtime AI companion that personalizes conversations using user data mirrored from MySQL into PostgreSQL via CDC (Debezium → Kafka → JDBC Sink), plus a lean memory system (atomic facts + rolling digest) persisted in Postgres.

## 1) High‑level architecture
- Browser (compenion_ai.html)
  - WebRTC audio/text to OpenAI Realtime API via server proxy
  - Minimal tool surface (profile/context fetch, language preference)
- Node/Express server (server.js)
  - Issues ephemeral Realtime tokens with carefully crafted instructions
  - Injects personalization context and Working Memory Pack (facts, preferences, goals, progress, open questions + rolling digest)
  - Session finalization creates cumulative summaries, extracts atomic memory items, rebuilds digest
- Data layer
  - PostgreSQL (pgvector installed; schemas in `db/init.sql`)
  - Redis: chat buffer + idle activity tracking
  - MySQL: source of truth for app data mirrored into Postgres
  - Kafka + Zookeeper + Kafka Connect: CDC pipeline (Debezium MySQL source → JDBC sink)

## 2) Tech stack
- Backend: Node.js (Express)
- AI: OpenAI Realtime API (voice/text) + Chat Completions for summaries
- DB: PostgreSQL 16 (pgvector), Redis 7, MySQL 8.0
- CDC: Debezium MySQL connector, Kafka, Kafka Connect, JDBC Sink
- Infra: Docker Compose

## 3) Getting started (dev)
1) Environment – create `.env` next to `server.js`
```
OPENAI_API_KEY=sk-...
OPENAI_REALTIME_MODEL=gpt-realtime              # or valid realtime model
OPENAI_SUMMARY_MODEL=gpt-4o
DATABASE_URL=postgresql://compenion_ai:compenion_ai@localhost:5432/compenion_ai
REDIS_URL=redis://localhost:6379
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=ai_cdc
MYSQL_PASSWORD=ai_cdc_pwd
MYSQL_DB=aiatwork
# Optional
DEBUG_CONTEXT_LOG=false
ENABLE_IDLE_SUMMARIZER=true
SESSION_IDLE_MS=60000
IDLE_SUMMARIZER_INTERVAL_MS=30000
```
2) Start services
```bash
docker compose up -d
node server.js
```
3) Open the app
- http://localhost:4400
- First login/register uses MySQL `users` for auth. The server also ensures a MySQL `users` row for any new Postgres-only identity so CDC can mirror to Postgres.

## 4) CDC pipeline (MySQL → Kafka → Postgres)
- Debezium MySQL source streams row changes to topics `mysql.aiatwork.*`.
- JDBC Sink writes `mysql.aiatwork.users` → Postgres `user_mysql_mirror`.
- Use `CDC_USERS_MIRROR.md` for ready-to-run creation/verification/troubleshooting commands.

Key mirrors used by personalization: `user_mysql_mirror`, `user_data_mysql_mirror`, `events_mysql_mirror`, `event_attendances_mysql_mirror`, `event_user_favorites_mysql_mirror`, `event_quiz_*_mysql_mirror`, `event_webinar_questions_mysql_mirror`, `event_nps_responses_mysql_mirror`, `event_certificates_mysql_mirror`, `categories_mysql_mirror`.

Performance indexes for mirrors are appended in `db/init.sql`.

## 5) Personalization and memory (new-session behavior)
On each new session, the server injects into OpenAI Realtime:
- Base system prompt: role/tone/loop; “fresh session” rule
- Context summary (from mirrors): name/email, top categories, upcoming/public events, attended, favorites, recent quizzes, recent webinar Qs
- Working Memory Pack (lean memory): top‑K atomic items + short rolling digest

Not injected: prior transcript or client-provided summary (the client does not set instructions).

Finalization (idle or explicit):
- Cumulative summary (150–300 words) → `chat_session_summary`
- Atomic items → `user_memory`
- Rolling digest → `user_digest`

## 6) Server endpoints (selected)
- Auth: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /me`
- Realtime: `ALL /realtime/sdp`, `ALL /realtime/token`
- Profile/context: `GET /user/profile`, `GET /user/profile_enriched`, `GET /user/context`
- Tools (POST `/tools/execute`): `create_chat_session`, `add_chat_turn`, `retrieve_kb`, `kb_add_text`, `read_preferred_language`, `set_preferred_language`, `get_user_profile`, `get_user_profile_enriched`, `get_recent_chat`, `save_session_summary`, `summarize_session`
- Sessions: `POST /sessions/heartbeat`, `POST /sessions/finalize`
- Admin: `POST /tools/admin/delete_memories` (ADMIN_TOKEN)

Static routes: `/`, `/login`, `/signup`, `/auth.css`, `/auth-bg.js`, `/public/*`

## 7) Client (compenion_ai.html)
- WebRTC + Realtime via server proxy
- Tools: avatar controls, `get_user_context`, `get_user_profile_enriched`, `set_preferred_language`
- Greeting uses preferred language only (no prior-summary); server instructions carry memory/digest
- Idle finalize on tab close/inactivity

## 8) Data model (Postgres)
- Core chat: `app_user`, `chat_session`, `chat_message` (JSONB per session/user), `chat_session_summary`
- Preferences: `user_language`
- KB: `kb`, `kb_document`, `kb_document_revision`, `kb_chunk` (pgvector)
- Lean memory: `user_memory`, `user_digest`

## 9) Environment variables
- OpenAI: `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_SUMMARY_MODEL`
- Postgres: `DATABASE_URL`
- Redis: `REDIS_URL`
- MySQL: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DB`
- Optional: `DEBUG_CONTEXT_LOG`, `ENABLE_IDLE_SUMMARIZER`, `SESSION_IDLE_MS`, `IDLE_SUMMARIZER_INTERVAL_MS`

## 10) Troubleshooting
- Users not mirrored: run commands in `CDC_USERS_MIRROR.md`; trigger: `UPDATE users SET updated_at=NOW() WHERE email='...'`
- 404 on `/user/profile_enriched`: ensure `user_mysql_mirror` has the email (server seeds MySQL users if missing)
- Debug injected instructions: `/realtime/token?debug=1` (dev only)

## 11) Development tips
- Keep instructions on the server; avoid client overrides
- Maintain mirror indexes (`db/init.sql`)
- For new mirrors, replicate users sink pattern (topic, table.name.format, PK mode, unwrap)

## 12) Reference files
- `server.js` – API, realtime token, summarization/memory
- `retrieval.js` – chat storage, summaries, preferences, KB, lean memory helpers
- `redis.js` – chat buffer + idle activity
- `db/init.sql` – Postgres schema + mirror indexes
- `db/mysql-init.sql` – MySQL schema
- `connect/Dockerfile` – Kafka Connect (JDBC + Debezium MySQL)
- `docker-compose.yml` – services
- `CDC_USERS_MIRROR.md` – CDC commands
- `compenion_ai.html` – client UI + realtime session

## 13) Runbook
1) `docker compose up -d`
2) `node server.js`
3) Open `http://localhost:4400`
4) Login/register → server ensures MySQL user → CDC mirrors to Postgres
5) Start session → fresh, personalized
6) Finalize session → saves summary/memory/digest