// Renderer-side plugin loading — the other half of main-plugins.js.
//
// At boot (see loadPlugins(), called once from app.js's init()):
//   1. Fetch the manifest list from the main process (window.api.pluginsList).
//   2. For each enabled plugin with a `style`, inject a <link> that loads it
//      from app://plugins/<dir>/<style> in Electron or /plugins/<dir>/<style>
//      in the LAN viewer (see main-protocol.js/main-viewer-server.js).
//   3. For each enabled plugin with a `renderer` entry, dynamic-import it as
//      an ES module from the same plugin asset origin. The module runs
//      with the RCBPlugins API already on `window` (set up before any
//      import), so it can call registerChannelType() etc. at top level.
//
// A plugin channel registered via registerChannelType participates in the
// existing virtual-channel system (see virtual.js) — it gets a channel
// number and shows up in the guide. definition shape:
//   { number, label, nowText, badge: {bg, label},
//     render(container, ctx),  // called every time the box tunes to `number`
//     stop(ctx),                // called when tuning away — clear timers etc.
//     onOk(ctx),                 // optional — called when Enter/Space is
//                                 // pressed while this channel is tuned in
//                                 // (see app.js's keydown handler), for a
//                                 // channel with a remote-triggerable
//                                 // action — same OK-button gesture a
//                                 // remote sends
//     onKey(key, ctx),           // optional — called for every keydown
//                                 // while this channel is tuned in, before
//                                 // any of app.js's own key handling (e.g.
//                                 // for a channel with its own arrow-key
//                                 // navigation). Return true to mark the
//                                 // key as handled (app.js's handler
//                                 // returns immediately after), false/
//                                 // undefined to let normal key handling
//                                 // continue. Be sparing: a `true` return
//                                 // swallows the key outright, so claiming
//                                 // ArrowUp/ArrowDown takes away CHANGE
//                                 // CHANNEL and strands the viewer on your
//                                 // channel. Claim only keys you handle.
//     supportsTimeMachine,       // optional — set true when what this
//                                 // channel plays is a pure function of a
//                                 // timestamp (i.e. it reads ctx.viewNow()
//                                 // rather than keeping its own playback
//                                 // log). Core then allows the time machine
//                                 // here instead of refusing it outright,
//                                 // and scrubbing works because your own
//                                 // render/tick re-derives from the shifted
//                                 // clock like everything else.
//     timeMachineNowText(nowMs, ctx), // optional companion to the flag —
//                                 // what the VCR on-screen display should
//                                 // name as playing at the scrubbed
//                                 // instant. Core cannot work that out for
//                                 // a plugin channel, so without this the
//                                 // OSD's programme line is blank.
//     enabled(ctx) }             // optional — gates whether this channel
//                                 // shows up in the channel list at all
//                                 // (beyond just "is the plugin installed"),
//                                 // for a channel with its own independent
//                                 // on/off toggle on top of that (see
//                                 // virtualChannelNumbers, virtual.js).
//                                 // Omit for "always available whenever the
//                                 // plugin's enabled," which is what most
//                                 // channels want.
// ctx is window.RCBPlugins.ctx (see installGlobalApi() below) — the same
// app state/clock/video-element access the built-in virtual channels use, so
// a plugin channel can read the live config, the box's (possibly
// time-machine-shifted) current time, and even drive the shared <video>
// element if it wants real playback. Also available synchronously at
// window.RCBPlugins.ctx from a plugin's own top-level code (e.g. an IPC
// listener registered outside render()).
import { getAudioCtx, playNoiseBurst, playTone } from './audio.js';
import { addFilesToChannel, addInterstitialPoolEntry, buildChannelBadge, getChannel, sortedChannels } from './channels.js';
import { getChannelSchedule } from './schedule.js';
import { nextBreakBoundary, resolveBreakAt } from './interstitials.js';
import { alertDialog } from './setup-dialogs.js';
import { MONTHS, S, WEEKDAYS, commitInPlace, saveConfigDebounced, viewNow } from './state.js';
import { formatClock, formatSlotLabel, getDisplayTitle } from './util.js';
import { player } from './dom.js';
import {
  applyPluginSettingsSchema, normalizePluginSettingsSchema, redactPluginSettings, validatePluginSettings,
} from './plugin-settings-schema.js';

const channelTypeRegistry = new Map();
const settingsPanelRegistry = new Map();
const settingsSectionRegistry = new Map();
const settingsSearchRegistry = new Map();
// id -> { name, description } for every installed plugin, enabled or not,
// so the setup search can find a plugin without listing plugins again.
const installedPluginSummaries = new Map();
const settingsSchemaRegistry = new Map();
const mediaSourcePickerRegistry = new Map();
const themePackRegistry = new Map();
const interruptRegistry = new Map();
const tuneGateRegistry = new Map();
const overlayAudioRegistry = new Map();
const titleRowActionRegistry = new Map();
const coreHookRegistry = new Map(); // event name -> Set<fn>
const rendererServiceRegistry = new Map();
let loadErrors = []; // [{id, name, error}] — surfaced once via a themed alert, not per-plugin

export function registerChannelType(id, definition) {
  if (!id || typeof id !== 'string') throw new Error('registerChannelType: id must be a non-empty string');
  if (!definition || typeof definition.render !== 'function') {
    throw new Error(`registerChannelType("${id}"): definition.render(container, ctx) is required`);
  }
  if (!Number.isInteger(definition.number)) {
    throw new Error(`registerChannelType("${id}"): definition.number (an integer channel number) is required`);
  }
  channelTypeRegistry.set(id, definition);
}

export function getPluginChannelType(id) {
  return channelTypeRegistry.get(id) || null;
}

export function pluginChannelTypeIds() {
  return Array.from(channelTypeRegistry.keys());
}

// Renderer-local counterpart to main-process registerService/callService.
// This keeps plugin-to-plugin UI collaboration behind a generic named
// contract instead of encouraging plugins to attach one-off globals.
export function registerRendererService(id, service) {
  if (!id || typeof id !== 'string') throw new Error('registerRendererService: id must be a non-empty string');
  if (!service || typeof service !== 'object') throw new Error(`registerRendererService("${id}"): service must be an object`);
  rendererServiceRegistry.set(id, service);
}

export function getRendererService(id) {
  return rendererServiceRegistry.get(id) || null;
}

// A plugin channel's authored `number`/`label` are just defaults — the
// Channel Setup screen's PLUGIN CHANNELS section (setup-channels.js) lets a
// user rename/renumber one the same way a real channel row does, without
// touching the plugin's own code or its dedicated PLUGINS-tab settings.
// Stored in the same generic per-plugin namespace as channelDisplay above,
// so it survives config export/import and undo/redo like everything else
// that flows through updatePluginSettings.
export function getPluginChannelOverride(id, definition = getPluginChannelType(id)) {
  const stored = getPluginSettings(id).channelOverride;
  const hasStored = stored && typeof stored === 'object' && !Array.isArray(stored);
  const hasName = hasStored && typeof stored.name === 'string' && stored.name.trim();
  const hasNumber = hasStored && Number.isInteger(stored.number);
  return {
    name: hasName ? stored.name.trim() : ((definition && definition.label) || id),
    number: hasNumber ? stored.number : ((definition && definition.number) || 0),
  };
}

export function updatePluginChannelOverride(id, patch) {
  const previous = getPluginSettings(id);
  const channelOverride = previous.channelOverride && typeof previous.channelOverride === 'object' && !Array.isArray(previous.channelOverride)
    ? previous.channelOverride
    : {};
  return updatePluginSettings(id, { channelOverride: { ...channelOverride, ...patch } });
}

// The channel number actually in effect for a registered channel-type plugin
// right now — its own definition.number, unless the user has overridden it
// via getPluginChannelOverride above. Every place that needs to know "what
// number does this plugin currently live at" (virtual.js's guide/tune-in
// logic, display-mode.js's per-channel override lookup) goes through this
// single function rather than reading definition.number directly, so an
// override takes effect everywhere consistently.
export function getPluginChannelEntryForNumber(number) {
  for (const [id, definition] of channelTypeRegistry) {
    if (getPluginChannelOverride(id, definition).number === number) return { id, definition };
  }
  return null;
}

// Generic persisted settings owned by the plugin platform. Plugin-specific
// legacy config can keep living where it already does; shared/type-provided
// settings use this namespace so core never needs to know a plugin's private
// config shape. Reads are non-mutating, while writes always use the renderer's
// normal save funnel so configGeneration and undo/redo stay correct.
export function getPluginSettings(id) {
  const root = S.config && S.config.pluginSettings;
  const settings = root && Object.prototype.hasOwnProperty.call(root, id) ? root[id] : null;
  return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
}

export function updatePluginSettings(id, patch) {
  if (!id || typeof id !== 'string') throw new Error('updatePluginSettings: id must be a non-empty string');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error(`updatePluginSettings("${id}"): patch must be an object`);
  }
  if (!S.config.pluginSettings || typeof S.config.pluginSettings !== 'object' || Array.isArray(S.config.pluginSettings)) {
    S.config.pluginSettings = {};
  }
  const previous = getPluginSettings(id);
  const next = { ...previous, ...patch };
  validatePluginSettings(id, next, settingsSchemaRegistry.get(id));
  Object.defineProperty(S.config.pluginSettings, id, {
    value: next, enumerable: true, configurable: true, writable: true,
  });
  commitInPlace({ type: 'plugin.setSettings', id, settings: next });
  return S.config.pluginSettings[id];
}

export function getRedactedPluginSettings(id) {
  return redactPluginSettings(getPluginSettings(id), settingsSchemaRegistry.get(id));
}

// Definition fields remain a compatibility/default fallback for plugins
// written before core-owned channel settings existed. Once a user chooses a
// value in the generated panel, even an explicit null (INHERIT) wins over the
// old definition value and is persisted in the generic namespace.
export function getPluginChannelDisplaySettings(id, definition = getPluginChannelType(id)) {
  const stored = getPluginSettings(id).channelDisplay;
  const hasStored = stored && typeof stored === 'object' && !Array.isArray(stored);
  const hasResolution = hasStored && Object.prototype.hasOwnProperty.call(stored, 'resolutionOverride');
  const hasAspect = hasStored && Object.prototype.hasOwnProperty.call(stored, 'displayAspectOverride');
  return {
    resolutionOverride: hasResolution ? stored.resolutionOverride : ((definition && definition.resolutionOverride) || null),
    displayAspectOverride: hasAspect ? stored.displayAspectOverride : ((definition && definition.displayAspectOverride) || null),
  };
}

export function updatePluginChannelDisplaySettings(id, patch) {
  const previous = getPluginSettings(id);
  const channelDisplay = previous.channelDisplay && typeof previous.channelDisplay === 'object' && !Array.isArray(previous.channelDisplay)
    ? previous.channelDisplay
    : {};
  return updatePluginSettings(id, { channelDisplay: { ...channelDisplay, ...patch } });
}

// A plugin that wants its own settings UI (a toggle, a path field, whatever)
// registers one of these instead of the app hardcoding a panel for it in
// index.html — mirrors registerChannelType's shape. render(container, ctx)
// is called every time the plugin's own SETTINGS toggle (in its PLUGINS tab
// row — see setup-plugins.js's renderPluginsList) is expanded, same
// "rebuild from scratch each time" contract as a channel type's render() —
// so it should clear/rebuild `container`'s contents each call rather than
// assuming it's empty only the first time.
export function registerSettingsPanel(id, definition) {
  if (!id || typeof id !== 'string') throw new Error('registerSettingsPanel: id must be a non-empty string');
  if (!definition || typeof definition.render !== 'function') {
    throw new Error(`registerSettingsPanel("${id}"): definition.render(container, ctx) is required`);
  }
  settingsPanelRegistry.set(id, definition);
}

export function getPluginSettingsPanel(id) {
  return settingsPanelRegistry.get(id) || null;
}

// New composable settings API. Type-provided sections are assembled by core;
// plugins contribute only their own sections. registerSettingsPanel above is
// intentionally retained as a legacy single-section contract.
export function registerPluginSettings(id, definition) {
  if (!id || typeof id !== 'string') throw new Error('registerPluginSettings: id must be a non-empty string');
  if (!definition || !Array.isArray(definition.sections) || !definition.sections.length) {
    throw new Error(`registerPluginSettings("${id}"): definition.sections must be a non-empty array`);
  }
  const schema = normalizePluginSettingsSchema(id, definition);
  if (schema) {
    const metaRoot = S.config.pluginSettingsMeta && typeof S.config.pluginSettingsMeta === 'object' && !Array.isArray(S.config.pluginSettingsMeta)
      ? S.config.pluginSettingsMeta
      : {};
    const storedMeta = metaRoot[id] && typeof metaRoot[id] === 'object' ? metaRoot[id] : {};
    const applied = applyPluginSettingsSchema(id, getPluginSettings(id), storedMeta.schemaVersion, schema);
    settingsSchemaRegistry.set(id, schema);
    if (applied.changed) {
      if (!S.config.pluginSettings || typeof S.config.pluginSettings !== 'object' || Array.isArray(S.config.pluginSettings)) S.config.pluginSettings = {};
      S.config.pluginSettings[id] = applied.settings;
      S.config.pluginSettingsMeta = metaRoot;
      metaRoot[id] = { schemaVersion: applied.version };
      commitInPlace([
        { type: 'plugin.setSettings', id, settings: applied.settings },
        { type: 'settings.set', path: ['pluginSettingsMeta'], value: metaRoot },
      ], { skipUndo: true, delay: 0 });
    }
  }
  const existing = settingsSectionRegistry.get(id) || [];
  const seen = new Set(existing.map((section) => section.id));
  const allowedLayouts = new Set(['stack', 'two-column', 'wide']);
  const sections = definition.sections.map((section) => {
    if (!section || !section.id || typeof section.id !== 'string') {
      throw new Error(`registerPluginSettings("${id}"): every section needs a string id`);
    }
    if (seen.has(section.id)) throw new Error(`registerPluginSettings("${id}"): duplicate section id "${section.id}"`);
    if (typeof section.render !== 'function') {
      throw new Error(`registerPluginSettings("${id}", "${section.id}"): render(container, ctx) is required`);
    }
    const layout = section.layout || 'stack';
    if (!allowedLayouts.has(layout)) {
      throw new Error(`registerPluginSettings("${id}", "${section.id}"): layout must be stack, two-column, or wide`);
    }
    seen.add(section.id);
    return { id: section.id, label: section.label || '', layout, render: section.render };
  });
  settingsSectionRegistry.set(id, [...existing, ...sections]);
}

// Setup search entries for settings a plugin draws itself (docs/design/03 §6).
// Each is { label, keywords?, section? }: label is what the user reads,
// keywords are extra words to match, section is a registerPluginSettings
// section id to scroll to. Replaces the plugin's earlier entries.
export function registerSettingsSearchEntries(id, entries) {
  if (!id || typeof id !== 'string') throw new Error('registerSettingsSearchEntries: id must be a non-empty string');
  if (!Array.isArray(entries)) throw new Error(`registerSettingsSearchEntries("${id}"): entries must be an array`);
  const clean = entries.map((entry, index) => {
    if (!entry || typeof entry.label !== 'string' || !entry.label.trim()) {
      throw new Error(`registerSettingsSearchEntries("${id}"): entry ${index} needs a label`);
    }
    return {
      label: entry.label.trim(),
      keywords: typeof entry.keywords === 'string' ? entry.keywords : '',
      section: typeof entry.section === 'string' ? entry.section : null,
    };
  });
  settingsSearchRegistry.set(id, clean);
}

// Everything the setup search knows about plugins: one entry per installed
// plugin (its name and description, plus its section labels) and the
// entries plugins registered for individual settings.
export function getPluginSearchEntries() {
  const results = [];
  installedPluginSummaries.forEach((summary, id) => {
    const sectionLabels = (settingsSectionRegistry.get(id) || []).map((section) => section.label).filter(Boolean);
    results.push({
      pluginId: id, pluginName: summary.name, kind: 'plugin', label: summary.name, section: null,
      preview: summary.description || '',
      haystack: [summary.name, id, summary.description, ...sectionLabels].filter(Boolean).join(' ').toLowerCase(),
    });
    (settingsSearchRegistry.get(id) || []).forEach((entry) => {
      results.push({
        pluginId: id, pluginName: summary.name, kind: 'setting', label: entry.label, section: entry.section,
        preview: summary.name,
        haystack: [entry.label, entry.keywords, summary.name].filter(Boolean).join(' ').toLowerCase(),
      });
    });
  });
  return results;
}

export function getPluginSettingsSections(id) {
  const sections = settingsSectionRegistry.get(id) || [];
  const legacy = getPluginSettingsPanel(id);
  return legacy ? [...sections, { id: 'legacy-panel', label: '', render: legacy.render, legacy: true }] : [...sections];
}

// A media-source provider plugin's own "browse for a folder" UI —
// PLUGIN_DEVELOPMENT.md's "Media sources" section documents the four core
// verbs (list/probe/readRange/checkAvailable, called via ctx.callService
// from the plugin's MAIN process) plus an optional main-process pickFolder
// verb; this is a second, richer alternative to that plain pickFolder verb,
// registered from the plugin's *renderer.js* instead — since a plugin's
// renderer.js already runs in this same window/process (same reason
// registerSettingsPanel/registerChannelType are plain function calls, not
// IPC), `pickerFn` can build and show a real modal (breadcrumbs, a
// clickable folder list, whatever the provider's own data shape needs)
// directly, with none of the cross-process UI choreography a main-process
// pickFolder verb would need to show anything. setup-channels.js's CHOOSE
// SOURCE flow tries this first, falls back to the main-process pickFolder
// verb, then finally to a plain text-input prompt if neither is
// registered. `pickerFn(): Promise<folderRef | null>` — same
// null-means-cancelled contract as the plain-prompt fallback.
export function registerMediaSourcePicker(providerId, pickerFn) {
  if (!providerId || typeof providerId !== 'string') throw new Error('registerMediaSourcePicker: providerId must be a non-empty string');
  if (typeof pickerFn !== 'function') throw new Error(`registerMediaSourcePicker("${providerId}"): pickerFn must be a function`);
  mediaSourcePickerRegistry.set(providerId, pickerFn);
}

export function getMediaSourcePicker(providerId) {
  return mediaSourcePickerRegistry.get(providerId) || null;
}

// A "pack" plugin bundles one CRT theme's look (`html[data-theme="<id>"]`
// CSS, shipped in the plugin's own style.css — same app://plugins/ delivery
// every other plugin stylesheet already uses, nothing new needed there)
// with the behavioral bits a handful of themes also carry beyond CSS: CRT
// bias defaults, a channel-change static style, channel/power SFX, ambient
// audio texture, and an optional border/bezel image for non-16:9 content.
// `safeAreaPct` (optional, only meaningful alongside `borderImage`) is
// `{ top, right, bottom, left }`, each a 0-1 fraction of the screen that
// border's artwork visually occupies — applyTvBezel (power.js) shrinks/
// repositions the video into the remaining space so it doesn't render
// underneath the frame. Omitted entirely, a modest default inset is used
// instead (DEFAULT_SAFE_AREA_PCT, power.js) so every existing pack still
// gets this "content auto-fits inside the border" behavior for free.
// `id` is the theme id (`S.config.theme` value, e.g. "wood-console-70s"),
// NOT the plugin id — mirrors how CSS already keys off the theme id via
// `[data-theme]`, so a pack plugin's manifest id can differ from its theme
// id (e.g. plugin id "theme-wood-console-70s", theme id
// "wood-console-70s") without the two needing to be kept in sync by hand.
// Every field but `label` is optional — a color-only theme (most of them)
// registers just `{ label }` (plus maybe `borderImage`), and core's own
// lookups (crtBias/staticStyle/sfx/ambientTexture) all fall back to today's
// generic defaults when a field is absent, exactly as if no pack were
// registered for that theme at all.
// `group` (optional) is a plain UI-categorization string — setup-settings.js's
// theme `<select>` (18 entries and counting) groups options under an
// `<optgroup>` per distinct value instead of one long flat list. Purely
// cosmetic, no behavioral effect; a pack that omits it falls into a generic
// "OTHER" group. Existing values in use: 'ERA (BY DECADE)', 'REAL CABLE-BOX
// UI', 'BROADCAST/STUDIO', 'STYLIZED' — reuse one of these for a new pack
// where it fits rather than inventing a near-duplicate.
// `captionStyle` (optional) is read by the closed-captions plugin, not core
// — an era-appropriate `#player::cue` styling object (background, color,
// fontFamily, fontSize, textTransform, padding, textShadow). Core has no
// idea captions exist; this field just sits here unread unless that plugin
// is installed, same as every other optional field on this object.
// `preview` (optional) gives the theme browser a stable, representative
// three-color swatch without applying the theme. Use CSS color strings for
// `background`, `accent`, and `secondary`. Packs that omit it receive a
// neutral preview so third-party themes remain selectable.
// `guidePreviewDefault` (optional, boolean) sets the *default* for whether
// the full-page program guide (DOCKED/FULL, guide.js's toggleGuideDockMode)
// shrinks the live picture into a top-right preview box while this theme is
// active — a look that's anachronistic for a pre-picture-in-picture era.
// Read by guide.js's guideLivePreviewEnabled, same lookup shape as crtBias
// above. Omitted (or any value other than `false`) keeps today's behavior,
// the preview box on. This is only ever a *default* — DISPLAY > GUIDE LIVE
// PREVIEW (S.config.display.guideLivePreview) lets the user set an explicit
// value that always overrides it, the same "explicit user choice beats
// theme default" rule getPluginChannelDisplaySettings's INHERIT semantics
// already use for per-channel overrides.
export function registerThemePack(id, definition) {
  if (!id || typeof id !== 'string') throw new Error('registerThemePack: id must be a non-empty string');
  if (!definition || typeof definition.label !== 'string') {
    throw new Error(`registerThemePack("${id}"): definition.label is required`);
  }
  themePackRegistry.set(id, definition);
}

export function getThemePack(id) {
  return themePackRegistry.get(id) || null;
}

// For the theme <select> (setup-settings.js) to build its option list from
// whatever pack plugins are actually installed+enabled, instead of a
// hardcoded 10-option HTML block — always includes 'digital-2000s' even
// with zero pack plugins installed, since that theme's look is just core's
// own base :root palette (no override CSS, no plugin required) and must
// stay available as the safe zero-plugins default.
export function themePackEntries() {
  const entries = Array.from(themePackRegistry.entries())
    .map(([themeId, def]) => ({
      id: themeId,
      label: def.label,
      group: def.group || 'OTHER',
      preview: def.preview || null,
    }));
  if (!themePackRegistry.has('digital-2000s')) {
    entries.unshift({
      id: 'digital-2000s',
      label: 'DIGITAL CABLE (MID 2000s BLUE)',
      group: 'ERA (BY DECADE)',
      preview: { background: '#000d1a', accent: '#00bfff', secondary: '#7fd4ff' },
    });
  }
  return entries;
}

// A full-screen (or otherwise attention-grabbing) interrupt a plugin can
// trigger on top of whatever's tuned — an alert slate, a news crawl, or any
// other third-party equivalent. Generalizes what used to be a couple of
// hand-wired special cases (each independently hardcoded by name in
// app.js/power.js/playback.js/tv-menu.js) into one registry any plugin can
// join.
//   label         — shown as a TV-menu button (tv-menu.js).
//   hintKey       — matches a hint-bar item's data-hintKey (power.js), so
//                   that item auto-hides when this plugin is disabled.
//   hotkey        — optional single letter; app.js's key handler runs
//                   .run({manual: true}) when it's pressed on live TV.
//   run(opts)     — trigger the interrupt.
//   cancel()      — called on power-off and whenever the box tunes to a new
//                   channel (playback.js) — clear timers, hide the overlay.
//   scheduleNext() — called after a tune-in completes, so a plugin that
//                   auto-fires periodically (e.g. "roll EAS test every N
//                   minutes") can re-arm its own timer for the new channel.
//   cancelScheduled() — optional; stops a pending scheduleNext() timer
//                   without touching an in-progress alert (distinct from
//                   cancel()) — called when entering setup, so a random
//                   test doesn't fire while there's no live TV to interrupt.
//   isActive()    — optional; returns whether THIS interrupt is currently
//                   showing. Lets one interrupt plugin (e.g. eas-alerts)
//                   politely defer to another (e.g. breaking-news) via
//                   anyOtherInterruptActive() below without either plugin
//                   hardcoding the other's name or private state field —
//                   each plugin only ever describes itself.
export function registerInterrupt(id, definition) {
  if (!id || typeof id !== 'string') throw new Error('registerInterrupt: id must be a non-empty string');
  if (!definition || typeof definition.run !== 'function') {
    throw new Error(`registerInterrupt("${id}"): definition.run(opts) is required`);
  }
  interruptRegistry.set(id, definition);
}

export function getInterrupt(id) {
  return interruptRegistry.get(id) || null;
}

export function interruptEntries() {
  return Array.from(interruptRegistry.entries()).map(([id, def]) => ({ id, ...def }));
}

// True if any REGISTERED interrupt other than excludeId reports itself
// active via its own optional isActive() — generic stand-in for a plugin
// that would otherwise have to hardcode another specific plugin's id/state
// field (e.g. "don't fire if breaking-news happens to be up") to avoid two
// full-screen/overlay interrupts colliding. A plugin that never defines
// isActive() simply never blocks anything this way, exactly as if it didn't
// exist for this check.
export function anyOtherInterruptActive(excludeId) {
  for (const [id, def] of interruptRegistry) {
    if (id !== excludeId && typeof def.isActive === 'function' && def.isActive()) return true;
  }
  return false;
}

export function cancelAllInterrupts() {
  interruptRegistry.forEach((def) => { if (def.cancel) def.cancel(); });
}

export function scheduleAllInterrupts() {
  interruptRegistry.forEach((def) => { if (def.scheduleNext) def.scheduleNext(); });
}

export function cancelAllScheduledInterrupts() {
  interruptRegistry.forEach((def) => { if (def.cancelScheduled) def.cancelScheduled(); });
}

// A gate a plugin can register to block tuning into a channel until some
// condition is met — generalizes pin-lock's isPinLocked/showPinLockScreen
// (previously the one hardcoded lock system playback.js's tuneToChannel
// knew about by direct import) into a registry any plugin can join, e.g. a
// bedtime lock or a PPV-credit gate.
//   isBlocked(number) — return true to block the tune.
//   onBlocked(number) — called instead of tuning; owns showing whatever UI
//                       resolves the block (a PIN pad, a purchase prompt)
//                       and calling window.tuneToChannel(number,
//                       {bypassGateIds: [id]}) once satisfied.
export function registerTuneGate(id, definition) {
  if (!id || typeof id !== 'string') throw new Error('registerTuneGate: id must be a non-empty string');
  if (!definition || typeof definition.isBlocked !== 'function' || typeof definition.onBlocked !== 'function') {
    throw new Error(`registerTuneGate("${id}"): definition.isBlocked(number) and onBlocked(number) are required`);
  }
  tuneGateRegistry.set(id, definition);
}

export function tuneGateEntries() {
  return Array.from(tuneGateRegistry.entries()).map(([id, def]) => ({ id, ...def }));
}

// A background <audio> element that plays independently of whatever's tuned
// (an overlay music source, e.g. a channel that opts to keep playing under
// other channels) and needs master-volume/mute/power coordination from core
// the same way the shared #player does. Generalizes what used to be a single
// hardcoded single-plugin `.overlayAudioEl` special case in power.js into a
// registry any plugin can join.
//   el              — the plugin's own persistent <audio> element.
//   overlayVolume()  — optional; returns this source's own 0-1 volume
//                      slider value (multiplied with master volume). Falls
//                      back to 0.6 if omitted.
//   resumeIfNeeded() — optional; called on power-on, so a plugin whose
//                      overlay was paused for power-off can resume it.
export function registerOverlayAudioSource(id, definition) {
  if (!id || typeof id !== 'string') throw new Error('registerOverlayAudioSource: id must be a non-empty string');
  if (!definition || !definition.el) {
    throw new Error(`registerOverlayAudioSource("${id}"): definition.el (the <audio> element) is required`);
  }
  overlayAudioRegistry.set(id, definition);
}

export function overlayAudioEntries() {
  return Array.from(overlayAudioRegistry.entries()).map(([id, def]) => ({ id, ...def }));
}

// A plugin can inject its own per-file action into the TITLES tab's file
// rows (setup-panels.js) — and, since that same row renderer is reused for a
// SCHEDULE block's own file list (setup-schedule.js), there too — without
// core needing to know that plugin exists at all. Generalizes what used to
// be a single hardcoded metadata-lookup button built directly into
// setup-panels.js (core had no business knowing that specific plugin
// existed, let alone building its whole UI).
//   renderRowCell(container, file, ctx)  — called once per visible file row;
//                                          build this action's own UI (a
//                                          button, a poster thumbnail,
//                                          whatever) into `container`, an
//                                          empty cell core creates and
//                                          appends into the row. Same
//                                          "clear/rebuild on every call, own
//                                          `container` fully" contract every
//                                          other registry here already uses.
//   renderBulkAction(container, ctx)     — optional; called once per panel
//                                          build to add a control into the
//                                          bulk-action bar (acts on every
//                                          currently-selected file at once).
// ctx (both hooks) is the standard window.RCBPlugins.ctx, plus:
//   getSelectedFiles()  — (renderBulkAction only) the Set of files currently
//                         bulk-selected on this panel.
//   rerender()          — re-renders every row (e.g. after a bulk action
//                         mutates many files at once).
export function registerTitleRowAction(id, definition) {
  if (!id || typeof id !== 'string') throw new Error('registerTitleRowAction: id must be a non-empty string');
  if (!definition || typeof definition.renderRowCell !== 'function') {
    throw new Error(`registerTitleRowAction("${id}"): definition.renderRowCell(container, file, ctx) is required`);
  }
  titleRowActionRegistry.set(id, definition);
}

export function titleRowActionEntries() {
  return Array.from(titleRowActionRegistry.entries()).map(([id, def]) => ({ id, ...def }));
}

// Generic core-to-plugin event hook — closes the last ad-hoc gap in plugin
// agnosticism: before this, a handful of core call sites reached into a
// specific plugin by hardcoded name (window.RCBPlugins.screensaver?.
// cancelTimer?.(), .vintageAudio?.applyThemeAudio?.(), .smpteTestPattern?.
// draw?.()) — safe (null-checked) but still meant core had to know that
// exact plugin's property name existed. A plugin now subscribes to a named
// event instead (e.g. 'power-off', 'idle-reset', 'draw-test-pattern' — see
// PLUGIN_DEVELOPMENT.md for the current event list) and core fires the
// event generically, with zero knowledge of who (if anyone) is listening.
// Multiple plugins may subscribe to the same event; one plugin may
// subscribe to several. A throw in one handler is caught and logged, same
// per-plugin failure isolation every other registry here already gives —
// it doesn't stop the remaining handlers for that event from running.
export function registerCoreHook(event, fn) {
  if (!event || typeof event !== 'string') throw new Error('registerCoreHook: event must be a non-empty string');
  if (typeof fn !== 'function') throw new Error(`registerCoreHook("${event}"): fn must be a function`);
  if (!coreHookRegistry.has(event)) coreHookRegistry.set(event, new Set());
  coreHookRegistry.get(event).add(fn);
}

export function runCoreHooks(event, ...args) {
  const fns = coreHookRegistry.get(event);
  if (!fns) return;
  fns.forEach((fn) => {
    try { fn(...args); } catch (e) { console.error(`[core hook "${event}"] a plugin's handler threw`, e); }
  });
}

// Functions and DOM nodes never cross the diagnostics boundary. This is an
// inventory of registration ids/counts only, safe to display and export.
export function pluginDiagnosticsSnapshot() {
  return {
    channelTypes: Array.from(channelTypeRegistry.keys()),
    settingsPanels: Array.from(settingsPanelRegistry.keys()),
    settingsSections: Array.from(settingsSectionRegistry.entries()).map(([id, sections]) => ({ id, sections: sections.map((s) => s.id) })),
    settingsSchemas: Array.from(settingsSchemaRegistry.keys()),
    mediaSourcePickers: Array.from(mediaSourcePickerRegistry.keys()),
    themePacks: Array.from(themePackRegistry.keys()),
    interrupts: Array.from(interruptRegistry.keys()),
    tuneGates: Array.from(tuneGateRegistry.keys()),
    overlayAudioSources: Array.from(overlayAudioRegistry.keys()),
    titleRowActions: Array.from(titleRowActionRegistry.keys()),
    coreHooks: Array.from(coreHookRegistry.entries()).map(([event, handlers]) => ({ event, count: handlers.size })),
    loadErrors: loadErrors.map((entry) => ({ ...entry })),
  };
}

// ctx started as one flat object of ~15 unrelated keys (state access, audio
// primitives, channel helpers, settings helpers) and was calcifying that way
// as more got bolted on. CTX_VERSION/minCtxVersion below exist so a FUTURE
// breaking reshape (e.g. actually removing the flat top-level aliases) can
// fail a too-old plugin with a clear message at load time instead of an
// undefined-property crash deep inside its render(). This pass only adds the
// grouped namespaces (ctx.audio/ctx.channels/ctx.settings) alongside the
// existing flat keys — every flat key stays exactly as it was, so no
// existing plugin's renderer.js needs to change. New plugin code should
// prefer the grouped form; the flat aliases are the deprecated-but-supported
// path until a version bump actually retires them.
// v3 added resolveBreakAt/nextBreakBoundary to ctx.channels — the pair a
// plugin needs to walk a channel's real broadcast (content AND the breaks
// between it) across a time range, rather than only the content the guide
// lists.
// v4 added ctx.search.registerEntries (setup search entries for a plugin's
// own settings).
const CTX_VERSION = 4;

function installGlobalApi() {
  const core = { S, viewNow, player, saveConfigDebounced };
  const audio = { playTone, playNoiseBurst, getAudioCtx };
  const channels = {
    sortedChannels, buildChannelBadge, getChannel, getChannelSchedule, getDisplayTitle, formatSlotLabel,
    addFilesToChannel, addInterstitialPoolEntry,
    resolveBreakAt, nextBreakBoundary,
  };
  const settings = { getPluginSettings, updatePluginSettings, getRedactedPluginSettings };
  const util = { formatClock, WEEKDAYS, MONTHS };
  const search = { registerEntries: registerSettingsSearchEntries };

  window.RCBPlugins = {
    registerChannelType,
    registerSettingsPanel,
    registerPluginSettings,
    registerSettingsSearchEntries,
    registerMediaSourcePicker,
    registerThemePack,
    getThemePack,
    registerInterrupt,
    getInterrupt,
    anyOtherInterruptActive,
    registerTuneGate,
    registerOverlayAudioSource,
    registerTitleRowAction,
    registerCoreHook,
    registerRendererService,
    getRendererService,
    // Same shape as the ctx a channel type's render()/stop() receives —
    // exposed here too so a plugin's top-level code (e.g. registering an
    // IPC listener that needs to update S.<pluginField> even before the
    // user ever tunes to its channel) can read S/viewNow/player
    // synchronously at module-load time, before its own render() has ever
    // been called. Set before any plugin renderer.js is imported below, so
    // it's always safe to read at a plugin's own top level.
    // playTone/playNoiseBurst/getAudioCtx are here so a theme-pack plugin's
    // channelChangeSfx/powerSfx hooks (registerThemePack) can build custom
    // sound effects with the app's own SFX primitives — a plugin can't
    // import audio.js directly (app://plugins is a different origin than
    // app://bundle, and only app://plugins responses carry the
    // Access-Control-Allow-Origin header a cross-origin import needs).
    // sortedChannels/buildChannelBadge/getChannelSchedule/getDisplayTitle/
    // formatSlotLabel/saveConfigDebounced are here for the same
    // can't-import-core-directly reason, needed by a program-listing-style
    // channel's render() (it has to read the box's real channel lineup
    // and live schedule, not something a plugin could reasonably reimplement
    // on its own without duplicating — and risking drifting out of sync
    // with — core's actual scheduling engine).
    // resolveBreakAt/nextBreakBoundary (interstitials.js) are the break-side
    // counterparts to getChannelSchedule: the first answers "what, if
    // anything, is interrupting content at this instant," the second "when
    // does that answer next change." Together with getChannelSchedule they
    // let a plugin reconstruct a channel's ENTIRE broadcast across a range —
    // shows plus the bumpers and commercials between them — which is what
    // recording one needs and what the guide alone can't give. Exposed
    // rather than reimplemented for the usual reason: break resolution is
    // several hundred lines of cadence, pod and flow logic that must not
    // drift out of sync with what actually airs.
    // addFilesToChannel/addInterstitialPoolEntry (channels.js) let a plugin
    // add real content to a channel or the interstitials pool without
    // knowing the config object's shape — same dedupe/shuffle/anchor and
    // pool-entry-default logic core's own setup-dragdrop.js/
    // setup-interstitials.js use for the identical job.
    // formatClock/WEEKDAYS/MONTHS are here so a listing-style channel (e.g.
    // prevue, public-access) doesn't need its own copy of this exact
    // clock-formatting/day-name/month-name logic — same can't-import-core-
    // directly reason as everything else on this object.
    ctx: {
      ...core, ...audio, ...channels, ...settings, ...util,
      // Grouped namespaces — the shape new plugin code should read from.
      // Each group is its own object (not just a re-export of the flat
      // keys) so a plugin can destructure `const { channels } = ctx`
      // without pulling in everything else.
      core, audio, channels, settings, util, search,
    },
    // Bumped whenever ctx's shape changes in a way a plugin might care
    // about (see CTX_VERSION above) — a plugin can declare manifest.json's
    // optional `minCtxVersion` and loadPlugins() (below) will refuse to
    // import it with a clear error instead of letting it crash on a
    // property that doesn't exist yet in this app version.
    version: CTX_VERSION,
  };
}

export async function loadPlugins() {
  installGlobalApi();
  let manifests;
  try {
    manifests = await window.api.pluginsList();
  } catch (e) {
    return; // main process couldn't enumerate plugins — nothing to load
  }

  // plugins:list (main.js) always returns every *installed* plugin,
  // disabled or not — the PLUGINS tab needs that to show an unchecked row
  // for a disabled one. Loading here is what actually has to respect
  // S.config.plugins.disabled; the main-process side already does (see
  // loadMainPlugins's own disabled-id filter, main-plugins.js) — this was
  // the one place that never did, so a "disabled" plugin's style/renderer
  // still loaded and registered its channel/settings panel exactly as if
  // it were enabled.
  const disabledIds = (S.config.plugins && S.config.plugins.disabled) || [];
  const isDisabled = (p) => disabledIds.includes(p.id);

  manifests.forEach((p) => {
    if (!p.error) installedPluginSummaries.set(p.id, { name: p.name || p.id, description: p.description || '' });
    if (p.error) { loadErrors.push({ id: p.dir, name: p.dir, error: p.error }); return; }
    if (isDisabled(p)) return;
    if (p.loadError) { loadErrors.push({ id: p.id, name: p.name, error: `(main process) ${p.loadError}` }); return; }
    if (p.needsIntegrityApproval) return;
    if (p.style) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      const base = window.__isViewer ? '/plugins' : 'app://plugins';
      link.href = `${base}/${encodeURIComponent(p.dir)}/${p.style}`;
      link.dataset.pluginId = p.id;
      document.head.appendChild(link);
    }
  });

  // Renderer/settings entries used to be imported one at a time (~96
  // sequential awaits across ~50 plugins) to keep one plugin's top-level
  // throw from interleaving with another's registration calls in a confusing
  // order. That ordering was never load-bearing for correctness though —
  // every registry a plugin's top-level code writes into (channelType,
  // settings sections, theme packs, etc.) is a plain id-keyed Map, so which
  // plugin registers first doesn't matter. Main-process activate() order
  // (which DOES matter, for ctx.services dependencies) is unaffected — that
  // sequencing lives entirely in loadMainPlugins (main-plugins.js), not here.
  // Firing every import() in the same tick lets their underlying fetches
  // overlap instead of paying for each one's latency in series; errors are
  // still collected back in manifest order for a stable-looking report.
  const importJobs = [];
  manifests.forEach((p) => {
    if (p.error || p.loadError || p.needsIntegrityApproval || isDisabled(p)) return;
    // Optional manifest field — a plugin built against a newer ctx shape
    // than this app version provides. Caught here, before import(), so the
    // failure is a clear one-line PLUGIN ERROR instead of an undefined-
    // property crash somewhere inside the plugin's own top-level code.
    if (Number.isInteger(p.minCtxVersion) && p.minCtxVersion > CTX_VERSION) {
      loadErrors.push({
        id: p.id, name: p.name,
        error: `requires plugin ctx v${p.minCtxVersion}, this app provides v${CTX_VERSION} — update RerunTV or use an older build of this plugin`,
      });
      return;
    }
    [['renderer', p.renderer], ['settings', p.settings]].forEach(([kind, entry]) => {
      if (!entry) return;
      const base = window.__isViewer ? '/plugins' : 'app://plugins';
      const url = `${base}/${encodeURIComponent(p.dir)}/${entry}`;
      importJobs.push({ p, kind, promise: import(/* webpackIgnore: true */ url) });
    });
  });
  const importResults = await Promise.allSettled(importJobs.map((job) => job.promise));
  importResults.forEach((result, i) => {
    if (result.status !== 'rejected') return;
    const { p, kind } = importJobs[i];
    loadErrors.push({ id: p.id, name: p.name, error: `(${kind}) ${result.reason.message}` });
  });

  if (loadErrors.length) {
    const lines = loadErrors.map((e) => `${e.name}: ${e.error}`).join('\n');
    alertDialog(`${loadErrors.length} plugin${loadErrors.length === 1 ? '' : 's'} failed to load:\n\n${lines}`, { variant: 'error', title: 'PLUGIN ERROR' });
  }
  // Also notify any future caller that deliberately reloads/rebuilds plugin
  // UI outside the initial awaited boot sequence.
  window.dispatchEvent(new Event('rcb:plugins-loaded'));
  reportInstalledThemes();
}

// Pushes the current theme-pack registry to main (companion-app/main.js's
// GET /api/themes reads it back via ctx.getInstalledThemes) — the registry
// only ever exists here, populated by whichever pack plugins' renderer.js
// modules happened to call registerThemePack, so main has no way to know
// the list on its own. Called after every plugin (re)load, boot included,
// same as renderThemeSelectOptions' own "rebuilt on every visit" comment
// explains — the installed-pack set can change between calls.
function reportInstalledThemes() {
  if (window.api.reportInstalledThemes) window.api.reportInstalledThemes(themePackEntries());
}

// Re-fetches and re-registers a single plugin's renderer-side assets
// (style.css, renderer.js, settings.js) without restarting the app —
// cache-busts every URL with a fresh timestamp so an on-disk edit is
// actually picked up (app://plugins/... otherwise resolves to the exact
// same specifier Chromium already has cached, both as an HTTP response and,
// for the JS files, as an already-evaluated ES module record). Deliberately
// does NOT touch this plugin's main.js — a same-process main-process plugin
// has no deactivate() hook yet, so cleanly unregistering its ipcMain
// handlers/spawned processes isn't possible without a real architecture
// change (see PLUGIN_DEVELOPMENT.md); a plugin with system-level changes
// still needs a full app restart, same as before this existed.
// Most registries here are plain id-keyed Maps, so re-running a plugin's
// top-level register*() calls naturally replaces its old entry. The one
// exception is settingsSectionRegistry, which *appends* (registerPluginSettings
// supports being called more than once per plugin for a different section
// each time) — cleared explicitly first so a reload doesn't duplicate every
// section it already registered. registerThemePack keys off the theme id,
// not the plugin id (a "theme-x" plugin registers theme id "x" — see that
// function's doc comment above), so it's cleared the same way when the
// naming convention holds.
// Known limitation: this only cleans up what a plugin declares through the
// register*() contract. A plugin whose top-level code has side effects
// beyond that — a running setInterval, an <audio> element it created and
// kept its only reference to locally, a registerCoreHook subscription (no
// registry here tracks which plugin owns which hook handler) — can still
// leak a stale instance across a reload. Fine for the common styling/UI/
// settings-panel iteration loop this exists for; not a guaranteed-clean
// unload for every possible plugin.
export async function reloadPlugin(id) {
  let manifests;
  try {
    manifests = await window.api.pluginsList();
  } catch (e) {
    return { ok: false, error: `couldn't refresh plugin list: ${e.message}` };
  }
  const p = manifests.find((m) => m.id === id);
  if (!p) return { ok: false, error: 'plugin no longer found' };
  if (p.error) return { ok: false, error: p.error };
  if (p.needsIntegrityApproval) return { ok: false, error: 'plugin needs integrity approval before it can be reloaded' };
  const disabledIds = (S.config.plugins && S.config.plugins.disabled) || [];
  if (disabledIds.includes(id)) return { ok: false, error: 'plugin is disabled' };

  const base = window.__isViewer ? '/plugins' : 'app://plugins';
  const bust = Date.now();

  if (p.style) {
    const existing = document.querySelector(`link[data-plugin-id="${CSS.escape(id)}"]`);
    if (existing) existing.remove();
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${base}/${encodeURIComponent(p.dir)}/${p.style}?t=${bust}`;
    link.dataset.pluginId = p.id;
    document.head.appendChild(link);
  }

  settingsSectionRegistry.delete(id);
  if (id.startsWith('theme-')) themePackRegistry.delete(id.slice('theme-'.length));

  const errors = [];
  for (const [kind, entry] of [['renderer', p.renderer], ['settings', p.settings]]) {
    if (!entry) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await import(/* webpackIgnore: true */ `${base}/${encodeURIComponent(p.dir)}/${entry}?t=${bust}`);
    } catch (e) {
      errors.push(`(${kind}) ${e.message}`);
    }
  }

  window.dispatchEvent(new Event('rcb:plugins-loaded'));
  reportInstalledThemes();
  return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true };
}

// A single user stylesheet, loaded dead last (appended to <head> after every
// built-in <link>/<style>, including plugin styles from loadPlugins() above)
// so anything in it wins the cascade without needing !important. Served over
// app://media the same way any other user-chosen file is (see main.js's
// path:toFileUrl) — reused rather than adding a new IPC round-trip.
const CUSTOM_CSS_LINK_ID = 'custom-css-override';

export async function applyCustomCss() {
  const existing = document.getElementById(CUSTOM_CSS_LINK_ID);
  const path = S.config.display && S.config.display.customCssPath;
  if (!path) {
    if (existing) existing.remove();
    return;
  }
  const href = await window.api.toFileUrl(path);
  let link = document.getElementById(CUSTOM_CSS_LINK_ID);
  if (!link) {
    link = document.createElement('link');
    link.id = CUSTOM_CSS_LINK_ID;
    link.rel = 'stylesheet';
    document.head.appendChild(link); // appended last — always after plugin <link>s above
  }
  // Cache-bust so re-choosing the *same* path after editing the file on disk
  // (a live "tweak and reload" workflow) actually re-fetches it instead of
  // reusing Chromium's cached response for an identical URL.
  link.href = `${href}${href.includes('?') ? '&' : '?'}t=${Date.now()}`;
}
