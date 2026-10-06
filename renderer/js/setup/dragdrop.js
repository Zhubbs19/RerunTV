// OS-level drag-and-drop from Explorer onto the setup screen.
// - Videos dropped on a channel row (list or editor card) join that channel.
// - A folder dropped on a channel row is added as one of its folders; a
//   folder dropped anywhere else on the channels page (including the empty
//   lineup) becomes a new channel (docs/design/03 §5.4). Folders are scanned
//   by the same main-process scan + ADD FOLDER uses.
// - Videos dropped on the bumper & ad pool list become pool entries.
import { S, commitConfigPatch } from '../core/state.js';
import { channelListEl, channelListPaneEl, interstitialsListEl, scanProgressEl } from '../core/dom.js';
import { probeDuration } from './util.js';
import { addInterstitialPoolEntry } from '../core/channels.js';
import { addFolderToChannel, addVideoFilesToChannel, createChannelFromFolder } from './channels.js';
import { renderInterstitialsList } from './interstitials.js';

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
  return splitDroppedPaths(dataTransfer).videos;
}

// Videos by extension; everything else is treated as a possible folder (a
// scan of a plain file just finds nothing).
function splitDroppedPaths(dataTransfer) {
  const paths = Array.from(dataTransfer.files || []).map((f) => window.api.getPathForFile(f)).filter(Boolean);
  return {
    videos: paths.filter((p) => VIDEO_EXTENSIONS.has(extOf(p))),
    others: paths.filter((p) => !VIDEO_EXTENSIONS.has(extOf(p))),
  };
}

function isFileDrag(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

// ---------- Channel rows: drop to append to that channel's playlist ----------
// Either a lineup row (left list) or the selected channel's editor card.
const CHANNEL_DROP_TARGET = '.channel-row, .channel-list-item:not(.channel-list-plugins)';
const channelsPageEl = (channelListEl && channelListEl.closest('.channel-master-detail')) || channelListPaneEl;
[channelsPageEl].filter(Boolean).forEach((container) => {
container.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return; // internal row-reorder drag (setup-channels.js) handles itself
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const row = e.target.closest && e.target.closest(CHANNEL_DROP_TARGET);
  container.querySelectorAll('.os-drag-over').forEach((el) => { if (el !== row) el.classList.remove('os-drag-over'); });
  if (row) row.classList.add('os-drag-over');
  container.classList.toggle('os-drag-over-page', !row);
});
container.addEventListener('dragleave', (e) => {
  if (e.relatedTarget && container.contains(e.relatedTarget)) return;
  container.querySelectorAll('.os-drag-over').forEach((el) => el.classList.remove('os-drag-over'));
  container.classList.remove('os-drag-over-page');
});
container.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  container.querySelectorAll('.os-drag-over').forEach((el) => el.classList.remove('os-drag-over'));
  container.classList.remove('os-drag-over-page');
  const row = e.target.closest && e.target.closest(CHANNEL_DROP_TARGET);
  const { videos, others } = splitDroppedPaths(e.dataTransfer);

  // Folders off a row: one new channel each.
  if (!row) {
    if (!others.length) { flashStatus('DROP VIDEOS ONTO A CHANNEL, OR A FOLDER HERE TO MAKE A NEW CHANNEL'); return; }
    // eslint-disable-next-line no-await-in-loop
    for (const folder of others) await createChannelFromFolder(folder);
    return;
  }

  const number = parseFloat(row.dataset.channelNumber);
  const ch = S.config.channels.find((c) => c.number === number);
  if (!ch) return;

  // eslint-disable-next-line no-await-in-loop
  for (const folder of others) await addFolderToChannel(ch, folder);
  const paths = videos;
  if (!paths.length) return;

  // Same path ADD FILES… uses: probe, append without disturbing what is airing, one undo step.
  await addVideoFilesToChannel(ch, paths);
});
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
