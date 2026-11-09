// The website in site/: every feature listed in features.json has a page component and every
// page component is listed, the list is well formed, internal #/features links point at real
// pages, and the hash router reads routes the way the pages link to them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const siteSrc = path.join(__dirname, '..', 'site', 'src');
const features = JSON.parse(fs.readFileSync(path.join(siteSrc, 'features.json'), 'utf8'));
const pagesDir = path.join(siteSrc, 'pages', 'features');
const pageFiles = fs.readdirSync(pagesDir).filter((name) => name.endsWith('.jsx'));

/**
 * Lists every .js and .jsx file under a folder.
 * @param {string} dir The folder.
 * @returns {string[]} Absolute file paths.
 */
function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.jsx?$/.test(entry.name) ? [full] : [];
  });
}

test('features.json and the page components match one to one', () => {
  const listed = features.map((page) => `${page.slug}.jsx`).sort();
  assert.deepEqual(pageFiles.slice().sort(), listed);
});

test('every feature entry is complete and unique', () => {
  const slugs = new Set();
  const channels = new Set();
  for (const page of features) {
    assert.match(page.slug, /^[a-z]+(-[a-z]+)*$/, `bad slug ${page.slug}`);
    assert.match(page.ch, /^\d{2,3}$/, `bad channel number on ${page.slug}`);
    assert.ok(page.title && page.summary, `${page.slug} needs a title and a summary`);
    assert.ok(!slugs.has(page.slug), `duplicate slug ${page.slug}`);
    assert.ok(!channels.has(page.ch), `duplicate channel number ${page.ch}`);
    slugs.add(page.slug);
    channels.add(page.ch);
  }
});

test('each page component renders its own features.json entry', () => {
  for (const file of pageFiles) {
    const source = fs.readFileSync(path.join(pagesDir, file), 'utf8');
    assert.ok(source.includes(`page.slug === '${file.replace(/\.jsx$/, '')}'`), `${file} looks up another page's entry`);
  }
});

test('internal feature links point at pages that exist', () => {
  const slugs = new Set(features.map((page) => page.slug));
  for (const file of sourceFiles(siteSrc)) {
    const source = fs.readFileSync(file, 'utf8');
    const linked = [
      ...[...source.matchAll(/featureHref\('([^']+)'\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/#\/features\/([a-z-]+)/g)].map((m) => m[1]),
      ...[...source.matchAll(/\['([a-z-]+)', '/g)].map((m) => m[1]).filter((slug) => file.endsWith('Home.jsx')),
    ];
    for (const slug of linked) assert.ok(slugs.has(slug), `${path.relative(siteSrc, file)} links to missing page ${slug}`);
  }
});

test('the router splits hashes into route parts', async () => {
  const { parseHash } = await import(pathToFileURL(path.join(siteSrc, 'router.js')).href);
  assert.deepEqual(parseHash(''), []);
  assert.deepEqual(parseHash('#/'), []);
  assert.deepEqual(parseHash('#/features'), ['features']);
  assert.deepEqual(parseHash('#/downloads'), ['downloads']);
  assert.deepEqual(parseHash('#/features/live-tv'), ['features', 'live-tv']);
  assert.deepEqual(parseHash('#/docs/'), ['docs']);
});
