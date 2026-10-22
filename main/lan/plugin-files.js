// What the LAN viewer may fetch from the plugins folder, and how much of the
// plugin list it may see.
//
// A paired viewer needs a plugin's browser-side files (renderer.js,
// settings.js, style.css and whatever those import or reference: more modules,
// images, fonts, sounds). It never needs the plugin's main-process code, which
// can embed endpoints and logic that only runs on the host, nor anything that
// is not a static web asset. This is a deny list over a plugin folder rather
// than an exact manifest allow-list, because a renderer module may import
// siblings the manifest does not name.
const fs = require('fs');
const path = require('path');
const { isPathContained } = require('../util/path-safety');

const SERVABLE_EXTENSIONS = new Set([
  '.js', '.mjs', '.css', '.json', '.html', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.ogg', '.wav', '.mp4', '.webm',
]);

// plugin folder name -> { mtimeMs, mainRel }
const manifestCache = new Map();

function mainEntryOf(pluginsDir, folder) {
  const manifestPath = path.join(pluginsDir, folder, 'manifest.json');
  let stat;
  try { stat = fs.statSync(manifestPath); } catch (e) { return null; }
  const cached = manifestCache.get(folder);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.mainRel;
  let mainRel = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.main === 'string' && manifest.main) mainRel = path.posix.normalize(manifest.main.replace(/\\/g, '/'));
  } catch (e) { /* unreadable manifest: nothing declared */ }
  manifestCache.set(folder, { mtimeMs: stat.mtimeMs, mainRel });
  return mainRel;
}

// Resolves a /plugins/<folder>/<file> request path (already URL-decoded) to a
// file the viewer may be sent, or null.
function resolveViewerPluginFile(pluginsDir, rel) {
  if (!pluginsDir || typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  if (segments.length < 2) return null; // a plugin folder plus a file
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.startsWith('.') || /^node_modules$/i.test(segment))) return null;
  const resolved = path.normalize(path.join(pluginsDir, ...segments));
  if (!isPathContained(pluginsDir, resolved)) return null;
  if (!SERVABLE_EXTENSIONS.has(path.extname(resolved).toLowerCase())) return null;
  const [folder, ...inside] = segments;
  const insideRel = path.posix.normalize(inside.join('/'));
  const mainRel = mainEntryOf(pluginsDir, folder);
  if (mainRel && insideRel === mainRel) return null; // the host-side entry point
  return resolved;
}

// The fields a viewer's plugin loader actually reads (renderer/js/plugin/
// host.js). Capabilities, approval state, integrity hashes, data directories,
// the main entry and raw error text stay on the host.
function projectPluginForViewer(plugin) {
  if (!plugin || typeof plugin !== 'object') return null;
  if (plugin.error) {
    return { dir: plugin.dir, error: String(plugin.error).slice(0, 160) };
  }
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    summary: plugin.summary,
    category: plugin.category,
    dir: plugin.dir,
    style: plugin.style,
    renderer: plugin.renderer,
    settings: plugin.settings,
    minCtxVersion: plugin.minCtxVersion,
    loadError: plugin.loadError ? 'This plugin failed to start on the host.' : null,
    needsIntegrityApproval: !!plugin.needsIntegrityApproval,
  };
}

module.exports = { resolveViewerPluginFile, projectPluginForViewer, SERVABLE_EXTENSIONS };
