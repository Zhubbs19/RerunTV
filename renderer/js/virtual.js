import {
  guideBarFillEl, guideLogoEl, guideMuteEl, guideNameEl, guideNowEl, guideNumberEl,
  guideOverlay, noSignalEl, player, pluginChannelContainerEl,
} from './dom.js';
import { S } from './state.js';
import {
  getPluginChannelEntryForNumber, getPluginChannelOverride, getPluginChannelType, pluginChannelTypeIds,
} from './plugins.js';
import { autoHideAfter } from './util.js';
import { formatChannelNumber } from './channels.js';

// The plugin channel currently rendered into pluginChannelContainerEl (if
// any) — tracked here rather than on the DOM, since a plugin's stop() hook
// needs its own type id, not just "something was showing".
let activePluginChannelId = null;

// Delegates to plugins.js's shared lookup so a user-set channel-number
// override (Channel Setup's PLUGIN CHANNELS section) is honored everywhere
// a plugin channel's live number is asked about, not just here.
function pluginTypeForNumber(number) {
  const entry = getPluginChannelEntryForNumber(number);
  return entry ? { id: entry.id, def: entry.definition } : null;
}

// Finds whichever registered channel type both (a) declares the optional
// `viewerLink` capability (registerChannelType, plugins.js) and (b) is
// actually the live, active channel at its own number right now (installed,
// enabled, and not overridden by a real user channel at that number — same
// isVirtualChannel semantics as everywhere else). Exported so app.js's LAN
// viewer "watch live" link can ask "does ANY plugin currently want to offer
// one" without knowing or caring which plugin, or which channel number, that
// might be — see PLUGIN_DEVELOPMENT.md's registerChannelType section.
export function findLiveViewerLinkChannelType() {
  for (const id of pluginChannelTypeIds()) {
    const def = getPluginChannelType(id);
    if (def && def.viewerLink && isVirtualChannel(getPluginChannelOverride(id, def).number)) return def;
  }
  return null;
}

// Called from app.js's Enter/Space keydown handler — lets a plugin channel
// respond to the same OK-button gesture a remote sends, without app.js
// needing to special-case every plugin's channel number by hand. Returns
// whether a plugin actually
// handled it, so app.js's handler can fall through to its other Enter/Space
// behaviors (guide overlay, entry buffer, shuttle) when it didn't.
export function triggerVirtualChannelOk(number) {
  const plugin = pluginTypeForNumber(number);
  if (!plugin || typeof plugin.def.onOk !== 'function') return false;
  try {
    plugin.def.onOk(window.RCBPlugins.ctx);
  } catch (e) {
    console.error(`[plugin ${plugin.id}] onOk() threw`, e);
  }
  return true;
}

// Same generic dispatch as triggerVirtualChannelOk, but for every keydown
// rather than just Enter/Space — see plugins.js's registerChannelType doc
// comment for onKey's contract.
export function triggerVirtualChannelKey(number, key) {
  const plugin = pluginTypeForNumber(number);
  if (!plugin || typeof plugin.def.onKey !== 'function') return false;
  try {
    return !!plugin.def.onKey(key, window.RCBPlugins.ctx);
  } catch (e) {
    console.error(`[plugin ${plugin.id}] onKey() threw`, e);
    return false;
  }
}

// TV mode: a plugin channel that defines onAction(action, ctx) gets remote
// actions ('move.up', 'select', 'back'…) instead of keys (docs/design/01
// §6.6). Returns whether it handled the action; unhandled ones fall back to
// core (so move.up/down still change channel, back still asks to leave).
export function virtualChannelHandlesActions(number) {
  const plugin = pluginTypeForNumber(number);
  return !!(plugin && typeof plugin.def.onAction === 'function');
}

export function triggerVirtualChannelAction(number, action) {
  const plugin = pluginTypeForNumber(number);
  if (!plugin || typeof plugin.def.onAction !== 'function') return false;
  try {
    return !!plugin.def.onAction(action, window.RCBPlugins.ctx);
  } catch (e) {
    console.error(`[plugin ${plugin.id}] onAction() threw`, e);
    return false;
  }
}

// The time machine used to be refused outright on every plugin channel,
// because core has no schedule of its own to re-derive for one. A plugin
// that computes what it is playing as a pure function of a timestamp (the
// same property core's own schedule.js relies on) can support it perfectly
// well, so it opts in with `supportsTimeMachine: true` and core stops
// treating "not a real channel" as "cannot be time-shifted".
export function virtualChannelSupportsTimeMachine(number) {
  const plugin = pluginTypeForNumber(number);
  return !!(plugin && plugin.def.supportsTimeMachine);
}

// Optional companion to the flag above: what the VCR on-screen display
// should name as the current programme at the scrubbed instant. Core has no
// way to work that out for a plugin channel, so without this the OSD's
// programme line is simply blank.
export function virtualChannelTimeMachineText(number, nowMs) {
  const plugin = pluginTypeForNumber(number);
  if (!plugin || typeof plugin.def.timeMachineNowText !== 'function') return '';
  try {
    return plugin.def.timeMachineNowText(nowMs, window.RCBPlugins.ctx) || '';
  } catch (e) {
    console.error(`[plugin ${plugin.id}] timeMachineNowText() threw`, e);
    return '';
  }
}

export function virtualChannelNumbers() {
  const nums = [];
  const seen = new Set();
  pluginChannelTypeIds().forEach((id) => {
    const def = getPluginChannelType(id);
    if (!def || !Number.isInteger(def.number)) return;
    if (typeof def.enabled === 'function' && !def.enabled(window.RCBPlugins.ctx)) return;
    // A user-set number override (getPluginChannelOverride, plugins.js) wins
    // over the plugin's own authored default. If two plugin channels somehow
    // land on the same effective number (e.g. an override collides with
    // another plugin's default), first-registered wins rather than showing
    // the same guide slot twice.
    const n = getPluginChannelOverride(id, def).number;
    if (seen.has(n)) return;
    seen.add(n);
    nums.push(n);
  });

  // Real user media channels ALWAYS take 100% priority over system virtual channels!
  const realNums = new Set((S.config && S.config.channels ? S.config.channels : []).map((c) => c.number));
  return nums.filter((n) => !realNums.has(n));
}

export function isVirtualChannel(number) {
  if (S.config && S.config.channels && S.config.channels.some((c) => c.number === number)) {
    return false;
  }
  return virtualChannelNumbers().includes(number);
}

export function virtualChannelInfo(number) {
  const plugin = pluginTypeForNumber(number);
  if (plugin) {
    // nowText can be a static string or, for a channel whose "what's on"
    // blurb changes with runtime state, a function evaluated fresh on every
    // guide-overlay render.
    const nowText = typeof plugin.def.nowText === 'function' ? plugin.def.nowText() : (plugin.def.nowText || '');
    return { number, name: getPluginChannelOverride(plugin.id, plugin.def).name, nowText };
  }
  return { number, name: `CH ${number}`, nowText: '' };
}

export function hideVirtualChannels() {
  if (pluginChannelContainerEl) pluginChannelContainerEl.classList.add('hidden');
  if (activePluginChannelId) {
    const def = getPluginChannelType(activePluginChannelId);
    if (def && typeof def.stop === 'function') {
      // The same ctx render() gets (PLUGIN_DEVELOPMENT.md documents stop(ctx)),
      // plus the container older plugins read. Passing only { container } left
      // Music Choice's stop() throwing on ctx.player and its ended/error
      // listeners attached to the shared player after tuning away.
      try { def.stop({ ...window.RCBPlugins.ctx, container: pluginChannelContainerEl }); } catch (e) { console.error(`[plugin ${activePluginChannelId}] stop() threw`, e); }
    }
    activePluginChannelId = null;
    if (pluginChannelContainerEl) pluginChannelContainerEl.innerHTML = '';
  }
}

// Exported so core code that needs a color for a virtual channel (the
// channel-change static-burst tint, playback.js) can read it from whichever
// plugin registered that channel number instead of keeping its own
// hardcoded, easily-drifting copy — core stays plugin-agnostic, it just asks
// "whatever's registered at this number, what's its color" rather than
// knowing any specific plugin's identity or picking its own color for it.
export function getVirtualBadge(number) {
  const plugin = pluginTypeForNumber(number);
  if (plugin && plugin.def.badge) return plugin.def.badge;
  return { bg: '#3b82f6', label: String(number) };
}

export function showVirtualGuideOverlay(number) {
  const info = virtualChannelInfo(number);
  guideNumberEl.textContent = formatChannelNumber(number);
  guideNameEl.textContent = info.name;
  guideNowEl.textContent = `NOW: ${info.nowText}`;
  guideBarFillEl.style.width = '100%';

  if (guideLogoEl) {
    guideLogoEl.innerHTML = '';
    const badge = getVirtualBadge(number);
    guideLogoEl.style.background = badge.bg;
    guideLogoEl.textContent = badge.label;
    guideLogoEl.classList.remove('hidden');
  }

  guideMuteEl.classList.toggle('hidden', !player.muted);
  guideOverlay.classList.remove('hidden');
  const cardDuration = S.config.display?.guideCardDuration ?? 4000;
  S.guideHideTimer = autoHideAfter(S.guideHideTimer, cardDuration, () => guideOverlay.classList.add('hidden'));
}

export function showVirtualChannel(number) {
  player.pause();
  player.removeAttribute('src');
  player.loop = false;
  if (S.endedHandler) { player.removeEventListener('ended', S.endedHandler); S.endedHandler = null; }
  if (S.errorHandler) { player.removeEventListener('error', S.errorHandler); S.errorHandler = null; }
  noSignalEl.classList.add('hidden');
  hideVirtualChannels();

  const plugin = pluginTypeForNumber(number);
  if (plugin) {
    activePluginChannelId = plugin.id;
    pluginChannelContainerEl.innerHTML = '';
    try {
      plugin.def.render(pluginChannelContainerEl, window.RCBPlugins.ctx);
    } catch (e) {
      console.error(`[plugin ${plugin.id}] render() threw`, e);
    }
    // Most plugin channels render their content INTO the container we just
    // handed them, so it needs to be visible. A few (party-channel is the
    // one today — see its renderer.js file header comment) deliberately
    // ignore the container and reveal their own pre-existing DOM elsewhere
    // instead. Leaving the container itself un-hidden for those left an
    // empty, opaque, full-screen div (.plugin-channel-container, z-index 5
    // — overlays.css) sitting ON TOP of that channel's real content
    // (z-index 4), painting over it entirely — a real "black screen" bug
    // found live. Only reveal the container when render() actually put
    // something in it.
    if (pluginChannelContainerEl.innerHTML.trim()) {
      pluginChannelContainerEl.classList.remove('hidden');
    }
  }

  showVirtualGuideOverlay(number);
}
