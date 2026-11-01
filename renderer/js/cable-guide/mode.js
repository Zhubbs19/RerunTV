// Which on-screen UI the box shows: the cable-guide layout (two skins,
// cable-guide.css) or the legacy layout every other theme
// pack was built for. The box theme decides it (cable-guide/model.js); this
// file only writes the result to the page.
//
// html[data-ui] sits next to html[data-mode] (desktop/TV), which is a
// different axis. A channel's own identity theme never flips the layout.
import { runCoreHooks } from '../plugin/host.js';
import { CABLE_GUIDE_UI, LEGACY_UI } from './model.js';

export function currentUiMode() {
  return document.documentElement.dataset.ui === CABLE_GUIDE_UI ? CABLE_GUIDE_UI : LEGACY_UI;
}

// Plugins hear about a change through the 'ui-mode-change' core hook,
// with the new mode as its argument.
export function setUiMode(mode) {
  const next = mode === CABLE_GUIDE_UI ? CABLE_GUIDE_UI : LEGACY_UI;
  const root = document.documentElement;
  if (root.dataset.ui === next) return;
  root.dataset.ui = next;
  runCoreHooks('ui-mode-change', next);
}
