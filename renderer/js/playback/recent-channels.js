// "Recent channels": the last few channels you tuned, on Shift+Backspace.
// Backspace alone is the one-step "last channel" jump; this is for hopping
// back two or three channels. A small card over the picture lists them most
// recent first; 1-6, ▲▼ + Enter, or a click tunes one, Esc or any other key
// closes it. Session only (nothing is saved).
import { crtContainer } from '../core/dom.js';
import { formatChannelNumber, getChannel } from '../core/channels.js';
import { S } from '../core/state.js';

const MAX_RECENT = 6;
let cardEl = null;
let cursor = 0;
let hideTimer = null;

export function noteRecentChannel(number) {
  if (number == null) return;
  const list = (S.recentChannels || []).filter((n) => n !== number);
  list.unshift(number);
  S.recentChannels = list.slice(0, MAX_RECENT + 1);
}

// The channels worth listing: the ones before the one on screen.
export function recentChannelList() {
  return (S.recentChannels || []).filter((n) => n !== S.currentNumber).slice(0, MAX_RECENT);
}

export function isRecentOpen() {
  return !!cardEl && !cardEl.classList.contains('hidden');
}

function label(number) {
  const ch = getChannel(number);
  return `${formatChannelNumber(number)}  ${ch && ch.name ? ch.name.toUpperCase() : `CHANNEL ${number}`}`;
}

function render() {
  const list = recentChannelList();
  cardEl.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'recent-channels-title';
  title.textContent = 'RECENT CHANNELS';
  cardEl.appendChild(title);
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'recent-channels-empty';
    empty.textContent = 'NOTHING YET — CHANGE CHANNEL FIRST';
    cardEl.appendChild(empty);
    return;
  }
  list.forEach((number, i) => {
    const row = document.createElement('div');
    row.className = `recent-channels-row${i === cursor ? ' active' : ''}`;
    row.textContent = `${i + 1}   ${label(number)}`;
    row.addEventListener('click', () => pick(number));
    cardEl.appendChild(row);
  });
}

export function closeRecentChannels() {
  clearTimeout(hideTimer);
  if (cardEl) cardEl.classList.add('hidden');
}

function pick(number) {
  closeRecentChannels();
  if (window.tuneToChannel) window.tuneToChannel(number);
}

export function toggleRecentChannels() {
  if (isRecentOpen()) { closeRecentChannels(); return; }
  if (!cardEl) {
    cardEl = document.createElement('div');
    cardEl.className = 'recent-channels hidden';
    crtContainer.appendChild(cardEl);
  }
  cursor = 0;
  render();
  cardEl.classList.remove('hidden');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(closeRecentChannels, 8000);
}

// Keys while the card is up. Returns true when the key was used.
export function handleRecentKey(e) {
  if (!isRecentOpen()) return false;
  const list = recentChannelList();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(closeRecentChannels, 8000);
  if (e.key >= '1' && e.key <= '9') {
    const target = list[Number(e.key) - 1];
    if (target != null) pick(target); else closeRecentChannels();
  } else if (e.key === 'ArrowDown') { cursor = Math.min(list.length - 1, cursor + 1); render(); }
  else if (e.key === 'ArrowUp') { cursor = Math.max(0, cursor - 1); render(); }
  else if (e.key === 'Enter' || e.key === ' ') { if (list[cursor] != null) pick(list[cursor]); else closeRecentChannels(); }
  else if (e.key === 'Backspace' && e.shiftKey) closeRecentChannels();
  else { closeRecentChannels(); return e.key === 'Escape'; }
  return true;
}
