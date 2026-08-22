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
      detailsPosterEl.src = posterUrl;
      detailsPosterEl.classList.remove('hidden');
    } else {
      detailsPosterEl.classList.add('hidden');
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
  populateDetails(file, ctx || {});
  detailsOverlayEl.classList.remove('hidden');
}

export function hideDetailsOverlay() {
  detailsOverlayEl.classList.add('hidden');
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
