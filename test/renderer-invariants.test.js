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
    console, Date: ControlledDate, setTimeout, clearTimeout,
    window: { matchMedia: () => ({ matches: false }), api: { saveConfig: () => Promise.resolve(true) } },
    document: { getElementById: () => null },
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
  const pluginSettingsSchema = await load(path.join(ROOT, 'renderer', 'js', 'plugin-settings-schema.js'));
  await state.evaluate();
  await schedule.evaluate();
  await pluginSettingsSchema.evaluate();
  return { state: state.namespace, schedule: schedule.namespace, pluginSettingsSchema: pluginSettingsSchema.namespace, setNow: (value) => { now = value; } };
}

test('viewNow applies the time-machine offset to the only schedule clock', async () => {
  const { state, setNow } = await loadRendererModules();
  setNow(5_000);
  state.S.timeOffsetMs = 12_345;
  assert.equal(state.viewNow(), 17_345);
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
