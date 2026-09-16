// The LAN control panel's stand-in for a native file dialog (docs/design/06 §5).
//
// On the host, picking a folder or an image opens an Electron dialog. A browser
// in another room has no such thing and no view of the host's disks, so it asks
// the host instead: /api/control/browse lists one directory at a time, limited
// to the roots main/lan/control-browse.js is willing to share. This module is
// only the dialog around that; every decision about what is listable is the
// host's, so nothing here needs to be trusted.
//
// Loaded on demand by browser-api-shim.js, which is a classic script and cannot
// import at parse time — so this is a module it dynamic-imports the first time
// somebody actually picks something.
import { Dialog } from './ui/dialog.js';
import { Button } from './ui/button.js';
import { h } from './ui/kit-core.js';

const KIND_TITLES = {
  folder: 'Choose a folder on the host',
  video: 'Choose a video on the host',
  image: 'Choose an image on the host',
  audio: 'Choose an audio file on the host',
};

async function fetchListing(kind, path) {
  const query = new URLSearchParams({ kind });
  if (path) query.set('path', path);
  let response;
  try {
    response = await fetch(`/api/control/browse?${query}`, { cache: 'no-store' });
  } catch (e) {
    return { error: `Could not reach the host: ${e.message}` };
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.error) {
    return { error: (body && body.error) || `The host answered ${response.status}.` };
  }
  return body;
}

// Resolves to the chosen absolute path on the host, or null if the user backed
// out. `kind` is 'folder' | 'video' | 'image' | 'audio'; 'folder' picks the
// directory currently open, the others pick a file by clicking it.
export function pickHostPath(kind = 'folder') {
  const pickingFolder = kind === 'folder';
  const crumb = h('div', { className: 'control-picker-path' });
  const list = h('div', { className: 'control-picker-list' });
  const note = h('div', { className: 'control-picker-note' });
  const body = h('div', { className: 'control-picker' }, crumb, list, note);

  let dialog = null;
  let current = null;

  const setNote = (text) => list.replaceChildren(h('div', { className: 'control-picker-note', text }));

  async function show(path) {
    setNote('Loading…');
    const listing = await fetchListing(kind, path);
    if (listing.error) { setNote(listing.error); return; }
    current = listing.path;
    crumb.textContent = listing.path || 'Folders this host shares';
    note.textContent = listing.truncated
      ? `Showing the first ${listing.entries.length} of ${listing.total} items.`
      : '';
    // "Use this folder" means the folder that is open, so it is only available
    // once the user is actually inside one rather than at the list of roots.
    if (pickingFolder && dialog) {
      const confirm = dialog.buttons[dialog.buttons.length - 1];
      if (confirm) confirm.disabled = !listing.path;
    }

    const rows = [];
    if (listing.parent) rows.push(Button({ label: '↰ Up one folder', variant: 'quiet', onPress: () => show(listing.parent) }));
    else if (listing.path) rows.push(Button({ label: '↰ All shared folders', variant: 'quiet', onPress: () => show(null) }));
    listing.entries.forEach((entry) => {
      rows.push(Button({
        label: `${entry.directory ? '[ ]' : '·'} ${entry.name}`,
        variant: 'quiet',
        onPress: () => {
          if (entry.directory) show(entry.path);
          else if (!pickingFolder) dialog.close(entry.path);
        },
      }));
    });
    if (!rows.length) rows.push(h('div', { className: 'control-picker-note', text: 'Nothing here to choose.' }));
    list.replaceChildren(...rows);
  }

  dialog = Dialog({
    title: KIND_TITLES[kind] || KIND_TITLES.folder,
    message: pickingFolder
      ? 'These are the folders the host shares. Open one and choose it, or add more in System › Network services on the host itself.'
      : 'These are the folders the host shares. Select a file to use it.',
    body,
    actions: pickingFolder
      ? [{ label: 'Cancel', value: null }, { label: 'Use this folder', variant: 'primary', value: () => current }]
      : [{ label: 'Cancel', value: null }],
    dismissValue: null,
    className: 'confirm-dialog control-picker-dialog',
  });
  show(null);
  return dialog.result;
}
