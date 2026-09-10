// Main-process half of the Music Choice Channel plugin — a single IPC
// handler that recursively lists a folder's audio files (for a station's
// playlist) or image files (for a slideshow background). Duration probing
// happens renderer-side (an off-screen <audio> element's loadedmetadata),
// so this file stays a plain folder walk with no ffmpeg/spawn dependency.
const path = require('path');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function activate(ctx) {
  const { ipcMain, fs: pluginFs } = ctx;

  ipcMain.handle('music-choice:scanFolder', async (event, opts) => {
    const folderPath = opts && opts.folderPath;
    const kind = (opts && opts.kind) === 'image' ? 'image' : 'audio';
    if (!folderPath || !pluginFs.existsSync(folderPath)) return { files: [], error: 'Folder not found.' };
    const extensions = kind === 'image' ? IMAGE_EXTENSIONS : AUDIO_EXTENSIONS;
    const results = [];

    function walk(dir) {
      let entries;
      try {
        entries = pluginFs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === '_originals_backup') continue;
          walk(fullPath);
        } else if (extensions.has(path.extname(entry.name).toLowerCase())) {
          results.push(fullPath);
        }
      }
    }
    walk(folderPath);
    results.sort();
    return { files: results };
  });
}

module.exports = { activate };
