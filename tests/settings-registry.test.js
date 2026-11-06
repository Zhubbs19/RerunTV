// The settings registry (renderer/js/core/settings-registry.js, docs/design/14 §3)
// against the setup screen and the rest of the app: every static row in
// index.html is a registry setting with the same label, help, range, choices,
// dependency and home, so the two can't drift apart; and the registry itself is
// well formed (unique ids, defaults where they are written, host-only paths on
// the LAN deny-list, TV entries in a TV section).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const load = () => import(pathToFileURL(path.join(root, 'renderer', 'js', 'core', 'settings-registry.js')).href);
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');

const decode = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#9654;/g, '▶').replace(/\s+/g, ' ').trim();

function blockEnd(start) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    depth += m[0] === '</div>' ? -1 : 1;
    if (depth === 0) return m.index + 6;
  }
  return html.length;
}

function lastBefore(re, at) {
  let hit = null;
  for (const m of html.matchAll(re)) { if (m.index < at) hit = m; else break; }
  return hit;
}

// Every static setting row inside a setup section.
function staticRows() {
  const rows = [];
  for (const m of html.matchAll(/<div class="setting-row[" ][^>]*data-setting="([^"]+)"[^>]*>/g)) {
    const tab = lastBefore(/data-tab-panel="([^"]+)"/g, m.index);
    if (!tab) continue;
    const sub = lastBefore(/data-subtab-panel="([^"]+)"/g, m.index);
    const block = html.slice(m.index, blockEnd(m.index));
    const label = /<(?:label|span) class="setting-row-label"[^>]*>([\s\S]*?)<\/(?:label|span)>/.exec(block);
    const help = /<p class="setting-row-help"([^>]*)>([\s\S]*?)<\/p>/.exec(block);
    const control = /<(input|select)\b([^>]*)>/.exec(block);
    const attr = (name) => (control ? (new RegExp(`\\b${name}="([^"]*)"`).exec(control[2]) || [])[1] : undefined);
    const options = control && control[1] === 'select' ? [...block.matchAll(/<option value="([^"]*)"/g)].map((o) => o[1]) : null;
    rows.push({
      id: m[1],
      home: `${tab[1]}/${sub && sub.index > tab.index ? sub[1] : ''}`,
      dependsOn: (/data-depends-on="([^"]+)"/.exec(m[0]) || [])[1] || '',
      label: decode(label && label[1]),
      // A help line with an id is a live status the app rewrites (network address, usage mode), not help.
      help: decode(help && help[2]),
      status: !!(help && /\bid=/.test(help[1])),
      type: control ? (control[1] === 'select' ? 'select' : attr('type')) : null,
      min: attr('min'), max: attr('max'), step: attr('step'),
      options,
    });
  }
  return rows;
}

test('every setup row is a registry setting, and they agree', async () => {
  const { settingById } = await load();
  const rows = staticRows();
  assert.ok(rows.length > 120, `found the rows (${rows.length})`);
  for (const row of rows) {
    const e = settingById(row.id);
    assert.ok(e, `${row.id} is in the registry`);
    assert.equal(row.label, e.label, `${row.id}: label`);
    if (!row.status) assert.equal(row.help, e.help || '', `${row.id}: help`);
    assert.equal(row.home, e.home, `${row.id}: lives where the registry says`);
    assert.equal(row.dependsOn, e.dependsOn || '', `${row.id}: depends on`);
    if (e.type === 'number' && e.range) {
      if (row.min !== undefined) assert.equal(Number(row.min), e.range.min, `${row.id}: min`);
      if (row.max !== undefined) assert.equal(Number(row.max), e.range.max, `${row.id}: max`);
      if (row.step !== undefined && row.step !== 'any') assert.equal(Number(row.step), e.range.step, `${row.id}: step`);
    }
    if (e.choices && row.options && row.options.length) {
      assert.deepEqual(row.options, e.choices.map(([v]) => String(v)), `${row.id}: choices`);
    }
  }
});

test('every registry setting with a home in index.html has its row there', async () => {
  const { SETTINGS } = await load();
  const ids = new Set(staticRows().map((r) => r.id));
  // Rows the app builds itself rather than index.html: fit to time slots and the
  // newer settings rendered from the registry.
  const built = SETTINGS.filter((e) => !ids.has(e.id)).map((e) => e.id);
  for (const id of built) {
    const e = SETTINGS.find((x) => x.id === id);
    assert.ok(e.fit || e.type === 'custom' || e.rendered, `${id} has no row: mark it fit/custom/rendered or add the row`);
  }
});

test('the registry is well formed', async () => {
  const { SETTINGS, SECTIONS, TV_SECTIONS, registryDefaults } = await load();
  const ids = SETTINGS.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  const homes = new Set();
  SECTIONS.forEach((s) => (s.pages || ['']).forEach((p) => homes.add(`${s.id}/${p}`)));
  homes.add('household/');
  for (const e of SETTINGS) {
    assert.ok(e.label, `${e.id}: label`);
    assert.ok(homes.has(e.home), `${e.id}: home ${e.home} is a section page`);
    assert.ok(['basic', 'advanced'].includes(e.level), `${e.id}: level`);
    if (e.type === 'choice') assert.ok(Array.isArray(e.choices) || e.dynamicChoices, `${e.id}: choices (or dynamicChoices for lists the app fills in)`);
    if (e.tv) assert.ok(TV_SECTIONS.some((s) => s.id === e.tv.section), `${e.id}: TV section ${e.tv.section}`);
    if (e.override) assert.ok(e.override.channel || e.override.block, `${e.id}: override says who`);
    if (e.default !== undefined && e.default !== null && e.choices) assert.ok(e.choices.some(([v]) => String(v) === String(e.default)), `${e.id}: default is a choice`);
    if (e.range && e.default != null && typeof e.default === 'number') {
      // The range is in shown units; the default is stored (shown × scale).
      const shown = e.default / (e.scale || 1);
      assert.ok(e.range.min === undefined || shown >= e.range.min - 1e-9, `${e.id}: default >= min`);
      assert.ok(e.range.max === undefined || shown <= e.range.max + 1e-9, `${e.id}: default <= max`);
    }
  }
  registryDefaults().forEach(([p, v]) => assert.ok(v !== undefined && v !== null, `${p.join('.')}: a written default has a value`));
});

test('host-only settings are on the LAN deny-list', async () => {
  const { hostOnlyPaths } = await load();
  const { REMOTE_DENIED_SETTINGS } = require(path.join(root, 'main', 'config', 'host.js'));
  for (const p of hostOnlyPaths()) assert.ok(REMOTE_DENIED_SETTINGS[p[0]], `${p.join('.')} is refused to remote clients`);
});

test('settingFor reads block, then channel, then box, then the default', async () => {
  const { settingFor, toOverride, settingById } = await load();
  const config = { commercials: { pauseForBreaks: false } };
  assert.equal(settingFor('commercials-pause-for-breaks', { config }), false, 'box');
  assert.equal(settingFor('commercials-pause-for-breaks', { config: {} }), true, 'default');
  assert.equal(settingFor('commercials-pause-for-breaks', { ch: { pauseForBreaks: 'on' }, config }), true, 'channel beats box');
  assert.equal(settingFor('commercials-pause-for-breaks', { ch: { pauseForBreaks: 'on' }, block: { pauseForBreaks: 'off' }, config }), false, 'block beats channel');
  assert.equal(toOverride(settingById('commercials-pause-for-breaks'), false), 'off');
  assert.equal(settingFor('commercials-interval', { ch: { adIntervalMinutes: 30 }, config }), 30);
  assert.equal(settingFor('program-fit-creditsRate', { ch: { programFit: { creditsRate: 2 } }, config: { programFit: { creditsRate: 4 } } }), 2);
});

test('every box setting is under a section settings.set accepts', async () => {
  const { SETTINGS } = await load();
  const { isSettingsSection } = await import(pathToFileURL(path.join(root, 'renderer', 'js', 'core', 'commands.js')).href);
  for (const e of SETTINGS) {
    if (!e.path || e.fit || e.scope === 'device' || e.store) continue;
    assert.ok(isSettingsSection(e.path[0]), `${e.id}: settings.set rejects "${e.path[0]}"; add it to SETTING_LABELS in core/commands.js`);
  }
});

test('page labels match the setup screen, and host-only sections match the LAN deny-list', async () => {
  const { PAGE_LABELS, SECTIONS, HOST_ONLY_SECTIONS } = await load();
  const buttons = new Map([...html.matchAll(/data-subtab="([a-z]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], decode(m[2])]));
  for (const section of SECTIONS) {
    for (const page of section.pages || []) {
      assert.ok(PAGE_LABELS[page], `${page} has no PAGE_LABELS entry`);
      assert.equal(PAGE_LABELS[page].toUpperCase(), buttons.get(page), `${page}'s label differs from its sub-tab button`);
    }
  }
  const { REMOTE_DENIED_SETTINGS } = require('../main/config/host');
  assert.deepEqual([...HOST_ONLY_SECTIONS].sort(), Object.keys(REMOTE_DENIED_SETTINGS).sort());
});

test('the companion catalogue holds only remote-editable settings, and values are checked', async () => {
  const { remoteSettingsCatalogue, settingById, coerceSettingValue, HOST_ONLY_SECTIONS } = await load();
  const cat = remoteSettingsCatalogue();
  assert.equal(cat.version, 1);
  assert.ok(cat.settings.length > 80, `${cat.settings.length} settings`);
  for (const e of cat.settings) {
    assert.ok(!HOST_ONLY_SECTIONS.includes(e.path[0]), `${e.id} is host-only`);
    assert.ok(['switch', 'choice', 'number', 'text'].includes(e.type), `${e.id} is ${e.type}`);
    assert.ok(cat.sections.some((s) => s.id === e.home.split('/')[0]) || !e.home, `${e.id} has an unknown home ${e.home}`);
  }
  assert.ok(!cat.settings.some((e) => e.id === 'pin-relock-minutes'), 'PIN relock stays on the box');
  assert.ok(cat.settings.some((e) => e.id === 'commercials-pause-for-breaks'));
  assert.equal(cat.settings.find((e) => e.id === 'guide-theme').choicesFrom, 'themes');

  const vol = settingById('content-volume');
  assert.deepEqual(coerceSettingValue(vol, 0.5), { ok: true, value: 0.5 });
  assert.deepEqual(coerceSettingValue(vol, 7), { ok: true, value: 1 }, 'clamped in shown units (100%)');
  assert.equal(coerceSettingValue(vol, 'loud').ok, false);
  assert.deepEqual(coerceSettingValue(vol, null), { ok: true, value: undefined }, 'null resets to the default');
  assert.equal(coerceSettingValue(settingById('commercials-pause-for-breaks'), 'yes').ok, false);
  assert.deepEqual(coerceSettingValue(settingById('commercials-skip-breaks'), 'never'), { ok: true, value: 'never' });
  assert.equal(coerceSettingValue(settingById('commercials-skip-breaks'), 'sometimes').ok, false);
  assert.deepEqual(coerceSettingValue(settingById('startup-channel'), '7'), { ok: true, value: 7 });
  assert.equal(coerceSettingValue(settingById('guide-theme'), '../evil').ok, false);
});
