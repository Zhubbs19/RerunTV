// Building the library from an existing lineup (docs/design/07 §7).
//
// The doc calls this the riskiest change in the whole set, so it is split into
// parts that can each be checked before anything is written:
//
//   planMigration(config)   pure. Returns the library index it would create and
//                           a copy of config with library ids attached. Touches
//                           neither input.
//   verify (caller's job)   diffSchedules over 60 days, per channel, between the
//                           original channel and the planned one. It lives in
//                           renderer/js/core/schedule-query.js, so this module
//                           takes the result rather than importing it.
//   finalizeMigration(plan, verdicts)
//                           keeps only the channels whose diff was empty. A
//                           channel that fails stays exactly as it was (legacy),
//                           and nothing in the library refers to it.
//
// What a migrated channel changes, deliberately little: each file gains an
// `item` id. Its path, duration, order and anchor are untouched, and its own
// metadata stays where it is so every existing reader keeps working (the doc's
// one-release dual-read). The library item holds the resolved metadata; a
// channel whose value lost the conflict records it in `fileOverrides`, so
// nothing is lost when dual-read ends.
const crypto = require('crypto');
const { resolveConflict } = require('./identity');
const { emptyIndex } = require('./store');

// Per-file metadata that moves to the library (docs/design/07 §3). Kept to the
// fields renderer/js/core/commands.js's file.set already treats as metadata;
// path, duration and folder are playlist structure and stay on the channel.
const METADATA_FIELDS = [
  'title', 'tags', 'facets', 'description', 'tmdb', 'rating', 'advisory', 'advisoryCues',
  'hasCC', 'hasSAP', 'hasStereo', 'creditsLeadS', 'creditsSqueezeBgImage',
];

// Stable across re-runs of the same migration: the same path always plans the
// same id, so running it twice produces the same library. After migration an
// id never changes again, even when the file moves (store.js).
function plannedItemId(ref) {
  return `itm_${crypto.createHash('sha1').update(String(ref)).digest('hex').slice(0, 16)}`;
}

function plannedRootId(folder) {
  return `root_${crypto.createHash('sha1').update(`${folder.source || 'local'}|${folder.ref}`).digest('hex').slice(0, 16)}`;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Every playlist a channel owns: its default files and each block's files.
// Blocks carry their own `files` in the schema even though today's lineup has
// none, and a migration that silently skipped them would leave items behind.
function playlistsOf(channel) {
  const lists = [{ owner: 'channel', files: channel.files || [] }];
  (channel.blocks || []).forEach((block) => {
    if (Array.isArray(block.files) && block.files.length) lists.push({ owner: `block:${block.id}`, files: block.files });
  });
  return lists;
}

/**
 * Plans the migration. Pure — neither `config` nor anything in it is modified.
 * Returns { index, config, channels, conflicts }.
 */
function planMigration(config, { now = () => Date.now() } = {}) {
  const planned = cloneJson(config);
  const index = emptyIndex();
  const rootsById = new Map();
  // ref -> [{ channel, owner, file }] across every channel, so conflicts can be
  // resolved once per item rather than once per channel.
  const occurrences = new Map();

  (planned.channels || []).forEach((channel) => {
    // Folders become roots one to one. Consolidating `J:\Media Center\TV Shows`
    // and its siblings into one parent root would be tidier, but it is a guess
    // about how somebody's disks are organised, and a migration should not guess.
    (channel.folders || []).forEach((folder) => {
      if (!folder || !folder.ref) return;
      const id = plannedRootId(folder);
      if (!rootsById.has(id)) {
        rootsById.set(id, {
          id,
          ref: folder.ref,
          kind: !folder.source || folder.source === 'local' ? 'local' : 'provider',
          source: folder.source || 'local',
          label: folder.label || null,
          addedAt: now(),
        });
      }
    });
    playlistsOf(channel).forEach(({ owner, files }) => {
      files.forEach((file) => {
        if (!file || !file.path) return;
        if (!occurrences.has(file.path)) occurrences.set(file.path, []);
        occurrences.get(file.path).push({ channel: channel.number, owner, file });
      });
    });
  });
  index.roots = [...rootsById.values()];

  // Which root a file belongs to: the folder it was scanned from, when the file
  // records one, otherwise the longest root ref that prefixes its path.
  const folderRoot = new Map();
  (planned.channels || []).forEach((channel) => {
    (channel.folders || []).forEach((folder) => {
      if (folder && folder.id && folder.ref) folderRoot.set(`${channel.number}|${folder.id}`, plannedRootId(folder));
    });
  });
  function rootFor(channelNumber, file) {
    const byFolder = file.folder != null && folderRoot.get(`${channelNumber}|${file.folder}`);
    if (byFolder) return byFolder;
    const match = index.roots
      .filter((root) => String(file.path).startsWith(root.ref))
      .sort((a, b) => b.ref.length - a.ref.length)[0];
    return match ? match.id : null;
  }

  const conflicts = [];
  const perChannel = new Map();

  occurrences.forEach((uses, ref) => {
    // A file that was already given an id keeps it — a re-run must not re-key.
    const existingId = uses.map((use) => use.file.item).find(Boolean);
    const id = existingId || plannedItemId(ref);
    const first = uses[0];
    const item = {
      id,
      ref,
      root: rootFor(first.channel, first.file),
      duration: first.file.duration,
      fingerprint: null, // fingerprinted lazily by the first scan (§4)
      provenance: {},
      addedAt: now(),
    };

    METADATA_FIELDS.forEach((field) => {
      const candidates = uses
        .filter((use) => use.file[field] !== undefined && use.file[field] !== null)
        .map((use) => ({
          value: use.file[field],
          // The config never recorded who set a value. `tmdb` present means a
          // metadata plugin filled the file in; anything else is unknown, which
          // ranks below every real provenance and falls through to the stable
          // channel-number tiebreak.
          provenance: use.file.tmdb && field !== 'tmdb' ? 'plugin' : 'unknown',
          sourceKey: use.channel,
          use,
        }));
      const winner = resolveConflict(candidates);
      if (!winner) return;
      item[field] = cloneJson(winner.value);
      item.provenance[field] = winner.provenance;

      const losers = candidates.filter((candidate) => !sameValue(candidate.value, winner.value));
      if (losers.length) {
        conflicts.push({ item: id, ref, field, kept: { channel: winner.sourceKey }, overridden: losers.map((l) => l.sourceKey) });
        losers.forEach((loser) => {
          const channel = planned.channels.find((ch) => ch.number === loser.sourceKey);
          if (!channel.fileOverrides) channel.fileOverrides = {};
          if (!channel.fileOverrides[id]) channel.fileOverrides[id] = {};
          channel.fileOverrides[id][field] = cloneJson(loser.value);
        });
      }
    });

    Object.defineProperty(index.items, id, { value: item, enumerable: true, configurable: true, writable: true });
    uses.forEach((use) => {
      use.file.item = id;
      const stats = perChannel.get(use.channel) || { items: 0, conflicts: 0 };
      stats.items += 1;
      perChannel.set(use.channel, stats);
    });
  });
  conflicts.forEach((conflict) => {
    [conflict.kept.channel, ...conflict.overridden].forEach((number) => {
      const stats = perChannel.get(number);
      if (stats) stats.conflicts += 1;
    });
  });

  return {
    index,
    config: planned,
    conflicts,
    channels: (planned.channels || []).map((channel) => ({
      number: channel.number,
      name: channel.name,
      files: (channel.files || []).length,
      ...(perChannel.get(channel.number) || { items: 0, conflicts: 0 }),
    })),
  };
}

/**
 * Keeps only the channels whose schedule diff was empty.
 * `verdicts` maps channel number -> { identical: boolean, ... }.
 * A channel with no verdict is treated as failed: not having checked is not
 * the same as having checked and found nothing.
 */
function finalizeMigration(original, plan, verdicts) {
  const accepted = new Set();
  const rejected = [];
  const nextConfig = cloneJson(plan.config);
  nextConfig.channels = nextConfig.channels.map((channel) => {
    const verdict = verdicts[channel.number];
    if (verdict && verdict.identical) {
      accepted.add(channel.number);
      return channel;
    }
    rejected.push({ number: channel.number, reason: verdict ? 'schedule-changed' : 'not-verified', verdict: verdict || null });
    return cloneJson(original.channels.find((ch) => ch.number === channel.number));
  });

  // Only items referenced by an accepted channel make it into the library, so
  // a rejected channel is genuinely untouched — nothing points at it.
  const referenced = new Set();
  nextConfig.channels.forEach((channel) => {
    if (!accepted.has(channel.number)) return;
    playlistsOf(channel).forEach(({ files }) => files.forEach((file) => file.item && referenced.add(file.item)));
  });
  const index = emptyIndex();
  Object.values(plan.index.items).forEach((item) => {
    if (referenced.has(item.id)) Object.defineProperty(index.items, item.id, { value: item, enumerable: true, configurable: true, writable: true });
  });
  const usedRoots = new Set(Object.values(index.items).map((item) => item.root));
  index.roots = plan.index.roots.filter((root) => usedRoots.has(root.id));

  return { index, config: nextConfig, accepted: [...accepted], rejected };
}

module.exports = { planMigration, finalizeMigration, plannedItemId, METADATA_FIELDS };
