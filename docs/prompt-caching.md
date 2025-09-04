# Realtime Prompt Caching — Cost Guide and Implementation Notes

This doc explains how to cut Realtime costs by caching the stable part of our assistant instructions, how to wire it in this codebase, and what savings to expect per user.

## TL;DR

- Keep a byte‑identical policy prefix at the start of the `instructions` we send when creating a Realtime session. The platform bills that prefix at the cheaper “cached input tokens” rate on subsequent sessions.
- Append dynamic, per‑user context as a small suffix. Do not put timestamps, names, or recency hints in the prefix.
- Savings: cached input tokens cost $0.40 / 1M vs $32 / 1M for normal input tokens (per your pricing image). Output tokens remain $64 / 1M.
- Change impact: low (extract + freeze a prefix; append a suffix). No behavior change for the assistant.

## What Caching Means Here

- The provider charges repeated, byte‑identical prefixes of your inputs as “cached input tokens.” Anything new/different is billed normally.
- For Realtime, the main win is caching our large system prompt (identity, tone, policies, tool rules). User speech and dynamic context do not benefit.

## Highlights From OpenAI’s Prompt‑Caching Guide

The official guide (Platform → Guides → Prompt Caching) emphasizes:

- The provider applies cheaper pricing to repeated, byte‑identical prefixes of input. New portions bill normally.
- Caching is per model/region and not permanent; think of it as an optimization, not a guarantee.
- Best wins come from caching large, stable instruction blocks sent frequently across sessions/users.
- Keep the cached portion at the beginning of the input. Prefix placement matters for match efficiency.
- Avoid any dynamic text in the cached portion (timestamps, user names, counters). Even whitespace/punctuation changes can break reuse.
- Consider versioning the cached block (e.g., POLICY_V1 → POLICY_V2 when edited) to reduce accidental changes.

Some SDKs and endpoints also expose a hint field called `prompt_cache_key` (name may vary by SDK) that associates semantically identical content across requests. Treat it as a hint — the safest path is still a byte‑identical prefix.

## Are We Caching Today?

- No. We currently send one monolithic `instructions` string that mixes stable policy with dynamic data. Because it changes every session, the prefix rarely qualifies as a cache hit.

Relevant code entrypoint:

- `server.js:640–742` (token mint) and `server.js:679–706` (POST `/v1/realtime/sessions`) — this is where `instructions` is built and sent.

## Implementation Plan (Minimal Changes)

1) Freeze a stable policy prefix
- Extract the long policy that starts around:
  - `server.js:449` (begins with “Identity & personality… Tool use… Quiz coaching policy…”) — treat this as `POLICY_V1`.
- Put it in a plain string with no interpolation. Avoid anything that could vary (no timestamps, no user names, no environment flags).
- Version it (e.g., `POLICY_VERSION=V1`). Only bump when the text truly changes.

2) Build `instructions = POLICY_V1 + "\n\n---\n" + dynamicSuffix`
- dynamicSuffix should include ONLY per‑user data: language, user context summary, working memory, recent summaries, recency/reload hints, current date/time.
- Keep dynamicSuffix relatively small (we already do this; just ensure it’s appended after the policy).

3) Reuse one session per page load
- We already mint one session token and then do `/realtime/sdp` once per page visit. Keep that pattern — don’t recreate sessions mid‑visit.

4) Hygiene to keep the cache hot
- Do not edit `POLICY_V1` whitespace or punctuation.
- Do not include values that change (dates, counters, names) in the policy prefix.
- If you must change the policy, bump the version and deploy (old version may still be warm in cache for a while; new version re‑warms quickly with use).

5) Observability
- Set `DEBUG_CONTEXT_LOG=1` and add `?debug=1` on `/realtime/token` to print log lines like `instructions.len` and `instructions.full` to verify the prefix stayed identical.
- In the billing dashboard, you should start seeing “cached input tokens” attributed to sessions.

### Realtime API example (gpt‑realtime)

In Realtime, the cache win comes from a byte‑identical prefix at the very start of `instructions`. There’s no separate `prompt_cache_key` field for session creation; you simply keep the policy text identical and first.

Pseudocode:

```js
// Stable, versioned policy kept byte‑identical across users/sessions
const POLICY_V1 = loadPolicyVerbatim();

// Small dynamic suffix for the current user/session
const dynamicSuffix = buildDynamicSuffix(userContext, recentSummaries, dateHints);

const res = await fetch('https://api.openai.com/v1/realtime/sessions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'realtime=v1'
  },
  body: JSON.stringify({
    model: 'gpt-realtime',
    modalities: ['audio','text'],
    voice: 'alloy',
    // Cached prefix (POLICY_V1) must be the first bytes of the string
    instructions: POLICY_V1 + '\n\n---\n' + dynamicSuffix
  })
});
```

Key points:
- POLICY_V1 is the cached prefix; do not include names, timestamps, or recency hints inside it.
- Put all per‑user data in `dynamicSuffix` so only that portion bills at normal input rates.
- Reuse one session per page load to avoid paying prompt costs repeatedly.

### Using `prompt_cache_key` (non‑Realtime)

Some non‑Realtime endpoints (e.g., Responses API) support attaching cache metadata directly to inputs. When available, you can combine a byte‑identical prefix with explicit cache hints:

```js
const POLICY_V1 = loadPolicyVerbatim(); // stable, versioned text

const resp = await client.responses.create({
  model: 'gpt-4o-mini',
  input: [
    {
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: POLICY_V1,
          cache_control: { type: 'ephemeral' },   // cacheable segment
          prompt_cache_key: 'policy:v1'           // stable key for this policy version
        }
      ]
    },
    { role: 'user', content: [ { type: 'input_text', text: dynamicSuffix } ] }
  ]
});
```

Notes:
- Field names and availability may vary by SDK/endpoint. Always follow the official guide for your API path.
- Realtime session creation does not currently take `prompt_cache_key`; rely on the byte‑identical prefix pattern shown above.

## Cost Impact (Per User, Per Month)

Assumptions
- System policy size ≈ 24k chars ≈ ~6,000 tokens (4 chars/token).
- One Realtime session per day (prefix sent once/day).
- 30 days.

Fixed monthly overhead (policy only)
- Without cache: 6,000 × 30 = 180,000 input tokens → 0.18M × $32 ≈ **$5.76**
- With cache: 0.18M × $0.40 ≈ **$0.07**

Conversation (unchanged by cache)
- Rough speech tokenization at normal speaking pace:
  - User ≈ 173 tokens/min; Assistant ≈ 133 tokens/min.
- For M minutes/day (split 50/50):
  - Monthly user input tokens ≈ 173 × 15M
  - Monthly assistant output tokens ≈ 133 × 15M
- Costs = `input_tokens/1e6 × $32` + `output_tokens/1e6 × $64`

Example totals (per user)
- 10 min/day (5 user + 5 assistant):
  - Conversation ≈ $2.11; Policy: $5.76 no‑cache vs $0.07 cached
  - Total: **$7.87 (no cache)** vs **$2.18 (cached)**
- 20 min/day:
  - Conversation ≈ $4.21; Policy: as above
  - Total: **$9.97 (no cache)** vs **$4.28 (cached)**
- 40 min/day:
  - Conversation ≈ $8.43; Policy: as above
  - Total: **$14.19 (no cache)** vs **$8.50 (cached)**

Takeaway: caching the policy removes most of the fixed overhead and keeps behavior identical.

Tip: If you see few or no “cached input tokens,” double‑check that your policy prefix is at the very start of `instructions` and that you haven’t accidentally added dynamic content or whitespace changes to the prefix.

## What Goes Into the Cached Prefix

Include
- Identity and tone
- Safety/guardrails
- Tool usage rules (e.g., list/recommend courses, quiz coaching policy)
- First‑turn rules and dialogue style

Exclude (move to dynamic suffix)
- User name, email, language preference
- Categories, recent events, last summaries, recency/reload hints
- Current date/time, time zone

## Pros and Cons

Pros
- 98%+ cheaper for the static policy chunk ($0.40 vs $32 per 1M input tokens)
- No model behavior change
- Simple rollout; easy to revert; A/B friendly

Cons
- Any byte change to the prefix misses cache until it re‑warms
- Requires discipline to keep dynamic content out of the prefix
- Cache lifetime/behavior is provider‑managed (not a strict SLA)

## Rollout Checklist

- [ ] Extract `POLICY_V1` string (stable, no interpolation)
- [ ] Append dynamic suffix only after the policy
- [ ] Keep one session per page load
- [ ] Enable `DEBUG_CONTEXT_LOG` and confirm identical prefix across sessions
- [ ] Monitor “cached input tokens” in usage
- [ ] After stabilization, consider turning the policy into a small file (e.g., `policy.txt`) and load it verbatim to avoid accidental edits

## Production Patterns — With vs Without Cache

- Without cache
  - `instructions = policy + dynamic` (policy contains dynamic pieces → changes per session)
  - New Realtime session each page load bills the full instructions as normal input tokens.

- With cache
  - `instructions = POLICY_V1 + "\n\n---\n" + dynamicSuffix` (POLICY_V1 is byte‑identical and first)
  - The policy block qualifies for cached‑input pricing; only the suffix bills normally.
  - Optionally set `prompt_cache_key: 'policy:v1'` in non‑Realtime flows.

## Summary — Practical Business Settings

- Baseline cost with caching: ≈ $0.007 per conversation minute (plus ~$0.07/month fixed policy overhead per user). Without caching, add ≈ $5.76/month per user.
- Suggested plans (per user/month):
  - Starter (10 min/day ≈ 300 min/mo): cost ≈ $2.2 → price $8–$10.
  - Standard (20 min/day ≈ 600 min/mo): cost ≈ $4.3 → price $12–$15.
  - Pro (40 min/day ≈ 1200 min/mo): cost ≈ $8.5 → price $25–$30.
- Limits to keep margins healthy:
  - Daily cap: 20–40 minutes; soft‑stop with a friendly notice and offer text‑only guidance or resume tomorrow.
  - Monthly cap: 600–1200 minutes; optionally allow overage at ~$0.01/min.
- Implementation quick wins:
  - Freeze `POLICY_V1` and place it first in `instructions`; append only user‑specific suffix.
  - Reuse one Realtime session per page load.
  - Monitor “cached input tokens” and adjust minutes/pricing as usage patterns emerge.

## Pricing Strategy (Per User)

- With caching: 20 min/day costs ≈ $4–$5 → charge $12–$15/month for healthy margin (infra/DB/monitoring overhead included).
- Without caching: 20 min/day costs ≈ $10 → price ≥ $20–$25/month to remain profitable.

## FAQ

**Q: Does caching change latency or quality?**
- No. It only changes how input tokens are billed. Model behavior is unchanged.

**Q: Do we need a special API field?**
- For Realtime sessions, no extra field is required; the key is a byte‑identical prefix. Some non‑Realtime endpoints expose explicit cache controls, but the core win here comes from keeping the prefix stable.

**Q: How often should we change the policy?**
- Rarely. When you must, bump `POLICY_VERSION` and deploy. Avoid churn to keep the prefix warm in cache.

---

If you want, we can wire this now by extracting `POLICY_V1` in `server.js` and appending the dynamic suffix (no behavior change). Let me know and I’ll send a small PR.
