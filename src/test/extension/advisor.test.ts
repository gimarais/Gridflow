import * as assert from 'node:assert/strict';
import { GridSnapshot, Row } from '../../shared/types';
import { scoreModels, suggestModel } from '../../extension/advisor/evaluate';

const COLS = [{ id: 'c_task', name: 'Task', type: 'text' as const }];
function snap(rows: Row[]): GridSnapshot {
  return { kind: 'workflow', columns: COLS, rows };
}

/** A row whose history pins a model with given outcomes. */
function runs(id: string, model: string, specs: { status: 'done' | 'failed'; costUsd?: number; durationMs?: number }[]): Row {
  return {
    id, cells: { c_task: id },
    work: {
      status: 'done', model,
      history: specs.map((s, i) => ({ id: `${id}_${i}`, status: s.status, model, usage: s.costUsd != null ? { costUsd: s.costUsd } : undefined, durationMs: s.durationMs })),
    },
  };
}

describe('advisor/evaluate (model scoring)', () => {
  describe('scoreModels', () => {
    it('aggregates runs, failures, success rate, avg cost & duration per model', () => {
      const s = snap([
        runs('a', 'claude-haiku-4-5', [{ status: 'done', costUsd: 0.01, durationMs: 1000 }, { status: 'done', costUsd: 0.03, durationMs: 2000 }]),
        runs('b', 'claude-opus-4-8', [{ status: 'failed', costUsd: 0.5, durationMs: 5000 }]),
      ]);
      const scores = Object.fromEntries(scoreModels(s).map((m) => [m.model, m]));
      assert.equal(scores['claude-haiku-4-5'].runs, 2);
      assert.equal(scores['claude-haiku-4-5'].successRate, 1);
      assert.equal(scores['claude-haiku-4-5'].avgCostUsd, 0.02);
      assert.equal(scores['claude-haiku-4-5'].avgDurationMs, 1500);
      assert.equal(scores['claude-opus-4-8'].successRate, 0);
      assert.equal(scores['claude-opus-4-8'].failures, 1);
    });
  });

  describe('suggestModel', () => {
    it('recommends the highest success-rate model', () => {
      const s = snap([
        runs('a', 'claude-haiku-4-5', [{ status: 'done', costUsd: 0.02 }, { status: 'done', costUsd: 0.02 }]),
        runs('b', 'claude-opus-4-8', [{ status: 'failed', costUsd: 0.5 }]),
        { id: 'c', cells: { c_task: 'next' }, work: { status: 'pending' } },
      ]);
      const sug = suggestModel(s, 'c');
      assert.equal(sug?.model, 'claude-haiku-4-5');
      assert.match(sug!.reason, /100% success over 2 runs/);
    });

    it('breaks ties on success rate by lower average cost', () => {
      const s = snap([
        runs('a', 'cheap-model', [{ status: 'done', costUsd: 0.01 }]),
        runs('b', 'pricey-model', [{ status: 'done', costUsd: 0.40 }]),
        { id: 'c', cells: { c_task: 'next' }, work: { status: 'pending' } },
      ]);
      assert.equal(suggestModel(s, 'c')?.model, 'cheap-model');
    });

    it('returns undefined when there is no history', () => {
      const s = snap([{ id: 'a', cells: { c_task: 'x' }, work: { status: 'pending' } }]);
      assert.equal(suggestModel(s, 'a'), undefined);
    });

    it('returns undefined when the row already uses the top performer', () => {
      const s = snap([
        runs('a', 'best', [{ status: 'done' }]),
        { id: 'c', cells: { c_task: 'next' }, work: { status: 'pending', model: 'best' } },
      ]);
      assert.equal(suggestModel(s, 'c'), undefined);
    });
  });
});
