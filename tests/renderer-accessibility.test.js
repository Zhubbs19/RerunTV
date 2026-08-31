const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

async function loadModule(file, context, cache = new Map()) {
  const absolute = path.resolve(file);
  if (cache.has(absolute)) return cache.get(absolute);
  const mod = new vm.SourceTextModule(fs.readFileSync(absolute, 'utf8'), { context, identifier: absolute });
  cache.set(absolute, mod);
  await mod.link((specifier, parent) => loadModule(path.resolve(path.dirname(parent.identifier), specifier), context, cache));
  return mod;
}

test('fallback media titles remove dotted release noise and expose suspicious metadata', async () => {
  const context = vm.createContext({
    console, Date, setTimeout, clearTimeout,
    window: { matchMedia: () => ({ matches: false }) }, document: { createElement: () => ({ set textContent(value) { this.value = value; }, get innerHTML() { return this.value || ''; } }) },
  });
  const util = await loadModule(path.join(ROOT, 'renderer', 'js', 'util.js'), context);
  await util.evaluate();
  const file = { path: 'C:/archive/Email.Surveillance.1080p.WEB-DL.2CH.PSA.ia.mp4' };
  assert.equal(util.namespace.getDisplayTitle(file), 'Email Surveillance PSA ia');
  assert.equal(util.namespace.titleNeedsMetadata(file), true);
  assert.equal(util.namespace.titleNeedsMetadata({ path: 'Pilot.mkv' }), false);
  assert.equal(util.namespace.titleNeedsMetadata({ path: file.path, title: 'Email Surveillance PSA' }), false);
});

test('custom overlay placement has keyboard, numeric, focus-return, and live-region paths', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-overlay-position-editor.js'), 'utf8');
  assert.match(source, /selection\.tabIndex = 0/);
  assert.match(source, /Shift\+ArrowUp/);
  assert.match(source, /xInput = coordinateField\('X %'\)/);
  assert.match(source, /aria-live', 'polite'/);
  assert.match(source, /returnFocus\.focus/);
});

test('runtime overlay coordinates clamp against the rendered overlay size', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'dynamic-overlays.js'), 'utf8');
  assert.match(source, /clamp\(0px, \$\{rule\.x\}%, calc\(100% - var\(--dynamic-overlay-size\)\)\)/);
  assert.match(source, /clamp\(0px, \$\{rule\.y\}%, calc\(100% - var\(--dynamic-overlay-size\)\)\)/);
});

test('dynamic channel edit navigation uses correct toolbar and tab semantics', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-channels.js'), 'utf8');
  assert.match(source, /editGroupBar\.setAttribute\('role', 'toolbar'\)/);
  assert.match(source, /groupBtn\.setAttribute\('aria-pressed'/);
  assert.match(source, /tabBtn\.tabIndex = tabActive \? 0 : -1/);
  assert.match(source, /enableDynamicBarKeyboard\(editTabBar/);
});

test('control center separates everyday viewing from headend operations', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup-settings.js'), 'utf8');
  assert.match(markup, /WATCH &amp; LINEUP/);
  assert.match(markup, /HEADEND STUDIO/);
  assert.match(markup, /data-workspaces="viewing headend"/);
  assert.match(settings, /applySetupWorkspace/);
});

test('flagship era themes own guide motion while every theme keeps a core fallback', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'guide.css'), 'utf8');
  assert.match(guide, /--theme-guide-enter-x, 0px/);
  assert.match(guide, /--theme-guide-enter-ease, ease-in-out/);
  for (const id of ['wood-console-70s', 'uhf-public-access-80s', 'vhs-retro-80s', 'analog-90s', 'prevue-guide-94', 'cable-box-osd']) {
    const css = fs.readFileSync(path.join(ROOT, 'plugins', `theme-${id}`, 'style.css'), 'utf8');
    assert.match(css, /--theme-guide-enter-x:/, `${id} needs an era-specific guide entrance`);
    assert.match(css, /--theme-guide-enter-ease:/, `${id} needs an era-specific guide easing`);
  }
});
