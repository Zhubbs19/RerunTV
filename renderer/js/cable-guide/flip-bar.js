// The Flip Bar: the channel banner on the cable-guide layout. It lives inside
// the legacy #guide-overlay (the banner element every banner path already
// shows, hides and times), so the banner hub's browse/actions logic and the
// card timer are shared; this only fills the cable-guide half.
//
// Top line: title (highlight colour), number + call letters, clock. Below:
// Info / Guide buttons on the left, the time range with a rating badge and
// the description on the right.
import { S, viewNow } from '../core/state.js';
import { getChannelSchedule } from '../core/schedule.js';
import { getDisplayTitle } from '../core/util.js';
import { formatChannelNumber } from '../core/channels.js';
import { channelCallLetters } from '../guide/model.js';
import { virtualChannelInfo, isVirtualChannel } from '../playback/virtual.js';
import { guideClock, guideRange } from './model.js';
import { setChannelLogo } from './header.js';

const el = (id) => document.getElementById(id);
const parts = {
  title: el('flip-title'), chan: el('flip-chan'), logo: el('flip-logo'), clock: el('flip-clock'),
  range: el('flip-range'), rating: el('flip-rating'), desc: el('flip-desc'),
  info: el('flip-info'), guide: el('flip-guide'),
};

let shown = null; // { number, ch, entry } on the bar right now

export function flipBarProgram() {
  return shown;
}

// Wires the two buttons once; the actions come from guide.js so this module
// never imports the guide back.
export function installFlipBar({ onInfo, onGuide }) {
  if (!parts.info || parts.info.dataset.wired) return;
  parts.info.dataset.wired = 'true';
  parts.info.addEventListener('click', () => { if (shown && shown.entry) onInfo(shown); });
  parts.guide.addEventListener('click', () => onGuide());
}

export function fillFlipBar(number, ch) {
  if (!parts.title) return;
  const clock24 = !!(S.config.display && S.config.display.clock24);
  const now = viewNow();
  parts.clock.textContent = guideClock(new Date(now), clock24);
  parts.chan.textContent = `${formatChannelNumber(number)} ${ch ? (channelCallLetters(ch) || ch.name || '') : ''}`.trim();
  if (parts.logo) setChannelLogo(parts.logo, ch, now);

  let entry = null;
  if (!ch && isVirtualChannel(number)) {
    const info = virtualChannelInfo(number);
    parts.title.textContent = info.name || '';
    parts.desc.textContent = info.nowText || '';
  } else if (!ch) {
    parts.title.textContent = (S.config.display && S.config.display.noSignalTitle && S.config.display.noSignalTitle.trim()) || 'No signal';
    parts.desc.textContent = '';
  } else {
    // A wide window: entries are clipped to the one asked for, and the bar
    // shows the whole program's start and end.
    const HALF_DAY = 12 * 3600000;
    entry = getChannelSchedule(ch, now - HALF_DAY, now + HALF_DAY).find((e) => e.start <= now && e.end > now) || null;
    parts.title.textContent = entry ? getDisplayTitle(entry.file) : (ch.name || '');
    const description = entry && typeof entry.file.description === 'string' ? entry.file.description.trim() : '';
    parts.desc.textContent = description;
  }
  parts.range.textContent = entry ? guideRange(new Date(entry.start), new Date(entry.end), clock24) : '';
  const rating = entry ? (entry.file.rating === 'NONE' ? null : (entry.file.rating || ch.rating)) : null;
  parts.rating.textContent = rating || '';
  parts.rating.classList.toggle('hidden', !rating);
  parts.info.disabled = !entry;
  shown = { number, ch, entry };
}
