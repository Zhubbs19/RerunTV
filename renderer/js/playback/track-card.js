// The artist / song lower third on a music-video channel (ch.trackCard —
// set by the Music Videos preset or the channel's IDENTITY tab).
//
// Like a music network's, the card appears as a video starts and again as it ends. The
// start showing is driven by the schedule position the file was loaded at
// (already viewNow()-derived in playback/core.js), so tuning in forty seconds
// into a video does not replay the opening card; the end showing is a timer
// from that same position, so it lands on the video's real last seconds.
// Both are presentation only — nothing here reads or changes the schedule.
//
// What the card says comes from the file's own metadata when the library
// tagged it (file.artist / file.title / file.album, materialized onto the
// playlist entry by library/query.js), else from an "Artist - Title"
// filename, parsed the same way library/tagging.js does. `trackInfoFor` is
// pure and exported for tests.
import { S } from '../core/state.js';
import { autoHideAfter, stripReleaseTags } from '../core/util.js';

// Looked up on use rather than imported from core/dom.js, so the pure part of
// this module (trackInfoFor) loads in Node for its tests.
const trackCardEl = () => document.getElementById('track-card');

const ARTIST_TITLE = /^(.{1,80}?)\s+[-–—]\s+(.+)$/;
const VIDEO_JUNK = /\s*[([{](?:official|hd|hq|4k|1080p|720p|remaster(?:ed)?|lyric|lyrics|audio|video|music video|live|explicit|clean|uncensored|visuali[sz]er|version|edit|from [^)\]}]*|feat\.?[^)\]}]*|ft\.?[^)\]}]*)[^)\]}]*[)\]}]\s*/gi;
const YEAR = /\(((?:19|20)\d\d)\)/;
// How close to the end the closing card shows, and the least room a video
// needs for both cards not to overlap.
const END_LEAD_S = 4;

function basenameNoExt(path) {
  return String(path || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
}

function clean(text) {
  return String(text || '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * { artist, title, album, year } for a playlist entry, or null when there is
 * nothing worth a card (no artist and no song title).
 */
export function trackInfoFor(file) {
  if (!file) return null;
  const base = basenameNoExt(file.path);
  const yearMatch = base.match(YEAR);
  const stripped = stripReleaseTags(clean(base.replace(VIDEO_JUNK, ' ').replace(YEAR, ' ')));
  const parsed = stripped.match(ARTIST_TITLE);
  const artist = clean(file.artist) || (parsed ? parsed[1].trim() : '');
  const title = clean(file.title) || (parsed ? parsed[2].trim() : (artist ? '' : stripped));
  if (!artist && !title) return null;
  const era = file.facets && (Array.isArray(file.facets.era) ? file.facets.era[0] : file.facets.era);
  const year = (yearMatch && yearMatch[1]) || (file.year ? String(file.year) : '') || '';
  return {
    artist,
    title,
    album: clean(file.album),
    year: year || (typeof era === 'string' && /^\d{4}s$/.test(era) ? era : ''),
  };
}

let startTimer = null;
let endTimer = null;

export function hideTrackCard() {
  clearTimeout(startTimer);
  clearTimeout(endTimer);
  startTimer = null;
  endTimer = null;
  const el = trackCardEl();
  if (el) el.classList.remove('show');
}

function render(info) {
  const card = trackCardEl();
  if (!card) return;
  card.replaceChildren();
  const line = (className, text) => {
    if (!text) return;
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    card.appendChild(el);
  };
  line('track-card-artist', info.artist);
  line('track-card-title', info.title ? `“${info.title}”` : '');
  line('track-card-meta', [info.album, info.year].filter(Boolean).join(' · '));
}

// The now-playing banner (guide.css .guide-overlay) sits bottom-left too and
// is up for a few seconds after a tune, exactly when the opening card shows.
// While it is visible the card sits just above it; otherwise the stylesheet's
// own bottom applies. Measured in the overlay layer's pixels so a scaled or
// inset layer (display/mode.js) still lands the card where it looks right.
const BANNER_GAP_PX = 12;
function clearBanner(card) {
  card.style.bottom = '';
  const banner = document.getElementById('guide-overlay');
  const layer = card.offsetParent;
  if (!banner || banner.classList.contains('hidden') || !layer) return;
  // The banner slides in (guide.css guide-overlay-in), so its live rect is
  // mid-animation right now; its resting top comes from its CSS bottom and
  // height inside its own container instead.
  const bannerParent = banner.offsetParent;
  const layerRect = layer.getBoundingClientRect();
  if (!bannerParent || !banner.offsetHeight || !layerRect.height) return;
  const parentRect = bannerParent.getBoundingClientRect();
  const parentScale = parentRect.height / bannerParent.clientHeight || 1;
  const bannerBottom = parseFloat(getComputedStyle(banner).bottom) || 0;
  const bannerTop = parentRect.bottom - (bannerBottom + banner.offsetHeight) * parentScale;
  const scale = layer.clientHeight / layerRect.height || 1;
  const lift = (layerRect.bottom - bannerTop) * scale + BANNER_GAP_PX;
  const base = parseFloat(getComputedStyle(card).bottom) || 0;
  if (lift > base) card.style.bottom = `${Math.round(lift)}px`;
}

function show(info, seconds) {
  const card = trackCardEl();
  if (!card) return;
  render(info);
  clearBanner(card);
  card.classList.add('show');
  S.trackCardTimer = autoHideAfter(S.trackCardTimer, seconds * 1000, () => card.classList.remove('show'));
}

/**
 * Called when real content starts on `ch` at `offsetS` seconds into `file`
 * (playback/core.js, next to the contentStart overlay trigger). Shows the
 * opening card if the video has only just begun, and arms the closing one.
 */
export function scheduleTrackCard(ch, file, offsetS) {
  hideTrackCard();
  const card = ch && ch.trackCard;
  if (!card || !card.enabled || !trackCardEl()) return;
  const info = trackInfoFor(file);
  if (!info) return;
  const seconds = Number(card.seconds) > 0 ? Number(card.seconds) : 8;
  const offset = Number.isFinite(offsetS) && offsetS > 0 ? offsetS : 0;
  const duration = Number(file.duration) || 0;
  const remaining = duration ? duration - offset : Infinity;

  // Opening card: only when we are still inside its own window, so a
  // channel change mid-song doesn't announce a song that is half over.
  if (card.atStart !== false && offset < seconds + 2) {
    const left = Math.max(2, seconds - offset);
    if (remaining > left + END_LEAD_S) show(info, left);
  }
  // Closing card: timed to end a few seconds before the video does. Skipped
  // when the video is too short for two separate showings.
  if (card.atEnd !== false && duration > 0) {
    const startAt = remaining - seconds - END_LEAD_S;
    if (startAt > seconds && duration > 2 * seconds + END_LEAD_S) {
      endTimer = setTimeout(() => {
        endTimer = null;
        if (S.currentNumber !== ch.number || !S.isPoweredOn || S.liveContentPath !== file.path) return;
        show(info, seconds);
      }, startAt * 1000);
    }
  }
}
