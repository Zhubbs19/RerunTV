// One mode-neutral answer to "is a guide or menu up?" for plugins. Overlay
// plugins used to ask by checking #guide-grid's .hidden class, which only
// knows about the legacy guide. This watches every registered surface (the
// legacy ones below, plus whatever the cable-guide UI registers) and
// publishes the open set two ways:
//   html[data-ui-overlay="guide menu"]  — for CSS; absent when nothing is open
//   'ui-overlay-change' core hook       — called with the sorted name list
// A surface counts as open while it is in the document without .hidden.
import { runCoreHooks } from '../plugin/host.js';
import { openSurfaceNames } from '../cable-guide/model.js';

const LEGACY_SURFACES = {
  guide: 'guide-grid',
  menu: 'shortcuts-overlay',
  details: 'details-overlay',
  pin: 'pin-lock-modal',
};

const surfaces = new Map(); // element → name
let observer = null;
let published = '';

function publish() {
  const names = openSurfaceNames(Array.from(surfaces, ([el, name]) => [name, {
    connected: el.isConnected,
    hidden: el.classList.contains('hidden') || el.hidden,
  }]));
  const key = names.join(' ');
  if (key === published) return;
  published = key;
  if (key) document.documentElement.dataset.uiOverlay = key;
  else delete document.documentElement.dataset.uiOverlay;
  runCoreHooks('ui-overlay-change', names);
}

export function registerOverlaySurface(name, element) {
  if (!name || !element || surfaces.get(element) === name) return;
  surfaces.set(element, name);
  if (observer) observer.observe(element, { attributes: true, attributeFilter: ['class', 'hidden'] });
  publish();
}

export function openOverlays() {
  return published ? published.split(' ') : [];
}

export function installOverlaySignal() {
  if (observer) return;
  observer = new MutationObserver(publish);
  for (const [name, id] of Object.entries(LEGACY_SURFACES)) {
    const el = document.getElementById(id);
    if (el) surfaces.set(el, name);
  }
  surfaces.forEach((_, el) => observer.observe(el, { attributes: true, attributeFilter: ['class', 'hidden'] }));
  publish();
}
