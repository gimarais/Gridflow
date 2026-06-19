import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { WORKFLOW_DIR } from '../../extension/workflowStore';
import type { GridSnapshot } from '../../shared/types';
import { recordRowUpdate, type RowUpdateEvent } from '../../extension/compliance';
import { parseAatJsonl, verifyChain } from '../../extension/compliance/aat';
import { clearWorkflowDir, requireWorkspace } from '../helpers';

const SNAP: GridSnapshot = { kind: 'workflow', columns: [], rows: [] };

function event(slug: string, rowId: string, status: RowUpdateEvent['status'], extra: Partial<RowUpdateEvent> = {}): RowUpdateEvent {
  return {
    slug, rowId, status,
    agent: 'claude', model: 'claude-opus-4-8',
    at: new Date().toISOString(),
    snapshot: SNAP,
    ...extra,
  };
}

async function readAat(slug: string): Promise<string> {
  const folder = requireWorkspace();
  const uri = vscode.Uri.joinPath(folder.uri, WORKFLOW_DIR, `${slug}.aat.jsonl`);
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

describe('compliance module (E2E against the real filesystem)', () => {
  before(() => requireWorkspace());
  beforeEach(() => clearWorkflowDir());
  after(() => clearWorkflowDir());

  it('appends a hash-chained record per update and the chain verifies', async () => {
    await recordRowUpdate(event('audit-wf', 'r1', 'running'));
    await recordRowUpdate(event('audit-wf', 'r1', 'done', { costUsd: 0.02, totalTokens: 1500, provenanceVerified: true }));
    await recordRowUpdate(event('audit-wf', 'r2', 'failed'));

    const records = parseAatJsonl(await readAat('audit-wf'));
    assert.equal(records.length, 3);
    assert.equal(records[1].trustLevel, 'verified', 'verified provenance lifts the trust level');
    assert.equal(records[2].trustLevel, 'reported');
    const v = verifyChain(records);
    assert.equal(v.ok, true);
    assert.equal(v.length, 3);
  });

  it('tampering with the persisted chain is detected', async () => {
    await recordRowUpdate(event('tamper-wf', 'r1', 'running'));
    await recordRowUpdate(event('tamper-wf', 'r1', 'done'));

    // Rewrite the file with a flipped outcome on record #1, without re-hashing.
    const folder = requireWorkspace();
    const uri = vscode.Uri.joinPath(folder.uri, WORKFLOW_DIR, 'tamper-wf.aat.jsonl');
    const records = parseAatJsonl(await readAat('tamper-wf'));
    records[0] = { ...records[0], outcome: 'cancelled' };
    await vscode.workspace.fs.writeFile(
      uri,
      new TextEncoder().encode(records.map((r) => JSON.stringify(r)).join('\n') + '\n'),
    );

    const v = verifyChain(parseAatJsonl(await readAat('tamper-wf')));
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 0);
  });
});
