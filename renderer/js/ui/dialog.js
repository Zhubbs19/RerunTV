// Dialog and ModalSurface (docs/design/04 §3).
//
// ModalSurface is what every modal overlay shares: role="dialog" markup, a
// FocusScope (Tab stays inside, focus starts on the safe default, closes back
// to what had focus), and a place on the modal stack, so in TV mode the D-pad
// moves by position, OK presses and Back cancels. The on-screen keyboard,
// handoff, learn mode and the first-run wizard are ModalSurfaces with their
// own content.
//
// Dialog is a ModalSurface with a title, a message or body, and a row of
// actions. It never defaults to a destructive action: focus starts on the
// action marked isDefault, else the first one that isn't danger.
import { FocusScope, focusDefault, registerModal } from './focus.js';
import { Button } from './button.js';
import { h } from './kit-core.js';

// ---------- Pure ----------
// Which action a dialog starts on: [{ isDefault, variant }] → index.
export function dialogDefaultIndex(actions) {
  const marked = actions.findIndex((a) => a.isDefault && a.variant !== 'danger');
  if (marked !== -1) return marked;
  const safe = actions.findIndex((a) => a.variant !== 'danger');
  return safe === -1 ? 0 : safe;
}

// ---------- DOM ----------
const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ModalSurface({ className, label, labelledBy, host, onCancel, closeAnimationMs })
// → { el, open(), close(), isOpen(), refocus() }. refocus() puts focus back on
// the safe default after the content changes (a wizard's next step). el is empty; put content in it before
// open(). host defaults to document.body (fixed-position, above the guide).
export function ModalSurface({ className = '', label = '', labelledBy = '', host = null, onCancel = null, closeAnimationMs = 0 } = {}) {
  const el = h('div', { className, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': labelledBy ? undefined : (label || undefined), 'aria-labelledby': labelledBy || undefined } });
  let release = null;
  let unregister = null;
  let open = false;
  const api = {
    el,
    isOpen: () => open,
    refocus: () => { if (open) focusDefault(el); },
    open({ initialFocus = true } = {}) {
      if (open) return api;
      open = true;
      (typeof host === 'function' ? host() : host || document.body).appendChild(el);
      unregister = registerModal({ isOpen: () => open, element: () => el, cancel: () => (onCancel ? onCancel() : api.close()) });
      release = FocusScope(el, { initialFocus });
      return api;
    },
    close() {
      if (!open) return;
      open = false;
      if (unregister) { unregister(); unregister = null; }
      if (release) { release(); release = null; }
      if (closeAnimationMs && !reduceMotion()) {
        el.classList.add('closing');
        setTimeout(() => el.remove(), closeAnimationMs);
      } else {
        el.remove();
      }
    },
  };
  return api;
}

// Dialog({ title, message, body, actions: [{ label, variant, value, isDefault }],
//   dismissValue, enterValue, danger, className, boxClassName })
// → { el, box, close(value), result: Promise<value> }
// Escape, Back and a click on the backdrop resolve dismissValue. enterValue,
// when given, is what Enter resolves from anywhere in the dialog (a prompt's
// text field); otherwise Enter presses the focused button like any button.
export function Dialog({
  title = '', message = '', body = null, actions = [], dismissValue = null, enterValue,
  danger = false, kind = '', className = 'confirm-dialog', boxClassName = 'confirm-dialog-box',
  actionsClassName = 'confirm-dialog-actions', initialFocus = null,
} = {}) {
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  let settled = false;
  const surface = ModalSurface({ className, label: title || (kind === 'prompt' ? 'Input required' : 'Message'), closeAnimationMs: 130, onCancel: () => finish(dismissValue) });
  const { el } = surface;
  if (kind) el.dataset.kind = kind;
  const box = h('div', { className: [boxClassName, danger ? 'confirm-dialog-danger' : ''].filter(Boolean).join(' ') });
  if (title) box.appendChild(h('div', { className: 'confirm-dialog-title', text: title }));
  if (message) box.appendChild(h('div', { className: 'confirm-dialog-message', text: message }));
  if (body) box.appendChild(body);

  const defaultIndex = dialogDefaultIndex(actions);
  const row = h('div', { className: actionsClassName });
  const buttons = actions.map((action, i) => {
    const btn = Button({
      label: action.label,
      variant: action.variant || 'default',
      isDefault: i === defaultIndex && !initialFocus,
      onPress: () => finish(typeof action.value === 'function' ? action.value() : action.value),
    });
    row.appendChild(btn);
    return btn;
  });
  if (actions.length) box.appendChild(row);
  el.appendChild(box);

  function finish(value) {
    if (settled) return;
    settled = true;
    surface.close();
    resolveResult(value);
  }

  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); finish(dismissValue); }
    else if (event.key === 'Enter' && enterValue !== undefined) {
      event.preventDefault();
      finish(typeof enterValue === 'function' ? enterValue() : enterValue);
    }
  });
  el.addEventListener('mousedown', (event) => { if (event.target === el) finish(dismissValue); });

  surface.open({ initialFocus: !initialFocus });
  if (initialFocus) initialFocus.focus();
  return { el, box, buttons, close: finish, result };
}
