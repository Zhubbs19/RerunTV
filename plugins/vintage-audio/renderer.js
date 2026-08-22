// Per-theme ambient audio texture — driven entirely by the active theme
// pack's `ambientTexture` field (registerThemePack, see
// plugins/theme-*/renderer.js) via window.RCBPlugins.getThemePack(). A
// subtle, always-additive background layer on top of whatever's already
// playing, mixed through the same window.S.sfxGain node every other SFX in
// core uses via window.getAudioCtx() — so it automatically respects
// mute/volume with no separate plumbing. Deliberately never touches
// `player` itself (the single shared <video> element, see the
// architecture's single-video-element rule): routing that through Web Audio
// via createMediaElementSource would permanently cut its native output
// unless every connection is wired flawlessly, and a bug there would
// silence real content across the whole app — far too much blast radius for
// a texture gimmick. Purely additive avoids that risk entirely. A theme
// with no `ambientTexture` (most of them) stays exactly as it always has:
// nothing runs.
//
// Each profile is either a filtered-noise texture (`type: 'noise'`, the
// original analog-90s tape-hiss mechanism, generalized) or a steady tone
// (`type: 'tone'`, for the satellite era's carrier hum — noise would read
// as static, wrong for a clean digital theme). `crackle` is optional.
//
// Note: S.config.vintageAudio's `cutoffHz`/`hum` fields are exposed in the
// settings panel below but not actually read by applyThemeAudio() — this is
// a pre-existing gap inherited from the old core implementation, not
// introduced by this migration. Only `clicks` (read by core audio.js's
// playChannelClickSound, which stays core-owned as a general SFX helper) is
// live.
function playNoiseBurst(opts) {
  const ctx = window.getAudioCtx();
  const bufferSize = ctx.sampleRate * (opts.duration / 1000);
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = opts.filterFreq;
  const gain = ctx.createGain();
  gain.gain.value = opts.gain;
  src.connect(filter).connect(gain).connect(window.S.sfxGain);
  src.start();
}

let themeHissGain = null;
let themeCrackleTimer = null;
let themeToneOsc = null;
let themeToneGain = null;
let activeTextureTheme = null;

function ensureThemeHiss(profile) {
  if (themeHissGain) return;
  const ctx = window.getAudioCtx();
  const bufferSize = ctx.sampleRate * 2; // 2s loop — long enough not to read as a rhythmic repeat
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = profile.filterType;
  filter.frequency.value = profile.filterFreq;
  themeHissGain = ctx.createGain();
  themeHissGain.gain.value = 0;
  src.connect(filter).connect(themeHissGain).connect(window.S.sfxGain);
  src.start();
}

function ensureThemeTone(profile) {
  if (themeToneOsc) return;
  const ctx = window.getAudioCtx();
  themeToneOsc = ctx.createOscillator();
  themeToneOsc.type = 'sine';
  themeToneOsc.frequency.value = profile.freq;
  themeToneGain = ctx.createGain();
  themeToneGain.gain.value = 0;
  themeToneOsc.connect(themeToneGain).connect(window.S.sfxGain);
  themeToneOsc.start();
}

function playThemeCrackle(profile) {
  const [gMin, gMax] = profile.gain;
  const [fMin, fMax] = profile.filterFreq;
  playNoiseBurst({ duration: 10 + Math.random() * 15, gain: gMin + Math.random() * (gMax - gMin), filterFreq: fMin + Math.random() * (fMax - fMin) });
}

function scheduleThemeCrackle(profile) {
  clearTimeout(themeCrackleTimer);
  themeCrackleTimer = setTimeout(() => {
    playThemeCrackle(profile);
    scheduleThemeCrackle(profile);
  }, profile.minMs + Math.random() * (profile.maxMs - profile.minMs));
}

// Subscribed below to every core event that could change whether this
// texture should be playing: a theme change/load ('theme-audio-refresh',
// also fired by the movie-mode checkbox handler — MOVIE MODE strips every
// other theme-immersion element, the ambient hiss/hum/tone shouldn't linger
// under it either), powering off/on (so the texture stops when the screen's
// off, same as every other ambient audio in the app), and entering setup
// (so it stops while you're in the setup screen, same as the video itself
// already pauses there). Cheap to call redundantly in any direction — it
// just re-derives "should this be playing right now" fresh from S each
// time, callers don't need to reason about whether it was already in the
// state they're asking for.
function applyThemeAudio() {
  const S = window.S;
  const pack = window.RCBPlugins.getThemePack(S.config.theme);
  const profile = pack && pack.ambientTexture;
  const cfg = S.config.vintageAudio;
  const active = S.isPoweredOn && !S.isSetupOpen && !S.config.display.movieMode
    && !!profile && (!cfg || cfg.enabled !== false);
  const ctx = S.audioCtx || window.getAudioCtx();

  if (active && activeTextureTheme !== S.config.theme) {
    // Switched from one textured theme to another (or from none) — stop
    // whichever generator was running before starting the new one, so two
    // textures never layer on top of each other.
    if (themeHissGain) themeHissGain.gain.setValueAtTime(0, ctx.currentTime);
    if (themeToneGain) themeToneGain.gain.setValueAtTime(0, ctx.currentTime);
    clearTimeout(themeCrackleTimer);
    themeCrackleTimer = null;
  }
  activeTextureTheme = active ? S.config.theme : null;

  if (active && profile.type === 'noise') {
    ensureThemeHiss(profile);
    themeHissGain.gain.cancelScheduledValues(ctx.currentTime);
    themeHissGain.gain.linearRampToValueAtTime(profile.gain, ctx.currentTime + 1.2);
    if (profile.crackle && !themeCrackleTimer) scheduleThemeCrackle(profile.crackle);
  } else if (active && profile.type === 'tone') {
    ensureThemeTone(profile);
    themeToneGain.gain.cancelScheduledValues(ctx.currentTime);
    themeToneGain.gain.linearRampToValueAtTime(profile.gain, ctx.currentTime + 1.2);
  } else {
    if (themeHissGain) {
      themeHissGain.gain.cancelScheduledValues(ctx.currentTime);
      themeHissGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
    }
    if (themeToneGain) {
      themeToneGain.gain.cancelScheduledValues(ctx.currentTime);
      themeToneGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
    }
    clearTimeout(themeCrackleTimer);
    themeCrackleTimer = null;
  }
}

// Core fires these generic events (registerCoreHook, plugins.js) instead of
// calling into this plugin by name.
window.RCBPlugins.registerCoreHook('theme-audio-refresh', applyThemeAudio);
window.RCBPlugins.registerCoreHook('power-off', applyThemeAudio);
window.RCBPlugins.registerCoreHook('power-on', applyThemeAudio);
window.RCBPlugins.registerCoreHook('enter-setup', applyThemeAudio);

window.RCBPlugins.registerSettingsPanel('vintage-audio', {
  render(container, ctx) {
    if (!ctx.S.config.vintageAudio) ctx.S.config.vintageAudio = { enabled: true, cutoffHz: 3500, hum: false, clicks: true };
    const cfg = ctx.S.config.vintageAudio;
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled">VINTAGE CRT AUDIO FILTER, AMBIENT TEXTURE &amp; SFX</label>
      <div class="panel-body crt-sliders">
        <label class="crt-slider">SPEAKER LOWPASS CUTOFF (Hz) <input type="range" min="1500" max="8000" data-el="cutoff"></label>
        <label class="shuffle-toggle"><input type="checkbox" data-el="hum">SUBTLE 60Hz CRT MAINS HUM</label>
        <label class="shuffle-toggle"><input type="checkbox" data-el="clicks">MECHANICAL CABLE BOX CLICK SFX</label>
      </div>
      <span class="panel-status">Adds a theme-tied ambient texture — tape hiss/crackle, console hum, UHF static, or satellite tone — depending on the active guide/OSD theme, plus a mechanical channel-change click.</span>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('enabled');
    const cutoffEl = q('cutoff');
    const humEl = q('hum');
    const clicksEl = q('clicks');
    enabledEl.checked = cfg.enabled !== false;
    cutoffEl.value = cfg.cutoffHz || 3500;
    humEl.checked = !!cfg.hum;
    clicksEl.checked = cfg.clicks !== false;
    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
      applyThemeAudio();
    });
    cutoffEl.addEventListener('input', () => {
      cfg.cutoffHz = parseInt(cutoffEl.value, 10);
      ctx.saveConfigDebounced();
    });
    humEl.addEventListener('change', () => {
      cfg.hum = humEl.checked;
      ctx.saveConfigDebounced();
    });
    clicksEl.addEventListener('change', () => {
      cfg.clicks = clicksEl.checked;
      ctx.saveConfigDebounced();
    });
  },
});
