'use strict';
// readableReleaseNotes (renderer/js/core/util.js): the post-update card and HELP show release notes
// as plain text, whether they arrive as markdown (GitHub's API) or HTML (the updater's feed).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'core', 'util.js')).href);

const MARKDOWN = [
  '**Unsigned beta:** Windows SmartScreen may warn about this installer.',
  '',
  "## What's new",
  '',
  '### 2026-11-25',
  '',
  '- The guide no longer gets stuck.',
  '- The guide shows the day & date.',
  '',
  "## What's Changed",
  '* Bump something by @dependabot[bot] in https://github.com/example/pull/1',
  '',
  '**Full Changelog**: https://github.com/example/commits/v1',
].join('\n');

const HTML = '<p><strong>Unsigned beta:</strong> Windows SmartScreen may warn about this installer.</p>\n'
  + '<h2>What\'s new</h2>\n<h3>2026-11-25</h3>\n<ul>\n<li>The guide no longer gets stuck.</li>\n'
  + '<li>The guide shows the day &amp; date &#8212; like Sun&nbsp;11/29.</li>\n</ul>\n'
  + '<h2>What\'s Changed</h2>\n<ul>\n<li>Bump something by <a href="x">@dependabot</a></li>\n</ul>\n'
  + '<p><strong>Full Changelog</strong>: <a href="y">link</a></p>';

test('markdown notes keep only the What\'s new section, without markup', async () => {
  const { readableReleaseNotes } = await load();
  assert.equal(readableReleaseNotes(MARKDOWN), '2026-11-25\n\n• The guide no longer gets stuck.\n• The guide shows the day & date.');
});

test('HTML notes from the updater read as plain text, not tags', async () => {
  const { readableReleaseNotes } = await load();
  const text = readableReleaseNotes(HTML);
  assert.doesNotMatch(text, /<|&amp;|&#|Unsigned|dependabot|Full Changelog/);
  assert.match(text, /^2026-11-25\n/);
  assert.match(text, /• The guide no longer gets stuck\.\n• The guide shows the day & date — like Sun 11\/29\./);
});

test('notes without a What\'s new section are kept whole', async () => {
  const { readableReleaseNotes } = await load();
  assert.equal(readableReleaseNotes('## Fixes\n- One thing'), 'Fixes\n• One thing');
  assert.equal(readableReleaseNotes('<p>Just a line.</p>'), 'Just a line.');
});

test('empty notes give the stock line', async () => {
  const { readableReleaseNotes } = await load();
  for (const v of [null, '', '   ', '<p></p>']) assert.match(readableReleaseNotes(v), /updated successfully/);
});

const HIGHLIGHTS_SRC = require('node:fs').readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'update', 'highlights.js'), 'utf8');

test('compareAppVersions orders betas and releases', async () => {
  const { compareAppVersions } = await load();
  assert.ok(compareAppVersions('0.2.0-beta.27', '0.2.0-beta.34') < 0);
  assert.ok(compareAppVersions('0.2.0-beta.35', '0.2.0-beta.9') > 0);
  assert.ok(compareAppVersions('0.2.0', '0.2.0-beta.35') > 0);
  assert.ok(compareAppVersions('v0.3.0-beta.1', '0.2.9') > 0);
  assert.equal(compareAppVersions('0.2.0-beta.27', 'v0.2.0-beta.27'), 0);
});

test('the post-update card lists only highlights newer than the old version', async () => {
  const { highlightsSince } = await load();
  const list = [{ id: 'a', since: '0.2.0-beta.36' }, { id: 'b' }, { id: 'c', since: '0.2.0-beta.35' }];
  assert.deepEqual(highlightsSince('0.2.0-beta.35', list).map((h) => h.id), ['a']);
  assert.deepEqual(highlightsSince('0.2.0-beta.34', list).map((h) => h.id), ['a', 'c']);
  assert.deepEqual(highlightsSince(undefined, list).map((h) => h.id), ['a', 'c']);
  // The real list: every `since` is a version the comparison can read, and an update
  // from beta.34 (the one that showed beta.27's highlights as new) lists none.
  const real = [...HIGHLIGHTS_SRC.matchAll(/id: '([^']+)'[^\n]*?since: '([^']*)'/g)].map(([, id, since]) => ({ id, since }));
  for (const h of real) assert.match(h.since, /^\d+\.\d+\.\d+(-[\w.]+)?$/);
  assert.deepEqual(highlightsSince('0.2.0-beta.34', real), []);
  assert.deepEqual(highlightsSince('0.2.0-beta.26', real).map((h) => h.id), ['pause-for-breaks', 'settings-homes']);
});
