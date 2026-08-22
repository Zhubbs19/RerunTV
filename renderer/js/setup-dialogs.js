// In-theme replacements for window.confirm()/window.alert(), styled to match
// the setup screen's preview-modal (see css/setup.css, "confirm-dialog").
// Two entry points:
//   confirmDialog({ message, title, danger, confirmText, cancelText }) -> Promise<boolean>
//     Use before any destructive/hard-to-undo action (delete, overwrite,
//     replace-on-import, etc). Resolves true only on explicit confirm —
//     Escape, backdrop click, and Cancel all resolve false.
//   alertDialog(message, { title, variant }) -> Promise<void>
//     variant: 'error' (red accent, for caught failures) or 'info' (gold,
//     default). Resolves once the user dismisses it.
// Both stack (last one opened sits on top) so a failure alert raised out of
// a confirm's action handler doesn't get lost.

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
  const focusable = () => Array.from(box.querySelectorAll('button'));
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
