// Touch input for the LAN viewer on phones/tablets (window.__isViewer, see
// browser-api-shim.js) — the host has a real keyboard and the Android TV
// wrapper has a D-pad, but a touchscreen has neither, so this translates
// taps/swipes into the exact same synthetic keydown shape those other input
// paths already use (see android-tv-client's MainActivity.kt and the phone
// remote's onRemoteCommand relay), routed through the one real handler
// (handleKey, app.js) via a genuine `window.dispatchEvent(new
// KeyboardEvent(...))` rather than a second, parallel command surface —
// dispatched, not imported directly, to avoid a circular import with app.js
// (which imports initTouchControls from here).
import { crtContainer, guideMuteEl, player, tvScreen } from '../core/dom.js';
import { autoHideAfter } from '../core/util.js';

function sendKey(key) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

// Only fire our own gesture handling for taps/swipes that land on the bare
// picture itself — not on any button, guide row, or setup-screen control,
// which already have their own real click handlers and shouldn't also be
// reinterpreted as a swipe/tap gesture underneath.
function isBackgroundTarget(el) {
  return el === player || el === crtContainer || el === tvScreen;
}

const SWIPE_MIN_PX = 40;
const TAP_MAX_MOVE_PX = 12;
const TAP_MAX_MS = 300;
const BAR_AUTOHIDE_MS = 4000;

let controlBarEl = null;
let muteBtnEl = null;
let barHideTimer = null;

function buildControlBar() {
  const bar = document.createElement('div');
  bar.className = 'touch-control-bar hidden';

  const makeBtn = (label, key, extraClass) => {
    const btn = document.createElement('button');
    btn.className = 'touch-control-btn' + (extraClass ? ` ${extraClass}` : '');
    btn.textContent = label;
    // pointerdown, not click — same reasoning as the existing phone remote
    // (remote/remote.js): fires the instant a finger touches down instead
    // of waiting for the browser's touchend->click synthesis delay.
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      sendKey(key);
      showControlBar(); // keep it open and reset the auto-hide timer on use
    });
    return btn;
  };

  bar.appendChild(makeBtn('CH ▲', 'ArrowUp'));
  bar.appendChild(makeBtn('CH ▼', 'ArrowDown'));
  bar.appendChild(makeBtn('GUIDE', 'g'));
  bar.appendChild(makeBtn('INFO', 'i'));
  muteBtnEl = makeBtn('MUTE', 'm', 'touch-control-mute');
  bar.appendChild(muteBtnEl);
  // Sends the same 'f' key the existing keyboard shortcut uses (handleKey,
  // app.js) -> window.api.toggleFullscreen() -> browser-api-shim.js, which
  // also attempts a landscape orientation lock right after fullscreen is
  // granted. This dispatch happens synchronously inside a real trusted
  // pointerdown handler, so it still counts as "called from a user gesture"
  // for the Fullscreen API's own gesture requirement even though the
  // keydown itself is synthetic.
  bar.appendChild(makeBtn('⛶ FULL', 'f'));

  document.body.appendChild(bar);
  controlBarEl = bar;
}

function refreshMuteLabel() {
  if (!muteBtnEl) return;
  muteBtnEl.textContent = player.muted ? 'UNMUTE' : 'MUTE';
}

function showControlBar() {
  if (!controlBarEl) return;
  refreshMuteLabel();
  controlBarEl.classList.remove('hidden');
  barHideTimer = autoHideAfter(barHideTimer, BAR_AUTOHIDE_MS, () => controlBarEl.classList.add('hidden'));
}

function toggleControlBar() {
  if (!controlBarEl) return;
  if (controlBarEl.classList.contains('hidden')) showControlBar();
  else controlBarEl.classList.add('hidden');
}

// Feature-detected, not device/user-agent sniffed — enables touch controls
// on any browser reporting a real touch-capable pointer (phones, tablets,
// touchscreen laptops), and stays a no-op everywhere else (a plain mouse/
// keyboard LAN browser, or the host itself, though this is only ever called
// from app.js's window.__isViewer branch to begin with).
export function initTouchControls() {
  if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) return;

  buildControlBar();

  let startX = 0;
  let startY = 0;
  let startT = 0;
  let startedOnBackground = false;

  tvScreen.addEventListener('touchstart', (e) => {
    startedOnBackground = isBackgroundTarget(e.target);
    if (!startedOnBackground) return;
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    // Date.now(), not viewNow() — this measures real elapsed UI gesture
    // time (how fast did the user's finger move?), unrelated to the
    // simulated broadcast clock the rest of this app reads through
    // viewNow().
    startT = Date.now();
  }, { passive: true });

  tvScreen.addEventListener('touchend', (e) => {
    if (!startedOnBackground) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dt = Date.now() - startT;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (absX < SWIPE_MIN_PX && absY < SWIPE_MIN_PX) {
      // Not a swipe — a tap, if it was quick and didn't wander far.
      if (absX < TAP_MAX_MOVE_PX && absY < TAP_MAX_MOVE_PX && dt <= TAP_MAX_MS) {
        toggleControlBar();
      }
      return;
    }
    if (absY > absX) {
      sendKey(dy < 0 ? 'ArrowUp' : 'ArrowDown'); // swipe up/down -> channel change
    } else {
      sendKey(dx < 0 ? 'ArrowLeft' : 'ArrowRight'); // swipe left/right -> time-machine shuttle (no-op unless already engaged)
    }
  }, { passive: true });

  // Reflects live mute state on the bar's own button, since 'm' can also be
  // toggled other ways (the on-screen guide-mute icon reacting to real
  // mute changes already dispatches nothing observable here, so just
  // refresh whenever the bar is shown rather than trying to observe
  // player.muted directly).
  guideMuteEl && new MutationObserver(refreshMuteLabel).observe(guideMuteEl, { attributes: true, attributeFilter: ['class'] });
}
