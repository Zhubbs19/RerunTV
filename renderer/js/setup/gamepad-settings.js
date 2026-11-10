// SYSTEM › REMOTE & KEYS › GAME CONTROLLER: the on/off switch, stick dead zone,
// background switch, and the editor that says what each controller button
// does. The tables and the polling loop are tv/gamepad.js; this is the form.
import { S, dispatch } from '../core/state.js';
import {
  GAMEPAD_CONTROLS, GAMEPAD_TARGETS, connectedGamepads, defaultGamepadTarget, gamepadSettings, gamepadTarget, onGamepadActivity,
} from '../tv/gamepad.js';
import { Button } from '../ui/button.js';
import { Select } from '../ui/controls.js';
import { attachSliderReadout } from './util.js';
import { refreshDependentControls } from './dependent-controls.js';

const enabledEl = document.getElementById('gamepad-enabled');
const deadzoneEl = document.getElementById('gamepad-deadzone');
const backgroundEl = document.getElementById('gamepad-background');
const keyboardEl = document.getElementById('gamepad-keyboard');
const statusEl = document.getElementById('gamepad-status');
const editorEl = document.getElementById('gamepad-map-editor');
const deadzoneReadout = deadzoneEl ? attachSliderReadout(deadzoneEl, { suffix: '%' }) : null;

// How long a pressed button's row stays lit.
const PRESSED_FLASH_MS = 900;

/**
 * Sets one `gamepad` setting as an undoable command.
 * @param {string[]} path The path under `config.gamepad`.
 * @param {*} value The new value; undefined removes the key.
 * @param {object} [opts] Options passed to `dispatch()`, such as `coalesce`.
 */
const setGamepad = (path, value, opts) => dispatch({ type: 'settings.set', path: ['gamepad', ...path], value }, opts);

/**
 * Says which controller is connected, or how to connect one.
 */
function renderStatus() {
  if (!statusEl) return;
  const pads = connectedGamepads();
  if (!pads.length) {
    statusEl.textContent = 'No controller found yet. Connect one, then press any button on it.';
    return;
  }
  const names = pads.map((pad) => pad.name).join(', ');
  const odd = pads.some((pad) => !pad.standard);
  statusEl.textContent = `Connected: ${names}.${odd ? ' This controller reports its buttons in its own order, so the names below may not match. Press a button to see which row it is.' : ''}`;
}

/**
 * Draws one row per controller button: its name, what it does, and a reset when that was changed.
 */
function renderEditor() {
  if (!editorEl) return;
  const { buttons } = gamepadSettings(S.config);
  editorEl.innerHTML = '';
  const options = GAMEPAD_TARGETS.map((target) => ({ value: target.id, label: target.group === 'shortcut' ? `Shortcut: ${target.label}` : target.label }));
  GAMEPAD_CONTROLS.forEach((control) => {
    const shipped = defaultGamepadTarget(control.id);
    const current = gamepadTarget(buttons, control.id) || 'none';
    const row = document.createElement('div');
    row.className = 'keymap-row gamepad-map-row';
    row.dataset.gamepadControl = control.id;
    const label = document.createElement('span');
    label.className = 'keymap-label';
    label.textContent = control.label;
    const select = Select({
      options,
      value: current,
      label: `${control.label} does`,
      onChange: (value) => {
        setGamepad(['buttons', control.id], value === shipped ? undefined : value);
        renderEditor();
      },
    });
    select.classList.toggle('keymap-changed', current !== shipped);
    const reset = Button({
      label: 'RESET',
      className: 'keymap-reset',
      title: `Back to ${(GAMEPAD_TARGETS.find((target) => target.id === shipped) || {}).label || 'Nothing'}`,
      onPress: () => {
        setGamepad(['buttons', control.id], undefined);
        renderEditor();
      },
    });
    reset.hidden = current === shipped;
    // The same wrapper a setting row uses, so the list looks like every other one in both layouts.
    const selectWrap = document.createElement('div');
    selectWrap.className = 'setting-row-control';
    selectWrap.appendChild(select);
    row.append(label, selectWrap, reset);
    editorEl.appendChild(row);
  });
}

/**
 * Fills the game controller panel from the current config.
 */
export function renderGamepadSettings() {
  if (!enabledEl) return;
  const cfg = gamepadSettings(S.config);
  enabledEl.checked = cfg.enabled;
  deadzoneEl.value = String(Math.round(cfg.deadzone * 100));
  if (deadzoneReadout && deadzoneReadout.refresh) deadzoneReadout.refresh();
  backgroundEl.checked = cfg.background;
  keyboardEl.checked = cfg.keyboard;
  renderStatus();
  renderEditor();
  refreshDependentControls();
}

if (enabledEl) {
  enabledEl.addEventListener('change', () => { setGamepad(['enabled'], enabledEl.checked); refreshDependentControls(); });
  deadzoneEl.addEventListener('input', () => {
    setGamepad(['deadzone'], (parseInt(deadzoneEl.value, 10) || 50) / 100, { coalesce: 'settings:gamepad.deadzone' });
  });
  backgroundEl.addEventListener('change', () => setGamepad(['background'], backgroundEl.checked));
  keyboardEl.addEventListener('change', () => setGamepad(['keyboard'], keyboardEl.checked));
  document.querySelector('.setup-subtab-btn[data-subtab="keys"]')?.addEventListener('click', renderGamepadSettings);

  // A pressed button lights its row, so nobody has to know which one "View" is.
  const flashTimers = new Map();
  onGamepadActivity((info) => {
    if (!editorEl.isConnected || editorEl.offsetParent === null) return; // the panel isn't on screen
    if (info.type === 'pads') { renderStatus(); return; }
    const row = editorEl.querySelector(`[data-gamepad-control="${info.button}"]`);
    if (!row) return;
    row.classList.add('gamepad-row-pressed');
    row.scrollIntoView({ block: 'nearest' });
    clearTimeout(flashTimers.get(info.button));
    flashTimers.set(info.button, setTimeout(() => {
      flashTimers.delete(info.button);
      editorEl.querySelector(`[data-gamepad-control="${info.button}"]`)?.classList.remove('gamepad-row-pressed');
    }, PRESSED_FLASH_MS));
    if (statusEl && statusEl.textContent.startsWith('No controller')) renderStatus();
  });
}
