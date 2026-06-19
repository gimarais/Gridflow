import * as vscode from 'vscode';
import { Provenance } from '../shared/types';
import {
  StatFn,
  VerificationSummary,
  verifyProvenance,
} from '../shared/provenanceCore';

/**
 * Extension-host provenance verifier: wires the pure verification core to
 * `vscode.workspace.fs`. Called by the orchestrator on every updateRow that
 * carries provenance, so agent-reported file claims are checked against the
 * real filesystem before they're persisted or shown.
 */

const stat: StatFn = async (absolutePath) => {
  try {
    const s = await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
    return { mtimeMs: s.mtime };
  } catch {
    return undefined;
  }
};

export async function verifyRowProvenance(
  provenance: Provenance | undefined,
  window: { runStart?: string; runEnd?: string },
): Promise<{ provenance: Provenance | undefined; summary: VerificationSummary | undefined }> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return verifyProvenance(provenance, {
    workspaceRoot,
    stat,
    runStart: window.runStart,
    runEnd: window.runEnd,
  });
}
