import * as assert from 'node:assert/strict';
import { GridSnapshot, Row } from '../../shared/types';
import {
  evaluateStopConditions,
  proposeReplan,
  verifyCompleteness,
} from '../../extension/verify/evaluate';

const COLS = [{ id: 'c_task', name: 'Task', type: 'text' as const }];
function snap(rows: Row[], budget?: GridSnapshot['budget']): GridSnapshot {
  return { kind: 'workflow', columns: COLS, rows, budget };
}
function row(id: string, status: Row['work'] extends infer W ? string : never, opts: Partial<NonNullable<Row['work']>> = {}): Row {
  return { id, cells: { c_task: id }, work: { status: status as never, ...opts } };
}

describe('verify/evaluate (VMAO core)', () => {
  describe('verifyCompleteness', () => {
    it('scores completeness over non-verifier rows and collects unmet criteria', () => {
      const s = snap([
        row('t1', 'done'),
        row('t2', 'pending'),
        { id: 'v1', cells: { c_task: 'criteria check' }, work: { status: 'failed', role: 'verifier', outputs: 'missing tests' } },
      ]);
      const v = verifyCompleteness(s);
      assert.equal(v.tasksTotal, 2);
      assert.equal(v.tasksDone, 1);
      assert.equal(v.completeness, 0.5);
      assert.equal(v.verifiersTotal, 1);
      assert.equal(v.unmetCriteria.length, 1);
      assert.equal(v.unmetCriteria[0].detail, 'missing tests');
    });
  });

  describe('evaluateStopConditions', () => {
    it('does not stop while a verifier reports a gap (replan instead)', () => {
      const s = snap([
        row('t1', 'done'),
        { id: 'v1', cells: { c_task: 'v' }, work: { status: 'failed', role: 'verifier' } },
      ]);
      const r = evaluateStopConditions(s);
      assert.equal(r.stop, false);
      assert.match(r.reason!, /replan/);
    });

    it('stops when all tasks are complete and verifiers pass', () => {
      const s = snap([
        row('t1', 'done'),
        { id: 'v1', cells: { c_task: 'v' }, work: { status: 'done', role: 'verifier' } },
      ]);
      const r = evaluateStopConditions(s);
      assert.equal(r.stop, true);
      assert.match(r.reason!, /complete and verified/);
    });

    it('stops when the budget is exhausted regardless of completeness', () => {
      const s = snap(
        [row('t1', 'done', { usage: { costUsd: 9, totalTokens: 10 }, history: [{ id: 'r', status: 'done', usage: { costUsd: 9, totalTokens: 10 } }] }), row('t2', 'pending')],
        { maxCostUsd: 5 },
      );
      const r = evaluateStopConditions(s);
      assert.equal(r.stop, true);
      assert.match(r.reason!, /budget/);
    });

    it('does not stop mid-flight when incomplete and within budget', () => {
      const s = snap([row('t1', 'done'), row('t2', 'pending')]);
      assert.equal(evaluateStopConditions(s).stop, false);
    });
  });

  describe('proposeReplan', () => {
    it('emits one gap-filling task per failed verifier, keyed by the title column', () => {
      const s = snap([
        row('t1', 'done'),
        { id: 'v1', cells: { c_task: 'tests present?' }, work: { status: 'failed', role: 'verifier', outputs: 'no tests for auth' } },
      ]);
      const replan = proposeReplan(s);
      assert.equal(replan.length, 1);
      assert.match(String(replan[0].Task), /Fix: tests present\?/);
      assert.match(String(replan[0].inputs), /no tests for auth/);
    });

    it('emits nothing when no verifier failed', () => {
      const s = snap([row('t1', 'done'), { id: 'v1', cells: { c_task: 'v' }, work: { status: 'done', role: 'verifier' } }]);
      assert.deepEqual(proposeReplan(s), []);
    });
  });
});
