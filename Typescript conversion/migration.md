### TypeScript Migration Plan (aligned with OpenAI Realtime Agents)

References:
- Realtime Agents (server‑first, typed agents, tool orchestration): https://github.com/openai/openai-realtime-agents/
- Realtime Console (clean client patterns, session.update, tools): https://github.com/openai/openai-realtime-console/

---

## Goals
- Single source of truth for instructions/policies on the server at session creation
- Typed tool schemas and server‑executed function calls
- Keep client thin: session.update (modalities/tools/voice), minimal greeting
- Maintain existing memory: summaries → atomic items → digest; inject concise context
- Improve maintainability with clear module boundaries and strict typing

## Tooling
- Dependencies (dev): typescript, tsx (or ts-node-dev), @types/node
- Types: @types/express, @types/cookie-parser, @types/jsonwebtoken, @types/bcryptjs, @types/redis, @types/mysql2, @types/pg
- tsconfig.json (high level):
  - module: commonjs
  - target: ES2020
  - rootDir: src
  - outDir: dist
  - strict: true
  - esModuleInterop: true
  - resolveJsonModule: true
  - skipLibCheck: true
- package.json scripts:
  - dev: tsx src/server/index.ts
  - build: tsc
  - start: node dist/server/index.js

## Target Structure
```
src/
  server/
    index.ts                  # Express bootstrap
    env.ts                    # Runtime env validation
    middleware/
      auth.ts                 # JWT parsing, user claims
    config/
      openai.ts               # OpenAI clients (Realtime + Chat)
      db.ts                   # Postgres pool
      mysql.ts                # MySQL pool
      redis.ts                # Redis client
      time.ts                 # TZ/date helpers
    agents/
      instructions.ts         # Base system prompt + continuity + personalization
      guardrails.ts           # Moderation / output filters (hook points)
      tools.ts                # Zod schemas + tool registry (server executors)
      types.ts                # Assistant events / tool call types
    routes/
      realtime.ts             # /realtime/token, /realtime/sdp
      tools.ts                # /tools/execute
      auth.ts                 # /auth/register, /auth/login, /auth/logout, /me
      user.ts                 # /user/profile, /user/context
      sessions.ts             # /sessions/heartbeat, /sessions/finalize
    services/
      memory.ts               # user_memory, user_digest, selectTopK, upsert
      summarization.ts        # summary, items extraction, digest
      chat.ts                 # createChatSession, chat_message JSON persistence
      courses.ts              # list/recommend courses; shared date parsing
      preferences.ts          # read/set language, agent name/voice/style
      kb.ts                   # (optional) KB CRUD + retrieval
    models/
      pgTypes.ts              # Postgres mirror row types
      mysqlTypes.ts           # MySQL row types
web/                          # (later) client TS modules if we migrate UI
```

## Instruction Strategy (Server‑first)
- Build the full instruction block in `agents/instructions.ts`:
  - Base identity + tone + platform scope + guardrails
  - Continuity (first contact vs returning)
  - Personalization: compact user context from Postgres mirrors
  - Working Memory Pack (top‑K) + newest summaries (short)
- Send as `instructions` in POST `/v1/realtime/sessions` (ephemeral mint)
- Use `session.update` only for small runtime tweaks (e.g., voice), not to resend policies

## Tools (Function Calling)
- Define tool schemas with Zod in `agents/tools.ts`
- Client declares tool schemas; the server executes via `/tools/execute`
- Stream outputs back using `function_call_output` items on the data channel
- Keep surface minimal: avatar controls, user context, language/name/settings, list/recommend courses

## History & Memory
- Keep current design:
  - Postgres `chat_message` single‑row JSON per session (authoritative transcript storage)
  - Redis short buffer for quick reads + idle detection
  - Summarization pipeline → `chat_session_summary` → atomic `user_memory` → rolling `user_digest`
- Inject only concise memory/digest into session instructions (avoid long client prompts)

## Guardrails
- Centralize moderation/filters in `agents/guardrails.ts`
- Hook point: intercept assistant output streams; mark/pass/fail as needed

## Client Simplification (later follow‑up)
- One initial `session.update` (modalities, tools, voice)
- Minimal first greeting that references system policies (no big prompts)
- Remove filler/ack speech logic and excessive debounce; rely on VAD + single `response.create` per user utterance

## Rollout Steps
1) Add TS toolchain and `tsconfig.json`
2) Create `src/server` skeleton with empty modules exporting stubs
3) Port config: `db`, `mysql`, `redis`, `openai`, `time`
4) Port services: `chat`, `memory`, `summarization`, `preferences`, `courses`
5) Port routes: `auth`, `realtime`, `tools`, `user`, `sessions`
6) Extract `agents/instructions.ts`, `agents/tools.ts`, `agents/guardrails.ts`, `agents/types.ts`
7) Wire ephemeral session creation (server) and test: SDP proxy uses X‑OpenAI‑Session‑Token; verify header `X-Session-Token-Used: true`
8) Build/run; smoke test all endpoints; measure instruction sizes; trim if needed
9) Optional: migrate client JS into `web/` TS modules (keep thin)

## Acceptance Checklist
- Server creates sessions with canonical instructions; no policy duplication in client
- Tool calls validated via Zod and executed server‑side; outputs streamed back
- Memory pipeline produces summaries, atomic items, digest; only condensed context injected
- Idle summarizer finalizes sessions reliably; errors backed off; logs gated by DEBUG
- TypeScript strict build is green; CI builds `dist/`; Docker uses compiled output

## Notes
- We can feature‑flag KB (`ENABLE_KB`) to exclude code and tools when unused
- Keep instruction length under model limits; prioritize newest info; avoid leaking schema names
- Prefer small utility functions for date parsing and voice selection to remove duplication


