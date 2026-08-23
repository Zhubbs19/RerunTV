// Renderer-side plugin loading — the other half of main-plugins.js.
//
// At boot (see loadPlugins(), called once from app.js's init()):
//   1. Fetch the manifest list from the main process (window.api.pluginsList).
//   2. For each enabled plugin with a `style`, inject a <link> that loads it
//      from app://plugins/<dir>/<style> — same custom-protocol trick the app
//      itself is served over (see main-protocol.js), needed because a
//      non-file:// origin can't load file:// stylesheets.
//   3. For each enabled plugin with a `renderer` entry, dynamic-import it as
//      an ES module from the same app://plugins/ origin. The module runs
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
//                                 // continue.
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
import { alertDialog } from './setup-dialogs.js';
import { MONTHS, S, WEEKDAYS, saveConfigDebounced, viewNow } from './state.js';
import { formatClock, formatSlotLabel, getDisplayTitle } from './util.js';
import { player } from './dom.js';

const channelTypeRegistry = new Map();
const settingsPanelRegistry = new Map();
const mediaSourcePickerRegistry = new Map();
const themePackRegistry = new Map();
const interruptRegistry = new Map();
const tuneGateRegistry = new Map();
const overlayAudioRegistry = new Map();
const titleRowActionRegistry = new Map();
const coreHookRegistry = new Map(); // event name -> Set<fn>
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
    .map(([themeId, def]) => ({ id: themeId, label: def.label, group: def.group || 'OTHER' }));
  if (!themePackRegistry.has('digital-2000s')) {
    entries.unshift({ id: 'digital-2000s', label: 'DIGITAL CABLE (MID 2000s BLUE)', group: 'ERA (BY DECADE)' });
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

function installGlobalApi() {
  window.RCBPlugins = {
    registerChannelType,
    registerSettingsPanel,
    registerMediaSourcePicker,
    registerThemePack,
    getThemePack,
    registerInterrupt,
    getInterrupt,
    registerTuneGate,
    registerOverlayAudioSource,
    registerTitleRowAction,
    registerCoreHook,
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
      S, viewNow, player, playTone, playNoiseBurst, getAudioCtx,
      sortedChannels, buildChannelBadge, getChannel, getChannelSchedule, getDisplayTitle, formatSlotLabel, saveConfigDebounced,
      addFilesToChannel, addInterstitialPoolEntry, formatClock, WEEKDAYS, MONTHS,
    },
    // Read-only escape hatch for plugins that need something not covered by
    // registerChannelType/registerSettingsPanel yet — kept intentionally
    // tiny for v1 rather than exposing internal app state wholesale.
    version: 1,
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
    if (p.error) { loadErrors.push({ id: p.dir, name: p.dir, error: p.error }); return; }
    if (isDisabled(p)) return;
    if (p.loadError) { loadErrors.push({ id: p.id, name: p.name, error: `(main process) ${p.loadError}` }); return; }
    if (p.style) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `app://plugins/${encodeURIComponent(p.dir)}/${p.style}`;
      link.dataset.pluginId = p.id;
      document.head.appendChild(link);
    }
  });

  // Renderer entries are imported sequentially (not Promise.all) so one
  // plugin's top-level throw can't interleave with another's registration
  // calls in a confusing order — plugin count is small enough that this
  // isn't a meaningful boot-time cost.
  for (const p of manifests) {
    if (p.error || p.loadError || !p.renderer || isDisabled(p)) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await import(/* webpackIgnore: true */ `app://plugins/${encodeURIComponent(p.dir)}/${p.renderer}`);
    } catch (e) {
      loadErrors.push({ id: p.id, name: p.name, error: e.message });
    }
  }

  if (loadErrors.length) {
    const lines = loadErrors.map((e) => `${e.name}: ${e.error}`).join('\n');
    alertDialog(`${loadErrors.length} plugin${loadErrors.length === 1 ? '' : 's'} failed to load:\n\n${lines}`, { variant: 'error', title: 'PLUGIN ERROR' });
  }
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
