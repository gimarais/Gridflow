/**
 * IETF Agent Audit Trail (AAT) — the cryptographic core. Pure and vscode-free
 * so it can be unit-tested directly.
 *
 * Each agent action becomes an append-only record carrying the mandatory AAT
 * fields (agent identity, semantic action, outcome, trust level) plus a
 * tamper-evident SHA-256 hash chain: every record's hash covers its own content
 * AND the previous record's hash, so altering or removing any record breaks the
 * chain from that point on. A `session.close` record carries the session_hash
 * (the digest of every record hash), giving a single value that attests to the
 * whole run — the shape EU AI Act / SOC 2 audit trails expect.
 */
import * as crypto from 'crypto';

export type TrustLevel = 'verified' | 'reported' | 'system';

export interface AatRecord {
  /** Format version. */
  v: 1;
  /** 1-based position in the chain. */
  seq: number;
  /** ISO timestamp of the action. */
  ts: string;
  /** Agent identity (who acted). */
  agentId: string;
  /** Semantic action classification, e.g. "row.update" / "session.close". */
  action: string;
  /** What was acted on (workflow slug, row id, …). */
  resource: string;
  /** Outcome classification (status / result). */
  outcome: string;
  /** Trust level — `verified` once GridFlow has cross-checked the claim. */
  trustLevel: TrustLevel;
  /** Free-form, canonicalized into the hash. */
  metadata?: Record<string, unknown>;
  /** Hash of the previous record (GENESIS_HASH for the first). */
  prevHash: string;
  /** SHA-256 over the canonical form of this record (excluding `hash`). */
  hash: string;
}

export const GENESIS_HASH = '0'.repeat(64);

function sha256hex(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * RFC 8785-style canonical JSON: object keys sorted recursively, no insignificant
 * whitespace. Sufficient for our records (strings, integers, booleans, nested
 * objects/arrays) — the inputs we hash never contain non-integer floats.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
  }
  return 'null';
}

/** Hash a record's content (everything except the `hash` field itself). */
function hashOf(recordSansHash: Omit<AatRecord, 'hash'>): string {
  return sha256hex(canonicalize(recordSansHash));
}

export type NewRecordFields = Pick<
  AatRecord,
  'ts' | 'agentId' | 'action' | 'resource' | 'outcome' | 'trustLevel'
> & { metadata?: Record<string, unknown> };

/** Build the next record in the chain after `prev` (undefined for the first). */
export function appendRecord(prev: AatRecord | undefined, fields: NewRecordFields): AatRecord {
  const prevHash = prev?.hash ?? GENESIS_HASH;
  const seq = (prev?.seq ?? 0) + 1;
  const sansHash: Omit<AatRecord, 'hash'> = { v: 1, seq, prevHash, ...fields };
  return { ...sansHash, hash: hashOf(sansHash) };
}

/** Digest of every record's hash — the single value that attests to the run. */
export function sessionHash(records: AatRecord[]): string {
  return sha256hex(records.map((r) => r.hash).join(''));
}

/** Build the terminal `session.close` record carrying the session_hash. */
export function closeRecord(records: AatRecord[], agentId = 'gridflow'): AatRecord {
  const prev = records[records.length - 1];
  return appendRecord(prev, {
    ts: new Date().toISOString(),
    agentId,
    action: 'session.close',
    resource: 'session',
    outcome: 'closed',
    trustLevel: 'system',
    metadata: { sessionHash: sessionHash(records) },
  });
}

export interface ChainVerification {
  ok: boolean;
  length: number;
  /** 0-based index of the first broken record, if any. */
  brokenAt?: number;
  reason?: string;
  sessionHash?: string;
}

/**
 * Verify the hash chain: each record's stored hash must recompute from its
 * content, and its prevHash must equal the previous record's hash. Any edit,
 * reorder, insertion, or deletion is detected.
 */
export function verifyChain(records: AatRecord[]): ChainVerification {
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.prevHash !== prevHash) {
      return { ok: false, length: records.length, brokenAt: i, reason: 'prevHash does not match the previous record (a record was altered, reordered, inserted, or removed)' };
    }
    const { hash, ...sansHash } = r;
    if (hashOf(sansHash) !== hash) {
      return { ok: false, length: records.length, brokenAt: i, reason: 'record content was altered (hash mismatch)' };
    }
    prevHash = hash;
  }
  return { ok: true, length: records.length, sessionHash: records.length ? sessionHash(records) : undefined };
}

/** Parse a `.aat.jsonl` blob into records (skips blank/garbage lines). */
export function parseAatJsonl(text: string): AatRecord[] {
  const out: AatRecord[] = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const r = JSON.parse(t);
      if (r && typeof r === 'object' && typeof r.hash === 'string') out.push(r as AatRecord);
    } catch {
      /* skip non-JSON lines */
    }
  }
  return out;
}

export function serializeRecord(record: AatRecord): string {
  return JSON.stringify(record);
}
