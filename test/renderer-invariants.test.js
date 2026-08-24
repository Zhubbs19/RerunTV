const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

async function loadRendererModules() {
  let now = 1_700_000_000_000;
  class ControlledDate extends Date {
    static now() { return now; }
  }
  const context = vm.createContext({
    console, Date: ControlledDate, setTimeout, clearTimeout, setInterval, clearInterval,
    window: { matchMedia: () => ({ matches: false }), api: { saveConfig: () => Promise.resolve(true) } },
    document: { getElementById: () => null, querySelector: () => null },
  });
  const cache = new Map();
  async function load(file) {
    const absolute = path.resolve(file);
    if (cache.has(absolute)) return cache.get(absolute);
    const mod = new vm.SourceTextModule(fs.readFileSync(absolute, 'utf8'), { context, identifier: absolute });
    cache.set(absolute, mod);
    await mod.link((specifier, parent) => load(path.resolve(path.dirname(parent.identifier), specifier)));
    return mod;
  }
  const state = await load(path.join(ROOT, 'renderer', 'js', 'state.js'));
  const schedule = await load(path.join(ROOT, 'renderer', 'js', 'schedule.js'));
  const interstitials = await load(path.join(ROOT, 'renderer', 'js', 'interstitials.js'));
  const pluginSettingsSchema = await load(path.join(ROOT, 'renderer', 'js', 'plugin-settings-schema.js'));
  const libraryRelink = await load(path.join(ROOT, 'renderer', 'js', 'library-relink.js'));
  const channelPackage = await load(path.join(ROOT, 'renderer', 'js', 'channel-package.js'));
  const playbackOrder = await load(path.join(ROOT, 'renderer', 'js', 'playback-order.js'));
  const programSearch = await load(path.join(ROOT, 'renderer', 'js', 'program-search.js'));
  const broadcastIdentity = await load(path.join(ROOT, 'renderer', 'js', 'broadcast-identity.js'));
  const librarySyncCore = await load(path.join(ROOT, 'renderer', 'js', 'library-sync-core.js'));
  await state.evaluate();
  await schedule.evaluate();
  await interstitials.evaluate();
  await pluginSettingsSchema.evaluate();
  await libraryRelink.evaluate();
  await channelPackage.evaluate();
  await playbackOrder.evaluate();
  await programSearch.evaluate();
  await broadcastIdentity.evaluate();
  await librarySyncCore.evaluate();
  return { state: state.namespace, schedule: schedule.namespace, interstitials: interstitials.namespace, pluginSettingsSchema: pluginSettingsSchema.namespace, libraryRelink: libraryRelink.namespace, channelPackage: channelPackage.namespace, playbackOrder: playbackOrder.namespace, programSearch: programSearch.namespace, broadcastIdentity: broadcastIdentity.namespace, librarySyncCore: librarySyncCore.namespace, setNow: (value) => { now = value; } };
}

test('library sync preserves metadata on unambiguous renames and keeps missing titles by default', async () => {
  const { librarySyncCore } = await loadRendererModules();
  const old = { path: 'D:/TV/Show S01E01.mkv', duration: 1200, folder: 'folder-1', source: 'local', title: 'Pilot', tags: ['favorite'] };
  const missing = { path: 'D:/TV/Missing.mkv', duration: 900, folder: 'folder-1', source: 'local', title: 'Keep me' };
  const unrelated = { path: 'D:/Other/Clip.mp4', duration: 30, folder: null, source: 'local' };
  const result = librarySyncCore.reconcileFolderFiles([old, missing, unrelated], [
    { path: 'D:/TV/Show - 01 - Pilot.mkv', duration: 1201, source: 'local' },
    { path: 'D:/TV/New Episode.mkv', duration: 1800, source: 'local' },
  ], 'folder-1', false);
  assert.equal(result.renames.length, 1);
  assert.equal(result.files.find((file) => file.path.includes('Pilot.mkv')).title, 'Pilot');
  assert.deepEqual(result.files.find((file) => file.path.includes('Pilot.mkv')).tags, ['favorite']);
  assert.ok(result.files.includes(missing));
  assert.ok(result.files.includes(unrelated));
  assert.equal(result.added.length, 1);
  assert.equal(result.missing.length, 1);
});

test('per-channel identity inherits the box theme unless explicitly overridden', async () => {
  const { broadcastIdentity } = await loadRendererModules();
  const config = { theme: 'box-theme', channels: [{ number: 3, broadcastIdentity: { theme: 'channel-theme' } }, { number: 4 }] };
  assert.equal(broadcastIdentity.effectiveThemeId(config, 3), 'channel-theme');
  assert.equal(broadcastIdentity.effectiveThemeId(config, 4), 'box-theme');
  assert.equal(broadcastIdentity.effectiveThemeId(config, 3, true), 'box-theme');
});

test('guide program search finds titles across channels in chronological order', async () => {
  const { programSearch } = await loadRendererModules();
  const from = 1_700_000_000_000;
  const channels = [
    { number: 9, anchor: from, blocks: [], files: [{ path: 'late.mkv', title: 'Space Special', duration: 120 }] },
    { number: 2, anchor: from - 60_000, blocks: [], files: [{ path: 'early.mkv', title: 'Space Patrol', duration: 120 }] },
  ];
  const results = programSearch.searchUpcomingPrograms(channels, 'space', from, { horizonMs: 180000, limit: 10 });
  assert.ok(results.length >= 2);
  assert.ok(results.every((result) => result.title.toLowerCase().includes('space')));
  assert.ok(results[0].entry.start <= results[1].entry.start);
});

test('playback-order tools sort episodes naturally and shuffle reproducibly', async () => {
  const { playbackOrder } = await loadRendererModules();
  const files = [
    { path: 'Show S1E10.mkv', duration: 10, folder: 'b' },
    { path: 'Show S1E2.mkv', duration: 10, folder: 'a' },
    { path: 'Show S1E1.mkv', duration: 10, folder: 'a' },
  ];
  assert.equal(playbackOrder.naturalFileOrder(files)[0].path, 'Show S1E1.mkv');
  assert.equal(playbackOrder.folderFileOrder(files, [{ id: 'a' }, { id: 'b' }])[2].folder, 'b');
  assert.equal(playbackOrder.seededFileOrder(files, 'same')[0].path, playbackOrder.seededFileOrder(files, 'same')[0].path);
  assert.equal(playbackOrder.fileAtOrder(files, 1000, 12_000).path, 'Show S1E2.mkv');
});

test('channel packages merge one channel and remap conflicts without replacing box settings', async () => {
  const { channelPackage } = await loadRendererModules();
  const sourceChannel = { number: 5, name: 'FIVE', folders: [], files: [{ path: 'show', tags: ['kids'] }], blocks: [{ id: 'block-a', files: [], trigger: {} }] };
  const source = { interstitials: {
    flows: [{ id: 'flow-a', channels: [5], steps: [] }],
    presets: [{ id: 'preset-a', contentTags: ['kids'] }],
    pool: [{ id: 'pool-a', type: 'promo', channelAffinity: 5, blockAffinity: 'block-a' }],
  } };
  const pkg = channelPackage.buildChannelPackage(source, sourceChannel);
  const target = {
    theme: 'untouched', channels: [{ number: 9, blocks: [{ id: 'block-a' }] }],
    interstitials: { flows: [{ id: 'flow-a' }], presets: [], pool: [] },
  };
  let seq = 0;
  const result = channelPackage.mergeChannelPackage(target, pkg, { targetNumber: 12, makeId: () => `new-${++seq}` });
  assert.equal(target.theme, 'untouched');
  assert.equal(result.channel.number, 12);
  assert.notEqual(result.channel.blocks[0].id, 'block-a');
  assert.equal(target.interstitials.flows[1].channels[0], 12);
  assert.equal(target.interstitials.pool[0].channelAffinity, 12);
  assert.equal(target.interstitials.pool[0].blockAffinity, result.channel.blocks[0].id);
});

test('library relink preserves relative paths and migrates shared folder references', async () => {
  const { libraryRelink } = await loadRendererModules();
  assert.equal(libraryRelink.replaceLocalRoot('D:\\Media\\TV\\Show\\one.mkv', 'D:\\Media\\TV', 'E:\\Library\\TV'), 'E:\\Library\\TV\\Show\\one.mkv');
  assert.equal(libraryRelink.replaceLocalRoot('D:\\Other\\one.mkv', 'D:\\Media\\TV', 'E:\\Library\\TV'), null);
  const config = {
    channels: [
      { folders: [{ id: 'old', source: 'local', ref: 'D:\\Media\\TV' }], files: [{ path: 'D:\\Media\\TV\\Show\\one.mkv', folder: 'old', source: 'local' }] },
      { folders: [], files: [{ path: 'D:\\Media\\TV\\Show\\two.mkv', folder: 'old', source: 'local' }] },
    ],
  };
  const result = libraryRelink.applyLocalFolderRelink(config, { oldId: 'old', oldRoot: 'D:\\Media\\TV', newId: 'new', newRoot: 'E:\\Library\\TV' });
  assert.equal(result.folderEntries, 1);
  assert.equal(result.fileReferences, 2);
  assert.equal(config.channels[0].folders[0].ref, 'E:\\Library\\TV');
  assert.equal(config.channels[1].files[0].path, 'E:\\Library\\TV\\Show\\two.mkv');
  assert.equal(config.channels[1].files[0].folder, 'new');
});

test('viewNow applies the time-machine offset to the only schedule clock', async () => {
  const { state, setNow } = await loadRendererModules();
  setNow(5_000);
  state.S.timeOffsetMs = 12_345;
  assert.equal(state.viewNow(), 17_345);
});

test('schedule position wraps in both directions without losing the live-TV anchor', async () => {
  const { schedule, state } = await loadRendererModules();
  state.S.contentLostMs = 0;
  const source = { anchor: 10_000, files: [{ path: 'a', duration: 10 }, { path: 'b', duration: 20 }] };
  assert.equal(schedule.computeSourcePosition(source, 25_000).file.path, 'b');
  assert.equal(schedule.computeSourcePosition(source, 25_000).offset, 5);
  assert.equal(schedule.computeSourcePosition(source, 5_000).file.path, 'b');
  assert.equal(schedule.computeSourcePosition(source, 5_000).offset, 15);
});

test('daily date blocks honor priority, unlock time, and per-day overrides', async () => {
  const { schedule } = await loadRendererModules();
  const first = { path: 'day-one', duration: 3600 };
  const second = { path: 'day-two', duration: 3600 };
  const block = {
    id: 'holiday', priority: 5, mode: 'daily', files: [first, second],
    trigger: { type: 'dateRange', startMonth: 12, startDay: 1, endMonth: 12, endDay: 3 },
    dayOverrides: { '12-02': { unlockTime: '09:30', title: 'SPECIAL TITLE' } },
  };
  const ch = { files: [{ path: 'default', duration: 3600 }], anchor: new Date(2026, 0, 1).getTime(), blocks: [block] };
  const beforeUnlock = schedule.resolveActiveSource(ch, new Date(2026, 11, 2, 8, 0).getTime());
  const afterUnlock = schedule.resolveActiveSource(ch, new Date(2026, 11, 2, 10, 0).getTime());
  assert.equal(beforeUnlock.files[0].path, 'day-one');
  assert.equal(afterUnlock.files[0].path, 'day-two');
  assert.equal(afterUnlock.files[0].title, 'SPECIAL TITLE');
  assert.equal(afterUnlock.anchor, new Date(2026, 11, 2, 9, 30).getTime());
});

test('interstitial selection is deterministic for the same channel and boundary', async () => {
  const { interstitials, state } = await loadRendererModules();
  const anchor = 1_700_000_000_000;
  const ch = {
    number: 7, anchor, blocks: [], adsEnabled: true,
    files: [{ path: 'show', duration: 1800, tags: ['cartoon'] }],
    commercials: { enabled: true, timing: 'interval', intervalMinutes: 10, podMin: 1, podMax: 1 },
  };
  state.S.config = {
    commercials: { intervalMinutes: 10 }, stationId: { enabled: false }, trivia: { enabled: false },
    interstitials: { flows: [], presets: [], pool: [
      { id: 'ad-a', type: 'commercial', channelAffinity: 'any', blockAffinity: null, contentTags: [], weight: 1, file: { path: 'ad-a.mp4', duration: 15 } },
      { id: 'ad-b', type: 'commercial', channelAffinity: 'any', blockAffinity: null, contentTags: [], weight: 1, file: { path: 'ad-b.mp4', duration: 15 } },
    ] },
  };
  state.bumpConfigGeneration();
  const at = anchor + 10 * 60000 + 1000;
  const one = interstitials.resolveBreakAt(ch, at);
  const two = interstitials.resolveBreakAt(ch, at);
  assert.equal(one.type, 'commercial');
  assert.equal(one.entry.id, two.entry.id);
  assert.equal(one.windowStart, anchor + 10 * 60000);
});

test('plugin settings schemas migrate, fill defaults, validate, and redact sensitive paths', async () => {
  const { pluginSettingsSchema: schemaApi } = await loadRendererModules();
  const schema = schemaApi.normalizePluginSettingsSchema('sample', {
    schemaVersion: 2,
    defaults: { enabled: false, nested: { label: 'default' } },
    sensitivePaths: ['auth.token'],
    migrations: { 1: (settings) => ({ ...settings, enabled: !!settings.active }) },
    validate: (settings) => typeof settings.enabled === 'boolean' || 'enabled must be boolean',
  });
  const applied = schemaApi.applyPluginSettingsSchema('sample', { active: 1, auth: { token: 'secret' } }, 1, schema);
  assert.equal(applied.version, 2);
  assert.equal(applied.settings.enabled, true);
  assert.equal(applied.settings.nested.label, 'default');
  assert.equal(schemaApi.redactPluginSettings(applied.settings, schema).auth.token, '[REDACTED]');
  assert.throws(() => schemaApi.validatePluginSettings('sample', { enabled: 'yes' }, schema), /enabled must be boolean/);
});

test('config generation invalidates resolveActiveCommercials memoization', async () => {
  const { state, schedule } = await loadRendererModules();
  const channel = { number: 7, blocks: [] };
  state.S.config = { interstitials: { flows: [{ id: 'old', channels: [7], steps: [] }] }, commercials: {} };
  state.bumpConfigGeneration();
  assert.equal(schedule.resolveActiveCommercials(channel, 123).key, 'flow:old');
  state.S.config.interstitials.flows[0].id = 'new';
  assert.equal(schedule.resolveActiveCommercials(channel, 123).key, 'flow:old');
  state.bumpConfigGeneration();
  assert.equal(schedule.resolveActiveCommercials(channel, 123).key, 'flow:new');
});
