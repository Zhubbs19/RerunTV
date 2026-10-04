'use strict';
// Baked-in black bar detection (main/media/cropdetect.js): the ffmpeg output
// parsing and the rule that turns several samples into one crop box.

const test = require('node:test');
const assert = require('node:assert/strict');
const { combineCrops, modeCrop, parseCropLines, parseFrameSize, sampleStarts } = require('../main/media/cropdetect');

const FRAME = { w: 1920, h: 1080 };

test('parseCropLines reads every crop= suggestion', () => {
  const stderr = '[Parsed_cropdetect_1 @ 0x1] x1:0 x2:1919 y1:132 y2:947 w:1920 h:816 x:0 y:132 pts:1 t:0.1 limit:0.094118 crop=1920:816:0:132\n'
    + '[Parsed_cropdetect_1 @ 0x1] x1:0 crop=1920:816:0:132\n';
  assert.deepEqual(parseCropLines(stderr), [{ w: 1920, h: 816, x: 0, y: 132 }, { w: 1920, h: 816, x: 0, y: 132 }]);
  assert.deepEqual(parseCropLines(''), []);
  assert.deepEqual(parseCropLines(null), []);
});

test('parseFrameSize finds the video stream size, not a hex codec tag', () => {
  const stderr = '  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709), 1920x1080 [SAR 1:1 DAR 16:9], 23.98 fps\n';
  assert.deepEqual(parseFrameSize(stderr), { w: 1920, h: 1080 });
  assert.equal(parseFrameSize('no video here'), null);
});

test('modeCrop picks the most frequent box', () => {
  const a = { w: 1920, h: 816, x: 0, y: 132 };
  const b = { w: 1920, h: 700, x: 0, y: 190 };
  assert.deepEqual(modeCrop([a, b, a, a, b]), a);
  assert.equal(modeCrop([]), null);
});

test('combineCrops returns the picture as fractions of the frame', () => {
  const crop = { w: 1920, h: 816, x: 0, y: 132 };
  const out = combineCrops([crop, crop, crop], FRAME);
  assert.deepEqual(out, { x: 0, y: 0.1222, w: 1, h: 0.7556 });
});

test('combineCrops takes the union, since dark scenes only over-crop', () => {
  const real = { w: 1920, h: 816, x: 0, y: 132 };
  const dark = { w: 1920, h: 500, x: 0, y: 290 };
  const out = combineCrops([real, dark, null], FRAME);
  assert.equal(out.y, 0.1222);
  assert.equal(out.h, 0.7556);
});

test('combineCrops reports no bars for a full frame or thin edges', () => {
  assert.equal(combineCrops([{ w: 1920, h: 1080, x: 0, y: 0 }], FRAME), null);
  assert.equal(combineCrops([{ w: 1920, h: 1040, x: 0, y: 20 }], FRAME), null, 'about 2% bars is noise');
});

test('combineCrops rejects a mostly-black sample and missing input', () => {
  assert.equal(combineCrops([{ w: 300, h: 200, x: 800, y: 400 }], FRAME), null);
  assert.equal(combineCrops([], FRAME), null);
  assert.equal(combineCrops([{ w: 1920, h: 816, x: 0, y: 132 }], null), null);
});

test('combineCrops finds pillarbox bars too', () => {
  const out = combineCrops([{ w: 1440, h: 1080, x: 240, y: 0 }], FRAME);
  assert.deepEqual(out, { x: 0.125, y: 0, w: 0.75, h: 1 });
});

test('sampleStarts spreads five samples over a long file, one for a short one', () => {
  assert.deepEqual(sampleStarts(1000), [100, 300, 500, 700, 900]);
  assert.equal(sampleStarts(60).length, 1);
  assert.equal(sampleStarts(0).length, 1);
});
