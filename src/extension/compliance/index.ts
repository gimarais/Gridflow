/**
 * Compliance pack — VS Code wiring around the pure AAT core.
 *
 * Records every persisted updateRow as a tamper-evident record appended to
 * `.gridflow/<slug>.aat.jsonl`, and contributes two commands:
 *   - gridflow.verifyChain       — re-hash a workflow's chain, report integrity
 *   - gridflow.exportAttestation — write a signed-style attestation (session_hash)
 */
import * as vscode from 'vscode';
import type { GridSnapshot, WorkItemStatus } from '../../shared/types';
import { WORKFLOW_DIR } from '../workflowStore';
import {
  AatRecord,
  appendRecord,
  closeRecord,
  parseAatJsonl,
  serializeRecord,
  sessionHash,
  verifyChain,
} from './aat';

/** Emitted after every persisted updateRow so the audit chain can record it. */
export interface RowUpdateEvent {
  slug: string;
  rowId: string;
  status: WorkItemStatus;
  agent?: string;
  model?: string;
  costUsd?: number;
  totalTokens?: number;
  /** True when GridFlow's provenance verifier confirmed the reported files (no missing). */
  provenanceVerified?: boolean;
  /** ISO timestamp of the update. */
  at: string;
  /** The post-update snapshot, for hashing the full state. */
  snapshot: GridSnapshot;
}

function aatUri(slug: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return vscode.Uri.joinPath(folder.uri, WORKFLOW_DIR, `${slug}.aat.jsonl`);
}

async function readChain(uri: vscode.Uri): Promise<{ text: string; records: AatRecord[] }> {
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    return { text, records: parseAatJsonl(text) };
  } catch {
    return { text: '', records: [] };
  }
}

/** Append one audit record for a persisted row update. Append-only on disk. */
export async function recordRowUpdate(event: RowUpdateEvent): Promise<void> {
  const uri = aatUri(event.slug);
  if (!uri) return;
  const { text, records } = await readChain(uri);
  const record = appendRecord(records[records.length - 1], {
    ts: event.at,
    agentId: event.agent ?? 'unknown',
    action: 'row.update',
    resource: `${event.slug}#${event.rowId}`,
    outcome: event.status,
    trustLevel: event.provenanceVerified === true ? 'verified' : 'reported',
    metadata: {
      model: event.model,
      costUsd: event.costUsd,
      totalTokens: event.totalTokens,
    },
  });
  const prefix = text === '' || text.endsWith('\n') ? text : text + '\n';
  const next = prefix + serializeRecord(record) + '\n';
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(next));
}

/** List workflow slugs that have an audit chain on disk. */
async function listChains(): Promise<string[]> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return [];
  const dir = vscode.Uri.joinPath(folder.uri, WORKFLOW_DIR);
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.aat.jsonl'))
      .map(([name]) => name.replace(/\.aat\.jsonl$/, ''))
      .sort();
  } catch {
    return [];
  }
}

async function pickChain(placeHolder: string): Promise<string | undefined> {
  const slugs = await listChains();
  if (slugs.length === 0) {
    vscode.window.showInformationMessage('GridFlow: no audit chains found yet. Run a workflow first.');
    return undefined;
  }
  if (slugs.length === 1) return slugs[0];
  return vscode.window.showQuickPick(slugs, { placeHolder });
}

async function verifyCommand(slugArg?: string): Promise<void> {
  const slug = slugArg ?? (await pickChain('Verify which workflow audit chain?'));
  if (!slug) return;
  const uri = aatUri(slug);
  if (!uri) return;
  const { records } = await readChain(uri);
  const result = verifyChain(records);
  if (result.ok) {
    vscode.window.showInformationMessage(
      `🔒 GridFlow: "${slug}" audit chain verified — ${result.length} records intact. ` +
      `session_hash ${result.sessionHash?.slice(0, 12)}…`,
    );
  } else {
    vscode.window.showErrorMessage(
      `⛔ GridFlow: "${slug}" audit chain FAILED at record ${(result.brokenAt ?? 0) + 1}/${result.length} — ${result.reason}`,
    );
  }
}

async function exportAttestationCommand(slugArg?: string): Promise<void> {
  const slug = slugArg ?? (await pickChain('Export an attestation for which workflow?'));
  if (!slug) return;
  const uri = aatUri(slug);
  if (!uri) return;
  const { records } = await readChain(uri);
  if (records.length === 0) {
    vscode.window.showWarningMessage(`GridFlow: "${slug}" has no audit records yet.`);
    return;
  }
  const verification = verifyChain(records);
  const close = closeRecord(records);
  const attestation = {
    type: 'gridflow.attestation',
    spec: 'IETF Agent Audit Trail (draft-sharif-agent-audit-trail)',
    workflow: slug,
    generatedAt: new Date().toISOString(),
    recordCount: records.length,
    sessionHash: sessionHash(records),
    closeRecord: close,
    integrity: verification.ok
      ? { verified: true }
      : { verified: false, brokenAt: verification.brokenAt, reason: verification.reason },
  };
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, `${slug}.attestation.json`) : undefined,
    filters: { JSON: ['json'] },
    saveLabel: 'Export Attestation',
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(attestation, null, 2)));
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc, { preview: true });
  vscode.window.showInformationMessage(
    `GridFlow: attestation exported for "${slug}" (${records.length} records, ${verification.ok ? 'verified' : 'INTEGRITY FAILURE'}).`,
  );
}

/** Register the audit-chain commands (verify integrity, export attestation). */
export function registerComplianceCommands(_context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('gridflow.verifyChain', (slug?: string) =>
      verifyCommand(typeof slug === 'string' ? slug : undefined),
    ),
    vscode.commands.registerCommand('gridflow.exportAttestation', (slug?: string) =>
      exportAttestationCommand(typeof slug === 'string' ? slug : undefined),
    ),
  );
}
