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

// ---------- Presentation era ----------
// What the real services actually put on screen, which is the thing this
// plugin had wrong. Music Choice ran a "freeze frame television" format:
// still slides over the audio showing artist, song, album and year, with a
// small strip at the top or bottom carrying artist info / "Did You Know?"
// factoids / banner advertising, cycling roughly every 30 seconds. Nothing
// in that format ever showed an elapsed-time readout, a progress bar, or an
// "up next" line — those are streaming-app affordances, and having them was
// the most anachronistic thing here. DMX went further still and put track
// info only on the tuner box's LCD, not on the TV at all.
//
// Rather than deleting the modern readouts outright, they move behind this
// one dial: the two period eras are accurate, 'modern' keeps what this
// plugin did before for anyone who preferred it.
export const ERAS = [
  { id: 'nineties', label: "'90s DIGITAL CABLE", transport: false, albumLine: false, vu: false, slideMs: 30000 },
  { id: 'twothousands', label: "'2000s MUSIC CHOICE", transport: false, albumLine: true, vu: false, slideMs: 30000 },
  { id: 'modern', label: 'MODERN (PROGRESS BAR + UP NEXT)', transport: true, albumLine: true, vu: true, slideMs: 12000 },
];
export const DEFAULT_ERA = 'twothousands';

export function eraFor(settings) {
  const id = (settings && settings.era) || DEFAULT_ERA;
  return ERAS.find((e) => e.id === id) || ERAS.find((e) => e.id === DEFAULT_ERA);
}

// Music Choice colour-coded its on-screen theme by daypart (its own
// description of the pre-2021 graphics package), so the same station reads
// warmer in the morning and cooler late at night. Pure function of the
// timestamp, like everything else here, so a time-machine scrub to 3am gets
// the 3am treatment.
export const DAYPARTS = [
  { id: 'morning', label: 'MORNING', startHour: 5, tint: 'rgba(255, 176, 92, 0.10)' },
  { id: 'day', label: 'DAYTIME', startHour: 11, tint: 'rgba(255, 255, 255, 0.06)' },
  { id: 'evening', label: 'EVENING', startHour: 17, tint: 'rgba(120, 86, 255, 0.12)' },
  { id: 'night', label: 'OVERNIGHT', startHour: 21, tint: 'rgba(0, 40, 120, 0.20)' },
];

export function daypartFor(nowMs) {
  const hour = new Date(nowMs).getHours();
  // Walk backwards so the first match is the latest start hour at or below
  // `hour`; anything earlier than the first start hour belongs to the
  // overnight block that began the previous evening.
  for (let i = DAYPARTS.length - 1; i >= 0; i--) {
    if (hour >= DAYPARTS[i].startHour) return DAYPARTS[i];
  }
  return DAYPARTS[DAYPARTS.length - 1];
}

// ---------- Filename metadata ----------
// There is no ID3 reader in this app, so artist/title/album/year come from
// the path. Handles the shapes personal rips actually come in:
//   Artist - Title.mp3
//   03 - Artist - Title.mp3
//   Artist - Album - 03 - Title.mp3
//   Artist - Title (1997).mp3
//   <Artist>/<Album>/03 Title.mp3     (folders as the last resort)
// Anything it cannot work out stays null rather than being guessed, so the
// UI omits that line instead of printing something wrong.
const YEAR_RE = /[([]\s*((?:19|20)\d{2})\s*[)\]]\s*$/;
const LEADING_TRACK_NO_RE = /^\d{1,3}\s*[-._)\]]?\s+/;

export function parseTrackMeta(filePath) {
  const norm = String(filePath || '').replace(/\\/g, '/');
  const segments = norm.split('/').filter(Boolean);
  const base = (segments.pop() || '').replace(/\.[^.]+$/, '');
  const folderAlbum = segments.length ? segments[segments.length - 1] : null;
  const folderArtist = segments.length > 1 ? segments[segments.length - 2] : null;

  let cleaned = base.replace(/_+/g, ' ').trim();
  let year = null;
  const yearMatch = cleaned.match(YEAR_RE);
  if (yearMatch) {
    year = yearMatch[1];
    cleaned = cleaned.slice(0, yearMatch.index).trim();
  }
  cleaned = cleaned.replace(LEADING_TRACK_NO_RE, '').trim();

  const parts = cleaned.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  let artist = null;
  let title = null;
  let album = null;
  if (parts.length >= 3) {
    // Artist - Album - [track] - Title. A track number only got stripped
    // above when it led the whole name, so drop a purely numeric middle
    // segment here too.
    artist = parts[0];
    title = parts[parts.length - 1];
    album = parts.slice(1, -1).filter((p) => !/^\d{1,3}$/.test(p)).join(' - ') || null;
  } else if (parts.length === 2) {
    artist = parts[0];
    title = parts[1];
  } else {
    title = parts[0] || null;
  }

  // Folders are only trustworthy as metadata under the <Artist>/<Album>/track
  // convention, which is exactly the case where the filename alone gave no
  // artist. Reading them whenever they merely exist turns a flat
  // "C:/Music/Oasis - Wonderwall (1995).mp3" into album "Music", which is
  // worse than showing no album at all. A drive root is never a name.
  const nameable = (seg) => seg && !/^[A-Za-z]:$/.test(seg) && seg.trim();
  if (!artist && nameable(folderArtist)) {
    artist = folderArtist.replace(/_+/g, ' ').trim();
    if (!album && nameable(folderAlbum) && folderAlbum !== folderArtist) {
      album = folderAlbum.replace(/_+/g, ' ').trim();
    }
  }
  if (album) {
    const albumYear = album.match(YEAR_RE);
    if (albumYear) {
      if (!year) year = albumYear[1];
      album = album.slice(0, albumYear.index).trim();
    }
  }
  return {
    artist: artist ? artist.toUpperCase() : 'UNKNOWN ARTIST',
    title: title || 'UNTITLED',
    album: album || null,
    year: year || null,
  };
}

// A saved track record may carry hand-set fields; fall back to the filename.
export function trackMetaOf(track) {
  const parsed = parseTrackMeta(track.path);
  return {
    artist: track.artist || parsed.artist,
    title: track.title || parsed.title,
    album: track.album || parsed.album,
    year: track.year || parsed.year,
  };
}

// Kept as the old two-field shape because settings.js and every saved track
// record still speak it; parseTrackMeta above is the full version.
export function parseArtistTitle(filePath) {
  const meta = parseTrackMeta(filePath);
  return { artist: meta.artist, title: meta.title };
}

// ---------- Album art ----------
// The 2000s on-screen slide carried the album cover, so a library that has
// one should show it. Two sources, cheapest first:
//
//   1. A sidecar image beside the audio file — the "cover.jpg next to the
//      album" convention every ripper and tagger writes. Found by simply
//      trying to load each candidate and taking the first that decodes, so
//      it needs no filesystem access from the renderer at all.
//   2. Artwork embedded in the track's own tags, read in the main process
//      (embedded-art.js) and handed back as a data URL.
//
// The order matters: (1) is a handful of path checks the browser answers
// from cache, while (2) reads the whole audio file. Most libraries hit (1).
const ART_BASENAMES = ['cover', 'folder', 'front', 'albumart'];
const ART_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

// Split in two because they cache differently: a file named after the track
// belongs to that track alone, while a generic cover belongs to the whole
// folder and every other track in it resolves to the same answer.
export function albumArtCandidates(trackPath) {
  const norm = String(trackPath || '').replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  if (slash < 0) return { dir: null, trackArt: [], folderArt: [] };
  const dir = norm.slice(0, slash);
  const base = norm.slice(slash + 1).replace(/\.[^.]+$/, '');
  return {
    dir,
    // Someone who put "03 Roads.jpg" next to "03 Roads.mp3" meant that one
    // specifically, so it outranks a generic album cover.
    trackArt: ART_EXTENSIONS.map((ext) => `${dir}/${base}.${ext}`),
    folderArt: ART_BASENAMES.flatMap((name) => ART_EXTENSIONS.map((ext) => `${dir}/${name}.${ext}`)),
  };
}

// `null` is a real cached answer ("looked, found nothing"), so every read
// goes through has() rather than a truthiness check — otherwise a folder
// with no art re-probes every candidate on each track change.
const trackArtCache = new Map();
const folderArtCache = new Map();

function probeImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img.naturalWidth > 0), { once: true });
    img.addEventListener('error', () => resolve(false), { once: true });
    img.src = url;
  });
}

async function firstLoadable(paths) {
  for (const candidate of paths) {
    // eslint-disable-next-line no-await-in-loop
    const url = await window.api.toFileUrl(candidate).catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    if (url && await probeImage(url)) return url;
  }
  return null;
}

export async function resolveAlbumArt(trackPath) {
  if (trackArtCache.has(trackPath)) return trackArtCache.get(trackPath);
  const { dir, trackArt, folderArt } = albumArtCandidates(trackPath);
  if (!dir) return null;

  let found = await firstLoadable(trackArt);
  if (!found) {
    if (folderArtCache.has(dir)) {
      found = folderArtCache.get(dir);
    } else {
      found = await firstLoadable(folderArt);
      folderArtCache.set(dir, found);
    }
  }
  // Only now go to the file's own tags. Sidecar images are a cheap path
  // check; reading a tag means the main process reads the whole audio file
  // and hands back the image as base64, so it is worth doing last and worth
  // caching per track. Unlike a folder cover, embedded art is genuinely
  // per-track, so there is nothing to share across the album here.
  if (!found && window.api && window.api.musicChoiceEmbeddedArt) {
    const result = await window.api.musicChoiceEmbeddedArt({ filePath: trackPath }).catch(() => null);
    if (result && result.art) found = result.art;
  }
  trackArtCache.set(trackPath, found || null);
  return found || null;
}

// ---------- The rotating info strip ----------
// The piece of Music Choice's on-screen grammar this plugin was missing: a
// strip that cycles every ~30s rather than one static readout. Built fresh
// each tick from whatever is actually available and indexed off the
// timestamp, so it is a pure function of (inputs, now) like the playback
// math — a time-machine scrub lands on the slide it would have shown live.
//
// Deliberately no shipped stock of "Did You Know?" facts: inventing music
// trivia would put fabricated claims on screen as though they were true. The
// default rotation is built from things this app can actually verify about
// the user's own library; real factoids are whatever the user types into
// settings.
export function buildInfoSlides(station, settings, pb) {
  const slides = [];
  ((settings && settings.factoids) || []).forEach((text) => {
    const trimmed = String(text || '').trim();
    if (trimmed) slides.push({ kind: 'factoid', label: 'DID YOU KNOW?', text: trimmed });
  });
  const trackCount = station ? (station.tracks || []).length : 0;
  if (trackCount) {
    slides.push({
      kind: 'station',
      label: 'ON THIS CHANNEL',
      text: `${station.name || 'THIS STATION'} — ${trackCount} TRACK${trackCount === 1 ? '' : 'S'} IN ROTATION, COMMERCIAL FREE`,
    });
  }
  if (pb && pb.nextTrack && pb.totalTracks > 1) {
    const next = trackMetaOf(pb.nextTrack);
    slides.push({ kind: 'coming', label: 'ALSO ON THIS CHANNEL', text: `${next.artist} — ${next.title}` });
  }
  return slides;
}

export function resolveInfoSlide(slides, nowMs, rotateMs) {
  if (!slides.length) return null;
  const period = rotateMs > 0 ? rotateMs : 30000;
  return slides[Math.floor(nowMs / period) % slides.length];
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
// same reasoning as everything else in this file using viewNow(). The
// interval comes from the era: the real freeze-frame slides held for about
// thirty seconds, not the twelve this used to use.
let lastSlideshowIndex = -1;
function updateSlideshow(station, nowMs, era) {
  if (!els || (station.background && station.background.mode) !== 'slideshow') return;
  const images = (station.background && station.background.images) || [];
  if (!images.length) { els.slideshowImgA.removeAttribute('src'); return; }
  const idx = Math.floor(nowMs / era.slideMs) % images.length;
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

// Resolving art hits the disk, so it runs only when the track actually
// changes, not on every one-second tick. The guard on the way back covers
// the case where the song moved on (or the channel was left) while the
// probe was still running.
let artTrackPath = null;
function updateAlbumArt(trackPath) {
  if (!els || trackPath === artTrackPath) return;
  artTrackPath = trackPath;
  els.artEl.classList.add('hidden');
  resolveAlbumArt(trackPath).then((url) => {
    if (!els || artTrackPath !== trackPath) return;
    if (!url) { els.artEl.removeAttribute('src'); return; }
    els.artEl.src = url;
    els.artEl.classList.remove('hidden');
  });
}

function updateNowPlayingUi(pb, era) {
  if (!els) return;
  const meta = trackMetaOf(pb.track);
  els.artistEl.textContent = meta.artist;
  els.titleEl.textContent = meta.title;
  updateAlbumArt(pb.track.path);

  // ALBUM (YEAR) — the two fields the real on-screen slide carried that this
  // plugin never showed. Only rendered when the filename actually yielded
  // them, and only in the eras that displayed them.
  const albumParts = [];
  if (meta.album) albumParts.push(meta.album);
  if (meta.year) albumParts.push(`(${meta.year})`);
  const albumText = era.albumLine ? albumParts.join(' ') : '';
  els.albumEl.textContent = albumText;
  els.albumEl.classList.toggle('hidden', !albumText);

  // The transport readout is a modern affordance — no cable audio service
  // ever put a progress bar or an up-next line on screen (see the ERAS
  // comment above), so the period eras simply do not build one.
  els.transportEl.classList.toggle('hidden', !era.transport);
  els.upNextEl.classList.toggle('hidden', !era.transport);
  if (!era.transport) return;
  els.elapsedEl.textContent = formatClock(pb.offsetSec);
  els.durationEl.textContent = formatClock(pb.track.durationSec);
  const pct = pb.track.durationSec ? Math.min(100, (pb.offsetSec / pb.track.durationSec) * 100) : 0;
  els.progressFillEl.style.width = `${pct}%`;
  const nextMeta = trackMetaOf(pb.nextTrack);
  els.upNextEl.textContent = pb.totalTracks > 1
    ? `UP NEXT: ${nextMeta.artist} – ${nextMeta.title}`
    : '';
}

// The bottom strip. Only the text swaps; the strip itself stays put, which
// is how the real thing behaved — the now-playing readout is persistent and
// the secondary information beneath it is what rotates.
let lastInfoSlideText = null;
function updateInfoStrip(station, settings, pb, era, nowMs) {
  if (!els) return;
  const slide = resolveInfoSlide(buildInfoSlides(station, settings, pb), nowMs, era.slideMs);
  if (!slide) {
    els.infoStripEl.classList.add('hidden');
    lastInfoSlideText = null;
    return;
  }
  els.infoStripEl.classList.remove('hidden');
  if (slide.text === lastInfoSlideText) return;
  lastInfoSlideText = slide.text;
  els.infoLabelEl.textContent = slide.label;
  els.infoTextEl.textContent = slide.text;
  // Restart the fade rather than letting a repeated class add be a no-op.
  els.infoStripEl.classList.remove('mc-info-enter');
  void els.infoStripEl.offsetWidth;
  els.infoStripEl.classList.add('mc-info-enter');
}

function applyEraAndDaypart(settings, nowMs) {
  if (!els) return eraFor(settings);
  const era = eraFor(settings);
  const daypart = daypartFor(nowMs);
  els.root.dataset.era = era.id;
  els.root.dataset.daypart = daypart.id;
  els.root.style.setProperty('--mc-daypart-tint', daypart.tint);
  els.vuEl.classList.toggle('hidden', !era.vu);
  return era;
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
  const nowMs = ctx.viewNow();
  const era = applyEraAndDaypart(settings, nowMs);
  els.stationNameEl.textContent = station.name || 'UNTITLED STATION';
  const pb = computeStationPlayback(station, nowMs);
  if (!pb) {
    els.nowPlayingEl.classList.add('hidden');
    els.infoStripEl.classList.add('hidden');
    els.probeHintEl.textContent = (station.tracks || []).length
      ? 'DURATIONS NOT YET PROBED — RESCAN THIS STATION IN SETTINGS'
      : 'NO TRACKS YET — CHOOSE A FOLDER AND RESCAN THIS STATION IN SETTINGS';
    els.probeHintEl.classList.remove('hidden');
    return;
  }
  els.nowPlayingEl.classList.remove('hidden');
  els.probeHintEl.classList.add('hidden');
  // While the time machine is actively shuttling, the scrubbed instant moves
  // by minutes per tick — reloading and re-seeking the audio each second
  // would just thrash the decoder for something nobody can listen to anyway.
  // The readout keeps tracking, and the next tick after the shuttle stops
  // loads whatever is actually playing at the committed instant.
  const shuttling = !!(window.S && window.S.shuttleDir);
  if (shuttling) {
    updateNowPlayingUi(pb, era);
    updateInfoStrip(station, settings, pb, era, nowMs);
    return;
  }
  if (currentLoadedTrackPath !== pb.track.path) {
    loadTrack(ctx, station, pb);
  } else if (Math.abs(ctx.player.currentTime - pb.offsetSec) > 2.5) {
    // Drift correction (a paused/backgrounded tab, a time-machine scrub,
    // clock skew) — resync without a full reload/re-buffer.
    ctx.player.currentTime = pb.offsetSec;
  }
  updateNowPlayingUi(pb, era);
  updateInfoStrip(station, settings, pb, era, nowMs);
  updateSlideshow(station, nowMs, era);
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
  // computeStationPlayback is a pure function of (station, timestamp), so
  // scrubbing needs nothing extra here — tick() already re-derives from
  // ctx.viewNow() every second and will land on whatever this station would
  // have been playing at the shifted instant. See virtual.js's
  // virtualChannelSupportsTimeMachine for the core side of this opt-in.
  supportsTimeMachine: true,
  timeMachineNowText(nowMs) {
    const station = selectedStation();
    if (!station) return '';
    const pb = computeStationPlayback(station, nowMs);
    if (!pb) return station.name || '';
    const meta = trackMetaOf(pb.track);
    return `${meta.artist} — ${meta.title}`;
  },
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
          <div class="mc-daypart-wash"></div>
          <div class="mc-vu hidden" data-el="vu"><span></span><span></span><span></span><span></span><span></span></div>
        </div>
        <div class="mc-chrome">
          <div class="mc-bug">
            <div class="mc-bug-brand">MUSIC CHOICE</div>
            <div class="mc-bug-station" data-el="station-name">&nbsp;</div>
            <div class="mc-bug-meta">
              <span class="mc-chnum">CH ${CHANNEL_NUMBER}</span>
              <span class="mc-stereo">◆ DIGITAL STEREO</span>
            </div>
          </div>
          <div class="mc-empty hidden" data-el="empty">
            <div class="mc-empty-title">NO STATIONS CONFIGURED</div>
            <div class="mc-empty-body">Add a station and point it at a music folder in PLUGINS &rarr; MUSIC CHOICE CHANNEL settings.</div>
          </div>
          <div class="mc-probe-hint hidden" data-el="probe-hint">DURATIONS NOT YET PROBED — RESCAN THIS STATION IN SETTINGS</div>
          <div class="mc-now-playing hidden" data-el="now-playing">
            <img class="mc-art hidden" data-el="art" alt="">
            <div class="mc-now-copy">
            <div class="mc-nowlabel">NOW PLAYING</div>
            <div class="mc-artist" data-el="artist"></div>
            <div class="mc-title" data-el="title"></div>
            <div class="mc-album hidden" data-el="album"></div>
            <div class="mc-progress-row hidden" data-el="transport">
              <span data-el="elapsed">0:00</span>
              <div class="mc-progress-bar"><div class="mc-progress-fill" data-el="progress-fill"></div></div>
              <span data-el="duration">0:00</span>
            </div>
            <div class="mc-upnext hidden" data-el="up-next"></div>
            <div class="mc-info-strip hidden" data-el="info-strip">
              <span class="mc-info-label" data-el="info-label"></span>
              <span class="mc-info-text" data-el="info-text"></span>
            </div>
            </div>
          </div>
          <div class="mc-hint">◀▶ CHANGE STATION &middot; OK STATION LIST &middot; ▲▼ CHANGE CHANNEL</div>
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
      albumEl: q('album'), artEl: q('art'), transportEl: q('transport'),
      elapsedEl: q('elapsed'), durationEl: q('duration'), progressFillEl: q('progress-fill'),
      upNextEl: q('up-next'), vuEl: q('vu'),
      infoStripEl: q('info-strip'), infoLabelEl: q('info-label'), infoTextEl: q('info-text'),
      browserEl: q('browser'), browserListEl: q('browser-list'),
    };

    const settings = getSettings();
    const stations = settings.stations || [];
    // Era/daypart before the empty-state bail-out, so even the "no stations"
    // card is painted in the right period treatment.
    applyEraAndDaypart(settings, ctx.viewNow());
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
    lastInfoSlideText = null;
    artTrackPath = null;
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
  // A plugin channel's onKey runs before core's own handler and a `true`
  // return swallows the key outright (app.js), so anything claimed here is
  // simply gone while this channel is tuned. Two things were wrong with
  // that:
  //
  //   - Up/Down are core's CHANGE CHANNEL keys. Claiming them for station
  //     cycling meant you could tune INTO 910 and then never tune out of it
  //     with the keys anyone would reach for.
  //   - The station browser returned true for every key it did not handle,
  //     which took out direct channel entry, the guide, setup and power as
  //     well, leaving Escape as the only way out of a full-screen list.
  //
  // Station cycling now lives on Left/Right, which core only uses to shuttle
  // and only while the time machine is on — so that case defers too. Nothing
  // else is claimed, in either state.
  onKey(key, ctx) {
    if (browserOpen) {
      if (key === 'ArrowUp') { browserMove(ctx, -1); return true; }
      if (key === 'ArrowDown') { browserMove(ctx, 1); return true; }
      if (key === 'Enter' || key === ' ') { if (browserHighlightId) switchToStation(ctx, browserHighlightId); closeBrowser(); return true; }
      if (key === 'Escape') { closeBrowser(); return true; }
      // Anything this list does not itself use belongs to core. Close first,
      // so tuning away or opening the guide does not leave the browser up
      // behind whatever the key actually did.
      closeBrowser();
      return false;
    }
    if (window.S && window.S.timeMachineOn) return false;
    if (key === 'ArrowLeft') { cycleStation(ctx, -1); return true; }
    if (key === 'ArrowRight') { cycleStation(ctx, 1); return true; }
    return false;
  },
});
