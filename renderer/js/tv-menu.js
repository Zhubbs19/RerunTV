// A real, D-pad/OK-navigable action menu — replaces the old keyboard-
// shortcut reference (a flat legend of "press X for Y" text, exactly as
// useless on a remote with no letter keys as the hint bar's own text was)
// with actual focusable buttons that DO the thing when activated, calling
// the exact same functions the keyboard shortcuts already call. Opened the
// same way the old reference screen was (the ? key) — works identically
// whether driven by mouse click, Enter/OK via a real keyboard, or a
// synthetic KeyboardEvent from the Android TV wrapper or the phone touch
// controls, since all of those already just dispatch a 'keydown' that
// lands here the same way.
import { shortcutsOverlayEl } from './dom.js';
import { changeChannel, jumpToLastChannel } from './playback.js';
import { showDetailsForCurrentChannel } from './details.js';
import { openGuideGrid } from './guide.js';
import { interruptEntries } from './plugins.js';
import { enterTimeMachine, exitTimeMachine, returnToLive } from './timemachine.js';
import {
  toggleMute, adjustVolume, toggleCrt, cyclePictureMode, cycleAspectMode,
  cycleSleepTimer, powerOff, toggleHintBar,
} from './power.js';
import { S } from './state.js';

// Read left-to-right, top-to-bottom — arrow-key navigation below treats the
// button list as a grid with this many columns per row.
const GRID_COLUMNS = 4;

// Any registerInterrupt entry (plugins.js) contributes its own menu button
// here — generalizes what used to be a couple of hardcoded entries naming
// specific plugins by id, so any interrupt plugin shows up in the TV menu
// automatically without a core code change.
function actions() {
  return [
    { label: 'CH ▲', run: () => changeChannel(1) },
    { label: 'CH ▼', run: () => changeChannel(-1) },
    { label: 'LAST CH', run: () => jumpToLastChannel() },
    { label: 'GUIDE', run: () => openGuideGrid() },
    { label: 'INFO', run: () => showDetailsForCurrentChannel() },
    { label: 'TIME MACHINE', run: () => (S.timeMachineOn ? exitTimeMachine() : enterTimeMachine()) },
    { label: 'RETURN TO LIVE', run: () => returnToLive() },
    ...interruptEntries().filter((e) => e.label).map((e) => ({ label: e.label, run: () => e.run({ manual: true }) })),
    { label: 'MUTE', run: () => toggleMute() },
    { label: 'VOL ▲', run: () => adjustVolume(0.1) },
    { label: 'VOL ▼', run: () => adjustVolume(-0.1) },
    { label: 'CRT FX', run: () => toggleCrt() },
    { label: 'PICTURE', run: () => cyclePictureMode() },
    { label: 'ASPECT', run: () => cycleAspectMode() },
    { label: 'SLEEP TIMER', run: () => cycleSleepTimer() },
    { label: 'FULLSCREEN', run: () => window.api.toggleFullscreen() },
    { label: 'HIDE HINTS', run: () => toggleHintBar() },
    { label: 'POWER OFF', run: () => powerOff() },
  ];
}

const gridEl = document.getElementById('tv-menu-grid');
// Built fresh every time the menu opens (not once at module load) since
// interruptEntries() only reflects whatever's registered by then — plugin
// renderer.js modules import+register asynchronously (loadPlugins(),
// app.js) after this module's own top-level code has already run.
let buttons = [];
function rebuildMenu() {
  gridEl.innerHTML = '';
  buttons = actions().map((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tv-menu-btn';
    btn.textContent = a.label;
    btn.addEventListener('click', () => {
      a.run();
      closeTvMenu();
    });
    gridEl.appendChild(btn);
    return btn;
  });
}

export function openTvMenu() {
  rebuildMenu();
  shortcutsOverlayEl.classList.remove('hidden');
  if (buttons[0]) buttons[0].focus();
}

export function closeTvMenu() {
  shortcutsOverlayEl.classList.add('hidden');
}

// Real 2D grid navigation — arrow keys move focus by row/column. A plain
// browser focus order has no concept of "up"/"down" for a grid of buttons
// (only linear Tab order), so this has to be computed explicitly. Moving
// right/left past a row's edge rolls into the next/previous row rather
// than stopping dead — a common, easy-to-predict grid-navigation behavior.
export function handleTvMenuKey(e) {
  if (e.key === '?' || e.key === 'Escape') {
    closeTvMenu();
    return;
  }
  const current = buttons.indexOf(document.activeElement);
  if (current === -1) {
    if (e.key === 'Enter' || e.key === ' ') buttons[0] && buttons[0].click();
    else if (buttons[0]) buttons[0].focus();
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    buttons[current].click();
    return;
  }
  let next = current;
  if (e.key === 'ArrowRight') next = Math.min(current + 1, buttons.length - 1);
  else if (e.key === 'ArrowLeft') next = Math.max(current - 1, 0);
  else if (e.key === 'ArrowDown') next = Math.min(current + GRID_COLUMNS, buttons.length - 1);
  else if (e.key === 'ArrowUp') next = Math.max(current - GRID_COLUMNS, 0);
  else return;
  buttons[next].focus();
}
