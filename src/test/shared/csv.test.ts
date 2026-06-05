import * as assert from 'node:assert/strict';
import { ColumnDef, Row } from '../../shared/types';
import { detectDelimiter, parseCsv, serializeCsv } from '../../extension/csv';

describe('csv', () => {
  describe('detectDelimiter', () => {
    it('honours an explicitly configured delimiter', () => {
      assert.equal(detectDelimiter('a;b;c', ';'), ';');
      // Configured wins even when the content looks like something else.
      assert.equal(detectDelimiter('a,b,c', ';'), ';');
    });

    it('auto-detects the most common candidate on the first non-empty line', () => {
      assert.equal(detectDelimiter('a,b,c\n1,2,3', 'auto'), ',');
      assert.equal(detectDelimiter('a;b;c\n1;2;3', 'auto'), ';');
      assert.equal(detectDelimiter('a\tb\tc', 'auto'), '\t');
      assert.equal(detectDelimiter('a|b|c', 'auto'), '|');
    });

    it('skips leading blank lines and strips a BOM', () => {
      assert.equal(detectDelimiter('\n\na;b;c', 'auto'), ';');
      assert.equal(detectDelimiter('﻿a;b;c', 'auto'), ';');
    });

    it('falls back to comma when nothing wins', () => {
      assert.equal(detectDelimiter('single', 'auto'), ',');
    });
  });

  describe('parseCsv', () => {
    it('returns empty columns/rows for empty input', () => {
      const parsed = parseCsv('', ',');
      assert.deepEqual(parsed.columns, []);
      assert.deepEqual(parsed.rows, []);
    });

    it('uses the first row as headers and assigns stable ids', () => {
      const { columns } = parseCsv('Name,Age\nAda,36', ',');
      assert.equal(columns.length, 2);
      assert.deepEqual(columns.map((c) => c.name), ['Name', 'Age']);
      assert.ok(columns.every((c) => c.id.startsWith('col_')));
      assert.notEqual(columns[0].id, columns[1].id);
    });

    it('names empty headers positionally', () => {
      const { columns } = parseCsv(',Age\nx,1', ',');
      assert.equal(columns[0].name, 'Column 1');
      assert.equal(columns[1].name, 'Age');
    });

    it('infers number, boolean, and text column types', () => {
      const { columns } = parseCsv('Qty,Active,Label\n3,true,hi\n4,false,yo', ',');
      assert.equal(columns[0].type, 'number');
      assert.equal(columns[1].type, 'boolean');
      assert.equal(columns[2].type, 'text');
    });

    it('coerces cell values to the inferred type', () => {
      const { columns, rows } = parseCsv('Qty,Active\n3,yes\n,no', ',');
      const [qty, active] = columns;
      assert.equal(rows[0].cells[qty.id], 3);
      assert.equal(rows[0].cells[active.id], true);
      // Empty number -> null, empty already-typed cells use type defaults.
      assert.equal(rows[1].cells[qty.id], null);
      assert.equal(rows[1].cells[active.id], false);
    });

    it('falls back to text when a column mixes numbers and words', () => {
      const { columns, rows } = parseCsv('Mixed\n3\nhello', ',');
      assert.equal(columns[0].type, 'text');
      assert.equal(rows[1].cells[columns[0].id], 'hello');
    });
  });

  describe('serializeCsv', () => {
    const columns: ColumnDef[] = [
      { id: 'c1', name: 'Name', type: 'text' },
      { id: 'c2', name: 'Active', type: 'boolean' },
      { id: 'c3', name: 'Qty', type: 'number' },
    ];

    it('writes a header row followed by cells', () => {
      const rows: Row[] = [{ id: 'r1', cells: { c1: 'Ada', c2: true, c3: 5 } }];
      const out = serializeCsv(columns, rows, ',');
      assert.equal(out, 'Name,Active,Qty\nAda,true,5');
    });

    it('renders null/undefined as empty and booleans as true/false', () => {
      const rows: Row[] = [{ id: 'r1', cells: { c1: '', c2: false, c3: null } }];
      const out = serializeCsv(columns, rows, ',');
      assert.equal(out, 'Name,Active,Qty\n,false,');
    });

    it('round-trips through parse without losing typed values', () => {
      const text = 'Name,Active,Qty\nAda,true,5\nGrace,false,12';
      const parsed = parseCsv(text, ',');
      const out = serializeCsv(parsed.columns, parsed.rows, ',');
      assert.equal(out, text);
    });
  });
});
