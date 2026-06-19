/**
 * Governance module — VS Code wiring. Contributes `gridflow_projectMemory`,
 * which aggregates file-failure history across ALL workflows in the workspace
 * and flags repo-wide risk for a row (or every ready row).
 */
import { readyRowIds } from '../../shared/workflowCore';
import { listWorkflows, loadWorkflow, slugify } from '../workflowStore';
import type { GridSnapshot } from '../../shared/types';
import type { McpTool } from '../mcpTool';
import { aggregateFailedFiles, projectRiskWarnings, rowHaystack } from './evaluate';

const projectMemorySchema = {
  name: 'gridflow_projectMemory',
  description:
    "Repo-wide governance memory: aggregates the file-failure history across EVERY workflow in " +
    ".gridflow/, then flags any row about to touch a file that has failed before — even in a different workflow. " +
    'Call before dispatching to avoid repeating a mistake the project already made. Omit rowId to check all ready rows.',
  inputSchema: {
    type: 'object',
    required: ['workflowId'],
    properties: {
      workflowId: { type: 'string', description: 'The workflowId from gridflow_openWorkflow.' },
      rowId: { type: 'string', description: 'Optional specific row to check; defaults to all ready rows.' },
    },
  },
};

async function loadAll(): Promise<GridSnapshot[]> {
  const slugs = await listWorkflows();
  const out: GridSnapshot[] = [];
  for (const slug of slugs) {
    const s = await loadWorkflow(slug);
    if (s) out.push(s);
  }
  return out;
}

async function projectMemory(args: Record<string, unknown>): Promise<string> {
  const slug = slugify(String(args.workflowId ?? ''));
  const snapshot = await loadWorkflow(slug);
  if (!snapshot) throw new Error(`Workflow "${slug}" not found.`);
  const failed = aggregateFailedFiles(await loadAll());

  const targetIds = typeof args.rowId === 'string' ? [args.rowId] : readyRowIds(snapshot);
  const riskyRows = targetIds
    .map((rowId) => ({ rowId, warnings: projectRiskWarnings(rowHaystack(snapshot, rowId), failed) }))
    .filter((r) => r.warnings.length > 0);

  return JSON.stringify(
    {
      ok: true,
      workflowId: slug,
      failedFilesTracked: failed.size,
      riskyRows,
      note: riskyRows.length ? undefined : 'No repo-wide file-failure risk detected for the checked rows.',
    },
    null,
    2,
  );
}

export const projectMemoryToolDef: McpTool = { schema: projectMemorySchema, handler: projectMemory };
