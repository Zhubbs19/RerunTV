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

// Whole-app mirror: capture this Electron window after every piece of TV UI
// has been composited, encode it as a live WebM stream, and hand its chunks
// to main.js's LAN endpoint. This is intentionally separate from the direct
// file cast above: direct media is lower latency, while this path includes
// the guide, OSD, captions, overlays, channel changes, and other RerunTV UI.
let mirrorRecorder = null;
let mirrorWindowStream = null;
let mirrorOutputStream = null;
let mirrorSourceVideo = null;
let mirrorCanvas = null;
let mirrorDrawFrame = null;
let mirrorAudioDestination = null;
let mirrorPlayerAudioSource = null;
let mirrorChunkQueue = Promise.resolve();
let stoppingMirror = false;
let acceptMirrorChunks = false;

const MIRROR_PROFILES = {
  // Short slices reduce glass-to-glass delay. Bitrate scales with resolution
  // so guide text stays sharp without making every mode pay 4K's cost.
  '720p30': { width: 1280, height: 720, frameRate: 30, bitrate: 5_000_000, audioBitrate: 160_000, timeslice: 125, codec: 'vp8' },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, bitrate: 14_000_000, audioBitrate: 192_000, timeslice: 150, codec: 'vp8' },
  '4k60': { width: 3840, height: 2160, frameRate: 60, bitrate: 42_000_000, audioBitrate: 192_000, timeslice: 250, codec: 'vp9' },
};

function chooseMirrorMimeType(preferredCodec) {
  const codecs = preferredCodec === 'vp9' ? ['vp9', 'vp8'] : ['vp8', 'vp9'];
  const candidates = [
    ...codecs.map((codec) => `video/webm;codecs=${codec},opus`),
    ...codecs.map((codec) => `video/webm;codecs=${codec}`),
    'video/webm',
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function findRerunTvSource(sources) {
  const title = String(document.title || 'RerunTV').trim().toLowerCase();
  return sources.find((source) => String(source.name).trim().toLowerCase() === title)
    || sources.find((source) => /^rerun\s*tv$/i.test(String(source.name).trim()))
    || sources.find((source) => /rerun\s*tv/i.test(String(source.name)));
}

async function stopMirror({ notifyMain = true } = {}) {
  if (stoppingMirror) return;
  stoppingMirror = true;
  let status;
  try {
    acceptMirrorChunks = false;
    if (mirrorDrawFrame !== null) cancelAnimationFrame(mirrorDrawFrame);
    mirrorDrawFrame = null;
    if (mirrorRecorder && mirrorRecorder.state !== 'inactive') mirrorRecorder.stop();
    if (mirrorWindowStream) mirrorWindowStream.getTracks().forEach((track) => track.stop());
    // player.captureStream() creates proxy tracks; stopping the composed
    // stream does not stop or alter the actual on-box player.
    if (mirrorOutputStream) mirrorOutputStream.getTracks().forEach((track) => track.stop());
    if (mirrorPlayerAudioSource) {
      try { mirrorPlayerAudioSource.disconnect(); } catch (e) { /* already disconnected */ }
    }
    if (mirrorAudioDestination && S.sfxGain) {
      try { S.sfxGain.disconnect(mirrorAudioDestination); } catch (e) { /* no active route */ }
    }
    mirrorRecorder = null;
    mirrorWindowStream = null;
    mirrorOutputStream = null;
    if (mirrorSourceVideo) {
      mirrorSourceVideo.pause();
      mirrorSourceVideo.srcObject = null;
    }
    mirrorSourceVideo = null;
    mirrorCanvas = null;
    mirrorAudioDestination = null;
    mirrorPlayerAudioSource = null;
    if (notifyMain) status = await window.api.castStopMirror();
  } finally {
    stoppingMirror = false;
  }
  return status;
}

async function startMirror(profileId = '1080p60', sourcePreference = 'app') {
  await stopMirror({ notifyMain: false });
  const profile = MIRROR_PROFILES[profileId] || MIRROR_PROFILES['1080p60'];
  const sources = await window.api.castListMirrorSources();
  const source = sourcePreference === 'app'
    ? findRerunTvSource(sources || [])
    : (sources || []).find((candidate) => candidate.id === sourcePreference);
  if (!source) throw new Error(sourcePreference === 'app'
    ? 'The RerunTV window could not be found for capture'
    : 'The selected desktop display is no longer available');

  const captureConstraints = {
    audio: source.sourceType === 'screen' ? {
      mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id },
    } : false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxWidth: profile.width,
        maxHeight: profile.height,
        maxFrameRate: profile.frameRate,
      },
    },
  };
  try {
    mirrorWindowStream = await navigator.mediaDevices.getUserMedia(captureConstraints);
  } catch (error) {
    // Window/screen video capture is the required feature. Windows loopback
    // audio availability varies by Electron/device, so retry video-only
    // rather than making desktop mirroring fail completely.
    if (captureConstraints.audio) {
      captureConstraints.audio = false;
      mirrorWindowStream = await navigator.mediaDevices.getUserMedia(captureConstraints);
    } else {
      throw error;
    }
  }

  // Render to an exact-size canvas so the quality picker controls the
  // outgoing stream dimensions rather than acting as only a capture ceiling.
  // Contain-fit preserves the entire RerunTV window without cropping.
  mirrorSourceVideo = document.createElement('video');
  mirrorSourceVideo.muted = true;
  mirrorSourceVideo.playsInline = true;
  mirrorSourceVideo.srcObject = mirrorWindowStream;
  await mirrorSourceVideo.play();
  if (mirrorSourceVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('RerunTV window capture did not produce a frame')), 5000);
      mirrorSourceVideo.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
  mirrorCanvas = document.createElement('canvas');
  mirrorCanvas.width = profile.width;
  mirrorCanvas.height = profile.height;
  const drawContext = mirrorCanvas.getContext('2d', { alpha: false, desynchronized: true });
  const drawMirrorFrame = () => {
    const sourceWidth = mirrorSourceVideo.videoWidth || profile.width;
    const sourceHeight = mirrorSourceVideo.videoHeight || profile.height;
    const scale = Math.min(profile.width / sourceWidth, profile.height / sourceHeight);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    const x = Math.floor((profile.width - width) / 2);
    const y = Math.floor((profile.height - height) / 2);
    drawContext.fillStyle = '#000';
    drawContext.fillRect(0, 0, profile.width, profile.height);
    drawContext.drawImage(mirrorSourceVideo, x, y, width, height);
    mirrorDrawFrame = requestAnimationFrame(drawMirrorFrame);
  };
  drawMirrorFrame();
  const canvasStream = typeof mirrorCanvas.captureStream === 'function'
    ? mirrorCanvas.captureStream(profile.frameRate) : null;
  const tracks = canvasStream && canvasStream.getVideoTracks().length
    ? [...canvasStream.getVideoTracks()]
    : [...mirrorWindowStream.getVideoTracks()];
  const outputVideoTrack = tracks[0] || null;
  if (outputVideoTrack && 'contentHint' in outputVideoTrack) outputVideoTrack.contentHint = 'detail';
  // A desktop source may already contain Windows loopback audio, including
  // other applications. Prefer that one complete track and avoid doubling
  // RerunTV. App-window capture instead mixes the player and RerunTV SFX.
  if (mirrorWindowStream.getAudioTracks().length) {
    tracks.push(...mirrorWindowStream.getAudioTracks());
  } else if (typeof player.captureStream === 'function') {
    try {
      const playerStream = player.captureStream();
      const audioCtx = window.RCBPlugins.ctx.getAudioCtx();
      mirrorAudioDestination = audioCtx.createMediaStreamDestination();
      if (playerStream.getAudioTracks().length) {
        mirrorPlayerAudioSource = audioCtx.createMediaStreamSource(playerStream);
        mirrorPlayerAudioSource.connect(mirrorAudioDestination);
      }
      if (S.sfxGain) S.sfxGain.connect(mirrorAudioDestination);
      tracks.push(...mirrorAudioDestination.stream.getAudioTracks());
    } catch (e) { /* video-only mirror fallback */ }
  }
  mirrorOutputStream = new MediaStream(tracks);

  const requestedMimeType = chooseMirrorMimeType(profile.codec);
  const options = requestedMimeType
    ? {
      mimeType: requestedMimeType,
      videoBitsPerSecond: profile.bitrate,
      audioBitsPerSecond: profile.audioBitrate,
      videoKeyFrameIntervalDuration: 1000,
    }
    : { videoBitsPerSecond: profile.bitrate, audioBitsPerSecond: profile.audioBitrate };
  try {
    mirrorRecorder = new MediaRecorder(mirrorOutputStream, options);
  } catch (error) {
    // Older Chromium versions may reject only the optional keyframe hint.
    delete options.videoKeyFrameIntervalDuration;
    mirrorRecorder = new MediaRecorder(mirrorOutputStream, options);
  }
  acceptMirrorChunks = true;

  let resolveFirstChunk;
  let rejectFirstChunk;
  const firstChunk = new Promise((resolve, reject) => {
    resolveFirstChunk = resolve;
    rejectFirstChunk = reject;
  });
  mirrorRecorder.addEventListener('dataavailable', (event) => {
    if (!event.data || !event.data.size) return;
    mirrorChunkQueue = mirrorChunkQueue.then(async () => {
      if (!acceptMirrorChunks) return;
      const bytes = await event.data.arrayBuffer();
      if (!acceptMirrorChunks) return;
      await window.api.castMirrorChunk(bytes);
      resolveFirstChunk();
    });
  });
  mirrorRecorder.addEventListener('error', (event) => {
    rejectFirstChunk(event.error || new Error('RerunTV mirror encoder failed'));
  }, { once: true });
  const videoTrack = mirrorWindowStream.getVideoTracks()[0];
  if (videoTrack) videoTrack.addEventListener('ended', () => stopMirror(), { once: true });
  mirrorRecorder.start(profile.timeslice);

  // Make sure the WebM header is already waiting at the LAN endpoint before
  // the receiver asks for /mirror; otherwise it can join mid-stream and see
  // undecodable clusters instead of the container header.
  await Promise.race([
    firstChunk,
    new Promise((_, reject) => setTimeout(() => reject(new Error('RerunTV mirror encoder did not start')), 5000)),
  ]);
  const actual = outputVideoTrack && typeof outputVideoTrack.getSettings === 'function' ? outputVideoTrack.getSettings() : {};
  return {
    mimeType: mirrorRecorder.mimeType || requestedMimeType || 'video/webm',
    profileId,
    sourceName: sourcePreference === 'app' ? 'RerunTV app' : source.name,
    width: actual.width || profile.width,
    height: actual.height || profile.height,
    frameRate: actual.frameRate || profile.frameRate,
  };
}

window.RCBPlugins.castToTv = {
  startMirror,
  stopMirror,
  isMirroring: () => !!mirrorRecorder && mirrorRecorder.state === 'recording',
};
