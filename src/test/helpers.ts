import * as vscode from 'vscode';
import { WORKFLOW_DIR } from '../extension/workflowStore';

/**
 * Remove the `.gridflow` sidecar directory from the test workspace so each
 * integration test starts from a clean slate. No-op if it doesn't exist.
 */
export async function clearWorkflowDir(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const dir = vscode.Uri.joinPath(folder.uri, WORKFLOW_DIR);
  try {
    await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
  } catch {
    // didn't exist — fine
  }
}

/** Assert a workspace folder is open; the orchestrator/store require one. */
export function requireWorkspace(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error('Test workspace folder is not open — check .vscode-test.mjs workspaceFolder.');
  return folder;
}
