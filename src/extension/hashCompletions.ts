import * as vscode from 'vscode';
import { HashCompletionItem } from '../shared/types';

const STATIC_ITEMS: HashCompletionItem[] = [
  { kind: 'codebase', label: '#codebase', token: '#codebase', detail: 'Reference the entire workspace' },
  { kind: 'errors', label: '#errors', token: '#errors', detail: 'Current diagnostics in the workspace' },
  { kind: 'selection', label: '#selection', token: '#selection', detail: 'Currently selected code in the active editor' },
];

/**
 * Resolve hash-style completion candidates for a `#` query inside a cell.
 * `query` is the text after the `#` (may be empty). We return up to 30 items.
 */
export async function resolveHashCompletions(query: string): Promise<HashCompletionItem[]> {
  const q = query.trim().toLowerCase();
  const items: HashCompletionItem[] = [];

  for (const item of STATIC_ITEMS) {
    if (q.length === 0 || item.label.toLowerCase().includes(q)) {
      items.push(item);
    }
  }

  // File search. Skip if query is short and starts with a builtin keyword to avoid noise.
  const fileQuery = q.startsWith('file:') ? q.slice('file:'.length) : q;
  if (fileQuery.length > 0 || q.length === 0) {
    const pattern = fileQuery.length === 0 ? '**/*' : `**/*${fileQuery}*`;
    try {
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 25);
      for (const uri of uris) {
        const rel = vscode.workspace.asRelativePath(uri, false);
        items.push({
          kind: 'file',
          label: rel.split('/').pop() ?? rel,
          token: `#file:${rel}`,
          detail: rel,
        });
      }
    } catch {
      // ignore
    }
  }

  return items.slice(0, 30);
}

/**
 * Expand hash tokens within a cell value when serializing for chat.
 * For now we just keep the token as-is, since downstream chat hosts (Copilot, Claude Code)
 * interpret `#file:…`, `#codebase`, etc. natively. We surface a resolved string list as a
 * side-channel on the snapshot so the LM tool can include resolved content if it wants.
 */
export function extractHashTokens(text: string): string[] {
  const matches = text.matchAll(/#(?:file|symbol):[^\s,;]+|#(?:codebase|errors|selection)/g);
  const out: string[] = [];
  for (const m of matches) out.push(m[0]);
  return out;
}
