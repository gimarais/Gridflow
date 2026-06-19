/**
 * Hash-reference tokens (`#file:…`, `#codebase`, `#errors`, `#selection`) are
 * inserted into cells via the native file-picker quick pick (gridPanel.ts) and
 * preserved verbatim in JSON output for downstream agents to resolve. This
 * module extracts them when serializing a grid for chat.
 */
export function extractHashTokens(text: string): string[] {
  const matches = text.matchAll(/#(?:file|symbol):[^\s,;]+|#(?:codebase|errors|selection)/g);
  const out: string[] = [];
  for (const m of matches) out.push(m[0]);
  return out;
}
