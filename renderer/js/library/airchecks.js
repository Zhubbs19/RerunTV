// Air checks — "mark this moment so I can come back to it."
//
// A broadcaster's air check was a recording of what actually went out over
// the transmitter. This box doesn't need one: the schedule is a pure
// function of (channel, timestamp), so a channel number and an instant on
// the viewing clock are already a complete description of a moment, and
// coming back to it is just shifting the clock the way the guide's
// jump-to-programme and the time machine's break jumps already do. Nothing
// is recorded, nothing is copied, and a mark costs a few dozen bytes.
//
// The tradeoff that buys: a mark is only as stable as the channel's anchor.
// Re-scanning a folder or re-ordering its playback re-anchors the channel
// (see the playback-order editor's own live-impact warning), and a mark made
// before that will land on whatever is airing at that timestamp afterwards,
// which may be a different programme. That's inherent to having no recording
// rather than a bug, and is why a mark stores the title it was made from —
// so the list can still say what it was meant to be pointing at.
import { getChannel } from '../core/channels.js';
import { flashMessage } from '../playback/power.js';
import { tuneToChannel } from '../playback/core.js';
import { computeLivePosition } from '../core/schedule.js';
import { S, viewNow, commitInPlace } from '../core/state.js';
import { updateTimeShiftBadge } from '../playback/timemachine.js';
import { formatClock, getDisplayTitle } from '../core/util.js';
import { currentProfile, personalCommand } from '../personal/state.js';

// Enough to be useful as a shortlist without turning the TV menu into a
// scrolling list; older ones drop off the end as new ones are added.
export const AIR_CHECK_MAX = 24;
// How many of them the TV menu offers directly. The full list, with removal,
// lives on the setup screen — the menu is a remote-friendly shortlist, not a
// management surface.
export const AIR_CHECK_MENU_MAX = 6;

function airCheckArray() {
  const profile = currentProfile();
  if (profile) return profile.state.airChecks;
  if (!Array.isArray(S.config.airChecks)) S.config.airChecks = [];
  return S.config.airChecks;
}

function saveAirChecks(list, opts = {}) {
  const profile = currentProfile();
  if (profile) {
    profile.state.airChecks = list;
    personalCommand({ type: 'state.set', key: 'airChecks', value: list }).catch((e) => console.warn('[profiles] air-check write failed:', e.message));
  } else {
    S.config.airChecks = list;
    commitInPlace({ type: 'settings.set', path: ['airChecks'], value: list }, opts);
  }
}

// Newest first — the one you just made is the one you are most likely to
// want back.
export function airChecks() {
  return airCheckArray().slice().sort((a, b) => b.at - a.at);
}

export function airCheckLabel(mark) {
  const when = formatClock(new Date(mark.at));
  return `${when} · CH ${mark.channelNumber}${mark.title ? ` · ${mark.title}` : ''}`;
}

export function saveAirCheck() {
  const ch = getChannel(S.currentNumber);
  if (!ch) {
    flashMessage('AIR CHECK — NOTHING TUNED', 'airCheckFlashTimer');
    return null;
  }
  const at = viewNow();
  const pos = computeLivePosition(ch);
  const mark = {
    id: `aircheck-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    channelNumber: ch.number,
    channelName: ch.name || '',
    title: pos && pos.file ? getDisplayTitle(pos.file) : '',
    // The viewing clock, not the wall clock: marking something while
    // time-shifted has to come back to that same point in the schedule, not
    // to whenever the key happened to be pressed.
    at,
  };
  const list = airCheckArray();
  list.push(mark);
  // Trim oldest-first regardless of insertion order, so the cap holds even
  // for a mark made in the past while time-shifted.
  list.sort((a, b) => a.at - b.at);
  while (list.length > AIR_CHECK_MAX) list.shift();
  // skipUndo: marking a moment happens while watching, not while editing.
  // Without it, an evening of surfing would bury real setup edits under a
  // pile of "air check added" steps — the same reasoning that keeps
  // lastChannel out of the undo stack (saveConfigDebounced, state.js).
  saveAirChecks(list, { skipUndo: true });
  flashMessage(`AIR CHECK SAVED — ${airCheckLabel(mark)}`, 'airCheckFlashTimer');
  return mark;
}

export function removeAirCheck(id) {
  saveAirChecks(airCheckArray().filter((mark) => mark.id !== id), { label: 'Remove air check' });
}

export function clearAirChecks() {
  saveAirChecks([], { label: 'Clear air checks' });
}

// Shifts the viewing clock so that `viewNow()` reads the marked instant,
// then tunes — the same two steps jumpToGuideEntry (guide.js) takes, for the
// same reason: everything downstream reads viewNow(), so moving the offset
// moves playback, the guide, dayparting, and the on-screen clocks together.
//
// Works whether or not the time machine is switched on. The mode gates
// shuttling and the guide's own jump-to-programme, but recalling a mark is
// an explicit, single destination the user picked by name, not open-ended
// scrubbing, so gating it behind a setting would only make the feature
// silently do nothing.
export function recallAirCheck(id) {
  const mark = airCheckArray().find((entry) => entry.id === id);
  if (!mark) return false;
  S.timeOffsetMs += mark.at - viewNow();
  updateTimeShiftBadge();
  tuneToChannel(mark.channelNumber);
  flashMessage(`AIR CHECK — ${airCheckLabel(mark)}`, 'airCheckFlashTimer');
  return true;
}
