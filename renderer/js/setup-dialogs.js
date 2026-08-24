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

let seq = 0;

// Plays the closing exit-fade (setup.css) before actually removing the
// overlay, instead of cutting it off instantly. Skipped under
// prefers-reduced-motion, where the CSS animation is disabled anyway — no
// point delaying removal for an animation that won't play.
const REDUCE_MOTION = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function closeOverlay(overlay) {
  if (REDUCE_MOTION()) { overlay.remove(); return; }
  overlay.classList.add('closing');
  setTimeout(() => overlay.remove(), 130);
}

function buildBox({ title, message, kind }) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-dialog';
  overlay.dataset.kind = kind;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', title || (kind === 'prompt' ? 'Input required' : 'Message'));

  const box = document.createElement('div');
  box.className = 'confirm-dialog-box';
  if (kind === 'confirm-danger' || kind === 'alert-error') box.classList.add('confirm-dialog-danger');

  if (title) {
    const titleEl = document.createElement('div');
    titleEl.className = 'confirm-dialog-title';
    titleEl.textContent = title;
    box.appendChild(titleEl);
  }

  const msgEl = document.createElement('div');
  msgEl.className = 'confirm-dialog-message';
  msgEl.textContent = message;
  box.appendChild(msgEl);

  overlay.appendChild(box);
  return { overlay, box };
}

function focusTrap(overlay, box) {
  const id = `confirm-dialog-${++seq}`;
  overlay.id = id;
  // 'button' alone missed promptDialog's <input> — found in review: tabbing
  // forward from OK wrapped straight to CANCEL, permanently skipping the
  // text field for that dialog instance. confirmDialog/alertDialog have no
  // non-button focusables, so this widened selector is a no-op for them.
  const focusable = () => Array.from(box.querySelectorAll('button, input'));
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const els = focusable();
      if (!els.length) return;
      const first = els[0];
      const last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

export function confirmDialog(opts) {
  const {
    message, title = null, danger = true, confirmText = danger ? 'REMOVE' : 'OK', cancelText = 'CANCEL',
  } = typeof opts === 'string' ? { message: opts } : opts;

  return new Promise((resolve) => {
    const { overlay, box } = buildBox({ title, message, kind: danger ? 'confirm-danger' : 'confirm' });

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = cancelText;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    confirmBtn.textContent = confirmText;

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    box.appendChild(actions);

    const previouslyFocused = document.activeElement;
    const close = (result) => {
      overlay.removeEventListener('keydown', onKeydown);
      closeOverlay(overlay);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(result);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter' && document.activeElement !== cancelBtn) { e.preventDefault(); close(true); }
    };

    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    overlay.addEventListener('keydown', onKeydown);
    focusTrap(overlay, box);

    document.body.appendChild(overlay);
    confirmBtn.focus();
  });
}

export function alertDialog(message, opts = {}) {
  const { title = null, variant = 'info' } = opts;
  return new Promise((resolve) => {
    const { overlay, box } = buildBox({
      title: title || (variant === 'error' ? 'ERROR' : null),
      message,
      kind: variant === 'error' ? 'alert-error' : 'alert',
    });

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';
    const okBtn = document.createElement('button');
    okBtn.className = variant === 'error' ? 'btn btn-danger' : 'btn btn-primary';
    okBtn.textContent = 'OK';
    actions.appendChild(okBtn);
    box.appendChild(actions);

    const previouslyFocused = document.activeElement;
    const close = () => {
      overlay.removeEventListener('keydown', onKeydown);
      closeOverlay(overlay);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve();
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); }
    };

    okBtn.addEventListener('click', close);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', onKeydown);
    focusTrap(overlay, box);

    document.body.appendChild(overlay);
    okBtn.focus();
  });
}

export function promptDialog(opts = {}) {
  const {
    message, title = null, placeholder = '', defaultValue = '',
  } = typeof opts === 'string' ? { message: opts } : opts;

  return new Promise((resolve) => {
    const { overlay, box } = buildBox({ title, message, kind: 'prompt' });

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'title-row-input';
    input.placeholder = placeholder;
    input.value = defaultValue;
    box.appendChild(input);

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'CANCEL';

    const okBtn = document.createElement('button');
    okBtn.className = 'btn btn-primary';
    okBtn.textContent = 'OK';

    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
    box.appendChild(actions);

    const previouslyFocused = document.activeElement;
    const close = (result) => {
      overlay.removeEventListener('keydown', onKeydown);
      closeOverlay(overlay);
      if (previouslyFocused && previouslyFocused.focus) previouslyFocused.focus();
      resolve(result);
    };
    const onKeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
      else if (e.key === 'Enter') { e.preventDefault(); close(input.value.trim()); }
    };

    cancelBtn.addEventListener('click', () => close(null));
    okBtn.addEventListener('click', () => close(input.value.trim()));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', onKeydown);
    focusTrap(overlay, box);

    document.body.appendChild(overlay);
    input.focus();
  });
}
