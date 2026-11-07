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
/**
 * Returns the message count for the header envelope; replaced by messages.js.
 * @returns {number} The message count.
 */
let messageCounter = () => 0;

/**
 * messages.js supplies the envelope's count, without a module cycle.
 * @param {Function} fn Returns the current message count.
 */
export function setMessageCounter(fn) {
  messageCounter = fn;
}

/**
 * Reads the message count for a header's envelope.
 * @returns {number} The count, or 0 if the counter throws.
 */
export function currentMessageCount() {
  try { return messageCounter(); } catch { return 0; }
}

/**
 * Names the open cable-guide page.
 * @returns {?string} The open page's name, or null when none is open.
 */
export function cgPageOpen() {
  return current ? current.name : null;
}

/**
 * Closes the open cable-guide page, if any.
 */
export function closeCgPage() {
  if (current) current.close();
}

/**
 * Makes a scrolling list of equal rows show whole rows only, as the boxes did: its
 * height snaps down to the last row that fits instead of cutting one in
 * half. Re-fits when the space around it changes or its rows are redrawn;
 * active() can switch it off (the Mini Guide sizes itself).
 * @param {?HTMLElement} list The scrolling list.
 * @param {Function} [active] Returns false while the fit should stay off.
 * @returns {Function} stop(), which ends the fitting.
 */
export function wholeRows(list, active = () => true) {
  if (!list || typeof ResizeObserver === 'undefined') return () => {};
  let frame = 0;
  const fit = () => {
    frame = 0;
    list.style.maxHeight = '';
    if (!list.isConnected) { stop(); return; }
    if (!active()) return;
    const rows = Array.from(list.children).filter((row) => row.offsetParent);
    if (rows.length < 2) return;
    const pitch = rows[1].offsetTop - rows[0].offsetTop;
    const row = rows[0].offsetHeight;
    if (!(pitch > 0) || !(row > 0)) return;
    const cs = getComputedStyle(list);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const room = list.clientHeight - pad;
    if (room < row) return;
    const height = Math.floor((room - row) / pitch) * pitch + row + pad;
    if (height < list.clientHeight - 0.5) list.style.maxHeight = `${height}px`;
  };
  const later = () => { if (!frame) frame = requestAnimationFrame(fit); };
  const sizes = new ResizeObserver(later);
  const rows = new MutationObserver(later);
  function stop() {
    sizes.disconnect();
    rows.disconnect();
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    list.style.maxHeight = '';
  }
  sizes.observe(list.parentElement || list);
  rows.observe(list, { childList: true });
  later();
  return stop;
}

/**
 * build(body, page) fills the body; onKey(e, page) may claim a key first by
 * returning true. Returns the page: { el, body, header, close, focusFirst }.
 * @param {object} opts The page definition.
 * @param {string} opts.name The page name, used in its class and as its overlay surface name.
 * @param {Function} opts.build Fills the page: `build(body, page)`.
 * @param {?Function} [opts.onKey=null] Gets first look at each key: `onKey(e, page)`, true to claim it.
 * @param {?Function} [opts.onClose=null] Called after the page closes.
 * @returns {object} The page.
 */
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

  const stops = [];
  const page = {
    name, el, body, header,
    // A list on this page that should show whole rows (wholeRows above).
    wholeRows(list) { stops.push(wholeRows(list)); },
    focusFirst() {
      const first = el.querySelector('[data-default-focus]') || el.querySelector('button:not([disabled])');
      (first || el).focus({ preventScroll: true });
    },
    close() {
      if (!open) return;
      open = false;
      if (resizeWatch) resizeWatch.disconnect();
      stops.forEach((stop) => stop());
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
