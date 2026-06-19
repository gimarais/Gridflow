import * as assert from 'node:assert/strict';
import {
  AatRecord,
  GENESIS_HASH,
  appendRecord,
  canonicalize,
  closeRecord,
  parseAatJsonl,
  serializeRecord,
  sessionHash,
  verifyChain,
} from '../../extension/compliance/aat';

function chain(n: number): AatRecord[] {
  const records: AatRecord[] = [];
  for (let i = 0; i < n; i++) {
    records.push(
      appendRecord(records[records.length - 1], {
        ts: `2026-06-16T10:0${i}:00.000Z`,
        agentId: 'claude',
        action: 'row.update',
        resource: `wf#r${i}`,
        outcome: i % 2 ? 'done' : 'running',
        trustLevel: 'reported',
        metadata: { costUsd: i * 0.01 },
      }),
    );
  }
  return records;
}

describe('compliance/aat (IETF Agent Audit Trail core)', () => {
  describe('canonicalize', () => {
    it('is deterministic regardless of key order', () => {
      assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
      assert.equal(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}');
    });
    it('recurses into nested objects and arrays', () => {
      assert.equal(canonicalize({ z: [{ y: 1, x: 2 }] }), '{"z":[{"x":2,"y":1}]}');
    });
    it('omits undefined properties', () => {
      assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
    });
  });

  describe('appendRecord / hash chain', () => {
    it('links each record to the previous via prevHash, genesis first', () => {
      const [r0, r1] = chain(2);
      assert.equal(r0.prevHash, GENESIS_HASH);
      assert.equal(r0.seq, 1);
      assert.equal(r1.prevHash, r0.hash);
      assert.equal(r1.seq, 2);
      assert.notEqual(r0.hash, r1.hash);
    });
    it('produces 64-hex-char SHA-256 hashes', () => {
      assert.match(chain(1)[0].hash, /^[0-9a-f]{64}$/);
    });
  });

  describe('verifyChain', () => {
    it('accepts an intact chain and returns the session hash', () => {
      const records = chain(5);
      const v = verifyChain(records);
      assert.equal(v.ok, true);
      assert.equal(v.length, 5);
      assert.equal(v.sessionHash, sessionHash(records));
    });

    it('detects an altered record (content tamper)', () => {
      const records = chain(4);
      records[2] = { ...records[2], outcome: 'failed' }; // mutate without re-hashing
      const v = verifyChain(records);
      assert.equal(v.ok, false);
      assert.equal(v.brokenAt, 2);
      assert.match(v.reason!, /altered/);
    });

    it('detects a removed record (chain break)', () => {
      const records = chain(4);
      records.splice(1, 1); // drop record #2
      const v = verifyChain(records);
      assert.equal(v.ok, false);
      assert.equal(v.brokenAt, 1);
    });

    it('detects reordering', () => {
      const records = chain(3);
      const swapped = [records[0], records[2], records[1]];
      assert.equal(verifyChain(swapped).ok, false);
    });

    it('an empty chain is trivially valid', () => {
      assert.deepEqual(verifyChain([]), { ok: true, length: 0, sessionHash: undefined });
    });
  });

  describe('closeRecord / sessionHash', () => {
    it('closeRecord chains on and carries the session hash of the prior records', () => {
      const records = chain(3);
      const close = closeRecord(records);
      assert.equal(close.action, 'session.close');
      assert.equal(close.prevHash, records[records.length - 1].hash);
      assert.equal((close.metadata as { sessionHash: string }).sessionHash, sessionHash(records));
      // The full chain including the close record still verifies.
      assert.equal(verifyChain([...records, close]).ok, true);
    });
  });

  describe('jsonl round-trip', () => {
    it('parses serialized records and skips blank/garbage lines', () => {
      const records = chain(3);
      const blob = records.map(serializeRecord).join('\n') + '\n\nnot-json\n';
      const parsed = parseAatJsonl(blob);
      assert.equal(parsed.length, 3);
      assert.equal(verifyChain(parsed).ok, true);
    });
  });
});
