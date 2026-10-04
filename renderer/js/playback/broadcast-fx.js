// Static/no-signal rendering, end-credits speedup, and every on-screen bug
// overlay — the box's "look and feel" layer, as distinct from what decides
// content should be playing (playback-core.js) or when a break should be on
// screen (playback-breaks.js). Covers: the NO SIGNAL/COMING SOON/SIGN-OFF/
// BLOCKED cards (showNoSignal and friends), the tuning static burst and its
// one-shot local-avail glitch variant, the syndication-style credits
// squeeze/speedup, the logo bug (placement, motion preset, and its burn-in
// ghost), and the corner/full-screen bug cards (rating, movie-rating,
// episode-status, format-disclaimer, content-advisory, capability badge).
// Split out of the former monolithic playback.js alongside playback-core.js
// (tune/source resolution) and playback-breaks.js (the ad-break state
// machine) — see those files' own header comments.
import { playConfiguredSound, sfxChannelChange, startHoldMusicLoop, stopHoldMusicLoop } from '../core/audio.js';
import {
  channelColor, getChannel, isVideoMediaPath, logoBugProfileDimensions, LOGO_MOTION_PRESETS,
  pickLogoBugProfile, resolveEffectiveIcon,
} from '../core/channels.js';
import {
  crtContainer, capabilityBadgeEl, contentAdvisoryCardEl, creditsSqueezeChannelEl, creditsSqueezePanelEl,
  creditsSqueezeTitleEl, creditsSqueezeVideoEl, episodeStatusBugEl, formatDisclaimerCardEl, logoBugEl,
  logoBugGhostEl, movieRatingCardEl, noSignalChannelEl, noSignalEl, noSignalMainEl, player, ratingBugEl,
  staticCanvas, staticCtx,
} from '../core/dom.js';
import { resolveContentDisplayMode, resolveEffectiveDisplayMode } from '../display/mode.js';
import { applyMuteState, applyVolume } from './power.js';
import { getThemePack } from '../plugin/host.js';
import { pickDeterministic, poolFor } from '../core/interstitials.js';
import { S, viewNow } from '../core/state.js';
import { autoHideAfter, formatHourLabel, getDisplayTitle } from '../core/util.js';
import { channelIdentity, effectiveThemeId } from '../display/identity.js';
import { computeNextTitle } from './breaks.js';

// variant: undefined (neutral/no signal), 'error', or 'transcoding' — maps
// to the matching .no-signal-main.is-* color in styles.css.
export function showNoSignal(main, sub, variant) {
  noSignalMainEl.textContent = main;
  noSignalMainEl.className = 'no-signal-main' + (variant ? ` is-${variant}` : '');
  noSignalChannelEl.textContent = sub;
  noSignalEl.classList.remove('hidden');
  // 'offair' is the persistent technical-difficulties state (3+ failed
  // retries, playback.js's handleUnplayable) — real dead-air broadcasts
  // played hold music during it. Any other variant (comingsoon/nosignal/
  // signoff/error/transcoding) stops it, same as hideNoSignal below, in
  // case a call transitions directly between variants without going
  // through a hide first.
  if (variant === 'offair') startHoldMusicLoop();
  else stopHoldMusicLoop();
}

// Shared hide path for noSignalEl so hold music always stops alongside it —
// see showNoSignal's 'offair' comment above.
export function hideNoSignal() {
  noSignalEl.classList.add('hidden');
  stopHoldMusicLoop();
}

function configuredNoSignalText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveNoSignalCopy(number, identity, fallbackTitle, fallbackMessage) {
  const display = S.config.display || {};
  const title = configuredNoSignalText(identity?.noSignalTitle)
    || configuredNoSignalText(display.noSignalTitle)
    || fallbackTitle;
  const template = configuredNoSignalText(identity?.noSignalMessage)
    || configuredNoSignalText(display.noSignalMessage)
    || fallbackMessage;
  return {
    title,
    message: template.replaceAll('{channel}', String(number)),
  };
}

export function channelNoSignalCopy(channel, fallbackTitle, fallbackMessage) {
  return resolveNoSignalCopy(channel.number, channel.broadcastIdentity, fallbackTitle, fallbackMessage);
}

export function genericNoSignalCopy(number) {
  return resolveNoSignalCopy(number, null, 'NO SIGNAL', 'CH {channel}');
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

// intensity (0-100, from S.config.staticEffect.intensity) scales peak opacity.
// tintHex (optional, from the active block's theme.staticTint) blends noise
// toward that color instead of flat grayscale. durationMs controls how quickly
// the static fades IN (the "TUNING TIME" slider) — the effect then holds at
// peak until markStaticReady() fires (first decoded video frame), then fades
// out, so the screen is never black between channels.
//
// Was 3000ms — a slow-loading file (network drive, cold disk cache, a large
// library) would hold the screen at peak static for up to an extra 3s beyond
// the configured tuning time before giving up, which read as "channel
// switching got slower" even though nothing about the tune itself changed.
// Still generous enough to cover normal disk-read variance without forcing a
// release mid-decode.
const STATIC_MAX_HOLD_MS = 1200;
const STATIC_RELEASE_FADE_MS = 300;
// The release phase also brightens #player up from this dim starting point
// to fully lit, in step with static dissolving away — without it, static
// simply peels back off an already-fully-bright picture, which reads as an
// abrupt cut rather than a signal "coming in." Not applied during the
// fade-in/hold phases so a partial static intensity setting still shows its
// intended blend of live picture underneath, same as before.
const PLAYER_REVEAL_START_OPACITY = 0.2;
let staticReady = true;

export function markStaticReady() {
  staticReady = true;
}

// Static animation: fade IN from 0→peak over durationMs (signal locking in),
// hold at peak until markStaticReady() fires (first decoded video frame),
// then fade OUT over STATIC_RELEASE_FADE_MS while the picture underneath
// brightens up in sync — dissolving into the show like a signal locking in,
// not a hard cut. This keeps the screen covered with static — never black —
// from the instant the channel changes until the video is actually ready to
// be seen.
// Per-theme channel-change look — same fade-in/hold/release timing and
// canvas element as the default random-noise burst below, just a different
// per-frame pixel fill (registerThemePack's `staticStyle` field,
// plugins.js) so each era's "something's happening while it tunes" moment
// reads differently, not only its colors. A color-only pack simply omits
// it — their static behavior stays the plain default 'noise' burst.
// One-shot local-ad-insertion glitch (startBreak's localAvail branch above)
// — a brief noise flash on the same staticCanvas/staticCtx showStaticBurst
// uses, but a plain fixed-duration blip rather than that function's whole
// fade-in/hold-for-a-decoded-frame/fade-out state machine, since there's no
// player reveal to gate on here (nothing plays on `player` for localAvail).
const LOCAL_AVAIL_GLITCH_MS = 150;
export function flashLocalAvailCut() {
  staticCanvas.width = staticCanvas.clientWidth;
  staticCanvas.height = staticCanvas.clientHeight;
  if (staticCanvas.width < 1 || staticCanvas.height < 1) return;
  const w = staticCanvas.width;
  const h = staticCanvas.height;
  const imgData = staticCtx.createImageData(w, h);
  const buf = imgData.data;
  for (let i = 0; i < buf.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
  }
  staticCtx.putImageData(imgData, 0, 0);
  staticCanvas.style.opacity = '0.9';
  setTimeout(() => { staticCanvas.style.opacity = '0'; }, LOCAL_AVAIL_GLITCH_MS);
}

export function showStaticBurst(durationMs, tintHex) {
  sfxChannelChange();
  staticCanvas.width = staticCanvas.clientWidth;
  staticCanvas.height = staticCanvas.clientHeight;
  // A minimized window, a hidden audit surface, or a theme transition can
  // briefly leave the canvas with no layout box. createImageData(0, 0)
  // throws and used to turn an otherwise harmless hidden tuning burst into
  // an uncaught renderer error. There is nothing visible to animate in this
  // state, so finish the burst immediately and let the next real tune draw
  // once the TV surface has dimensions again.
  if (staticCanvas.width < 1 || staticCanvas.height < 1) {
    staticReady = true;
    staticCanvas.style.opacity = '0';
    player.style.opacity = '';
    return;
  }
  const se = S.config.staticEffect;
  let peakOpacity = (se && se.intensity != null ? se.intensity : 100) / 100;
  const tint = hexToRgb(tintHex);
  const identity = channelIdentity(S.config, S.currentNumber);
  const pack = getThemePack(effectiveThemeId(S.config, S.currentNumber));
  const staticStyle = (identity && identity.staticStyle) || (pack && pack.staticStyle) || 'noise';
  // Network broadcast didn't cut to visible tuning noise between its own
  // channels the way cable/UHF did — a quick, low-opacity blip instead of a
  // full static burst.
  if (staticStyle === 'quiet') peakOpacity *= 0.3;
  let rollOffset = 0;

  staticReady = false;
  // Reset in case a previous burst was interrupted mid-release (rapid
  // channel surfing) and left the player dimmed partway through its brighten-up.
  player.style.opacity = '';
  const start = performance.now();
  let releaseStart = null;

  function draw(now) {
    const elapsed = now - start;
    let currentOpacity;
    let finished = false;

    if (releaseStart !== null) {
      // Phase 3 — fade out: peak→0 over STATIC_RELEASE_FADE_MS, while the
      // picture brightens dim→full in lockstep.
      const releaseProgress = Math.min(1, (now - releaseStart) / STATIC_RELEASE_FADE_MS);
      currentOpacity = peakOpacity * (1 - releaseProgress);
      player.style.opacity = String(PLAYER_REVEAL_START_OPACITY + (1 - PLAYER_REVEAL_START_OPACITY) * releaseProgress);
      if (releaseProgress >= 1) finished = true;
    } else if (staticReady) {
      // Phase 2 — frame decoded (or cap hit), begin release fade
      releaseStart = now;
      currentOpacity = peakOpacity;
      player.style.opacity = String(PLAYER_REVEAL_START_OPACITY);
    } else {
      // Phase 1 — fade in 0→peak over durationMs, then hold at peak
      // until the video is ready. Cap: force release after STATIC_MAX_HOLD_MS
      // beyond the fade-in so a broken tune doesn't hold forever.
      const fadeInProgress = Math.min(1, elapsed / Math.max(1, durationMs));
      // Ease-in-out (smoothstep) so it ramps up like a signal locking in
      const eased = fadeInProgress * fadeInProgress * (3 - 2 * fadeInProgress);
      currentOpacity = peakOpacity * eased;
      // If we've been holding well past durationMs with no ready signal, force release
      if (elapsed > durationMs + STATIC_MAX_HOLD_MS) {
        releaseStart = now;
      }
    }

    if (!finished) {
      staticCanvas.style.opacity = String(currentOpacity);
      const w = staticCanvas.width, h = staticCanvas.height;

      if (staticStyle === 'acquire') {
        // Digital-satellite: no snow at all — a near-black field with a
        // bright horizontal band sweeping downward (searching for a lock)
        // and a text readout, instead of the analog eras' noise.
        staticCtx.fillStyle = '#01050d';
        staticCtx.fillRect(0, 0, w, h);
        rollOffset = (rollOffset + h * 0.025) % (h + 80);
        const grad = staticCtx.createLinearGradient(0, rollOffset - 40, 0, rollOffset + 40);
        grad.addColorStop(0, 'rgba(0,191,255,0)');
        grad.addColorStop(0.5, 'rgba(0,191,255,0.85)');
        grad.addColorStop(1, 'rgba(0,191,255,0)');
        staticCtx.fillStyle = grad;
        staticCtx.fillRect(0, rollOffset - 40, w, 80);
        staticCtx.fillStyle = 'rgba(160,225,255,0.9)';
        staticCtx.font = `${Math.max(12, Math.round(h * 0.045))}px monospace`;
        staticCtx.textAlign = 'center';
        staticCtx.textBaseline = 'middle';
        staticCtx.fillText('ACQUIRING SIGNAL…', w / 2, h / 2);
      } else {
        const imgData = staticCtx.createImageData(w, h);
        const buf = imgData.data;
        if (staticStyle === 'roll') rollOffset = (rollOffset + 2) % h;
        for (let i = 0; i < buf.length; i += 4) {
          let v = Math.random() * 255 | 0;
          if (staticStyle === 'roll') {
            const y = Math.floor((i / 4) / w);
            const band = Math.sin(((y + rollOffset) / h) * Math.PI * 6);
            v = Math.min(255, Math.max(0, v * 0.55 + (band > 0.6 ? 140 : 0)));
          }
          if (tint) {
            buf[i] = (v + tint[0]) / 2; buf[i + 1] = (v + tint[1]) / 2; buf[i + 2] = (v + tint[2]) / 2;
          } else {
            buf[i] = v; buf[i + 1] = v; buf[i + 2] = v;
          }
          buf[i + 3] = 255;
        }
        staticCtx.putImageData(imgData, 0, 0);
        if (staticStyle === 'tear') {
          // A few short horizontal bands redrawn with a slight x-offset —
          // the "bad tracking" look of a signal that can't quite hold.
          for (let b = 0; b < 3; b++) {
            const bandY = Math.floor(Math.random() * h);
            const bandH = 2 + Math.floor(Math.random() * 6);
            const xShift = (Math.random() * 30 - 15) | 0;
            staticCtx.drawImage(staticCanvas, 0, bandY, w, bandH, xShift, bandY, w, bandH);
          }
        }
      }
      S.staticRAF = requestAnimationFrame(draw);
    } else {
      staticCanvas.style.opacity = '0';
      // Clear the inline opacity this burst set — an inline style outlives
      // this burst and would otherwise out-rank .screen-fade-out's CSS rule
      // (used for break-bumper transitions) on every tune after this one.
      player.style.opacity = '';
      if (S.staticRAF) cancelAnimationFrame(S.staticRAF);
    }
  }
  if (S.staticRAF) cancelAnimationFrame(S.staticRAF);
  S.staticRAF = requestAnimationFrame(draw);
}

// Persistent off-air card shown outside a channel's broadcastHours window —
// distinct copy from the generic NO SIGNAL/COMING SOON cards so it reads as
// "this channel is fine, it's just not on right now" rather than broken.
export function showSignOffCard(ch) {
  const returns = formatHourLabel(ch.broadcastHours.startHour);
  showNoSignal('SIGN-OFF', `CH ${ch.number}${ch.name ? ' — ' + ch.name.toUpperCase() : ''} — RETURNS AT ${returns}`, 'signoff');
}

// A deliberately blocked channel (ch.notSubscribed) — reads as a billing
// message, not a failure, so it gets its own copy and CSS variant distinct
// from both the technical OFF THE AIR card and the scheduled SIGN-OFF card.
export function showBlockedCard(ch) {
  showNoSignal('CHANNEL NOT AVAILABLE', `CH ${ch.number}${ch.name ? ' — ' + ch.name.toUpperCase() : ''} — PLEASE CALL YOUR CABLE COMPANY TO SUBSCRIBE`, 'blocked');
}

export function cancelCreditsSpeedup() {
  clearTimeout(S.creditsSpeedupTimer);
  S.creditsSpeedupTimer = null;
}

// Undoes whatever startCreditsSpeedup below changed, WITHOUT crediting any
// time to S.contentLostMs — used when the sped-up file is interrupted
// (tune-away, power-off) rather than allowed to run to its own natural
// 'ended'. An interrupted speedup has no well-defined "how much did we
// actually save," so this just restores normal playback/audio state and
// leaves the schedule to read as very slightly behind until the next
// natural boundary reconciles it — the same class of harmless drift breaks
// already cause elsewhere.
export function resetCreditsSpeedup() {
  cancelCreditsSpeedup();
  if (!S.creditsSpeedupActive) return;
  player.playbackRate = 1;
  player.muted = S.creditsSpeedupPrevMuted;
  S.creditsSpeedupActive = false;
  creditsSqueezePanelEl.classList.add('hidden');
  creditsSqueezePanelEl.classList.remove('video-mode');
  document.querySelector('.crt')?.classList.remove('credits-squeeze');
  // Video mode only: stop the promo and release its decode handle rather
  // than leaving it paused mid-file — it gets a fresh pick next time
  // (startCreditsSpeedup below), not resumed from where it left off.
  if (!creditsSqueezeVideoEl.paused) creditsSqueezeVideoEl.pause();
  creditsSqueezeVideoEl.removeAttribute('src');
  creditsSqueezeVideoEl.load();
}

// Old syndicated stations routinely fast-forwarded a movie's end credits to
// hit a hard time slot. `leadS` (seconds-before-file-end where credits
// begin) resolves per-file first (file.creditsLeadS — 0 explicitly opts a
// single file out even when the channel default is on), else the channel's
// own default when ch.creditsSpeedup.enabled. Armed the same one-shot way
// scheduleUpNextBar is (once per tune/file-load, not a continuous poll) —
// a sibling timer, not sharing that one's slot, since both can be armed for
// the same file at once.
export function scheduleCreditsSpeedup(ch, pos) {
  cancelCreditsSpeedup();
  const file = pos.file;
  const cfg = ch.creditsSpeedup;
  const leadS = file.creditsLeadS != null ? file.creditsLeadS : (cfg && cfg.enabled ? cfg.leadSeconds : null);
  if (!leadS) return;
  const remainingMs = (file.duration - pos.offset) * 1000;
  if (remainingMs <= leadS * 1000) return;
  const rate = (cfg && cfg.rate) || 3;
  S.creditsSpeedupTimer = setTimeout(() => {
    if (S.currentNumber !== ch.number || !S.isPoweredOn) return;
    startCreditsSpeedup(ch, file, rate, leadS);
  }, remainingMs - leadS * 1000);
}

// Exported (alongside the timer-arming/reset functions above) so both real
// call sites and tests can invoke start/finish directly without needing to
// wait out a real setTimeout — see tests/ui/verify-credits-speedup.mjs.
export function startCreditsSpeedup(ch, file, rate, leadS) {
  S.creditsSpeedupPrevMuted = player.muted;
  player.muted = true;
  player.playbackRate = rate;
  S.creditsSpeedupActive = true;
  S.creditsSpeedupRealStartMs = viewNow();
  // What the pure schedule (which always assumes normal speed) still thinks
  // is left in this file — compared against real elapsed time once the
  // video actually ends, in finishCreditsSpeedupIfActive below, to credit
  // exactly the difference back to S.contentLostMs.
  S.creditsSpeedupScheduledRemainingMs = leadS * 1000;

  const bgImage = file.creditsSqueezeBgImage || (ch.creditsSpeedup && ch.creditsSpeedup.squeezeBgImage);
  if (bgImage) {
    window.api.toFileUrl(bgImage).then((url) => {
      if (S.creditsSpeedupActive) creditsSqueezePanelEl.style.setProperty('--credits-squeeze-bg', `url("${url}")`);
    });
  } else {
    // No custom backdrop set at either level — fall back to a plain card
    // tinted with the channel's own accent color rather than a blank panel,
    // same "zero-config still looks intentional" idea channelColor already
    // serves elsewhere (guide row theming, etc.).
    creditsSqueezePanelEl.style.setProperty('--credits-squeeze-bg', `linear-gradient(160deg, ${channelColor(ch.number)}33, var(--ink-deep, #080b12))`);
  }
  creditsSqueezeChannelEl.textContent = (ch.name || `CHANNEL ${ch.number}`).toUpperCase();
  creditsSqueezeTitleEl.textContent = computeNextTitle(ch);

  // VIDEO mode: a real, audible upNext-pool promo fills the panel instead
  // of the text trio above. Reuses the exact same pool-resolution machinery
  // every other bumper uses (poolFor/pickDeterministic, interstitials.js) —
  // seeded by the airing file's own path so the same movie always shows the
  // same promo, rotating naturally as different movies air. Falls back to
  // the text card (already populated above) when nothing eligible resolves
  // or the entry has no real file — never a blank panel.
  let usedVideoMode = false;
  if (ch.creditsSpeedup && ch.creditsSpeedup.squeezeMode === 'video') {
    const pool = (S.config.interstitials && S.config.interstitials.pool) || [];
    const candidates = poolFor(pool, 'upNext', ch, null, file.tags || []);
    const promoEntry = candidates.length ? pickDeterministic(candidates, `creditsSqueeze:${ch.number}:${file.path}`, 0) : null;
    if (promoEntry && promoEntry.file) {
      usedVideoMode = true;
      window.api.resolvePlayablePath(promoEntry.file.source || 'local', promoEntry.file.path).then((resolved) => window.api.toFileUrl(resolved.path)).then((url) => {
        if (!S.creditsSpeedupActive) return; // interrupted while the IPC round-trip was in flight
        creditsSqueezeVideoEl.loop = true;
        creditsSqueezeVideoEl.src = url;
        applyVolume();
        applyMuteState(); // respects the box's current mute state, doesn't force-unmute
        creditsSqueezeVideoEl.play().catch(() => {});
      }).catch(() => {});
    }
  }
  creditsSqueezePanelEl.classList.toggle('video-mode', usedVideoMode);

  document.querySelector('.crt')?.classList.add('credits-squeeze');
  creditsSqueezePanelEl.classList.remove('hidden');
}

// Called from handleContentEnded, BEFORE it checks for the next break/file —
// if a speedup was actually running for the file that just ended naturally,
// credit the time it saved back to S.contentLostMs (the same accumulator
// breaks use to credit time LOST, just the opposite sign — see this file's
// top-of-function comments on computeLiveContentPosition) so the live-tuned
// channel's position catches back up to what the pure schedule says should
// be airing next, then restores normal playback/audio + the squeeze visual.
export function finishCreditsSpeedupIfActive() {
  if (!S.creditsSpeedupActive) return;
  const realElapsedMs = viewNow() - S.creditsSpeedupRealStartMs;
  const creditMs = S.creditsSpeedupScheduledRemainingMs - realElapsedMs;
  S.contentLostMs -= creditMs;
  resetCreditsSpeedup();
}

// Fallback used only if a config somehow has no profiles at all (shouldn't
// happen once foldLogoBugCorner has run — see channels.js/app.js migration
// — but keeps this function total rather than placing at 0,0/size 0 on a
// malformed config).
const FALLBACK_LOGO_BUG_PROFILE = { x: 94, y: 90, size: 46 };

// The profiles a channel actually draws from — its own override array if it
// has one, else the box-wide default (S.config.display.logoBugProfiles).
function activeLogoBugProfiles(ch) {
  return (ch && ch.logoBugProfiles) || (S.config.display && S.config.display.logoBugProfiles) || [];
}

// The profile set is matched against the content's aspect and resolution, so
// a 4:3 or SD file can land on a differently sized profile (or the 46px
// default) than the 16:9 one next to it. "Same bug size for all content"
// (default on) always matches the 16:9 native profile instead, so the bug
// is one size whatever is playing; the picture-anchored position still
// follows the content.
const REFERENCE_LOGO_BUG_CONTEXT = { aspect: '16:9', resolution: 'native' };

function activeLogoBugContext() {
  if (!(S.config.display && S.config.display.logoBugVaryWithContent)) return REFERENCE_LOGO_BUG_CONTEXT;
  return S.config.display && S.config.display.logoBugAutoAdjust
    ? resolveContentDisplayMode()
    : resolveEffectiveDisplayMode();
}

// Keep a pixel-sized profile wholly inside the current TV canvas. Interface
// zoom and simulated-resolution zoom can make the canvas smaller in CSS px
// while leaving a profile's stored dimensions unchanged; a raw `left: 94%`
// can then put part of the bug past the right/bottom edge. CSS min()/clamp()
// keep the stored placement responsive without rewriting the user's profile.
// Bug sizes are stored in screen pixels, so the same number is half the
// relative size on a 4K screen as on 1080p. Scale by the screen's height
// against the height the profile was set on: its own stamp (the live editor
// writes one), else DISPLAY › Logo bug › "Sizes were set on". 0 = off.
const DEFAULT_LOGO_BUG_REFERENCE_HEIGHT = 2160;
function logoBugScale(profile) {
  const setting = S.config.display && S.config.display.logoBugReferenceHeight;
  if (setting === 0) return 1;
  const refH = Number(profile.refH) || Number(setting) || DEFAULT_LOGO_BUG_REFERENCE_HEIGHT;
  const h = crtContainer.clientHeight;
  return h > 0 ? Math.min(4, Math.max(0.25, h / refH)) : 1;
}

function applyLogoBugProfileStyles(element, profile) {
  const scale = logoBugScale(profile);
  const { width: rawWidth, height: rawHeight } = logoBugProfileDimensions(profile);
  const width = rawWidth * scale;
  const height = rawHeight * scale;
  const rect = S.config.display && S.config.display.logoBugFollowPicture !== false ? S.pictureRect : null;
  if (rect) {
    // Anchored to the picture, not the screen: positions are a share of the
    // picture, so the bug sits on letterboxed content. The size is the
    // profile's own, in screen pixels, so it doesn't change with the shape
    // of the picture.
    const w = Math.min(width, rect.width);
    const h = Math.min(height, rect.height);
    element.style.setProperty('--logo-bug-size', `${Math.min(profile.size * scale, rect.width, rect.height)}px`);
    element.style.setProperty('--logo-bug-width', `${w}px`);
    element.style.setProperty('--logo-bug-height', `${h}px`);
    const x = rect.left + Math.min(Math.max(0, (profile.x / 100) * rect.width), Math.max(0, rect.width - w));
    const y = rect.top + Math.min(Math.max(0, (profile.y / 100) * rect.height), Math.max(0, rect.height - h));
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    return;
  }
  element.style.setProperty('--logo-bug-size', `min(${profile.size * scale}px, 100%)`);
  element.style.setProperty('--logo-bug-width', `min(${width}px, 100%)`);
  element.style.setProperty('--logo-bug-height', `min(${height}px, 100%)`);
  element.style.left = `clamp(0px, ${profile.x}%, max(0px, calc(100% - var(--logo-bug-width))))`;
  element.style.top = `clamp(0px, ${profile.y}%, max(0px, calc(100% - var(--logo-bug-height))))`;
}

// Position + size are resolution-aware now (S.config.display.logoBugProfiles
// / ch.logoBugProfiles — see pickLogoBugProfile, channels.js), keyed off the
// actively-playing video's own width. `player.videoWidth` reads 0 before
// `loadedmetadata` fires, which pickLogoBugProfile treats as "unknown" (any
// non-catch-all breakpoint is skipped, falling through to the DEFAULT
// profile) — playChannelLive's onMeta handler re-calls this once the real
// width is known, so a resolution-specific profile still gets a chance to
// apply within the same tune, not just on the next one.
export function applyLogoBugPlacement(ch) {
  const profile = pickLogoBugProfile(activeLogoBugProfiles(ch), activeLogoBugContext()) || FALLBACK_LOGO_BUG_PROFILE;
  applyLogoBugProfileStyles(logoBugEl, profile);
  // Absent opacity falls back to the CSS default (55%) via the var()
  // fallback in overlays.css, so profiles without it round-trip unchanged.
  if (Number.isFinite(profile.opacity)) logoBugEl.style.setProperty('--logo-bug-opacity', profile.opacity / 100);
  else logoBugEl.style.removeProperty('--logo-bug-opacity');
}

// The picture was re-framed (new file, resize, aspect change): a bug anchored
// to the picture moves with it.
// A resize changes the screen height the size scales against.
window.addEventListener('resize', () => {
  if (S.config && S.config.display && S.currentNumber != null) applyLogoBugPlacement(getChannel(S.currentNumber));
});
window.addEventListener('reruntv:picture-framed', () => {
  if (S.config && S.config.display && S.config.display.logoBugFollowPicture !== false && S.currentNumber != null) {
    applyLogoBugPlacement(getChannel(S.currentNumber));
    applyLogoBugGhost(getChannel(S.currentNumber));
  }
});

// ---------- OS media session ----------
// Tells the operating system what's airing, so the media keys on a keyboard
// and the system's own now-playing overlay both work on a box that is
// explicitly meant to keep running behind other windows. Channel up/down is
// the honest mapping for next/previous track — there is no "track" here, and
// skipping within a programme would contradict the whole live-schedule
// premise. Play/pause is deliberately left to the element's own default:
// pausing genuinely pauses, and the drift watchdog (playback-core.js) snaps
// the channel back to live the moment it resumes, which is exactly the
// behaviour a viewer would expect from a set-top box.
export function initMediaSession(onChannelDelta) {
  const ms = navigator.mediaSession;
  if (!ms || typeof ms.setActionHandler !== 'function') return;
  const bind = (action, fn) => {
    try { ms.setActionHandler(action, fn); } catch (e) { /* unsupported action */ }
  };
  bind('nexttrack', () => onChannelDelta(1));
  bind('previoustrack', () => onChannelDelta(-1));
}

export function updateMediaSession(ch, file) {
  const ms = navigator.mediaSession;
  if (!ms || typeof window.MediaMetadata !== 'function') return;
  try {
    if (!ch) { ms.metadata = null; return; }
    ms.metadata = new window.MediaMetadata({
      title: file ? getDisplayTitle(file) : (ch.name || `CHANNEL ${ch.number}`),
      artist: `CH ${ch.number}${ch.name ? ` — ${ch.name}` : ''}`,
      album: 'RerunTV',
    });
  } catch (e) {
    // Metadata is decoration; never let it take a tune down with it.
  }
}

export function updateLogoBug(ch) {
  logoBugEl.innerHTML = '';
  logoBugEl.style.background = '';
  applyLogoBugPlacement(ch);
  const effectiveIcon = ch && resolveEffectiveIcon(ch, viewNow());
  if (!ch) {
    logoBugEl.classList.add('hidden');
  } else if (effectiveIcon) {
    // A GIF/APNG icon already animates for free through a plain <img> — only
    // an actual video file (mp4/webm/etc) needs the <video> element instead.
    if (isVideoMediaPath(effectiveIcon)) {
      const video = document.createElement('video');
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      window.api.toFileUrl(effectiveIcon).then((url) => { video.src = url; video.play().catch(() => {}); });
      logoBugEl.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.alt = String(ch.number);
      window.api.toFileUrl(effectiveIcon).then((url) => { img.src = url; });
      logoBugEl.appendChild(img);
    }
    // See buildChannelBadge (channels.js) — same "icon otherwise hides the
    // number entirely" fix, same shared .badge-num chip (overlays.css).
    if (!(S.config.display && S.config.display.logoBugHideNumber)) {
      const numChip = document.createElement('span');
      numChip.className = 'badge-num';
      numChip.textContent = String(ch.number);
      logoBugEl.appendChild(numChip);
    }
    logoBugEl.classList.remove('hidden');
  } else {
    logoBugEl.style.background = channelColor(ch);
    logoBugEl.textContent = String(ch.number);
    logoBugEl.classList.remove('hidden');
  }
  applyLogoBugGhost(ch);
  applyLogoBugMotion();
}

// Box-wide only (S.config.display.logoBugMotion) — a CSS animation preset
// applied to the real logo bug (never the burn-in ghost, which has its own
// separate fade-based animation already). 'slide-in' is one-shot and needs
// to replay on every call (a fresh tune, or any other updateLogoBug trigger)
// — forcing a reflow between remove and add is the same trick
// attachSliderReadout's pulse uses (setup-util.js); 'pulse'/'glow' are
// persistent CSS @keyframes loops that don't need replaying.
export function applyLogoBugMotion() {
  const preset = (S.config.display && S.config.display.logoBugMotion) || 'none';
  LOGO_MOTION_PRESETS.forEach((p) => logoBugEl.classList.remove(`logo-motion-${p}`));
  if (preset === 'none') return;
  void logoBugEl.offsetWidth;
  logoBugEl.classList.add(`logo-motion-${preset}`);
}

// Full ghost strength (the crtIntensity.burnIn slider's own cap, applied on
// top of this) reached after this many continuous ms of the same logo
// sitting in the same corner — a real CRT burns in over a much longer real-
// world timescale, compressed here so the effect is actually observable
// during a normal viewing session instead of only in theory.
const BURN_IN_FULL_MS = 30 * 60000;

function logoBugBurnKeyFor(ch) {
  if (!ch) return null;
  const profile = pickLogoBugProfile(activeLogoBugProfiles(ch), activeLogoBugContext()) || FALLBACK_LOGO_BUG_PROFILE;
  // Includes the effective icon so a seasonal swap (resolveEffectiveIcon,
  // channels.js) re-renders the ghost's own content immediately instead of
  // it staying stale until the next channel/profile change.
  return `${ch.number}:${profile.id || `${profile.x},${profile.y}`}:${resolveEffectiveIcon(ch, viewNow()) || ''}`;
}

function tickLogoBugGhost() {
  const cap = ((S.config.crtIntensity && S.config.crtIntensity.burnIn) || 0) / 100 * 0.35;
  if (cap <= 0 || !S.logoBugBurnStartMs) {
    logoBugGhostEl.style.setProperty('--logo-bug-burn-opacity', 0);
    return;
  }
  const elapsedMs = Date.now() - S.logoBugBurnStartMs;
  const opacity = Math.min(1, elapsedMs / BURN_IN_FULL_MS) * cap;
  logoBugGhostEl.style.setProperty('--logo-bug-burn-opacity', opacity);
}

// Tracks how long the CURRENT logo bug (same channel, same corner) has sat
// on screen continuously and renders a matching faint ghost of it — the
// ghost is its OWN element (#logo-bug-ghost, separate from the real
// #logo-bug) so it keeps showing through breaks/virtual channels/anything
// else that hides the real logo bug, which is the entire point of "burn-in"
// (a real CRT doesn't know or care that the show cut to a commercial).
// Real wall-clock time (Date.now()), not viewNow() — burn-in tracks actual
// screen-on time, unaffected by the time machine scrubbing simulated
// broadcast time back and forth.
// Re-applies the ghost for whatever's currently tuned — for the DISPLAY
// settings screen's LOGO BURN-IN slider (setup-settings.js) to get instant
// feedback on drag instead of waiting for the next channel change.
export function refreshLogoBugGhost() {
  applyLogoBugGhost(getChannel(S.currentNumber));
}

function applyLogoBugGhost(ch) {
  const burnIn = (S.config.crtIntensity && S.config.crtIntensity.burnIn) || 0;
  clearInterval(S.logoBugBurnTimer);
  S.logoBugBurnTimer = null;
  if (!burnIn) {
    S.logoBugBurnKey = null;
    S.logoBugBurnStartMs = null;
    logoBugGhostEl.classList.add('hidden');
    logoBugGhostEl.style.setProperty('--logo-bug-burn-opacity', 0);
    return;
  }

  const key = logoBugBurnKeyFor(ch);
  if (key !== S.logoBugBurnKey) {
    // A different logo (or the same logo in a different corner) took over
    // this spot — restart accumulation and re-render the ghost's own
    // content to match, rather than leaving a stale ghost of whatever used
    // to be there.
    S.logoBugBurnKey = key;
    S.logoBugBurnStartMs = key ? Date.now() : null;
    logoBugGhostEl.innerHTML = '';
    logoBugGhostEl.style.background = '';
    if (ch) {
      const profile = pickLogoBugProfile(activeLogoBugProfiles(ch), activeLogoBugContext()) || FALLBACK_LOGO_BUG_PROFILE;
      applyLogoBugProfileStyles(logoBugGhostEl, profile);
      const effectiveIcon = resolveEffectiveIcon(ch, viewNow());
      if (effectiveIcon) {
        const img = document.createElement('img');
        img.alt = String(ch.number);
        window.api.toFileUrl(effectiveIcon).then((url) => { img.src = url; });
        logoBugGhostEl.appendChild(img);
        // Mirrors the real logo bug (updateLogoBug above) — the ghost should
        // show the same content it's an afterimage of, chip included.
        const numChip = document.createElement('span');
        numChip.className = 'badge-num';
        numChip.textContent = String(ch.number);
        logoBugGhostEl.appendChild(numChip);
      } else {
        logoBugGhostEl.style.background = channelColor(ch);
        logoBugGhostEl.textContent = String(ch.number);
      }
      logoBugGhostEl.classList.remove('hidden');
    } else {
      logoBugGhostEl.classList.add('hidden');
    }
  }

  if (key) {
    tickLogoBugGhost();
    S.logoBugBurnTimer = setInterval(tickLogoBugGhost, 15000);
  } else {
    logoBugGhostEl.style.setProperty('--logo-bug-burn-opacity', 0);
  }
}

// TV content-rating bug — flashed briefly whenever a program starts, mirrors
// the logo bug's show/hide but auto-hides on a timer like the up-next bar.
// `rating` is resolved by the caller (currently-airing file's own rating,
// falling back to the channel-wide one — see playChannelLive's onMeta) so
// this stays a dumb renderer, not a second place that re-derives the
// fallback chain. Real US ratings bugs hold ~15-17s at program start; 6s was
// an arbitrary compression from before per-file ratings existed.
export function flashRatingBug(ch, rating) {
  ratingBugEl.textContent = rating;
  ratingBugEl.classList.add('show');
  playConfiguredSound('card', ch.number);
  S.ratingBugTimer = autoHideAfter(S.ratingBugTimer, 16000, () => ratingBugEl.classList.remove('show'));
}

// Full-screen movie-rating-card analogue of flashRatingBug above — real
// broadcast movies got a plain black "the following program is rated..."
// slide before the film started rather than a small corner bug. Shown
// instead of (not alongside) flashRatingBug when the caller has already
// determined the airing file is a movie (see playChannelLive's onMeta).
export function showMovieRatingCard(ch, rating) {
  movieRatingCardEl.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'movie-rating-card-line';
  line.textContent = 'THE FOLLOWING PROGRAM IS RATED';
  const value = document.createElement('div');
  value.className = 'movie-rating-card-value';
  value.textContent = rating;
  movieRatingCardEl.appendChild(line);
  movieRatingCardEl.appendChild(value);
  movieRatingCardEl.classList.add('show');
  playConfiguredSound('card', ch.number);
  S.movieRatingCardTimer = autoHideAfter(S.movieRatingCardTimer, 16000, () => movieRatingCardEl.classList.remove('show'));
}

// "NEW EPISODE"/"REPEAT" bug — same show/hide shape as flashRatingBug,
// separate element/timer so it can coexist with the rating bug (opposite
// screen corner by default, see .episode-status-bug in overlays.css).
export function flashEpisodeStatusBug(ch, status) {
  episodeStatusBugEl.textContent = status;
  episodeStatusBugEl.classList.add('show');
  playConfiguredSound('card', ch.number);
  S.episodeStatusBugTimer = autoHideAfter(S.episodeStatusBugTimer, 16000, () => episodeStatusBugEl.classList.remove('show'));
}

// "Formatted to fit your screen"/widescreen disclaimer card — same
// show/hide shape as the bugs above, own element/timer.
export function flashFormatDisclaimer(ch, text) {
  formatDisclaimerCardEl.textContent = text;
  formatDisclaimerCardEl.classList.add('show');
  playConfiguredSound('card', ch.number);
  S.formatDisclaimerCardTimer = autoHideAfter(S.formatDisclaimerCardTimer, 16000, () => formatDisclaimerCardEl.classList.remove('show'));
}

// Content advisory disclaimer card — same show/hide shape as the bugs
// above, own element/timer. `text` is the file's own free-text advisory
// (file.advisory, setup-panels.js's TITLES tab), never auto-generated.
export function flashContentAdvisory(ch, text) {
  contentAdvisoryCardEl.textContent = text;
  contentAdvisoryCardEl.classList.add('show');
  playConfiguredSound('card', ch.number);
  S.contentAdvisoryCardTimer = autoHideAfter(S.contentAdvisoryCardTimer, 16000, () => contentAdvisoryCardEl.classList.remove('show'));
}

// CC/SAP/STEREO capability badge — same show/hide shape as the bugs above.
// `labels` is whichever of ['CC','SAP','STEREO'] apply to this file
// (file.hasCC/hasSAP/hasStereo, setup-panels.js's TITLES tab).
export function flashCapabilityBadge(ch, labels) {
  capabilityBadgeEl.textContent = labels.join(' · ');
  capabilityBadgeEl.classList.add('show');
  playConfiguredSound('card', ch.number);
  S.capabilityBadgeTimer = autoHideAfter(S.capabilityBadgeTimer, 16000, () => capabilityBadgeEl.classList.remove('show'));
}
