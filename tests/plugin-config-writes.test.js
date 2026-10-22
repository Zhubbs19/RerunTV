// Plugins edit their settings through ctx.settings.updatePluginSettings (or, for
// the few bundled plugins whose settings predate pluginSettings,
// ctx.settings.updateLegacyConfig), so an edit is one named undo step and goes
// through the config funnel. A direct `S.config.x = ...` skips all of that.
//
// Assignments in plugins/*/{settings,renderer}.js are counted per file against
// the ceiling below. Most remaining sites are load-time default seeding
// (`if (!S.config.x) S.config.x = {...}`), which isn't an edit; the rest are
// listed so they can be moved over. Lower a number when you fix one; never raise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const FILES = ['settings.js', 'renderer.js'];
const CEILING = {
  'breaking-news/renderer.js': 1,
  'closed-captions/renderer.js': 1,
  'eas-alerts/settings.js': 1,
  'eas-alerts/renderer.js': 1,
  'ffmpeg-transcode/settings.js': 1,
  'guide-channel/settings.js': 1,
  'local-weather/settings.js': 1,
  'noaa-weather/renderer.js': 2,
  'party-channel/renderer.js': 10,
  'public-access/settings.js': 1,
  'public-access/renderer.js': 1,
  'sap-audio/settings.js': 1,
  'screensaver/settings.js': 1,
  'screensaver/renderer.js': 2,
  'smpte-test-pattern/settings.js': 1,
  'spotify-connect/settings.js': 1,
  'spotify-connect/renderer.js': 1,
  'ticker/settings.js': 1,
  'tmdb-metadata/renderer.js': 1,
  'vintage-audio/settings.js': 1,
  'youtube-music/settings.js': 1,
  'youtube-music/renderer.js': 3,
};
const ASSIGNMENT = /\b\w*S\.config(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])+\s*(?:\|\|=|\?\?=|\+=|-=|=)(?!=)/;

function countWrites(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*)/.test(line) && ASSIGNMENT.test(line)).length;
}

test('plugins do not add direct S.config assignments', () => {
  const above = [];
  for (const dir of fs.readdirSync(PLUGINS_DIR)) {
    for (const name of FILES) {
      const file = path.join(PLUGINS_DIR, dir, name);
      if (!fs.existsSync(file)) continue;
      const key = `${dir}/${name}`;
      const n = countWrites(file);
      if (n > (CEILING[key] || 0)) above.push(`${key}: ${n} (ceiling ${CEILING[key] || 0})`);
    }
  }
  assert.deepEqual(above, [], 'Use ctx.settings.updatePluginSettings / updateLegacyConfig instead of assigning to S.config (see this test\'s header).');
});
