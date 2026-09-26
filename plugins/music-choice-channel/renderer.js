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

// A saved track record may carry hand-set fields, then whatever its own tags
// said (read on rescan — see tags.js), then what the filename says.
export function trackMetaOf(track) {
  const parsed = parseTrackMeta(track.path);
  const tags = track.tags || {};
  const artist = track.artist || tags.artist;
  return {
    artist: artist ? String(artist).toUpperCase() : parsed.artist,
    title: track.title || tags.title || parsed.title,
    album: track.album || tags.album || parsed.album,
    year: track.year || tags.year || parsed.year,
    albumArtist: tags.albumArtist ? String(tags.albumArtist).toUpperCase() : null,
  };
}

// ---------- Library search ----------
// Everything here is pure over the stations' saved track lists, so it can be
// tested without a DOM and never touches the live rotation's math.

// Lower-case, accents off, punctuation to spaces: "Beyoncé" finds "beyonce",
// "AC/DC" finds "ac dc".
export function normalizeForSearch(text) {
  return String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "1997", "1990s", "90s", "'90s", "1995-1999", "1995 to 1999" -> an inclusive
// year range. Anything else is not a year query and returns null.
export function parseYearQuery(query) {
  const q = String(query || '').trim().toLowerCase().replace(/[‘’]/g, "'");
  let m = q.match(/^((?:19|20)\d{2})$/);
  if (m) return { from: Number(m[1]), to: Number(m[1]) };
  m = q.match(/^((?:19|20)\d)0'?s$/);
  if (m) return { from: Number(`${m[1]}0`), to: Number(`${m[1]}9`) };
  m = q.match(/^'?(\d)0'?s$/);
  if (m) {
    const decade = Number(m[1]) >= 3 ? 1900 + Number(m[1]) * 10 : 2000 + Number(m[1]) * 10;
    return { from: decade, to: decade + 9 };
  }
  m = q.match(/^((?:19|20)\d{2})\s*(?:-|–|to)\s*((?:19|20)\d{2})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return { from: Math.min(a, b), to: Math.max(a, b) };
  }
  return null;
}

// One entry per distinct file across every station (a song in two stations'
// folders is still one song), with its metadata resolved once.
export function buildLibraryIndex(stations) {
  const seen = new Set();
  const index = [];
  (stations || []).forEach((station) => {
    (station.tracks || []).forEach((track) => {
      if (!track || !track.path || seen.has(track.path)) return;
      seen.add(track.path);
      const meta = trackMetaOf(track);
      index.push({
        track,
        meta,
        stationId: station.id,
        artistKey: normalizeForSearch(meta.artist),
        albumKey: normalizeForSearch(meta.album),
        haystack: normalizeForSearch([meta.artist, meta.albumArtist, meta.title, meta.album, meta.year].filter(Boolean).join(' ')),
      });
    });
  });
  return index;
}

function matchesWords(haystack, words) {
  return words.every((w) => haystack.includes(w));
}

// Album order is file order, which is track-number order for any sensibly
// named rip; everything else sorts artist -> album -> file.
function byArtistAlbumPath(a, b) {
  return a.artistKey.localeCompare(b.artistKey)
    || a.albumKey.localeCompare(b.albumKey)
    || a.track.path.localeCompare(b.track.path);
}

function groupRows(entries, keyOf, rowOf) {
  const groups = new Map();
  entries.forEach((entry) => {
    const key = keyOf(entry);
    if (key == null) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });
  return [...groups.entries()].map(([key, members]) => rowOf(key, members.sort(byArtistAlbumPath)));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 'S'}`;
}

export const SEARCH_TABS = [
  { id: 'stations', label: 'STATIONS' },
  { id: 'songs', label: 'SONGS' },
  { id: 'artists', label: 'ARTISTS' },
  { id: 'albums', label: 'ALBUMS' },
  { id: 'years', label: 'YEARS' },
];

// Rows for one search tab: { label, sub, tracks } where `tracks` is the play
// queue picking that row starts. A song row's queue is every song result from
// that one on, so picking a song from an artist search keeps playing that
// artist.
export function searchLibrary(index, query, tab) {
  const words = normalizeForSearch(query).split(' ').filter(Boolean);
  const years = parseYearQuery(query);
  const inYears = (entry) => {
    const y = Number(entry.meta.year);
    return !!years && y >= years.from && y <= years.to;
  };

  if (tab === 'songs') {
    const hits = index.filter((e) => !words.length || inYears(e) || matchesWords(e.haystack, words)).sort(byArtistAlbumPath);
    const queue = hits.map((h) => h.track);
    return hits.map((e, i) => ({
      label: e.meta.title,
      sub: [e.meta.artist, e.meta.album, e.meta.year].filter(Boolean).join(' · '),
      tracks: queue.slice(i),
    }));
  }

  if (tab === 'artists') {
    const hits = index.filter((e) => !words.length || matchesWords(normalizeForSearch(`${e.meta.artist} ${e.meta.albumArtist || ''}`), words));
    return groupRows(hits, (e) => e.meta.artist, (artist, members) => {
      const albums = new Set(members.map((m) => m.meta.album).filter(Boolean));
      return {
        label: artist,
        sub: [albums.size ? plural(albums.size, 'ALBUM') : null, plural(members.length, 'SONG')].filter(Boolean).join(' · '),
        tracks: members.map((m) => m.track),
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
  }

  if (tab === 'albums') {
    const hits = index.filter((e) => e.meta.album && (!words.length || inYears(e)
      || matchesWords(normalizeForSearch(`${e.meta.album} ${e.meta.artist} ${e.meta.albumArtist || ''}`), words)));
    return groupRows(hits, (e) => `${normalizeForSearch(e.meta.albumArtist || e.meta.artist)}\u0000${e.albumKey}`, (key, members) => {
      const first = members[0].meta;
      const year = members.map((m) => m.meta.year).find(Boolean);
      return {
        label: first.album,
        artist: first.albumArtist || first.artist,
        sub: [first.albumArtist || first.artist, year, plural(members.length, 'SONG')].filter(Boolean).join(' · '),
        tracks: members.map((m) => m.track),
      };
    }).sort((a, b) => a.artist.localeCompare(b.artist) || a.label.localeCompare(b.label));
  }

  if (tab === 'years') {
    const hits = index.filter((e) => e.meta.year && (!words.length || (years ? inYears(e) : matchesWords(e.haystack, words))));
    const byYear = groupRows(hits, (e) => String(e.meta.year), (year, members) => ({
      label: year, order: Number(year), sub: plural(members.length, 'SONG'), tracks: members.map((m) => m.track),
    }));
    // Each decade gets a "whole decade" row ahead of its own years: the
    // natural way to ask a music channel for "the '90s" from a remote.
    const decades = groupRows(hits, (e) => String(Math.floor(Number(e.meta.year) / 10) * 10), (decade, members) => ({
      label: `THE ${decade}s`, order: Number(decade) - 0.5, sub: `WHOLE DECADE · ${plural(members.length, 'SONG')}`, tracks: members.map((m) => m.track),
    }));
    return [...decades, ...byYear].sort((a, b) => a.order - b.order);
  }
  return [];
}

// Where a paused live rotation carries on from: the rest of the loop, starting
// with the song that was playing, in rotation order.
export function rotationQueueFrom(station, pb) {
  const tracks = (station && station.tracks || []).filter((t) => t.durationSec > 0);
  if (!tracks.length || !pb) return [];
  return tracks.slice(pb.index).concat(tracks.slice(0, pb.index));
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
let endedHandler = null;
let errorHandler = null;
let bgVideoPath = null; // avoid re-setting the same <video> src every tick (restarts playback)

// The browser (OK): station list plus library search, one tab each.
let browserOpen = false;
let browserTab = 'stations';
let browserQuery = '';
// Row index in browserRows; -1 is the search field itself, which only exists
// as a row in TV mode (a remote reaches it with ▲ and opens the on-screen
// keyboard with OK). On a keyboard the field simply has focus.
let browserCursor = 0;
let browserRows = [];
let libraryIndex = null;

// ---------- On demand ----------
// The live rotation is a pure function of (station, now) and cannot pause or
// seek — it is a broadcast. Pausing, seeking, skipping, or picking something
// from search steps OFF the broadcast into an on-demand session instead, the
// way digital cable's Music Choice On Demand sat beside its linear channels.
// While it lasts the player's own clock is the truth, not viewNow(): that is
// the whole point of it. Leaving it (Back/L, the end of the list, a station
// pick, the time machine) drops straight back onto the live rotation, which
// has kept "playing" the whole time.
//
//   { queue: [track], index, label, paused }
let od = null;
let flashText = null;
let flashTimer = null;
// Guards a hardware media key arriving both as a keydown and through the OS
// media session, which would otherwise pause and immediately resume.
let lastPauseChangeAt = 0;

function isTvMode() {
  return document.documentElement.dataset.mode === 'tv';
}

function flash(text) {
  flashText = text;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flashText = null; flashTimer = null; }, 1400);
}

// The one place playback actually switches to a different station — anchors
// a never-tuned station to "now" (so its loop math has a starting point),
// applies its theme/background, and forces the next tick() to (re)load its
// current track. Called from a confirmed browser pick, the ▲/▼ quick-cycle,
// and settings.js right after a brand-new station is created.
function switchToStation(ctx, id) {
  od = null;
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

// Tells the OS what song this is, so its media overlay reads right while
// this channel is tuned. Core sets the channel's own metadata on every tune.
let mediaSessionTrackPath = null;
function updateMediaSessionTrack(track, meta) {
  const ms = navigator.mediaSession;
  if (!ms || typeof window.MediaMetadata !== 'function' || mediaSessionTrackPath === track.path) return;
  mediaSessionTrackPath = track.path;
  try {
    ms.metadata = new window.MediaMetadata({ title: meta.title, artist: meta.artist, album: meta.album || `MUSIC CHOICE · CH ${CHANNEL_NUMBER}` });
  } catch (e) { /* decoration only */ }
}

function updateNowPlayingUi(pb, era) {
  if (!els) return;
  const meta = trackMetaOf(pb.track);
  els.artistEl.textContent = meta.artist;
  els.titleEl.textContent = meta.title;
  updateAlbumArt(pb.track.path);
  updateMediaSessionTrack(pb.track, meta);

  let label = 'NOW PLAYING';
  if (od) label = od.paused ? '❚❚ PAUSED · ON DEMAND' : '▶ ON DEMAND';
  els.nowLabelEl.textContent = flashText || label;
  els.root.dataset.ondemand = od ? (od.paused ? 'paused' : 'playing') : '';

  // ALBUM (YEAR) — the two fields the real on-screen slide carried that this
  // plugin never showed. Only rendered when the filename actually yielded
  // them, and only in the eras that displayed them. On demand always shows
  // it: that screen was a menu pick, not the freeze-frame broadcast.
  const albumParts = [];
  if (meta.album) albumParts.push(meta.album);
  if (meta.year) albumParts.push(`(${meta.year})`);
  const albumText = (era.albumLine || od) ? albumParts.join(' ') : '';
  els.albumEl.textContent = albumText;
  els.albumEl.classList.toggle('hidden', !albumText);

  // The transport readout is a modern affordance — no cable audio service
  // ever put a progress bar or an up-next line on the broadcast (see the ERAS
  // comment above), so the period eras do not build one live. On demand is
  // different: you are seeking, so you need to see where you are.
  const transport = era.transport || !!od;
  els.transportEl.classList.toggle('hidden', !transport);
  els.upNextEl.classList.toggle('hidden', !transport);
  if (!transport) return;
  els.elapsedEl.textContent = formatClock(pb.offsetSec);
  els.durationEl.textContent = formatClock(pb.track.durationSec);
  const pct = pb.track.durationSec ? Math.min(100, (pb.offsetSec / pb.track.durationSec) * 100) : 0;
  els.progressFillEl.style.width = `${pct}%`;
  const nextMeta = pb.nextTrack ? trackMetaOf(pb.nextTrack) : null;
  if (od) {
    els.upNextEl.textContent = nextMeta ? `NEXT: ${nextMeta.artist} – ${nextMeta.title}` : 'LAST SONG — THEN BACK TO THE LIVE CHANNEL';
  } else {
    els.upNextEl.textContent = pb.totalTracks > 1 && nextMeta ? `UP NEXT: ${nextMeta.artist} – ${nextMeta.title}` : '';
  }
}

function updateHint() {
  if (!els) return;
  const tv = isTvMode();
  let text;
  if (od) {
    text = tv
      ? '◀▶ SEEK · ⏯ PLAY/PAUSE · ⏮⏭ SONG · OK SEARCH · BACK LIVE'
      : '◀▶ SEEK · SPACE PLAY/PAUSE · [ ] SONG · OK SEARCH · L BACK TO LIVE';
  } else {
    text = tv
      ? '◀▶ CHANGE STATION · OK SEARCH & STATIONS · ⏯ PAUSE · ▲▼ CHANGE CHANNEL'
      : '◀▶ CHANGE STATION · OK SEARCH & STATIONS · SPACE PAUSE · ▲▼ CHANGE CHANNEL';
  }
  if (els.hintEl.textContent !== text) els.hintEl.textContent = text;
}

// The bottom strip. Only the text swaps; the strip itself stays put, which
// is how the real thing behaved — the now-playing readout is persistent and
// the secondary information beneath it is what rotates.
let lastInfoSlideText = null;
function updateInfoStrip(station, settings, pb, era, nowMs) {
  showInfoSlide(resolveInfoSlide(buildInfoSlides(station, settings, pb), nowMs, era.slideMs));
}

function showInfoSlide(slide) {
  if (!els) return;
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
  updateHint();
  // The time machine is about the broadcast; an on-demand session has no
  // place in it, so scrubbing drops back to the live rotation.
  if (od && window.S && window.S.timeMachineOn) {
    od = null;
    currentLoadedTrackPath = null;
    updateHint();
  }
  if (od) {
    els.stationNameEl.textContent = 'ON DEMAND';
    tickOnDemand(ctx, era);
    return;
  }
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

function tickOnDemand(ctx, era) {
  const track = od.queue[od.index];
  const p = ctx.player;
  const durationSec = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : (track.durationSec || 0);
  els.nowPlayingEl.classList.remove('hidden');
  els.probeHintEl.classList.add('hidden');
  updateNowPlayingUi({
    track: { ...track, durationSec },
    offsetSec: currentLoadedTrackPath === track.path ? (p.currentTime || 0) : 0,
    nextTrack: od.queue[od.index + 1] || null,
    totalTracks: od.queue.length,
  }, era);
  showInfoSlide({ kind: 'ondemand', label: 'ON DEMAND', text: `${od.label} — SONG ${od.index + 1} OF ${od.queue.length}` });
}

function loadOnDemandTrack(ctx, startSec) {
  const session = od;
  const track = session.queue[session.index];
  currentLoadedTrackPath = track.path;
  window.api.toFileUrl(track.path).then((url) => {
    if (od !== session || session.queue[session.index] !== track || window.S.currentNumber !== CHANNEL_NUMBER) return;
    ctx.player.loop = false;
    ctx.player.src = url;
    ctx.player.load();
    const onMeta = () => {
      ctx.player.removeEventListener('loadedmetadata', onMeta);
      if (startSec > 0) ctx.player.currentTime = startSec;
      tick(ctx);
    };
    ctx.player.addEventListener('loadedmetadata', onMeta);
    if (!session.paused) ctx.player.play().catch(() => {});
  });
}

// Starts a session on `queue` (a search pick). Returns false for an empty one.
function startOnDemand(ctx, queue, label) {
  if (!queue || !queue.length) return false;
  od = { queue, index: 0, label, paused: false };
  loadOnDemandTrack(ctx, 0);
  flash('▶ ON DEMAND');
  tick(ctx);
  return true;
}

// Steps off the live rotation at exactly the song and second it was on, so
// pausing or seeking a broadcast carries on from where you were rather than
// restarting anything. The queue is the rest of the loop in rotation order.
function enterOnDemandFromLive(ctx, paused) {
  const station = selectedStation();
  const pb = station && computeStationPlayback(station, ctx.viewNow());
  if (!pb) return false;
  const loaded = currentLoadedTrackPath === pb.track.path;
  od = { queue: rotationQueueFrom(station, pb), index: 0, label: station.name || 'THIS STATION', paused };
  if (!loaded) loadOnDemandTrack(ctx, pb.offsetSec);
  else if (paused) ctx.player.pause();
  return true;
}

function setPaused(ctx, paused) {
  if (!od) {
    if (!paused || !enterOnDemandFromLive(ctx, true)) return false;
  } else {
    od.paused = paused;
    if (paused) ctx.player.pause();
    else ctx.player.play().catch(() => {});
  }
  lastPauseChangeAt = performance.now();
  tick(ctx);
  return true;
}

// For the paths a single hardware key can arrive on twice (a keydown and the
// OS media session): the second one inside the window is the same press.
function pressedRecently() {
  return performance.now() - lastPauseChangeAt < 400;
}

function togglePause(ctx) {
  if (pressedRecently()) return true;
  return setPaused(ctx, !(od && od.paused));
}

function seekBy(ctx, deltaSec) {
  if (!od && !enterOnDemandFromLive(ctx, false)) return false;
  const p = ctx.player;
  const track = od.queue[od.index];
  const duration = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : (track.durationSec || 0);
  let target = (p.currentTime || 0) + deltaSec;
  if (duration) target = Math.min(target, Math.max(0, duration - 1));
  p.currentTime = Math.max(0, target);
  flash(deltaSec < 0 ? `◀◀ ${Math.abs(deltaSec)} SEC` : `▶▶ ${deltaSec} SEC`);
  tick(ctx);
  return true;
}

function skipTrack(ctx, dir, auto) {
  if (!od && !enterOnDemandFromLive(ctx, false)) return false;
  // Previous means "start of this song" unless you are already near it, the
  // way every CD player's ⏮ behaves.
  if (dir < 0 && ((ctx.player.currentTime || 0) > 3 || od.index === 0)) {
    ctx.player.currentTime = 0;
    tick(ctx);
    return true;
  }
  const next = od.index + dir;
  if (next >= od.queue.length) {
    leaveOnDemand(ctx, 'BACK TO LIVE');
    return true;
  }
  od.index = next;
  if (auto) od.paused = false;
  loadOnDemandTrack(ctx, 0);
  if (!auto) flash(dir < 0 ? '⏮ PREVIOUS SONG' : '⏭ NEXT SONG');
  tick(ctx);
  return true;
}

function leaveOnDemand(ctx, message) {
  if (!od) return;
  od = null;
  currentLoadedTrackPath = null;
  if (message) flash(message);
  tick(ctx);
}

// The OS media keys and media overlay. Explicit play/pause handlers stop
// Chromium's default of toggling the element itself, which would pause the
// broadcast with nothing on screen saying so. Core keeps next/previous track
// as channel up/down (broadcast-fx.js's initMediaSession).
function bindMediaSession(ctx) {
  const ms = navigator.mediaSession;
  if (!ms || typeof ms.setActionHandler !== 'function') return;
  const bind = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (e) { /* unsupported */ } };
  bind('pause', () => { if (!pressedRecently()) setPaused(ctx, true); });
  bind('play', () => { if (!pressedRecently()) setPaused(ctx, false); });
  bind('seekbackward', () => seekBy(ctx, -10));
  bind('seekforward', () => seekBy(ctx, 10));
}

function unbindMediaSession() {
  const ms = navigator.mediaSession;
  if (!ms || typeof ms.setActionHandler !== 'function') return;
  ['pause', 'play', 'seekbackward', 'seekforward'].forEach((action) => {
    try { ms.setActionHandler(action, null); } catch (e) { /* unsupported */ }
  });
}

// A long result list is capped on screen; the count still says how many.
const MAX_ROWS = 300;

// Rows for the current tab. Each is { label, sub, right, swatch, active, run }.
function buildBrowserRows(ctx) {
  const settings = getSettings();
  const stations = settings.stations || [];
  if (browserTab === 'stations') {
    const rows = [];
    // Transport as rows too, so a remote with nothing but a D-pad and OK can
    // still pause, resume and go back to live.
    if (od) {
      rows.push({ label: od.paused ? '▶ RESUME' : '❚❚ PAUSE', sub: `ON DEMAND · ${od.label}`, run: () => setPaused(ctx, !od.paused) });
      rows.push({ label: '● BACK TO THE LIVE CHANNEL', sub: 'RETURN TO THE STATION ROTATION', run: () => leaveOnDemand(ctx, 'BACK TO LIVE') });
    } else if (selectedStation(settings) && computeStationPlayback(selectedStation(settings), ctx.viewNow())) {
      rows.push({ label: '❚❚ PAUSE THIS SONG', sub: 'THEN ◀▶ TO SEEK', run: () => setPaused(ctx, true) });
    }
    stations.forEach((station) => {
      const theme = themeFor(station);
      rows.push({
        label: station.name || 'UNTITLED STATION',
        sub: theme.label,
        right: plural((station.tracks || []).length, 'TRACK'),
        swatch: theme.accent,
        stationId: station.id,
        active: !od && station.id === settings.selectedStationId,
        run: () => switchToStation(ctx, station.id),
      });
    });
    return rows;
  }
  if (!libraryIndex) libraryIndex = buildLibraryIndex(stations);
  const tabLabel = (SEARCH_TABS.find((t) => t.id === browserTab) || {}).label || '';
  return searchLibrary(libraryIndex, browserQuery, browserTab).map((row) => ({
    label: row.label,
    sub: row.sub,
    right: browserTab === 'songs' ? '' : '▶ PLAY ALL',
    run: () => startOnDemand(ctx, row.tracks, browserTab === 'songs' ? `SEARCH: ${browserQuery.trim().toUpperCase() || 'ALL SONGS'}` : `${tabLabel.replace(/S$/, '')}: ${row.label}`),
  }));
}

function emptyMessage() {
  const anyTags = (libraryIndex || []).some((e) => e.track.tagsRead);
  if (browserTab === 'years' || browserTab === 'albums') {
    const word = browserTab === 'years' ? 'YEARS' : 'ALBUMS';
    if (!anyTags) return `NO ${word} FOUND YET — RESCAN YOUR STATIONS IN SETTINGS TO READ EACH SONG'S TAGS`;
  }
  return browserQuery.trim() ? `NOTHING MATCHES “${browserQuery.trim().toUpperCase()}”` : 'NO SONGS YET — ADD A STATION FOLDER IN SETTINGS';
}

function renderBrowser(ctx) {
  if (!els) return;
  browserRows = buildBrowserRows(ctx);
  const searching = browserTab !== 'stations';
  const minCursor = searching && isTvMode() ? -1 : 0;
  browserCursor = Math.max(minCursor, Math.min(browserCursor, browserRows.length - 1));

  els.browserTabsEl.querySelectorAll('[data-tab]').forEach((tabEl) => {
    tabEl.classList.toggle('mc-browser-tab-active', tabEl.dataset.tab === browserTab);
  });
  els.browserSearchEl.classList.toggle('hidden', !searching);
  els.browserSearchEl.classList.toggle('mc-browser-row-active', searching && browserCursor === -1);
  if (els.browserInputEl.value !== browserQuery) els.browserInputEl.value = browserQuery;
  els.browserCountEl.textContent = searching ? plural(browserRows.length, 'RESULT') : '';

  els.browserListEl.innerHTML = '';
  if (!browserRows.length && searching) {
    const empty = document.createElement('div');
    empty.className = 'mc-browser-empty';
    empty.textContent = emptyMessage();
    els.browserListEl.appendChild(empty);
  }
  browserRows.slice(0, MAX_ROWS).forEach((rowData, i) => {
    const row = document.createElement('div');
    row.className = 'mc-browser-row';
    if (i === browserCursor) row.classList.add('mc-browser-row-active');
    if (rowData.active) row.classList.add('mc-browser-row-current');
    const cell = (cls, text) => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text || '';
      row.appendChild(span);
      return span;
    };
    const swatch = cell('mc-browser-swatch', '');
    if (rowData.swatch) swatch.style.background = rowData.swatch;
    else swatch.classList.add('mc-browser-swatch-blank');
    cell('mc-browser-name', rowData.label);
    cell('mc-browser-genre', rowData.sub);
    cell('mc-browser-count', rowData.right);
    row.addEventListener('click', () => { browserCursor = i; activateBrowserRow(ctx); });
    els.browserListEl.appendChild(row);
  });
  const activeEl = els.browserListEl.querySelector('.mc-browser-row-active');
  if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });

  // On a keyboard the field just has focus while a search tab is up; in TV
  // mode it is a row the remote selects instead (see browserCursor).
  if (searching && !isTvMode()) {
    if (document.activeElement !== els.browserInputEl) els.browserInputEl.focus();
  } else if (document.activeElement === els.browserInputEl) {
    els.browserInputEl.blur();
  }
  els.browserHintEl.textContent = searching
    ? (isTvMode() ? '▲▼ SELECT · OK PLAY (OK ON THE SEARCH BOX TO TYPE) · ◀▶ TAB · BACK CLOSE' : 'TYPE TO SEARCH · ▲▼ SELECT · ENTER PLAY · ◀▶ TAB · ESC CLOSE')
    : '▲▼ SELECT · OK TUNE · ◀▶ SEARCH TABS · ESC CANCEL';
}

function openBrowser(ctx) {
  if (!els || !(getSettings().stations || []).length) return;
  browserOpen = true;
  browserTab = 'stations';
  libraryIndex = null; // rebuilt from the current settings on first search
  const firstStation = buildBrowserRows(ctx).findIndex((r) => r.active);
  browserCursor = Math.max(0, firstStation);
  els.browserEl.classList.remove('hidden');
  renderBrowser(ctx);
}
function closeBrowser() {
  browserOpen = false;
  browserRows = [];
  if (!els) return;
  els.browserEl.classList.add('hidden');
  if (document.activeElement === els.browserInputEl) els.browserInputEl.blur();
}

function switchBrowserTab(ctx, dir) {
  const i = SEARCH_TABS.findIndex((t) => t.id === browserTab);
  setBrowserTab(ctx, SEARCH_TABS[(i + dir + SEARCH_TABS.length) % SEARCH_TABS.length].id);
}

function setBrowserTab(ctx, id) {
  browserTab = id;
  // TV mode lands on the search box when there is nothing typed yet, since
  // that is the thing to do first; otherwise straight on the first result.
  browserCursor = id !== 'stations' && isTvMode() && !browserQuery ? -1 : 0;
  renderBrowser(ctx);
}

function activateBrowserRow(ctx) {
  if (browserCursor === -1) { openSearchKeyboard(ctx); return; }
  const row = browserRows[browserCursor];
  if (!row) return;
  closeBrowser();
  row.run();
}

function openSearchKeyboard(ctx) {
  if (!ctx.input || typeof ctx.input.openKeyboard !== 'function') return;
  ctx.input.openKeyboard({ title: 'SEARCH MUSIC', value: browserQuery, maxLength: 40 }).then((text) => {
    if (text == null || !browserOpen) return;
    browserQuery = text;
    browserCursor = 0;
    renderBrowser(ctx);
  });
}

function browserMove(ctx, delta) {
  if (!browserRows.length && browserCursor !== -1) return;
  const minCursor = browserTab !== 'stations' && isTvMode() ? -1 : 0;
  const last = Math.min(browserRows.length, MAX_ROWS) - 1;
  browserCursor = Math.max(minCursor, Math.min(last, browserCursor + delta));
  renderBrowser(ctx);
}

// Keys typed into the search box. app.js ignores keys while a text field has
// focus, so the list's own navigation is handled here instead.
function onSearchInputKey(ctx, e) {
  const input = els && els.browserInputEl;
  if (!input) return;
  const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
  const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
  let handled = true;
  if (e.key === 'ArrowDown') browserMove(ctx, 1);
  else if (e.key === 'ArrowUp') browserMove(ctx, -1);
  else if (e.key === 'PageDown') browserMove(ctx, 8);
  else if (e.key === 'PageUp') browserMove(ctx, -8);
  else if (e.key === 'ArrowLeft' && atStart) switchBrowserTab(ctx, -1);
  else if (e.key === 'ArrowRight' && atEnd) switchBrowserTab(ctx, 1);
  else if (e.key === 'Enter') activateBrowserRow(ctx);
  else if (e.key === 'Escape') {
    if (input.value) { browserQuery = ''; browserCursor = 0; renderBrowser(ctx); } else closeBrowser();
  } else handled = false;
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

function cycleStation(ctx, dir) {
  const settings = getSettings();
  const stations = settings.stations || [];
  if (stations.length < 2) return;
  const curIdx = Math.max(0, stations.findIndex((s) => s.id === settings.selectedStationId));
  const next = stations[(curIdx + dir + stations.length) % stations.length];
  switchToStation(ctx, next.id);
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
            <div class="mc-nowlabel" data-el="now-label">NOW PLAYING</div>
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
          <div class="mc-hint" data-el="hint"></div>
        </div>
        <div class="mc-browser hidden" data-el="browser">
          <div class="mc-browser-tabs" data-el="browser-tabs">
            ${SEARCH_TABS.map((t) => `<span class="mc-browser-tab" data-tab="${t.id}">${t.label}</span>`).join('')}
          </div>
          <label class="mc-browser-search hidden" data-el="browser-search">
            <span class="mc-browser-search-icon" aria-hidden="true">⌕</span>
            <input type="text" class="mc-browser-input" data-el="browser-input" maxlength="40" spellcheck="false" autocomplete="off"
              placeholder="SONG, ARTIST, ALBUM OR YEAR (1997, 90s, 1995-1999)" aria-label="Search music">
            <span class="mc-browser-result-count" data-el="browser-count"></span>
          </label>
          <div class="mc-browser-list" data-el="browser-list"></div>
          <div class="mc-browser-hint" data-el="browser-hint"></div>
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
      nowLabelEl: q('now-label'), hintEl: q('hint'),
      browserTabsEl: q('browser-tabs'), browserSearchEl: q('browser-search'), browserInputEl: q('browser-input'),
      browserCountEl: q('browser-count'), browserHintEl: q('browser-hint'),
    };

    // A fresh tune-in always starts on the live rotation.
    od = null;
    browserOpen = false;
    browserQuery = '';
    updateHint();
    els.browserTabsEl.querySelectorAll('[data-tab]').forEach((tabEl) => {
      tabEl.addEventListener('click', () => setBrowserTab(ctx, tabEl.dataset.tab));
    });
    els.browserInputEl.addEventListener('keydown', (e) => onSearchInputKey(ctx, e));
    els.browserInputEl.addEventListener('input', () => {
      browserQuery = els.browserInputEl.value;
      browserCursor = 0;
      renderBrowser(ctx);
    });
    // In TV mode the box is a row, not a text field: clicking or tapping it
    // (touch controls) opens the on-screen keyboard like OK does.
    els.browserSearchEl.addEventListener('mousedown', (e) => { if (isTvMode()) e.preventDefault(); });
    els.browserSearchEl.addEventListener('click', (e) => {
      if (!isTvMode()) return;
      e.preventDefault();
      browserCursor = -1;
      openSearchKeyboard(ctx);
    });

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

    // Live: re-derive from now() rather than blindly advancing one index. On
    // demand: the next song in the queue (and back to live after the last).
    endedHandler = () => (od ? skipTrack(ctx, 1, true) : tick(ctx));
    // An unplayable file on demand is skipped rather than retried forever.
    errorHandler = () => (od ? skipTrack(ctx, 1, true) : tick(ctx));
    ctx.player.addEventListener('ended', endedHandler);
    ctx.player.addEventListener('error', errorHandler);
    bindMediaSession(ctx);

    currentLoadedTrackPath = null;
    tick(ctx);
    // Four times a second rather than once: the on-demand progress bar and
    // seek readout need to feel attached to the keys. Live ticks are cheap —
    // everything expensive in tick() is gated on the track actually changing.
    tickTimer = setInterval(() => tick(ctx), 250);
  },
  stop(ctx) {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (endedHandler) { ctx.player.removeEventListener('ended', endedHandler); endedHandler = null; }
    if (errorHandler) { ctx.player.removeEventListener('error', errorHandler); errorHandler = null; }
    unbindMediaSession();
    if (els) {
      els.bgVideoEl.pause();
      els.bgVideoEl.removeAttribute('src');
    }
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    flashText = null;
    od = null;
    currentLoadedTrackPath = null;
    bgVideoPath = null;
    lastSlideshowIndex = -1;
    lastInfoSlideText = null;
    artTrackPath = null;
    mediaSessionTrackPath = null;
    browserOpen = false;
    browserRows = [];
    libraryIndex = null;
    els = null;
  },
  onOk(ctx) {
    if (browserOpen) { activateBrowserRow(ctx); return true; }
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
  //
  // The browser takes ◀▶ for its tabs, which core does not use while the
  // list is up either. Transport keys are only claimed where core has no
  // meaning for them on this channel: Space (core's second OK key — Enter
  // still opens the list), the Media* keys, [ ] (core's break jumps, which
  // only run under the time machine, where this defers anyway), and on
  // demand ◀▶ and L/Escape, which mean "seek" and "back to live" here the
  // same way they do for the time machine.
  //
  // TV mode (ctx v5): remote actions arrive here, forwarded to the same
  // handling onKey already does. Anything not handled goes back to core, so
  // ▲▼ still change channel and Back still asks to leave.
  onAction(action, ctx) {
    const key = ctx && ctx.input ? ctx.input.keyForAction(action) : null;
    return key ? this.onKey(key, ctx) : false;
  },
  onKey(key, ctx) {
    if (browserOpen) {
      if (key === 'ArrowUp') { browserMove(ctx, -1); return true; }
      if (key === 'ArrowDown') { browserMove(ctx, 1); return true; }
      if (key === 'PageUp') { browserMove(ctx, -8); return true; }
      if (key === 'PageDown') { browserMove(ctx, 8); return true; }
      if (key === 'ArrowLeft') { switchBrowserTab(ctx, -1); return true; }
      if (key === 'ArrowRight') { switchBrowserTab(ctx, 1); return true; }
      if (key === 'Enter' || key === ' ') { activateBrowserRow(ctx); return true; }
      if (key === 'Escape') { closeBrowser(); return true; }
      // Anything this list does not itself use belongs to core. Close first,
      // so tuning away or opening the guide does not leave the browser up
      // behind whatever the key actually did.
      closeBrowser();
      return false;
    }
    if (window.S && window.S.timeMachineOn) return false;
    if (key === ' ' || key === 'MediaPlayPause') return togglePause(ctx);
    if (key === 'MediaPause') return pressedRecently() || setPaused(ctx, true);
    if (key === 'MediaPlay') return !od || pressedRecently() || setPaused(ctx, false);
    if (key === 'MediaRewind') return seekBy(ctx, -30);
    if (key === 'MediaFastForward') return seekBy(ctx, 30);
    // A desktop keyboard's ⏮⏭ keys stay core's (the OS media session maps
    // them to channel down/up, and could deliver the same press twice); a TV
    // remote's arrive here as onAction('media.previous'/'media.next').
    const trackKey = isTvMode() && (key === 'MediaTrackPrevious' || key === 'MediaTrackNext');
    if (key === '[' || (trackKey && key === 'MediaTrackPrevious')) return skipTrack(ctx, -1, false);
    if (key === ']' || (trackKey && key === 'MediaTrackNext')) return skipTrack(ctx, 1, false);
    if (od) {
      if (key === 'ArrowLeft') return seekBy(ctx, -10);
      if (key === 'ArrowRight') return seekBy(ctx, 10);
      if (key === 'Escape' || key === 'l' || key === 'L') { leaveOnDemand(ctx, 'BACK TO LIVE'); return true; }
      return false;
    }
    if (key === 'ArrowLeft') { cycleStation(ctx, -1); return true; }
    if (key === 'ArrowRight') { cycleStation(ctx, 1); return true; }
    return false;
  },
});
