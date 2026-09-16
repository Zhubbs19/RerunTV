// Library item identity (docs/design/07 §4) — specifically the behaviours the
// 2026-09-15 audit said had to be pinned down BEFORE anything relinks
// automatically: what an ambiguous match does, what a changed mtime does, and
// how a metadata conflict is resolved deterministically.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const identity = require('../main/library/identity');

const fp = (size, mtime, head) => ({ size, mtime, head });
const item = (id, ref, fingerprint) => ({ id, ref, fingerprint });

test('a changed mtime alone does not make it a different file', () => {
  const stored = fp(1000, 111, 'sha1:aaa');
  const touched = fp(1000, 999, 'sha1:aaa');
  assert.equal(identity.sameContent(stored, touched), true,
    'a copy, a restore or a sync client touching a file changes mtime, not content');

  const known = [item('itm_1', 'J:\\a.mkv', stored)];
  const result = identity.classify({ ref: 'J:\\a.mkv', fingerprint: touched }, known);
  assert.equal(result.kind, 'same');
  assert.equal(identity.isAutoApplicable(result), true);
});

test('mtime is a pre-filter for re-reading, not a verdict', () => {
  const stored = fp(1000, 111, 'sha1:aaa');
  assert.equal(identity.needsRehash(stored, { size: 1000, mtimeMs: 111 }), false);
  assert.equal(identity.needsRehash(stored, { size: 1000, mtimeMs: 222 }), true, 'look again');
  assert.equal(identity.needsRehash(stored, { size: 2000, mtimeMs: 111 }), true);
  assert.equal(identity.needsRehash({ size: 1000, mtime: 111, head: null }, { size: 1000, mtimeMs: 111 }), true,
    'no content evidence yet');
});

test('one moved file relinks on its own; two identical ones do not', () => {
  const content = fp(500, 10, 'sha1:bbb');
  const moved = identity.classify(
    { ref: 'J:\\new\\a.mkv', fingerprint: content },
    [item('itm_1', 'J:\\old\\a.mkv', content)],
  );
  assert.equal(moved.kind, 'moved');
  assert.equal(moved.from, 'J:\\old\\a.mkv');
  assert.equal(moved.to, 'J:\\new\\a.mkv');
  assert.equal(identity.isAutoApplicable(moved), true);

  const ambiguous = identity.classify(
    { ref: 'J:\\new\\a.mkv', fingerprint: content },
    [item('itm_1', 'J:\\old\\a.mkv', content), item('itm_2', 'K:\\backup\\a.mkv', content)],
  );
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.equal(ambiguous.items.length, 2);
  assert.equal(ambiguous.confidence, 'low');
  assert.equal(identity.isAutoApplicable(ambiguous), false,
    'a size and a first megabyte are evidence, not proof — a human picks');
});

test('different content at a known path is a replacement, not a rename', () => {
  const before = fp(500, 10, 'sha1:bbb');
  const after = fp(900, 20, 'sha1:ccc');
  const result = identity.classify(
    { ref: 'J:\\a.mkv', fingerprint: after },
    [item('itm_1', 'J:\\a.mkv', before)],
  );
  assert.equal(result.kind, 'replaced');
  assert.equal(identity.isAutoApplicable(result), false,
    'a re-encode or a recycled filename must not inherit the old title and tags silently');
});

test('size is what separates a truncated copy from its original', () => {
  // A short file and a truncated copy of a longer one hash the same head.
  assert.equal(identity.sameContent(fp(1000, 1, 'sha1:aaa'), fp(400, 1, 'sha1:aaa')), false);
});

test('a provider item with no etag is never matched on size alone', () => {
  const withEtag = identity.fingerprintProvider({ id: 'jellyfin', etag: 'v1', size: 100 });
  const sameEtag = identity.fingerprintProvider({ id: 'jellyfin', etag: 'v1', size: 100 });
  const noEtag = identity.fingerprintProvider({ id: 'jellyfin', etag: null, size: 100 });
  assert.equal(identity.sameContent(withEtag, sameEtag), true);
  assert.equal(identity.sameContent(noEtag, noEtag), false, 'no content evidence means no match');
  assert.equal(identity.classify({ ref: 'mediasource:jellyfin:x', fingerprint: noEtag }, []).kind, 'new');
});

test('an unknown file is new, and nothing is guessed about it', () => {
  const result = identity.classify({ ref: 'J:\\z.mkv', fingerprint: fp(1, 1, 'sha1:zzz') }, [
    item('itm_1', 'J:\\a.mkv', fp(2, 1, 'sha1:aaa')),
  ]);
  assert.equal(result.kind, 'new');
});

// ---------- Metadata conflict policy (docs/design/07 §7) ----------

test('a hand-typed value beats a guessed one whatever the timestamps say', () => {
  const winner = identity.resolveConflict([
    { value: 'Guessed From Filename', provenance: 'path', editedAt: 9999, sourceKey: 5 },
    { value: 'The Dundies', provenance: 'user', editedAt: 1, sourceKey: 9 },
  ]);
  assert.equal(winner.value, 'The Dundies');
});

test('provenance ranks user over accepted over plugin over embedded over path', () => {
  const order = ['user', 'user-accepted', 'plugin', 'embedded', 'path', 'unknown'];
  for (let i = 1; i < order.length; i += 1) {
    assert.ok(identity.provenanceRank(order[i - 1]) > identity.provenanceRank(order[i]),
      `${order[i - 1]} outranks ${order[i]}`);
  }
  assert.equal(identity.provenanceRank('something-new'), identity.provenanceRank('unknown'));
});

test('equal provenance falls back to recency, then to a stable key', () => {
  const byRecency = identity.resolveConflict([
    { value: 'older', provenance: 'user', editedAt: 100, sourceKey: 2 },
    { value: 'newer', provenance: 'user', editedAt: 200, sourceKey: 7 },
  ]);
  assert.equal(byRecency.value, 'newer');

  // The case the audit was worried about: same provenance, no timestamps. The
  // winner must not depend on the order the candidates were walked in.
  const candidates = [
    { value: 'from channel 7', provenance: 'user', sourceKey: 7 },
    { value: 'from channel 2', provenance: 'user', sourceKey: 2 },
    { value: 'from channel 11', provenance: 'user', sourceKey: 11 },
  ];
  assert.equal(identity.resolveConflict(candidates).value, 'from channel 2');
  assert.equal(identity.resolveConflict(candidates.slice().reverse()).value, 'from channel 2',
    'the same inputs in a different order give the same answer');
  // Channel numbers compare numerically, so 2 wins over 11 rather than "11"
  // sorting before "2" as text.
  assert.equal(identity.resolveConflict([
    { value: 'eleven', provenance: 'user', sourceKey: 11 },
    { value: 'two', provenance: 'user', sourceKey: 2 },
  ]).value, 'two');
});

test('nothing to choose from resolves to null rather than to undefined', () => {
  assert.equal(identity.resolveConflict([]), null);
  assert.equal(identity.resolveConflict([{ value: null, provenance: 'user' }]), null);
  assert.equal(identity.resolveConflict([{ value: undefined, provenance: 'user' }]), null);
  assert.equal(identity.resolveConflict([{ value: '', provenance: 'user', sourceKey: 1 }]).value, '',
    'an empty string is a real value somebody chose');
});

// ---------- The hash, against real bytes ----------

test('the head hash reads the first megabyte and the size separates truncations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reruntv-library-'));
  const long = path.join(dir, 'long.bin');
  const short = path.join(dir, 'short.bin');
  const different = path.join(dir, 'different.bin');
  const head = Buffer.alloc(identity.HEAD_BYTES, 7);

  fs.writeFileSync(long, Buffer.concat([head, Buffer.alloc(1000, 9)]));
  fs.writeFileSync(short, head);                       // same first MB, shorter
  fs.writeFileSync(different, Buffer.alloc(identity.HEAD_BYTES, 8));

  const a = await identity.fingerprintLocal(long);
  const b = await identity.fingerprintLocal(short);
  const c = await identity.fingerprintLocal(different);

  assert.equal(a.head, b.head, 'the same first megabyte hashes the same');
  assert.notEqual(a.head, c.head);
  assert.equal(identity.sameContent(a, b), false, 'but the sizes differ, so they are not the same item');
  assert.equal(identity.sameContent(a, a), true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a migrated item with no fingerprint yet is the same item, not a replacement', () => {
  // Migration fingerprints lazily. The first scan must adopt, not flag 2,173 files.
  const migrated = [{ id: 'itm_1', ref: 'J:\\a.mkv', fingerprint: null }];
  const result = identity.classify({ ref: 'J:\\a.mkv', fingerprint: fp(100, 1, 'sha1:a') }, migrated);
  assert.equal(result.kind, 'same');
  assert.equal(result.adopt, true);
  assert.equal(result.confidence, 'ref-only');
  assert.equal(identity.isAutoApplicable(result), true);
});

test('a provider item keeps its identity by ref when no etag exists on either side', () => {
  const noEtag = identity.fingerprintProvider({ id: 'archive', etag: null, size: null });
  const known = [{ id: 'itm_p', ref: 'mediasource:archive:clip', fingerprint: noEtag }];
  const result = identity.classify({ ref: 'mediasource:archive:clip', fingerprint: noEtag }, known);
  assert.equal(result.kind, 'same');
});

test('an item WITH evidence at a ref still reads as replaced when the content differs', () => {
  const known = [{ id: 'itm_1', ref: 'J:\\a.mkv', fingerprint: fp(100, 1, 'sha1:a') }];
  assert.equal(identity.classify({ ref: 'J:\\a.mkv', fingerprint: fp(9, 9, 'sha1:z') }, known).kind, 'replaced');
});
