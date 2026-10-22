// Media-source providers (plugins that supply channel content from somewhere other
// than local disk) as the setup screens use them: which are active, how a folder
// gets picked from one, and the <select> that offers them. CHOOSE SOURCE on a
// channel (channels.js) and IMPORT FROM SOURCE in the ad pool (interstitials.js)
// share all of it; only what happens after a folder is picked differs.
import { getMediaSourcePicker } from '../plugin/host.js';
import { promptDialog } from './dialogs.js';

// Which provider plugins are activated right now (main's
// plugins:listMediaSourceProviders). Fetched once per session: activation can't
// change without an app restart, so re-fetching per render would only add IPC.
let providers = [];
let fetchStarted = false;
const loadedListeners = new Set();

export function getMediaSourceProviders() {
  return providers;
}

export function providerLabel(providerId) {
  const info = providers.find((p) => p.providerId === providerId);
  return info ? info.displayName : providerId;
}

// Starts the one fetch and, when it finds providers, calls each registered
// listener so already-drawn rows can pick up the real picker. Register at module
// load, before the reply can arrive. No providers active means nothing is called
// and every control stays local-only.
export function ensureMediaSourceProvidersLoaded(onLoaded) {
  if (onLoaded) loadedListeners.add(onLoaded);
  if (fetchStarted) return;
  fetchStarted = true;
  window.api.listMediaSourceProviders().then((list) => {
    if (!list || !list.length) return;
    providers = list;
    loadedListeners.forEach((fn) => {
      try { fn(); } catch (error) { console.warn('[media-sources] listener failed:', error); }
    });
  }).catch(() => {});
}

// Three-tier folder picker, richest first:
//   1. a renderer-registered picker (registerMediaSourcePicker): the plugin's own modal;
//   2. the provider's main-process pickFolder verb;
//   3. a plain text prompt, so choosing a source never dead-ends.
// Resolves to the raw folder ref, or a falsy value when cancelled.
export async function pickFolderRefForProvider(providerId) {
  const label = providerLabel(providerId);
  const renderedPicker = getMediaSourcePicker(providerId);
  if (renderedPicker) return renderedPicker();
  try {
    return await window.api.callMediaSourceHook(providerId, 'pickFolder');
  } catch (err) {
    // window.prompt() is inert in this app's Electron context; use the themed dialog.
    return promptDialog({
      title: `${label.toUpperCase()} FOLDER`,
      message: `Enter a folder reference for ${label} (this provider has no picker UI of its own):`,
    });
  }
}

// A <select> listing the active providers after `leadingOptions`
// ([{ value, text }], e.g. a placeholder and "LOCAL FOLDER"). Choosing an option
// resets the select and calls onPick(value) for any non-empty value.
export function buildProviderSelect({ title, leadingOptions, onPick, id }) {
  const select = document.createElement('select');
  if (id) select.id = id;
  select.className = 'btn folder-btn';
  select.title = title;
  const addOption = (value, text) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  };
  leadingOptions.forEach(({ value, text }) => addOption(value, text));
  providers.forEach((p) => addOption(p.providerId, p.displayName.toUpperCase()));
  select.addEventListener('change', () => {
    const value = select.value;
    select.value = '';
    if (value) onPick(value);
  });
  return select;
}
