// Volume leveler math (renderer/js/playback/leveler-model.js) and the ffmpeg
// loudness parsing it depends on (main/media/loudness.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { combineLoudness, parseIntegratedLoudness, sampleStarts } = require('../main/media/loudness');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'playback', 'leveler-model.js')).href);

test('a loud file is turned down and a quiet one up, within limits', async () => {
  const { gainForLoudness } = await load();
  assert.equal(gainForLoudness(-24), 1);
  assert.ok(Math.abs(gainForLoudness(-14) - 10 ** (-10 / 20)) < 1e-9, 'ten dB too loud comes down ten dB');
  assert.ok(Math.abs(gainForLoudness(-30) - 10 ** (6 / 20)) < 1e-9);
  assert.equal(gainForLoudness(-60), 2.5, 'a near-silent file is not boosted without limit');
  assert.equal(gainForLoudness(5), 0.25);
  assert.equal(gainForLoudness(null), 1, 'unmeasured files play as they are');
});

test('only local app://media files are measured', async () => {
  const { mediaPathFromUrl } = await load();
  const url = `app://media/?p=${encodeURIComponent('J:\TV\Show S01E01.mp4')}`;
  assert.equal(mediaPathFromUrl(url), 'J:\TV\Show S01E01.mp4');
  assert.equal(mediaPathFromUrl(`app://media/?p=${encodeURIComponent('mediasource:jellyfin:abc')}`), null);
  assert.equal(mediaPathFromUrl('http://127.0.0.1:9000/media?x=1'), null);
  assert.equal(mediaPathFromUrl(''), null);
});

test('the lineup sweep covers channel, block and bumper files once each', async () => {
  const { lineupMediaItems } = await load();
  const items = lineupMediaItems({
    channels: [
      { files: [{ path: 'a.mp4', duration: 10 }, { path: 'mediasource:x:1' }], blocks: [{ files: [{ path: 'b.mp4' }, { path: 'a.mp4' }] }] },
    ],
    interstitials: { pool: [{ file: { path: 'c.mp4', duration: 30 } }, { bgFile: { path: 'd.mp4' } }, {}] },
  });
  assert.deepEqual(items.map((i) => i.path), ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4']);
  assert.equal(items[0].duration, 10);
});

test("ffmpeg's ebur128 summary is read, and samples combine by energy", () => {
  const stderr = 'frame log...\n[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -19.7 LUFS\n    Threshold: -30.0 LUFS\n';
  assert.equal(parseIntegratedLoudness(stderr), -19.7);
  assert.equal(parseIntegratedLoudness('no audio here'), null);
  assert.equal(combineLoudness([-20, -20, -20]), -20);
  assert.equal(combineLoudness([-20, -70, null]), -20, 'silent and failed samples are ignored');
  assert.ok(combineLoudness([-10, -30]) > -20, 'the loud part dominates, as it does to the ear');
  assert.equal(combineLoudness([]), null);
  assert.deepEqual(sampleStarts(60), [0]);
  assert.deepEqual(sampleStarts(1000), [100, 450, 800]);
});
