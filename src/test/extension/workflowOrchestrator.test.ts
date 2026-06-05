import * as assert from 'node:assert/strict';
import { GridSnapshot } from '../../shared/types';
import { WorkflowOrchestrator, workflowToText } from '../../extension/workflowOrchestrator';
import { loadWorkflow, saveWorkflow } from '../../extension/workflowStore';
import { clearWorkflowDir, requireWorkspace } from '../helpers';

/** updateRow/addRows/getWorkflow never touch the panel or extension context. */
function makeOrchestrator(): WorkflowOrchestrator {
  return new WorkflowOrchestrator(undefined as never, undefined as never);
}

const T0 = '2026-06-02T10:00:00.000Z';
const T1 = '2026-06-02T10:00:01.500Z'; // +1500ms

function seed(slug: string, rows: GridSnapshot['rows']): Promise<void> {
  const snapshot: GridSnapshot = {
    title: slug,
    kind: 'workflow',
    columns: [{ id: 'c_task', name: 'Task', type: 'text' }],
    rows,
  };
  return saveWorkflow(slug, snapshot);
}

describe('WorkflowOrchestrator', () => {
  let orch: WorkflowOrchestrator;

  before(() => requireWorkspace());
  beforeEach(async () => {
    await clearWorkflowDir();
    orch = makeOrchestrator();
  });
  after(() => clearWorkflowDir());

  describe('updateRow — run lifecycle', () => {
    it('opens one run on running and finalizes it on done, computing durationMs', async () => {
      await seed('lifecycle', [{ id: 'r1', cells: { c_task: 'a' }, work: { status: 'pending' } }]);

      await orch.updateRow({ workflowId: 'lifecycle', rowId: 'r1', status: 'running', startedAt: T0 });
      const doneRes = JSON.parse(
        await orch.updateRow({ workflowId: 'lifecycle', rowId: 'r1', status: 'done', finishedAt: T1 }),
      );

      assert.equal(doneRes.status, 'done');
      assert.equal(doneRes.runsTotal, 1, 'a single execution is one run, not one-per-call');
      assert.equal(doneRes.durationMs, 1500);

      const loaded = await loadWorkflow('lifecycle');
      const run = loaded?.rows[0].work?.history?.[0];
      assert.equal(loaded?.rows[0].work?.status, 'done');
      assert.equal(run?.durationMs, 1500);
      assert.equal(run?.startedAt, T0);
      assert.equal(run?.finishedAt, T1);
    });

    it('aggregates cost and tokens across separate executions', async () => {
      await seed('aggregate', [{ id: 'r1', cells: { c_task: 'a' }, work: { status: 'pending' } }]);

      // Execution 1
      await orch.updateRow({ workflowId: 'aggregate', rowId: 'r1', status: 'running', startedAt: T0 });
      await orch.updateRow({
        workflowId: 'aggregate', rowId: 'r1', status: 'done', finishedAt: T1,
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      });
      // Execution 2 (a fresh run because the previous one is finalized)
      await orch.updateRow({ workflowId: 'aggregate', rowId: 'r1', status: 'running', startedAt: T0 });
      const res = JSON.parse(
        await orch.updateRow({
          workflowId: 'aggregate', rowId: 'r1', status: 'done', finishedAt: T1,
          usage: { totalTokens: 200, costUsd: 0.02 },
        }),
      );

      assert.equal(res.runsTotal, 2);
      assert.ok(Math.abs(res.totalCostUsd - 0.03) < 1e-9);
      // Run 1 contributes input+output (150) since it had no totalTokens; run 2 contributes 200.
      assert.equal(res.totalTokens, 350);
    });

    it('rejects an unknown workflow or row', async () => {
      await seed('present', [{ id: 'r1', cells: { c_task: 'a' }, work: { status: 'pending' } }]);
      await assert.rejects(() => orch.updateRow({ workflowId: 'missing', rowId: 'r1', status: 'done' }), /not found/);
      await assert.rejects(() => orch.updateRow({ workflowId: 'present', rowId: 'nope', status: 'done' }), /not found/);
    });
  });

  describe('readyRowIds — the dependency DAG', () => {
    it('only surfaces rows whose dependencies are all done', async () => {
      await seed('dag', [
        { id: 'r1', cells: { c_task: 'first' }, work: { status: 'pending' } },
        { id: 'r2', cells: { c_task: 'second' }, work: { status: 'pending', dependsOn: ['r1'] } },
      ]);

      // Before anything runs, only the dependency-free row is ready.
      const initial = JSON.parse(await orch.getWorkflow({ workflowId: 'dag' }));
      assert.deepEqual(initial.readyRowIds, ['r1']);

      // While r1 runs, nothing is ready (r1 is no longer pending; r2 still blocked).
      const running = JSON.parse(
        await orch.updateRow({ workflowId: 'dag', rowId: 'r1', status: 'running', startedAt: T0 }),
      );
      assert.deepEqual(running.readyRowIds, []);

      // Once r1 is done, r2 unblocks.
      const done = JSON.parse(
        await orch.updateRow({ workflowId: 'dag', rowId: 'r1', status: 'done', finishedAt: T1 }),
      );
      assert.deepEqual(done.readyRowIds, ['r2']);
    });
  });

  describe('addRows', () => {
    it('appends rows and resolves dependsOn indices to the new row ids', async () => {
      await seed('addrows', [{ id: 'r1', cells: { c_task: 'existing' }, work: { status: 'done' } }]);

      await orch.addRows({
        workflowId: 'addrows',
        rows: [
          { Task: 'new-a', agent: 'Explore' },
          { Task: 'new-b', dependsOn: [0] },
        ],
      });

      const loaded = await loadWorkflow('addrows');
      assert.equal(loaded?.rows.length, 3);
      const [a, b] = loaded!.rows.slice(1);
      assert.equal(a.cells.c_task, 'new-a');
      assert.equal(a.work?.assignedAgent, 'Explore');
      // dependsOn:[0] referenced the first row of THIS batch -> a's id.
      assert.deepEqual(b.work?.dependsOn, [a.id]);
    });
  });

  describe('workflowToText (pure serialization)', () => {
    it('marks ready rows and lists readyRowIds without any disk access', () => {
      const snapshot: GridSnapshot = {
        title: 'pure',
        kind: 'workflow',
        columns: [{ id: 'c_task', name: 'Task', type: 'text' }],
        rows: [
          { id: 'r1', cells: { c_task: 'a' }, work: { status: 'done' } },
          { id: 'r2', cells: { c_task: 'b' }, work: { status: 'pending', dependsOn: ['r1'] } },
          { id: 'r3', cells: { c_task: 'c' }, work: { status: 'pending', dependsOn: ['r2'] } },
        ],
      };

      const out = JSON.parse(workflowToText('pure', snapshot, 'current'));
      assert.equal(out.state, 'current');
      assert.equal(out.workflowId, 'pure');
      assert.deepEqual(out.readyRowIds, ['r2']); // r1 done, r3 still blocked by r2
      const byId = Object.fromEntries(out.rows.map((r: { id: string }) => [r.id, r]));
      assert.equal(byId.r1.ready, false);
      assert.equal(byId.r2.ready, true);
      assert.equal(byId.r3.ready, false);
      // Cells are keyed by column NAME in the agent-facing payload.
      assert.equal(byId.r1.cells.Task, 'a');
    });
  });
});
