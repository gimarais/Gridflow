import * as vscode from 'vscode';
import { GridSnapshot } from '../shared/types';
import { sanitizeSnapshot } from '../shared/sanitize';
import { KeyedMutex } from '../shared/mutex';
import { slugify } from '../shared/workflowCore';

/**
 * Persistence for workflow grids. Each workflow lives in a human-readable JSON
 * sidecar under `.gridflow/<slug>.json` in the first workspace folder. Keeping the
 * rich work-item metadata (status, provenance, logs, cost, history) here — rather
 * than inside CSV/TSV cells — lets plain tabular files stay clean while workflow
 * documents remain diffable, committable, and portable across machines.
 */
export const WORKFLOW_DIR = '.gridflow';

export { slugify };

export interface WorkflowHandle {
  /** URI of the sidecar JSON file. */
  uri: vscode.Uri;
  /** Slug used for the filename (also the default title). */
  slug: string;
  /** Snapshot loaded from disk, or undefined if the file does not exist yet. */
  snapshot?: GridSnapshot;
}

/**
 * Per-slug write lock. Every load-modify-write of a sidecar must go through
 * this — parallel `updateRow` calls (the flagship orchestration path) and the
 * panel's debounced save would otherwise clobber each other's writes.
 */
const workflowMutex = new KeyedMutex();

export function withWorkflowLock<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  return workflowMutex.run(slug, fn);
}

function workflowFolder(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  return vscode.Uri.joinPath(folder.uri, WORKFLOW_DIR);
}

export function workflowUri(slug: string): vscode.Uri | undefined {
  const dir = workflowFolder();
  if (!dir) return undefined;
  return vscode.Uri.joinPath(dir, `${slug}.json`);
}

/** List existing workflow sidecar files (without the `.json` extension). */
export async function listWorkflows(): Promise<string[]> {
  const dir = workflowFolder();
  if (!dir) return [];
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.json'))
      .map(([name]) => name.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

export async function loadWorkflow(slug: string): Promise<GridSnapshot | undefined> {
  const uri = workflowUri(slug);
  if (!uri) return undefined;
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buf));
    // The sidecar comes from the workspace — a cloned repo may carry a hostile
    // or malformed file. Sanitize instead of blind-casting, and force the kind
    // so an older/hand-edited file still renders as a workflow.
    const snapshot = sanitizeSnapshot(parsed);
    if (!snapshot) return undefined;
    return { ...snapshot, kind: 'workflow' };
  } catch {
    return undefined;
  }
}

export async function saveWorkflow(slug: string, snapshot: GridSnapshot): Promise<void> {
  const dir = workflowFolder();
  const uri = workflowUri(slug);
  if (!dir || !uri) {
    throw new Error('No workspace folder is open — cannot save a workflow.');
  }
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // already exists
  }
  const doc: GridSnapshot = { ...snapshot, kind: 'workflow' };
  const json = JSON.stringify(doc, null, 2);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(json));
}
