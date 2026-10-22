// The sign-on card: shown once when the box starts, after the startup channel
// is tuned. Says how long the box was off and lists the viewer's next few
// reminders. Any key or a click dismisses it; otherwise it leaves on its own.
// Also keeps config.lastSeenAt fresh so the next start knows how long it was
// away (a watching-state write: no undo step).
import { crtContainer } from '../core/dom.js';
import { buildSignOn } from '../core/sign-on.js';
import { S, commitInPlace } from '../core/state.js';
import { formatSlotLabel } from '../core/util.js';
import { currentProfile } from '../personal/state.js';

const HIDE_MS = 12000;
const SEEN_WRITE_MS = 2 * 60000;
let cardEl = null;
let hideTimer = null;

function reminders() {
  const profile = currentProfile();
  return profile ? profile.state.reminders : (S.config.reminders || []);
}

export function closeSignOnCard() {
  clearTimeout(hideTimer);
  if (cardEl) cardEl.classList.add('hidden');
}

export function isSignOnOpen() {
  return !!cardEl && !cardEl.classList.contains('hidden');
}

export function showSignOnCard() {
  const info = buildSignOn({
    now: Date.now(),
    lastSeenAt: S.config.lastSeenAt,
    reminders: reminders(),
    formatTime: formatSlotLabel,
  });
  if (!info) return false;
  if (!cardEl) {
    cardEl = document.createElement('div');
    cardEl.className = 'sign-on-card hidden';
    cardEl.addEventListener('click', closeSignOnCard);
    crtContainer.appendChild(cardEl);
  }
  cardEl.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'sign-on-title';
  title.textContent = info.title;
  cardEl.appendChild(title);
  info.lines.forEach((text) => {
    const row = document.createElement('div');
    row.className = 'sign-on-row';
    row.textContent = text;
    cardEl.appendChild(row);
  });
  cardEl.classList.remove('hidden');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(closeSignOnCard, HIDE_MS);
  return true;
}

// Called once at boot, after the first tune.
export function startSignOn() {
  showSignOnCard();
  const stamp = () => {
    S.config.lastSeenAt = Date.now();
    commitInPlace({ type: 'settings.set', path: ['lastSeenAt'], value: S.config.lastSeenAt }, { skipUndo: true });
  };
  stamp();
  setInterval(stamp, SEEN_WRITE_MS);
  window.addEventListener('beforeunload', stamp);
  // Any key closes the card, without swallowing the key.
  window.addEventListener('keydown', () => { if (isSignOnOpen()) closeSignOnCard(); }, true);
}
