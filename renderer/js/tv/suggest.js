// "Switch to TV mode?" (docs/design/01 §4, step 4). A suggestion only — the
// mode never changes on its own. It appears when this session looks like
// someone across the room: fullscreen, driven by arrows/OK alone for a while,
// with no pointer movement at all. Declining is remembered per device.
//
// The decision is pure so node:test can cover it; the toast is the only DOM.
import { setUsageModePreference } from './usage-mode.js';

export const SUGGEST_AFTER_MS = 10000;
export const SUGGEST_MIN_KEYS = 3;
const DISMISS_KEY = 'reruntv.tvSuggestDismissed';
const REMOTE_LIKE = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape']);

/**
 * Decides whether this session looks like a remote across the room and the offer should show.
 * state: { mode, fullscreen, dismissed, pointerAt, remoteKeys, firstRemoteAt, now }
 * @param {?object} state What the session has seen so far.
 * @param {string} state.mode The current usage mode (`'desktop'` or `'tv'`).
 * @param {boolean} state.fullscreen Whether the window fills the screen.
 * @param {boolean} state.dismissed Whether the offer was declined on this device.
 * @param {boolean} state.pointerAt Whether a pointer has been used.
 * @param {number} state.remoteKeys How many remote-like keys were pressed.
 * @param {?number} state.firstRemoteAt Timestamp (ms) of the first remote-like key.
 * @param {number} state.now The current timestamp (ms).
 * @returns {boolean} True when the suggestion should be shown.
 */
export function shouldSuggestTvMode(state) {
  if (!state || state.mode !== 'desktop' || state.dismissed) return false;
  if (!state.fullscreen) return false;
  if (state.pointerAt) return false; // a pointer was used: this is a desk
  if ((state.remoteKeys || 0) < SUGGEST_MIN_KEYS) return false;
  return state.firstRemoteAt != null && state.now - state.firstRemoteAt >= SUGGEST_AFTER_MS;
}

/**
 * Whether a key is one a plain remote could send (arrows, Enter, Escape).
 * @param {string} key A `KeyboardEvent.key` value.
 * @returns {boolean} True for a remote-like key.
 */
export function isRemoteLikeKey(key) {
  return REMOTE_LIKE.has(key);
}

/**
 * Whether the offer was declined on this device; true when storage is unavailable.
 * @returns {boolean} True if the suggestion should stay hidden.
 */
function dismissed() {
  try { return window.localStorage.getItem(DISMISS_KEY) === '1'; } catch (e) { return true; }
}

/**
 * Records in local storage that the offer was answered, so it is not shown again.
 */
function rememberDismissed() {
  try { window.localStorage.setItem(DISMISS_KEY, '1'); } catch (e) { /* storage unavailable */ }
}

// The suggestion toast while it is on screen.
let toastEl = null;

/**
 * Removes the suggestion toast if it is showing.
 */
function hideToast() {
  if (toastEl) { toastEl.remove(); toastEl = null; }
}

/**
 * Builds and shows the "Switch to TV mode?" toast with its two buttons, focusing the first.
 */
function showToast() {
  if (toastEl) return;
  toastEl = document.createElement('div');
  toastEl.className = 'tv-suggest';
  toastEl.setAttribute('role', 'dialog');
  toastEl.setAttribute('aria-label', 'Switch to TV mode?');
  toastEl.innerHTML = '<span class="tv-suggest-text">Using a remote? TV mode makes everything reachable with the D-pad.</span>';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'tv-suggest-btn';
  yes.textContent = 'SWITCH TO TV MODE';
  yes.addEventListener('click', () => { rememberDismissed(); hideToast(); setUsageModePreference('tv'); });
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'tv-suggest-btn quiet';
  no.textContent = 'NOT NOW';
  no.addEventListener('click', () => { rememberDismissed(); hideToast(); });
  toastEl.append(yes, no);
  // Remote-like keys land here while a button has focus: Enter activates it
  // (native click), Esc declines, arrows hop between the two, and none of them
  // also reaches the app's own key handler behind the toast.
  toastEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.stopPropagation(); return; }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); rememberDismissed(); hideToast(); return; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      (document.activeElement === yes ? no : yes).focus();
    }
  });
  document.body.appendChild(toastEl);
  yes.focus({ preventScroll: true });
}

/**
 * Watches this session and offers once. Installed from app.js.
 * @param {() => string} getMode Returns the current usage mode.
 */
export function installTvSuggestion(getMode) {
  const state = { remoteKeys: 0, firstRemoteAt: null, pointerAt: false };
  let offered = false;
  let timer = null;
  const check = () => {
    if (offered) { clearInterval(timer); return; }
    const ok = shouldSuggestTvMode({
      mode: getMode(),
      fullscreen: !!(document.fullscreenElement || (window.innerWidth === window.screen.width && window.innerHeight === window.screen.height)),
      dismissed: dismissed(),
      pointerAt: state.pointerAt,
      remoteKeys: state.remoteKeys,
      firstRemoteAt: state.firstRemoteAt,
      now: Date.now(),
    });
    // Offered once per session: the interval has nothing left to do after that.
    if (ok) { offered = true; clearInterval(timer); showToast(); }
  };
  window.addEventListener('pointermove', () => { state.pointerAt = true; }, { passive: true, once: true });
  window.addEventListener('mousedown', () => { state.pointerAt = true; }, { passive: true, once: true });
  window.addEventListener('keydown', (event) => {
    if (!isRemoteLikeKey(event.key)) return;
    state.remoteKeys += 1;
    if (state.firstRemoteAt == null) state.firstRemoteAt = Date.now();
    check();
  });
  timer = setInterval(check, 5000);
}
