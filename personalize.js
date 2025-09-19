// personalize.js – On-demand personalized onboarding flow
// Wires the "Personalize with AI" button to a dynamic Q&A session.
// Relies on the existing Realtime session and tools defined in compenion_ai.html.

(function(){
  function $(id){ return document.getElementById(id); }

  async function ensureSessionStarted(){
    // If DataChannel is open, we can proceed
    if (window.__DC && window.__DC.readyState === 'open') return true;
    // If function is available, start it; else click the button
    try {
      if (typeof window.startOpenAIRealtime === 'function') {
        await window.startOpenAIRealtime();
      } else {
        const sb = $('startAssistantBtn');
        if (sb && !sb.disabled) sb.click();
      }
    } catch(_) {}
    // Wait up to 8s for DC to open
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (window.__DC && window.__DC.readyState === 'open') return true;
      await new Promise(r => setTimeout(r, 120));
    }
    return false;
  }

  async function getUser(){
    try { return await fetch('/me').then(r=>r.json()); } catch(_) { return null; }
  }

  async function getUserPromptSnapshot(email){
    if (!email) return null;
    try {
      const path = `/scripts/exports/user_prompts/${email.replace(/[\\/]/g,'')}.txt`;
      const txt = await fetch(path).then(r => r.ok ? r.text() : '');
      return txt || null;
    } catch(_) { return null; }
  }

  function trimBlock(s, max = 4000){
    if (!s) return '';
    const t = String(s);
    return t.length > max ? (t.slice(0, max - 3) + '...') : t;
  }

  function buildPersonalizeInstructions(hasSnapshot, snapshot){
    // Prompt for the assistant to drive a dynamic, personalized onboarding.
    return (
"Enter personalization mode now. Phase 1 — Introduction: Start with an explicit acknowledgement like (IMPORTANT: you must start like this or similar): \"Oh you clicked the personalization mode button. Let’s tailor your learning journey so I can recommend the right courses and help you apply them day‑to‑day.\" In 2–3 short sentences, explain why we’re doing this and what to expect (a few focused questions). Do NOT ask a question in the introduction; end your turn after introducing.\n\nPhase 2 — Dialogue goals:\n" +
"- Rapidly understand the learner's key objectives and constraints.\n" +
"- Ask 4–6 crucial questions with adaptive follow-ups only when answers are vague or too short.\n" +
"- DO NOT repeat questions already answered in the provided snapshot; read it first and only fill gaps.\n" +
"- After each answer, immediately call the tool add_user_memory with a best-fit type among: fact, preference, goal, progress, open_question. Keep statements short and concrete.\n" +
"- Prefer stability: goals/preferences phrased crisply; avoid future hypotheticals.\n" +
"- IMPORTANT: Drop any prior pending topic; switch to personalization NOW.\n" +
"- When enough information is captured (you decide), propose the ONE best course from our catalog (past or upcoming) that best fits their answers. If past: say they just missed it and can watch the recording; if upcoming: mention local start_date/time and starts_in_human. Tone: energetic and motivational.\n" +
"- Use tools silently; keep spoken turns short (2–3 sentences), energetic and fluent.\n" +
"- Ask exactly one question per turn. After asking, END your response immediately and wait for the user’s reply. Do not keep talking or ask follow‑up in the same turn.\n" +
"- Questions should be free‑form — do NOT present multiple‑choice answers (a/b/c). If the user asks for help or seems unsure, briefly offer 2–3 example answers as scaffolding.\n" +
"- After each answer, summarize in one short phrase (optional), then immediately call add_user_memory with { type, statement } using the user’s own words when possible.\n" +
"- Tools you may need: list_courses, recommend_courses, get_event_details, add_user_memory.\n" +
"- Never reveal raw JSON or table names.\n\n" +
"Conduct the dialogue now. First produce ONLY the introduction and stop. After the user’s acknowledgement, ask your first question (one question only) and stop to wait for the answer before continuing. When you decide you have enough information, call list_courses (and optionally recommend_courses/get_event_details) to pick the single best course and explain why it fits.\n" +
(hasSnapshot ? "\n\nUse the following prior snapshot to avoid re-asking known items. Treat it as trusted context and only fill gaps.\n[SNAPSHOT BEGIN]\n" + snapshot + "\n[SNAPSHOT END]" : "")
    );
  }

  function buildSessionOverrideInstructions(){
    return (
      "SESSION OVERRIDE — PERSONALIZATION MODE:\n" +
      "- You are in an explicit personalization mode triggered by the user.\n" +
      "- Ignore any onboarding gate or first-time language choice flows for this mode, even if baseline instructions suggest them.\n" +
      "- Do NOT re-run onboarding questions; prefer gap-filling only based on existing memory/snapshot.\n" +
      "- Language: respond in the user’s preferred language if known; otherwise use English without asking a language question.\n" +
      "- Ask one question per turn, wait for user replies, and save answers using add_user_memory.\n" +
      "- When sufficient detail is captured, recommend one best course via list_courses (+ optional recommend_courses/get_event_details).\n"
    );
  }

  function buildSnapshotAttachment(snapshot){
    if (!snapshot) return null;
    return {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: 'personalize_snapshot_1',
        output: JSON.stringify({ kind: 'user_context_snapshot', text: snapshot })
      }
    };
  }

  async function runPersonalizeFlow(){
    const btn = $('personalizeBtn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy','true'); btn.textContent = 'Preparing…'; }
    try {
      const ok = await ensureSessionStarted();
      if (!ok || !window.__DC) throw new Error('Session not active');
      const dc = window.__DC;

      // Suppress auto follow-ups and cancel any active response before starting personalization.
      try { if (window.setAutoResponseSuppressed) window.setAutoResponseSuppressed(true); } catch(_) {}
      try { if (window.__IS_RESPONSE_ACTIVE && typeof window.cancelActiveResponse === 'function') window.cancelActiveResponse(); } catch(_) {}
      const timeoutAt = Date.now() + 3000;
      while (window.__IS_RESPONSE_ACTIVE && Date.now() < timeoutAt) {
        try { if (typeof window.cancelActiveResponse === 'function') window.cancelActiveResponse(); } catch(_) {}
        await new Promise(r => setTimeout(r, 120));
      }
      const user = await getUser();
      const email = user && user.email ? String(user.email) : null;
      const snapshotRaw = await getUserPromptSnapshot(email);
      const snapshot = trimBlock(snapshotRaw, 3500);
      const hasSnapshot = !!snapshot;

      // removed client-side language lock; enforced server-side from snapshot

      // Ensure turn detection is active so questions pause for user replies
      try {
        dc.send(JSON.stringify({ type: 'session.update', session: { turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 1100 }, instructions: buildSessionOverrideInstructions() } }));
        try { await fetch('/debug/log_instructions', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tag:'session.update', scope:'personalize.override', instructions: buildSessionOverrideInstructions() }) }); } catch(_) {}
      } catch(_) {}

      // Mark intro phase so the app keeps auto replies suppressed until the user's first reply
      try { window.__PERSONALIZE_MODE = 'intro'; } catch(_) {}
      // Send the driving instructions for the dynamic onboarding
      const instructions = buildPersonalizeInstructions(hasSnapshot, snapshot);
      try { await fetch('/debug/log_instructions', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tag:'response.create', scope:'personalize.intro', instructions, snapshot: hasSnapshot ? snapshot : null }) }); } catch(_) {}
      dc.send(JSON.stringify({
        type: 'response.create',
        response: { modalities: ['audio','text'], instructions }
      }));
      if (btn) { btn.textContent = 'Personalization in progress…'; }
    } catch (e) {
      console.error('Personalize flow failed:', e);
      try { alert('Could not start personalized onboarding. Please try again after connecting.'); } catch(_) {}
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = '✨ Personalize with AI'; }
    } finally {
      // Keep button disabled during the ongoing personalization; do not re-enable here on success
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    const btn = $('personalizeBtn');
    if (!btn) return;
    btn.addEventListener('click', runPersonalizeFlow);
  });
})();
