import * as assert from 'node:assert/strict';
import { GridSnapshot } from '../../shared/types';
import {
  listWorkflows,
  loadWorkflow,
  saveWorkflow,
  slugify,
} from '../../extension/workflowStore';
import { clearWorkflowDir, requireWorkspace } from '../helpers';

describe('workflowStore', () => {
  before(() => requireWorkspace());
  beforeEach(() => clearWorkflowDir());
  after(() => clearWorkflowDir());

  describe('slugify', () => {
    it('lowercases and hyphenates non-alphanumerics', () => {
      assert.equal(slugify('Auth Refactor'), 'auth-refactor');
      assert.equal(slugify('  Foo / Bar!! '), 'foo-bar');
    });

    it('trims leading/trailing hyphens and caps length at 64', () => {
      assert.equal(slugify('---hi---'), 'hi');
      assert.equal(slugify('x'.repeat(100)).length, 64);
    });

    it('falls back to "workflow" when nothing usable remains', () => {
      assert.equal(slugify('!!!'), 'workflow');
      assert.equal(slugify(''), 'workflow');
    });
  });

  describe('save/load round-trip', () => {
    const snapshot: GridSnapshot = {
      title: 'Persist Me',
      kind: 'workflow',
      columns: [{ id: 'c1', name: 'Task', type: 'text' }],
      rows: [{ id: 'r1', cells: { c1: 'do the thing' }, work: { status: 'pending' } }],
    };

    it('writes a sidecar that loads back identically', async () => {
      await saveWorkflow('persist-me', snapshot);
      const loaded = await loadWorkflow('persist-me');
      assert.ok(loaded);
      assert.equal(loaded?.title, 'Persist Me');
      assert.deepEqual(loaded?.columns, snapshot.columns);
      assert.equal(loaded?.rows[0].cells.c1, 'do the thing');
      assert.equal(loaded?.rows[0].work?.status, 'pending');
    });

    it('forces kind:workflow even if the stored file omits it', async () => {
      const dataish = { ...snapshot, kind: undefined } as GridSnapshot;
      await saveWorkflow('forced', dataish);
      const loaded = await loadWorkflow('forced');
      assert.equal(loaded?.kind, 'workflow');
    });

    it('returns undefined for a slug that was never saved', async () => {
      assert.equal(await loadWorkflow('does-not-exist'), undefined);
    });
  });

  describe('listWorkflows', () => {
    it('lists saved slugs, sorted, without the .json extension', async () => {
      await saveWorkflow('beta', { columns: [], rows: [] });
      await saveWorkflow('alpha', { columns: [], rows: [] });
      const list = await listWorkflows();
      assert.deepEqual(list, ['alpha', 'beta']);
    });

    it('returns an empty list when no workflows exist', async () => {
      assert.deepEqual(await listWorkflows(), []);
    });
  });
});
