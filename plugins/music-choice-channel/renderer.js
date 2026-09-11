// Music Choice Channel — a retro '90s/2000s digital-cable-style audio
// channel. Real Music Choice/DMX cable audio services worked as a *block* of
// dozens of single-genre channels you'd flip between, each just looping a
// hand-picked playlist with a static/slowly-changing background and a
// now-playing text readout (artist/title, no video, no DJ). This plugin
// gets exactly one real channel number (like every other plugin channel —
// see PLUGIN_DEVELOPMENT.md's registerChannelType), so that "flip between
// genres" behavior is reproduced as an in-channel station browser (▲/▼ or
// OK) instead of dozens of registered numbers.
//
// Playback position is a PURE function of (station, now) — computeStationPlayback
// below — so tuning in mid-song resumes at the right place and scrubbing the
// time machine works for free, the same "no separate playback log" philosophy
// core's own schedule.js uses for real channels (see CLAUDE.md). `ctx.viewNow()`
// is used everywhere here instead of Date.now() for exactly that reason.
const CHANNEL_NUMBER = 910;

export const GENRE_THEMES = [
  { id: 'rock', label: 'ROCK', bg: '#1a0606', bg2: '#3a0d0d', accent: '#ff4444' },
  { id: 'country', label: 'COUNTRY', bg: '#241505', bg2: '#4a2d0a', accent: '#e0a952' },
  { id: 'rnb', label: 'R&B / SOUL', bg: '#1c0620', bg2: '#3a0f42', accent: '#e066ff' },
  { id: 'jazz', label: 'JAZZ', bg: '#050b1c', bg2: '#0d1f42', accent: '#f2c14e' },
  { id: 'classical', label: 'CLASSICAL', bg: '#1c1508', bg2: '#3a2c10', accent: '#f5e6c8' },
  { id: 'dance', label: 'DANCE / POP', bg: '#1a0620', bg2: '#3d0a46', accent: '#39e6ff' },
  { id: 'hiphop', label: 'HIP-HOP', bg: '#0a0a0a', bg2: '#141414', accent: '#3dff7a' },
  { id: 'oldies', label: 'OLDIES', bg: '#051c1a', bg2: '#0a3a36', accent: '#ff9d4d' },
  { id: 'easy', label: 'EASY LISTENING', bg: '#0e1a12', bg2: '#1f3a26', accent: '#dff0d8' },
  { id: 'holiday', label: 'HOLIDAY', bg: '#06170a', bg2: '#0e3616', accent: '#ff5252' },
];

export function themeFor(station) {
  return GENRE_THEMES.find((t) => t.id === (station && station.themeId)) || GENRE_THEMES[0];
}

// Most personal rips follow "Artist - Title.ext" — reused loosely from
// core's own getDisplayTitle (util.js) filename-cleanup convention, kept
// local here since there's no ID3 reader in this app and re-deriving a
// title from a raw filename is genuinely this plugin's own concern.
export function parseArtistTitle(filePath) {
  const base = filePath.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
  const cleaned = base.replace(/_+/g, ' ').trim();
  const parts = cleaned.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) return { artist: parts[0].toUpperCase(), title: parts.slice(1).join(' - ') };
  return { artist: 'UNKNOWN ARTIST', title: cleaned || 'UNTITLED' };
}

// Pure function of (station, now) — the one thing this whole plugin's
// correctness rests on. `station.tracks` must already have durationSec
// probed (see probeAllDurations below); untimed tracks are skipped so a
// station mid-scan doesn't corrupt the loop math for the ones already known.
export function computeStationPlayback(station, nowMs) {
  const tracks = (station && station.tracks || []).filter((t) => t.durationSec > 0);
  if (!tracks.length) return null;
  const totalMs = tracks.reduce((sum, t) => sum + t.durationSec * 1000, 0);
  if (totalMs <= 0) return null;
  const anchor = station.anchorMs || 0;
  let elapsed = (nowMs - anchor) % totalMs;
  if (elapsed < 0) elapsed += totalMs;
  let index = 0;
  for (; index < tracks.length; index++) {
    const durMs = tracks[index].durationSec * 1000;
    if (elapsed < durMs) break;
    elapsed -= durMs;
  }
  if (index >= tracks.length) index = tracks.length - 1;
  return {
    track: tracks[index],
    offsetSec: elapsed / 1000,
    nextTrack: tracks[(index + 1) % tracks.length],
    index,
    totalTracks: tracks.length,
  };
}

// Off-screen <audio> metadata probe — no ffmpeg/ID3 dependency needed, the
// browser already knows how to read a container's duration. Called from the
// settings panel's RESCAN flow (settings.js) as well as lazily here for any
// track that's missing a duration (e.g. a folder edited outside the app).
export function probeDuration(filePath) {
  return window.api.toFileUrl(filePath).then((url) => new Promise((resolve) => {
    const a = new Audio();
    const finish = (sec) => { a.removeAttribute('src'); resolve(sec); };
    a.addEventListener('loadedmetadata', () => finish(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0), { once: true });
    a.addEventListener('error', () => finish(0), { once: true });
    a.preload = 'metadata';
    a.src = url;
  }));
}

export async function probeAllDurations(tracks, onProgress) {
  for (let i = 0; i < tracks.length; i++) {
    if (!tracks[i].durationSec) tracks[i].durationSec = await probeDuration(tracks[i].path);
    if (onProgress) onProgress(i + 1, tracks.length);
  }
  return tracks;
}

function formatClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getSettings() {
  return window.RCBPlugins.ctx.settings.getPluginSettings('music-choice-channel');
}
function updateSettings(patch) {
  return window.RCBPlugins.ctx.settings.updatePluginSettings('music-choice-channel', patch);
}

function selectedStation(settings) {
  settings = settings || getSettings();
  const stations = settings.stations || [];
  if (!stations.length) return null;
  return stations.find((s) => s.id === settings.selectedStationId) || stations[0];
}

// ---------- Runtime (per tune-in) state ----------
let els = null;
let tickTimer = null;
let currentLoadedTrackPath = null;
let browserOpen = false;
let browserHighlightId = null; // navigation cursor inside the open browser, separate from what's actually playing until confirmed
let endedHandler = null;
let errorHandler = null;
let bgVideoPath = null; // avoid re-setting the same <video> src every tick (restarts playback)

// The one place playback actually switches to a different station — anchors
// a never-tuned station to "now" (so its loop math has a starting point),
// applies its theme/background, and forces the next tick() to (re)load its
// current track. Called from a confirmed browser pick, the ▲/▼ quick-cycle,
// and settings.js right after a brand-new station is created.
function switchToStation(ctx, id) {
  updateSettings({ selectedStationId: id });
  currentLoadedTrackPath = null;
  const station = selectedStation(getSettings());
  if (!station) return;
  if (!station.anchorMs) {
    const settings = getSettings();
    const st = (settings.stations || []).find((s) => s.id === station.id);
    if (st) { st.anchorMs = ctx.viewNow(); updateSettings({ stations: settings.stations }); }
  }
  applyStationTheme(station);
  applyStationBackground(station);
  tick(ctx);
}

function applyStationTheme(station) {
  const theme = themeFor(station);
  if (!els) return;
  els.root.style.setProperty('--mc-bg', theme.bg);
  els.root.style.setProperty('--mc-bg2', theme.bg2);
  els.root.style.setProperty('--mc-accent', theme.accent);
}

function applyStationBackground(station) {
  if (!els) return;
  const bgMode = (station.background && station.background.mode) || 'gradient';
  els.slideshowEl.classList.toggle('hidden', bgMode !== 'slideshow');
  els.bgVideoEl.classList.toggle('hidden', bgMode !== 'video');
  if (bgMode !== 'video') {
    els.bgVideoEl.pause();
    els.bgVideoEl.removeAttribute('src');
    bgVideoPath = null;
  } else if (station.background.videoPath && station.background.videoPath !== bgVideoPath) {
    bgVideoPath = station.background.videoPath;
    window.api.toFileUrl(bgVideoPath).then((url) => {
      els.bgVideoEl.src = url;
      els.bgVideoEl.loop = true;
      els.bgVideoEl.muted = true;
      els.bgVideoEl.play().catch(() => {});
    });
  }
}

// Deterministic on viewNow() (not a free-running setInterval index) so a
// time-machine scrub lands on the same image it would have shown live —
// same reasoning as everything else in this file using viewNow().
const SLIDESHOW_INTERVAL_MS = 12000;
let lastSlideshowIndex = -1;
function updateSlideshow(station, nowMs) {
  if (!els || (station.background && station.background.mode) !== 'slideshow') return;
  const images = (station.background && station.background.images) || [];
  if (!images.length) { els.slideshowImgA.removeAttribute('src'); return; }
  const idx = Math.floor(nowMs / SLIDESHOW_INTERVAL_MS) % images.length;
  if (idx === lastSlideshowIndex) return;
  lastSlideshowIndex = idx;
  window.api.toFileUrl(images[idx]).then((url) => {
    // Crossfade: swap the "back" layer's image, then flip which layer is on
    // top so CSS opacity transitions handle the fade instead of a hard cut.
    const showingA = !els.slideshowImgB.classList.contains('mc-slideshow-top');
    const backImg = showingA ? els.slideshowImgB : els.slideshowImgA;
    backImg.src = url;
    els.slideshowImgA.classList.toggle('mc-slideshow-top', showingA);
    els.slideshowImgB.classList.toggle('mc-slideshow-top', !showingA);
  });
}

function updateNowPlayingUi(pb) {
  if (!els) return;
  const meta = parseArtistTitle(pb.track.path);
  els.artistEl.textContent = pb.track.artist || meta.artist;
  els.titleEl.textContent = pb.track.title || meta.title;
  els.elapsedEl.textContent = formatClock(pb.offsetSec);
  els.durationEl.textContent = formatClock(pb.track.durationSec);
  const pct = pb.track.durationSec ? Math.min(100, (pb.offsetSec / pb.track.durationSec) * 100) : 0;
  els.progressFillEl.style.width = `${pct}%`;
  const nextMeta = parseArtistTitle(pb.nextTrack.path);
  els.upNextEl.textContent = pb.totalTracks > 1
    ? `UP NEXT: ${pb.nextTrack.artist || nextMeta.artist} – ${pb.nextTrack.title || nextMeta.title}`
    : '';
}

function loadTrack(ctx, station, pb) {
  currentLoadedTrackPath = pb.track.path;
  window.api.toFileUrl(pb.track.path).then((url) => {
    if (window.S.currentNumber !== CHANNEL_NUMBER || currentLoadedTrackPath !== pb.track.path) return;
    ctx.player.loop = false;
    ctx.player.src = url;
    ctx.player.load();
    const onMeta = () => {
      ctx.player.currentTime = pb.offsetSec;
      ctx.player.removeEventListener('loadedmetadata', onMeta);
    };
    ctx.player.addEventListener('loadedmetadata', onMeta);
    ctx.player.play().catch(() => {});
  });
}

function tick(ctx) {
  if (!els || window.S.currentNumber !== CHANNEL_NUMBER) return;
  const settings = getSettings();
  const station = selectedStation(settings);
  if (!station) return;
  els.stationNameEl.textContent = station.name || 'UNTITLED STATION';
  const pb = computeStationPlayback(station, ctx.viewNow());
  if (!pb) {
    els.nowPlayingEl.classList.add('hidden');
    els.probeHintEl.textContent = (station.tracks || []).length
      ? 'DURATIONS NOT YET PROBED — RESCAN THIS STATION IN SETTINGS'
      : 'NO TRACKS YET — CHOOSE A FOLDER AND RESCAN THIS STATION IN SETTINGS';
    els.probeHintEl.classList.remove('hidden');
    return;
  }
  els.nowPlayingEl.classList.remove('hidden');
  els.probeHintEl.classList.add('hidden');
  if (currentLoadedTrackPath !== pb.track.path) {
    loadTrack(ctx, station, pb);
  } else if (Math.abs(ctx.player.currentTime - pb.offsetSec) > 2.5) {
    // Drift correction (a paused/backgrounded tab, a time-machine scrub,
    // clock skew) — resync without a full reload/re-buffer.
    ctx.player.currentTime = pb.offsetSec;
  }
  updateNowPlayingUi(pb);
  updateSlideshow(station, ctx.viewNow());
}

function renderBrowser(ctx) {
  if (!els) return;
  const stations = getSettings().stations || [];
  els.browserListEl.innerHTML = '';
  stations.forEach((station) => {
    const theme = themeFor(station);
    const row = document.createElement('div');
    row.className = 'mc-browser-row';
    if (station.id === browserHighlightId) row.classList.add('mc-browser-row-active');
    row.dataset.stationId = station.id;
    row.innerHTML = `
      <span class="mc-browser-swatch" style="background:${theme.accent}"></span>
      <span class="mc-browser-name">${station.name || 'UNTITLED STATION'}</span>
      <span class="mc-browser-genre">${theme.label}</span>
      <span class="mc-browser-count">${(station.tracks || []).length} TRACKS</span>
    `;
    row.addEventListener('click', () => { switchToStation(ctx, station.id); closeBrowser(); });
    els.browserListEl.appendChild(row);
  });
}

function openBrowser(ctx) {
  if (!els || !(getSettings().stations || []).length) return;
  browserOpen = true;
  browserHighlightId = getSettings().selectedStationId;
  els.browserEl.classList.remove('hidden');
  renderBrowser(ctx);
}
function closeBrowser() {
  browserOpen = false;
  browserHighlightId = null;
  if (els) els.browserEl.classList.add('hidden');
}

function cycleStation(ctx, dir) {
  const settings = getSettings();
  const stations = settings.stations || [];
  if (stations.length < 2) return;
  const curIdx = Math.max(0, stations.findIndex((s) => s.id === settings.selectedStationId));
  const next = stations[(curIdx + dir + stations.length) % stations.length];
  switchToStation(ctx, next.id);
}

function browserMove(ctx, dir) {
  const stations = getSettings().stations || [];
  if (!stations.length) return;
  const curIdx = Math.max(0, stations.findIndex((s) => s.id === browserHighlightId));
  const next = stations[(curIdx + dir + stations.length) % stations.length];
  browserHighlightId = next.id;
  renderBrowser(ctx);
}

window.RCBPlugins.registerChannelType('music-choice-channel', {
  number: CHANNEL_NUMBER,
  label: 'MUSIC CHOICE',
  // Internally compares window.S.currentNumber against the CHANNEL_NUMBER
  // constant above rather than reading a live effective number, so a
  // user-set number override (Channel Setup's PLUGIN CHANNELS section)
  // would desync this plugin's own tuned-in checks from the real number it
  // got moved to. Opt out of that override's number field until this
  // plugin reads its live number dynamically instead.
  numberLocked: true,
  get nowText() {
    const station = selectedStation();
    return station ? station.name : 'No stations configured';
  },
  badge: { bg: '#7c2d92', label: 'MC' },
  render(container, ctx) {
    container.innerHTML = `
      <div class="mc-channel" data-el="root">
        <div class="mc-bg">
          <div class="mc-bg-gradient"></div>
          <div class="mc-bg-slideshow hidden" data-el="slideshow">
            <img class="mc-slideshow-img mc-slideshow-top" data-el="slideshow-a" alt="">
            <img class="mc-slideshow-img" data-el="slideshow-b" alt="">
          </div>
          <video class="mc-bg-video hidden" data-el="bg-video" muted loop playsinline></video>
          <div class="mc-bg-scrim"></div>
          <div class="mc-vu"><span></span><span></span><span></span><span></span><span></span></div>
        </div>
        <div class="mc-chrome">
          <div class="mc-bug">
            <div class="mc-bug-brand">MUSIC CHOICE</div>
            <div class="mc-bug-station" data-el="station-name">&nbsp;</div>
          </div>
          <div class="mc-topright">
            <div class="mc-chnum">CH ${CHANNEL_NUMBER}</div>
            <div class="mc-stereo">◆ DIGITAL STEREO</div>
          </div>
          <div class="mc-empty hidden" data-el="empty">
            <div class="mc-empty-title">NO STATIONS CONFIGURED</div>
            <div class="mc-empty-body">Add a station and point it at a music folder in PLUGINS &rarr; MUSIC CHOICE CHANNEL settings.</div>
          </div>
          <div class="mc-probe-hint hidden" data-el="probe-hint">DURATIONS NOT YET PROBED — RESCAN THIS STATION IN SETTINGS</div>
          <div class="mc-now-playing hidden" data-el="now-playing">
            <div class="mc-artist" data-el="artist"></div>
            <div class="mc-title" data-el="title"></div>
            <div class="mc-progress-row">
              <span data-el="elapsed">0:00</span>
              <div class="mc-progress-bar"><div class="mc-progress-fill" data-el="progress-fill"></div></div>
              <span data-el="duration">0:00</span>
            </div>
            <div class="mc-upnext" data-el="up-next"></div>
          </div>
          <div class="mc-hint">▲▼ CHANGE STATION &middot; OK STATION LIST</div>
        </div>
        <div class="mc-browser hidden" data-el="browser">
          <div class="mc-browser-title">CHOOSE A STATION</div>
          <div class="mc-browser-list" data-el="browser-list"></div>
          <div class="mc-browser-hint">▲▼ SELECT &middot; OK TUNE &middot; ESC CANCEL</div>
        </div>
      </div>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    els = {
      root: q('root'),
      slideshowEl: q('slideshow'), slideshowImgA: q('slideshow-a'), slideshowImgB: q('slideshow-b'),
      bgVideoEl: q('bg-video'),
      stationNameEl: q('station-name'), emptyEl: q('empty'), probeHintEl: q('probe-hint'),
      nowPlayingEl: q('now-playing'), artistEl: q('artist'), titleEl: q('title'),
      elapsedEl: q('elapsed'), durationEl: q('duration'), progressFillEl: q('progress-fill'),
      upNextEl: q('up-next'), browserEl: q('browser'), browserListEl: q('browser-list'),
    };

    const settings = getSettings();
    const stations = settings.stations || [];
    els.emptyEl.classList.toggle('hidden', stations.length > 0);
    if (!stations.length) return;

    const station = selectedStation(settings);
    if (!station.anchorMs) { station.anchorMs = ctx.viewNow(); updateSettings({ stations }); }
    applyStationTheme(station);
    applyStationBackground(station);

    endedHandler = () => tick(ctx); // re-derive from now() rather than blindly advancing one index
    errorHandler = () => tick(ctx);
    ctx.player.addEventListener('ended', endedHandler);
    ctx.player.addEventListener('error', errorHandler);

    currentLoadedTrackPath = null;
    tick(ctx);
    tickTimer = setInterval(() => tick(ctx), 1000);
  },
  stop(ctx) {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (endedHandler) { ctx.player.removeEventListener('ended', endedHandler); endedHandler = null; }
    if (errorHandler) { ctx.player.removeEventListener('error', errorHandler); errorHandler = null; }
    if (els) {
      els.bgVideoEl.pause();
      els.bgVideoEl.removeAttribute('src');
    }
    currentLoadedTrackPath = null;
    bgVideoPath = null;
    lastSlideshowIndex = -1;
    browserOpen = false;
    els = null;
  },
  onOk(ctx) {
    if (browserOpen) {
      if (browserHighlightId) switchToStation(ctx, browserHighlightId);
      closeBrowser();
      return true;
    }
    if ((getSettings().stations || []).length) { openBrowser(ctx); return true; }
    return false;
  },
  onKey(key, ctx) {
    if (browserOpen) {
      if (key === 'ArrowUp') { browserMove(ctx, -1); return true; }
      if (key === 'ArrowDown') { browserMove(ctx, 1); return true; }
      if (key === 'Enter' || key === ' ') { if (browserHighlightId) switchToStation(ctx, browserHighlightId); closeBrowser(); return true; }
      if (key === 'Escape') { closeBrowser(); return true; }
      return true; // swallow everything else while the browser is open
    }
    if (key === 'ArrowUp') { cycleStation(ctx, -1); return true; }
    if (key === 'ArrowDown') { cycleStation(ctx, 1); return true; }
    return false;
  },
});
