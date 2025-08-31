// Hook points for output moderation/filters; no-ops initially
export function guardrailCheckText(_text: string): { pass: boolean; reason?: string } {
  return { pass: true };
}


