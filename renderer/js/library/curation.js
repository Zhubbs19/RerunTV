// Auto-curation engine — PROGRAMMING > AUTO-CURATE.
//
// Given a saved curation profile (freshCurationProfile, channels.js), scores
// tagged content against the profile's theme seeds and produces a
// deterministic, previewable proposal. Nothing is written to S.config until
// applyCurationProposal() is called, so the setup-autocurate.js wizard can
// "Reshuffle" a preview freely by just changing the seed.
//
// Ad cadence isn't a separate config object this engine needs to build:
// channel-level commercials config was retired (see freshCommercialsConfig's
// comment) — break timing is entirely a function of which CADENCE & PRESETS
// entry (setup-interstitials.js) matches a piece of content's own tags
// (resolveActiveCommercials, schedule.js). So "curating ad density" just
// means the curated files carry tags that overlap an existing preset's
// contentTags — nothing else needs to be written for it to take effect.
import {
  addInterstitialPoolEntry, findFolderEntry, freshBlock, freshChannel, mergeFolderEntries,
  nextChannelNumber, resolveScopeFolderIds, sortedChannels,
} from '../core/channels.js';
import { S } from '../core/state.js';
import { hashString, mulberry32, randomInterstitialId } from '../core/util.js';

function seededShuffle(arr, seed) {
  const rand = mulberry32(seed);
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// genre/contentType are the strongest signals a file actually belongs to a
// theme; era next; mood is the softest (a "cozy" mood spans many genres).
const FACET_WEIGHTS = { genre: 3, contentType: 2, era: 2, mood: 1 };

function tagSetOf(item) {
  return new Set((item.tags || []).map((t) => t.toLowerCase()));
}

// Weighted overlap between a file's own tags (which, per mirrorFacetsIntoTags,
// already include anything set via structured facets) and a themeSeeds
// object ({genre,era,mood,contentType} arrays). A file with no tags at all
// can never score — untagged content is only reachable via an untargeted/
// 'all' pool scope, not by theme match. Takes themeSeeds directly (not a
// profile) so a dayPartTemplate slot's own narrower seeds (buildDayPartPlan
// below) can be scored the same way as the profile's own.
export function scoreCandidate(file, themeSeeds) {
  const tags = tagSetOf(file);
  if (!tags.size) return 0;
  let score = 0;
  Object.entries(FACET_WEIGHTS).forEach(([facet, weight]) => {
    (themeSeeds[facet] || []).forEach((seed) => {
      if (tags.has(String(seed).toLowerCase())) score += weight;
    });
  });
  return score;
}

// A day-part slot only overrides genre/contentType (freshDayPartSlot,
// channels.js) — era/mood always inherit the profile's own seeds, since a
// slot is about "what plays in this hour", not a wholesale re-theme.
function slotThemeSeeds(profile, slot) {
  return {
    genre: slot.genre && slot.genre.length ? slot.genre : profile.themeSeeds.genre,
    contentType: slot.contentType ? [slot.contentType] : profile.themeSeeds.contentType,
    era: profile.themeSeeds.era,
    mood: profile.themeSeeds.mood,
  };
}

// Every file across every channel that falls within the profile's
// contentPoolScope (folders 'all' or an explicit list of ch.folders[] entry
// ids; tags 'any' or an explicit list a file must carry at least one of) —
// the raw candidate set before theme scoring narrows it further.
function poolScope(profile) {
  const { folders, tags } = profile.contentPoolScope;
  const folderIds = Array.isArray(folders) && folders.length ? resolveScopeFolderIds(folders) : folders;
  const files = [];
  sortedChannels().forEach((ch) => {
    ch.files.forEach((f) => {
      if (folderIds !== 'all' && Array.isArray(folderIds) && folderIds.length && !folderIds.includes(f.folder)) return;
      if (Array.isArray(tags) && tags.length) {
        const fTags = tagSetOf(f);
        if (!tags.some((t) => fTags.has(String(t).toLowerCase()))) return;
      }
      files.push(f);
    });
  });
  return files;
}

// A themed rotation cap — generous for a curated block while staying easy
// to review/edit by hand afterward, rather than dumping an entire matched
// library (which could be thousands of files) onto one fresh channel.
const MAX_CURATED_FILES = 60;

// `excludePaths` (a target channel's own current file paths, for a
// re-curate run — see curateChannel below) is filtered out before scoring,
// not after: since apply is add-only and silently skips a path already in
// the channel (applyCurationProposal), scoring in something already
// present would waste a slot in the MAX_CURATED_FILES cap on a no-op
// instead of surfacing genuinely new matches.
export function buildProgrammingPlan(profile, seed, excludePaths) {
  const candidates = poolScope(profile).filter((f) => !excludePaths || !excludePaths.has(f.path));
  const scored = candidates.map((f) => ({ f, score: scoreCandidate(f, profile.themeSeeds) }));
  const matched = scored.filter((s) => s.score > 0);
  // Falls back to the full (unscored) scope when nothing matches the theme
  // seeds yet — e.g. a brand-new profile whose seeds don't match any tagged
  // file yet — so the preview always shows *something* to react to instead
  // of a silent empty channel.
  const pool = (matched.length ? matched : scored).map((s) => s.f);
  const shuffled = seededShuffle(pool, hashString(`${profile.id}:${seed}:programming`));
  const files = shuffled.slice(0, MAX_CURATED_FILES)
    .map((f) => ({ path: f.path, duration: f.duration, folder: f.folder || null, source: f.source || 'local' }));
  // `folder` on a curated file is still just the id it had on its *original*
  // channel — resolve each back to a real ch.folders[]-shaped entry (via
  // findFolderEntry, which scans every channel) so the new/target channel's
  // own ch.folders[] gets proper { id, source, ref, label } objects, not
  // bare ids, matching the shape every other channel's folders[] uses.
  const folderIds = Array.from(new Set(files.map((f) => f.folder).filter(Boolean)));
  const folders = folderIds.map(findFolderEntry).filter(Boolean);
  return { folders, files, matchedCount: matched.length, totalScanned: candidates.length };
}

// Smaller per-slot cap than the flat plan's MAX_CURATED_FILES — a day-part
// slot is a specific hour range, not a whole channel's rotation, so a
// themed handful is more useful to review than dozens.
const MAX_FILES_PER_SLOT = 20;

// One ch.blocks[]-shaped patch per dayPartTemplate slot, each scored against
// the profile's seeds narrowed by that slot's own genre/contentType
// (slotThemeSeeds). `excludePaths` is shared and grows across slots as they're
// built (see the caller below) so the same file never lands in two slots —
// each slot also excludes anything already in the flat plan for the same
// reason. Falls back to the slot's own unscored pool the same way
// buildProgrammingPlan does, so an unmatched slot still previews something.
function buildDayPartSlotPlan(profile, slot, seed, excludePaths) {
  const seeds = slotThemeSeeds(profile, slot);
  const candidates = poolScope(profile).filter((f) => !excludePaths.has(f.path));
  const scored = candidates.map((f) => ({ f, score: scoreCandidate(f, seeds) }));
  const matched = scored.filter((s) => s.score > 0);
  const pool = (matched.length ? matched : scored).map((s) => s.f);
  const shuffled = seededShuffle(pool, hashString(`${profile.id}:${seed}:slot:${slot.id}`));
  const files = shuffled.slice(0, MAX_FILES_PER_SLOT)
    .map((f) => ({ path: f.path, duration: f.duration, folder: f.folder || null, source: f.source || 'local' }));
  return { slot, files, matchedCount: matched.length, totalScanned: candidates.length };
}

// Builds one plan per dayPartTemplate slot in order, each excluding every
// path already claimed by an earlier slot or the flat plan (`baseExclude`)
// so a curated channel doesn't repeat the same file across its own
// dayparts. Returns [] when the profile has no dayPartTemplate — the
// engine's original flat-only behavior.
export function buildDayPartPlan(profile, seed, baseExclude) {
  if (!profile.dayPartTemplate || !profile.dayPartTemplate.length) return [];
  const claimed = new Set(baseExclude || []);
  const plans = [];
  profile.dayPartTemplate.forEach((slot) => {
    const plan = buildDayPartSlotPlan(profile, slot, seed, claimed);
    plan.files.forEach((f) => claimed.add(f.path));
    plans.push(plan);
  });
  return plans;
}

export function resolveAdPreset(profile) {
  if (!profile.adDensity) return null;
  return (S.config.interstitials.presets || []).find((p) => p.id === profile.adDensity) || null;
}

// Proposes new bumper/station-ID/ad-pod-bump interstitial pool entries
// scoped to this channel, tagged with the profile's bumperStyleTags — but
// only for a type nothing in the existing pool already covers for this
// theme, so re-running a profile doesn't pile up duplicate bumpers.
export function buildInterstitialPlan(profile, channelNumber) {
  if (!profile.bumperStyleTags || !profile.bumperStyleTags.length) return [];
  const seedTags = profile.bumperStyleTags.map((t) => String(t).toLowerCase());
  const pool = S.config.interstitials.pool || [];
  const existingTypes = new Set();
  pool.forEach((e) => {
    const eTags = (e.contentTags || []).map((t) => t.toLowerCase());
    if (eTags.length && seedTags.some((t) => eTags.includes(t))) existingTypes.add(e.type);
  });
  const wantedTypes = ['channelId', 'adBreakIn', 'adBreakOut'];
  return wantedTypes
    .filter((type) => !existingTypes.has(type))
    .map((type) => ({
      id: randomInterstitialId(), type, channelAffinity: channelNumber, blockAffinity: null, weight: 1,
      file: null, text: null, contentTags: seedTags,
    }));
}

// Orchestrates the above into a read-only proposal — nothing is written to
// S.config. `seed` is caller-controlled (a wizard "Reshuffle"/"RE-PREVIEW"
// just passes a new one) so the same profile+seed pair always reproduces
// the same result. When the profile targets an existing channel (a
// "re-curate" run), the plan is built to exclude what's already there
// (buildProgrammingPlan's excludePaths) so the diff reflects only what this
// run would actually *add* — merge is always additive, see
// applyCurationProposal below, so anything already present is a no-op and
// shouldn't eat into the preview's file cap or be reported as "new".
export function curateChannel(profile, seed) {
  const isNewChannel = profile.targetChannel == null;
  const targetChannel = isNewChannel ? null : S.config.channels.find((c) => c.number === profile.targetChannel);
  const targetMissing = !isNewChannel && !targetChannel;
  const alreadyPresent = targetChannel ? new Set(targetChannel.files.map((f) => f.path)) : new Set();

  // Day-part slots get first pick (they're the more specific/intentional
  // choice); the flat plan then fills the rest of the rotation, excluding
  // whatever the slots already claimed so nothing repeats between them.
  const dayPartPlans = buildDayPartPlan(profile, seed, alreadyPresent);
  const dayPartExclude = new Set(alreadyPresent);
  dayPartPlans.forEach((p) => p.files.forEach((f) => dayPartExclude.add(f.path)));
  const programming = buildProgrammingPlan(profile, seed, dayPartExclude);

  const adPreset = resolveAdPreset(profile);
  const channelNumber = isNewChannel ? nextChannelNumber() : profile.targetChannel;
  const newInterstitialEntries = targetMissing ? [] : buildInterstitialPlan(profile, channelNumber);

  const existingBlockSlotIds = new Set((targetChannel && targetChannel.blocks || []).map((b) => b.curationSlotId).filter(Boolean));
  const blockPatches = dayPartPlans
    .filter((p) => p.files.length > 0) // an empty slot proposes nothing — no point creating a block with no content
    .map((p) => ({
      slotId: p.slot.id, label: p.slot.label, startHour: p.slot.startHour, endHour: p.slot.endHour,
      files: p.files, isNewBlock: !existingBlockSlotIds.has(p.slot.id),
    }));

  const channelPatch = { name: profile.name || '', folders: programming.folders, files: programming.files, blocks: blockPatches };
  return {
    profileId: profile.id, seed, isNewChannel, targetMissing, channelNumber, channelPatch, newInterstitialEntries,
    diffSummary: {
      channelNumber, channelName: channelPatch.name, isNewChannel, targetMissing,
      currentFileCount: targetChannel ? targetChannel.files.length : 0,
      fileCount: programming.files.length, matchedCount: programming.matchedCount, totalScanned: programming.totalScanned,
      sampleTitles: programming.files.slice(0, 5).map((f) => f.path.split(/[\\/]/).pop()),
      adPresetName: adPreset ? adPreset.name : null,
      newInterstitialTypes: newInterstitialEntries.map((e) => e.type),
      dayPartSummaries: blockPatches.map((b) => ({
        label: b.label || `${b.startHour}:00–${b.endHour}:00`, fileCount: b.files.length, isNewBlock: b.isNewBlock,
      })),
    },
  };
}

// A day-part block patch (curateChannel's blockPatches) as a real
// ch.blocks[] entry — freshBlock's dayOfWeek shape (every day, since
// `days` stays empty) with the slot's hour range and curated files.
// curationSlotId is an extra marker field (harmless — nothing else reads or
// validates against a fixed block schema) so a later re-curate can find
// this exact slot's block again instead of creating a duplicate.
function buildBlockFromPatch(patch) {
  const block = freshBlock('dayOfWeek');
  block.name = patch.label || '';
  block.trigger.startHour = patch.startHour;
  block.trigger.endHour = patch.endHour;
  block.files = patch.files;
  block.curationSlotId = patch.slotId;
  return block;
}

// Writes a proposal into S.config in place. The caller records it with
// commitConfigPatch('…') (one labelled, undoable structural patch, state.js)
// and refreshes the CHANNELS/BUMPER & AD POOL UI itself.
export function applyCurationProposal(proposal) {
  let ch;
  if (proposal.isNewChannel) {
    ch = freshChannel(); // assigns its own fresh number; kept in sync with the proposal's below
    ch.number = proposal.channelNumber;
    ch.name = proposal.channelPatch.name;
    ch.folders = proposal.channelPatch.folders;
    ch.files = proposal.channelPatch.files;
    ch.blocks = proposal.channelPatch.blocks.map(buildBlockFromPatch);
    S.config.channels.push(ch);
  } else {
    ch = S.config.channels.find((c) => c.number === proposal.channelNumber);
    if (!ch) return null;
    if (proposal.channelPatch.name) ch.name = proposal.channelPatch.name;
    ch.folders = mergeFolderEntries(ch.folders, proposal.channelPatch.folders);
    const existingPaths = new Set(ch.files.map((f) => f.path));
    proposal.channelPatch.files.forEach((f) => { if (!existingPaths.has(f.path)) ch.files.push(f); });

    if (!ch.blocks) ch.blocks = [];
    proposal.channelPatch.blocks.forEach((patch) => {
      if (patch.isNewBlock) { ch.blocks.push(buildBlockFromPatch(patch)); return; }
      const existingBlock = ch.blocks.find((b) => b.curationSlotId === patch.slotId);
      if (!existingBlock) { ch.blocks.push(buildBlockFromPatch(patch)); return; }
      const existingBlockPaths = new Set(existingBlock.files.map((f) => f.path));
      patch.files.forEach((f) => { if (!existingBlockPaths.has(f.path)) existingBlock.files.push(f); });
    });
  }
  proposal.newInterstitialEntries.forEach((fields) => addInterstitialPoolEntry(fields));
  return ch;
}
