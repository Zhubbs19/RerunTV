// Publishes the bundled ffmpeg binary's path onto ctx.services.ffmpegPath for
// core (video transcode, party thumbnail capture) and dependent plugins
// (any plugin that pipes real-time audio through ffmpeg declares
// "dependsOn": ["ffmpeg-transcode"] so it activates after this does) to read.
//
// The actual `require('ffmpeg-static')` resolution can't happen here: this
// file runs from userData/plugins/ffmpeg-transcode/, which is outside the
// app's own node_modules tree, so requiring an npm package from it would
// fail. Core still does that resolution (main-media.js's FFMPEG_STATIC_PATH)
// and hands the already-resolved absolute path in via ctx — this plugin's
// only job is deciding whether to actually publish it, which is what makes
// disabling this plugin a real, meaningful toggle rather than a fake one.
function activate(ctx) {
  // A user-configured path (settings.js's FFMPEG PATH field, config.ffmpeg.ffmpegPath)
  // wins over the bundled/system path core resolved, if it actually exists.
  const configuredPath = (ctx.loadConfig().ffmpeg || {}).ffmpegPath;
  const resolvedPath = (configuredPath && ctx.fs.existsSync(configuredPath))
    ? configuredPath
    : ctx.ffmpegStaticPath;
  if (!resolvedPath || !ctx.fs.existsSync(resolvedPath)) {
    throw new Error(`bundled ffmpeg binary not found at ${resolvedPath || '(unresolved)'}`);
  }
  ctx.services.ffmpegPath = resolvedPath;
}

module.exports = { activate };
