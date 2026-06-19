import * as assert from 'node:assert/strict';
import { GridSnapshot, Row } from '../../shared/types';
import {
  applyRowUpdate,
  budgetStatus,
  buildFanOut,
  buildRows,
  criticalPath,
  deadlockedRowIds,
  dispatchPlan,
  executionWaves,
  fanOutSubstitute,
  fileRiskWarnings,
  isWorkflowComplete,
  validateWorkflow,
  prepareReplay,
  readyRowIds,
  readyRowsDetail,
  resolveRowInputs,
  riskyRows,
  staleRowIds,
  workflowStats,
  workflowToMarkdown,
  wouldCreateCycle,
} from '../../shared/workflowCore';
import { MAX_FILE_REFS } from '../../shared/sanitize';

const COLUMNS = [{ id: 'c_task', name: 'Task', type: 'text' as const }];

function snap(rows: Row[]): GridSnapshot {
  return { title: 'core', kind: 'workflow', columns: COLUMNS, rows };
}

describe('workflowCore', () => {
  describe('buildRows — dependency resolution', () => {
    it('resolves in-batch indices and existing row ids', () => {
      const existing: Row[] = [{ id: 'old1', cells: { c_task: 'x' }, work: { status: 'done' } }];
      const { rows, droppedDependencies } = buildRows(
        COLUMNS,
        [
          { Task: 'a' },
          { Task: 'b', dependsOn: [0, 'old1'] },
        ],
        existing,
      );
      assert.equal(droppedDependencies.length, 0);
      assert.deepEqual(rows[1].work?.dependsOn, [rows[0].id, 'old1']);
    });

    it('drops unknown dependency ids and reports them', () => {
      const { rows, droppedDependencies } = buildRows(COLUMNS, [{ Task: 'a', dependsOn: ['ghost', 99] }]);
      assert.equal(rows[0].work?.dependsOn, undefined);
      assert.equal(droppedDependencies.length, 2);
    });

    it('rejects in-batch edges that would close a cycle', () => {
      const { rows, droppedDependencies } = buildRows(COLUMNS, [
        { Task: 'a', dependsOn: [1] }, // forward edge a → b
        { Task: 'b', dependsOn: [0] }, // would close b → a → b
      ]);
      assert.deepEqual(rows[0].work?.dependsOn, [rows[1].id]);
      assert.equal(rows[1].work?.dependsOn, undefined);
      assert.equal(droppedDependencies.length, 1);
      assert.match(droppedDependencies[0], /cycle/);
    });

    it('rejects self-dependencies', () => {
      const { rows, droppedDependencies } = buildRows(COLUMNS, [{ Task: 'a', dependsOn: [0] }]);
      assert.equal(rows[0].work?.dependsOn, undefined);
      assert.equal(droppedDependencies.length, 1);
    });
  });

  describe('file-risk gate (G7-basic)', () => {
    const withFailedFile = (): GridSnapshot => snap([
      {
        id: 'a', cells: { c_task: 'first attempt' },
        work: {
          status: 'failed',
          history: [{ id: 'run1', status: 'failed', provenance: { filesModified: [{ path: 'src/flaky.ts', change: 'modified' }] } }],
        },
      },
      { id: 'b', cells: { c_task: 'retry on src/flaky.ts' }, work: { status: 'pending' } },
      { id: 'c', cells: { c_task: 'unrelated work' }, work: { status: 'pending' } },
    ]);

    it('warns when a row references a file a prior failed run touched', () => {
      const w = fileRiskWarnings(withFailedFile(), 'b');
      assert.equal(w.length, 1);
      assert.match(w[0], /src\/flaky\.ts.*failed run/);
    });

    it('does not warn for rows that do not reference the failed file', () => {
      assert.deepEqual(fileRiskWarnings(withFailedFile(), 'c'), []);
    });

    it('riskyRows lists only ready rows with warnings', () => {
      const risky = riskyRows(withFailedFile());
      assert.deepEqual(risky.map((r) => r.rowId), ['b']);
    });
  });

  describe('fan-out / map (G6)', () => {
    it('fanOutSubstitute replaces {{item}} for string items', () => {
      assert.equal(fanOutSubstitute('audit {{item}} now', 'src/a.ts'), 'audit src/a.ts now');
    });

    it('fanOutSubstitute replaces {{field}} for object items', () => {
      assert.equal(fanOutSubstitute('{{name}} → {{path}}', { name: 'auth', path: 'src/a.ts' }), 'auth → src/a.ts');
    });

    it('buildFanOut expands one template into N rows with substitution', () => {
      const cols = [{ id: 'c_task', name: 'Task', type: 'text' as const }];
      const { rows } = buildFanOut(
        cols,
        { Task: 'Audit {{item}}', agent: 'Explore', inputs: 'review {{item}}' },
        ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      );
      assert.equal(rows.length, 3);
      assert.equal(rows[0].cells.c_task, 'Audit src/a.ts');
      assert.equal(rows[1].work?.inputs, 'review src/b.ts');
      assert.equal(rows[2].work?.assignedAgent, 'Explore');
    });

    it('buildFanOut applies the template dependsOn (existing parent ids) to every row', () => {
      const cols = [{ id: 'c_task', name: 'Task', type: 'text' as const }];
      const existing: Row[] = [{ id: 'parent', cells: { c_task: 'gather' }, work: { status: 'done' } }];
      const { rows } = buildFanOut(cols, { Task: '{{item}}', dependsOn: ['parent'] }, ['x', 'y'], existing);
      assert.deepEqual(rows[0].work?.dependsOn, ['parent']);
      assert.deepEqual(rows[1].work?.dependsOn, ['parent']);
    });
  });

  describe('DAG helpers', () => {
    it('wouldCreateCycle detects transitive reachability', () => {
      const deps = new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', []],
      ]);
      assert.equal(wouldCreateCycle(deps, 'c', 'a'), true, 'c→a closes a→b→c');
      assert.equal(wouldCreateCycle(deps, 'a', 'c'), false);
      assert.equal(wouldCreateCycle(deps, 'a', 'a'), true, 'self-edge');
    });

    it('deadlockedRowIds finds cycle members and their downstream rows', () => {
      const rows: Row[] = [
        { id: 'a', cells: {}, work: { status: 'pending', dependsOn: ['b'] } },
        { id: 'b', cells: {}, work: { status: 'pending', dependsOn: ['a'] } },
        { id: 'c', cells: {}, work: { status: 'pending', dependsOn: ['b'] } }, // downstream of the cycle
        { id: 'd', cells: {}, work: { status: 'pending' } },
      ];
      assert.deepEqual(deadlockedRowIds(rows).sort(), ['a', 'b', 'c']);
    });

    it('readyRowIds treats dangling dependency ids as satisfied', () => {
      const s = snap([
        { id: 'r1', cells: {}, work: { status: 'pending', dependsOn: ['deleted-row'] } },
      ]);
      assert.deepEqual(readyRowIds(s), ['r1']);
    });
  });

  describe('validation & execution plan (G10)', () => {
    it('validateWorkflow flags cycles as errors and missing deps / no-budget as warnings', () => {
      const s = snap([
        { id: 'a', cells: { c_task: 'a' }, work: { status: 'pending', dependsOn: ['b'] } },
        { id: 'b', cells: { c_task: 'b' }, work: { status: 'pending', dependsOn: ['a'] } },
        { id: 'c', cells: { c_task: 'c' }, work: { status: 'pending', dependsOn: ['ghost'] } },
      ]);
      const v = validateWorkflow(s);
      assert.ok(v.errors.some((e) => /cycle/.test(e)), 'cycle is an error');
      assert.ok(v.warnings.some((w) => /missing row/.test(w)), 'dangling dep is a warning');
      assert.ok(v.warnings.some((w) => /no budget/.test(w)), 'no budget is a warning');
    });

    it('validateWorkflow is clean for a valid budgeted workflow', () => {
      const s: GridSnapshot = {
        ...snap([
          { id: 'a', cells: { c_task: 'a' }, work: { status: 'done' } },
          { id: 'b', cells: { c_task: 'b' }, work: { status: 'pending', dependsOn: ['a'] } },
        ]),
        budget: { maxCostUsd: 5 },
      };
      const v = validateWorkflow(s);
      assert.deepEqual(v.errors, []);
      assert.deepEqual(v.warnings, []);
    });

    it('executionWaves groups rows into parallel topological waves', () => {
      const s = snap([
        { id: 'a', cells: {}, work: { status: 'pending' } },
        { id: 'b', cells: {}, work: { status: 'pending', dependsOn: ['a'] } },
        { id: 'c', cells: {}, work: { status: 'pending', dependsOn: ['a'] } },
        { id: 'd', cells: {}, work: { status: 'pending', dependsOn: ['b', 'c'] } },
      ]);
      const waves = executionWaves(s);
      assert.deepEqual(waves[0], ['a']);
      assert.deepEqual(waves[1].sort(), ['b', 'c']);
      assert.deepEqual(waves[2], ['d']);
    });

    it('executionWaves omits rows trapped in a cycle', () => {
      const s = snap([
        { id: 'a', cells: {}, work: { status: 'pending' } },
        { id: 'x', cells: {}, work: { status: 'pending', dependsOn: ['y'] } },
        { id: 'y', cells: {}, work: { status: 'pending', dependsOn: ['x'] } },
      ]);
      const scheduled = executionWaves(s).flat();
      assert.deepEqual(scheduled, ['a']);
    });
  });

  describe('critical path (G9-basic)', () => {
    function timed(id: string, ms: number, deps?: string[]): Row {
      return {
        id, cells: {},
        work: { status: 'done', dependsOn: deps, history: [{ id: `run_${id}`, status: 'done', durationMs: ms }] },
      };
    }

    it('picks the longest weighted dependency chain', () => {
      // a(100) → b(50) → d(200) ; a(100) → c(500) ; longest is a→c = 600.
      const s = snap([
        timed('a', 100),
        timed('b', 50, ['a']),
        timed('c', 500, ['a']),
        timed('d', 200, ['b']),
      ]);
      const cp = criticalPath(s);
      assert.equal(cp.durationMs, 600);
      assert.deepEqual(cp.rowIds, ['a', 'c']);
    });

    it('handles independent (parallel) rows — longest single node wins', () => {
      const s = snap([timed('a', 300), timed('b', 100)]);
      const cp = criticalPath(s);
      assert.equal(cp.durationMs, 300);
      assert.deepEqual(cp.rowIds, ['a']);
    });

    it('is cycle-safe (a dependency cycle does not hang)', () => {
      const s = snap([
        { id: 'x', cells: {}, work: { status: 'pending', dependsOn: ['y'], history: [{ id: 'r', status: 'done', durationMs: 10 }] } },
        { id: 'y', cells: {}, work: { status: 'pending', dependsOn: ['x'], history: [{ id: 'r2', status: 'done', durationMs: 10 }] } },
      ]);
      const cp = criticalPath(s);
      assert.ok(cp.durationMs >= 10, 'returns a finite result without infinite recursion');
    });
  });

  describe('budget (G3-basic)', () => {
    function spent(costUsd: number, tokens: number): Row {
      return {
        id: 'r1', cells: {},
        work: { status: 'done', usage: { costUsd, totalTokens: tokens }, history: [{ id: 'run1', status: 'done', usage: { costUsd, totalTokens: tokens } }] },
      };
    }

    it('budgetStatus reports usage, remaining, and exceeded against caps', () => {
      const s: GridSnapshot = { ...snap([spent(3, 1000)]), budget: { maxCostUsd: 5, maxTokens: 2000 } };
      const b = budgetStatus(s);
      assert.equal(b.costUsed, 3);
      assert.equal(b.tokensUsed, 1000);
      assert.equal(b.exceeded, false);
      assert.equal(b.remainingCostUsd, 2);
      assert.equal(b.remainingTokens, 1000);
    });

    it('flags exceeded when the cost cap is passed', () => {
      const s: GridSnapshot = { ...snap([spent(6, 100)]), budget: { maxCostUsd: 5 } };
      assert.equal(budgetStatus(s).exceeded, true);
    });

    it('flags exceeded when the token cap is passed', () => {
      const s: GridSnapshot = { ...snap([spent(0.1, 5000)]), budget: { maxTokens: 2000 } };
      assert.equal(budgetStatus(s).exceeded, true);
    });

    it('dispatchPlan halts dispatch when the budget is spent', () => {
      const pending: Row = { id: 'r2', cells: {}, work: { status: 'pending' } };
      const over: GridSnapshot = { ...snap([spent(6, 100), pending]), budget: { maxCostUsd: 5 } };
      const plan = dispatchPlan(over);
      assert.deepEqual(plan.readyRowIds, [], 'no rows dispatched over budget');
      assert.equal(plan.budgetExceeded, true);

      const under: GridSnapshot = { ...snap([spent(1, 100), pending]), budget: { maxCostUsd: 5 } };
      assert.deepEqual(dispatchPlan(under).readyRowIds, ['r2'], 'dispatch resumes under budget');
    });

    it('dispatchPlan is unaffected when no budget is set', () => {
      const s = snap([{ id: 'r1', cells: {}, work: { status: 'pending' } }]);
      assert.deepEqual(dispatchPlan(s).readyRowIds, ['r1']);
      assert.equal(dispatchPlan(s).budgetExceeded, false);
    });
  });

  describe('edge-state propagation & replay (G1 + G2)', () => {
    const dag = () => snap([
      { id: 'a', cells: { c_task: 'Research' }, work: { status: 'done', outputs: 'found the auth module' } },
      { id: 'b', cells: { c_task: 'Implement' }, work: { status: 'pending', inputs: 'use the research', dependsOn: ['a'] } },
    ]);

    it('resolveRowInputs returns own inputs + dependency outputs', () => {
      const r = resolveRowInputs(dag(), 'b');
      assert.equal(r.inputs, 'use the research');
      assert.deepEqual(r.dependencyOutputs, [{ rowId: 'a', title: 'Research', outputs: 'found the auth module' }]);
    });

    it('readyRowsDetail attaches resolved inputs to each ready row', () => {
      const detail = readyRowsDetail(dag());
      assert.deepEqual(detail.map((d) => d.id), ['b']);
      assert.equal(detail[0].dependencyOutputs?.[0].outputs, 'found the auth module');
    });

    it('applyRowUpdate captures resolvedInputs when a run opens', () => {
      const res = applyRowUpdate(dag(), { workflowId: 'w', rowId: 'b', status: 'running' });
      const run = res.work.history?.[0];
      assert.equal(run?.resolvedInputs?.inputs, 'use the research');
      assert.equal(run?.resolvedInputs?.dependencyOutputs?.[0].outputs, 'found the auth module');
    });

    it('prepareReplay resets one row to pending, preserves history, returns resolved inputs', () => {
      // Give b a finished failed run first.
      const started = applyRowUpdate(dag(), { workflowId: 'w', rowId: 'b', status: 'running' });
      const failed = applyRowUpdate(started.snapshot, { workflowId: 'w', rowId: 'b', status: 'failed', outputs: 'boom' });
      const { snapshot: replayed, resolvedInputs } = prepareReplay(failed.snapshot, 'b');
      const b = replayed.rows.find((r) => r.id === 'b')!;
      assert.equal(b.work?.status, 'pending', 're-queued for the next pass');
      assert.equal(b.work?.history?.length, 1, 'history preserved');
      assert.equal(resolvedInputs.dependencyOutputs?.[0].outputs, 'found the auth module');
      // The upstream row is untouched.
      assert.equal(replayed.rows.find((r) => r.id === 'a')?.work?.status, 'done');
    });

    it('prepareReplay applies a prompt override', () => {
      const { snapshot: replayed, resolvedInputs } = prepareReplay(dag(), 'b', { promptOverride: 'try a different approach' });
      assert.equal(replayed.rows.find((r) => r.id === 'b')?.work?.inputs, 'try a different approach');
      assert.equal(resolvedInputs.inputs, 'try a different approach');
    });

    it('prepareReplay throws on an unknown row', () => {
      assert.throws(() => prepareReplay(dag(), 'nope'), /not found/);
    });
  });

  describe('staleRowIds', () => {
    it('flags running rows untouched past the threshold, not fresh ones', () => {
      const now = Date.now();
      const old = new Date(now - 31 * 60 * 1000).toISOString();
      const fresh = new Date(now - 60 * 1000).toISOString();
      const s = snap([
        { id: 'stale', cells: {}, work: { status: 'running', updatedAt: old } },
        { id: 'fresh', cells: {}, work: { status: 'running', updatedAt: fresh } },
        { id: 'idle', cells: {}, work: { status: 'pending', updatedAt: old } },
      ]);
      assert.deepEqual(staleRowIds(s, now), ['stale']);
    });
  });

  describe('applyRowUpdate — validation and caps', () => {
    it('throws on an invalid status with the valid list in the message', () => {
      const s = snap([{ id: 'r1', cells: {}, work: { status: 'pending' } }]);
      assert.throws(
        () => applyRowUpdate(s, { workflowId: 'w', rowId: 'r1', status: 'exploded' as never }),
        /Invalid status .*pending, queued, running/,
      );
    });

    it('caps oversized provenance file lists', () => {
      const s = snap([{ id: 'r1', cells: {}, work: { status: 'pending' } }]);
      const filesRead = Array.from({ length: MAX_FILE_REFS + 100 }, (_, i) => ({ path: `f${i}.ts` }));
      const result = applyRowUpdate(s, {
        workflowId: 'w', rowId: 'r1', status: 'done', provenance: { filesRead },
      });
      const run = result.work.history?.[0];
      assert.equal(run?.provenance?.filesRead?.length, MAX_FILE_REFS);
    });

    it('drops cycle-creating dependsOn changes and reports them', () => {
      const s = snap([
        { id: 'a', cells: {}, work: { status: 'pending' } },
        { id: 'b', cells: {}, work: { status: 'pending', dependsOn: ['a'] } },
      ]);
      const result = applyRowUpdate(s, {
        workflowId: 'w', rowId: 'a', status: 'pending', dependsOn: ['b', 'ghost'],
      });
      assert.deepEqual(result.work.dependsOn, []);
      assert.equal(result.droppedDependencies.length, 2);
    });

    it('estimates costUsd from reported tokens when the model is known', () => {
      const s = snap([{ id: 'r1', cells: {}, work: { status: 'pending' } }]);
      const result = applyRowUpdate(s, {
        workflowId: 'w', rowId: 'r1', status: 'done', model: 'claude-opus-4-8',
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      });
      // $5/MTok input on claude-opus-4-8.
      assert.equal(result.work.history?.[0].usage?.costUsd, 5);
      assert.equal(result.totalCostUsd, 5);
    });

    it('never overwrites an agent-reported costUsd with an estimate', () => {
      const s = snap([{ id: 'r1', cells: {}, work: { status: 'pending' } }]);
      const result = applyRowUpdate(s, {
        workflowId: 'w', rowId: 'r1', status: 'done', model: 'claude-opus-4-8',
        usage: { inputTokens: 1_000_000, costUsd: 1.23 },
      });
      assert.equal(result.work.history?.[0].usage?.costUsd, 1.23);
    });

    it('always computes durationMs from started/finished timestamps, ignoring any agent-reported value', () => {
      const s = snap([{ id: 'r1', cells: {}, work: { status: 'pending' } }]);
      const started = applyRowUpdate(s, {
        workflowId: 'w', rowId: 'r1', status: 'running', startedAt: '2026-06-02T10:00:00.000Z',
      });
      const finished = applyRowUpdate(started.snapshot, {
        workflowId: 'w', rowId: 'r1', status: 'done', finishedAt: '2026-06-02T10:00:01.500Z',
        // @ts-expect-error durationMs is not part of UpdateRowInput; agents should not send it.
        durationMs: 999999,
      });
      assert.equal(finished.work.history?.[0].durationMs, 1500);
    });
  });

  describe('aggregates', () => {
    it('workflowStats sums status counts, cost, tokens, and duration', () => {
      const s = snap([
        {
          id: 'r1', cells: {},
          work: {
            status: 'done',
            usage: { costUsd: 0.5, totalTokens: 100 },
            history: [{ id: 'run1', status: 'done', durationMs: 1500 }],
          },
        },
        { id: 'r2', cells: {}, work: { status: 'failed' } },
        { id: 'r3', cells: {}, work: { status: 'running' } },
      ]);
      const stats = workflowStats(s);
      assert.equal(stats.total, 3);
      assert.equal(stats.done, 1);
      assert.equal(stats.failed, 1);
      assert.equal(stats.running, 1);
      assert.equal(stats.totalCostUsd, 0.5);
      assert.equal(stats.totalTokens, 100);
      assert.equal(stats.totalDurationMs, 1500);
    });

    it('wallClockDurationMs merges overlapping runs but totalDurationMs sums them independently', () => {
      // r1 ran 0-10s, r2 ran 5-15s (overlap 5-10s) — wall clock is 0-15s = 15s.
      const s = snap([
        { id: 'r1', cells: {}, work: { status: 'done', history: [{
          id: 'run1', status: 'done', startedAt: '2026-06-02T10:00:00.000Z', finishedAt: '2026-06-02T10:00:10.000Z', durationMs: 10000,
        }] } },
        { id: 'r2', cells: {}, work: { status: 'done', history: [{
          id: 'run2', status: 'done', startedAt: '2026-06-02T10:00:05.000Z', finishedAt: '2026-06-02T10:00:15.000Z', durationMs: 10000,
        }] } },
      ]);
      const stats = workflowStats(s);
      assert.equal(stats.totalDurationMs, 20000, 'sum of both runs, as if sequential');
      assert.equal(stats.wallClockDurationMs, 15000, 'actual elapsed time, overlap counted once');
    });

    it('wallClockDurationMs counts a still-running run up to "now"', () => {
      const now = Date.parse('2026-06-02T10:00:30.000Z');
      const s = snap([
        { id: 'r1', cells: {}, work: { status: 'running', history: [{
          id: 'run1', status: 'running', startedAt: '2026-06-02T10:00:00.000Z',
        }] } },
      ]);
      const stats = workflowStats(s, now);
      assert.equal(stats.totalDurationMs, 30000);
      assert.equal(stats.wallClockDurationMs, 30000);
    });

    it('isWorkflowComplete requires every row terminal and at least one row', () => {
      assert.equal(isWorkflowComplete(snap([])), false);
      assert.equal(isWorkflowComplete(snap([{ id: 'a', cells: {}, work: { status: 'done' } }])), true);
      assert.equal(
        isWorkflowComplete(snap([
          { id: 'a', cells: {}, work: { status: 'done' } },
          { id: 'b', cells: {}, work: { status: 'running' } },
        ])),
        false,
      );
    });
  });

  describe('workflowToMarkdown', () => {
    it('renders the summary, the table, and verification badges', () => {
      const s = snap([
        {
          id: 'r1', cells: { c_task: 'Implement auth' },
          work: {
            status: 'done',
            assignedAgent: 'claude',
            usage: { costUsd: 0.25, totalTokens: 1000 },
            history: [{
              id: 'run1', status: 'done', durationMs: 2000,
              provenance: {
                filesModified: [{ path: 'src/auth.ts', verification: 'verified' }],
                filesRead: [{ path: 'src/ghost.ts', verification: 'missing' }],
              },
            }],
          },
        },
      ]);
      const md = workflowToMarkdown('auth', s);
      assert.match(md, /# Workflow report: core/);
      assert.match(md, /\*\*1\/1 done\*\*/);
      assert.match(md, /\| 1 \| Implement auth \| done \| claude \|/);
      assert.match(md, /`src\/auth\.ts` ✓/);
      assert.match(md, /`src\/ghost\.ts` ✗ \(missing\)/);
    });
  });
});
