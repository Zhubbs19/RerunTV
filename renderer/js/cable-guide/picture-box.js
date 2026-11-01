// Where the live picture sits while a cable-guide page is up: a box in the
// header's top-right corner (cable-guide/model.js pictureBoxRect). Published
// so overlay plugins can stay clear of it, two ways:
//   html[data-picture-box] plus --picture-box-left/-top/-width/-height (px,
//     relative to the .crt screen) — for CSS
//   'picture-box-change' core hook — called with the rect, or null when the
//     picture is full screen again
// Pages call showPictureBox() when they open and hidePictureBox() when they
// close; moving #player into the box is the page's job (step 2 onward).
import { runCoreHooks } from '../plugin/host.js';
import { pictureBoxRect, sameRect } from './model.js';

let current = null;

function write(rect) {
  if (sameRect(rect, current)) return;
  current = rect;
  const root = document.documentElement;
  if (rect) {
    root.dataset.pictureBox = 'on';
    for (const key of ['left', 'top', 'width', 'height']) root.style.setProperty(`--picture-box-${key}`, `${rect[key]}px`);
  } else {
    delete root.dataset.pictureBox;
    for (const key of ['left', 'top', 'width', 'height']) root.style.removeProperty(`--picture-box-${key}`);
  }
  runCoreHooks('picture-box-change', rect ? { ...rect } : null);
}

// For a page that works out its own box (listings.js aligns it with a hole in
// #guide-grid); rect is in the .crt's local pixels, or null.
export function setPictureBox(rect) {
  write(rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null);
}

export function showPictureBox(screenEl) {
  const crt = screenEl || document.querySelector('#tv-screen .crt');
  if (!crt) return null;
  write(pictureBoxRect(crt.clientWidth, crt.clientHeight, document.documentElement.dataset.guideLayout));
  return current;
}

export function hidePictureBox() {
  write(null);
}

export function pictureBox() {
  return current ? { ...current } : null;
}
