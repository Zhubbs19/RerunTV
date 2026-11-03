// Local metadata for media files (docs/design/07 §5 step 2): media-center .nfo
// sidecars and the container's own tags, read from disk with nothing fetched.
//
// Two sources, in this order of trust:
//   1. NFO sidecars, the XML files media centers, media servers and library
//      managers write: `<file>.nfo` beside the file (an episode or a movie),
//      `movie.nfo` in a movie's folder, and `tvshow.nfo` in the series folder
//      (the file's folder, or one or two above it, past a season folder).
//      These are written on purpose by a person or a manager and are trusted.
//   2. Container tags, read with ffmpeg's ffmetadata muxer (only ffmpeg is
//      installed, never ffprobe). In real libraries these are mostly left
//      behind by whoever encoded the file: a release name, a site's URL, a
//      collection's name stamped on every file in it. `cleanTagTitle` and the
//      batch rule in `createLocalMetadataReader` throw those away, and a
//      comment tag is never read at all.
//
// The output is suggestions, never writes: `{ fields, sources }`, where each
// field names the file it came from. The caller decides what to fill in, and
// only ever fills a field that is empty.
//
// Parsers are pure. The reader takes its file system and ffmpeg runner by
// injection, so tests run against fixtures.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { atomicWriteFile } = require('../util/atomic-write');

const NFO_MAX_BYTES = 512 * 1024;
const TAGS_MAX_BYTES = 256 * 1024;
const TAGS_TIMEOUT_MS = 15000;
const CACHE_VERSION = 1;
const MAX_CACHE_ENTRIES = 50000;
// A tag title stamped on this many files of one batch is the collection's
// name, not each file's.
const SHARED_TITLE_LIMIT = 3;
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const SEASON_DIR = /^(s(eason)?[ ._-]?\d{1,4}|specials?)$/i;
const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.webm', '.mov', '.mkv', '.avi', '.mpg', '.mpeg', '.wmv', '.flv', '.ts', '.m2ts', '.ogv', '.divx', '.asf', '.3gp',
]);

// ---------- NFO ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, code.toLowerCase()) ? ENTITIES[code.toLowerCase()] : whole;
  });
}

function textOf(inner) {
  const cdata = inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, body) => body.replace(/</g, '\u0000'));
  // Anything still tagged inside is markup, not text.
  const plain = cdata.replace(/<[^>]*>/g, ' ').replaceAll('\u0000', '<');
  return decodeEntities(plain).replace(/\s+/g, ' ').trim();
}

function elements(xml, name) {
  const re = new RegExp(`<${name}(\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'gi');
  const out = [];
  let match;
  while ((match = re.exec(xml))) out.push({ attrs: match[1] || '', inner: match[2] });
  return out;
}

function first(xml, name) {
  const found = elements(xml, name)[0];
  const text = found ? textOf(found.inner) : '';
  return text || null;
}

function all(xml, name) {
  return elements(xml, name).map((e) => textOf(e.inner)).filter(Boolean);
}

function intOrNull(text) {
  const n = Number.parseInt(text, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function yearOf(text) {
  const match = String(text || '').match(/\b(1[89]\d\d|20\d\d)\b/);
  return match ? Number(match[1]) : null;
}

function isoDate(text) {
  const match = String(text || '').match(/\b(1[89]\d\d|20\d\d)-(\d\d)-(\d\d)\b/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

// Several genres often arrive in one element ("Comedy / Family").
function splitList(values) {
  const out = [];
  values.forEach((value) => String(value).split(/\s*[/;|,]\s*/).forEach((part) => {
    const clean = part.trim();
    if (clean && !out.some((seen) => seen.toLowerCase() === clean.toLowerCase())) out.push(clean);
  }));
  return out;
}

// The box's rating vocabulary is the US TV one (TV-Y … TV-MA), which is what a
// broadcast shows on screen even for a movie. Film ratings map to the TV
// rating a network would have aired them under. Anything else (another
// country's scheme, "Not Rated") is left unset rather than guessed.
const TV_RATINGS = ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'];
const FILM_TO_TV = { G: 'TV-G', PG: 'TV-PG', 'PG-13': 'TV-14', R: 'TV-MA', 'NC-17': 'TV-MA' };

function normalizeRating(raw) {
  if (!raw) return null;
  // Several countries arrive as "US:PG-13 / GB:12A"; a US entry wins, otherwise the first that maps.
  const entries = String(raw).split(/\s*\/\s*/);
  const usFirst = entries.slice().sort((a, b) => (/^\s*(us|usa)\s*:/i.test(b) ? 1 : 0) - (/^\s*(us|usa)\s*:/i.test(a) ? 1 : 0));
  for (const entry of usFirst) {
    if (/^\s*[a-z]{2,3}\s*:/i.test(entry) && !/^\s*(us|usa)\s*:/i.test(entry)) continue;
    const value = entry.replace(/^\s*[a-z]{2,3}\s*:\s*/i, '').replace(/^rated\s+/i, '').trim().toUpperCase().replace(/\s+/g, '');
    const tv = value.replace(/^TV-?/, 'TV-').replace(/-(FV|D|L|S|V)+$/, '');
    if (/^TV-/.test(tv) && TV_RATINGS.includes(tv)) return tv;
    const film = value.replace(/^PG13$/, 'PG-13').replace(/^NC17$/, 'NC-17');
    if (FILM_TO_TV[film]) return FILM_TO_TV[film];
  }
  return null;
}

/**
 * One NFO file's contents. `kind` is the root element's meaning:
 * 'episode' | 'movie' | 'series' | 'music', or null when the file is not
 * media-center XML (many old .nfo files are a scene release's ASCII art, or a bare
 * IMDb link; the link is still worth keeping as an id).
 */
function parseNfo(text) {
  const xml = String(text || '').replace(/^\uFEFF/, '');
  const roots = { episodedetails: 'episode', movie: 'movie', tvshow: 'series', musicvideo: 'music' };
  let kind = null;
  let body = null;
  for (const name of Object.keys(roots)) {
    const found = elements(xml, name);
    if (!found.length) continue;
    kind = roots[name];
    body = found;
    break;
  }
  const imdbLink = xml.match(/\b(tt\d{7,})\b/);
  if (!kind) return imdbLink ? { kind: null, ids: { imdb: imdbLink[1] } } : null;

  // A multi-episode file has one <episodedetails> per episode. The first
  // gives season and episode; the titles are joined the way a guide would.
  const main = body[0].inner;
  // Cast and file-info blocks hold their own <name>/<title>-like children.
  const top = main.replace(/<(actor|fileinfo|set|ratings|thumb|fanart)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, ' ');
  const out = { kind };
  const titles = body.map((b) => first(b.inner.replace(/<(actor|fileinfo|set)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi, ' '), 'title')).filter(Boolean);
  const title = titles.length > 1 ? titles.join(' / ') : titles[0] || null;

  if (kind === 'series') {
    if (title) out.series = title;
  } else if (title) {
    out.title = title;
  }
  const show = first(top, 'showtitle');
  if (show && kind !== 'series') out.series = show;
  const season = intOrNull(first(top, 'season'));
  const episode = intOrNull(first(top, 'episode'));
  if (kind === 'episode' && season != null) out.season = season;
  if (kind === 'episode' && episode != null) out.episode = episode;

  const aired = isoDate(first(top, 'aired')) || isoDate(first(top, 'premiered')) || isoDate(first(top, 'releasedate'));
  if (aired) out.aired = aired;
  const year = yearOf(first(top, 'year')) || yearOf(aired);
  if (year) out.year = year;

  const description = first(top, 'plot') || first(top, 'outline');
  if (description) out.description = description;
  const rating = normalizeRating(first(top, 'mpaa') || first(top, 'certification'));
  if (rating) out.rating = rating;
  const genre = splitList(all(top, 'genre'));
  if (genre.length) out.genre = genre;
  const studio = first(top, 'studio') || first(top, 'network');
  if (studio) out.studio = studio;
  const cast = elements(main, 'actor').map((a) => first(a.inner, 'name')).filter(Boolean).slice(0, 10);
  if (cast.length) out.cast = cast;
  if (kind === 'music') {
    const artist = first(top, 'artist');
    const album = first(top, 'album');
    if (artist) out.artist = artist;
    if (album) out.album = album;
  }

  const ids = {};
  elements(main, 'uniqueid').forEach((u) => {
    const type = (u.attrs.match(/type\s*=\s*"([^"]+)"/i) || [])[1];
    const value = textOf(u.inner);
    if (type && value && /^(imdb|tmdb|tvdb)$/i.test(type)) ids[type.toLowerCase()] = value;
  });
  if (!ids.imdb) {
    const imdb = first(top, 'imdbid') || first(top, 'imdb_id') || (imdbLink && imdbLink[1]);
    if (imdb && /^tt\d{7,}$/.test(imdb)) ids.imdb = imdb;
  }
  if (Object.keys(ids).length) out.ids = ids;
  return out;
}

// ---------- Container tags ----------

/**
 * ffmpeg's `-f ffmetadata` output: the global `key=value` section only.
 * Stream and chapter sections are skipped. Values are unescaped (a backslash
 * escapes `=`, `;`, `#`, `\` and a newline).
 */
function parseFfmetadata(text) {
  const tags = {};
  const lines = String(text || '').split(/\r?\n/);
  let inGlobal = true;
  let pending = null;
  for (const raw of lines) {
    if (pending != null) {
      pending.value += `\n${raw}`;
    } else {
      if (!raw || raw[0] === ';' || raw[0] === '#') continue;
      if (raw[0] === '[') { inGlobal = false; continue; }
      if (!inGlobal) continue;
      const eq = raw.search(/(?<!\\)=/);
      if (eq <= 0) continue;
      pending = { key: raw.slice(0, eq), value: raw.slice(eq + 1) };
    }
    // A trailing unescaped backslash continues the value on the next line.
    if (/(^|[^\\])(\\\\)*\\$/.test(pending.value)) { pending.value = pending.value.slice(0, -1); continue; }
    const key = pending.key.replace(/\\(.)/g, '$1').trim().toLowerCase();
    const value = pending.value.replace(/\\(.)/g, '$1').trim();
    if (key && value && !Object.prototype.hasOwnProperty.call(tags, key)) tags[key] = value;
    pending = null;
  }
  return tags;
}

const RELEASE_TOKENS = /\b(\d{3,4}p|[xh][ .]?26[45]|hevc|avc|xvid|divx|blu-?ray|bdrip|brrip|web-?dl|web-?rip|webrip|hdtv|dvd-?rip|remux|aac\d?|ac3|e-?ac-?3|ddp?\d|10bit)\b/i;
const EPISODE_CODE = /(?<![a-z0-9])(s\d{1,4}[ ._-]?e\d{1,3}|\d{1,2}x\d{2,3})(?![0-9])/i;
// A box set's name stamped on one of its files ("… 2-Movie Collection").
const SET_NAME = /\b(\d+[- ](movie|film|disc|episode)s?|collection|complete (series|season|seasons)|box ?set|trilogy|anthology)\b/i;

/**
 * A title tag as a person would write it, or null. Rejects what encoders and
 * release groups leave behind: a URL or domain, a "site | name" banner, a
 * dotted release name, codec and source tokens, an episode code (a title
 * that still carries one is a filename, not an episode's name), or a box
 * set's name. A trailing " - GROUP" in capitals and a trailing "(1998)" are
 * dropped.
 */
function cleanTagTitle(raw) {
  let title = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  if (/https?:\/\/|www\.|\b[\w-]+\.(com|org|net|io|to|me|tv|info|cc|ws)\b/i.test(title)) return null;
  if (title.includes('|')) return null;
  title = title.replace(/\s+-\s+[A-Z0-9]{3,8}$/, '').replace(/\s*\((19|20)\d\d\)$/, '').trim();
  if ((title.match(/[._]/g) || []).length >= 3 && !/\s/.test(title.replace(/[._]/g, ''))) return null;
  if (RELEASE_TOKENS.test(title) || EPISODE_CODE.test(title) || SET_NAME.test(title)) return null;
  if (/^\d{1,2}:\d\d(:\d\d)?([.,]\d+)?$/.test(title) || /^(chapter|track|title) ?\d+$/i.test(title)) return null;
  return title.length >= 2 ? title : null;
}

/** What a file's container tags say, filtered for trust. */
function tagsToFields(tags) {
  const out = {};
  const title = cleanTagTitle(tags.title);
  if (title) out.title = title;
  const show = cleanTagTitle(tags.show || tags.tvshow);
  if (show) out.series = show;
  const season = intOrNull(tags.season_number);
  if (season != null) out.season = season;
  const episode = intOrNull(tags.episode_sort) ?? (/^\d+$/.test(tags.episode_id || '') ? Number(tags.episode_id) : null);
  if (episode != null) out.episode = episode;
  const date = tags.date || tags.year || tags.release_date;
  const aired = isoDate(date);
  if (aired) out.aired = aired;
  const year = yearOf(date);
  if (year) out.year = year;
  // `comment` is deliberately not read: in practice it carries a release name
  // or a licence URL far more often than anything a viewer should see.
  const description = tags.description || tags.synopsis || tags.long_description || tags.longdescription;
  if (description && description.length >= 20 && !RELEASE_TOKENS.test(description.slice(0, 80))) out.description = description.replace(/\s+/g, ' ').trim();
  const genre = tags.genre ? splitList([tags.genre]) : [];
  if (genre.length) out.genre = genre;
  if (tags.network) out.studio = tags.network;
  const rating = normalizeRating(tags.content_rating || tags.rating);
  if (rating) out.rating = rating;
  if (tags.artist) out.artist = tags.artist;
  if (tags.album) out.album = tags.album;
  return out;
}

// ---------- Merging ----------

// Fields a series-level tvshow.nfo may supply to one of its episodes. Its
// title is the series name, never the episode's title, and its plot is the
// show's overview, used only when the episode has no description of its own.
const SERIES_FIELDS = ['series', 'genre', 'rating', 'studio', 'description', 'year'];

function merge(layers) {
  const fields = {};
  const sources = {};
  layers.forEach(({ data, source, only }) => {
    if (!data) return;
    Object.keys(data).forEach((key) => {
      if (key === 'kind' || key === 'ids') return;
      if (only && !only.includes(key)) return;
      if (fields[key] != null) return;
      fields[key] = data[key];
      sources[key] = source;
    });
  });
  return { fields, sources };
}

// ---------- Reader ----------

function runFfmetadata(ffmpegPath, filePath) {
  return new Promise((resolve) => {
    let child;
    let out = '';
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } finish(null); }, TAGS_TIMEOUT_MS);
    try {
      child = spawn(ffmpegPath, ['-v', 'error', '-nostdin', '-i', filePath, '-f', 'ffmetadata', '-'], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      finish(null);
      return;
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.length > TAGS_MAX_BYTES) { try { child.kill(); } catch (e) { /* gone */ } finish(out); }
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(out));
  });
}

/**
 * A cached reader over a list of local files. Cached per file on disk
 * (`<dir>/local-metadata-cache.json`), keyed by the file's size and mtime and
 * those of every sidecar that was found, so an edited .nfo is read again.
 *
 * read(refs, { nfo, tags }) -> { results: { [ref]: { fields, sources } | null }, tagsAvailable }
 */
function createLocalMetadataReader({ dir, getFfmpegPath = () => null, fsImpl = fs, runTags = runFfmetadata, now = () => Date.now() }) {
  const cachePath = dir ? path.join(dir, 'local-metadata-cache.json') : null;
  let cache = { version: CACHE_VERSION, entries: {} };
  if (cachePath) {
    try {
      const loaded = JSON.parse(fsImpl.readFileSync(cachePath, 'utf8'));
      if (loaded && loaded.version === CACHE_VERSION && loaded.entries) cache = loaded;
    } catch (e) { /* no cache yet */ }
  }
  let saveTimer = null;
  const saveSoon = () => {
    if (!cachePath) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const keys = Object.keys(cache.entries);
      if (keys.length > MAX_CACHE_ENTRIES) {
        keys.sort((a, b) => (cache.entries[a].at || 0) - (cache.entries[b].at || 0))
          .slice(0, keys.length - MAX_CACHE_ENTRIES)
          .forEach((k) => { delete cache.entries[k]; });
      }
      atomicWriteFile(cachePath, JSON.stringify(cache), { encoding: 'utf8', mkdir: true }).catch(() => {});
    }, 2000);
  };

  async function statFile(p) {
    try {
      const st = await fsImpl.promises.stat(p);
      return st.isFile() ? st : null;
    } catch (e) {
      return null;
    }
  }

  async function readNfo(p) {
    const st = await statFile(p);
    if (!st || st.size > NFO_MAX_BYTES) return null;
    try {
      return { parsed: parseNfo(await fsImpl.promises.readFile(p, 'utf8')), name: path.basename(p), sig: `${p}:${st.size}:${Math.round(st.mtimeMs)}` };
    } catch (e) {
      return null;
    }
  }

  // How many media files a folder holds. A movie.nfo describes the one
  // movie in its folder; in a folder of several it would label them all.
  // One listing per folder per read: lower-case name -> real name.
  async function listing(folder, lists) {
    if (!lists.has(folder)) {
      const names = new Map();
      try {
        (await fsImpl.promises.readdir(folder)).forEach((name) => names.set(name.toLowerCase(), name));
      } catch (e) { /* unreadable folder: no sidecars */ }
      lists.set(folder, names);
    }
    return lists.get(folder);
  }

  async function mediaCount(folder, lists) {
    let n = 0;
    (await listing(folder, lists)).forEach((name) => { if (MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase())) n += 1; });
    return n;
  }

  // The first of `stems` × image extensions present in `folder`.
  async function imageIn(folder, stems, lists) {
    const names = await listing(folder, lists);
    for (const stem of stems) {
      for (const ext of IMAGE_EXTENSIONS) {
        const real = names.get(`${stem}${ext}`.toLowerCase());
        if (real) return path.join(folder, real);
      }
    }
    return null;
  }

  // A poster or thumbnail for one file, nearest first: its own
  // (`<name>-thumb.jpg`, `<name>-poster.jpg`, `<name>.jpg`), a single-movie
  // folder's, then its show folder's (past a season folder).
  async function posterFor(filePath, showFolder, lists) {
    const folder = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const own = await imageIn(folder, [`${base}-thumb`, `${base}-poster`, base], lists);
    if (own) return own;
    if ((await mediaCount(folder, lists)) === 1) {
      const movie = await imageIn(folder, ['poster', 'folder', 'cover'], lists);
      if (movie) return movie;
    }
    const seriesFolder = showFolder || (SEASON_DIR.test(path.basename(folder)) ? path.dirname(folder) : null);
    return seriesFolder ? imageIn(seriesFolder, ['poster', 'folder'], lists) : null;
  }

  // The sidecars that apply to one file, nearest first.
  async function sidecars(filePath, counts) {
    const folder = path.dirname(filePath);
    const base = path.basename(filePath, path.extname(filePath));
    const own = (await readNfo(path.join(folder, `${base}.nfo`)))
      || ((await mediaCount(folder, counts)) === 1 ? await readNfo(path.join(folder, 'movie.nfo')) : null);
    let show = null;
    let showFolder = null;
    let up = folder;
    for (let i = 0; i < 3 && !show; i += 1) {
      show = await readNfo(path.join(up, 'tvshow.nfo'));
      if (show) showFolder = up;
      const parent = path.dirname(up);
      if (parent === up) break;
      up = parent;
    }
    return { own, show, poster: await posterFor(filePath, showFolder, counts) };
  }

  async function readOne(filePath, { nfo, tags, ffmpegPath, counts }) {
    const st = await statFile(filePath);
    if (!st) return null;
    const found = nfo ? await sidecars(filePath, counts) : { own: null, show: null, poster: null };
    const sig = [st.size, Math.round(st.mtimeMs), found.own && found.own.sig, found.show && found.show.sig, found.poster, nfo ? 'n' : '', tags && ffmpegPath ? 't' : ''].join('|');
    const hit = cache.entries[filePath];
    if (hit && hit.sig === sig) return hit.result;

    let tagFields = null;
    if (tags && ffmpegPath) {
      const text = await runTags(ffmpegPath, filePath);
      if (text) tagFields = tagsToFields(parseFfmetadata(text));
      // A container's date is as often the day it was encoded or uploaded as
      // the day it aired. One within a year of the file itself is distrusted.
      if (tagFields && tagFields.year && tagFields.year >= new Date(st.mtimeMs).getFullYear() - 1) {
        delete tagFields.year;
        delete tagFields.aired;
      }
    }
    const own = found.own && found.own.parsed && found.own.parsed.kind !== 'series' ? found.own.parsed : null;
    const show = found.show && found.show.parsed && found.show.parsed.kind === 'series' ? found.show.parsed : null;
    const merged = merge([
      { data: own, source: found.own && found.own.name },
      { data: tagFields, source: 'embedded tags' },
      { data: show, source: 'tvshow.nfo', only: SERIES_FIELDS },
    ]);
    if (found.poster) {
      merged.fields.poster = found.poster;
      merged.sources.poster = path.basename(found.poster);
    }
    const result = Object.keys(merged.fields).length ? merged : null;
    if (result && own && own.kind) result.kind = own.kind;
    cache.entries[filePath] = { sig, result, at: now() };
    saveSoon();
    return result;
  }

  return {
    async read(refs, { nfo = true, tags = true } = {}) {
      const ffmpegPath = tags ? getFfmpegPath() : null;
      const results = {};
      const counts = new Map();
      for (const ref of refs) {
        results[ref] = await readOne(ref, { nfo, tags, ffmpegPath, counts }).catch(() => null);
      }
      // A tag title on several files of one batch is a collection's name
      // (an archive's banner, a box set's), not each file's own.
      const titleCounts = new Map();
      Object.values(results).forEach((r) => {
        if (r && r.sources.title === 'embedded tags') titleCounts.set(r.fields.title.toLowerCase(), (titleCounts.get(r.fields.title.toLowerCase()) || 0) + 1);
      });
      Object.keys(results).forEach((ref) => {
        const r = results[ref];
        if (!r || r.sources.title !== 'embedded tags' || titleCounts.get(r.fields.title.toLowerCase()) < SHARED_TITLE_LIMIT) return;
        const fields = { ...r.fields };
        const sources = { ...r.sources };
        delete fields.title;
        delete sources.title;
        results[ref] = Object.keys(fields).length ? { ...r, fields, sources } : null;
      });
      return { results, tagsAvailable: !!ffmpegPath };
    },
  };
}

module.exports = {
  parseNfo,
  parseFfmetadata,
  tagsToFields,
  cleanTagTitle,
  normalizeRating,
  createLocalMetadataReader,
  __test: { decodeEntities, splitList, merge },
};
