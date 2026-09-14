// Shared pieces of the component kit (docs/design/04 §3): a small element
// builder, the one "press" path every component's action goes through, and
// the pure keyboard helpers the kit's lists, tabs and menus share.
//
// Kit rules, for anyone adding a component:
// - Components are plain functions returning DOM; no framework, no state
//   outside the element.
// - Density comes from tokens under html[data-mode] (tokens.css), never a
//   per-call prop.
// - Focus styling comes from --focus-ring/--focus-halo (kit.css), once.
// - Nothing touches the DOM at import time, so tests can import any file.

// ---------- Pure ----------
// Where focus goes in a one-dimensional list for a key, or null when the key
// isn't a navigation key. wrap: ▼ on the last item goes to the first.
export function rovingIndex(count, current, key, { orientation = 'vertical', wrap = true } = {}) {
  if (count <= 0) return null;
  const next = orientation === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
  const prev = orientation === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
  const at = current < 0 ? -1 : Math.min(current, count - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === next) {
    if (at === -1) return 0;
    if (at + 1 < count) return at + 1;
    return wrap ? 0 : at;
  }
  if (key === prev) {
    if (at === -1) return count - 1;
    if (at > 0) return at - 1;
    return wrap ? count - 1 : at;
  }
  return null;
}

// Stepping a number by `direction` steps, clamped and snapped to step so
// float noise (0.1 + 0.2) never leaks into config.
export function stepValue(value, { min = -Infinity, max = Infinity, step = 1 } = {}, direction = 1) {
  const decimals = (String(step).split('.')[1] || '').length;
  const base = Number.isFinite(min) ? min : 0;
  const snapped = Math.round(((Number(value) || 0) - base) / step) * step + base;
  const next = snapped + direction * step;
  return Number(Math.min(max, Math.max(min, next)).toFixed(decimals));
}

let idCounter = 0;
export function nextId(prefix = 'ui') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

// ---------- DOM ----------
// h('button', { className: 'btn', text: 'OK', attrs: { 'aria-label': … },
//   dataset: { … }, on: { click: fn } }, ...children)
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  const { className, text, attrs, dataset, on, style, ...rest } = props || {};
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  if (attrs) Object.entries(attrs).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? '' : String(v)); });
  if (dataset) Object.entries(dataset).forEach(([k, v]) => { if (v !== undefined && v !== null) el.dataset[k] = String(v); });
  if (on) Object.entries(on).forEach(([k, fn]) => el.addEventListener(k, fn));
  if (style) Object.assign(el.style, style);
  Object.entries(rest).forEach(([k, v]) => { if (v !== undefined) el[k] = v; });
  children.flat().forEach((child) => {
    if (child == null || child === false) return;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  });
  return el;
}

export function isTvMode() {
  return typeof document !== 'undefined' && document.documentElement.dataset.mode === 'tv';
}

// The one way a kit control is activated. A native <button> already turns
// Enter and Space into click, and tv-input's dialog context turns the remote's
// OK into click on the focused control, so every path lands on this listener.
// Non-button hosts (a row, a swatch) get Enter/Space mapped here.
export function bindPress(el, onPress) {
  if (typeof onPress !== 'function') return;
  el.addEventListener('click', (event) => {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    onPress(event);
  });
  if (el.tagName !== 'BUTTON') {
    el.addEventListener('keydown', (event) => {
      if (event.target !== el || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      el.click();
    });
  }
}

export function press(el) {
  if (el && typeof el.click === 'function') el.click();
}
