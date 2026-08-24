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
  const schemaVersion = definition.schemaVersion;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
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
