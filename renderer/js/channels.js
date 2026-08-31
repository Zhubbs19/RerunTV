import { changeChannel } from './playback-core.js';
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
    adsEnabled: true, contentTags: [], favorite: false, rating: null, vhsQuality: false,
    logoBugProfiles: null, volume: null, broadcastHours: freshBroadcastHours(),
    quickAccess: false, dynamicOverlays: null, tickerLayout: null, tickerContent: null,
  };
}

// ---------- Logo bug placement profiles ----------
// A logoBugProfiles array (box-wide: S.config.display.logoBugProfiles;
// per-channel override: ch.logoBugProfiles, null = inherit box-wide) is a
// list of { id, aspect, resolution, x, y, size, width?, height?, opacity? }.
// `size` is the legacy square dimension; `width`/`height` (optional) allow
// non-square placement — if present they override `size` for that axis.
// `opacity` (optional, 0-100) overrides overlays.css's default 55% via
// --logo-bug-opacity (playback.js's applyLogoBugPlacement) — absent means
// "use the CSS default", so old configs round-trip unchanged.
// null aspect/resolution values are wildcards; the all-null profile is the
// DEFAULT. x/y are 0-100 percentages of the screen (the logo bug's top-left
// corner), so placement survives a window resize instead of drifting the way
// a fixed-pixel position would.
const LOGO_BUG_CORNER_XY = {
  'bottom-right': { x: 94, y: 90 }, 'bottom-left': { x: 4, y: 90 },
  'top-right': { x: 94, y: 6 }, 'top-left': { x: 4, y: 6 },
};

// One-time migration helper (app.js's applyConfigDefaults, and
// normalizeChannel below) — folds the old corner-enum + size-px shape into
// a single DEFAULT profile. Shared here so both call sites agree on exactly
// the same corner-to-x/y mapping.
export function foldLogoBugCorner(position, size) {
  const xy = LOGO_BUG_CORNER_XY[position] || LOGO_BUG_CORNER_XY['bottom-right'];
  return [{ id: 'default', aspect: null, resolution: null, size: size || 46, ...xy }];
}

// Migrates the former width-breakpoint shape and sanitizes hand-edited
// configs. Old <=480 entries become SD 240 placements; wider finite
// breakpoints become SD 480 placements. Duplicate combinations collapse
// deterministically, and the DEFAULT is always present.
export function normalizeLogoBugProfiles(profiles) {
  const source = Array.isArray(profiles) && profiles.length ? profiles : foldLogoBugCorner(null, null);
  const seen = new Set();
  const normalized = [];
  source.forEach((profile, index) => {
    let aspect = profile.aspect === '4:3' || profile.aspect === '16:9' ? profile.aspect : null;
    let resolution = ['native', 'sd480', 'sd240'].includes(profile.resolution) ? profile.resolution : null;
    if (profile.maxWidth != null && resolution == null) resolution = Number(profile.maxWidth) <= 480 ? 'sd240' : 'sd480';
    const key = `${aspect || '*'}|${resolution || '*'}`;
    if (seen.has(key)) return;
    seen.add(key);
    const size = Math.min(240, Math.max(28, Number(profile.size) || 46));
    // width/height are optional — only written when the user explicitly sets
    // a non-square shape via the live editor, so older configs round-trip
    // cleanly without extra keys.
    const entry = {
      id: profile.id || (key === '*|*' ? 'default' : `logo-${index}`),
      aspect,
      resolution,
      x: Number.isFinite(Number(profile.x)) ? Number(profile.x) : 94,
      y: Number.isFinite(Number(profile.y)) ? Number(profile.y) : 90,
      size,
    };
    if (Number.isFinite(Number(profile.width))) entry.width = Math.min(400, Math.max(14, Number(profile.width)));
    if (Number.isFinite(Number(profile.height))) entry.height = Math.min(400, Math.max(14, Number(profile.height)));
    // opacity is a 0-100 percentage; absent means "use the CSS default"
    // (55%) so old configs without this field round-trip unchanged.
    if (Number.isFinite(Number(profile.opacity))) entry.opacity = Math.min(100, Math.max(0, Number(profile.opacity)));
    normalized.push(entry);
  });
  if (!seen.has('*|*')) normalized.push(foldLogoBugCorner(null, null)[0]);
  return normalized;
}

// Resolved pixel width/height for a profile — uses explicit width/height when
// present, otherwise falls back to the square `size`. Consumers (playback.js,
// setup-util.js) should call this instead of reading profile.size directly so
// non-square images just work everywhere.
export function logoBugProfileDimensions(profile) {
  const size = profile.size || 46;
  return {
    width: Number.isFinite(Number(profile.width)) ? profile.width : size,
    height: Number.isFinite(Number(profile.height)) ? profile.height : size,
  };
}

// Exact aspect+resolution wins, then a one-field match, then DEFAULT.
export function pickLogoBugProfile(profiles, context = {}) {
  if (!profiles || !profiles.length) return null;
  const normalized = normalizeLogoBugProfiles(profiles);
  const aspect = context && typeof context === 'object' ? context.aspect : null;
  const resolution = context && typeof context === 'object' ? context.resolution : null;
  return normalized
    .filter((profile) => (!profile.aspect || profile.aspect === aspect) && (!profile.resolution || profile.resolution === resolution))
    .sort((a, b) => Number(Boolean(b.aspect)) + Number(Boolean(b.resolution))
      - Number(Boolean(a.aspect)) - Number(Boolean(a.resolution)))[0]
    || normalized.find((profile) => !profile.aspect && !profile.resolution)
    || normalized[0];
}

// Mirrors main-media.js's VIDEO_EXTENSIONS (same reasoning as
// setup-dragdrop.js's own small copy) — used to decide whether a logo/
// overlay media path should render as a looping <video> instead of a plain
// <img> (updateLogoBug/renderDynamicOverlay, playback.js). Animated GIF/APNG
// need no special-casing — an <img> already plays those natively.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.mpg', '.mpeg']);
export function isVideoMediaPath(mediaPath) {
  if (!mediaPath) return false;
  const match = /\.[a-z0-9]+$/i.exec(mediaPath);
  return !!match && VIDEO_EXTENSIONS.has(match[0].toLowerCase());
}

// ---------- Logo bug motion (box-wide only — applyLogoBugPlacement, playback.js) ----------
// A CSS animation preset applied to #logo-bug (overlays.css's
// .logo-bug-motion-<preset> classes). 'slide-in' is one-shot, replayed on
// every tune (see the classList remove/reflow/add trick, playback.js);
// 'pulse'/'glow' are persistent CSS @keyframes loops.
export const LOGO_MOTION_PRESETS = ['none', 'pulse', 'glow', 'slide-in'];

// ---------- Dynamic overlays (animated logo/image/video, shown on trigger) ----------
// A dynamicOverlays array (box-wide: S.config.display.dynamicOverlays;
// per-channel override: ch.dynamicOverlays, null = inherit box-wide — same
// inherit convention as logoBugProfiles above) is a list of
// { id, trigger, mediaPath, corner, x, y, size, durationMs, contentTags }.
// `trigger` fires the overlay at a specific schedule/break moment (see
// DYNAMIC_OVERLAY_TRIGGERS below); `corner` is one of the four screen
// corners, 'center', 'fullscreen', or 'custom' (drag-placed via the live
// editor — buildDynamicOverlaysEditor's POSITION button, same underlying
// openLiveLogoBugEditor mechanics as the logo bug/ticker — in which case
// `x`/`y` (0-100 percentages of the screen, top-left corner, same
// convention as logoBugProfiles) are used instead of a CORNER_STYLE
// preset). `durationMs` of 0 means "auto" — resolveActiveBreakEnd for a
// break trigger, DEFAULT_OVERLAY_DURATION_MS for tuneIn/contentStart.
// `contentTags` (optional, same "unset/empty = any content, otherwise must
// share at least one tag" convention as ad targeting — see
// effectiveContentTags, interstitials.js) narrows the rule to only fire
// while content carrying one of these tags is airing, on top of whichever
// trigger moment matched.
export const DYNAMIC_OVERLAY_TRIGGERS = [
  { id: 'tuneIn', label: 'CHANNEL TUNE-IN' },
  { id: 'contentStart', label: 'PROGRAM START' },
  { id: 'commercial', label: 'COMMERCIAL BREAK' },
  { id: 'upNext', label: 'UP NEXT PROMO' },
  { id: 'channelId', label: 'STATION ID' },
  { id: 'trivia', label: 'TRIVIA CARD' },
  { id: 'contentRating', label: 'CONTENT RATING BUG' },
  { id: 'movieRatingCard', label: 'MOVIE RATING CARD (FULL SCREEN)' },
  { id: 'episodeStatus', label: 'NEW EPISODE / REPEAT BUG' },
  { id: 'formatDisclaimer', label: 'FORMATTED-FOR-YOUR-SCREEN CARD' },
  { id: 'contentAdvisory', label: 'CONTENT ADVISORY CARD' },
  { id: 'capabilityBadge', label: 'CC/SAP/STEREO BADGE' },
];
// 'fullscreen' is meant for the movieRatingCard trigger above (a corner
// bug replacement wouldn't use it) but is offered for every trigger rather
// than gated per-trigger, matching how corner/size/duration are already
// generic across all triggers.
export const DYNAMIC_OVERLAY_CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'fullscreen', 'custom'];
export const DEFAULT_OVERLAY_DURATION_MS = 8000;

// ---------- Generic x/y/width/height overlay-layout profiles (ticker bar) ----------
// Shape shared with display-mode.js's OVERLAY_LAYOUT_TARGETS placement
// system: a list of { id, aspect, resolution, x, y, width, height } — x/y are
// 0-100 percentages of the screen (the element's top-left corner, same
// convention as logoBugProfiles above); width/height are 0-100 percentages
// of the screen rather than a fixed scale factor, since the ticker bar
// (unlike the fixed-size HUD cards the scale-based targets are used for) has
// no natural intrinsic size to scale from. null aspect/resolution are
// wildcards, same matching precedence as pickLogoBugProfile.
export function normalizeOverlayLayoutProfiles(profiles) {
  if (!Array.isArray(profiles)) return [];
  return profiles.filter((p) => p && typeof p === 'object').map((p, index) => ({
    id: p.id || `ov${index}`,
    aspect: p.aspect === '4:3' || p.aspect === '16:9' ? p.aspect : null,
    resolution: ['native', 'sd480', 'sd240'].includes(p.resolution) ? p.resolution : null,
    x: Number.isFinite(Number(p.x)) ? Number(p.x) : 0,
    y: Number.isFinite(Number(p.y)) ? Number(p.y) : 0,
    width: Math.min(100, Math.max(5, Number.isFinite(Number(p.width)) ? Number(p.width) : 100)),
    height: Math.min(100, Math.max(2, Number.isFinite(Number(p.height)) ? Number(p.height) : 12)),
  }));
}

// Per-channel override for the ticker plugin's content (plugins/ticker) —
// null = inherit the box-wide S.config.ticker (enabled/text/speed), same
// inherit convention as tickerLayout/logoBugProfiles/dynamicOverlays above.
// A present object overrides all three fields for this channel (e.g. a
// channel that wants its own crawl text, or none at all, regardless of the
// box-wide ticker).
export function normalizeTickerContent(content) {
  if (!content || typeof content !== 'object') return null;
  return {
    enabled: !!content.enabled,
    text: typeof content.text === 'string' ? content.text : '',
    speed: Math.min(120, Math.max(5, Number(content.speed) || 30)),
  };
}

let dynamicOverlayIdCounter = 0;
export function newDynamicOverlayId() {
  return `ov${Date.now().toString(36)}${(dynamicOverlayIdCounter++).toString(36)}`;
}

// ---------- Seasonal/holiday logo bug icon overrides ----------
// A ch.iconOverrides array (list of { id, startMonth, startDay, endMonth,
// endDay, icon }) lets a channel's logo bug swap to a different icon during
// a calendar date range (a snowflake variant in December, etc.) — resolved
// purely from (ch, atMs), same "no separate state to maintain" shape as
// everything else in this file. Empty/absent = today's unchanged behavior
// (always ch.icon), same "empty array is off" convention as dynamicOverlays.
function inMonthDayRange(atMs, o) {
  const d = new Date(atMs);
  const md = (d.getMonth() + 1) * 100 + d.getDate();
  const start = o.startMonth * 100 + o.startDay;
  const end = o.endMonth * 100 + o.endDay;
  // Same wrap-safe shape as hourInRange (schedule.js) — lets a range span
  // the new year (e.g. Dec 20 -> Jan 5) without special-casing it.
  if (start <= end) return md >= start && md <= end;
  return md >= start || md <= end;
}

export function normalizeIconOverrides(overrides) {
  if (!Array.isArray(overrides)) return [];
  return overrides.filter((o) => o && typeof o === 'object').map((o) => ({
    id: o.id || randomId('iconov'),
    startMonth: Math.min(12, Math.max(1, Number(o.startMonth) || 1)),
    startDay: Math.min(31, Math.max(1, Number(o.startDay) || 1)),
    endMonth: Math.min(12, Math.max(1, Number(o.endMonth) || 1)),
    endDay: Math.min(31, Math.max(1, Number(o.endDay) || 1)),
    icon: typeof o.icon === 'string' ? o.icon : '',
  }));
}

// The logo bug's actual effective icon at a given instant — first matching
// date-range override wins, falling back to the channel's plain ch.icon.
// Both updateLogoBug and applyLogoBugGhost (playback.js) call this instead
// of reading ch.icon directly, so the seasonal swap applies to the real bug
// and its burn-in ghost alike. buildChannelBadge (below) deliberately does
// NOT use this — the channel-list badge represents the channel's base
// identity for editing, not whatever's seasonally active right now.
export function resolveEffectiveIcon(ch, atMs) {
  if (!ch) return null;
  const overrides = ch.iconOverrides || [];
  const match = overrides.find((o) => o.icon && inMonthDayRange(atMs, o));
  return (match && match.icon) || ch.icon || null;
}

// A rule with no mediaPath yet (just added, media not chosen) is still kept
// — the setup-screen list needs it to survive re-render so the user has a
// row to pick a file into (see buildDynamicOverlaysEditor, setup-util.js).
// The runtime side (triggerDynamicOverlays, dynamic-overlays.js) is what
// actually skips a mediaPath-less rule when deciding what to show.
export function normalizeDynamicOverlays(rules) {
  if (!Array.isArray(rules)) return [];
  const triggerIds = new Set(DYNAMIC_OVERLAY_TRIGGERS.map((t) => t.id));
  return rules
    .filter((rule) => rule && triggerIds.has(rule.trigger))
    .map((rule) => ({
      id: rule.id || newDynamicOverlayId(),
      trigger: rule.trigger,
      mediaPath: typeof rule.mediaPath === 'string' ? rule.mediaPath : '',
      corner: DYNAMIC_OVERLAY_CORNERS.includes(rule.corner) ? rule.corner : 'bottom-right',
      // Only meaningful when corner === 'custom' — kept even when a config
      // is later switched back to a preset corner so re-selecting 'custom'
      // restores the last-dragged spot instead of resetting to 0,0.
      x: Number.isFinite(Number(rule.x)) ? Math.min(100, Math.max(0, Number(rule.x))) : null,
      y: Number.isFinite(Number(rule.y)) ? Math.min(100, Math.max(0, Number(rule.y))) : null,
      size: Math.min(600, Math.max(40, Number(rule.size) || 160)),
      durationMs: Math.min(120000, Math.max(0, Number(rule.durationMs) || 0)),
      contentTags: Array.isArray(rule.contentTags) ? rule.contentTags.filter((t) => typeof t === 'string' && t) : [],
    }));
}

// A folder/file's `source` names which media-source provider it came from —
// 'local' for the filesystem (the only provider that exists today; plugin
// providers arrive in a later phase of the media-source abstraction work).
// The id is deliberately content-derived (source+ref), not random, so the
// same physical folder always resolves to the same ch.folders[] entry id
// everywhere it's referenced — normalizeChannel's migration below depends on
// this being idempotent across every boot, and curation.js depends on it to
// resolve a copied file's `folder` id back to a real entry on another
// channel (findFolderEntry).
export function mediaRefId(source, ref) {
  return `src_${source}_${hashString(`${source}:${ref}`)}`;
}

// Renderer-side mirror of main-media-dispatch.js's parseMediaRef/
// wrapMediaRef (main process) — small enough, and needed rarely enough
// (unwrapping a freshly-scanned plugin ref back to its raw form before
// probing — see rescanAllFolders, setup-channels.js), that duplicating the
// pure logic here beats an IPC round-trip just to parse a string. Same
// reasoning as setup-dragdrop.js's own small VIDEO_EXTENSIONS mirror of
// main-media.js's. `ch.files[].path` for a plugin-sourced file is always
// the WRAPPED form (mediasource:<source>:<ref>) — main.js's fs:scanFolder
// handler applies wrapMediaRef once, at the point a ref first enters
// config, so a provider's own list()/probe()/readRange() always work with
// their own natural unprefixed refs and never need to know this scheme
// exists.
export function parseMediaRef(ref) {
  const m = /^mediasource:([a-zA-Z0-9_-]+):([\s\S]*)$/.exec(ref);
  if (!m) return { source: 'local', ref };
  return { source: m[1], ref: m[2] };
}

export function wrapMediaRef(source, rawRef) {
  return `mediasource:${source}:${rawRef}`;
}

// Optional per-provider verb (PLUGIN_DEVELOPMENT.md's "Media sources"
// section) — a plugin-sourced file's `path` is that provider's opaque ref
// (e.g. a Drive file id), which has no meaningful basename the way a local
// path's filename does, so without this any UI showing a file's name falls
// back to the raw ref (getDisplayTitle, util.js). Lives here (not in
// setup-channels.js, where it originated, or setup-interstitials.js, which
// also needs it) specifically to avoid those two setup-screen modules
// importing from each other — this file is pure logic both already depend
// on either way.
export async function tryGetDisplayName(providerId, rawRef) {
  try {
    return await window.api.callMediaSourceHook(providerId, 'getDisplayName', rawRef);
  } catch (err) {
    return null;
  }
}

// Optional per-provider verb, same shape as tryGetDisplayName above: a
// provider that can identify real descriptive metadata for a specific file
// (not just a cleaned-up name) can register `getMetadata(ref)` to return
// `{ description?, facets?: { genre?, era?, contentType? } }` — merged into
// the new file's own `description`/`facets` fields at scan time
// (addPluginSourceToChannel below), same one-time-at-scan timing as
// getDisplayName's title. Absent or throwing is a normal, silent no-op —
// most providers won't implement this at all.
export async function tryGetMetadata(providerId, rawRef) {
  try {
    return await window.api.callMediaSourceHook(providerId, 'getMetadata', rawRef);
  } catch (err) {
    return null;
  }
}

// A saved curation profile's contentPoolScope.folders (setup-autocurate.js)
// may still hold legacy raw path strings from before ch.folders[] entries
// had ids — resolve each to its current entry id (matching by ref) so an
// old profile's explicit folder subset keeps scoping correctly after the
// shape change, without a separate one-time config migration pass. A value
// that's already an id (or matches nothing at all — its folder was since
// removed) passes through unchanged.
export function resolveScopeFolderIds(scopeFolders) {
  const allEntries = [];
  S.config.channels.forEach((c) => (c.folders || []).forEach((e) => allEntries.push(e)));
  return scopeFolders.map((v) => {
    if (allEntries.some((e) => e.id === v)) return v;
    const byRef = allEntries.find((e) => e.ref === v);
    return byRef ? byRef.id : v;
  });
}

// Resolves a ch.files[]/block.files[] entry's `folder` id back to its
// owning ch.folders[] entry — scans every channel, not just one, because a
// curated channel's files can carry a folder id that originated on a
// different channel than the one they were copied into (curation.js copies
// files by reference-equal id, not by re-scanning). Returns null if no
// channel's folders[] still has it (e.g. the source folder was later
// removed from its original channel).
export function findFolderEntry(folderId) {
  if (!folderId) return null;
  for (const c of S.config.channels) {
    const found = (c.folders || []).find((e) => e.id === folderId);
    if (found) return found;
  }
  return null;
}

// Merges a second list of ch.folders[] entries into an existing one,
// de-duped by id (object identity/reference can't be relied on — the
// incoming entries are usually freshly resolved copies, not the same
// objects). Existing entries win on conflict (keeps any user-edited label).
export function mergeFolderEntries(existing, incoming) {
  const byId = new Map((existing || []).map((e) => [e.id, e]));
  (incoming || []).forEach((e) => { if (!byId.has(e.id)) byId.set(e.id, e); });
  return Array.from(byId.values());
}

// Migrates old single-folder configs (ch.folder + ch.files with no folder tag)
// to the multi-folder shape (ch.folders[] + each file tagged with its source
// folder), then further migrates bare-path ch.folders[] entries (pre-dating
// the media-source abstraction) into { id, source, ref, label } objects —
// see mediaRefId above for why the id is content-derived rather than random.
// Also migrates the old ch.commercials/ch.commercialsEnabled to the new
// ch.adsEnabled boolean — all break scheduling now lives in the Programming
// tab's flows/presets, not on the channel object.
export function normalizeChannel(ch) {
  if (!ch.folders) {
    ch.folders = ch.folder ? [ch.folder] : [];
    if (ch.folder && ch.files) {
      ch.files.forEach((f) => { if (!f.folder) f.folder = ch.folder; });
    }
  }
  delete ch.folder;
  if (ch.folders.length && typeof ch.folders[0] === 'string') {
    const idFor = (p) => mediaRefId('local', p);
    const migrated = ch.folders.map((p) => ({ id: idFor(p), source: 'local', ref: p, label: null }));
    (ch.files || []).forEach((f) => {
      if (f.source === undefined) f.source = 'local';
      if (f.folder) f.folder = idFor(f.folder); // was the raw path; now the owning entry's id
    });
    ch.folders = migrated;
  }
  // Covers files added after ch.folders was already migrated (or was always
  // empty) — drag-dropped/addFilesToChannel-pushed files with folder: null.
  (ch.files || []).forEach((f) => { if (f.source === undefined) f.source = 'local'; });
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
  if (ch.logoBugProfiles) ch.logoBugProfiles = normalizeLogoBugProfiles(ch.logoBugProfiles);
  delete ch.logoBugPosition;
  delete ch.logoBugSize;
  // null = inherit the box-wide default dynamic-overlay rules (same
  // convention as logoBugProfiles above); a present array overrides it.
  if (ch.dynamicOverlays === undefined) ch.dynamicOverlays = null;
  if (ch.dynamicOverlays) ch.dynamicOverlays = normalizeDynamicOverlays(ch.dynamicOverlays);
  // Always a plain array (no inherit concept — icons are per-channel to
  // begin with, unlike dynamicOverlays' box-wide default).
  ch.iconOverrides = normalizeIconOverrides(ch.iconOverrides);
  // null = inherit the box-wide ticker placement
  // (S.config.display.overlayLayouts['ticker-bar']); a present array
  // overrides it for this channel — same inherit convention as
  // logoBugProfiles/dynamicOverlays above.
  if (ch.tickerLayout === undefined) ch.tickerLayout = null;
  if (ch.tickerLayout) ch.tickerLayout = normalizeOverlayLayoutProfiles(ch.tickerLayout);
  // null = inherit the box-wide ticker content (S.config.ticker); a present
  // object overrides enabled/text/speed for this channel.
  if (ch.tickerContent === undefined) ch.tickerContent = null;
  if (ch.tickerContent) ch.tickerContent = normalizeTickerContent(ch.tickerContent);
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
    (b.files || []).forEach((f) => { if (f.source === undefined) f.source = 'local'; });
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
        folder: ov.folder, files: (ov.files || []).map((f) => ({ ...f, source: f.source || 'local' })), anchor: ov.anchor,
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

// Memoized on S.configGeneration (same invalidation as resolveActiveCommercials
// in schedule.js — see CLAUDE.md's "Config mutation" section): both the sorted
// array and a number->channel Map are rebuilt only when config has actually
// changed, since this is called from the guide's 1-second tick among dozens of
// other call sites.
let sortedChannelsCache = null;
let sortedChannelsCacheGen = -1;
let channelByNumberCache = null;

function ensureChannelCaches() {
  if (S.configGeneration !== sortedChannelsCacheGen) {
    sortedChannelsCache = [...S.config.channels].sort((a, b) => a.number - b.number);
    channelByNumberCache = new Map(sortedChannelsCache.map((ch) => [ch.number, ch]));
    sortedChannelsCacheGen = S.configGeneration;
  }
}

export function sortedChannels() {
  ensureChannelCaches();
  return sortedChannelsCache;
}

// Channels shown in the time-grid guide, narrowed by S.guideFilterQuery, and
// always excluding ch.hidden (setup-channels.js's HIDE FROM TUNING toggle) —
// a hidden channel is meant to read as "not in the lineup," not just
// filtered out of a search. Surfing (changeChannel) applies the same
// ch.hidden exclusion itself (playback.js), but deliberately ignores
// S.guideFilterQuery — a search filter in the guide shouldn't change what
// channel-up/down cycles through.
export function filteredChannels() {
  const q = S.guideFilterQuery.trim().toLowerCase();
  const list = sortedChannels().filter((ch) => !ch.hidden);
  if (!q) return list;
  return list.filter((ch) => (ch.name || '').toLowerCase().includes(q) || String(ch.number).includes(q));
}

export function getChannel(number) {
  ensureChannelCaches();
  return channelByNumberCache.get(number) || null;
}

// Appends already-probed files to a channel's playlist — dedupes by path
// (so re-adding the same file is a silent no-op, not a duplicate playlist
// entry), reshuffles if the channel is in shuffle mode, and anchors a
// never-yet-played channel to "now" so it doesn't sit unanchored. `entries`
// is [{path, duration, folder, source}] — folder is null for anything not
// tied to a tracked ch.folders[] source (a one-off drag-drop, a plugin-added
// file); source defaults to 'local' since every caller today (drag-drop,
// plugins via ctx.addFilesToChannel) only ever adds local-filesystem files —
// a future media-source plugin passing its own refs would set source itself.
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
  added.forEach((e) => ch.files.push({
    path: e.path, duration: e.duration, folder: e.folder || null, source: e.source || 'local',
  }));
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
