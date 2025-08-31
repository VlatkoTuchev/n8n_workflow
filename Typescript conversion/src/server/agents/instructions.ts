import { SessionInstructionsBuilder } from './types';

export const buildInstructions: SessionInstructionsBuilder = ({
  base,
  continuity,
  personalization,
  workingPack,
  recentSummaries,
  recentConvos,
  agentName,
  agentStyle,
  preferredLanguage,
  tz,
  nowIso,
}) => {
  const parts: string[] = [];
  parts.push(base);
  parts.push(continuity);
  if (preferredLanguage) {
    parts.push(
      `Language Policy:\n- RESPOND ONLY IN ${preferredLanguage}.\n- Do NOT switch languages unless the user explicitly asks.\n- If the user asks to change, confirm briefly and continue in the new language.`,
    );
  }
  parts.push(`Current date/time (${tz}): ${nowIso}`);
  if (agentName) {
    parts.push(
      `Agent name policy:\n- Your current name is "${agentName}".\n- Always answer with this name when asked.`,
    );
  }
  if (agentStyle) {
    parts.push(
      `Agent style preference:\n- Maintain this baseline style across turns: ${agentStyle}.`,
    );
  }
  if (personalization) parts.push(`Context for personalization:\n${personalization}`);
  if (recentSummaries) parts.push(`Recent session summaries:\n${recentSummaries}`);
  if (workingPack) parts.push(`Working Memory Pack:\n${workingPack}`);
  if (recentConvos) parts.push(`Recent conversation excerpts:\n${recentConvos}`);
  return parts.join('\n\n');
};


