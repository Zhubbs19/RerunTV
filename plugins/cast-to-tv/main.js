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
  const { ipcMain, createServer, desktopCapturer, getLanAddresses, sendToMainWindow } = ctx;

  let session = null; // current CastSession, or null when not connected
  let deviceHost = null;
  let autoSync = true;
  let nowPlaying = null; // { path, positionMs, title, channelNumber } — latest from the renderer
  let lastLoadedPath = null;
  let lastStatus = { state: 'disconnected' };
  let castMode = null; // 'program' or 'mirror'
  let mirrorMimeType = 'video/webm; codecs="vp8, opus"';
  let mirrorQuality = null;
  let mirrorActive = false;
  let mirrorBootstrap = [];
  let mirrorBootstrapBytes = 0;
  let mirrorCaptureSession = null;
  const mirrorClients = new Set();
  const MAX_MIRROR_BOOTSTRAP_BYTES = 16 * 1024 * 1024;

  function reportStatus(patch) {
    lastStatus = { ...patch };
    sendToMainWindow('cast:status', lastStatus);
  }

  // ---- local HTTP server: serves whatever `nowPlaying.path` currently is ----
  const server = createServer((req, res) => {
    const route = req.url.split('?')[0];
    const remoteAddress = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if ((route === '/mirror' || route === '/now') && deviceHost && remoteAddress !== deviceHost) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (route === '/mirror') {
      if (!mirrorActive) { res.writeHead(404); res.end(); return; }
      req.socket.setNoDelay(true);
      res.writeHead(200, {
        'Content-Type': mirrorMimeType,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
        Connection: 'keep-alive',
      });
      // Send headers immediately so the receiver can start its demuxer
      // without waiting for Node to coalesce them with a later media write.
      res.flushHeaders?.();
      mirrorBootstrap.forEach((chunk) => res.write(chunk));
      mirrorClients.add(res);
      req.on('close', () => mirrorClients.delete(res));
      res.on('close', () => mirrorClients.delete(res));
      return;
    }
    if (route !== '/now') { res.writeHead(404); res.end(); return; }
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

  function mirrorUrl() {
    const addrs = getLanAddresses();
    const host = (addrs && addrs[0] && addrs[0].address) || '127.0.0.1';
    return `http://${host}:${PORT}/mirror`;
  }

  function resetMirrorStream() {
    mirrorActive = false;
    mirrorBootstrap = [];
    mirrorBootstrapBytes = 0;
    for (const response of mirrorClients) {
      try { response.end(); } catch (e) { /* receiver already closed */ }
    }
    mirrorClients.clear();
  }

  async function doConnect(host) {
    const previousSession = session;
    session = null;
    if (previousSession) previousSession.disconnect();
    deviceHost = host;
    reportStatus({ state: 'connecting', host });
    const nextSession = new CastSession({
      host,
      onStatus: (s) => {
        // A replaced session can emit its asynchronous close after the new
        // one has started. Ignore that stale callback instead of letting it
        // clear the current receiver and make CAST NOW fail at random.
        if (session !== nextSession) return;
        if (castMode === 'program' && s.state === 'media' && typeof s.currentTime === 'number' && nowPlaying) {
          // Drift check: if the receiver's own reported position has wandered
          // more than 4s from where the live schedule actually is right now,
          // nudge it back in line rather than letting it silently fall behind
          // (a receiver-side buffering stall is the common cause).
          if (autoSync) {
            const expectedSec = (nowPlaying.positionMs + (Date.now() - nowPlaying.capturedAt)) / 1000;
            if (Math.abs(expectedSec - s.currentTime) > 4) nextSession.seek(expectedSec);
          }
        }
        if (s.state === 'error' || s.state === 'disconnected') {
          session = null;
          deviceHost = null;
          if (castMode === 'mirror') resetMirrorStream();
          castMode = null;
          mirrorQuality = null;
        }
        if (s.state === 'media' && s.playerState === 'IDLE') {
          castMode = null;
          reportStatus({ state: 'connected', host });
        } else {
          reportStatus({ ...s, host, mode: castMode, quality: castMode === 'mirror' ? mirrorQuality : undefined });
        }
      },
    });
    session = nextSession;
    try {
      await nextSession.connect();
      if (session !== nextSession) throw new Error('The selected receiver changed while connecting');
      reportStatus({ state: 'connected', host });
    } catch (error) {
      if (session === nextSession) {
        session = null;
        deviceHost = null;
      }
      nextSession.disconnect();
      reportStatus({ state: 'error', host, error: error.message });
      throw error;
    }
  }

  function castCurrent() {
    if (!session) throw new Error('Not connected to a cast device');
    if (!nowPlaying || !nowPlaying.path) throw new Error('Nothing is currently playing');
    const elapsedSec = (nowPlaying.positionMs + (Date.now() - nowPlaying.capturedAt)) / 1000;
    lastLoadedPath = nowPlaying.path;
    castMode = 'program';
    const ext = path.extname(nowPlaying.path).toLowerCase();
    session.loadMedia({
      url: mediaUrl(),
      contentType: CONTENT_TYPE_BY_EXT[ext] || 'video/mp4',
      currentTimeSec: Math.max(0, elapsedSec),
      title: nowPlaying.title,
    });
    reportStatus({ state: 'casting', host: deviceHost, mode: castMode, path: nowPlaying.path });
  }

  ipcMain.handle('cast:scan', async () => discoverCastDevices({ interfaces: getLanAddresses().map((c) => c.address) }));

  ipcMain.handle('cast:listMirrorSources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      displayId: source.display_id || '',
      sourceType: source.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnailDataUrl: source.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('cast:prepareMirrorCapture', async (event, sourceId) => {
    const mediaSession = event.sender && event.sender.session;
    if (!mediaSession || typeof mediaSession.setDisplayMediaRequestHandler !== 'function') {
      throw new Error('This Electron build cannot capture mirrored audio');
    }
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 0, height: 0 },
      fetchWindowIcons: false,
    });
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) throw new Error('The selected mirror source is no longer available');
    const sourceType = source.id.startsWith('screen:') ? 'screen' : 'window';

    // getDisplayMedia cannot choose a source itself in Electron. Install a
    // one-shot handler for the source the user picked in the plugin UI. For
    // app-window capture, WebFrameMain audio includes the player, Web Audio
    // SFX, and plugin-created audio elements. For a whole Windows display,
    // Electron's loopback source captures the actual system mix.
    mediaSession.setDisplayMediaRequestHandler((request, callback) => {
      const streams = { video: source };
      if (request.audioRequested) {
        if (sourceType === 'screen' && process.platform === 'win32') {
          streams.audio = 'loopback';
        } else if (sourceType === 'window' && request.frame) {
          streams.audio = request.frame;
          streams.enableLocalEcho = true;
        }
      }
      callback(streams);
      setImmediate(() => {
        try { mediaSession.setDisplayMediaRequestHandler(null); } catch (e) { /* session closed */ }
        if (mirrorCaptureSession === mediaSession) mirrorCaptureSession = null;
      });
    });
    mirrorCaptureSession = mediaSession;
    return {
      sourceType,
      audioMode: sourceType === 'screen'
        ? (process.platform === 'win32' ? 'system' : 'unavailable')
        : 'app',
    };
  });

  ipcMain.handle('cast:connect', async (event, host) => {
    await doConnect(host);
    return lastStatus;
  });

  ipcMain.handle('cast:disconnect', async () => {
    if (session) session.disconnect();
    session = null; deviceHost = null; lastLoadedPath = null;
    castMode = null;
    mirrorQuality = null;
    resetMirrorStream();
    reportStatus({ state: 'disconnected' });
    return lastStatus;
  });

  ipcMain.handle('cast:castNow', async (event, host) => {
    // The selected receiver is the user's intent. Do not require a hidden
    // two-step CONNECT then CAST NOW ritual; establish or switch the session
    // here so every caller gets the same reliable behavior.
    if (host && (!session || deviceHost !== host)) await doConnect(host);
    if (castMode === 'mirror') resetMirrorStream();
    castCurrent();
    return lastStatus;
  });

  function writeMirrorChunk(response, chunk) {
    if (response.destroyed || response.writableEnded) return Promise.resolve();
    try {
      if (response.write(chunk)) return Promise.resolve();
    } catch (e) {
      mirrorClients.delete(response);
      return Promise.resolve();
    }
    // Honor socket backpressure rather than accumulating stale frames in
    // ServerResponse's internal buffer. The renderer awaits this IPC call
    // before forwarding its next encoded chunk.
    return new Promise((resolve) => {
      const done = () => {
        response.off('drain', done);
        response.off('close', done);
        response.off('error', done);
        resolve();
      };
      response.once('drain', done);
      response.once('close', done);
      response.once('error', done);
    });
  }

  ipcMain.handle('cast:mirrorChunk', async (event, bytes) => {
    if (!bytes) return;
    const chunk = Buffer.from(bytes);
    if (!chunk.length) return;
    mirrorActive = true;
    if (!mirrorClients.size && mirrorBootstrapBytes < MAX_MIRROR_BOOTSTRAP_BYTES) {
      mirrorBootstrap.push(chunk);
      mirrorBootstrapBytes += chunk.length;
    }
    await Promise.all([...mirrorClients].map((response) => writeMirrorChunk(response, chunk)));
  });

  ipcMain.handle('cast:startMirror', async (event, host, mimeType, quality) => {
    if (!host) throw new Error('Choose a receiver before mirroring');
    if (!mirrorActive) throw new Error('RerunTV window capture did not start');
    if (!session || deviceHost !== host) await doConnect(host);
    castMode = 'mirror';
    lastLoadedPath = null;
    mirrorQuality = typeof quality === 'string' ? quality : null;
    mirrorMimeType = typeof mimeType === 'string' && mimeType.startsWith('video/webm')
      ? mimeType : 'video/webm';
    session.loadMedia({
      url: mirrorUrl(),
      contentType: mirrorMimeType,
      currentTimeSec: 0,
      title: 'RerunTV Live',
      streamType: 'LIVE',
    });
    reportStatus({ state: 'mirroring', host, mode: castMode, quality: mirrorQuality });
    return lastStatus;
  });

  ipcMain.handle('cast:stopMirror', async () => {
    resetMirrorStream();
    if (session) session.stopMedia();
    castMode = null;
    mirrorQuality = null;
    reportStatus({ state: session ? 'connected' : 'disconnected', host: deviceHost });
    return lastStatus;
  });

  ipcMain.handle('cast:stop', async () => {
    if (session) session.stopMedia();
    lastLoadedPath = null;
    castMode = null;
    mirrorQuality = null;
    resetMirrorStream();
    reportStatus({ state: session ? 'connected' : 'disconnected', host: deviceHost });
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
    if (session && castMode === 'program' && autoSync && lastLoadedPath && prevPath && prevPath !== info.path) {
      try { castCurrent(); } catch (e) { reportStatus({ state: 'error', error: e.message }); }
    }
  });

  ipcMain.handle('cast:getStatus', async () => lastStatus);

  ctx.app.on('before-quit', () => {
    if (session) session.disconnect();
    resetMirrorStream();
    if (mirrorCaptureSession) {
      try { mirrorCaptureSession.setDisplayMediaRequestHandler(null); } catch (e) {}
      mirrorCaptureSession = null;
    }
    try { server.close(); } catch (e) {}
  });
}

module.exports = { activate };
