/**
 * Model advisor — VS Code wiring. Contributes the `gridflow_suggestModel` MCP
 * tool plus the `suggestModel` helper.
 */
import type { GridSnapshot } from '../../shared/types';
import { loadWorkflow, slugify } from '../workflowStore';
import type { McpTool } from '../mcpTool';
import { ModelSuggestion, scoreModels, suggestModel as suggestModelPure } from './evaluate';

const suggestModelSchema = {
  name: 'gridflow_suggestModel',
  description:
    'Recommends a model for a workflow row based on the workflow\'s own run history — the model with ' +
    'the best success rate (then cheaper, then faster). Returns the full per-model scoreboard plus a suggestion. ' +
    'Call before dispatching an unassigned row to pick the most cost-effective capable model.',
  inputSchema: {
    type: 'object',
    required: ['workflowId'],
    properties: {
      workflowId: { type: 'string', description: 'The workflowId from gridflow_openWorkflow.' },
      rowId: { type: 'string', description: 'Optional row to tailor the suggestion to (excludes its current model).' },
    },
  },
};

async function suggestModelTool(args: Record<string, unknown>): Promise<string> {
  const slug = slugify(String(args.workflowId ?? ''));
  const snapshot = await loadWorkflow(slug);
  if (!snapshot) throw new Error(`Workflow "${slug}" not found.`);
  const rowId = typeof args.rowId === 'string' ? args.rowId : '';
  const suggestion = suggestModelPure(snapshot, rowId);
  return JSON.stringify(
    {
      ok: true,
      workflowId: slug,
      scoreboard: scoreModels(snapshot).sort((a, b) => b.successRate - a.successRate),
      suggestion: suggestion ?? null,
      note: suggestion ? undefined : 'No history yet, or the row already uses the top performer.',
    },
    null,
    2,
  );
}

export const suggestModelToolDef: McpTool = { schema: suggestModelSchema, handler: suggestModelTool };

export function suggestModel(snapshot: GridSnapshot, rowId: string): ModelSuggestion | undefined {
  return suggestModelPure(snapshot, rowId);
}
