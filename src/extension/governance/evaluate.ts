/**
 * Governance — pure core (no vscode), unit-tested.
 *
 * Extends the in-workflow file-risk gate (workflowCore.fileRiskWarnings) to a
 * repo-wide signal: aggregate the file-failure history across EVERY workflow in
 * `.gridflow/`, so a file that has burned a different workflow still warns here.
 * This is the ProjectMem "memory-as-governance" idea applied across the whole
 * project's audit log.
 */
import { GridSnapshot } from '../../shared/types';
import { failedFileHistory } from '../../shared/workflowCore';

/** Merge per-workflow failed-file history into one repo-wide map: path → failure count. */
export function aggregateFailedFiles(snapshots: GridSnapshot[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const s of snapshots) {
    for (const [path, count] of failedFileHistory(s)) {
      merged.set(path, (merged.get(path) ?? 0) + count);
    }
  }
  return merged;
}

/** Warnings for any failed file (repo-wide) that the given text references. */
export function projectRiskWarnings(text: string, failed: Map<string, number>): string[] {
  const warnings: string[] = [];
  for (const [path, count] of failed) {
    if (text.includes(path)) {
      warnings.push(`${path} has failed ${count} time${count > 1 ? 's' : ''} across this project's workflows`);
    }
  }
  return warnings;
}

/** The text of a row that downstream risk-matching scans (inputs + cell strings). */
export function rowHaystack(snapshot: GridSnapshot, rowId: string): string {
  const row = snapshot.rows.find((r) => r.id === rowId);
  if (!row) return '';
  return [row.work?.inputs ?? '', ...Object.values(row.cells).map((v) => (typeof v === 'string' ? v : ''))].join('\n');
}
