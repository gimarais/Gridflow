/**
 * Provenance verification — "verify, don't trust". Agents self-report which
 * files they read and modified; this module cross-checks those claims against
 * the filesystem (existence + mtime inside the run window) and labels each
 * claim. Pure: filesystem access is injected via `stat`, so the extension host
 * (workspace.fs) and the CLI (fs.promises) share the same logic.
 */
import { FileRef, Provenance } from './types';

export type StatFn = (absolutePath: string) => Promise<{ mtimeMs: number } | undefined>;

export interface VerifyProvenanceOptions {
  /** Workspace root used to resolve relative paths and to relativize absolute ones. */
  workspaceRoot?: string;
  stat: StatFn;
  /** ISO timestamps of the run window; modifications are verified against it. */
  runStart?: string;
  runEnd?: string;
  /** Clock-skew slack applied to both ends of the window. */
  slackMs?: number;
}

export interface VerificationSummary {
  filesRead: { total: number; verified: number; missing: number };
  filesModified: { total: number; verified: number; unverified: number; missing: number };
}

/** Normalize a reported path: absolute paths under the workspace become workspace-relative. */
export function normalizeFilePath(p: string, workspaceRoot?: string): string {
  let path = p.trim().replace(/\\/g, '/');
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (path === root) return '.';
    if (path.startsWith(root + '/')) path = path.slice(root.length + 1);
  }
  return path;
}

function resolveForStat(path: string, workspaceRoot?: string): string {
  const isAbsolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
  if (isAbsolute || !workspaceRoot) return path;
  return `${workspaceRoot.replace(/\/+$/, '')}/${path}`;
}

function dedupeByPath(refs: FileRef[]): FileRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
}

/**
 * Normalize, dedupe, and verify a provenance report. Returns a new provenance
 * object with `verification` set on every file ref, plus a count summary the
 * orchestrator returns to the agent so it can self-correct.
 *
 * Labels:
 * - filesRead: `verified` = file exists; `missing` = reported but not found.
 * - filesModified: `verified` = exists and mtime falls inside the run window
 *   (or change === 'deleted' and the file is indeed gone); `unverified` =
 *   exists but mtime is outside the window (or no window known); `missing` =
 *   reported as modified/created but not found.
 */
export async function verifyProvenance(
  provenance: Provenance | undefined,
  opts: VerifyProvenanceOptions,
): Promise<{ provenance: Provenance | undefined; summary: VerificationSummary | undefined }> {
  if (!provenance || (!provenance.filesRead?.length && !provenance.filesModified?.length)) {
    return { provenance, summary: undefined };
  }

  const slack = opts.slackMs ?? 5000;
  const startMs = opts.runStart ? Date.parse(opts.runStart) - slack : undefined;
  const endMs = opts.runEnd ? Date.parse(opts.runEnd) + slack : undefined;
  const hasWindow = startMs !== undefined && Number.isFinite(startMs);

  const normalize = (refs: FileRef[] | undefined): FileRef[] =>
    dedupeByPath((refs ?? []).map((r) => ({ ...r, path: normalizeFilePath(r.path, opts.workspaceRoot) })));

  const read = normalize(provenance.filesRead);
  const modified = normalize(provenance.filesModified);

  const summary: VerificationSummary = {
    filesRead: { total: read.length, verified: 0, missing: 0 },
    filesModified: { total: modified.length, verified: 0, unverified: 0, missing: 0 },
  };

  const verifiedRead = await Promise.all(
    read.map(async (ref): Promise<FileRef> => {
      const stat = await opts.stat(resolveForStat(ref.path, opts.workspaceRoot));
      if (stat) {
        summary.filesRead.verified++;
        return { ...ref, verification: 'verified' };
      }
      summary.filesRead.missing++;
      return { ...ref, verification: 'missing' };
    }),
  );

  const verifiedModified = await Promise.all(
    modified.map(async (ref): Promise<FileRef> => {
      const stat = await opts.stat(resolveForStat(ref.path, opts.workspaceRoot));
      if (!stat) {
        // A reported deletion is *expected* to be missing — that verifies it.
        if (ref.change === 'deleted') {
          summary.filesModified.verified++;
          return { ...ref, verification: 'verified' };
        }
        summary.filesModified.missing++;
        return { ...ref, verification: 'missing' };
      }
      if (ref.change === 'deleted') {
        // Claimed deleted but still present.
        summary.filesModified.unverified++;
        return { ...ref, verification: 'unverified' };
      }
      const inWindow =
        hasWindow && stat.mtimeMs >= (startMs as number) && (endMs === undefined || stat.mtimeMs <= endMs);
      if (inWindow) {
        summary.filesModified.verified++;
        return { ...ref, verification: 'verified' };
      }
      summary.filesModified.unverified++;
      return { ...ref, verification: 'unverified' };
    }),
  );

  return {
    provenance: {
      ...provenance,
      filesRead: verifiedRead.length ? verifiedRead : undefined,
      filesModified: verifiedModified.length ? verifiedModified : undefined,
    },
    summary,
  };
}
