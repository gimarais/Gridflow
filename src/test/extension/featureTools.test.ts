import * as assert from 'node:assert/strict';
import { GridSnapshot } from '../../shared/types';
import { saveWorkflow } from '../../extension/workflowStore';
import { FEATURE_MCP_TOOLS } from '../../extension/featureTools';
import { verifyTool, evaluateStop } from '../../extension/verify';
import { suggestModelToolDef } from '../../extension/advisor';
import { clearWorkflowDir, requireWorkspace } from '../helpers';

describe('feature MCP tools (integration through real persistence)', () => {
  before(() => requireWorkspace());
  beforeEach(() => clearWorkflowDir());
  after(() => clearWorkflowDir());

  it('contributes the three feature MCP tools', () => {
    const names = FEATURE_MCP_TOOLS.map((t) => (t.schema as { name: string }).name).sort();
    assert.deepEqual(names, ['gridflow_projectMemory', 'gridflow_suggestModel', 'gridflow_verifyWorkflow']);
  });

  it('gridflow_verifyWorkflow scores completeness and applies a replan', async () => {
    const snapshot: GridSnapshot = {
      kind: 'workflow',
      columns: [{ id: 'c_task', name: 'Task', type: 'text' }],
      rows: [
        { id: 't1', cells: { c_task: 'implement' }, work: { status: 'done' } },
        { id: 'v1', cells: { c_task: 'tests cover auth?' }, work: { status: 'failed', role: 'verifier', outputs: 'no auth tests' } },
      ],
    };
    await saveWorkflow('verify-it', snapshot);

    const verdict = JSON.parse(await verifyTool.handler({ workflowId: 'verify-it', applyReplan: true }));
    assert.equal(verdict.completeness, 1, '1/1 non-verifier task done');
    assert.equal(verdict.unmetCriteria.length, 1);
    assert.equal(verdict.recommendation, 'continue');
    assert.equal(verdict.replanAddedRowIds.length, 1, 'a gap-filling row was appended');
  });

  it('gridflow_suggestModel recommends from history; evaluateStop reflects budget', async () => {
    const snapshot: GridSnapshot = {
      kind: 'workflow',
      budget: { maxCostUsd: 5 },
      columns: [{ id: 'c_task', name: 'Task', type: 'text' }],
      rows: [
        { id: 'a', cells: { c_task: 'a' }, work: { status: 'done', model: 'claude-haiku-4-5', history: [{ id: 'r1', status: 'done', model: 'claude-haiku-4-5', usage: { costUsd: 0.01 } }] } },
        { id: 'b', cells: { c_task: 'b' }, work: { status: 'pending' } },
      ],
    };
    await saveWorkflow('suggest-it', snapshot);

    const out = JSON.parse(await suggestModelToolDef.handler({ workflowId: 'suggest-it', rowId: 'b' }));
    assert.equal(out.suggestion.model, 'claude-haiku-4-5');

    // evaluateStop: not over budget here, tasks incomplete → don't stop.
    assert.equal(evaluateStop(snapshot).stop, false);
  });
});
