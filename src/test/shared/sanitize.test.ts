import * as assert from 'node:assert/strict';
import {
  MAX_CELL_CHARS,
  MAX_LOGS,
  MAX_TOOL_CALLS,
  sanitizeFileRefs,
  sanitizeLogs,
  sanitizeProvenance,
  sanitizeSnapshot,
} from '../../shared/sanitize';

describe('sanitize', () => {
  describe('sanitizeSnapshot', () => {
    it('rejects values that are not snapshot-shaped', () => {
      assert.equal(sanitizeSnapshot(null), undefined);
      assert.equal(sanitizeSnapshot('hi'), undefined);
      assert.equal(sanitizeSnapshot([]), undefined);
      assert.equal(sanitizeSnapshot({ columns: 'nope', rows: [] }), undefined);
      assert.equal(sanitizeSnapshot({ columns: [], rows: {} }), undefined);
    });

    it('normalizes hostile column and row shapes instead of crashing', () => {
      const result = sanitizeSnapshot({
        kind: 'workflow',
        title: 42, // wrong type — dropped
        columns: [
          { id: 'c1', name: 'Task', type: 'text' },
          { id: 'c1', name: 'Dupe', type: 'text' }, // duplicate id — dropped
          { name: { evil: true }, type: 'rocket' }, // bad name/type — defaulted
          null,
          'garbage',
        ],
        rows: [
          { id: 'r1', cells: { c1: 'ok' }, work: { status: 'exploded', dependsOn: ['r2', 42, {}] } },
          { id: 'r1', cells: {} }, // duplicate row id — dropped
          null,
        ],
      });
      assert.ok(result);
      assert.equal(result!.title, undefined);
      assert.equal(result!.columns.length, 2);
      assert.equal(result!.columns[0].id, 'c1');
      assert.equal(result!.columns[1].type, 'text', 'unknown column type falls back to text');
      assert.equal(result!.rows.length, 1);
      assert.equal(result!.rows[0].work?.status, 'pending', 'unknown status falls back to pending');
      assert.deepEqual(result!.rows[0].work?.dependsOn, ['r2'], 'non-string deps dropped');
    });

    it('caps oversized cell strings', () => {
      const result = sanitizeSnapshot({
        columns: [{ id: 'c1', name: 'Task', type: 'text' }],
        rows: [{ id: 'r1', cells: { c1: 'x'.repeat(MAX_CELL_CHARS + 50) } }],
      });
      assert.equal((result!.rows[0].cells.c1 as string).length, MAX_CELL_CHARS);
    });

    it('coerces non-primitive cell values to empty strings', () => {
      const result = sanitizeSnapshot({
        columns: [{ id: 'c1', name: 'Task', type: 'text' }],
        rows: [{ id: 'r1', cells: { c1: { nested: 'object' } } }],
      });
      assert.equal(result!.rows[0].cells.c1, '');
    });
  });

  describe('sanitizeFileRefs', () => {
    it('accepts bare path strings and {path} objects, drops the rest', () => {
      const refs = sanitizeFileRefs(['a.ts', { path: 'b.ts', change: 'modified' }, { nope: 1 }, 42]);
      assert.deepEqual(refs?.map((r) => r.path), ['a.ts', 'b.ts']);
      assert.equal(refs?.[1].change, 'modified');
    });

    it('strips invalid change/kind/verification enums', () => {
      const refs = sanitizeFileRefs([{ path: 'a.ts', change: 'detonated', kind: 'bomb', verification: 'trust-me' }]);
      assert.equal(refs?.[0].change, undefined);
      assert.equal(refs?.[0].kind, undefined);
      assert.equal(refs?.[0].verification, undefined);
    });
  });

  describe('sanitizeProvenance / sanitizeLogs', () => {
    it('caps tool calls and logs', () => {
      const p = sanitizeProvenance({
        toolCalls: Array.from({ length: MAX_TOOL_CALLS + 10 }, (_, i) => ({ name: `t${i}` })),
      });
      assert.equal(p?.toolCalls?.length, MAX_TOOL_CALLS);

      const logs = sanitizeLogs(Array.from({ length: MAX_LOGS + 10 }, (_, i) => ({ message: `m${i}` })));
      assert.equal(logs?.length, MAX_LOGS);
    });

    it('returns undefined for empty or non-object provenance', () => {
      assert.equal(sanitizeProvenance(undefined), undefined);
      assert.equal(sanitizeProvenance({}), undefined);
      assert.equal(sanitizeProvenance('text'), undefined);
    });
  });
});
