// Schema-versioning scaffold for the top-level app config (S.config, the
// contents of channels.json) — mirrors the pattern plugin-settings-schema.js
// already gives per-plugin settings (schemaVersion + a version->migration
// function map, applied in order) but for core config itself, which has
// never had one: every feature so far has added its own field via an ad hoc
// `if (!config.x) config.x = default` in applyConfigDefaults (app.js).
//
// This intentionally does NOT retrofit that existing 200+ lines of ad hoc
// defaulting into numbered migrations — each of those checks is already
// idempotent and safe to keep re-running exactly as written, and rewriting
// hard-won migration ordering for channels/blocks/interstitials risks
// corrupting a real user's config for no behavioral gain. What this adds is
// the landing zone: a NEW top-level config reshape from this point forward
// should register a numbered migration here instead of another ad hoc
// default, so config.schemaVersion actually reflects what shape the file is
// in — avoiding the "missing field = undefined" landmines a purely ad hoc
// scheme risks as the config keeps growing.

export const CONFIG_SCHEMA_VERSION = 1;

// sourceVersion (integer) -> (config) => config. Keyed by the version being
// migrated FROM, same convention as plugin-settings-schema.js's migrations
// map. Empty today — see the header comment above for why the pre-existing
// fields aren't retroactively assigned migrations.
const MIGRATIONS = {};

// Run once per applyConfigDefaults() call, before its own field-by-field
// defaulting — a config with no schemaVersion yet (every config that
// predates this scaffold) starts at 0 and walks forward through any
// registered migrations before landing on CONFIG_SCHEMA_VERSION. Mutates
// and returns the same object, matching applyConfigDefaults' own contract.
export function runConfigMigrations(config) {
  let version = Number.isInteger(config.schemaVersion) ? config.schemaVersion : 0;
  if (version > CONFIG_SCHEMA_VERSION) {
    // A config saved by a newer app version than this one — don't guess at
    // reversing anything; leave it untouched and let the rest of
    // applyConfigDefaults' existing null-checks paper over whatever a
    // downgrade doesn't understand, same as it always has.
    console.error(`config.json is schema v${version}, newer than this app version supports (v${CONFIG_SCHEMA_VERSION}) — leaving it as-is`);
    return config;
  }
  while (version < CONFIG_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version];
    if (migrate) config = migrate(config);
    version += 1;
  }
  config.schemaVersion = CONFIG_SCHEMA_VERSION;
  return config;
}
