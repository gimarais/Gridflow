import * as assert from 'node:assert/strict';
import { ColumnDef, emptyRow, emptyWorkItem, makeId } from '../../shared/types';

describe('shared/types helpers', () => {
  describe('makeId', () => {
    it('prefixes the id and uses the default prefix when omitted', () => {
      assert.ok(makeId('row').startsWith('row_'));
      assert.ok(makeId().startsWith('id_'));
    });

    it('produces distinct ids across calls', () => {
      const ids = new Set(Array.from({ length: 500 }, () => makeId('col')));
      assert.equal(ids.size, 500);
    });
  });

  describe('emptyWorkItem', () => {
    it('starts pending with an updatedAt timestamp', () => {
      const w = emptyWorkItem();
      assert.equal(w.status, 'pending');
      assert.ok(w.updatedAt && !Number.isNaN(Date.parse(w.updatedAt)));
    });
  });

  describe('emptyRow', () => {
    const columns: ColumnDef[] = [
      { id: 'c_text', name: 'T', type: 'text' },
      { id: 'c_num', name: 'N', type: 'number' },
      { id: 'c_bool', name: 'B', type: 'boolean' },
    ];

    it('seeds per-type default cell values', () => {
      const row = emptyRow(columns);
      assert.equal(row.cells.c_text, '');
      assert.equal(row.cells.c_num, null);
      assert.equal(row.cells.c_bool, false);
      assert.ok(row.id.startsWith('row_'));
    });

    it('omits work for data grids and attaches it for workflow grids', () => {
      assert.equal(emptyRow(columns, 'data').work, undefined);
      const wf = emptyRow(columns, 'workflow');
      assert.ok(wf.work);
      assert.equal(wf.work?.status, 'pending');
    });
  });
});
