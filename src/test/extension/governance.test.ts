import * as assert from 'node:assert/strict';
import { GridSnapshot, Row } from '../../shared/types';
import { aggregateFailedFiles, projectRiskWarnings, rowHaystack } from '../../extension/governance/evaluate';

const COLS = [{ id: 'c_task', name: 'Task', type: 'text' as const }];
function snap(rows: Row[]): GridSnapshot {
  return { kind: 'workflow', columns: COLS, rows };
}
function failedOn(id: string, path: string): Row {
  return {
    id, cells: { c_task: id },
    work: { status: 'failed', history: [{ id: `${id}_r`, status: 'failed', provenance: { filesModified: [{ path, change: 'modified' }] } }] },
  };
}

describe('governance/evaluate (cross-workflow project memory)', () => {
  it('aggregates failed-file counts across multiple workflows', () => {
    const wf1 = snap([failedOn('a', 'src/db.ts')]);
    const wf2 = snap([failedOn('b', 'src/db.ts'), failedOn('c', 'src/api.ts')]);
    const agg = aggregateFailedFiles([wf1, wf2]);
    assert.equal(agg.get('src/db.ts'), 2, 'same file failed in two workflows');
    assert.equal(agg.get('src/api.ts'), 1);
  });

  it('warns when a row references a repo-wide failed file', () => {
    const agg = aggregateFailedFiles([snap([failedOn('a', 'src/db.ts')]), snap([failedOn('b', 'src/db.ts')])]);
    const warnings = projectRiskWarnings('please edit src/db.ts carefully', agg);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /src\/db\.ts has failed 2 times across this project/);
  });

  it('does not warn for unrelated text', () => {
    const agg = aggregateFailedFiles([snap([failedOn('a', 'src/db.ts')])]);
    assert.deepEqual(projectRiskWarnings('work on src/ui.tsx', agg), []);
  });

  it('rowHaystack combines inputs and cell text', () => {
    const s = snap([{ id: 'r1', cells: { c_task: 'touch src/db.ts' }, work: { status: 'pending', inputs: 'be careful' } }]);
    const hay = rowHaystack(s, 'r1');
    assert.match(hay, /be careful/);
    assert.match(hay, /src\/db\.ts/);
  });
});
