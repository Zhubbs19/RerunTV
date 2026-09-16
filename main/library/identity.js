// Library item identity (docs/design/07 §4, contract C6).
//
// The design doc calls a fingerprint "size + mtime + a hash of the first 1 MB"
// and says relinking "becomes automatic". The 2026-09-15 audit corrected that,
// and this module is where the correction lives: **a fingerprint is matching
// EVIDENCE, not an identity.** Two different files can share a size and a first
// megabyte (an encoder's identical leader, two rips of the same disc, a
// truncated copy), and one file's mtime changes for reasons that have nothing
// to do with its bytes (a copy, a backup restore, a sync client touching it).
//
// So nothing here returns "this is the same file". It returns a classification
// with a confidence, and the caller decides what may happen automatically. The
// rule the rest of the library follows is: only `same` and `moved` relink on
// their own; `ambiguous` and `replaced` go to a review queue and change nothing.
//
// Electron-free and pure apart from the hash, so it can be tested directly.
const crypto = require('crypto');
const fs = require('fs');

// A megabyte is enough to separate genuinely different content while staying
// cheap on a spinning disk and on a provider root fetched over the network.
const HEAD_BYTES = 1024 * 1024;

// Reads the first HEAD_BYTES of a file and hashes them. A file shorter than
// that hashes whatever it has, which is why `size` is part of the fingerprint:
// a truncated copy has the same head hash as the original but a different size.
async function hashHead(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return `sha1:${crypto.createHash('sha1').update(buffer.subarray(0, bytesRead)).digest('hex')}`;
  } finally {
    await handle.close();
  }
}

async function fingerprintLocal(filePath) {
  const stat = await fs.promises.stat(filePath);
  return { size: stat.size, mtime: Math.round(stat.mtimeMs), head: await hashHead(filePath) };
}

// A provider root has no filesystem to read (docs/design/07 §4). Its listing
// supplies an id and an etag/modified stamp, and those stand in for the
// fingerprint — with `head: null`, which classify() treats as "no content
// evidence", so a provider item is never relinked across refs on size alone.
function fingerprintProvider({ id, etag, size }) {
  return { size: Number.isFinite(size) ? size : null, mtime: null, head: etag ? `etag:${etag}` : null, providerId: id || null };
}

// Do two fingerprints agree about the CONTENT? mtime is deliberately not part
// of this: it is a cheap pre-filter for deciding what to re-hash, never
// evidence that bytes differ. A file that was copied, restored from a backup or
// touched by a sync client has a new mtime and the same content.
function sameContent(a, b) {
  if (!a || !b) return false;
  if (!a.head || !b.head) return false; // no content evidence either side
  return a.head === b.head && a.size === b.size;
}

// Whether a stored fingerprint needs re-reading before it can be trusted. Size
// or mtime moving is the signal to go and look; it is not itself a verdict.
function needsRehash(stored, stat) {
  if (!stored || !stat) return true;
  if (!stored.head) return true;
  return stored.size !== stat.size || Math.round(stat.mtimeMs) !== stored.mtime;
}

// ---------- Classification ----------
// `candidates` are existing items whose fingerprint could match `observed`.
// Returns one of:
//   same       the item is still at the ref it was catalogued at
//   moved      exactly one item elsewhere has this content — safe to relink
//   ambiguous  more than one item has this content, and they are not all the
//              same item: a human decides, nothing moves on its own
//   replaced   an item is catalogued at this ref, but the content there is now
//              different. The item is NOT repointed and its metadata is NOT
//              transferred to the new content — that is how a re-encode or a
//              recycled filename silently inherits the wrong title otherwise.
//   new        nothing known matches
function classify(observed, candidates = []) {
  const atRef = candidates.filter((item) => item.ref === observed.ref);
  const byContent = candidates.filter((item) => sameContent(item.fingerprint, observed.fingerprint));

  if (atRef.length && byContent.some((item) => item.id === atRef[0].id)) {
    return { kind: 'same', item: atRef[0], confidence: 'high' };
  }
  if (byContent.length === 1) {
    return {
      kind: 'moved',
      item: byContent[0],
      from: byContent[0].ref,
      to: observed.ref,
      confidence: 'high',
    };
  }
  if (byContent.length > 1) {
    return {
      kind: 'ambiguous',
      items: byContent,
      reason: `${byContent.length} catalogued items have the same size and first megabyte`,
      confidence: 'low',
    };
  }
  if (atRef.length) {
    return {
      kind: 'replaced',
      item: atRef[0],
      reason: 'the file at this path is not the content that was catalogued here',
      confidence: 'high',
    };
  }
  return { kind: 'new', confidence: 'high' };
}

// Only these two may be applied without asking. Kept as a function rather than
// a set the caller reads, so "what relinks automatically" has exactly one
// definition in the codebase.
function isAutoApplicable(result) {
  return result.kind === 'same' || result.kind === 'moved';
}

// ---------- Metadata conflict policy (docs/design/07 §7) ----------
// Migration folds per-channel copies of the same file into one item, and two
// channels can disagree. "Most recently edited wins" is not enough on its own:
// timestamps are often absent or equal, and then the winner is whatever order
// the walk happened to take, which makes a migration unreproducible.
//
// So: provenance first, then recency, then a stable tiebreak that does not
// depend on iteration order. Running the same migration twice gives the same
// library.
const PROVENANCE_RANK = {
  user: 5,           // typed in by hand
  'user-accepted': 4, // a suggestion somebody confirmed
  plugin: 3,          // an opt-in metadata plugin (TMDB and friends)
  embedded: 2,        // container/ID3 tags
  path: 1,            // guessed from the filename or folder
  unknown: 0,
};

function provenanceRank(name) {
  return PROVENANCE_RANK[name] === undefined ? PROVENANCE_RANK.unknown : PROVENANCE_RANK[name];
}

// candidates: [{ value, provenance, editedAt, sourceKey }]. sourceKey is the
// deterministic tiebreak — the channel number the copy came from, as a string.
// Returns the winning candidate, or null when there is nothing to choose from.
function resolveConflict(candidates = []) {
  const usable = candidates.filter((entry) => entry && entry.value !== undefined && entry.value !== null);
  if (!usable.length) return null;
  return usable.slice().sort((a, b) => {
    const rank = provenanceRank(b.provenance) - provenanceRank(a.provenance);
    if (rank) return rank;
    const edited = (b.editedAt || 0) - (a.editedAt || 0);
    if (edited) return edited;
    // Numeric where both look numeric (channel numbers), lexicographic
    // otherwise, so the order never depends on how the candidates were walked.
    const aKey = String(a.sourceKey === undefined ? '' : a.sourceKey);
    const bKey = String(b.sourceKey === undefined ? '' : b.sourceKey);
    const aNum = Number(aKey);
    const bNum = Number(bKey);
    if (Number.isFinite(aNum) && Number.isFinite(bNum) && aNum !== bNum) return aNum - bNum;
    return aKey.localeCompare(bKey);
  })[0];
}

module.exports = {
  HEAD_BYTES,
  hashHead,
  fingerprintLocal,
  fingerprintProvider,
  sameContent,
  needsRehash,
  classify,
  isAutoApplicable,
  resolveConflict,
  provenanceRank,
  PROVENANCE_RANK,
};
