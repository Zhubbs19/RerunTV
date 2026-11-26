// plugins/ffmpeg-transcode/main.js: a missing ffmpeg is reported in words people can act on.
const test = require('node:test');
const assert = require('node:assert/strict');
const { activate } = require('../plugins/ffmpeg-transcode/main.js');

const ctxWith = ({ configured = null, resolved = null, exists = () => false } = {}) => ({
  loadConfig: async () => ({ ffmpeg: { ffmpegPath: configured } }),
  ffmpegStaticPath: resolved,
  fs: { existsSync: exists },
  services: {},
});

test('no ffmpeg anywhere says it is not installed and how to fix it', async () => {
  await assert.rejects(activate(ctxWith()), (e) => {
    assert.doesNotMatch(e.message, /unresolved/);
    assert.match(e.message, /isn't installed/);
    assert.match(e.message, /INSTALL FFMPEG/);
    return true;
  });
});

test('a configured path that is gone is named', async () => {
  await assert.rejects(activate(ctxWith({ configured: 'D:/tools/ffmpeg.exe' })), /D:\/tools\/ffmpeg\.exe/);
});

test('a found ffmpeg is published', async () => {
  const ctx = ctxWith({ resolved: '/usr/bin/ffmpeg', exists: (p) => p === '/usr/bin/ffmpeg' });
  await activate(ctx);
  assert.equal(ctx.services.ffmpegPath, '/usr/bin/ffmpeg');
});
