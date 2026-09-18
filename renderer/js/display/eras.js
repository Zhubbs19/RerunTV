// Eras as a presentation layer (docs/design/10, contract C7). An era is
// data, never CSS: it names a theme pack that already exists and a handful
// of box-wide presentation values to set alongside it. Applying/clearing an
// era mutate `config.era`, a small record of which config paths it touched,
// their values immediately before the era was applied, and which of those
// paths the person has since changed by hand — clearing restores everything
// EXCEPT hand-changed ("overridden") paths, so a plain apply-then-clear with
// no edits in between is a no-op (docs/design/10 §8's acceptance test).
//
// v1 scope: theme, the CRT look, display-mode resolution/aspect/uiExtent,
// and the 24-hour clock — the box-wide settings with a single existing
// config path each. Per-channel "follow/pin era", plugin era hints (Music
// Choice's ERA dial, ticker/EAS style) and template/pool suggestions (05 in
// the doc's own phase list) are deliberately not built yet; nothing here
// blocks adding them later the same way.

export const ERA_FIELDS = [
  { key: 'theme', path: ['theme'], label: 'Theme' },
  { key: 'crtEnabled', path: ['crtEnabled'], label: 'CRT effect' },
  { key: 'crtScanlines', path: ['crtIntensity', 'scanlines'], label: 'CRT scanlines' },
  { key: 'crtCurvature', path: ['crtIntensity', 'curvature'], label: 'CRT curvature' },
  { key: 'crtGrain', path: ['crtIntensity', 'grain'], label: 'CRT grain' },
  { key: 'resolution', path: ['displayMode', 'resolution'], label: 'Resolution' },
  { key: 'aspect', path: ['displayMode', 'aspect'], label: 'Screen shape' },
  { key: 'uiExtent', path: ['displayMode', 'uiExtent'], label: 'On-screen cards' },
  { key: 'clock24', path: ['display', 'clock24'], label: '24-hour clock' },
];
const FIELDS_BY_KEY = new Map(ERA_FIELDS.map((f) => [f.key, f]));

export const BUILT_IN_ERAS = [
  {
    id: '1970s', label: '1970s — Wood console', range: [1970, 1979],
    presentation: {
      theme: 'wood-console-70s', crtEnabled: true, crtScanlines: 85, crtCurvature: 60, crtGrain: 70,
      resolution: 'sd240', aspect: '4:3', uiExtent: 'confined', clock24: false,
    },
    notes: ['A handful of channels, no remote guide data — over-the-air reception is the whole model, so the picture is soft and round-cornered.'],
  },
  {
    id: '1980s', label: '1980s — VHS and UHF', range: [1980, 1989],
    presentation: {
      theme: 'vhs-retro-80s', crtEnabled: true, crtScanlines: 80, crtCurvature: 55, crtGrain: 60,
      resolution: 'sd240', aspect: '4:3', uiExtent: 'confined', clock24: false,
    },
    notes: ['Cable is new and UHF stations still fight for a clean signal — tracking noise and soft edges are part of the picture, not a fault.'],
  },
  {
    id: '1994', label: '1994 — Analog cable', range: [1992, 1996],
    presentation: {
      theme: 'prevue-guide-94', crtEnabled: true, crtScanlines: 70, crtCurvature: 45, crtGrain: 55,
      resolution: 'sd480', aspect: '4:3', uiExtent: 'confined', clock24: false,
    },
    notes: ['The TV Parental Guidelines content-rating system did not exist yet — it began in January 1997, so no rating bug is period-accurate here even though this box does not yet suppress it automatically.'],
  },
  {
    id: '2000s', label: '2000s — Digital satellite', range: [2000, 2009],
    presentation: {
      theme: 'digital-satellite-2000s', crtEnabled: true, crtScanlines: 35, crtCurvature: 20, crtGrain: 25,
      resolution: 'sd480', aspect: '4:3', uiExtent: 'confined', clock24: false,
    },
    notes: ['Digital tuners and on-screen guides are standard, but CRT sets and 4:3 sets still outnumber flat, widescreen ones through most of the decade.'],
  },
  {
    id: '2016', label: '2016 — Flat and digital', range: [2010, 2020],
    presentation: {
      theme: 'cloud-guide-16', crtEnabled: false, crtScanlines: 0, crtCurvature: 0, crtGrain: 0,
      resolution: 'native', aspect: '16:9', uiExtent: 'fullscreen', clock24: true,
    },
    notes: ['Flat-panel, widescreen and sharp — the CRT look is switched off entirely rather than just dialed down.'],
  },
];
const BUILT_IN_BY_ID = new Map(BUILT_IN_ERAS.map((e) => [e.id, e]));
const pluginEras = new Map();

// docs/design/10 §3: "plugins may register eras". Kept minimal for v1 — no
// ctx surface calls this yet, but the registry exists so one can be added
// without another migration of this file.
export function registerEra(era) {
  if (!era || typeof era.id !== 'string' || !era.id) throw new Error('registerEra: id is required');
  if (!era.presentation || typeof era.presentation !== 'object') throw new Error(`registerEra("${era.id}"): presentation is required`);
  pluginEras.set(era.id, era);
}

export function listEras() { return [...BUILT_IN_ERAS, ...pluginEras.values()]; }
export function getEra(id) { return BUILT_IN_BY_ID.get(id) || pluginEras.get(id) || null; }

function readPath(root, path) {
  let node = root;
  for (const key of path) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

function writePath(root, path, value) {
  let node = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (typeof node[key] !== 'object' || node[key] == null) node[key] = {};
    node = node[key];
  }
  node[path[path.length - 1]] = value;
}

// Mutates `config` in place; caller records it (commitConfigPatch, one undo
// step) same as curation/library sync do for other whole-config transforms.
export function applyEra(config, eraId) {
  const era = getEra(eraId);
  if (!era) throw new Error(`Unknown era "${eraId}".`);
  const previousValues = {};
  const fields = [];
  ERA_FIELDS.forEach(({ key, path }) => {
    if (!Object.prototype.hasOwnProperty.call(era.presentation, key)) return;
    previousValues[key] = readPath(config, path);
    writePath(config, path, era.presentation[key]);
    fields.push(key);
  });
  config.era = { id: era.id, appliedAt: Date.now(), fields, previousValues, overrides: [] };
  return config.era;
}

// Restores every field the era touched to its pre-era value, except fields
// the person has since hand-changed (an "override" — see noteEraOverride),
// which are left exactly as they are. Applying then immediately clearing,
// with no edits in between, leaves config byte-for-byte where it started.
export function clearEra(config) {
  const state = config.era;
  if (!state) return;
  const overrides = new Set(state.overrides || []);
  ERA_FIELDS.forEach(({ key, path }) => {
    if (!Object.prototype.hasOwnProperty.call(state.previousValues, key) || overrides.has(key)) return;
    const previous = state.previousValues[key];
    if (previous === undefined) return;
    writePath(config, path, previous);
  });
  delete config.era;
}

// Called from the settings.set command (core/commands.js) whenever a config
// path changes while an era is active. If that path is one of the era's own
// fields, hand-setting it back to the era's own value un-overrides it (the
// person just re-agreed with the era); any other value marks it a box-level
// exception that clearEra will leave alone.
export function noteEraOverride(config, path) {
  if (!config.era) return;
  const field = ERA_FIELDS.find((f) => f.path.length === path.length && f.path.every((seg, i) => seg === path[i]));
  if (!field || !config.era.fields.includes(field.key)) return;
  const era = getEra(config.era.id);
  const eraValue = era ? era.presentation[field.key] : undefined;
  const currentValue = readPath(config, path);
  const overrides = new Set(config.era.overrides || []);
  if (currentValue === eraValue) overrides.delete(field.key); else overrides.add(field.key);
  config.era.overrides = [...overrides];
}

// Re-applies just one field's era value and clears its override flag,
// without touching config.era.previousValues or any other field's override
// state — used by the "reset to era" action per field in the ERA panel.
// Re-running applyEra() wholesale would be wrong here: it would re-snapshot
// every field's "previous value" from its current (possibly overridden)
// state, corrupting what clearEra() should restore for untouched fields.
export function resetEraField(config, key) {
  const state = config.era;
  if (!state || !state.fields.includes(key)) return;
  const era = getEra(state.id);
  const field = FIELDS_BY_KEY.get(key);
  if (!era || !field || !Object.prototype.hasOwnProperty.call(era.presentation, key)) return;
  writePath(config, field.path, era.presentation[key]);
  const overrides = new Set(state.overrides || []);
  overrides.delete(key);
  state.overrides = [...overrides];
}

// 'era' (following, showing the era's value), 'override' (era active, this
// field was hand-changed away from it) or null (no era active / not an era
// field) — what the setup screen shows next to each affected setting.
export function eraFieldSource(config, key) {
  if (!config || !config.era || !config.era.fields.includes(key)) return null;
  return (config.era.overrides || []).includes(key) ? 'override' : 'era';
}

export function eraFieldLabel(key) { return (FIELDS_BY_KEY.get(key) || {}).label || key; }
