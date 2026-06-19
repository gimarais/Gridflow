import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { GridSnapshot, Row } from '../../shared/types';
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

    it('rejects an invalid status with a helpful message', async () => {
      await seed('badstatus', [{ id: 'r1', cells: { c_task: 'a' }, work: { status: 'pending' } }]);
      await assert.rejects(
        () => orch.updateRow({ workflowId: 'badstatus', rowId: 'r1', status: 'exploded' as never }),
        /Invalid status/,
      );
    });
  });

  describe('updateRow — parallel calls (the flagship orchestration path)', () => {
    it('persists every run when many rows are updated concurrently', async () => {
      const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
        id: `r${i}`,
        cells: { c_task: `task ${i}` },
        work: { status: 'pending' as const },
      }));
      await seed('parallel', rows);

      // Fire 10 unsynchronized updateRow calls — each is a full load-modify-write
      // of the same sidecar; without the per-slug lock most writes would be lost.
      await Promise.all(
        rows.map((r, i) =>
          orch.updateRow({
            workflowId: 'parallel', rowId: r.id, status: 'done',
            startedAt: T0, finishedAt: T1,
            usage: { costUsd: 0.01 * (i + 1), totalTokens: 10 },
          }),
        ),
      );

      const loaded = await loadWorkflow('parallel');
      for (const r of loaded!.rows) {
        assert.equal(r.work?.status, 'done', `${r.id} should be done`);
        assert.equal(r.work?.history?.length, 1, `${r.id} should have its run persisted`);
      }
      const totalCost = loaded!.rows.reduce((n, r) => n + (r.work?.usage?.costUsd ?? 0), 0);
      assert.ok(Math.abs(totalCost - 0.55) < 1e-9, `no run lost: total cost ${totalCost} should be 0.55`);
    });
  });

  describe('updateRow — provenance verification', () => {
    it('labels reported files verified/missing against the real filesystem', async () => {
      await seed('verify', [{ id: 'r1', cells: { c_task: 'a' }, work: { status: 'pending' } }]);

      // Write a real file inside the test workspace during the run window.
      const folder = vscode.workspace.workspaceFolders![0];
      const fileUri = vscode.Uri.joinPath(folder.uri, 'verify-me.txt');
      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode('evidence'));
      try {
        const now = Date.now();
        const res = JSON.parse(
          await orch.updateRow({
            workflowId: 'verify', rowId: 'r1', status: 'done',
            startedAt: new Date(now - 10_000).toISOString(),
            finishedAt: new Date(now).toISOString(),
            provenance: {
              filesModified: [{ path: 'verify-me.txt', change: 'created' }],
              filesRead: [{ path: 'this/file/does/not/exist.ts' }],
            },
          }),
        );
        assert.deepEqual(res.verification.filesModified, { total: 1, verified: 1, unverified: 0, missing: 0 });
        assert.deepEqual(res.verification.filesRead, { total: 1, verified: 0, missing: 1 });

        const loaded = await loadWorkflow('verify');
        const prov = loaded?.rows[0].work?.history?.[0].provenance;
        assert.equal(prov?.filesModified?.[0].verification, 'verified');
        assert.equal(prov?.filesRead?.[0].verification, 'missing');
      } finally {
        await vscode.workspace.fs.delete(fileUri);
      }
    });
  });

  describe('replayRow — single-node replay', () => {
    it('resets one finished row to pending, preserves history, returns resolved inputs', async () => {
      await seed('replay', [
        { id: 'a', cells: { c_task: 'research' }, work: { status: 'done', outputs: 'the findings' } },
        { id: 'b', cells: { c_task: 'build' }, work: { status: 'failed', inputs: 'use findings', dependsOn: ['a'], history: [{ id: 'run_x', status: 'failed' }] } },
      ]);

      const res = JSON.parse(await orch.replayRow({ workflowId: 'replay', rowId: 'b' }));
      assert.equal(res.status, 'pending');
      assert.equal(res.resolvedInputs.dependencyOutputs[0].outputs, 'the findings');
      assert.deepEqual(res.readyRowIds, ['b'], 'b is ready again (its dep is still done)');

      const loaded = await loadWorkflow('replay');
      const b = loaded!.rows.find((r) => r.id === 'b')!;
      assert.equal(b.work?.status, 'pending');
      assert.equal(b.work?.history?.length, 1, 'prior run preserved');
      assert.equal(loaded!.rows.find((r) => r.id === 'a')?.work?.status, 'done', 'upstream untouched');
    });

    it('applies a promptOverride', async () => {
      await seed('replay2', [{ id: 'r1', cells: { c_task: 'x' }, work: { status: 'failed', inputs: 'old' } }]);
      const res = JSON.parse(await orch.replayRow({ workflowId: 'replay2', rowId: 'r1', promptOverride: 'new prompt' }));
      assert.equal(res.resolvedInputs.inputs, 'new prompt');
      assert.equal((await loadWorkflow('replay2'))!.rows[0].work?.inputs, 'new prompt');
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

    it('drops cycle-creating dependencies and reports them in the response', async () => {
      await seed('addcycle', [{ id: 'r1', cells: { c_task: 'existing' }, work: { status: 'done' } }]);

      const res = JSON.parse(
        await orch.addRows({
          workflowId: 'addcycle',
          rows: [
            { Task: 'a', dependsOn: [1] }, // forward edge a → b
            { Task: 'b', dependsOn: [0] }, // would close the cycle — dropped
          ],
        }),
      );
      assert.equal(res.droppedDependencies.length, 1);
      assert.match(res.droppedDependencies[0], /cycle/);

      const loaded = await loadWorkflow('addcycle');
      const [a, b] = loaded!.rows.slice(1);
      assert.deepEqual(a.work?.dependsOn, [b.id]);
      assert.equal(b.work?.dependsOn, undefined);
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
