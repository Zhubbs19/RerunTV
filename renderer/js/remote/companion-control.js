// Companion app: seeing and driving the box's screen from a phone, and the
// phone's schedule CALENDAR (plugins/companion-app/control-routes.js is the
// HTTP half).
//
// The phone asks questions on the `remote:command` IPC channel
// ({ action: 'companion-query', id, kind, args }) and gets the answer back on
// `remote:state` as { companionReply: { id, ok, result, error } }, the pair
// the companion plugin already uses, so no new preload method or plugin
// capability was needed. Questions:
// - ui.snapshot: what is on screen — which surface (a dialog, the TV menu,
//   setup, live TV), a breadcrumb, and every control a person could reach on
//   it, in order, with its label, kind, value and choices.
// - ui.act: focus, press, set or type into one of those controls, then a
//   fresh snapshot. Indexes are only good for the snapshot they came from.
// - calendar.month: what a channel airs on each day of a month, from the
//   same calendarDayInfo the CALENDAR grid draws (setup/schedule.js).
// - calendar.setFolder: scan a folder for a block, as CHOOSE FOLDER does.
//
// Controls for things a LAN client may never change (main/config/host.js's
// deny-lists: plug-ins, network, updates, backups, the PIN lock, PC power) are
// listed but locked: the phone can see them, not press them. The D-pad is a
// remote control, the same as the box's own, and reaches what it reaches.
//
// pressCompanionRemote is the other half: a phone's RemoteKey goes through
// the TV-mode remote path (tv/input.js's RerunTVInput.native) when the box is
// in TV mode, so the TV menu hierarchy, kit dialogs and plugin channels act as
// they do with the box's own remote; in desktop mode it becomes the keyboard
// key a person would press.
import { S, dispatch, viewNow, writeConfigNow } from '../core/state.js';
import { tvScreen } from '../core/dom.js';
import { topModal } from '../ui/focus.js';
import { isTvMode } from '../tv/usage-mode.js';
import { exitPromptOpen } from '../tv/input.js';
import { HOST_ONLY_SECTIONS, SETTINGS } from '../core/settings-registry.js';
import { blockPickerLabel, calendarDayInfo, scanBlockFolder } from '../setup/schedule.js';
import { computeSourcePosition, mdKey } from '../core/schedule.js';
import { getDisplayTitle } from '../core/util.js';

// ---------- Remote buttons ----------

// The keyboard key for a RemoteKey in desktop mode (the same keys the phone's
// buttons sent before it knew RemoteKey names).
const DESKTOP_KEYS = {
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', ok: 'Enter', back: 'Escape',
  menu: '?', settings: '?', guide: 'g', info: 'i', chUp: 'ArrowUp', chDown: 'ArrowDown',
  volUp: '+', volDown: '-', mute: 'm', last: 'Backspace', captions: 'k', exit: 'Escape', home: '?',
  digit0: '0', digit1: '1', digit2: '2', digit3: '3', digit4: '4', digit5: '5', digit6: '6', digit7: '7', digit8: '8', digit9: '9', dot: '.',
  playPause: 'Enter', play: 'Enter', rewind: 'ArrowLeft', fastForward: 'ArrowRight', prev: '[', next: ']', record: 'r',
};

/**
 * Presses a remote button sent by the phone (POST /command { remote, long }).
 * In TV mode it takes the TV remote path whenever that path can act: on live
 * TV, over any dialog, and Back on the setup screen (back to live TV, as the
 * box's own remote does). The setup screen's other buttons are its own keys,
 * since TV routing stands aside there.
 * In desktop mode a dialog on screen gets the key as a real key press on the
 * control that has focus, the way a keyboard would deliver it; everything
 * else goes the way the phone's keys always have (sendKey).
 * @param {object} cmd The relayed command.
 * @param {string} cmd.remote The RemoteKey name.
 * @param {boolean} [cmd.long] A long press.
 * @param {(key: string) => void} sendKey Sends a keyboard key the way app.js relays the phone's keys.
 * @returns {boolean} True when the button did something.
 */
export function pressCompanionRemote({ remote, long = false }, sendKey) {
  const onSetup = !tvScreen || tvScreen.classList.contains('hidden');
  const overlay = !!topModal() || exitPromptOpen();
  if (isTvMode() && window.RerunTVInput && (!onSetup || overlay || remote === 'back')) {
    return window.RerunTVInput.native({ source: 'companion', key: remote, longPress: !!long }) === 'handled';
  }
  const key = DESKTOP_KEYS[remote];
  if (!key) return false;
  const surface = activeSurface();
  if (surface.kind === 'dialog') {
    pressInDialog(surface.el, key);
    return true;
  }
  sendKey(key);
  return true;
}

/**
 * Delivers a key to a dialog the way a keyboard would: a keydown on the
 * focused control. When the dialog doesn't take it, Enter presses the focused
 * button and the arrows move focus through the dialog's controls (a browser
 * does neither for a key a script sends).
 * @param {Element} dialog The dialog on screen.
 * @param {string} key The `KeyboardEvent.key`.
 */
function pressInDialog(dialog, key) {
  const focused = document.activeElement;
  const target = focused && dialog.contains(focused) ? focused : dialog;
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  // A remote button always means the default key, whatever the keyboard is remapped to.
  window.__remoteKeyDispatch = true;
  try { target.dispatchEvent(event); } finally { window.__remoteKeyDispatch = false; }
  // Handled already: marked so, the dialog went away, or something moved focus
  // (the TV menu moves it on arrows without marking the key).
  if (event.defaultPrevented || !dialog.isConnected || !isShown(dialog) || document.activeElement !== focused) return;
  const el = document.activeElement;
  if (key === 'Enter') {
    if (el && dialog.contains(el) && el.matches(CONTROL_SELECTOR) && !isTextField(el)) el.click();
    return;
  }
  const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[key];
  if (!step) return;
  const controls = Array.from(dialog.querySelectorAll(FOCUSABLE))
    .filter((c) => c !== dialog && !isFocusableContainer(c) && !c.disabled && isShown(c));
  if (!controls.length) return;
  const at = controls.indexOf(el);
  const next = controls[at < 0 ? 0 : (at + step + controls.length) % controls.length];
  next.focus();
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ---------- What is on screen ----------

const FOCUSABLE = [
  'button', 'a[href]', 'input:not([type="hidden"])', 'select', 'textarea', '[tabindex]:not([tabindex="-1"])',
  '[role="button"]', '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="checkbox"]',
].join(', ');
// Enough for the longest setup page; a page with more says `truncated`.
const MAX_ITEMS = 400;
const MAX_OPTIONS = 200;
const SECRET = /(?:api.?key|token|secret|password|credential|auth|pin)/i;

// Setting rows (index.html data-setting = registry id) a remote may not change.
const LOCKED_SETTING_IDS = new Set(SETTINGS
  .filter((entry) => entry.remote === false || (entry.path && HOST_ONLY_SECTIONS.includes(entry.path[0])))
  .map((entry) => entry.id));
// Whole areas that only a person at the host may change.
const LOCKED_AREAS = [
  ['[data-tab-panel="plugins"]', 'Plug-ins can only be changed on the host.'],
  ['.plugin-perms-dialog', 'Plug-in permissions can only be changed on the host.'],
  ['[data-subtab-panel="network"]', 'Network services can only be changed on the host.'],
  ['[data-subtab-panel="updates"]', 'Update settings can only be changed on the host.'],
  ['[data-subtab-panel="backups"]', 'Backups can only be restored on the host.'],
];
// TV menu (tv/setup.js) sections for the same things, by their title.
const LOCKED_TV_MENU = [
  [/PARENTAL LOCK/, 'The PIN lock can only be changed on the host.'],
  [/UPDATES/, 'Update settings can only be changed on the host.'],
];
const LOCKED_TV_ITEMS = [[/PC SHUTDOWN|SHUTS DOWN PC/, 'PC power can only be changed on the host.']];
// In a locked area's dialogs, these still work: the phone can always back out.
const ALWAYS_ALLOWED = /^(cancel|close|back|no|not now|done|ok)$/i;

let snapshotSeq = 0;
// The last few snapshots' elements by id. The phone polls while a person taps,
// so a tap can name the snapshot just before the newest one.
const KEEP_SNAPSHOTS = 6;
const recentSnapshots = new Map();

/**
 * Collapses whitespace and trims text to a length.
 * @param {*} text The text.
 * @param {number} [max=120] The longest result.
 * @returns {string} The cleaned text.
 */
function clean(text, max = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Whether an element is drawn and can be reached (not hidden, inert or behind aria-hidden).
 * @param {Element} el The element.
 * @returns {boolean} True when it is on screen.
 */
function isShown(el) {
  if (!el || !el.isConnected) return false;
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if (!el.getClientRects().length) return false;
  return getComputedStyle(el).visibility !== 'hidden';
}

/**
 * The surface that answers input now: the top dialog, the exit prompt, the
 * setup screen, or live TV.
 * @returns {object} `{ el, kind }`; kind is `dialog`, `setup` or `tv`.
 */
function activeSurface() {
  const modal = topModal();
  const modalEl = modal && (typeof modal.element === 'function' ? modal.element() : modal.element);
  if (exitPromptOpen()) {
    const prompt = document.querySelector('.tv-exit-prompt');
    if (prompt && isShown(prompt)) return { el: prompt, kind: 'dialog' };
  }
  if (modalEl && isShown(modalEl)) return { el: modalEl, kind: 'dialog' };
  // Overlays that aren't on the modal stack (the TV menu, the guide, a
  // preview modal): the last one drawn is on top.
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"], .preview-modal'))
    .filter(isShown);
  if (dialogs.length) return { el: dialogs[dialogs.length - 1], kind: 'dialog' };
  const setup = document.getElementById('setup-screen');
  if (setup && isShown(setup)) return { el: setup, kind: 'setup' };
  return { el: tvScreen, kind: 'tv' };
}

/**
 * Text of the elements an `aria-labelledby` names.
 * @param {Element} el The element.
 * @returns {string} The text, or ''.
 */
function labelledByText(el) {
  const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  return clean(ids.map((id) => (document.getElementById(id) || {}).textContent || '').join(' '));
}

/**
 * The name a person would read for a control.
 * @param {Element} el The control.
 * @returns {string} Its label.
 */
function controlLabel(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);
  const by = labelledByText(el);
  if (by) return by;
  if (el.labels && el.labels.length) {
    const text = clean(Array.from(el.labels).map((l) => l.textContent).join(' '));
    if (text) return text;
  }
  const isField = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
  if (!isField) {
    const text = clean(el.textContent);
    if (text) return text;
  }
  // A field with no label of its own: its setting row's label, then hints.
  const row = el.closest('.setting-row');
  const rowLabel = row && row.querySelector('.setting-row-label');
  if (rowLabel) return clean(rowLabel.textContent);
  return clean(el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.id || el.tagName.toLowerCase());
}

/**
 * The heading of the part of the surface a control sits in, for grouping the phone's list.
 * @param {Element} el The control.
 * @param {Element} surface The surface root.
 * @returns {string} The group label, or ''.
 */
function groupLabel(el, surface) {
  let node = el.parentElement;
  for (let depth = 0; node && node !== surface && depth < 14; depth += 1, node = node.parentElement) {
    if (node.classList.contains('setup-sidebar')) return 'SECTIONS';
    if (node.classList.contains('setup-subtabs')) return 'PAGES';
    const aria = node.getAttribute('aria-label');
    if (aria && !node.matches(FOCUSABLE)) return clean(aria, 60);
    if (node.tagName === 'FIELDSET') {
      const legend = node.querySelector(':scope > legend');
      if (legend) return clean(legend.textContent, 60);
    }
    const heading = node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > .panel-toggle, :scope > .panel-title');
    if (heading && !heading.contains(el)) return clean(heading.textContent, 60);
  }
  return '';
}

/**
 * Why the phone may not press or change a control, or null when it may.
 * @param {Element} el The control.
 * @param {?string} areaReason The lock that covers the whole surface, if any.
 * @param {string} label The control's label.
 * @returns {?string} The reason.
 */
function lockReason(el, areaReason, label) {
  for (const [selector, reason] of LOCKED_AREAS) {
    if (el.closest(selector)) return reason;
  }
  const row = el.closest('.setting-row[data-setting]');
  if (row && LOCKED_SETTING_IDS.has(row.dataset.setting)) return 'This setting can only be changed on the host.';
  if (el.closest('#shortcuts-overlay')) {
    const hit = LOCKED_TV_ITEMS.find(([pattern]) => pattern.test(label));
    if (hit) return hit[1];
  }
  if (areaReason && !ALWAYS_ALLOWED.test(label)) return areaReason;
  return null;
}

/**
 * A lock that covers everything on the current surface: a dialog opened from
 * a host-only setup page, or a host-only TV menu section.
 * @param {object} surface The active surface.
 * @returns {?string} The reason, or null.
 */
function surfaceLock(surface) {
  if (surface.el && surface.el.id === 'shortcuts-overlay') {
    const title = clean((document.getElementById('tv-menu-title') || {}).textContent);
    const hit = LOCKED_TV_MENU.find(([pattern]) => pattern.test(title));
    return hit ? hit[1] : null;
  }
  if (surface.kind !== 'dialog') return null;
  const setup = document.getElementById('setup-screen');
  if (!setup || !isShown(setup)) return null;
  // The setup page underneath decides: a confirm opened from PLUG-INS is a
  // plug-in change, whatever the dialog itself says.
  const pages = Array.from(setup.querySelectorAll('.setup-tab-panel:not(.hidden), .setup-subtab-panel:not(.hidden)'))
    .filter((panel) => panel.getClientRects().length);
  for (const panel of pages) {
    const hit = LOCKED_AREAS.find(([selector]) => panel.matches(selector));
    if (hit) return hit[1];
  }
  return null;
}

/**
 * The kind of control, for the phone to draw it.
 * @param {Element} el The control.
 * @returns {string} `button`, `tab`, `option`, `link`, `checkbox`, `switch`, `radio`, `select`, `range`, `number`, `text`, `textarea` or `password`.
 */
function controlKind(el) {
  const role = el.getAttribute('role');
  if (el.tagName === 'SELECT') return 'select';
  if (el.tagName === 'TEXTAREA') return 'textarea';
  if (el.tagName === 'INPUT') {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['checkbox', 'radio', 'range', 'number', 'password'].includes(type)) return type;
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'color' || type === 'file') return 'button';
    return 'text';
  }
  if (['tab', 'option', 'menuitem', 'switch', 'checkbox'].includes(role)) return role === 'menuitem' ? 'button' : role;
  if (el.tagName === 'A') return 'link';
  return 'button';
}

// Matched only because it has a tabindex: a scroll pane or a list wrapper.
const CONTROL_SELECTOR = FOCUSABLE.split(', ').filter((sel) => !sel.startsWith('[tabindex]')).join(', ');

/**
 * Whether an element is listed only for its tabindex but holds real controls
 * (a scroll pane, a list wrapper), so the phone lists its contents instead.
 * @param {Element} el The element.
 * @returns {boolean} True for such a container.
 */
function isFocusableContainer(el) {
  return !el.matches(CONTROL_SELECTOR) && !!el.querySelector(FOCUSABLE);
}

/**
 * Whether a control is one a person types into.
 * @param {Element} el The control.
 * @returns {boolean} True for text, number and password inputs and text areas.
 */
function isTextField(el) {
  return !!el && ['text', 'textarea', 'number', 'password'].includes(controlKind(el));
}

/**
 * The phone's description of one control.
 * @param {Element} el The control.
 * @param {number} index Its index in the snapshot.
 * @param {object} surface The active surface.
 * @param {?string} areaReason The surface-wide lock, if any.
 * @param {boolean} focused Whether this is the control with focus (real or a menu's own).
 * @returns {object} `{ index, kind, label, group, ... }`.
 */
function describeControl(el, index, surface, areaReason, focused) {
  const kind = controlKind(el);
  const label = controlLabel(el);
  const item = { index, kind, label, group: groupLabel(el, surface.el) };
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
  if (focused) item.focused = true;
  if (el.classList.contains('active') || el.classList.contains('selected') || ['aria-selected', 'aria-pressed', 'aria-current'].some((a) => el.getAttribute(a) === 'true')) {
    item.selected = true;
  }
  const locked = lockReason(el, areaReason, label);
  if (locked) item.locked = locked;
  if (kind === 'checkbox' || kind === 'radio' || kind === 'switch') {
    item.checked = el.tagName === 'INPUT' ? !!el.checked : el.getAttribute('aria-checked') === 'true';
  } else if (kind === 'select') {
    item.value = el.value;
    item.options = Array.from(el.options).slice(0, MAX_OPTIONS)
      .map((o) => ({ value: o.value, label: clean(o.textContent, 80), disabled: o.disabled || undefined }));
  } else if (kind === 'range' || kind === 'number') {
    item.value = el.value === '' ? null : Number(el.value);
    ['min', 'max', 'step'].forEach((key) => {
      const v = el.getAttribute(key);
      if (v != null && v !== '' && Number.isFinite(Number(v))) item[key] = Number(v);
    });
  } else if (kind === 'text' || kind === 'textarea' || kind === 'password') {
    // Credentials keep their shape but never cross the LAN.
    const secret = kind === 'password' || SECRET.test(`${el.name || ''} ${el.id || ''} ${label}`);
    if (secret) item.secret = true;
    item.value = secret ? null : clean(el.value, 500);
    if (el.getAttribute('placeholder')) item.placeholder = clean(el.getAttribute('placeholder'), 80);
  }
  return item;
}

/**
 * Breadcrumb for the setup screen: section, the channel being edited, and open pages.
 * @returns {string[]} The trail.
 */
function setupTrail() {
  const setup = document.getElementById('setup-screen');
  if (!setup || !isShown(setup)) return [];
  const trail = [];
  const section = setup.querySelector('.setup-tab-btn.active');
  if (section) trail.push(clean(section.getAttribute('aria-label') || section.textContent, 40));
  if (section && section.dataset.tab === 'channels' && S.setupSelectedChannel != null) {
    const ch = (S.config.channels || []).find((c) => c.number === S.setupSelectedChannel);
    trail.push(clean(`CH ${S.setupSelectedChannel}${ch && ch.name ? ` ${ch.name}` : ''}`, 40));
  }
  setup.querySelectorAll('.setup-subtab-btn.active, .edit-tab-btn.active, [role="tab"][aria-selected="true"]').forEach((tab) => {
    if (!isShown(tab)) return;
    const text = clean(tab.textContent, 40);
    if (text && !trail.includes(text)) trail.push(text);
  });
  return trail;
}

/**
 * The title of a surface: its label, its first heading, or what's on live TV.
 * @param {object} surface The active surface.
 * @returns {string} The title.
 */
function surfaceTitle(surface) {
  if (surface.kind === 'tv') {
    const ch = (S.config.channels || []).find((c) => c.number === S.currentNumber);
    return clean(`LIVE TV · CH ${S.currentNumber != null ? S.currentNumber : '—'}${ch && ch.name ? ` ${ch.name}` : ''}`);
  }
  if (surface.kind === 'setup') return 'SETUP';
  const el = surface.el;
  if (el.id === 'shortcuts-overlay') {
    const title = document.getElementById('tv-menu-title');
    if (title && clean(title.textContent)) return clean(title.textContent);
  }
  const by = labelledByText(el);
  if (by) return by;
  if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
  const heading = el.querySelector('h1, h2, h3, .confirm-dialog-title, .dialog-title, [class*="-title"]');
  return heading ? clean(heading.textContent) : 'DIALOG';
}

/**
 * Takes a snapshot of what's on screen for the phone. Remembers the listed
 * elements so a later ui.act can name one by index.
 * @returns {object} `{ id, screen, mode, kind, title, trail, focusedIndex, items, truncated }`.
 */
export function snapshotScreen() {
  const surface = activeSurface();
  const areaReason = surfaceLock(surface);
  const all = Array.from(surface.el.querySelectorAll(FOCUSABLE))
    .filter((el) => el !== surface.el && !isFocusableContainer(el) && isShown(el));
  const elements = all.slice(0, MAX_ITEMS);
  snapshotSeq += 1;
  recentSnapshots.set(snapshotSeq, elements);
  while (recentSnapshots.size > KEEP_SNAPSHOTS) recentSnapshots.delete(recentSnapshots.keys().next().value);
  // The cable-guide menus keep their own focus (a `focus` class on the row,
  // cable-guide/main-menu.js), which wins over wherever the page's focus was left.
  let focusedIndex = elements.findIndex((el) => el.classList.contains('focus'));
  if (focusedIndex < 0) focusedIndex = elements.indexOf(document.activeElement);
  const items = elements.map((el, i) => describeControl(el, i, surface, areaReason, i === focusedIndex));
  return {
    id: snapshotSeq,
    screen: tvScreen && !tvScreen.classList.contains('hidden') ? 'tv' : 'setup',
    mode: isTvMode() ? 'tv' : 'desktop',
    kind: surface.kind,
    title: surfaceTitle(surface),
    trail: setupTrail(),
    ...(areaReason ? { locked: areaReason } : {}),
    focusedIndex: focusedIndex >= 0 ? focusedIndex : null,
    items,
    truncated: all.length > elements.length,
  };
}

/**
 * Sets a form control's value the way typing or picking would, firing input and change.
 * @param {Element} el The control.
 * @param {*} value The new value.
 */
function setControlValue(el, value) {
  const kind = controlKind(el);
  if (kind === 'checkbox' || kind === 'radio' || kind === 'switch') {
    const checked = el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
    if (checked !== !!value) el.click();
    return;
  }
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) throw new Error("That control doesn't take a value.");
  let text = String(value);
  if (kind === 'select' && !Array.from(el.options).some((o) => o.value === text && !o.disabled)) {
    throw new Error("That isn't one of the choices.");
  }
  if (kind === 'range' || kind === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error('That needs a number.');
    const min = el.getAttribute('min') !== null && el.getAttribute('min') !== '' ? Number(el.min) : -Infinity;
    const max = el.getAttribute('max') !== null && el.getAttribute('max') !== '' ? Number(el.max) : Infinity;
    text = String(Math.min(max, Math.max(min, n)));
  }
  el.focus({ preventScroll: true });
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Waits for the page to draw what an action changed.
 * @returns {Promise<void>}
 */
function afterPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 30))));
}

/**
 * Focuses, presses, sets or types into a control from the last snapshot.
 * @param {object} args The action.
 * @param {string} args.op `focus`, `activate`, `set` or `text`.
 * @param {number} [args.snapshot] The snapshot id the index belongs to.
 * @param {number} [args.index] The control's index; `text` without one types into the focused field.
 * @param {*} [args.value] The new value, for `set`.
 * @param {string} [args.text] The text, for `text`.
 * @param {boolean} [args.submit] For `text`, press Enter after typing.
 * @returns {Promise<object>} A fresh snapshot.
 * @throws {Error} When the screen has changed, or the control is locked, off or the wrong kind.
 */
export async function actOnScreen({ op, snapshot, index, value, text, submit }) {
  let el;
  if (Number.isInteger(index)) {
    const elements = recentSnapshots.get(snapshot);
    if (!elements) throw new Error('The screen changed. Look again and retry.');
    el = elements[index];
    if (!el || !isShown(el)) throw new Error('That control is no longer on screen.');
  } else {
    el = document.activeElement;
    if (!isTextField(el) || !isShown(el)) throw new Error('No text field is selected on the box. Pick one first.');
  }
  const surface = activeSurface();
  const reason = lockReason(el, surfaceLock(surface), controlLabel(el));
  if (reason) throw new Error(reason);
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('That control is switched off right now.');

  if (op === 'focus') {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } else if (op === 'activate') {
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // Fields take focus (then the phone types or picks); everything else is pressed.
    if (!isTextField(el) && controlKind(el) !== 'select' && controlKind(el) !== 'range') el.click();
  } else if (op === 'set') {
    setControlValue(el, value);
  } else if (op === 'text') {
    if (!isTextField(el)) throw new Error("That control isn't a text field.");
    setControlValue(el, text);
    if (submit) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  } else {
    throw new Error('Unknown action.');
  }
  await afterPaint();
  return snapshotScreen();
}

// ---------- Calendar ----------

// Folder scans the phone started, by block id, so the calendar can show
// progress: { state: 'scanning' | 'done' | 'failed', text, at }.
const folderScans = new Map();

/**
 * Finds a channel in the live config.
 * @param {number} number The channel number.
 * @returns {object} The channel.
 * @throws {Error} When there is none.
 */
function requireChannel(number) {
  const ch = (S.config.channels || []).find((c) => c.number === number);
  if (!ch) throw new Error('No channel has that number.');
  return ch;
}

/**
 * What a channel airs on each day of a month, for the phone's calendar.
 * @param {object} args The question.
 * @param {number} args.channel The channel number.
 * @param {number} [args.year] The year; defaults to the box's today (time-machine aware).
 * @param {number} [args.month] The month, 1–12; defaults with the year.
 * @returns {object} `{ year, month, today, days, scans }`.
 */
export function calendarMonth({ channel, year, month }) {
  const ch = requireChannel(channel);
  const now = new Date(viewNow());
  const y = Number.isInteger(year) && Number.isInteger(month) ? year : now.getFullYear();
  const m = Number.isInteger(year) && Number.isInteger(month) ? month : now.getMonth() + 1;
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const dayMs = new Date(y, m - 1, day, 12, 0, 0, 0).getTime();
    const info = calendarDayInfo(ch, dayMs);
    const block = info.source.block || null;
    const key = mdKey(dayMs);
    const pos = computeSourcePosition(info.source, dayMs);
    days.push({
      day,
      key,
      weekday: new Date(dayMs).getDay(),
      label: info.label,
      color: info.color,
      blockId: block ? block.id : null,
      overlaps: info.conflict ? info.matches.map((b) => ({ id: b.id, label: blockPickerLabel(b) })) : [],
      emptyBlocks: info.emptyMatches.map((b) => ({ id: b.id, label: blockPickerLabel(b) })),
      isDaily: info.isDaily,
      override: block && block.dayOverrides && block.dayOverrides[key] ? block.dayOverrides[key] : null,
      atNoon: pos && pos.file ? getDisplayTitle(pos.file) : null,
    });
  }
  const scans = {};
  folderScans.forEach((entry, id) => { scans[id] = { state: entry.state, text: entry.text }; });
  return {
    year: y,
    month: m,
    today: { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() },
    days,
    labels: Object.fromEntries((ch.blocks || []).map((b) => [b.id, blockPickerLabel(b)])),
    colors: Object.fromEntries(days.filter((d) => d.blockId && d.color).map((d) => [d.blockId, d.color])),
    scans,
  };
}

/**
 * Points a block at a folder from the phone: scans and probes it as CHOOSE
 * FOLDER does, then records the change as one edit. Runs in the background;
 * the calendar reports progress under `scans`.
 * @param {object} args The request.
 * @param {number} args.channel The channel number.
 * @param {string} args.blockId The block.
 * @param {string} args.folder The folder's path on this machine (checked by the plugin).
 * @returns {object} `{ started: true }`.
 * @throws {Error} When the block is gone or already being scanned.
 */
export function setBlockFolder({ channel, blockId, folder }) {
  const ch = requireChannel(channel);
  const block = (ch.blocks || []).find((b) => b.id === blockId);
  if (!block) throw new Error('That block is no longer on this channel.');
  if (typeof folder !== 'string' || !folder) throw new Error('A folder is required.');
  if (folderScans.get(blockId) && folderScans.get(blockId).state === 'scanning') throw new Error('That block is already being scanned.');
  const entry = { state: 'scanning', text: 'SCANNING FOLDER…', at: Date.now() };
  folderScans.set(blockId, entry);
  (async () => {
    try {
      const { files, unreadable, error } = await scanBlockFolder(folder, { shuffle: !!ch.shuffle, onProgress: (t) => { entry.text = t; } });
      if (error) {
        Object.assign(entry, { state: 'failed', text: error === 'empty' ? 'NO VIDEO FILES IN THAT FOLDER' : "COULDN'T READ ANY VIDEO IN THAT FOLDER" });
        return;
      }
      const live = requireChannel(channel);
      const target = (live.blocks || []).find((b) => b.id === blockId);
      if (!target) { Object.assign(entry, { state: 'failed', text: 'THE BLOCK WAS REMOVED WHILE SCANNING' }); return; }
      // A channel anchor is a real-time stamp (CLAUDE.md's exception list),
      // the same as CHOOSE FOLDER sets.
      dispatch({
        type: 'item.set', collection: 'blocks', channel, id: blockId,
        fields: { folder, files, anchor: Date.now() },
      }, { label: `Set ${blockPickerLabel(target)} folder from the phone` });
      // Done only once the box has it: the phone reads the block back next and
      // edits it at that revision.
      await writeConfigNow();
      Object.assign(entry, { state: 'done', text: `${files.length} VIDEOS${unreadable ? `, ${unreadable} UNREADABLE SKIPPED` : ''}` });
    } catch (e) {
      Object.assign(entry, { state: 'failed', text: clean(`COULDN'T SCAN THAT FOLDER: ${(e && e.message) || e}`, 120).toUpperCase() });
    }
  })();
  return { started: true };
}

// ---------- Questions from the phone ----------

const HANDLERS = {
  'ui.snapshot': () => snapshotScreen(),
  'ui.act': (args) => actOnScreen(args),
  'calendar.month': (args) => calendarMonth(args),
  'calendar.setFolder': (args) => setBlockFolder(args),
};

/**
 * Answers one question the companion plugin relayed, on `remote:state`.
 * @param {object} query `{ id, kind, args }`.
 * @returns {Promise<void>}
 */
export async function answerCompanionQuery({ id, kind, args }) {
  let reply;
  try {
    const handler = HANDLERS[kind];
    if (!handler) throw new Error(`Unknown question "${kind}".`);
    reply = { id, ok: true, result: await handler(args || {}) };
  } catch (e) {
    reply = { id, ok: false, error: (e && e.message) || String(e) };
  }
  if (window.api && typeof window.api.sendRemoteState === 'function') window.api.sendRemoteState({ companionReply: reply });
}
