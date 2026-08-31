// ---------- Cast to TV — casts the live schedule to a Chromecast/Google TV ----------
// Not isolated, deliberately: this plugin has to be able to stream arbitrary
// local media-library files (wherever the user's channel folders live on
// disk, which is not this plugin's own folder or the app's install
// directory) to a Chromecast. Isolated mode's OS-level
// --experimental-permission fs-read restriction (see PLUGIN_DEVELOPMENT.md's
// "Isolated plugins" section) scopes reads to exactly those two locations,
// which would make that impossible — so this plugin stays same-process, the
// same tradeoff core's own local file serving (main-protocol.js) already
// makes. It still declares every ipc/net capability it actually uses, so the
// same PLUGINS-tab approval prompt still applies.
const fs = require('fs');
const path = require('path');
const { CastSession } = require('./castv2-lite');
const { discoverCastDevices } = require('./mdns-lite');

const PORT = 8731;
const CONTENT_TYPE_BY_EXT = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/webm', // best-effort; Chromecast support for mkv containers is spotty
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
};

function activate(ctx) {
  const { ipcMain, createServer, getLanAddresses, sendToMainWindow } = ctx;

  let session = null; // current CastSession, or null when not connected
  let deviceHost = null;
  let autoSync = true;
  let nowPlaying = null; // { path, positionMs, title, channelNumber } — latest from the renderer
  let lastLoadedPath = null;
  let lastStatus = { state: 'disconnected' };

  function reportStatus(patch) {
    lastStatus = { ...lastStatus, ...patch };
    sendToMainWindow('cast:status', lastStatus);
  }

  // ---- local HTTP server: serves whatever `nowPlaying.path` currently is ----
  const server = createServer((req, res) => {
    if (req.url.split('?')[0] !== '/now') { res.writeHead(404); res.end(); return; }
    if (!nowPlaying || !nowPlaying.path) { res.writeHead(404); res.end(); return; }
    const filePath = nowPlaying.path;
    let stat;
    try { stat = fs.statSync(filePath); } catch (e) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext] || 'video/mp4';
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : stat.size - 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': contentType,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': contentType, 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filePath).pipe(res);
    }
  });
  server.listen(PORT, '0.0.0.0');

  function mediaUrl() {
    const addrs = getLanAddresses();
    const host = (addrs && addrs[0] && addrs[0].address) || '127.0.0.1';
    return `http://${host}:${PORT}/now`;
  }

  async function doConnect(host) {
    if (session) session.disconnect();
    deviceHost = host;
    reportStatus({ state: 'connecting', host });
    session = new CastSession({
      host,
      onStatus: (s) => {
        if (s.state === 'media' && typeof s.currentTime === 'number' && nowPlaying) {
          // Drift check: if the receiver's own reported position has wandered
          // more than 4s from where the live schedule actually is right now,
          // nudge it back in line rather than letting it silently fall behind
          // (a receiver-side buffering stall is the common cause).
          if (autoSync) {
            const expectedSec = (nowPlaying.positionMs + (Date.now() - nowPlaying.capturedAt)) / 1000;
            if (Math.abs(expectedSec - s.currentTime) > 4) session.seek(expectedSec);
          }
        }
        if (s.state === 'error' || s.state === 'disconnected') { session = null; deviceHost = null; }
        reportStatus(s);
      },
    });
    await session.connect();
    reportStatus({ state: 'connected', host });
  }

  function castCurrent() {
    if (!session) throw new Error('Not connected to a cast device');
    if (!nowPlaying || !nowPlaying.path) throw new Error('Nothing is currently playing');
    const elapsedSec = (nowPlaying.positionMs + (Date.now() - nowPlaying.capturedAt)) / 1000;
    lastLoadedPath = nowPlaying.path;
    const ext = path.extname(nowPlaying.path).toLowerCase();
    session.loadMedia({
      url: mediaUrl(),
      contentType: CONTENT_TYPE_BY_EXT[ext] || 'video/mp4',
      currentTimeSec: Math.max(0, elapsedSec),
      title: nowPlaying.title,
    });
    reportStatus({ state: 'casting', path: nowPlaying.path });
  }

  ipcMain.handle('cast:scan', async () => discoverCastDevices());

  ipcMain.handle('cast:connect', async (event, host) => {
    await doConnect(host);
    return lastStatus;
  });

  ipcMain.handle('cast:disconnect', async () => {
    if (session) session.disconnect();
    session = null; deviceHost = null; lastLoadedPath = null;
    reportStatus({ state: 'disconnected' });
    return lastStatus;
  });

  ipcMain.handle('cast:castNow', async () => {
    castCurrent();
    return lastStatus;
  });

  ipcMain.handle('cast:stop', async () => {
    if (session) session.stopMedia();
    lastLoadedPath = null;
    reportStatus({ state: session ? 'connected' : 'disconnected' });
    return lastStatus;
  });

  ipcMain.handle('cast:setVolume', async (event, level) => {
    if (session) session.setVolume(level);
    return lastStatus;
  });

  ipcMain.handle('cast:setAutoSync', async (event, enabled) => {
    autoSync = !!enabled;
    return { autoSync };
  });

  // Fire-and-forget from the renderer, roughly whenever the tuned channel's
  // active file/position changes (see renderer.js). If a *different* file
  // than what's already loaded starts airing while auto-sync is on, this is
  // what actually re-casts it — the schedule moved on to the next thing
  // whether or not anyone touched CAST NOW.
  ipcMain.on('cast:setNowPlaying', (event, info) => {
    const prevPath = nowPlaying && nowPlaying.path;
    nowPlaying = { ...info, capturedAt: Date.now() };
    if (session && autoSync && lastLoadedPath && prevPath && prevPath !== info.path) {
      try { castCurrent(); } catch (e) { reportStatus({ state: 'error', error: e.message }); }
    }
  });

  ipcMain.handle('cast:getStatus', async () => lastStatus);

  ctx.app.on('before-quit', () => {
    if (session) session.disconnect();
    try { server.close(); } catch (e) {}
  });
}

module.exports = { activate };
