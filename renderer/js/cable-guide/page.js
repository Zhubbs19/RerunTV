// A full cable-guide page (Search, Listings by Channel, Messages): the shared
// header with the picture in its corner, a body the page fills, and the same
// keys everywhere — arrows move focus by position, OK presses, Back closes.
//
// It mounts inside the TV screen's .crt like the info page, joins the modal
// stack (so a remote's D-pad gets the dialog context) and the overlay signal,
// and keeps its keys from reaching the live-TV shortcuts. Opening a page
// closes nothing else: callers close the guide or menu first, since
// #guide-grid sits above the screen and would hide the page.
import { tvScreen } from '../core/dom.js';
import { moveFocusSpatially, registerModal } from '../ui/focus.js';
import { registerOverlaySurface } from '../display/overlay-signal.js';
import { createGuideHeader } from './header.js';
import { hidePictureBox, showPictureBox } from './picture-box.js';

const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

let current = null;
let messageCounter = () => 0;

// messages.js supplies the envelope's count, without a module cycle.
export function setMessageCounter(fn) {
  messageCounter = fn;
}

export function currentMessageCount() {
  try { return messageCounter(); } catch { return 0; }
}

export function cgPageOpen() {
  return current ? current.name : null;
}

export function closeCgPage() {
  if (current) current.close();
}

// build(body, page) fills the body; onKey(e, page) may claim a key first by
// returning true. Returns the page: { el, body, header, close, focusFirst }.
export function openCgPage({ name, build, onKey = null, onClose = null }) {
  closeCgPage();
  const crt = tvScreen.querySelector('.crt') || tvScreen;
  const el = document.createElement('div');
  el.className = `cg-surface cg-page cg-page-${name}`;
  el.tabIndex = -1;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = '<div class="cg-frame"><div class="cg-page-body"></div></div>';
  const header = createGuideHeader();
  el.querySelector('.cg-frame').prepend(header.el);
  header.setMessages(currentMessageCount());
  const body = el.querySelector('.cg-page-body');
  crt.appendChild(el);

  let open = true;
  let unregister = null;
  let unsurface = null;
  let resizeWatch = null;
  const previouslyFocused = document.activeElement;

  const page = {
    name, el, body, header,
    focusFirst() {
      const first = el.querySelector('[data-default-focus]') || el.querySelector('button:not([disabled])');
      (first || el).focus({ preventScroll: true });
    },
    close() {
      if (!open) return;
      open = false;
      if (resizeWatch) resizeWatch.disconnect();
      if (unregister) unregister();
      header.destroy();
      el.remove();
      if (unsurface) unsurface();
      hidePictureBox();
      if (current === page) current = null;
      if (onClose) onClose();
      if (previouslyFocused && previouslyFocused.isConnected && previouslyFocused.focus) previouslyFocused.focus({ preventScroll: true });
    },
  };

  el.addEventListener('keydown', (e) => {
    // The page owns every key while it is up.
    e.stopPropagation();
    if (onKey && onKey(e, page)) { e.preventDefault(); return; }
    if (e.key === 'Escape' || (e.key === 'Backspace' && !(e.target && e.target.matches('input, textarea')))) {
      e.preventDefault();
      page.close();
    } else if (ARROWS[e.key]) {
      e.preventDefault();
      moveFocusSpatially(el, ARROWS[e.key]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      const target = document.activeElement;
      if (target && el.contains(target) && target.click && target !== el) { e.preventDefault(); target.click(); }
    }
  });

  unregister = registerModal({ isOpen: () => open, element: () => el, cancel: () => page.close() });
  unsurface = registerOverlaySurface(name, el);
  showPictureBox(crt);
  if (typeof ResizeObserver !== 'undefined') {
    resizeWatch = new ResizeObserver(() => { if (open) showPictureBox(crt); });
    resizeWatch.observe(crt);
  }
  current = page;
  build(body, page);
  page.focusFirst();
  return page;
}
