// Background sync: watches what the shared <video> element is actually
// playing and reports it to main.js so the cast device can be kept in step
// with the live schedule. No channel/UI registration here — see settings.js
// for the PLUGINS-tab controls (device IP, connect, cast now, auto-sync).
const { player, S } = window.RCBPlugins.ctx;

function decodeLocalPath(currentSrc) {
  if (!currentSrc || !currentSrc.startsWith('app://media/')) return null; // mediaSource-plugin refs and bumpers aren't supported yet
  try {
    const url = new URL(currentSrc);
    return url.searchParams.get('p');
  } catch (e) {
    return null;
  }
}

function reportNowPlaying() {
  if (!S.isPoweredOn) return;
  const src = player.currentSrc || player.src;
  const filePath = decodeLocalPath(src);
  if (!filePath) return;
  window.api.castSetNowPlaying({
    path: filePath,
    positionMs: Math.round((player.currentTime || 0) * 1000),
    title: (S.config && S.config.channels && (S.config.channels.find((c) => c.number === S.currentNumber) || {}).name) || null,
    channelNumber: S.currentNumber,
  });
}

// Reports on every file change immediately (so a channel change re-casts
// promptly under auto-sync) and on a steady interval regardless of whether
// the file changed — main.js needs the latter to keep its own drift-
// correction math (nowPlaying.positionMs/capturedAt) current even while the
// same file keeps playing.
player.addEventListener('loadstart', reportNowPlaying);
setInterval(reportNowPlaying, 5000);
