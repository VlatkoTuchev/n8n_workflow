# Code Overview

Clickable, sectioned map of the codebase with deep links to key spots in the main runtime files. Links use relative paths; most editors and GitHub jump to the line after the `#L…` anchor. If your editor ignores the line anchor, open the file and search for the nearest function name or the square‑bracket section tags in comments (e.g., `[CA1.1]`).

Top files
- Client: [../compenion_ai.html](../compenion_ai.html)
- Server: [../server.js](../server.js)
- Postgres helpers: [../retrieval.js](../retrieval.js)
- Redis helpers: [../redis.js](../redis.js)
- Schemas: [../db/init.sql](../db/init.sql), [../db/mysql-init.sql](../db/mysql-init.sql)
- Project guide: [../README.md](../README.md)

---

## 1) Client — compenion_ai.html
High‑level: Single‑page client UI. Renders the 3D avatar, sets up OpenAI Realtime (WebRTC), wires the model’s tool calls to UI/server actions (courses, quizzes, summaries, memory, preferences, agent settings, code‑assist), and handles session lifecycle (heartbeats, finalize on idle/exit).

Jump to sections
- 3D Avatar (Three.js): [../compenion_ai.html#L345](../compenion_ai.html#L345)
  - Scene/camera/lights, GLB loading (“walk”, “dance”, “boxing”), normalization, cross‑fades
  - Public API: `window.AvatarController.setWalk|setDance|setFight`
- Realtime entrypoint: [../compenion_ai.html#L626](../compenion_ai.html#L626)
  - PeerConnection, remote audio playout, audio worklet envelope, microphone capture/mute, token mint + SDP exchange
- Tools registry (functions callable by the model): [../compenion_ai.html#L859](../compenion_ai.html#L859)
- Quiz UI (modal): [../compenion_ai.html#L1125](../compenion_ai.html#L1125)
- Summary UI (overlay): [../compenion_ai.html#L1211](../compenion_ai.html#L1211)
- Events list + Enter/Quiz/Summary actions: [../compenion_ai.html#L1248](../compenion_ai.html#L1248)
- Code‑assist panel: [../compenion_ai.html#L1403](../compenion_ai.html#L1403)
- Client idle finalizer (best‑effort): [../compenion_ai.html#L1305](../compenion_ai.html#L1305)
- Logout wiring: [../compenion_ai.html#L2247](../compenion_ai.html#L2247)
- Mute toggle: [../compenion_ai.html#L2269](../compenion_ai.html#L2269)
- Pagehide/visibility finalize: [../compenion_ai.html#L2339](../compenion_ai.html#L2339)

Notes
- The client posts tool calls to `POST /tools/execute`; see the Server section for each tool.
- Audio worklet is optional; there’s an analyser fallback for environments without Worklet support.

### Client functions (compenion_ai.html)
Anchor: #client-functions — one‑line explanations and deep links to each function.

- `initThreeAvatarLayer()` [../compenion_ai.html#L351](../compenion_ai.html#L351): Bootstraps the Three.js scene, camera, lights, ground, loaders, and main loop.
- `crossFadeTo(name, fade)` [../compenion_ai.html#L410](../compenion_ai.html#L410): Smoothly transitions the avatar’s AnimationMixer to the named clip.
- `normalizeAndGroundModel(root)` [../compenion_ai.html#L420](../compenion_ai.html#L420): Centers and scales a loaded GLB so feet touch the ground plane.
- `setFacingByDirection()` [../compenion_ai.html#L460](../compenion_ai.html#L460): Sets yaw based on current horizontal velocity so the avatar faces movement.
- `updateAutonomy(deltaMs)` [../compenion_ai.html#L475](../compenion_ai.html#L475): Lightweight pacing across X with clamp bounds; idle in non‑walk modes.
- `startWalking()` [../compenion_ai.html#L489](../compenion_ai.html#L489): Switches to walk clip and resumes horizontal pacing.
- `enableAvatarDragging()` (IIFE) [../compenion_ai.html#L497](../compenion_ai.html#L497): Pointer‑drag move/raise the avatar within screen bounds.
- `onResize()` [../compenion_ai.html#L539](../compenion_ai.html#L539): Resizes renderer, updates camera projection, re‑normalizes avatar.
- `animate()` [../compenion_ai.html#L583](../compenion_ai.html#L583): rAF loop: tick mixer, autonomy, render.
- `window.AvatarController.setWalk|setDance|setFight` [../compenion_ai.html#L593](../compenion_ai.html#L593): Public controls for Realtime tools.

- `startOpenAIRealtime()` [../compenion_ai.html#L626](../compenion_ai.html#L626): Full Realtime setup — token mint, SDP exchange, audio/mic wiring, tools.
  - `setMood(mood)` [../compenion_ai.html#L660](../compenion_ai.html#L660): Color theme for the speaking bubble.
  - `animateBubble()` [../compenion_ai.html#L669](../compenion_ai.html#L669): Scales/glows the bubble based on audio envelope.
  - `setupEnvelopeProcessing(stream)` [../compenion_ai.html#L680](../compenion_ai.html#L680): AudioWorklet or analyser fallback for envelope.
  - `getUserId()` [../compenion_ai.html#L1055](../compenion_ai.html#L1055): Reads user id via `/user/profile` and caches `__CA_UID`.
  - `getSessionId()` [../compenion_ai.html#L1070](../compenion_ai.html#L1070): Returns current chat session id from `sessionStorage`.
  - `startNewSessionForUser(userId)` [../compenion_ai.html#L1073](../compenion_ai.html#L1073): Creates a new session via tool call and stores its id.
  - `ensureQuizUI()` [../compenion_ai.html#L1121](../compenion_ai.html#L1121): Lazily builds the quiz modal container.
  - `renderQuizQuestion()` [../compenion_ai.html#L1133](../compenion_ai.html#L1133): Renders current MCQ and Next/Prev logic.
  - `openQuizForEvent(eventId)` [../compenion_ai.html#L1187](../compenion_ai.html#L1187): Fetches quiz by event and opens the modal.
  - `ensureSummaryUI()` [../compenion_ai.html#L1207](../compenion_ai.html#L1207): Lazily builds the summary overlay container.
  - `openSummaryHtml(html, title)` [../compenion_ai.html#L1224](../compenion_ai.html#L1224): Loads provided HTML into the summary overlay.
  - `openSummaryForEvent(eventId, title)` [../compenion_ai.html#L1230](../compenion_ai.html#L1230): Loads saved summary for an event from the server.
  - `loadEvents()` [../compenion_ai.html#L1248](../compenion_ai.html#L1248): Lists courses from the server and renders cards with Enter/Quiz/Summary actions.
  - `maybeSendFiller()` [../compenion_ai.html#L1300](../compenion_ai.html#L1300): Marks tool activity to avoid back‑to‑back speech.
  - `finalizeSessionForIdle()` [../compenion_ai.html#L1309](../compenion_ai.html#L1309): Best‑effort background finalize after inactivity.
  - `resetIdleTimer()` [../compenion_ai.html#L1322](../compenion_ai.html#L1322): Restarts client idle countdown.
  - `requestResponseSafe()` [../compenion_ai.html#L1327](../compenion_ai.html#L1327): Sends response.create only if none in flight.
  - `waitForSessionUpdated(ms)` [../compenion_ai.html#L1341](../compenion_ai.html#L1341): Resolves after a session.updated event or timeout.
  - `beginNoToolFollowup(text?)` [../compenion_ai.html#L1350](../compenion_ai.html#L1350): Temporarily disables tools and prompts a short follow‑up.
  - `ensureCodeAssistLauncher()` [../compenion_ai.html#L1365](../compenion_ai.html#L1365): Floating entry button for the code‑assist panel.
  - `openOrRenderCodeAssist(payload)` [../compenion_ai.html#L1385](../compenion_ai.html#L1385): Opens or re‑renders the right panel with code/explanation.
  - `escapeHtml(s)` [../compenion_ai.html#L1390](../compenion_ai.html#L1390): Simple HTML escaper for code blocks.
  - `ensurePanel()` [../compenion_ai.html#L1391](../compenion_ai.html#L1391): Creates the panel shell on first use.
  - `caKey(base)` [../compenion_ai.html#L1474](../compenion_ai.html#L1474): Namespaces code‑assist storage per user.
  - `setupMuteToggle()` (IIFE) [../compenion_ai.html#L2269](../compenion_ai.html#L2269): Mute/unmute mic toggle wiring.
  - `summarizeAndSave` [../compenion_ai.html#L2299](../compenion_ai.html#L2299): Attempts session finalization on pagehide/visibility.

What it does (in practice)
- Starts a WebRTC session: mints an ephemeral token from `/realtime/token`, creates an SDP offer, posts it to `/realtime/sdp`, and attaches the returned SDP answer.
- Plays assistant audio via a hidden `<audio>` element and animates a small “speaking” bubble using an AudioWorklet envelope.
- Captures microphone (AEC/NS enabled) and exposes a robust mute toggle that flips both local tracks and any RTCRtpSender track.
- Registers a large tool catalog. When the model calls a tool, the client executes the matching UI/server action and replies with a compact JSON result through the data channel.
- Shows small, purpose‑built panels: code‑assist (right drawer), quiz modal, and course summary overlay.
- Sends session heartbeats; on idle/close it best‑effort finalizes the session so summaries/memory are saved.

Data contracts (outbound to server)
- `POST /realtime/token` → `{ token, hasHistory, preferredVoice }`
- `POST /realtime/sdp` with `application/sdp` body and header `X-OpenAI-Session-Token` → returns SDP answer
- `POST /tools/execute` with `{ name, arguments }` for specific tools (see Server section)
- `POST /sessions/heartbeat` and `/sessions/finalize` on timers/teardown

Failure behavior
- Token/SDP failures are surfaced in console with minimal UI disruption. Mic permission failures disable the mute button and continue in text‑only mode.
- On unload, the client tries `fetch(keepalive)`, then `sendBeacon`, then a sync XHR as a last resort to finalize the session quickly.

Modify safely
- When adding a new tool: register it in the Tools registry (name + JSON schema) and implement its call handler in the message loop. Keep spoken output short and put details into UI elements.
- 3D avatar is isolated behind `window.AvatarController` — extend its API if you need more animations or effects.

---

## 2) Server — server.js
High‑level: Express server that mints Realtime tokens with per‑user instructions (context + memory), proxies SDP to OpenAI, exposes user/profile/context endpoints, executes tool calls (courses, quizzes, favorites, memory, preferences, agent settings), persists chat in Postgres + Redis, and summarizes sessions (on demand or idle).

Core endpoints and helpers
- Realtime SDP proxy: [../server.js#L221](../server.js#L221)
- Realtime token (instructions + Working Memory Pack): [../server.js#L276](../server.js#L276)
- Auth: register [../server.js#L778](../server.js#L778), login [../server.js#L829](../server.js#L829), logout [../server.js#L873](../server.js#L873)
- Me/profile/context: `/me` [../server.js#L911](../server.js#L911), `/user/profile` [../server.js#L916](../server.js#L916), `/user/context` [../server.js#L942](../server.js#L942)
- Tools hub (POST `/tools/execute`): [../server.js#L1108](../server.js#L1108)
  - Chat/session: create session, add chat turn, recent chat/history
  - Language + agent: read/set preferred language, read/set agent name/settings
  - Memory: add/list user memory; rolling digest maintained by summarizer
  - Courses: `list_courses`, `recommend_courses`, `get_event_details`
  - Participation/favorites: `enter_event`, `user_favourite`
  - Quizzes: `get_event_quiz`, `submit_event_quiz`
  - Summaries: `save_session_summary` (and model‑driven summarize)
- Admin: delete memories [../server.js#L1923](../server.js#L1923)
- Static assets and HTML routes: [../server.js#L1952](../server.js#L1952)
- Index routing (`/`): [../server.js#L1975](../server.js#L1975)
- Summarization helper (finalization pipeline): [../server.js#L1994](../server.js#L1994)
- Sessions: heartbeat [../server.js#L2134](../server.js#L2134), finalize [../server.js#L2147](../server.js#L2147)
- Idle summarizer loop: section [../server.js#L2183](../server.js#L2183), interval [../server.js#L2191](../server.js#L2191)
- Startup (listen): [../server.js#L2240](../server.js#L2240)

Supporting helpers
- Ensure MySQL user for CDC mirroring: [../server.js#L47](../server.js#L47)
- Compose per‑user context summary for instructions: [../server.js#L71](../server.js#L71)

Operational notes
- Static exposure of the repo root is convenient for dev (GLBs/worklets). Consider narrowing mounts in production.
- The idle summarizer can be disabled via `ENABLE_IDLE_SUMMARIZER=false`.

How token minting builds intelligence
- Pulls compact “who/what” context from Postgres MySQL‑mirror tables (categories, upcoming, attended, favorites, quizzes, recent webinar Qs).
- Reads preferred language and agent settings (name/voice/style) from Postgres app tables.
- Builds a “Working Memory Pack” from `user_memory` top‑K items and a short rolling digest. This is injected into the Realtime session as part of `instructions` so the very first response is already personalized.
- Applies first‑turn and onboarding policies (language choice → 5 short questions). These guardrails live server‑side so the client stays thin.

Auth bridging (MySQL ↔ Postgres)
- Register/login uses MySQL `users` (password hash with bcrypt).
- Each identity is mirrored to Postgres `app_user`. The helper `ensureMysqlUserForEmail` keeps the MySQL side present so the Debezium CDC flow can mirror back into Postgres `user_mysql_mirror`.

Tools (server behaviors behind `/tools/execute`)
- Chat persistence: `create_chat_session`, `add_chat_turn`, `get_recent_chat`, `fetch_chat_history` — writes both Redis buffer and Postgres `chat_message` aggregated JSON per (session_id,user_id).
- Preferences/agent: read/set language and agent name/settings. Settings enforce “self‑only” access; voice/style updates ask for a page reload.
- Memory: `add_user_memory`, `get_user_memory` — atomic facts/preferences/goals/progress/open_questions with pinning/stability. The summarizer also extracts items automatically.
- Courses/catalog: `list_courses` and `recommend_courses` compute local date/time fields and human “starts in …” labels; they dynamically adapt to mirror schema differences and merge with MySQL if mirrors lag.
- Details and content: `get_event_details`, `get_event_summary` — normalize start times and serve saved HTML summaries when present.
- Participation/favorites: `enter_event` and `user_favourite` write to MySQL and rely on CDC mirrors for reads.
- Quizzes: `get_event_quiz` reads from mirror tables; `submit_event_quiz` persists attempts and item responses in MySQL and returns score/pass.

Summarization pipeline
- Transcript collection order: Postgres `chat_message` JSON → Redis buffer → fallback to row logs.
- Model summary → `chat_session_summary` UPSERT; memory extraction (light hallucination guard via content‑word overlap) → `user_memory`; rolling digest update → `user_digest`.
- Idle summarizer scans Redis keys `chat:last_activity:*` and finalizes inactive sessions with backoff on repeated failure.

Security and privacy
- All core routes require JWT (`authRequired` middleware). JWT is set as `auth` cookie and verified on each call.
- Admin route `/tools/admin/delete_memories` is protected with `X-Admin-Token` and an env token.
- In production, prefer explicit static mounts over serving the repo root.

---

## 3) Postgres helpers — retrieval.js
High‑level: Postgres layer for chat/session storage, summaries and preferences, agent settings, lean user memory, plus a small pgvector knowledge base (KB).

Functions
- Sessions/messages: `createChatSession` [../retrieval.js#L13](../retrieval.js#L13), `addChatMessage` [../retrieval.js#L24](../retrieval.js#L24), `getRecentMessages` [../retrieval.js#L90](../retrieval.js#L90)
- Summaries: `saveSessionSummary` [../retrieval.js#L103](../retrieval.js#L103), `readLatestSummary` [../retrieval.js#L115](../retrieval.js#L115)
- Language: `readPreferredLanguagePg` [../retrieval.js#L128](../retrieval.js#L128), `setPreferredLanguagePg` [../retrieval.js#L136](../retrieval.js#L136)
- Users/KB: `createUser` [../retrieval.js#L152](../retrieval.js#L152), `createKb` [../retrieval.js#L162](../retrieval.js#L162), `kbAddText` [../retrieval.js#L183](../retrieval.js#L183), `retrieveKb` [../retrieval.js#L222](../retrieval.js#L222)
- Memory: `ensureMemoryTables` [../retrieval.js#L258](../retrieval.js#L258), `upsertUserMemoryItems` [../retrieval.js#L296](../retrieval.js#L296), `selectTopKUserMemory` [../retrieval.js#L319](../retrieval.js#L319), `setUserDigest` [../retrieval.js#L343](../retrieval.js#L343), `getUserDigest` [../retrieval.js#L354](../retrieval.js#L354), `getRecentSummaries` [../retrieval.js#L359](../retrieval.js#L359)
- Agent settings: `readAgentNamePg` [../retrieval.js#L370](../retrieval.js#L370), `setAgentNamePg` [../retrieval.js#L378](../retrieval.js#L378), `readAgentSettingsPg` [../retrieval.js#L390](../retrieval.js#L390), `setAgentSettingsPg` [../retrieval.js#L403](../retrieval.js#L403)

Data model highlights
- `chat_message` stores an aggregated JSON array per (session_id,user_id) with UTC timestamp plus a pre‑formatted local timestamp and turn counters for easy summarization.
- `user_memory` holds atomic “facts/preferences/goals/progress/open_questions”. Ranking favors `pinned`, then `stability` (long→med→short), then recency.
- KB chunking uses fixed‑size character windows (1200 chars, 200 overlap) and `text-embedding-3-small` by default. An ivfflat index speeds up cosine similarity.

---

## 4) Redis helpers — redis.js
High‑level: Minimal chat buffers and session activity tracking used for idle summarization.

Functions
- Client + connect: `createClient` [../redis.js#L6](../redis.js#L6), `connectRedis` [../redis.js#L15](../redis.js#L15)
- Chat buffers: `addChatTurn` [../redis.js#L27](../redis.js#L27), `getRecentChat` [../redis.js#L40](../redis.js#L40), `getFullChat` [../redis.js#L46](../redis.js#L46)
- Activity: `setSessionActivity` [../redis.js#L56](../redis.js#L56), `getSessionActivity` [../redis.js#L65](../redis.js#L65)

Key mechanics
- Messages are appended to `chat:<sessionId>` with a TTL (default 24h); list is trimmed to a max length (`CHAT_BUFFER_MAX`).
- `chat:last_activity:<sessionId>` tracks the last user/assistant activity timestamp used by the idle summarizer.
- A separate `chat:session_user:<sessionId>` key maps sessions to Postgres user ids so the summarizer can attribute results.

---

## 5) Database schemas
- Postgres (app tables, KB, mirror indexes): [../db/init.sql#L1](../db/init.sql#L1)
- MySQL (source‑of‑truth app schema): [../db/mysql-init.sql#L1](../db/mysql-init.sql#L1)

Context
- MySQL is the operational source of truth. Debezium (MySQL → Kafka) + JDBC Sink mirror selected tables into Postgres as `<name>_mysql_mirror`.
- Postgres hosts app tables (chat, memory, preferences, KB). Mirror performance indexes are created in `db/init.sql`.
- The server reads primarily from Postgres (including mirrors) and writes back to MySQL for participation/favorites/quizzes.

---

## 6) Reading tips
- The server keeps most of the long‑form rationale in comments near the token minting instructions and summarization helper — skim those when making behavioral changes.
- When adding a new tool, define its JSON schema in the client tools registry and implement a matching case in `POST /tools/execute`.
- If you introduce new CDC mirrors, add read paths in `/user/context` and consider indexes in `db/init.sql`.

Common flows (end‑to‑end)
- First visit → register/login (MySQL) → cookie JWT issued.
- Open app → client requests `/realtime/token` → server injects context + memory into `instructions` → client posts SDP to `/realtime/sdp` → assistant greets with onboarding.
- During chat → model calls tools silently; client updates UI and server persists turns; heartbeats keep the session “active”.
- On idle/close → client or idle summarizer finalizes → model produces a cumulative summary → atomic memory extracted; digest updated.

Environment quick list
- OpenAI: `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_SUMMARY_MODEL`
- Postgres: `DATABASE_URL`, `APP_TIMEZONE`
- Redis: `REDIS_URL`, `CHAT_BUFFER_MAX`, `CHAT_BUFFER_TTL_SECONDS`
- MySQL: `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DB`
- Session/idle: `ENABLE_IDLE_SUMMARIZER`, `SESSION_IDLE_MS`, `IDLE_SUMMARIZER_INTERVAL_MS`
