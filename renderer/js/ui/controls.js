// Toggle, Slider, Select, Segmented, NumberStepper, ColorPick
// (docs/design/04 §3). Native elements underneath wherever one exists, so
// forms, labels, search and the existing input styling keep working.
//
// Controls that use ◀▶ themselves (Slider, Segmented, NumberStepper) carry
// data-ui-arrows="horizontal"; TV focus movement hands those keys to the
// control instead of moving focus away from it.
import { bindPress, h, nextId, rovingIndex, stepValue } from './kit-core.js';

// ---------- Pure ----------
export function formatReadout(value, format) {
  if (typeof format === 'function') return String(format(value));
  if (format === 'percent') return `${Math.round(Number(value) * 100)}%`;
  return String(value);
}

// ---------- DOM ----------
// Toggle({ checked, onChange, label, id }) — a checkbox with switch
// semantics. With `label` it brings its own <label>; inside a SettingRow or
// Field leave label out and let the row label it.
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

// Slider({ min, max, step, value, format, onInput, onChange }) → wrapper with
// .input (the range) and setValue(v). The readout follows every step.
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

// Select({ options: [{ value, label, disabled }] | ['a', 'b'], value, onChange })
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

// Segmented({ items: [{ value, label, title }], value, onChange, label }) — a
// row of mutually exclusive choices. ◀▶ Home End move and choose (the radio
// group pattern); only the chosen segment is a Tab stop.
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

// NumberStepper({ value, min, max, step, onChange, label }) — − [n] + with
// ◀▶ stepping on the field.
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
    commit(stepValue(input.value, bounds, dir));
  });
  input.addEventListener('change', () => commit(stepValue(input.value, bounds, 0)));
  const wrap = h('div', { className: ['ui-stepper', className].filter(Boolean).join(' '), dataset: { uiArrows: 'horizontal' } }, minus, input, plus);
  wrap.input = input;
  return wrap;
}

// ColorPick({ value, swatches: ['#f5d327', …], onChange, label, custom }) —
// swatches as a radio group, plus a native colour input when custom is on.
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
