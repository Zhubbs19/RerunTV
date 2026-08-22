import { changeChannel } from './playback.js';
import { renderChannelList } from './setup.js';
import { BADGE_COLORS, S, saveConfigDebounced } from './state.js';
import {
  hashString, randomId, randomInterstitialId, shuffleArray,
} from './util.js';
import { virtualChannelNumbers } from './virtual.js';

// Block-level ad override — only present when a daypart block explicitly
// opts out of the channel/flow default (block.commercials !== null).
// Channel-level ad scheduling is now entirely controlled by the
// Programming tab's flows and presets; the channel itself only carries
// ch.adsEnabled (true/false) to suppress all breaks on that channel.
export function freshCommercialsConfig() {
  return { enabled: true };
}

function randomBlockId() {
  return randomId('blk');
}

// ---------- Content facets (Tag System 2.0) ----------
// A file's free-text `tags` (TITLES tab, setup-panels.js) stays the one list
// every consumer (interstitial contentTags matching, ad presets, search)
// reads — these structured facets are an optional, more curation-friendly
// layer on top, not a replacement. Whenever a facet is set it's mirrored
// into `tags` too (mirrorFacetsIntoTags below) so nothing that only knows
// about `tags` needs to change.
export function freshFileFacets() {
  return { genre: [], era: null, mood: [], contentType: null, dayPart: [] };
}

// Idempotent — only fills in a missing facets object, never overwrites a
// user's existing one. Called from normalizeChannel below; the TITLES panel
// also defends against a pre-migration file (one added after boot, e.g. via
// rescanAllFolders) by falling back to freshFileFacets() itself.
export function normalizeFileFacets(file) {
  if (!file.facets) file.facets = freshFileFacets();
  return file;
}

// Folds a file's structured facet values into its flat `tags` array
// (additively — never removes a tag, including one a facet used to
// contribute and no longer does; the user's free tags field is the one
// place tags get removed by hand). Called after any facet edit.
export function mirrorFacetsIntoTags(file) {
  if (!file.facets) return;
  const derived = [
    ...(file.facets.genre || []), file.facets.era,
    ...(file.facets.mood || []), file.facets.contentType,
  ].filter(Boolean).map((t) => String(t).toLowerCase());
  if (!derived.length) return;
  const existing = new Set(file.tags || []);
  derived.forEach((t) => existing.add(t));
  file.tags = Array.from(existing);
}

function randomProfileId() {
  return randomId('curate');
}

// A saved auto-curation profile (PROGRAMMING > AUTO-CURATE) — a reusable
// spec for generating or refreshing a channel's programming/ad-tagging/
// bumper set from tagged content, rather than a one-off action. See
// renderer/js/curation.js for the engine that consumes these.
export function freshCurationProfile() {
  return {
    id: randomProfileId(), name: '', targetChannel: null, // null = create a brand-new channel
    themeSeeds: { genre: [], era: [], mood: [], contentType: [] },
    contentPoolScope: { folders: 'all', tags: 'any' },
    // An empty array means "simple whole-pool curation" (the engine's
    // original mode) — a populated one adds slot-specific ch.blocks[] on
    // top of that flat pool, each carved out of its own hour range. See
    // freshDayPartSlot below and buildDayPartPlan, curation.js.
    dayPartTemplate: [],
    adDensity: null, // an S.config.interstitials.presets[].id, or null
    bumperStyleTags: [],
    // 'manual' — only ever runs from AUTO-CURATE (PREVIEW/APPLY by hand).
    // 'scheduled' — also auto-runs (and auto-applies) on scheduleInterval,
    // with no user action; see curation-scheduler.js.
    regenerationMode: 'manual',
    scheduleInterval: 'weekly', // 'daily' | 'weekly' | 'monthly' — only read when regenerationMode is 'scheduled'
    createdAt: Date.now(), lastRunAt: null,
  };
}

function randomDayPartSlotId() {
  return randomId('slot');
}

// One row of a curation profile's optional dayPartTemplate — a themed hour
// range (e.g. "6am-9am, cartoons") the curation engine fills independently
// of the profile's flat whole-pool selection, layered on top of it as its
// own ch.blocks[] entry (freshBlock's dayOfWeek shape, mode: 'loop', every
// day since `days` stays empty). genre/contentType here narrow the profile's
// own themeSeeds for just this slot — empty means "inherit the profile's
// seeds unchanged".
export function freshDayPartSlot() {
  return { id: randomDayPartSlotId(), label: '', startHour: 6, endHour: 12, genre: [], contentType: null };
}

// A fresh ch.blocks[] entry for the given trigger type — 'dayOfWeek' (an
// hour/day-of-week daypart, e.g. Saturday mornings) or 'dateRange' (a fixed
// calendar-date window, e.g. a holiday takeover). priority defaults mirror
// normalizeChannel's migration defaults so a hand-added dateRange block
// still pre-empts a dayOfWeek block by default, same as before blocks and
// date overrides were unified into one array.
export function freshBlock(triggerType) {
  const trigger = triggerType === 'dateRange'
    ? { type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 25 }
    : { type: 'dayOfWeek', startHour: 20, endHour: 6, days: [] };
  return {
    id: randomBlockId(), name: '', trigger, priority: triggerType === 'dateRange' ? 10 : 0, mode: 'loop',
    folder: null, files: [], anchor: null, commercials: null, dayOverrides: {}, finale: null, theme: null,
  };
}

// New channels start numbering at 5+, skipping whatever's currently
// registered as a virtual channel (virtualChannelNumbers(), plugin-driven —
// core has no fixed list of which numbers those are).
export function nextChannelNumber() {
  const floor = 5;
  const used = new Set([
    ...S.config.channels.map((c) => c.number),
    ...virtualChannelNumbers(),
  ]);
  let next = floor;
  while (used.has(next)) {
    next++;
  }
  return next;
}

// enabled: false (default) = broadcasts around the clock, same as every
// channel before this existed. startHour/endHour use the same wrap-safe
// hourInRange a dayOfWeek trigger already uses — endHour: 0 means "until
// midnight" (hour>=6 || hour<0 reduces to hour>=6, since hour is never
// negative), not "instant off at hour 0", so 6-0 reads as "6am-midnight"
// while still using an hour the setup UI's 0-23 select can represent.
export function freshBroadcastHours() {
  return { enabled: false, startHour: 6, endHour: 0 };
}

export function freshChannel() {
  return {
    number: nextChannelNumber(), name: '', folders: [], files: [], anchor: null, shuffle: false, icon: null,
    adsEnabled: true, favorite: false, rating: null, vhsQuality: false,
    logoBugProfiles: null, volume: null, broadcastHours: freshBroadcastHours(),
    quickAccess: false,
  };
}

// ---------- Logo bug placement profiles ----------
// A logoBugProfiles array (box-wide: S.config.display.logoBugProfiles;
// per-channel override: ch.logoBugProfiles, null = inherit box-wide) is a
// list of { id, label, maxWidth, x, y, size } sorted ascending by maxWidth,
// with exactly one catch-all entry (maxWidth: null) always last — the
// "DEFAULT" profile used whenever the active video's width doesn't fall
// under any narrower breakpoint. x/y are 0-100 percentages of the screen
// (the logo bug's top-left corner), so placement survives a window resize
// instead of drifting the way a fixed-pixel position would.
const LOGO_BUG_CORNER_XY = {
  'bottom-right': { x: 94, y: 90 }, 'bottom-left': { x: 4, y: 90 },
  'top-right': { x: 94, y: 6 }, 'top-left': { x: 4, y: 6 },
};

// One-time migration helper (app.js's applyConfigDefaults, and
// normalizeChannel below) — folds the old corner-enum + size-px shape into
// a single DEFAULT profile. Shared here so both call sites agree on exactly
// the same corner->x/y mapping.
export function foldLogoBugCorner(position, size) {
  const xy = LOGO_BUG_CORNER_XY[position] || LOGO_BUG_CORNER_XY['bottom-right'];
  return [{ id: 'default', label: 'DEFAULT', maxWidth: null, size: size || 46, ...xy }];
}

// Resolves which profile applies for a video of the given width — the
// first (narrowest) profile whose maxWidth covers it, sorted ascending so
// an SD/4:3 breakpoint (e.g. maxWidth: 720) wins over the catch-all DEFAULT
// (maxWidth: null) for anything at or under that width. `profiles` is
// expected pre-sorted (the editor keeps it that way on every edit); this
// re-sorts defensively since a hand-edited/imported config might not be.
export function pickLogoBugProfile(profiles, videoWidth) {
  if (!profiles || !profiles.length) return null;
  const sorted = profiles.slice().sort((a, b) => (a.maxWidth ?? Infinity) - (b.maxWidth ?? Infinity));
  return sorted.find((p) => p.maxWidth == null || !videoWidth || videoWidth <= p.maxWidth) || sorted[sorted.length - 1];
}

// Migrates old single-folder configs (ch.folder + ch.files with no folder tag)
// to the multi-folder shape (ch.folders[] + each file tagged with its source
// folder). Also migrates the old ch.commercials/ch.commercialsEnabled to the
// new ch.adsEnabled boolean — all break scheduling now lives in the
// Programming tab's flows/presets, not on the channel object.
export function normalizeChannel(ch) {
  if (!ch.folders) {
    ch.folders = ch.folder ? [ch.folder] : [];
    if (ch.folder && ch.files) {
      ch.files.forEach((f) => { if (!f.folder) f.folder = ch.folder; });
    }
  }
  delete ch.folder;
  (ch.files || []).forEach(normalizeFileFacets);
  if (ch.name == null) ch.name = '';
  // Migrate old commercials config to the simple adsEnabled boolean.
  if (ch.adsEnabled === undefined) {
    ch.adsEnabled = ch.commercials ? ch.commercials.enabled !== false : ch.commercialsEnabled !== false;
  }
  delete ch.commercials;
  delete ch.commercialsEnabled;
  if (ch.favorite === undefined) ch.favorite = false;
  // Marks a channel for one-tap access from the Android companion remote —
  // shown as a quick-tune grid there instead of requiring digit entry.
  if (ch.quickAccess === undefined) ch.quickAccess = false;
  if (ch.rating === undefined) ch.rating = null;
  if (ch.vhsQuality === undefined) ch.vhsQuality = false;
  // logoBugPosition/logoBugSize (the old corner-enum + size-px override) ->
  // logoBugProfiles (see foldLogoBugCorner above) — only fold when the
  // channel actually had an override set (either field non-null); otherwise
  // logoBugProfiles stays null, same "inherit the box-wide default" meaning
  // the old null/null pair had.
  if (ch.logoBugProfiles === undefined) {
    ch.logoBugProfiles = (ch.logoBugPosition != null || ch.logoBugSize != null)
      ? foldLogoBugCorner(ch.logoBugPosition, ch.logoBugSize)
      : null;
  }
  delete ch.logoBugPosition;
  delete ch.logoBugSize;
  // null = inherit the box-wide master volume; a number 0-1 overrides it for
  // this channel (e.g. a channel of old/quiet recordings that always needs
  // to run louder than everything else).
  if (ch.volume === undefined) ch.volume = null;
  if (!ch.broadcastHours) ch.broadcastHours = freshBroadcastHours();

  // Blocks used to be flat hour/day-of-week objects (startHour/endHour/days)
  // with no trigger concept — wrap them in trigger.dayOfWeek in place so
  // every block, old or new, is driven by the same trigger/mode/priority
  // shape. Safe to re-run: a block that already has a trigger is untouched.
  (ch.blocks || []).forEach((b) => {
    if (!b.trigger) {
      b.trigger = { type: 'dayOfWeek', startHour: b.startHour, endHour: b.endHour, days: b.days || [] };
      delete b.startHour; delete b.endHour; delete b.days;
    }
    if (b.priority === undefined) b.priority = b.trigger.type === 'dateRange' ? 10 : 0;
    if (!b.mode) b.mode = 'loop';
    if (!b.dayOverrides) b.dayOverrides = {};
    if (b.finale === undefined) b.finale = null;
    if (!b.id) b.id = randomBlockId();
    if (b.name === undefined) b.name = '';
    if (b.theme === undefined) b.theme = null;
  });

  // dateOverrides used to be a separate MM-DD date-range array running
  // alongside blocks — fold each into ch.blocks as a dateRange-trigger block
  // (priority 10, matching the old "date override always pre-empts a block"
  // precedence regardless of array position) and retire the array.
  if (ch.dateOverrides && ch.dateOverrides.length) {
    if (!ch.blocks) ch.blocks = [];
    ch.dateOverrides.forEach((ov) => {
      ch.blocks.push({
        id: randomBlockId(), name: ov.label || '',
        trigger: { type: 'dateRange', startMonth: ov.startMonth, startDay: ov.startDay, endMonth: ov.endMonth, endDay: ov.endDay },
        priority: 10, mode: 'loop',
        folder: ov.folder, files: ov.files || [], anchor: ov.anchor,
        commercials: ov.commercials || null, dayOverrides: {}, finale: null,
      });
    });
  }
  delete ch.dateOverrides;

  return ch;
}

// A small set of on-brand accent colors (matching the design system's
// palette family) rather than arbitrary hues, so placeholder badges look
// chosen, not random. Picked deterministically per channel so a given
// channel keeps the same color across re-renders.

export function badgeColor(ch) {
  const key = String(ch.number) + (ch.name || '');
  return BADGE_COLORS[hashString(key) % BADGE_COLORS.length];
}

// User-picked accent wins over the deterministic auto-assignment.
export function channelColor(ch) {
  return ch.color || badgeColor(ch);
}

// Custom icon if set, otherwise a colored placeholder badge showing the
// channel number. Editable (click to assign/change) on the setup screen;
// read-only wherever it's just shown for reference, like the guide grid —
// that's a browsing view, not a place to be editing channel config from.

export function buildChannelBadge(ch, opts) {
  opts = opts || {};
  const el = document.createElement('div');
  el.className = 'channel-badge' + (opts.small ? ' small' : '');
  if (opts.editable !== false) {
    el.title = 'Click to set channel icon';
    el.classList.add('editable');
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const imgPath = await window.api.selectImage();
      if (!imgPath) return;
      ch.icon = imgPath;
      saveConfigDebounced();
      renderChannelList();
    });
  }

  if (ch.icon) {
    const img = document.createElement('img');
    img.alt = String(ch.number);
    window.api.toFileUrl(ch.icon).then((url) => { img.src = url; });
    el.appendChild(img);
    // A custom icon otherwise replaces the plain number text entirely —
    // this app is built around typing channel numbers (0-9 direct entry),
    // so a small always-on chip keeps the number readable here too, not
    // just in the big tune-in card (guide.js) which has room for both.
    const numChip = document.createElement('span');
    numChip.className = 'badge-num';
    numChip.textContent = String(ch.number);
    el.appendChild(numChip);
  } else {
    el.style.background = channelColor(ch);
    el.textContent = String(ch.number);
  }
  return el;
}

export function guideSlots() {
  return (S.config.display && S.config.display.guideSlots) || 3;
}

export function sortedChannels() {
  return [...S.config.channels].sort((a, b) => a.number - b.number);
}

// Channels shown in the time-grid guide, narrowed by S.guideFilterQuery.
// Surfing (changeChannel) deliberately ignores this — a search filter in
// the guide shouldn't change what channel-up/down cycles through.
export function filteredChannels() {
  const q = S.guideFilterQuery.trim().toLowerCase();
  const list = sortedChannels();
  if (!q) return list;
  return list.filter((ch) => (ch.name || '').toLowerCase().includes(q) || String(ch.number).includes(q));
}

export function getChannel(number) {
  return S.config.channels.find((c) => c.number === number) || null;
}

// Appends already-probed files to a channel's playlist — dedupes by path
// (so re-adding the same file is a silent no-op, not a duplicate playlist
// entry), reshuffles if the channel is in shuffle mode, and anchors a
// never-yet-played channel to "now" so it doesn't sit unanchored. `entries`
// is [{path, duration, folder}] — folder is null for anything not tied to a
// tracked ch.folders[] source (a one-off drag-drop, a plugin-added file).
// Shared by setup-dragdrop.js and exposed to plugins via ctx.addFilesToChannel
// (plugins.js) so a plugin can add channel content without knowing the
// channel object's shape.
export function addFilesToChannel(ch, entries) {
  const existing = new Set(ch.files.map((f) => f.path));
  const added = [];
  entries.forEach((e) => {
    if (existing.has(e.path)) return; // also guards a duplicate path within `entries` itself
    existing.add(e.path);
    added.push(e);
  });
  if (!added.length) return added;
  added.forEach((e) => ch.files.push({ path: e.path, duration: e.duration, folder: e.folder || null }));
  if (ch.shuffle) shuffleArray(ch.files);
  if (!ch.anchor) ch.anchor = Date.now();
  return added;
}

// Pushes one interstitials-pool entry, filling in the same defaults every
// pool-add call site already used by hand (id/type/channelAffinity/
// blockAffinity/weight) — `fields` overrides any of those plus file/text.
// Shared by setup-interstitials.js and setup-dragdrop.js, and exposed to
// plugins via ctx.addInterstitialPoolEntry.
export function addInterstitialPoolEntry(fields) {
  const entry = {
    id: randomInterstitialId(), type: 'commercial', channelAffinity: 'any', blockAffinity: null, weight: 1,
    file: null, text: null, ...fields,
  };
  S.config.interstitials.pool.push(entry);
  return entry;
}
