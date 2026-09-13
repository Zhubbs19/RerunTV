// The program DETAILS card (toggled with I) — a per-file title/description/
// tags readout, either for whatever's live-playing on the current channel or
// (with the guide open) whichever program is currently highlighted there.
// Purely a display of data authored elsewhere (a file's title/description/
// tags — see buildTitlesPanel, setup-panels.js); this module owns no state
// of its own beyond the overlay's show/hide.
import { detailsDescriptionEl, detailsMetaEl, detailsOverlayEl, detailsPosterEl, detailsTagsEl, detailsTitleEl } from './dom.js';
import { getChannel } from './channels.js';
import { computeLivePosition } from './schedule.js';
import { S } from './state.js';
import { getDisplayTitle } from './util.js';

let detailsPreviouslyFocused = null;

// A poster only ever came from an opt-in metadata match, so for most
// libraries this card had no image on it at all. Falling back to a frame out
// of the file itself needs nothing external — the setup screen's thumbnails
// already pull one the same way (buildMediaThumb, setup-util.js) — the only
// difference here is rendering it to a data URL so it can feed the existing
// <img> rather than swapping the element for a <video>.
//
// A paused <video> seeked to a frame, NOT a canvas snapshot. Media is served
// from app://media while the page itself is app://bundle — different hosts
// on a `standard` scheme, so different origins, and the media handler
// deliberately sends no Access-Control-Allow-Origin (only the bundle and
// plugin routes do). Drawing that video to a canvas therefore taints it and
// toDataURL throws, which is exactly what happened the first time this was
// built. Widening CORS on the media route to get a thumbnail would be a poor
// trade; showing the video element itself costs nothing and is the same
// thing the setup screen's thumbnails already do.
const POSTER_FRAME_TIMEOUT_MS = 6000;
const AUDIO_ONLY_RE = /\.(mp3|m4a|flac|wav|ogg|opus|aac|wma)$/i;
// Files that produced no frame — audio-only, a codec Chromium won't decode,
// a path that has since moved. Remembered so a hopeless file isn't retried
// every time its card opens.
const posterFrameFailures = new Set();
// Only the newest request may reveal the element: opening the card, closing
// it, and opening it on another channel faster than a seek completes would
// otherwise show the first file's frame on the second file's card.
let posterRequestToken = 0;
let posterVideoEl = null;

function ensurePosterVideo() {
  if (posterVideoEl || !detailsPosterEl || !detailsPosterEl.parentNode) return posterVideoEl;
  posterVideoEl = document.createElement('video');
  // Same class as the <img> so it inherits the card's poster sizing/framing
  // rather than needing a parallel rule in the stylesheet.
  posterVideoEl.className = detailsPosterEl.className;
  // ...except its shape: a frame out of the file is widescreen (or 4:3), and
  // the poster's 2:3 box cropped it down to a sliver of someone's face.
  posterVideoEl.classList.add('details-poster-frame', 'hidden');
  posterVideoEl.muted = true;
  posterVideoEl.playsInline = true;
  posterVideoEl.preload = 'metadata';
  posterVideoEl.tabIndex = -1;
  posterVideoEl.setAttribute('aria-hidden', 'true');
  detailsPosterEl.parentNode.insertBefore(posterVideoEl, detailsPosterEl.nextSibling);
  return posterVideoEl;
}

function hidePosterFrame() {
  posterRequestToken += 1;
  if (!posterVideoEl) return;
  posterVideoEl.classList.add('hidden');
  posterVideoEl.removeAttribute('src');
  posterVideoEl.load();
}

function applyPosterFrame(file) {
  const path = file && file.path;
  // Only local video: a provider-backed ref would mean a network fetch just
  // to decorate a card, and an audio file has no frame to pull.
  if (!path || (file.source && file.source !== 'local') || AUDIO_ONLY_RE.test(path)) return;
  if (posterFrameFailures.has(path)) return;
  const video = ensurePosterVideo();
  if (!video) return;
  const token = ++posterRequestToken;

  let settled = false;
  const fail = () => {
    if (settled) return;
    settled = true;
    posterFrameFailures.add(path);
    if (token === posterRequestToken) video.classList.add('hidden');
  };
  const reveal = () => {
    if (settled) return;
    settled = true;
    if (token === posterRequestToken) video.classList.remove('hidden');
  };

  const onMeta = () => {
    // A quarter in, same as the setup thumbnails: far enough past a black
    // opening frame or a distributor logo to usually be the programme
    // itself, capped so a three-hour film doesn't seek ten minutes deep.
    video.currentTime = video.duration > 1 ? Math.min(video.duration / 4, 600) : 0;
  };
  video.addEventListener('loadedmetadata', onMeta, { once: true });
  video.addEventListener('seeked', reveal, { once: true });
  video.addEventListener('error', fail, { once: true });
  setTimeout(fail, POSTER_FRAME_TIMEOUT_MS);

  Promise.resolve(window.api.toFileUrl(path)).then((url) => {
    if (token !== posterRequestToken) return;
    video.src = url;
  }).catch(fail);
}

function populateDetails(file, ctx) {
  detailsTitleEl.textContent = file ? getDisplayTitle(file) : 'NO INFO AVAILABLE';

  const metaParts = [];
  if (ctx.channelNumber != null) {
    metaParts.push(`CH ${ctx.channelNumber}${ctx.channelName ? ' — ' + ctx.channelName : ''}`);
  }
  if (ctx.airTime) metaParts.push(ctx.airTime);
  detailsMetaEl.textContent = metaParts.join('   ·   ');

  detailsDescriptionEl.textContent = (file && file.description && file.description.trim())
    ? file.description.trim()
    : 'No description added yet — add one from this channel\'s EDIT → TITLES tab in setup.';

  // Poster + cast come from an opt-in metadata match (a plugin's own
  // registerTitleRowAction on the TITLES tab — see setup-panels.js);
  // most files never have this, so both are hidden whenever it's missing
  // rather than showing a broken image or empty row.
  const posterUrl = file && file.tmdb && file.tmdb.posterUrl;
  if (detailsPosterEl) {
    if (posterUrl) {
      hidePosterFrame(); // cancels any frame seek still in flight
      detailsPosterEl.src = posterUrl;
      detailsPosterEl.classList.remove('hidden');
    } else {
      hidePosterFrame();
      // Hidden first, then filled in if a frame can be pulled out of the
      // file itself — the capture is asynchronous, and a card that popped
      // open holding the previous programme's image while it ran would be
      // worse than one that simply has no image.
      detailsPosterEl.classList.add('hidden');
      applyPosterFrame(file);
    }
  }

  detailsTagsEl.innerHTML = '';
  ((file && file.tags) || []).forEach((t) => {
    const tag = document.createElement('span');
    tag.className = 'details-tag';
    tag.textContent = t.toUpperCase();
    detailsTagsEl.appendChild(tag);
  });

  const cast = file && file.tmdb && file.tmdb.cast;
  if (cast && cast.length) {
    const castLabel = document.createElement('span');
    castLabel.className = 'details-tag details-cast';
    castLabel.textContent = `CAST: ${cast.join(', ')}`;
    detailsTagsEl.appendChild(castLabel);
  }
}

export function showDetailsOverlay(file, ctx) {
  if (detailsOverlayEl.classList.contains('hidden')) detailsPreviouslyFocused = document.activeElement;
  populateDetails(file, ctx || {});
  detailsOverlayEl.classList.remove('hidden');
  requestAnimationFrame(() => detailsOverlayEl.focus({ preventScroll: true }));
}

export function hideDetailsOverlay() {
  detailsOverlayEl.classList.add('hidden');
  if (detailsPreviouslyFocused && detailsPreviouslyFocused.isConnected && detailsPreviouslyFocused.getClientRects().length && detailsPreviouslyFocused.focus) {
    detailsPreviouslyFocused.focus({ preventScroll: true });
  } else if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
  detailsPreviouslyFocused = null;
}

// Live-playback entry point (the I key outside the guide) — shows details
// for whatever's actually airing on the current channel right now. A silent
// no-op on a virtual channel or an empty one, where there's no real file to
// describe, rather than popping up an empty/misleading card.
export function showDetailsForCurrentChannel() {
  if (!S.config.details || S.config.details.enabled === false) return;
  const ch = getChannel(S.currentNumber);
  if (!ch) return;
  const pos = computeLivePosition(ch);
  if (!pos || !pos.file) return;
  showDetailsOverlay(pos.file, { channelNumber: ch.number, channelName: ch.name });
}
