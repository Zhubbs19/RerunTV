// Button, IconButton, EmptyState, Badge and Chip (docs/design/04 §3).
// Buttons keep the long-standing .btn classes, so every page and theme that
// styles .btn/.btn-primary/.btn-danger styles a kit Button the same way.
import { bindPress, h } from './kit-core.js';

const VARIANT_CLASS = { default: '', primary: 'btn-primary', danger: 'btn-danger', quiet: 'btn-quiet' };

// Button({ label, variant: 'default'|'primary'|'danger'|'quiet', icon, onPress,
//   disabled, title, pressed, isDefault, className, id, searchId, bare })
// onPress fires on click, Enter, Space and the TV remote's OK. bare: no .btn
// chrome, for surfaces with their own key look (the on-screen keyboard).
export function Button({ label = '', variant = 'default', icon = '', onPress, disabled = false, title = '', pressed, isDefault = false, className = '', id, searchId, attrs = {}, bare = false } = {}) {
  if (!(variant in VARIANT_CLASS)) throw new Error(`Button: unknown variant "${variant}"`);
  const el = h('button', {
    type: 'button',
    className: [bare ? '' : 'btn', bare ? '' : VARIANT_CLASS[variant], className].filter(Boolean).join(' '),
    attrs: {
      title: title || undefined,
      'aria-pressed': pressed === undefined ? undefined : String(!!pressed),
      'data-default': isDefault || undefined,
      'data-danger': variant === 'danger' || undefined,
      'data-search-id': searchId,
      ...attrs,
    },
  });
  if (id) el.id = id;
  if (icon) el.appendChild(h('span', { className: 'btn-icon', text: icon, attrs: { 'aria-hidden': 'true' } }));
  if (label) el.appendChild(document.createTextNode(label));
  el.disabled = !!disabled;
  bindPress(el, onPress);
  return el;
}

// IconButton({ icon, label, onPress, variant }) — label is required: it is the
// accessible name and the tooltip, since the glyph alone says nothing to a
// screen reader.
export function IconButton({ icon, label, onPress, variant = 'default', className = '', ...rest } = {}) {
  if (!label) throw new Error('IconButton: label is required');
  return Button({
    ...rest,
    icon,
    variant,
    onPress,
    title: rest.title || label,
    className: ['icon-btn', className].filter(Boolean).join(' '),
    attrs: { 'aria-label': label, ...(rest.attrs || {}) },
  });
}

// EmptyState({ message, action: { label, run } }) — a list with nothing in it
// says so, and offers the one thing that fixes that.
export function EmptyState({ message, action = null, className = '' } = {}) {
  const wrap = h('div', { className: ['titles-empty', 'empty-state', className].filter(Boolean).join(' ') },
    h('p', { className: 'empty-state-text', text: message }));
  if (action) {
    wrap.appendChild(Button({ label: action.label, variant: 'primary', className: 'empty-state-action', onPress: action.run }));
  }
  return wrap;
}

// Badge — a count or status beside something. Chip — a non-interactive tag.
// Neither is focusable or looks pressable.
export function Badge({ text, tone = 'default', title = '', className = '' } = {}) {
  return h('span', { className: ['ui-badge', `tone-${tone}`, className].filter(Boolean).join(' '), text, attrs: { title: title || undefined } });
}

export function Chip({ text, tone = 'default', title = '', className = '' } = {}) {
  return h('span', { className: ['ui-chip', `tone-${tone}`, className].filter(Boolean).join(' '), text, attrs: { title: title || undefined } });
}
