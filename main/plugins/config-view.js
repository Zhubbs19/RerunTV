// What an ISOLATED plugin sees when it calls ctx.loadConfig().
//
// The plugin runs in its own process precisely so that it holds less authority
// than the host; handing it the whole channels.json (every other plugin's
// settings and API keys, the PIN lock, network pairing settings, TMDB key, ...)
// would undo that. The viewer projection (lan/viewer-projection.js) is no help
// here: it replaces host paths with opaque ids, and plugins need real paths.
// So this is a purpose-built view:
//
//   * its OWN pluginSettings entry, untouched (it may hold that plugin's own
//     credentials; nobody else's are included),
//   * a short allow-list of shared sections that today's isolated plugins
//     read (ffmpeg path, youtubeMusic.ytDlpPath, party, network switches),
//     passed through the same credential-key filter the viewer uses,
//   * the channel lineup reduced to identifying fields (no file lists, no
//     per-channel secrets).
//
// Anything else is simply absent. Electron-free, so it is unit-testable.
const { sanitizeViewerConfig } = require('../lan/viewer-projection');

const SHARED_SECTIONS = ['ffmpeg', 'youtubeMusic', 'party', 'network', 'theme'];
const CHANNEL_FIELDS = ['number', 'name', 'quickAccess', 'favorite'];

function isolatedConfigView(config, pluginId) {
  const source = config && typeof config === 'object' ? config : {};
  const view = {};
  SHARED_SECTIONS.forEach((key) => {
    if (source[key] !== undefined) view[key] = sanitizeViewerConfig(source[key]);
  });
  view.channels = (Array.isArray(source.channels) ? source.channels : []).map((channel) => {
    const out = {};
    CHANNEL_FIELDS.forEach((field) => { if (channel && channel[field] !== undefined) out[field] = channel[field]; });
    return out;
  });
  const own = source.pluginSettings && typeof source.pluginSettings === 'object' ? source.pluginSettings[pluginId] : undefined;
  view.pluginSettings = own === undefined ? {} : { [pluginId]: JSON.parse(JSON.stringify(own)) };
  if (source._configLoadError) view._configLoadError = true;
  if (source._isFirstRun) view._isFirstRun = true;
  return view;
}

module.exports = { isolatedConfigView, SHARED_SECTIONS, CHANNEL_FIELDS };
