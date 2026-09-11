// Main-process half of the Music Choice Channel plugin — a single IPC
// handler that recursively lists a folder's audio files (for a station's
// playlist) or image files (for a slideshow background). Duration probing
// happens renderer-side (an off-screen <audio> element's loadedmetadata),
// so this file stays a plain folder walk with no ffmpeg/spawn dependency.
const path = require('path');
const { extractEmbeddedArt } = require('./embedded-art.js');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

// ctx.fs deliberately exposes no ranged read, so pulling a tag means reading
// the file. That is fine at this cadence — once per song change, and only
// after the cheap sidecar-image lookup has already missed — but a pathological
// file should not be pulled into memory whole, and an oversized cover should
// not be pushed through IPC as base64.
const MAX_AUDIO_BYTES = 120 * 1024 * 1024;
const MAX_ART_BYTES = 8 * 1024 * 1024;

function activate(ctx) {
  const { ipcMain, fs: pluginFs } = ctx;

  // Reads the cover image out of a track's own tags. Returns a data URL the
  // renderer can drop straight into an <img>, or null for "this file has no
  // embedded art", which is an ordinary answer and not an error.
  ipcMain.handle('music-choice:embeddedArt', async (event, opts) => {
    const filePath = opts && opts.filePath;
    if (!filePath || typeof filePath !== 'string') return { art: null };
    if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return { art: null };
    if (!pluginFs.existsSync(filePath)) return { art: null };
    try {
      const buf = await new Promise((resolve, reject) => {
        pluginFs.readFile(filePath, (err, data) => (err ? reject(err) : resolve(data)));
      });
      if (!buf || buf.length > MAX_AUDIO_BYTES) return { art: null };
      const pic = extractEmbeddedArt(buf);
      if (!pic || pic.data.length > MAX_ART_BYTES) return { art: null };
      return { art: `data:${pic.mime};base64,${pic.data.toString('base64')}` };
    } catch (e) {
      // An unreadable or malformed file costs a missing cover, nothing more.
      return { art: null, error: String(e && e.message ? e.message : e) };
    }
  });

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
