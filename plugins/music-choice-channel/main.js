// Main-process half of the Music Choice Channel plugin — a single IPC
// handler that recursively lists a folder's audio files (for a station's
// playlist) or image files (for a slideshow background). Duration probing
// happens renderer-side (an off-screen <audio> element's loadedmetadata),
// so this file stays a plain folder walk with no ffmpeg/spawn dependency.
const path = require('path');
const { extractEmbeddedArt } = require('./embedded-art.js');
const { readTrackTags, bufferIo } = require('./tags.js');

const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

// ctx.fs deliberately exposes no ranged read, so pulling a tag means reading
// the file. That is fine at this cadence — once per song change, and only
// after the cheap sidecar-image lookup has already missed — but a pathological
// file should not be pulled into memory whole, and an oversized cover should
// not be pushed through IPC as base64.
const MAX_AUDIO_BYTES = 120 * 1024 * 1024;
const MAX_ART_BYTES = 8 * 1024 * 1024;
// One rescan asks for a whole station's tags in batches; bound a single call.
const MAX_TAG_BATCH = 200;

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

  // Artist/title/album/year for a batch of tracks, read from their own tags
  // (tags.js) so the channel can search by year and album even when the
  // filenames carry neither. Only the few kilobytes a tag occupies are read,
  // through ctx.fs.readRange; a host whose ctx.fs predates that falls back
  // to reading the file, capped like embeddedArt above.
  async function tagsFor(filePath) {
    if (!filePath || typeof filePath !== 'string') return {};
    if (!AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return {};
    if (!pluginFs.existsSync(filePath)) return {};
    if (typeof pluginFs.readRange === 'function' && typeof pluginFs.statSync === 'function') {
      const size = pluginFs.statSync(filePath).size;
      return readTrackTags({ size, readRange: (start, length) => pluginFs.readRange(filePath, start, length) });
    }
    const buf = await new Promise((resolve, reject) => {
      pluginFs.readFile(filePath, (err, data) => (err ? reject(err) : resolve(data)));
    });
    if (!buf || buf.length > MAX_AUDIO_BYTES) return {};
    return readTrackTags(bufferIo(buf));
  }

  ipcMain.handle('music-choice:readTags', async (event, opts) => {
    const filePaths = Array.isArray(opts && opts.filePaths) ? opts.filePaths.slice(0, MAX_TAG_BATCH) : [];
    const tags = [];
    for (const filePath of filePaths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        tags.push(await tagsFor(filePath));
      } catch (e) {
        // A malformed or unreadable file just has no tags to offer.
        tags.push({});
      }
    }
    return { tags };
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
