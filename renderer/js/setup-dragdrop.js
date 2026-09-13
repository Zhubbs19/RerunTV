// OS-level drag-and-drop of video files from Explorer onto the setup screen
// — drop onto a channel row to append the file(s) to that channel's
// playlist, or onto the interstitials pool list to add them as pool
// entries. Deliberately files only, not folders (a dropped folder resolves
// to a File object too, but scanning it recursively is what the existing
// CHOOSE FOLDER / + ADD FOLDER buttons already do via a real fs scan in the
// main process — re-implementing that here for a bare dropped path isn't
// worth the duplication, so a dropped non-video path is just skipped with a
// status message pointing at those buttons instead).
import { S, commitConfigPatch, commitInPlace } from './state.js';
import { channelListEl, interstitialsListEl, scanProgressEl } from './dom.js';
import { probeDuration } from './setup-util.js';
import { addFilesToChannel, addInterstitialPoolEntry } from './channels.js';
import { renderChannelList } from './setup-channels.js';
import { renderInterstitialsList } from './setup-interstitials.js';

// Mirrors main-media.js's VIDEO_EXTENSIONS — duplicated rather than piped
// through IPC since it's a small, stable list and this only needs it for a
// client-side "is this even worth probing" filter, not the source of truth
// (main-media.js's own scanFolderForVideos is still what the FOLDER-based
// add flows use).
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.mpg', '.mpeg']);

function extOf(filePath) {
  const dot = filePath.lastIndexOf('.');
  return dot === -1 ? '' : filePath.slice(dot).toLowerCase();
}

function flashStatus(text, ms) {
  scanProgressEl.classList.remove('hidden');
  scanProgressEl.textContent = text;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => scanProgressEl.classList.add('hidden'), ms || 2500);
}

// Resolves every dropped File to a real filesystem path via the preload
// bridge (sandboxed renderers can't read File.path directly — see
// preload.js) and filters down to ones that look like video files.
async function resolveDroppedVideoPaths(dataTransfer) {
  const files = Array.from(dataTransfer.files || []);
  const paths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean);
  return paths.filter((p) => VIDEO_EXTENSIONS.has(extOf(p)));
}

function isFileDrag(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

// ---------- Channel rows: drop to append to that channel's playlist ----------
channelListEl.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return; // internal row-reorder drag (setup-channels.js) handles itself
  const row = e.target.closest && e.target.closest('.channel-row');
  if (!row) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  row.classList.add('os-drag-over');
});
channelListEl.addEventListener('dragleave', (e) => {
  const row = e.target.closest && e.target.closest('.channel-row');
  if (row) row.classList.remove('os-drag-over');
});
channelListEl.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  const row = e.target.closest && e.target.closest('.channel-row');
  if (!row) return;
  e.preventDefault();
  row.classList.remove('os-drag-over');

  const number = parseInt(row.dataset.channelNumber, 10);
  const ch = S.config.channels.find((c) => c.number === number);
  if (!ch) return;

  const paths = await resolveDroppedVideoPaths(e.dataTransfer);
  if (!paths.length) { flashStatus('NO VIDEO FILES IN THAT DROP (DROP A FOLDER USING + ADD FOLDER INSTEAD)'); return; }

  const existing = new Set(ch.files.map((f) => f.path));
  const newPaths = paths.filter((p) => !existing.has(p));
  if (!newPaths.length) { flashStatus('ALREADY ON THIS CHANNEL'); return; }

  const entries = [];
  for (let i = 0; i < newPaths.length; i++) {
    flashStatus(`ADDING DROPPED VIDEO ${i + 1} / ${newPaths.length}…`, 60000);
    const duration = await probeDuration(newPaths[i]);
    entries.push({ path: newPaths[i], duration });
  }
  addFilesToChannel(ch, entries);
  flashStatus(`ADDED ${newPaths.length} VIDEO${newPaths.length === 1 ? '' : 'S'} TO CH ${ch.number}`);
  commitInPlace({ type: 'channel.setFields', channel: ch.number, fields: { files: ch.files, anchor: ch.anchor } }, { label: `Add ${newPaths.length} video${newPaths.length === 1 ? '' : 's'} to CH ${ch.number}` });
  renderChannelList();
});

// ---------- Interstitials pool: drop to add pool entries ----------
interstitialsListEl.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return; // internal card-reorder drag (setup-interstitials.js) handles itself
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  interstitialsListEl.classList.add('os-drag-over');
});
interstitialsListEl.addEventListener('dragleave', (e) => {
  if (e.target === interstitialsListEl) interstitialsListEl.classList.remove('os-drag-over');
});
interstitialsListEl.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  interstitialsListEl.classList.remove('os-drag-over');

  const paths = await resolveDroppedVideoPaths(e.dataTransfer);
  if (!paths.length) { flashStatus('NO VIDEO FILES IN THAT DROP'); return; }

  for (let i = 0; i < paths.length; i++) {
    flashStatus(`ADDING DROPPED VIDEO ${i + 1} / ${paths.length}…`, 60000);
    const duration = await probeDuration(paths[i]);
    addInterstitialPoolEntry({ file: { path: paths[i], duration } });
  }
  flashStatus(`ADDED ${paths.length} POOL ENTR${paths.length === 1 ? 'Y' : 'IES'}`);
  commitConfigPatch(`Add ${paths.length} ad pool entr${paths.length === 1 ? 'y' : 'ies'}`);
  renderInterstitialsList();
});

// A file dragged over any part of the setup screen that ISN'T one of the
// drop zones above would otherwise fall through to Electron's default
// behavior (navigating the window to the dropped file) — swallow it
// globally so an off-target drop is just a no-op instead of blanking the
// whole app to a video player tab.
window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => { if (isFileDrag(e)) e.preventDefault(); });
