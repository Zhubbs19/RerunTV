// In-theme replacements for window.confirm()/window.alert()/window.prompt(),
// styled to match the setup screen's preview-modal (see css/setup.css,
// "confirm-dialog"). Three entry points:
//   confirmDialog({ message, title, danger, confirmText, cancelText }) -> Promise<boolean>
//     Use before any destructive/hard-to-undo action (delete, overwrite,
//     replace-on-import, etc). Resolves true only on explicit confirm —
//     Escape, backdrop click, and Cancel all resolve false.
//   alertDialog(message, { title, variant }) -> Promise<void>
//     variant: 'error' (red accent, for caught failures) or 'info' (gold,
//     default). Resolves once the user dismisses it.
//   promptDialog({ message, title, placeholder, defaultValue }) -> Promise<string|null>
//     Single-line text input. Resolves the trimmed value on OK/Enter (empty
//     string if left blank), null on Cancel/Escape/backdrop click — same
//     null-means-cancelled contract window.prompt() has, but actually
//     renders in this app: the raw browser API is never used anywhere else
//     in this codebase and turned out to be silently inert in this app's
//     Electron context (found live via the media-source CHOOSE SOURCE
//     fallback for a provider with no pickFolder hook — selecting a
//     provider appeared to do nothing at all, no dialog, no error).
// All three stack (last one opened sits on top) so a failure alert raised
// out of a confirm's/prompt's action handler doesn't get lost.
//
// Built on the kit's Dialog (docs/design/04 §3): focus trap, the safe default
// action, and a place on the modal stack, so a remote's D-pad/OK/Back work too.

import { Dialog } from '../ui/dialog.js';
import { h } from '../ui/kit-core.js';

/**
 * Asks the user to confirm an action. Destructive dialogs (the default) focus CANCEL.
 * @param {string|object} opts The message, or an options object.
 * @param {string} opts.message The question to ask.
 * @param {?string} [opts.title=null] Dialog title.
 * @param {boolean} [opts.danger=true] Styles the dialog as destructive and makes CANCEL the default.
 * @param {string} [opts.confirmText] Confirm button label; 'REMOVE' when dangerous, otherwise 'OK'.
 * @param {string} [opts.cancelText='CANCEL'] Cancel button label.
 * @returns {Promise<boolean>} True only on an explicit confirm.
 */
export function confirmDialog(opts) {
  const {
    message, title = null, danger = true, confirmText = danger ? 'REMOVE' : 'OK', cancelText = 'CANCEL',
  } = typeof opts === 'string' ? { message: opts } : opts;
  // Destructive dialogs default to the safe action. Enter activates whichever
  // real button owns focus instead of confirming from anywhere in the dialog,
  // so an accidental key repeat can't delete data.
  return Dialog({
    title,
    message,
    kind: danger ? 'confirm-danger' : 'confirm',
    danger,
    dismissValue: false,
    actions: [
      { label: cancelText, value: false },
      { label: confirmText, variant: danger ? 'danger' : 'primary', value: true, isDefault: !danger },
    ],
  }).result;
}

/**
 * Shows a message with a single OK button.
 * @param {string} message The message text.
 * @param {object} [opts] Options.
 * @param {?string} [opts.title=null] Dialog title; errors default to 'ERROR'.
 * @param {string} [opts.variant='info'] 'info' or 'error'.
 * @returns {Promise<void>} Resolves when dismissed.
 */
export function alertDialog(message, opts = {}) {
  const { title = null, variant = 'info' } = opts;
  return Dialog({
    title: title || (variant === 'error' ? 'ERROR' : null),
    message,
    kind: variant === 'error' ? 'alert-error' : 'alert',
    danger: variant === 'error',
    dismissValue: undefined,
    enterValue: () => undefined,
    // An error's only button is OK; it closes, it doesn't destroy anything.
    actions: [{ label: 'OK', variant: variant === 'error' ? 'danger' : 'primary', value: undefined, isDefault: true }],
  }).result;
}

/**
 * Asks for one line of text.
 * @param {string|object} [opts] The message, or an options object.
 * @param {string} opts.message The prompt text.
 * @param {?string} [opts.title=null] Dialog title.
 * @param {string} [opts.placeholder=''] Input placeholder.
 * @param {string} [opts.defaultValue=''] Initial input value.
 * @param {string} [opts.inputType='text'] The input's `type` attribute.
 * @returns {Promise<?string>} The trimmed text (empty if left blank), or null when cancelled.
 */
export function promptDialog(opts = {}) {
  const {
    message, title = null, placeholder = '', defaultValue = '', inputType = 'text',
  } = typeof opts === 'string' ? { message: opts } : opts;
  const input = h('input', { type: inputType, className: 'title-row-input', placeholder, value: defaultValue });
  return Dialog({
    title,
    message,
    kind: 'prompt',
    body: input,
    dismissValue: null,
    enterValue: () => input.value.trim(),
    initialFocus: input,
    actions: [
      { label: 'CANCEL', value: null },
      { label: 'OK', variant: 'primary', value: () => input.value.trim() },
    ],
  }).result;
}
