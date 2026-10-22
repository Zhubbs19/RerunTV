// Adding and removing a channel's media sources (folders, individual files, plugin
// providers) and the folder rescan. The provider list itself lives in
// media-sources.js. Split out of channels.js.
import {
  buildProviderSelect, ensureMediaSourceProvidersLoaded, getMediaSourceProviders, pickFolderRefForProvider,
  providerLabel,
} from './media-sources.js';
import { applyPlaylistPreservingAir } from '../library/reanchor.js';
import {
  freshChannel, freshFileFacets, mediaRefId, parseMediaRef, tryGetDisplayName, tryGetMetadata,
} from '../core/channels.js';
import { channelFilterEl } from '../core/dom.js';
import {
  commitOwnerFields, probeDurationForEntry, showScanStatus, hideScanStatus, hideScanStatusAfter, safeApi,
} from './util.js';
import { S, dispatch, viewNow } from '../core/state.js';
import { shuffleArray } from '../core/util.js';
import { renderChannelList } from './channels.js';

// ---------- Media sources (CHOOSE SOURCE) ----------
// The provider list, its fetch and the folder picker live in media-sources.js.
ensureMediaSourceProvidersLoaded(() => renderChannelList()); // re-render once so already-drawn rows pick up the real picker instead of just "CHOOSE FOLDER"

// The per-channel folder/source picker — a plain "CHOOSE FOLDER" button
// when no media-source provider plugin is active (true for the overwhelming
// majority of setups, and exactly what every existing screenshot/muscle
// memory already expects — zero visual change), or a small select offering
// "Local Folder" plus each active provider once at least one exists.
export function buildChooseSourceControl(ch) {
  if (!getMediaSourceProviders().length) {
    const btn = document.createElement('button');
    btn.className = 'btn folder-btn';
    btn.textContent = ch.folders.length ? '+ ADD FOLDER' : 'CHOOSE FOLDER';
    btn.addEventListener('click', () => addFolderToChannel(ch));
    return btn;
  }

  return buildProviderSelect({
    title: 'CHOOSE SOURCE',
    leadingOptions: [
      { value: '', text: ch.folders.length ? '+ ADD FOLDER…' : 'CHOOSE SOURCE…' },
      { value: 'local', text: 'LOCAL FOLDER' },
    ],
    onPick: (providerId) => {
      if (providerId === 'local') { addFolderToChannel(ch); return; }
      addPluginSourceToChannel(ch, providerId);
    },
  });
}

// Mirrors addFolderToChannel's picker -> scan -> probe -> merge flow below,
// but for a plugin-provided source: the plugin owns what "picking a
// folder" even means for its own namespace (core has no folder-browser UI
// for e.g. a Drive folder). Three-tier fallback, richest first:
//   1. A renderer-registered picker (registerMediaSourcePicker, plugins.js)
//      — the plugin's own renderer.js builds and shows a real modal
//      (breadcrumbs, a clickable list, whatever fits its data), same-window
//      plain function call, no IPC involved.
//   2. A main-process pickFolder service verb (PLUGIN_DEVELOPMENT.md's
//      "Media sources" section) — for a provider that would rather not
//      ship any renderer UI at all.
//   3. A plain text-input prompt (setup-dialogs.js's promptDialog) — always
//      available, so CHOOSE SOURCE never dead-ends even for the simplest
//      possible provider.
// tryGetDisplayName moved to channels.js (see its own comment there) — it's
// pure logic setup-interstitials.js needs too, and living there avoids that
// module and this one importing from each other.

export async function addPluginSourceToChannel(ch, providerId) {
  const label = providerLabel(providerId);

  const folderRef = await pickFolderRefForProvider(providerId);
  if (!folderRef) return;

  if (ch.folders.some((e) => e.source === providerId && e.ref === folderRef)) {
    showScanStatus('THAT SOURCE IS ALREADY ON THIS CHANNEL', 2000);
    return;
  }

  showScanStatus(`SCANNING ${label.toUpperCase()}…`);

  let refs;
  try {
    refs = await window.api.scanFolder(providerId, folderRef);
  } catch (err) {
    showScanStatus(`COULDN'T REACH ${label.toUpperCase()}: ${(err && err.message) || 'unknown error'}`);
    hideScanStatusAfter(3500);
    return;
  }
  if (!refs || refs.length === 0) {
    showScanStatus(`NO VIDEO FILES FOUND IN THAT ${label.toUpperCase()} FOLDER`);
    hideScanStatusAfter(2500);
    return;
  }

  const entry = { id: mediaRefId(providerId, folderRef), source: providerId, ref: folderRef, label: null };
  const newFiles = [];
  let unreadable = 0;
  for (let i = 0; i < refs.length; i++) {
    showScanStatus(`PROBING VIDEO ${i + 1} / ${refs.length}…`);
    // refs[i] is already the wrapped mediasource:<providerId>: form (main.js's
    // fs:scanFolder handler applies that once, at scan time) — probing
    // needs the raw ref back, same convention every provider call uses.
    const rawRef = parseMediaRef(refs[i]).ref;
    // Independent lookups (duration, title, metadata) for the same file —
    // run in parallel rather than sequentially awaited. Found in review: for
    // a 200-file Drive folder this was doubling scan wall-clock time for no
    // reason, since neither call depends on the other's result.
    // eslint-disable-next-line no-await-in-loop -- files themselves are still scanned one at a time, only the per-file lookups are parallelized
    const [duration, title, metadata] = await Promise.all([
      probeDurationForEntry(providerId, rawRef),
      tryGetDisplayName(providerId, rawRef),
      tryGetMetadata(providerId, rawRef),
    ]);
    // A probe that came back empty means the file isn't readable right now;
    // never store a guessed length for it.
    if (!(duration > 0)) { unreadable++; continue; }
    newFiles.push({
      path: refs[i], duration, folder: entry.id, source: providerId, ...(title ? { title } : {}),
      ...(metadata && metadata.description ? { description: metadata.description } : {}),
      ...(metadata && metadata.facets ? { facets: { ...freshFileFacets(), ...metadata.facets } } : {}),
    });
  }
  if (!newFiles.length) {
    showScanStatus(`COULD NOT READ ANY VIDEO IN THAT ${label.toUpperCase()} FOLDER — NOTHING ADDED`, 5000);
    return;
  }
  ch.folders.push(entry);
  ch.files = ch.files.concat(newFiles);
  if (ch.shuffle) shuffleArray(ch.files);
  if (!ch.anchor) ch.anchor = Date.now();
  if (unreadable) showScanStatus(`ADDED ${newFiles.length} VIDEO${newFiles.length === 1 ? '' : 'S'} — ${unreadable} UNREADABLE FILE${unreadable === 1 ? '' : 'S'} SKIPPED`, 5000);
  else hideScanStatus();
  commitOwnerFields(ch, ['folders', 'files', 'anchor'], { label: `Add folder to CH ${ch.number}` });
  renderChannelList();
}

// Adds a folder to a channel's playlist, alongside whatever's already there
// — CHOOSE/CHANGE FOLDER used to replace ch.files outright, but multi-folder
// channels need the scan to merge in rather than clobber. Always local —
// see addPluginSourceToChannel above for the plugin-provided-source
// counterpart CHOOSE SOURCE offers once at least one provider is active.
// `folderPath` skips the folder picker (a folder dropped onto the channel).
export async function addFolderToChannel(ch, folderPath = null) {
  const folder = folderPath || await safeApi('Opening the file picker', () => window.api.selectFolder());
  if (!folder) return;
  if (ch.folders.some((e) => e.source === 'local' && e.ref === folder)) {
    showScanStatus('THAT FOLDER IS ALREADY ON THIS CHANNEL', 2000);
    return;
  }

  showScanStatus('SCANNING FOLDER…');

  let paths;
  try {
    paths = await window.api.scanFolder('local', folder);
  } catch (err) {
    showScanStatus(`COULD NOT SCAN THAT FOLDER — ${String((err && err.message) || err).slice(0, 100).toUpperCase()}`);
    hideScanStatusAfter(4000);
    return;
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    showScanStatus('NO VIDEO FILES FOUND IN THAT FOLDER');
    hideScanStatusAfter(2500);
    return;
  }

  const entry = { id: mediaRefId('local', folder), source: 'local', ref: folder, label: null };
  const newFiles = [];
  let unreadable = 0;
  for (let i = 0; i < paths.length; i++) {
    showScanStatus(`PROBING VIDEO ${i + 1} / ${paths.length}…`);
    // eslint-disable-next-line no-await-in-loop
    const duration = await probeDurationForEntry('local', paths[i]);
    if (!(duration > 0)) { unreadable++; continue; }
    newFiles.push({ path: paths[i], duration, folder: entry.id, source: 'local' });
  }
  if (!newFiles.length) {
    showScanStatus('COULD NOT READ ANY VIDEO IN THAT FOLDER — NOTHING ADDED', 5000);
    return;
  }
  ch.folders.push(entry);
  ch.files = ch.files.concat(newFiles);
  if (ch.shuffle) shuffleArray(ch.files);
  // Anchor is set once, the first time a channel gets any content — later
  // folder additions extend the loop from that same reference point rather
  // than restarting the "always live" clock.
  if (!ch.anchor) ch.anchor = Date.now();
  if (unreadable) showScanStatus(`ADDED ${newFiles.length} VIDEO${newFiles.length === 1 ? '' : 'S'} — ${unreadable} UNREADABLE FILE${unreadable === 1 ? '' : 'S'} SKIPPED`, 5000);
  else hideScanStatus();
  commitOwnerFields(ch, ['folders', 'files', 'anchor'], { label: `Add folder to CH ${ch.number}` });
  renderChannelList();
}

// Adds individual video files (not a whole folder) to a channel — the way to
// pull a few films out of a big shared folder. They are kept with `folder: null`
// (see addFilesToChannel), so a folder rescan never touches them. Appended and
// re-anchored so what is airing now keeps airing. Returns how many were new.
export async function addVideoFilesToChannel(ch, paths) {
  const known = new Set(ch.files.map((f) => f.path));
  const fresh = Array.from(new Set(paths.filter(Boolean))).filter((p) => !known.has(p));
  if (!fresh.length) {
    showScanStatus('ALREADY ON THIS CHANNEL', 2000);
    return 0;
  }
  const entries = [];
  let unreadable = 0;
  for (let i = 0; i < fresh.length; i++) {
    showScanStatus(`PROBING VIDEO ${i + 1} / ${fresh.length}…`);
    // eslint-disable-next-line no-await-in-loop
    const duration = await probeDurationForEntry('local', fresh[i]);
    if (!(duration > 0)) { unreadable++; continue; }
    entries.push({ path: fresh[i], duration, folder: null, source: 'local' });
  }
  if (!entries.length) {
    showScanStatus('COULD NOT READ THOSE VIDEOS — NOTHING ADDED', 5000);
    return 0;
  }
  applyPlaylistPreservingAir(ch, [...ch.files, ...entries], viewNow());
  if (!ch.anchor) ch.anchor = Date.now();
  const label = `Add ${entries.length} file${entries.length === 1 ? '' : 's'} to CH ${ch.number}`;
  commitOwnerFields(ch, ['files', 'anchor'], { label });
  showScanStatus(`ADDED ${entries.length} VIDEO${entries.length === 1 ? '' : 'S'} TO CH ${ch.number}${unreadable ? ` — ${unreadable} UNREADABLE SKIPPED` : ''}`, unreadable ? 5000 : 2500);
  renderChannelList();
  return entries.length;
}

// ADD FILES…: a multi-select picker, then addVideoFilesToChannel. A LAN
// control session's picker returns one path (or null); both shapes work.
export async function pickFilesForChannel(ch) {
  const picked = await safeApi('Opening the file picker', () => window.api.selectVideo({ multiple: true }));
  const paths = Array.isArray(picked) ? picked : (picked ? [picked] : []);
  if (!paths.length) return 0;
  return addVideoFilesToChannel(ch, paths);
}

// Removes one individually-added file. Appended-order and air position are
// preserved the same way as an add.
export function removeFileFromChannel(ch, file) {
  applyPlaylistPreservingAir(ch, ch.files.filter((f) => f !== file), viewNow());
  commitOwnerFields(ch, ['files', 'anchor'], { label: `Remove file from CH ${ch.number}` });
  renderChannelList();
}

// Re-scans every folder already assigned to every channel, picking up files
// added to disk (or, for a plugin source, added at the source) since the
// last scan. Additive only — a file that vanished stays in the channel list
// (and keeps any custom title) rather than being silently dropped, matching
// the "no silent destructive action" rule the confirm-on-remove dialogs
// follow. A non-'local' entry whose provider is currently unreachable/
// disabled (a stale reference in a hand-edited config, or a plugin toggled
// off) is skipped with its own error caught per-entry, not per-channel —
// one broken source shouldn't abort rescanning every other channel's
// folders in the same pass.
// A folder dropped on the lineup (setup-dragdrop.js) becomes a new channel
// named after it, with its videos, as one undo step.
export async function createChannelFromFolder(folderPath) {
  showScanStatus('SCANNING DROPPED FOLDER…');
  let paths;
  try {
    paths = await window.api.scanFolder('local', folderPath);
  } catch (err) {
    showScanStatus(`COULD NOT SCAN THAT FOLDER — ${String((err && err.message) || err).slice(0, 100).toUpperCase()}`);
    hideScanStatusAfter(4000);
    return null;
  }
  if (!Array.isArray(paths) || !paths.length) {
    showScanStatus('NO VIDEO FILES FOUND IN THAT FOLDER');
    hideScanStatusAfter(2500);
    return null;
  }
  const entry = { id: mediaRefId('local', folderPath), source: 'local', ref: folderPath, label: null };
  const files = [];
  let unreadable = 0;
  for (let i = 0; i < paths.length; i++) {
    showScanStatus(`PROBING VIDEO ${i + 1} / ${paths.length}…`);
    // eslint-disable-next-line no-await-in-loop
    const duration = await probeDurationForEntry('local', paths[i]);
    if (!(duration > 0)) { unreadable++; continue; }
    files.push({ path: paths[i], duration, folder: entry.id, source: 'local' });
  }
  if (!files.length) {
    showScanStatus('COULD NOT READ ANY VIDEO IN THAT FOLDER — NO CHANNEL CREATED', 5000);
    return null;
  }
  const channel = freshChannel();
  channel.name = folderPath.split(/[\\/]/).filter(Boolean).pop() || '';
  channel.folders = [entry];
  channel.files = files;
  channel.anchor = Date.now(); // channel anchor: real time, when the folder was scanned
  if (unreadable) showScanStatus(`CHANNEL CREATED — ${unreadable} UNREADABLE FILE${unreadable === 1 ? '' : 'S'} SKIPPED`, 5000);
  else hideScanStatus();
  dispatch({ type: 'channel.insert', channel }, { label: `Add channel from folder ${channel.name}` });
  S.bulkSelectedChannels.clear();
  S.setupSelectedChannel = channel.number;
  S.setupFilterQuery = '';
  channelFilterEl.value = '';
  renderChannelList();
  return channel.number;
}

export async function rescanAllFolders() {
  const targets = S.config.channels.filter((c) => c.folders && c.folders.length > 0);
  if (targets.length === 0) return;

  showScanStatus('RESCANNING…');
  let added = 0;
  let unreachable = 0;
  for (const ch of targets) {
    const fresh = [];
    for (const entry of ch.folders) {
      const label = ch.name && ch.name.trim() ? ch.name.trim() : `CH ${ch.number}`;
      showScanStatus(`RESCANNING ${label}: ${entry.label || entry.ref}…`);
      let paths;
      try {
        paths = await window.api.scanFolder(entry.source, entry.ref);
      } catch (err) {
        unreachable++;
        continue; // eslint-disable-line no-continue
      }
      const known = new Set(ch.files.filter((f) => f.folder === entry.id).concat(fresh).map((f) => f.path));
      const newPaths = paths.filter((p) => !known.has(p));
      for (let i = 0; i < newPaths.length; i++) {
        showScanStatus(`${label}: PROBING NEW VIDEO ${i + 1} / ${newPaths.length}…`);
        // newPaths[i] is already the wrapped form (main.js's fs:scanFolder
        // handler applies that once, at scan time) — probing needs the raw,
        // provider-native ref back, same as any provider's own probe(ref).
        const rawRef = entry.source === 'local' ? newPaths[i] : parseMediaRef(newPaths[i]).ref;
        // Parallel, not sequential — see addPluginSourceToChannel's own
        // comment on the same pattern above.
        // eslint-disable-next-line no-await-in-loop
        const [duration, title, metadata] = await Promise.all([
          probeDurationForEntry(entry.source, rawRef),
          entry.source === 'local' ? Promise.resolve(null) : tryGetDisplayName(entry.source, rawRef),
          entry.source === 'local' ? Promise.resolve(null) : tryGetMetadata(entry.source, rawRef),
        ]);
        if (!(duration > 0)) continue; // unreadable now: leave it out, a later rescan retries
        fresh.push({
          path: newPaths[i], duration, folder: entry.id, source: entry.source, ...(title ? { title } : {}),
          ...(metadata && metadata.description ? { description: metadata.description } : {}),
          ...(metadata && metadata.facets ? { facets: { ...freshFileFacets(), ...metadata.facets } } : {}),
        });
        added++;
      }
    }
    if (fresh.length) {
      // Appended (not reshuffled) and re-anchored, so what is airing now keeps airing,
      // and committed so it saves, undoes and invalidates schedule caches.
      applyPlaylistPreservingAir(ch, [...ch.files, ...fresh], viewNow());
      commitOwnerFields(ch, ['files', 'anchor'], { label: `Rescan ${ch.name || `CH ${ch.number}`}` });
    }
  }
  const addedText = added > 0 ? `${added} NEW VIDEO${added === 1 ? '' : 'S'} ADDED` : 'NO NEW VIDEOS FOUND';
  const unreachableText = unreachable > 0 ? ` — ${unreachable} FOLDER${unreachable === 1 ? '' : 'S'} UNREACHABLE, LEFT UNCHANGED` : '';
  showScanStatus(`RESCAN COMPLETE — ${addedText}${unreachableText}`, unreachable > 0 ? 5000 : 3000);
  renderChannelList();
}

export function removeFolderFromChannel(ch, folderEntry) {
  ch.folders = ch.folders.filter((e) => e.id !== folderEntry.id);
  ch.files = ch.files.filter((f) => f.folder !== folderEntry.id);
  commitOwnerFields(ch, ['folders', 'files'], { label: `Remove folder from CH ${ch.number}` });
  renderChannelList();
}
