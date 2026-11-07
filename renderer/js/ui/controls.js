// Toggle, Slider, Select, Segmented, NumberStepper, ColorPick
// (docs/design/04 §3). Native elements underneath wherever one exists, so
// forms, labels, search and the existing input styling keep working.
//
// Controls that use ◀▶ themselves (Slider, Segmented, NumberStepper) carry
// data-ui-arrows="horizontal"; TV focus movement hands those keys to the
// control instead of moving focus away from it.
import { bindPress, h, nextId, rovingIndex, stepValue } from './kit-core.js';

// ---------- Pure ----------
/**
 * Formats a control's value for its readout.
 * @param {*} value The value.
 * @param {string|Function} [format] `'percent'` (0..1 shown as a percentage) or a formatter function.
 * @returns {string} The readout text.
 */
export function formatReadout(value, format) {
  if (typeof format === 'function') return String(format(value));
  if (format === 'percent') return `${Math.round(Number(value) * 100)}%`;
  return String(value);
}

// ---------- DOM ----------
/**
 * Toggle({ checked, onChange, label, id }) — a checkbox with switch
 * semantics. With `label` it brings its own <label>; inside a SettingRow or
 * Field leave label out and let the row label it.
 * @param {object} [opts] Options.
 * @param {boolean} [opts.checked=false] Initial state.
 * @param {(checked: boolean) => void} [opts.onChange] Called with the new state.
 * @param {string} [opts.label=''] Optional own label text.
 * @param {string} [opts.id] Input id; generated when omitted.
 * @param {boolean} [opts.disabled=false] Whether it is disabled.
 * @param {string} [opts.className=''] Extra classes on the input.
 * @returns {HTMLElement} The checkbox, or a <label> wrapping it when `label` is given.
 */
export function Toggle({ checked = false, onChange, label = '', id, disabled = false, className = '' } = {}) {
  const input = h('input', { type: 'checkbox', className: ['ui-toggle', className].filter(Boolean).join(' '), attrs: { role: 'switch' } });
  input.id = id || nextId('toggle');
  input.checked = !!checked;
  input.disabled = !!disabled;
  const sync = () => input.setAttribute('aria-checked', String(input.checked));
  sync();
  input.addEventListener('change', () => { sync(); if (onChange) onChange(input.checked); });
  if (!label) return input;
  return h('label', { className: 'ui-toggle-label', htmlFor: input.id }, input, h('span', { text: label }));
}

/**
 * Slider({ min, max, step, value, format, onInput, onChange }) → wrapper with
 * .input (the range) and setValue(v). The readout follows every step.
 * @param {object} [opts] Options.
 * @param {number} [opts.min=0] Minimum.
 * @param {number} [opts.max=100] Maximum.
 * @param {number} [opts.step=1] Step.
 * @param {number} [opts.value=0] Initial value.
 * @param {string|Function} [opts.format] Readout format, see formatReadout.
 * @param {(value: number) => void} [opts.onInput] Called on every step.
 * @param {(value: number) => void} [opts.onChange] Called when the drag ends.
 * @param {string} [opts.id] Input id; generated when omitted.
 * @param {string} [opts.label=''] Accessible name.
 * @param {boolean} [opts.disabled=false] Whether it is disabled.
 * @param {string} [opts.className=''] Extra classes on the wrapper.
 * @returns {HTMLElement} The wrapper, with `.input` and `.setValue(v)`.
 */
export function Slider({ min = 0, max = 100, step = 1, value = 0, format, onInput, onChange, id, label = '', disabled = false, className = '' } = {}) {
  const input = h('input', { type: 'range', min, max, step, value, disabled, attrs: { 'aria-label': label || undefined } });
  input.id = id || nextId('slider');
  const readout = h('output', { className: 'ui-slider-readout', htmlFor: input.id, attrs: { 'aria-hidden': 'true' } });
  const wrap = h('div', { className: ['ui-slider', className].filter(Boolean).join(' '), dataset: { uiArrows: 'horizontal' } }, input, readout);
  const paint = () => {
    const text = formatReadout(Number(input.value), format);
    readout.textContent = text;
    input.setAttribute('aria-valuetext', text);
  };
  paint();
  input.addEventListener('input', () => { paint(); if (onInput) onInput(Number(input.value)); });
  input.addEventListener('change', () => { if (onChange) onChange(Number(input.value)); });
  wrap.input = input;
  wrap.setValue = (v) => { input.value = String(v); paint(); };
  return wrap;
}

/**
 * A native select built from an options list.
 * Select({ options: [{ value, label, disabled }] | ['a', 'b'], value, onChange })
 * @param {object} [opts] Options.
 * @param {Array<object|string>} [opts.options=[]] `{ value, label, disabled }` objects or plain values.
 * @param {*} [opts.value] The selected value.
 * @param {(value: string) => void} [opts.onChange] Called with the new value (as a string).
 * @param {string} [opts.id] Select id; generated when omitted.
 * @param {string} [opts.label=''] Accessible name.
 * @param {boolean} [opts.disabled=false] Whether it is disabled.
 * @param {string} [opts.className=''] Classes on the select.
 * @returns {HTMLSelectElement} The select.
 */
export function Select({ options = [], value, onChange, id, label = '', disabled = false, className = '' } = {}) {
  const select = h('select', { className, disabled, attrs: { 'aria-label': label || undefined } });
  select.id = id || nextId('select');
  options.forEach((opt) => {
    const o = typeof opt === 'object' ? opt : { value: opt, label: String(opt) };
    select.appendChild(h('option', { value: String(o.value), text: o.label, disabled: !!o.disabled }));
  });
  if (value !== undefined) select.value = String(value);
  select.addEventListener('change', () => { if (onChange) onChange(select.value); });
  return select;
}

/**
 * Segmented({ items: [{ value, label, title }], value, onChange, label }) — a
 * row of mutually exclusive choices. ◀▶ Home End move and choose (the radio
 * group pattern); only the chosen segment is a Tab stop.
 * @param {object} [opts] Options.
 * @param {Array<object>} [opts.items=[]] `{ value, label, title }` choices.
 * @param {*} [opts.value] The chosen value.
 * @param {(value: *) => void} [opts.onChange] Called when the user picks a different value.
 * @param {string} [opts.label=''] Accessible name of the group.
 * @param {string} [opts.className=''] Extra classes on the group.
 * @param {string} [opts.itemClassName='btn'] Classes on each segment.
 * @returns {HTMLElement} The group, with `.setValue(v)` and `.getValue()`.
 */
export function Segmented({ items = [], value, onChange, label = '', className = '', itemClassName = 'btn' } = {}) {
  const group = h('div', { className: ['ui-segmented', className].filter(Boolean).join(' '), attrs: { role: 'radiogroup', 'aria-label': label || undefined }, dataset: { uiArrows: 'horizontal' } });
  let current = value;
  const buttons = items.map((item) => {
    const btn = h('button', { type: 'button', className: ['ui-segment', itemClassName].filter(Boolean).join(' '), text: item.label, attrs: { role: 'radio', title: item.title || undefined }, dataset: { value: String(item.value) } });
    bindPress(btn, () => choose(item.value, true));
    group.appendChild(btn);
    return btn;
  });
  function paint() {
    buttons.forEach((btn, i) => {
      const on = String(items[i].value) === String(current);
      btn.setAttribute('aria-checked', String(on));
      btn.classList.toggle('active', on);
      btn.tabIndex = on ? 0 : -1;
    });
    if (!buttons.some((b) => b.tabIndex === 0) && buttons[0]) buttons[0].tabIndex = 0;
  }
  function choose(next, fromUser) {
    if (String(next) === String(current)) return;
    current = next;
    paint();
    if (fromUser && onChange) onChange(next);
  }
  group.addEventListener('keydown', (event) => {
    const at = buttons.indexOf(document.activeElement);
    if (at === -1) return;
    const to = rovingIndex(buttons.length, at, event.key, { orientation: 'horizontal' });
    if (to === null) return;
    event.preventDefault();
    buttons[to].focus();
    choose(items[to].value, true);
  });
  paint();
  group.setValue = (v) => choose(v, false);
  group.getValue = () => current;
  return group;
}

/**
 * NumberStepper({ value, min, max, step, onChange, label }) — − [n] + with
 * ◀▶ stepping on the field.
 * @param {object} [opts] Options.
 * @param {number} [opts.value=0] Initial value.
 * @param {number} [opts.min=-Infinity] Minimum.
 * @param {number} [opts.max=Infinity] Maximum.
 * @param {number} [opts.step=1] Step.
 * @param {(value: number) => void} [opts.onChange] Called with each committed value.
 * @param {string} [opts.label=''] Accessible name, also used in the button labels.
 * @param {string} [opts.id] Input id; generated when omitted.
 * @param {string} [opts.className=''] Extra classes on the wrapper.
 * @returns {HTMLElement} The wrapper, with `.input`.
 */
export function NumberStepper({ value = 0, min = -Infinity, max = Infinity, step = 1, onChange, label = '', id, className = '' } = {}) {
  const input = h('input', { type: 'number', value: String(value), attrs: { 'aria-label': label || undefined, min: Number.isFinite(min) ? min : undefined, max: Number.isFinite(max) ? max : undefined, step } });
  input.id = id || nextId('stepper');
  const bounds = { min, max, step };
  const commit = (next) => {
    input.value = String(next);
    if (onChange) onChange(next);
  };
  const minus = h('button', { type: 'button', className: 'btn icon-btn ui-stepper-minus', text: '−', tabIndex: -1, attrs: { 'aria-label': `Decrease ${label}`.trim(), title: `Decrease ${label}`.trim() } });
  const plus = h('button', { type: 'button', className: 'btn icon-btn ui-stepper-plus', text: '+', tabIndex: -1, attrs: { 'aria-label': `Increase ${label}`.trim(), title: `Increase ${label}`.trim() } });
  bindPress(minus, () => commit(stepValue(input.value, bounds, -1)));
  bindPress(plus, () => commit(stepValue(input.value, bounds, 1)));
  input.addEventListener('keydown', (event) => {
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[event.key];
    if (!dir) return;
    event.preventDefault();
    event.stopPropagation(); // the arrow steps the value; it must not also move channel/focus
    commit(stepValue(input.value, bounds, dir));
  });
  input.addEventListener('change', () => commit(stepValue(input.value, bounds, 0)));
  const wrap = h('div', { className: ['ui-stepper', className].filter(Boolean).join(' '), dataset: { uiArrows: 'horizontal' } }, minus, input, plus);
  wrap.input = input;
  return wrap;
}

/**
 * ColorPick({ value, swatches: ['#f5d327', …], onChange, label, custom }) —
 * swatches as a radio group, plus a native colour input when custom is on.
 * @param {object} [opts] Options.
 * @param {string} [opts.value=''] The chosen colour.
 * @param {string[]} [opts.swatches=[]] CSS colours to offer.
 * @param {(color: string) => void} [opts.onChange] Called with the chosen colour.
 * @param {string} [opts.label=''] Accessible name.
 * @param {boolean} [opts.custom=false] Also offer a native colour input.
 * @param {string} [opts.className=''] Extra classes.
 * @returns {HTMLElement} The Segmented group of swatches.
 */
export function ColorPick({ value = '', swatches = [], onChange, label = '', custom = false, className = '' } = {}) {
  const items = swatches.map((color) => ({ value: color, label: '' }));
  const group = Segmented({ items, value, label, onChange, className: ['ui-colorpick', className].filter(Boolean).join(' '), itemClassName: 'color-swatch' });
  Array.from(group.children).forEach((btn, i) => {
    btn.style.background = swatches[i];
    btn.setAttribute('aria-label', swatches[i]);
    btn.title = swatches[i];
  });
  if (custom) {
    const input = h('input', { type: 'color', value: value || '#ffffff', attrs: { 'aria-label': `${label} custom colour`.trim() } });
    input.addEventListener('change', () => { group.setValue(input.value); if (onChange) onChange(input.value); });
    group.appendChild(input);
  }
  return group;
}
