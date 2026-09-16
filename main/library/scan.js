// Incremental library scanning (docs/design/07 §4).
//
// A scan answers one question per file — "what is this, relative to what we
// already catalogued?" — and then applies only the answers that are safe to
// apply without asking. It deliberately does NOT decide what any of those
// answers mean: identity.js does that, and this module's job is to be
// incremental, to be interruptible, and to keep its hands off `ch.files`.
//
// Nothing here touches channels.json. A scan changes the CATALOGUE; what airs
// changes only when somebody rematerializes a channel, which is a separate
// command with a diffSchedules preview (§3, contract C6).
//
// Everything external is injected — the directory listing, the fingerprinter,
// the duration probe — so this runs unchanged against a local root, a
// provider root (whose lister is a media-source plugin's listing call), and a
// test's fixture. No Electron, no fs of its own.
const identity = require('./identity');

// Incremental means: only files whose cheap stat moved get their first
// megabyte read again. On a library of tens of thousands of items that is the
// difference between a scan you can run on a timer and one you cannot.
function unchangedSince(item, entry) {
  if (!item || !item.fingerprint) return false;
  return !identity.needsRehash(item.fingerprint, { size: entry.size, mtimeMs: entry.mtimeMs });
}

/**
 * Walks one root and reports what it found. Applies nothing.
 *
 * list(rootRef)           -> [{ ref, size, mtimeMs }]      cheap, no hashing
 * fingerprint(ref)        -> { size, mtime, head }         the expensive part
 * probeDuration(ref)      -> seconds | null                optional
 * signal                  -> { aborted }                   optional co-operative cancel
 *
 * The report buckets by verdict so the caller can apply `same`/`moved`
 * unattended and put `ambiguous`/`replaced` in front of a person.
 */
async function scanRoot({ store, root, list, fingerprint, probeDuration = null, onProgress = null, signal = null }) {
  const known = store.itemsInRoot(root.id);
  const knownByRef = new Map(known.map((item) => [item.ref, item]));
  const seenItemIds = new Set();

  const report = {
    root: root.id,
    scannedAt: Date.now(),
    aborted: false,
    // Verdicts, each entry carrying enough for the caller to act or to explain.
    same: [], moved: [], ambiguous: [], replaced: [], added: [], missing: [],
    // How much work the incremental path avoided, which is the thing worth
    // watching when a scan starts feeling slow.
    hashed: 0,
    skipped: 0,
    probed: 0,
    errors: [],
  };

  const entries = await list(root.ref);
  for (let i = 0; i < entries.length; i += 1) {
    if (signal && signal.aborted) { report.aborted = true; break; }
    const entry = entries[i];
    const existing = knownByRef.get(entry.ref) || null;

    // The incremental skip: same path, same size, same mtime — nothing to do.
    if (existing && unchangedSince(existing, entry)) {
      report.skipped += 1;
      report.same.push({ ref: entry.ref, item: existing.id });
      seenItemIds.add(existing.id);
      if (onProgress) onProgress({ done: i + 1, total: entries.length, ref: entry.ref, action: 'skipped' });
      continue;
    }

    let observed;
    try {
      observed = { ref: entry.ref, fingerprint: await fingerprint(entry.ref) };
      report.hashed += 1;
    } catch (e) {
      // A file that vanished mid-scan, or one we cannot read. Not fatal, and
      // NOT treated as missing: it was listed a moment ago, so reporting it as
      // gone could trigger a relink it does not need.
      report.errors.push({ ref: entry.ref, message: e.message });
      if (onProgress) onProgress({ done: i + 1, total: entries.length, ref: entry.ref, action: 'error' });
      continue;
    }

    // Candidates are drawn from the WHOLE library, not just this root: a file
    // moved between two catalogued roots should read as `moved`, not as one
    // `missing` plus one `added`.
    const verdict = identity.classify(observed, store.allItems());

    if (verdict.kind === 'same' || verdict.kind === 'moved') {
      seenItemIds.add(verdict.item.id);
    }
    if (verdict.kind === 'same') {
      report.same.push({ ref: entry.ref, item: verdict.item.id, fingerprint: observed.fingerprint });
    } else if (verdict.kind === 'moved') {
      report.moved.push({ ref: entry.ref, item: verdict.item.id, from: verdict.from, fingerprint: observed.fingerprint });
    } else if (verdict.kind === 'ambiguous') {
      report.ambiguous.push({ ref: entry.ref, items: verdict.items.map((item) => item.id), reason: verdict.reason });
    } else if (verdict.kind === 'replaced') {
      report.replaced.push({ ref: entry.ref, item: verdict.item.id, reason: verdict.reason, fingerprint: observed.fingerprint });
      seenItemIds.add(verdict.item.id); // it is still catalogued here, just not this content
    } else {
      let duration = null;
      if (probeDuration) {
        try {
          duration = await probeDuration(entry.ref);
          report.probed += 1;
        } catch (e) {
          report.errors.push({ ref: entry.ref, message: `duration: ${e.message}` });
        }
      }
      report.added.push({ ref: entry.ref, root: root.id, fingerprint: observed.fingerprint, duration });
    }
    if (onProgress) onProgress({ done: i + 1, total: entries.length, ref: entry.ref, action: verdict.kind });
  }

  // Catalogued in this root but not seen. Only meaningful for a scan that ran
  // to completion — an aborted one has simply not looked everywhere yet, and
  // reporting half a root as missing would be worse than reporting nothing.
  if (!report.aborted) {
    known.forEach((item) => {
      if (!seenItemIds.has(item.id)) report.missing.push({ item: item.id, ref: item.ref });
    });
  }
  return report;
}

/**
 * Applies the safe half of a report: new items are catalogued, moved ones are
 * repointed, refreshed fingerprints are stored. Ambiguous and replaced entries
 * are returned untouched for review.
 *
 * `missing` is reported, never acted on. A drive that is unplugged, a network
 * share that is slow to mount and a folder somebody really did delete look
 * identical from here, and the first two are far more common.
 */
function applyScan(store, report, { now = () => Date.now() } = {}) {
  const applied = { added: 0, moved: 0, refreshed: 0 };

  report.added.forEach((entry) => {
    const item = store.addItem({
      ref: entry.ref,
      root: entry.root,
      fingerprint: entry.fingerprint,
      duration: entry.duration,
      // No title, tags or facets: those are the auto-tagging pass's job (§5),
      // and inventing them here would make every suggestion look user-supplied.
      provenance: {},
    });
    entry.item = item.id;
    applied.added += 1;
  });

  report.moved.forEach((entry) => {
    store.updateItem(entry.item, { ref: entry.ref, fingerprint: entry.fingerprint, movedAt: now() });
    applied.moved += 1;
  });

  // A `same` verdict reached through a re-hash (its mtime moved) carries a
  // fresh fingerprint worth storing, so the next scan can skip it again.
  report.same.forEach((entry) => {
    if (!entry.fingerprint) return;
    store.updateItem(entry.item, { fingerprint: entry.fingerprint });
    applied.refreshed += 1;
  });

  return {
    ...applied,
    needsReview: report.ambiguous.length + report.replaced.length,
    missing: report.missing.length,
  };
}

// A one-line summary for the setup screen and the scan log.
function describeScan(report) {
  const parts = [];
  if (report.added.length) parts.push(`${report.added.length} new`);
  if (report.moved.length) parts.push(`${report.moved.length} moved`);
  if (report.ambiguous.length) parts.push(`${report.ambiguous.length} need a decision`);
  if (report.replaced.length) parts.push(`${report.replaced.length} changed on disk`);
  if (report.missing.length) parts.push(`${report.missing.length} not found`);
  if (!parts.length) parts.push('nothing changed');
  return `${parts.join(', ')} (${report.skipped} unchanged, ${report.hashed} read)`;
}

module.exports = { scanRoot, applyScan, describeScan, unchangedSince };
