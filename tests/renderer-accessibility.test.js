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
  const util = await loadModule(path.join(ROOT, 'renderer', 'js', 'core/util.js'), context);
  await util.evaluate();
  const file = { path: 'C:/archive/Email.Surveillance.1080p.WEB-DL.2CH.PSA.ia.mp4' };
  assert.equal(util.namespace.getDisplayTitle(file), 'Email Surveillance PSA');
  assert.equal(util.namespace.titleNeedsMetadata(file), true);
  assert.equal(util.namespace.titleNeedsMetadata({ path: 'Pilot.mkv' }), false);
  assert.equal(util.namespace.titleNeedsMetadata({ path: file.path, title: 'Email Surveillance PSA' }), false);
});

test('custom overlay placement has keyboard, numeric, focus-return, and live-region paths', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup/overlay-editor.js'), 'utf8');
  assert.match(source, /selection\.tabIndex = 0/);
  assert.match(source, /Shift\+ArrowUp/);
  assert.match(source, /xInput = coordinateField\('X %'\)/);
  assert.match(source, /aria-live', 'polite'/);
  assert.match(source, /returnFocus\.focus/);
});

test('runtime overlay coordinates clamp against the rendered overlay size', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'playback/dynamic-overlays.js'), 'utf8');
  assert.match(source, /clamp\(0px, \$\{rule\.x\}%, calc\(100% - var\(--dynamic-overlay-size\)\)\)/);
  assert.match(source, /clamp\(0px, \$\{rule\.y\}%, calc\(100% - var\(--dynamic-overlay-size\)\)\)/);
});

// docs/design/03 §3: a channel's editor is one bar of pages.
test('channel pages use one tab bar with roving tab semantics', () => {
  const source = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup/channels.js'), 'utf8');
  assert.match(source, /editTabBar\.setAttribute\('role', 'tablist'\)/);
  assert.doesNotMatch(source, /editGroupBar/);
  for (const page of ['overview', 'content', 'schedule', 'look', 'breaks', 'advanced']) {
    assert.match(source, new RegExp(`id: '${page}'`), `channel page ${page}`);
  }
  assert.match(source, /tabBtn\.tabIndex = tabActive \? 0 : -1/);
  assert.match(source, /enableDynamicBarKeyboard\(editTabBar/);
});

// docs/design/03: one navigation layer (a vertical sidebar of every section,
// no workspace switch), one scroll pane, and a pinned status bar.
test('control center is a sidebar shell with one scroll pane and a pinned status bar', () => {
  const markup = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const settings = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'setup/settings.js'), 'utf8');
  const tabs = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'ui', 'tabs.js'), 'utf8');
  const displayMode = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'display/mode.js'), 'utf8');
  assert.match(markup, /<aside class="setup-sidebar"/);
  assert.match(markup, /id="setup-tabs"[^>]*aria-orientation="vertical"/);
  for (const tab of ['channels', 'programming', 'library', 'display', 'guide', 'household', 'audio', 'plugins', 'help']) {
    assert.match(markup, new RegExp(`class="setup-tab-btn[^"]*" data-tab="${tab}"`), `sidebar lists ${tab}`);
  }
  assert.doesNotMatch(markup, /setup-workspace-switch|data-workspaces=/);
  // docs/design/03 §3 sections: the old STATUS tab is System › Diagnostics.
  assert.doesNotMatch(markup, /data-tab="perf"/);
  assert.match(markup, /data-tab-panel="audio"[\s\S]*?data-subtab-panel="status"[\s\S]*?id="box-status-check-btn"/);
  assert.match(markup, /data-tab-panel="household"[\s\S]*?id="pin-lock-enabled"[\s\S]*?id="viewer-enabled"/);
  assert.match(markup, /id="setup-content" class="setup-content"/);
  assert.match(markup, /class="setup-footer setup-status-bar"[\s\S]*?id="setup-undo-btn"[\s\S]*?id="done-btn"/);
  assert.match(markup, /data-subtab-panel="backups"[\s\S]*?id="config-export-btn"/);
  assert.doesNotMatch(settings, /applySetupWorkspace/);
  // Step 2: the lineup is a list beside the selected channel's editor.
  assert.match(markup, /id="channel-list-pane" class="channel-list-pane"[^>]*role="listbox"[\s\S]*?id="channel-list" class="channel-detail-pane"/);
  assert.match(tabs, /getAttribute\('aria-orientation'\) === 'vertical'/);
  // Steps 3-4: settings are SettingRows (label wired to its control) and one
  // search replaces the separate command palette overlay.
  const rowLabels = markup.match(/<label class="setting-row-label" for="[^"]+"/g) || [];
  assert.ok(rowLabels.length >= 60, `settings rows with wired labels: ${rowLabels.length}`);
  rowLabels.forEach((label) => {
    const id = label.match(/for="([^"]+)"/)[1];
    assert.match(markup, new RegExp(`id="${id}"`), `row label for ${id} has its control`);
  });
  assert.doesNotMatch(markup, /id="command-palette"/);
  assert.match(displayMode, /display-frame-control-center/);
  assert.match(displayMode, /setupVisible[\s\S]*?--display-frame-width[\s\S]*?availW/);
});

test('flagship era themes own guide motion while every theme keeps a core fallback', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'guide.css'), 'utf8');
  assert.match(guide, /--theme-guide-enter-x, 0px/);
  assert.match(guide, /--theme-guide-enter-ease, ease-in-out/);
  for (const id of ['wood-console-70s', 'uhf-public-access-80s', 'vhs-retro-80s', 'analog-90s', 'scrolling-guide-94', 'cable-box-osd', 'addressable-converter-89', 'dual-tuner-dvr-05', 'hotel-headend-92']) {
    const css = fs.readFileSync(path.join(ROOT, 'plugins', `theme-${id}`, 'style.css'), 'utf8');
    assert.match(css, /--theme-guide-enter-x:/, `${id} needs an era-specific guide entrance`);
    assert.match(css, /--theme-guide-enter-ease:/, `${id} needs an era-specific guide easing`);
  }
});

test('new cable-box themes include visual, guide, sound, caption, and era behavior', () => {
  for (const id of ['addressable-converter-89', 'dual-tuner-dvr-05', 'hotel-headend-92']) {
    const base = path.join(ROOT, 'plugins', `theme-${id}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(base, 'manifest.json'), 'utf8'));
    const renderer = fs.readFileSync(path.join(base, 'renderer.js'), 'utf8');
    const css = fs.readFileSync(path.join(base, 'style.css'), 'utf8');
    assert.equal(manifest.category, 'theme');
    assert.match(renderer, /group: 'REAL CABLE-BOX UI'/);
    assert.match(renderer, /guidePreviewDefault:/);
    assert.match(renderer, /captionStyle:/);
    assert.match(renderer, /channelChangeSfx\(\)/);
    assert.match(renderer, /powerSfx\(isOn\)/);
    assert.match(css, new RegExp(`html\\[data-theme="${id}"\\]`));
    assert.match(css, /--guide-row-height:/);
  }
  const motionCore = [
    fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'guide.css'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'overlays.css'), 'utf8'),
  ].join('\n');
  assert.match(motionCore, /prefers-reduced-motion[\s\S]*?guide-overlay[\s\S]*?animation: none/);
  assert.match(motionCore, /prefers-reduced-motion[\s\S]*?crt-power-fx-line[\s\S]*?animation: none/);
});
