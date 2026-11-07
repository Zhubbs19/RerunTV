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

/**
 * Recomputes the open-surface set and publishes it when it changed.
 * Writes `html[data-ui-overlay]` and runs the `ui-overlay-change` core hook.
 */
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

/**
 * Returns an unregister function. A surface that is removed from the page
 * rather than hidden (a cable-guide page) must call it: removal fires no
 * class or hidden change, so the signal would go on naming it.
 * @param {string} name The surface name published while it is open (e.g. `guide`).
 * @param {HTMLElement} element The element whose presence and `.hidden` state mark it open.
 * @returns {Function} Removes the surface and republishes.
 */
export function registerOverlaySurface(name, element) {
  const unregister = () => { if (surfaces.delete(element)) publish(); };
  if (!name || !element || surfaces.get(element) === name) return unregister;
  surfaces.set(element, name);
  if (observer) observer.observe(element, { attributes: true, attributeFilter: ['class', 'hidden'] });
  publish();
  return unregister;
}

/**
 * Lists the overlay surfaces open right now.
 * @returns {string[]} Sorted surface names; empty when nothing is open.
 */
export function openOverlays() {
  return published ? published.split(' ') : [];
}

/**
 * Registers the legacy surfaces and starts watching every registered one.
 * Safe to call more than once; later calls do nothing.
 */
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
