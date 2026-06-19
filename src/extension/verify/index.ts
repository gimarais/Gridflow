/**
 * Verifier module — VS Code wiring. Contributes the `gridflow_verifyWorkflow`
 * MCP tool (scores completeness, and on request appends a gap-filling sub-DAG)
 * and exposes the stop-condition evaluator to the extension.
 */
import type { GridSnapshot } from '../../shared/types';
import { buildRows } from '../../shared/workflowCore';
import { loadWorkflow, saveWorkflow, slugify, withWorkflowLock } from '../workflowStore';
import type { McpTool } from '../mcpTool';
import { evaluateStopConditions, proposeReplan, verifyCompleteness } from './evaluate';

const verifyWorkflowSchema = {
  name: 'gridflow_verifyWorkflow',
  description:
    'Independently scores a workflow against its verifier rows: returns completeness, unmet ' +
    'criteria (from failed verifier rows), and a recommended stop/continue decision. Pass applyReplan:true to ' +
    'automatically append a gap-filling sub-DAG (one task per unmet criterion) and have them dispatched next.',
  inputSchema: {
    type: 'object',
    required: ['workflowId'],
    properties: {
      workflowId: { type: 'string', description: 'The workflowId from gridflow_openWorkflow.' },
      applyReplan: { type: 'boolean', description: 'Append gap-filling task rows for each unmet criterion (default false).' },
    },
  },
};

async function verifyWorkflow(args: Record<string, unknown>): Promise<string> {
  const slug = slugify(String(args.workflowId ?? ''));
  return withWorkflowLock(slug, async () => {
    const snapshot = await loadWorkflow(slug);
    if (!snapshot) throw new Error(`Workflow "${slug}" not found.`);
    const verdict = verifyCompleteness(snapshot);
    const stop = evaluateStopConditions(snapshot);
    let addedRowIds: string[] | undefined;
    if (args.applyReplan === true && verdict.unmetCriteria.length > 0) {
      const replan = proposeReplan(snapshot);
      const built = buildRows(snapshot.columns, replan, snapshot.rows);
      const updated: GridSnapshot = { ...snapshot, rows: [...snapshot.rows, ...built.rows] };
      await saveWorkflow(slug, updated);
      addedRowIds = built.rows.map((r) => r.id);
    }
    return JSON.stringify(
      {
        ok: true,
        workflowId: slug,
        completeness: Number(verdict.completeness.toFixed(3)),
        tasksDone: verdict.tasksDone,
        tasksTotal: verdict.tasksTotal,
        verifiersPassed: verdict.verifiersPassed,
        verifiersTotal: verdict.verifiersTotal,
        unmetCriteria: verdict.unmetCriteria,
        recommendation: stop.stop ? 'stop' : 'continue',
        reason: stop.reason,
        replanAddedRowIds: addedRowIds,
      },
      null,
      2,
    );
  });
}

export const verifyTool: McpTool = { schema: verifyWorkflowSchema, handler: verifyWorkflow };

export function evaluateStop(snapshot: GridSnapshot): { stop: boolean; reason?: string } {
  return evaluateStopConditions(snapshot);
}
