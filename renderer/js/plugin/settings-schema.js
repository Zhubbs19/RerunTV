// Pure helpers for the optional declarative contract registered alongside a
// plugin's custom settings sections. Kept separate from plugins.js so schema
// evolution, validation, and redaction can be tested without booting the
// renderer/plugin loader.

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function mergeDefaults(settings, defaults) {
  const result = isPlainObject(settings) ? clone(settings) : {};
  if (!isPlainObject(defaults)) return result;
  Object.entries(defaults).forEach(([key, fallback]) => {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      result[key] = clone(fallback);
    } else if (isPlainObject(result[key]) && isPlainObject(fallback)) {
      result[key] = mergeDefaults(result[key], fallback);
    }
  });
  return result;
}

function validationMessage(result) {
  if (result == null || result === true) return '';
  if (result === false) return 'settings failed validation';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.filter(Boolean).join('; ');
  if (isPlainObject(result) && result.valid === false) return result.message || 'settings failed validation';
  return '';
}

export function normalizePluginSettingsSchema(pluginId, definition) {
  const hasSchema = definition && ['schemaVersion', 'defaults', 'validate', 'sensitivePaths', 'migrations']
    .some((key) => Object.prototype.hasOwnProperty.call(definition, key));
  if (!hasSchema) return null;
  // schemaVersion is only meaningful for the parts of this contract that
  // actually version something (defaults get merged forward, migrations run
  // between versions). A plugin that only wants sensitivePaths redaction
  // and/or a validate() hook — no defaults, no migrations — shouldn't have
  // to adopt a whole versioning scheme just to unlock those; default to v1
  // instead of forcing an explicit schemaVersion in that case.
  const needsExplicitVersion = definition.defaults != null
    || (definition.migrations != null && Object.keys(definition.migrations).length > 0);
  let { schemaVersion } = definition;
  if (schemaVersion == null && !needsExplicitVersion) {
    schemaVersion = 1;
  } else if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`registerPluginSettings("${pluginId}"): schemaVersion must be a positive integer`);
  }
  if (definition.defaults != null && !isPlainObject(definition.defaults)) {
    throw new Error(`registerPluginSettings("${pluginId}"): defaults must be an object`);
  }
  if (definition.validate != null && typeof definition.validate !== 'function') {
    throw new Error(`registerPluginSettings("${pluginId}"): validate must be a function`);
  }
  const sensitivePaths = definition.sensitivePaths || [];
  if (!Array.isArray(sensitivePaths) || sensitivePaths.some((path) => typeof path !== 'string' || !path.trim())) {
    throw new Error(`registerPluginSettings("${pluginId}"): sensitivePaths must be an array of dotted paths`);
  }
  const migrations = definition.migrations || {};
  if (!isPlainObject(migrations) || Object.entries(migrations).some(([version, migrate]) => !/^\d+$/.test(version) || typeof migrate !== 'function')) {
    throw new Error(`registerPluginSettings("${pluginId}"): migrations must map source versions to functions`);
  }
  return {
    schemaVersion,
    defaults: clone(definition.defaults || {}),
    validate: definition.validate || null,
    sensitivePaths: [...new Set(sensitivePaths.map((path) => path.trim()))],
    migrations: { ...migrations },
  };
}

export function applyPluginSettingsSchema(pluginId, settings, storedVersion, schema) {
  if (!schema) return { settings: isPlainObject(settings) ? settings : {}, version: 0, changed: false };
  let version = Number.isInteger(storedVersion) && storedVersion >= 0 ? storedVersion : 0;
  if (version > schema.schemaVersion) {
    throw new Error(`${pluginId} settings are from schema v${version}, newer than supported v${schema.schemaVersion}`);
  }
  let next = isPlainObject(settings) ? clone(settings) : {};
  const before = JSON.stringify(next);
  while (version < schema.schemaVersion) {
    const migrate = schema.migrations[version];
    if (migrate) {
      const migrated = migrate(clone(next), { pluginId, fromVersion: version, toVersion: version + 1 });
      if (!isPlainObject(migrated)) {
        throw new Error(`${pluginId} settings migration v${version}→v${version + 1} must return an object`);
      }
      next = migrated;
    }
    version++;
  }
  next = mergeDefaults(next, schema.defaults);
  validatePluginSettings(pluginId, next, schema);
  return { settings: next, version, changed: before !== JSON.stringify(next) || storedVersion !== version };
}

export function validatePluginSettings(pluginId, settings, schema) {
  if (!isPlainObject(settings)) throw new Error(`${pluginId} settings must be an object`);
  if (!schema || !schema.validate) return;
  const message = validationMessage(schema.validate(clone(settings), { pluginId, schemaVersion: schema.schemaVersion }));
  if (message) throw new Error(`${pluginId} settings are invalid: ${message}`);
}

export function redactPluginSettings(settings, schema, replacement = '[REDACTED]') {
  const redacted = clone(isPlainObject(settings) ? settings : {});
  if (!schema) return redacted;
  schema.sensitivePaths.forEach((path) => {
    const parts = path.split('.').filter(Boolean);
    let parent = redacted;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isPlainObject(parent[parts[i]])) return;
      parent = parent[parts[i]];
    }
    const key = parts[parts.length - 1];
    if (key && Object.prototype.hasOwnProperty.call(parent, key)) parent[key] = replacement;
  });
  return redacted;
}

// ---------- Declarative fields (docs/design/04 §5) ----------
// A settings section can list `fields` instead of drawing itself with
// render(): core builds each one from the component kit (SettingRow plus a
// Toggle/Slider/NumberStepper/Select/text/colour control), so it gets TV
// density, D-pad focus, setup search entries and inline validation errors
// without plugin code.
//   { key: 'crawl.speed', type: 'slider', label: 'Crawl speed', help: '…',
//     min: 1, max: 10, step: 1, unit: 'x', dependsOn: 'enabled', synonyms: 'scroll pace' }
const FIELD_TYPES = new Set(['toggle', 'slider', 'number', 'select', 'text', 'color']);

export function normalizeSettingsFields(pluginId, sectionId, fields) {
  const where = `registerPluginSettings("${pluginId}", "${sectionId}")`;
  if (!Array.isArray(fields) || !fields.length) throw new Error(`${where}: fields must be a non-empty array`);
  const seen = new Set();
  return fields.map((field, index) => {
    if (!isPlainObject(field)) throw new Error(`${where}: field ${index} must be an object`);
    const key = typeof field.key === 'string' ? field.key.trim() : '';
    if (!key || !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(key)) throw new Error(`${where}: field ${index} needs a dotted key like "crawl.speed"`);
    if (seen.has(key)) throw new Error(`${where}: duplicate field key "${key}"`);
    seen.add(key);
    if (!FIELD_TYPES.has(field.type)) throw new Error(`${where}: field "${key}" type must be one of ${[...FIELD_TYPES].join(', ')}`);
    if (typeof field.label !== 'string' || !field.label.trim()) throw new Error(`${where}: field "${key}" needs a label`);
    const out = {
      key,
      type: field.type,
      label: field.label.trim(),
      help: typeof field.help === 'string' ? field.help : '',
      synonyms: typeof field.synonyms === 'string' ? field.synonyms : '',
      dependsOn: typeof field.dependsOn === 'string' ? field.dependsOn : '',
    };
    if (field.type === 'slider' || field.type === 'number') {
      const min = Number(field.min);
      const max = Number(field.max);
      const step = field.step == null ? 1 : Number(field.step);
      if (field.type === 'slider' && (!Number.isFinite(min) || !Number.isFinite(max) || max <= min)) throw new Error(`${where}: slider "${key}" needs min < max`);
      if (!(step > 0)) throw new Error(`${where}: field "${key}" step must be positive`);
      Object.assign(out, { min: Number.isFinite(min) ? min : -Infinity, max: Number.isFinite(max) ? max : Infinity, step, unit: typeof field.unit === 'string' ? field.unit : '' });
    }
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || !field.options.length) throw new Error(`${where}: select "${key}" needs options`);
      out.options = field.options.map((opt) => (isPlainObject(opt) ? { value: opt.value, label: String(opt.label ?? opt.value) } : { value: opt, label: String(opt) }));
    }
    if (field.type === 'text') out.placeholder = typeof field.placeholder === 'string' ? field.placeholder : '';
    return out;
  });
}

export function readSettingPath(settings, path) {
  return path.split('.').reduce((node, part) => (isPlainObject(node) ? node[part] : undefined), settings);
}

// The top-level patch updatePluginSettings(id, patch) needs to set one dotted
// path, leaving everything else in that branch as it was.
const UNSAFE_PATH_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

export function settingPathPatch(settings, path, value) {
  const parts = path.split('.');
  // A plugin-supplied path must never walk or assign through prototype-chain keys.
  if (parts.some((part) => UNSAFE_PATH_PARTS.has(part))) return {};
  const top = parts[0];
  if (parts.length === 1) return { [top]: value };
  const branch = isPlainObject(settings && settings[top]) ? clone(settings[top]) : {};
  let node = branch;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return {};
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key];
  }
  const last = parts[parts.length - 1];
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') return {};
  node[last] = value;
  return { [top]: branch };
}

// A field's value as a control shows it, and back again for saving.
export function coerceFieldValue(field, raw) {
  if (field.type === 'toggle') return !!raw;
  if (field.type === 'slider' || field.type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return Number.isFinite(field.min) ? field.min : 0;
    return Math.min(field.max, Math.max(field.min, n));
  }
  if (field.type === 'select') {
    const match = field.options.find((opt) => String(opt.value) === String(raw));
    return match ? match.value : field.options[0].value;
  }
  return raw == null ? '' : String(raw);
}
