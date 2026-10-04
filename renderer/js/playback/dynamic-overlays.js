// User-defined animated overlays (image or video) shown on a schedule/break
// trigger — box-wide default rules (S.config.display.dynamicOverlays) or a
// per-channel override list (ch.dynamicOverlays, null = inherit box-wide),
// same convention as logoBugProfiles (channels.js). One overlay slot at a
// time: the first rule in the effective list matching the fired trigger
// wins: see [[dynamic_overlays_rule_shape]] in channels.js's
// normalizeDynamicOverlays comment.
import { DEFAULT_OVERLAY_DURATION_MS, isVideoMediaPath } from '../core/channels.js';
import { crtContainer, dynamicOverlayEl } from '../core/dom.js';
import { effectiveContentTags } from '../core/interstitials.js';
import { computeLivePosition } from '../core/schedule.js';
import { S } from '../core/state.js';

const CORNER_STYLE = {
  'top-left': { top: '4%', left: '4%', right: 'auto', bottom: 'auto', transform: 'none' },
  'top-right': { top: '4%', right: '4%', left: 'auto', bottom: 'auto', transform: 'none' },
  'bottom-left': { bottom: '4%', left: '4%', top: 'auto', right: 'auto', transform: 'none' },
  'bottom-right': { bottom: '4%', right: '4%', top: 'auto', left: 'auto', transform: 'none' },
  center: { top: '50%', left: '50%', right: 'auto', bottom: 'auto', transform: 'translate(-50%, -50%)' },
  // Overrides the --dynamic-overlay-size-driven square sizing (overlays.css)
  // with explicit width/height — the generic style-prop loop in
  // triggerDynamicOverlays below applies whatever keys are present here, so
  // this is the only change needed to support a full-screen custom overlay
  // (e.g. a user-supplied movie rating card image/video) alongside the
  // corner-bug-sized presets above.
  fullscreen: { top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%', transform: 'none' },
};

// Break-type triggers (see DYNAMIC_OVERLAY_TRIGGERS, channels.js) — an
// overlay shown for one of these stays up until clearDynamicOverlaysForBreak
// fires (rule.durationMs === 0, the "auto" default for these) instead of a
// fixed timer, so it naturally tracks however long the actual break runs.
const BREAK_TRIGGERS = new Set(['commercial', 'upNext', 'channelId', 'trivia']);

let hideTimer = null;
let activeTrigger = null;

function effectiveDynamicOverlays(ch) {
  return (ch && ch.dynamicOverlays) || (S.config.display && S.config.display.dynamicOverlays) || [];
}

export function hideDynamicOverlay() {
  clearTimeout(hideTimer);
  hideTimer = null;
  activeTrigger = null;
  dynamicOverlayEl.classList.add('hidden');
  dynamicOverlayEl.innerHTML = '';
}

// Called on every break-end (endBreak, playback.js) — only actually hides
// the overlay if what's showing was shown FOR a break, so an unrelated
// tuneIn/contentStart overlay mid-way through its own auto-hide timer isn't
// cut short by a break elsewhere ending.
export function clearDynamicOverlaysForBreak() {
  if (activeTrigger && BREAK_TRIGGERS.has(activeTrigger)) hideDynamicOverlay();
}

// Content the rule's own contentTags (if any) must overlap — same "unset/
// empty = eligible for anything, otherwise must share at least one tag"
// convention resolveBreakAt (interstitials.js) already uses for ad
// targeting. Computed from the channel's OWN currently-airing file, same
// (ch, computeLivePosition) pairing setup-aircheck.js's preview simulator
// uses, so a rule scoped to e.g. "holiday" only fires while holiday-tagged
// content is actually on screen, regardless of which moment (trigger)
// happens to line up with it.
function ruleMatchesCurrentContent(ch, rule) {
  if (!rule.contentTags || !rule.contentTags.length) return true;
  const pos = computeLivePosition(ch);
  const fileTags = effectiveContentTags(ch, pos && pos.file);
  return fileTags.length > 0 && rule.contentTags.some((t) => fileTags.includes(t));
}

// Returns true when a matching custom-media rule was actually found and
// shown, false otherwise — callers that have their own built-in fallback
// rendering (e.g. flashRatingBug/showMovieRatingCard, playback.js) use this
// to know whether they still need to render that fallback themselves.
// Overlay sizes are in pixels set on one screen, so they are scaled by the
// screen's height against the "sizes were set on" height (DISPLAY › Logo bug,
// shared with the logo bug), the same as the bug itself. 0 there means fixed.
function overlayScale() {
  const display = S.config.display || {};
  const setting = display.logoBugReferenceHeight;
  if (setting === 0) return 1;
  const h = crtContainer.clientHeight;
  return h > 0 ? Math.min(4, Math.max(0.25, h / (Number(setting) || Number(display.logoBugAuthoredHeight) || 1080))) : 1;
}

export function triggerDynamicOverlays(ch, trigger) {
  const rule = effectiveDynamicOverlays(ch).find((r) => r.trigger === trigger && r.mediaPath && ruleMatchesCurrentContent(ch, r));
  if (!rule) return false;
  clearTimeout(hideTimer);
  hideTimer = null;
  activeTrigger = trigger;
  dynamicOverlayEl.innerHTML = '';
  dynamicOverlayEl.style.setProperty('--dynamic-overlay-size', `${Math.round(rule.size * overlayScale())}px`);
  // 'custom' is drag-placed (x/y percentages) rather than one of
  // CORNER_STYLE's fixed presets — everything CORNER_STYLE would normally
  // set (right/bottom/transform) is cleared explicitly first since a
  // PREVIOUS rule's corner styling could otherwise linger on this shared
  // element (e.g. a 'center' rule's translate transform bleeding into a
  // custom-positioned one right after it).
  if (rule.corner === 'custom' && Number.isFinite(rule.x) && Number.isFinite(rule.y)) {
    Object.assign(dynamicOverlayEl.style, {
      // Clamp against the live frame, not merely 0..100 in config: an
      // imported x=100 rule or a later size increase must never leave part
      // of the overlay outside the visible picture.
      top: `clamp(0px, ${rule.y}%, calc(100% - var(--dynamic-overlay-size)))`,
      left: `clamp(0px, ${rule.x}%, calc(100% - var(--dynamic-overlay-size)))`,
      right: 'auto', bottom: 'auto', transform: 'none', width: '', height: '',
    });
  } else {
    Object.assign(dynamicOverlayEl.style, { width: '', height: '' });
    Object.entries(CORNER_STYLE[rule.corner] || CORNER_STYLE['bottom-right']).forEach(([prop, value]) => {
      dynamicOverlayEl.style[prop] = value;
    });
  }

  const isVideo = isVideoMediaPath(rule.mediaPath);
  const media = document.createElement(isVideo ? 'video' : 'img');
  if (isVideo) {
    media.muted = true;
    media.loop = true;
    media.autoplay = true;
    media.playsInline = true;
  }
  window.api.toFileUrl(rule.mediaPath).then((url) => {
    media.src = url;
    if (isVideo) media.play().catch(() => {});
  });
  dynamicOverlayEl.appendChild(media);
  dynamicOverlayEl.classList.remove('hidden');
  // Force a reflow so a rapid re-trigger of the same corner/entrance
  // animation replays instead of the browser coalescing it away — same
  // trick attachSliderReadout's pulse uses (setup-util.js).
  dynamicOverlayEl.classList.remove('show');
  void dynamicOverlayEl.offsetWidth;
  dynamicOverlayEl.classList.add('show');

  if (!BREAK_TRIGGERS.has(trigger)) {
    const durationMs = rule.durationMs || DEFAULT_OVERLAY_DURATION_MS;
    hideTimer = setTimeout(hideDynamicOverlay, durationMs);
  } else if (rule.durationMs) {
    // A break rule can still opt into a fixed duration shorter than the
    // break itself (e.g. flash a bug for the first 5s of a commercial break
    // rather than the whole thing).
    hideTimer = setTimeout(hideDynamicOverlay, rule.durationMs);
  }
  return true;
}
