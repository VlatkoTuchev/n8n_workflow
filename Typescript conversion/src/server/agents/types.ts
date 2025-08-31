export type ToolSchema = {
  name: string;
  description?: string;
  parameters: unknown; // narrowed with zod at runtime
};

export type SessionInstructionsBuilder = (args: {
  base: string;
  continuity: string;
  personalization?: string;
  workingPack?: string;
  recentSummaries?: string;
  recentConvos?: string;
  agentName?: string;
  agentStyle?: string;
  preferredLanguage?: string | null;
  tz: string;
  nowIso: string;
}) => string;


