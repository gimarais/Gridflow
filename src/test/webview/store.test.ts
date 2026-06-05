import * as assert from 'node:assert/strict';
import { GridSnapshot } from '../../shared/types';

// The webview store pushes mutations to the host via `post()`, which lazily calls
// `window.acquireVsCodeApi()`. There is no webview in the Extension Host, so we stub a
// no-op bridge before any host-pushing mutation runs. The store module itself touches
// `window` only inside post(), so importing it up top is safe.
import { store } from '../../webview/store';

function freshSnapshot(): GridSnapshot {
  return {
    title: 'Test',
    kind: 'workflow',
    columns: [
      { id: 'c_task', name: 'Task', type: 'text' },
      { id: 'c_done', name: 'Done', type: 'boolean' },
    ],
    rows: [
      { id: 'r1', cells: { c_task: 'first', c_done: false }, work: { status: 'pending' } },
      { id: 'r2', cells: { c_task: 'second', c_done: false }, work: { status: 'pending' } },
    ],
  };
}

function reset(snapshot = freshSnapshot()) {
  store.init(snapshot, 'workflow', true);
  store.clearSelection();
  store.clearFocus();
  store.collapseDetail();
  store.setStatusFilter('all');
}

describe('webview store', () => {
  before(() => {
    (globalThis as unknown as { window: unknown }).window = {
      acquireVsCodeApi: () => ({ postMessage() {}, setState() {}, getState: () => undefined }),
    };
  });
  beforeEach(() => reset());

  const rows = () => store.getState().snapshot.rows;
  const cols = () => store.getState().snapshot.columns;

  describe('cell + row mutations', () => {
    it('setCell updates a single cell immutably', () => {
      store.setCell('r1', 'c_task', 'edited');
      assert.equal(rows()[0].cells.c_task, 'edited');
      assert.equal(rows()[1].cells.c_task, 'second');
    });

    it('addRow appends a row carrying a work item in workflow mode', () => {
      store.addRow();
      assert.equal(rows().length, 3);
      assert.ok(rows()[2].work, 'workflow rows get a work item');
      assert.equal(rows()[2].work?.status, 'pending');
    });

    it('addRow(afterRowId) inserts directly after the target', () => {
      store.addRow('r1');
      assert.deepEqual(rows().map((r) => r.id).slice(0, 2), ['r1', rows()[1].id]);
      assert.equal(rows()[2].id, 'r2');
      assert.equal(rows().length, 3);
    });

    it('deleteRows removes rows and clears related selection/expansion', () => {
      store.toggleSelectRow('r1', false);
      store.expandRow('r1');
      store.deleteRows(['r1']);
      assert.deepEqual(rows().map((r) => r.id), ['r2']);
      assert.deepEqual(store.getState().selectedRowIds, []);
      assert.equal(store.getState().expandedRowId, null);
    });

    it('duplicateRow keeps intent but drops the execution trail', () => {
      reset({
        ...freshSnapshot(),
        rows: [{
          id: 'r1',
          cells: { c_task: 'x', c_done: false },
          work: {
            status: 'done',
            assignedAgent: 'Explore',
            model: 'claude-opus-4-8',
            inputs: 'prompt',
            outputs: 'result',
            history: [{ id: 'run_1', status: 'done' }],
          },
        }],
      });
      store.duplicateRow('r1');
      const copy = rows()[1];
      assert.equal(copy.work?.assignedAgent, 'Explore');
      assert.equal(copy.work?.model, 'claude-opus-4-8');
      assert.equal(copy.work?.inputs, 'prompt');
      assert.equal(copy.work?.status, 'pending');
      assert.equal(copy.work?.outputs, undefined);
      assert.equal(copy.work?.history, undefined);
    });

    it('moveRow reorders within bounds and no-ops past the edges', () => {
      store.moveRow('r1', 1);
      assert.deepEqual(rows().map((r) => r.id), ['r2', 'r1']);
      store.moveRow('r2', -1); // already first -> no change
      assert.deepEqual(rows().map((r) => r.id), ['r2', 'r1']);
    });
  });

  describe('updateWork', () => {
    it('merges the patch into the row work and stamps updatedAt', () => {
      store.updateWork('r1', { status: 'running', assignedAgent: 'claude' });
      const w = rows()[0].work!;
      assert.equal(w.status, 'running');
      assert.equal(w.assignedAgent, 'claude');
      assert.ok(w.updatedAt && !Number.isNaN(Date.parse(w.updatedAt)));
    });
  });

  describe('column mutations', () => {
    it('addColumn appends a column and backfills every row', () => {
      store.addColumn();
      assert.equal(cols().length, 3);
      const newCol = cols()[2];
      assert.ok(rows().every((r) => r.cells[newCol.id] === ''));
    });

    it('deleteColumn drops the column and its cells', () => {
      store.deleteColumn('c_done');
      assert.deepEqual(cols().map((c) => c.id), ['c_task']);
      assert.ok(rows().every((r) => !('c_done' in r.cells)));
    });

    it('setColumnType coerces existing cell values to the new type', () => {
      store.setCell('r1', 'c_task', '42');
      store.setColumnType('c_task', 'number');
      assert.equal(cols()[0].type, 'number');
      assert.equal(rows()[0].cells.c_task, 42);
      // Non-numeric text becomes null.
      assert.equal(rows()[1].cells.c_task, null);
    });

    it('moveColumn reorders within bounds', () => {
      store.moveColumn('c_task', 1);
      assert.deepEqual(cols().map((c) => c.id), ['c_done', 'c_task']);
    });
  });
});
