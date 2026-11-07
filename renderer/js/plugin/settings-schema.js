// Pure helpers for the optional declarative contract registered alongside a
// plugin's custom settings sections. Kept separate from plugins.js so schema
// evolution, validation, and redaction can be tested without booting the
// renderer/plugin loader.

/**
 * Whether a value is a non-null, non-array object.
 * @param {*} value Value to test.
 * @returns {boolean} True for a plain object.
 */
function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-copies plain JSON-like data (objects, arrays, primitives).
 * @param {*} value Value to copy.
 * @returns {*} The copy; primitives are returned as-is.
 */
function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

/**
 * Returns a copy of settings with every missing key filled from defaults, recursing into nested objects.
 * @param {object} settings The stored plugin settings.
 * @param {object} defaults The schema's default values.
 * @returns {object} A new merged settings object.
 */
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

/**
 * Turns whatever a plugin's `validate()` hook returned into an error message.
 * `true`/nullish mean valid; `false`, a string, an array of strings or `{ valid: false, message }` mean invalid.
 * @param {*} result The hook's return value.
 * @returns {string} The message, or an empty string when valid.
 */
function validationMessage(result) {
  if (result == null || result === true) return '';
  if (result === false) return 'settings failed validation';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.filter(Boolean).join('; ');
  if (isPlainObject(result) && result.valid === false) return result.message || 'settings failed validation';
  return '';
}

/**
 * Validates and normalizes the declarative schema part of a `registerPluginSettings()` definition.
 * @param {string} pluginId The plugin id, used in error messages.
 * @param {object} definition The settings definition the plugin registered.
 * @returns {?object} `{ schemaVersion, defaults, validate, sensitivePaths, migrations }`, or null when the definition declares no schema fields.
 * @throws {Error} When a schema field has the wrong shape.
 */
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

/**
 * Brings stored plugin settings up to the schema's current version: runs migrations in order, merges defaults and validates.
 * @param {string} pluginId The plugin id, used in error messages and passed to migrations.
 * @param {object} settings The stored settings.
 * @param {number} storedVersion The schema version the settings were saved under (0 when unknown).
 * @param {?object} schema A normalized schema from `normalizePluginSettingsSchema`.
 * @returns {object} `{ settings, version, changed }`, where `changed` says the result differs from what was stored.
 * @throws {Error} When the stored version is newer than the schema, a migration returns a non-object, or validation fails.
 */
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

/**
 * Runs the schema's `validate()` hook against a copy of the settings.
 * @param {string} pluginId The plugin id, used in error messages.
 * @param {object} settings The settings to check.
 * @param {?object} schema A normalized schema.
 * @throws {Error} When settings is not an object or the hook reports a problem.
 */
export function validatePluginSettings(pluginId, settings, schema) {
  if (!isPlainObject(settings)) throw new Error(`${pluginId} settings must be an object`);
  if (!schema || !schema.validate) return;
  const message = validationMessage(schema.validate(clone(settings), { pluginId, schemaVersion: schema.schemaVersion }));
  if (message) throw new Error(`${pluginId} settings are invalid: ${message}`);
}

/**
 * Returns a copy of the settings with every schema `sensitivePaths` value replaced, for logs and diagnostics.
 * @param {object} settings The plugin settings.
 * @param {?object} schema A normalized schema.
 * @param {*} [replacement='[REDACTED]'] Value written in place of each sensitive value.
 * @returns {object} The redacted copy.
 */
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

/**
 * Validates a settings section's declarative `fields` list and normalizes each entry for the field renderer.
 * @param {string} pluginId The plugin id, used in error messages.
 * @param {string} sectionId The settings section id, used in error messages.
 * @param {Array<object>} fields The field definitions the plugin registered.
 * @returns {Array<object>} Normalized field descriptors.
 * @throws {Error} When the list is empty or a field is malformed or duplicated.
 */
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

/**
 * Reads a dotted path out of a settings object.
 * @param {object} settings The plugin settings.
 * @param {string} path Dotted key such as `crawl.speed`.
 * @returns {*} The value, or undefined when any step is missing.
 */
export function readSettingPath(settings, path) {
  return path.split('.').reduce((node, part) => (isPlainObject(node) ? node[part] : undefined), settings);
}

// The top-level patch updatePluginSettings(id, patch) needs to set one dotted
// path, leaving everything else in that branch as it was.
const UNSAFE_PATH_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Builds the top-level patch that sets one dotted path while keeping the rest of its branch.
 * Paths through prototype-chain keys yield an empty patch.
 * @param {object} settings The current plugin settings.
 * @param {string} path Dotted key to set.
 * @param {*} value The new value.
 * @returns {object} A `{ [topKey]: branch }` patch for `updatePluginSettings`.
 */
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

/**
 * A field's value as a control shows it, and back again for saving.
 * @param {object} field A normalized field descriptor.
 * @param {*} raw The raw stored or control value.
 * @returns {*} The value clamped or coerced to the field's type.
 */
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
