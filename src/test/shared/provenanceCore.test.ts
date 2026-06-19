import * as assert from 'node:assert/strict';
import { normalizeFilePath, verifyProvenance, StatFn } from '../../shared/provenanceCore';

const ROOT = '/work/space';
const T0 = '2026-06-02T10:00:00.000Z';
const T1 = '2026-06-02T10:05:00.000Z';
const DURING_RUN = Date.parse(T0) + 60_000;
const LONG_BEFORE_RUN = Date.parse(T0) - 60 * 60 * 1000;

/** Fake filesystem: absolute path → mtimeMs. */
function fakeStat(files: Record<string, number>): StatFn {
  return async (p) => (p in files ? { mtimeMs: files[p] } : undefined);
}

describe('provenanceCore', () => {
  describe('normalizeFilePath', () => {
    it('relativizes absolute paths under the workspace root', () => {
      assert.equal(normalizeFilePath('/work/space/src/a.ts', ROOT), 'src/a.ts');
      assert.equal(normalizeFilePath('src/a.ts', ROOT), 'src/a.ts');
      assert.equal(normalizeFilePath('/elsewhere/b.ts', ROOT), '/elsewhere/b.ts');
    });
  });

  describe('verifyProvenance', () => {
    it('labels reads: verified when the file exists, missing otherwise', async () => {
      const { provenance, summary } = await verifyProvenance(
        { filesRead: [{ path: 'src/real.ts' }, { path: 'src/ghost.ts' }] },
        { workspaceRoot: ROOT, stat: fakeStat({ [`${ROOT}/src/real.ts`]: DURING_RUN }), runStart: T0, runEnd: T1 },
      );
      assert.equal(provenance?.filesRead?.[0].verification, 'verified');
      assert.equal(provenance?.filesRead?.[1].verification, 'missing');
      assert.deepEqual(summary?.filesRead, { total: 2, verified: 1, missing: 1 });
    });

    it('verifies modifications only when mtime falls inside the run window', async () => {
      const { provenance, summary } = await verifyProvenance(
        {
          filesModified: [
            { path: 'src/touched.ts', change: 'modified' },
            { path: 'src/untouched.ts', change: 'modified' },
            { path: 'src/ghost.ts', change: 'created' },
          ],
        },
        {
          workspaceRoot: ROOT,
          stat: fakeStat({
            [`${ROOT}/src/touched.ts`]: DURING_RUN,
            [`${ROOT}/src/untouched.ts`]: LONG_BEFORE_RUN,
          }),
          runStart: T0,
          runEnd: T1,
        },
      );
      assert.equal(provenance?.filesModified?.[0].verification, 'verified');
      assert.equal(provenance?.filesModified?.[1].verification, 'unverified');
      assert.equal(provenance?.filesModified?.[2].verification, 'missing');
      assert.deepEqual(summary?.filesModified, { total: 3, verified: 1, unverified: 1, missing: 1 });
    });

    it('treats a reported deletion as verified when the file is gone', async () => {
      const { provenance } = await verifyProvenance(
        {
          filesModified: [
            { path: 'src/gone.ts', change: 'deleted' },
            { path: 'src/still-here.ts', change: 'deleted' },
          ],
        },
        {
          workspaceRoot: ROOT,
          stat: fakeStat({ [`${ROOT}/src/still-here.ts`]: DURING_RUN }),
          runStart: T0,
          runEnd: T1,
        },
      );
      assert.equal(provenance?.filesModified?.[0].verification, 'verified');
      assert.equal(provenance?.filesModified?.[1].verification, 'unverified', 'claimed deleted but still present');
    });

    it('normalizes and dedupes paths before verifying', async () => {
      const { provenance } = await verifyProvenance(
        { filesRead: [{ path: `${ROOT}/src/a.ts` }, { path: 'src/a.ts' }] },
        { workspaceRoot: ROOT, stat: fakeStat({ [`${ROOT}/src/a.ts`]: DURING_RUN }), runStart: T0, runEnd: T1 },
      );
      assert.equal(provenance?.filesRead?.length, 1);
      assert.equal(provenance?.filesRead?.[0].path, 'src/a.ts');
    });

    it('passes empty provenance through untouched', async () => {
      const { provenance, summary } = await verifyProvenance(
        { prompt: 'just a prompt' },
        { workspaceRoot: ROOT, stat: fakeStat({}), runStart: T0, runEnd: T1 },
      );
      assert.deepEqual(provenance, { prompt: 'just a prompt' });
      assert.equal(summary, undefined);
    });
  });
});
