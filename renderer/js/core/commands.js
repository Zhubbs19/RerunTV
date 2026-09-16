// Config commands — contract C3 from docs/design/05-command-layer-and-sync.md.
//
// A command is a plain JSON object ({ type, ...payload }) that changes config
// in place and hands back the command(s) that would undo it. That one shape is
// what undo history is made of, and later what a remote editor sends over the
// LAN and what a template applies in one batch.
//
// Pure on purpose: no DOM, no renderer state. Every function takes the config
// object it works on, so the same file can run against the host process's copy
// of config later (doc 05 §2.2) and under node:test today. Undo history and
// persistence live with saveConfigDebounced in state.js.
//
// Two kinds of command exist during the migration:
//   - named ones (channel.set, channel.rename, …) for edits converted so far;
//   - config.patch, a structural diff of whatever an unconverted call site
//     changed before calling saveConfigDebounced(). Every edit is undoable
//     either way; named ones just undo more precisely and describe themselves.

const registry = new Map();

export function registerCommand(type, definition) {
  if (!type || typeof type !== 'string') throw new Error('registerCommand: type must be a non-empty string');
  if (typeof definition.apply !== 'function') throw new Error(`registerCommand("${type}"): apply(config, cmd) is required`);
  registry.set(type, definition);
}

export function isRegisteredCommand(type) {
  return registry.has(type);
}

// Validates and applies one command to `config` in place. Returns the list of
// commands that undo it, in the order they should be applied.
export function applyCommand(config, cmd) {
  const def = cmd && registry.get(cmd.type);
  if (!def) throw new Error(`Unknown command "${cmd && cmd.type}"`);
  if (def.validate) def.validate(config, cmd);
  const inverse = def.apply(config, cmd);
  if (!Array.isArray(inverse)) throw new Error(`Command "${cmd.type}" did not return its inverse`);
  return inverse;
}

export function describeCommand(config, cmd) {
  const def = cmd && registry.get(cmd.type);
  return (def && def.describe && def.describe(config, cmd)) || 'Edit';
}

// What this client should send the host in place of `cmd`, once it has been
// applied locally. Almost every command travels as itself. A plugin's own
// command does not: the host has no plugin renderers and so no registry entry
// for it, and it would arrive as "Unknown command". Such a command declares
// `toHost`, which states the resulting settings as a plain `plugin.setSettings`
// the host already understands (docs/design/05 §3). Undo history keeps the
// precise plugin command either way, so the step still reads as what the plugin
// called it.
export function hostCommandsFor(config, cmd) {
  const def = cmd && registry.get(cmd.type);
  if (!def || typeof def.toHost !== 'function') return [cmd];
  const translated = def.toHost(config, cmd);
  return Array.isArray(translated) ? translated : [translated];
}

// ---------- Touch sets (docs/design/05 §2.3) ----------
// What part of config a command changes, as slash-separated tokens. The host
// uses them to decide whether two clients' edits can both land: two commands
// conflict when one's token is the other's, or an ancestor of it. Deliberately
// coarse where an edit changes addressing rather than a value — renumbering or
// removing a channel touches `channels`, because a command another client
// built against the old numbering may no longer mean what it said. A
// structural config.patch touches '*', which conflicts with everything: those
// are whole-config transforms (a curation run, a tag rename, an import) that
// genuinely cannot be merged with a concurrent edit.
//
// A command type with no touches() is treated as '*' rather than as touching
// nothing, so a new or plugin-supplied command is safe before it is thought
// about, not silently mergeable with everything.
export function commandTouches(cmd) {
  const def = cmd && registry.get(cmd.type);
  if (!def || typeof def.touches !== 'function') return ['*'];
  try {
    const tokens = def.touches(cmd);
    return Array.isArray(tokens) && tokens.length ? tokens.map(String) : ['*'];
  } catch (e) {
    return ['*'];
  }
}

// One token covers another when they are equal or the first is an ancestor of
// the second at a separator boundary — `channels` covers `channels/7/name`,
// but `channels/7` does not cover `channels/70`.
function tokenCovers(outer, inner) {
  if (outer === '*' || inner === '*') return true;
  return outer === inner || inner.startsWith(`${outer}/`);
}

export function touchesConflict(a, b) {
  return a.some((one) => b.some((other) => tokenCovers(one, other) || tokenCovers(other, one)));
}

// Every touch token of a batch, deduped — what the host records per revision.
export function batchTouches(commands) {
  const seen = new Set();
  commands.forEach((cmd) => commandTouches(cmd).forEach((token) => seen.add(token)));
  return [...seen];
}

// ---------- JSON helpers ----------

function isObject(value) {
  return value !== null && typeof value === 'object';
}

export function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (!isObject(a) || !isObject(b)) return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

// ---------- Structural diff ----------
//
// Ops, each with a path of keys/indices from the config root:
//   { p, v }        set p to v (a path of [] replaces the root's contents)
//   { p, d: true }  delete key p
//   { p, s: [start, deleteCount, items] }  splice the array at p
//
// diffJson walks both trees once and returns the ops that turn `before` into
// `after` AND the ops that turn it back, so undo never needs a second walk or a
// full snapshot. Arrays of the same length are diffed element by element;
// arrays that grew or shrank become one splice over the changed middle (common
// prefix and suffix kept), so removing one channel doesn't copy the lineup.
// JSON semantics throughout: undefined-valued keys count as absent, as they do
// once config is saved.

export function diffJson(before, after) {
  const ops = [];
  const undo = [];
  walk(before, after, [], ops, undo);
  return { ops, undo };
}

// Config arrays hold things with identity — channels by number, blocks and
// pool entries by id, files by path — so "the same item, edited" is matched by
// that, not only by being identical.
const IDENTITY_KEYS = ['id', 'number', 'path'];
function sameItem(a, b) {
  if (deepEqual(a, b)) return true;
  if (!isObject(a) || !isObject(b) || Array.isArray(a) || Array.isArray(b)) return false;
  return IDENTITY_KEYS.some((key) => a[key] !== undefined && a[key] === b[key]);
}

function walk(a, b, path, ops, undo) {
  if (deepEqual(a, b)) return;
  if (isObject(a) && isObject(b) && Array.isArray(a) === Array.isArray(b)) {
    if (Array.isArray(a)) {
      if (a.length === b.length) {
        for (let i = 0; i < a.length; i++) walk(a[i], b[i], [...path, i], ops, undo);
        return;
      }
      // Keep the ends that are the same item (identical, or the same channel/
      // block/file by identity) and diff inside them; splice only the middle.
      // Suffix items are addressed by their index in `after`: forward, their
      // ops run after the splice; undo runs them first, before the splice is
      // reversed, so the same index is right both ways.
      let prefix = 0;
      const max = Math.min(a.length, b.length);
      while (prefix < max && sameItem(a[prefix], b[prefix])) prefix++;
      let suffix = 0;
      while (suffix < max - prefix && sameItem(a[a.length - 1 - suffix], b[b.length - 1 - suffix])) suffix++;
      for (let i = 0; i < prefix; i++) walk(a[i], b[i], [...path, i], ops, undo);
      const removed = a.slice(prefix, a.length - suffix);
      const inserted = b.slice(prefix, b.length - suffix);
      ops.push({ p: path, s: [prefix, removed.length, cloneJson(inserted)] });
      undo.unshift({ p: path, s: [prefix, inserted.length, cloneJson(removed)] });
      for (let k = suffix - 1; k >= 0; k--) {
        walk(a[a.length - 1 - k], b[b.length - 1 - k], [...path, b.length - 1 - k], ops, undo);
      }
      return;
    }
    for (const key of Object.keys(b)) {
      if (b[key] === undefined) continue;
      if (a[key] === undefined) {
        ops.push({ p: [...path, key], v: cloneJson(b[key]) });
        undo.unshift({ p: [...path, key], d: true });
      } else {
        walk(a[key], b[key], [...path, key], ops, undo);
      }
    }
    for (const key of Object.keys(a)) {
      if (a[key] === undefined || b[key] !== undefined) continue;
      ops.push({ p: [...path, key], d: true });
      undo.unshift({ p: [...path, key], v: cloneJson(a[key]) });
    }
    return;
  }
  ops.push({ p: path, v: cloneJson(b) });
  undo.unshift({ p: path, v: cloneJson(a) });
}

// Applies ops to `root` in place. Inserted values are always copied, so a
// history entry's stored values can never become live config objects that a
// later in-place edit would silently change.
export function applyPatch(root, ops) {
  for (const op of ops) {
    if (!op.p.length) {
      if (op.v === undefined || !isObject(op.v)) throw new Error('config.patch: the root can only be replaced by an object');
      const replacement = cloneJson(op.v); // before clearing: op.v may be root itself
      Object.keys(root).forEach((key) => { delete root[key]; });
      Object.assign(root, replacement);
      continue;
    }
    let parent = root;
    for (let i = 0; i < op.p.length - 1; i++) {
      parent = parent[op.p[i]];
      if (!isObject(parent)) throw new Error(`config.patch: no container at ${op.p.slice(0, i + 1).join('.')}`);
    }
    const key = op.p[op.p.length - 1];
    if (op.s) {
      const target = parent[key];
      if (!Array.isArray(target)) throw new Error(`config.patch: splice target ${op.p.join('.')} is not an array`);
      target.splice(op.s[0], op.s[1], ...cloneJson(op.s[2]));
    } else if (op.d) {
      if (Array.isArray(parent)) throw new Error('config.patch: delete inside an array; use a splice');
      delete parent[key];
    } else {
      parent[key] = cloneJson(op.v);
    }
  }
}

// ---------- Built-in commands ----------

function findChannel(config, number) {
  return (config.channels || []).find((ch) => ch.number === number);
}

function requireChannel(config, number) {
  if (!findChannel(config, number)) throw new Error(`Channel ${number} doesn't exist`);
}

// A readable name for "what did this diff touch", for undo labels on edits
// that haven't been converted to named commands yet.
function describePatch(config, ops) {
  const channelIndices = new Set();
  const topKeys = new Set();
  ops.forEach((op) => {
    if (op.p[0] === 'channels' && typeof op.p[1] === 'number' && op.p.length > 2) channelIndices.add(op.p[1]);
    topKeys.add(op.p[0] === undefined ? 'config' : String(op.p[0]));
  });
  if (topKeys.size === 1 && topKeys.has('channels') && channelIndices.size === 1) {
    const [index] = channelIndices;
    const ch = config.channels && config.channels[index];
    if (ch) {
      const fields = new Set(ops.map((op) => op.p[2]));
      return fields.size === 1 ? `Change CH ${ch.number} ${String([...fields][0])}` : `Edit CH ${ch.number}`;
    }
  }
  if (topKeys.size === 1) {
    const [key] = topKeys;
    if (key === 'channels') return 'Edit channels';
    return SETTING_LABELS[key] ? `Change ${SETTING_LABELS[key]}` : `Edit ${key} settings`;
  }
  return 'Edit settings';
}

registerCommand('config.patch', {
  touches() { return ['*']; },
  validate(config, cmd) {
    if (!Array.isArray(cmd.ops) || !Array.isArray(cmd.undo)) throw new Error('config.patch needs ops and undo');
  },
  apply(config, cmd) {
    applyPatch(config, cmd.ops);
    return [{ type: 'config.patch', ops: cmd.undo, undo: cmd.ops, label: cmd.label }];
  },
  describe(config, cmd) {
    return cmd.label || describePatch(config, cmd.ops);
  },
});

// Box-wide setting at a path under an allowed top-level section. The allow-list
// keeps this from becoming a second, unvalidated config.patch.
const SETTING_LABELS = {
  crtEnabled: 'CRT effect', crtIntensity: 'CRT', staticEffect: 'channel static', contentVolume: 'content volume',
  adVolume: 'commercial volume', display: 'display', upNext: 'up next banner', details: 'details page',
  timeMachine: 'time machine', stationId: 'station ID', trivia: 'trivia', theme: 'theme',
  pictureMode: 'picture mode', aspectMode: 'aspect', displayMode: 'display mode', updates: 'updates',
  network: 'network', reminders: 'reminders', reminderAutoTune: 'reminder auto-tune',
  reminderNotify: 'reminder notifications', reminderLeadMinutes: 'reminder lead time',
  viewingHistory: 'viewing history', keepDisplayAwake: 'keep display awake', playbackResync: 'playback resync',
  customSounds: 'sounds', pinLock: 'PIN lock', commercials: 'commercials', autoStandby: 'auto standby', preemptionWindows: 'preemption windows', subChannels: 'sub-channels',
  muted: 'mute', volume: 'volume', lastChannel: 'last channel', librarySync: 'library sync',
  tagTaxonomy: 'tag taxonomy', airChecks: 'air checks', ticker: 'ticker', pluginSettingsMeta: 'plugin settings versions',
};
const SETTINGS_SECTIONS = new Set(Object.keys(SETTING_LABELS));

// "hintBarShowDuration" -> "hint bar show duration", for undo labels.
function humanizeKey(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

function readPath(root, path) {
  let node = root;
  for (const key of path) {
    if (!isObject(node)) return { exists: false };
    if (!Object.prototype.hasOwnProperty.call(node, key)) return { exists: false };
    node = node[key];
  }
  return { exists: true, value: node };
}

registerCommand('settings.set', {
  touches(cmd) { return [`settings/${cmd.path.join('/')}`]; },
  validate(config, cmd) {
    if (!Array.isArray(cmd.path) || !cmd.path.length || !SETTINGS_SECTIONS.has(cmd.path[0])) {
      throw new Error(`settings.set: "${cmd.path && cmd.path[0]}" isn't a settings section`);
    }
  },
  apply(config, cmd) {
    const before = readPath(config, cmd.path);
    let parent = config;
    for (let i = 0; i < cmd.path.length - 1; i++) {
      const key = cmd.path[i];
      if (!isObject(parent[key])) parent[key] = {};
      parent = parent[key];
    }
    const key = cmd.path[cmd.path.length - 1];
    if (cmd.value === undefined) delete parent[key]; else parent[key] = cloneJson(cmd.value);
    return [{ type: 'settings.set', path: cmd.path, value: before.exists ? cloneJson(before.value) : undefined }];
  },
  describe(config, cmd) {
    const section = SETTING_LABELS[cmd.path[0]] || cmd.path[0];
    return cmd.path.length > 1 ? `Change ${section} ${humanizeKey(cmd.path[cmd.path.length - 1])}` : `Change ${section}`;
  },
});

// Per-channel fields that are a plain value with no side effects beyond being
// read. Anything that reorders files, re-anchors, or renumbers is not here.
const CHANNEL_FIELDS = {
  favorite: 'favorite', quickAccess: 'remote quick-tap', vhsQuality: 'VHS', vhsWearLoops: 'wear loops',
  hideFormatDisclaimer: 'format disclaimer', hideRatingBug: 'rating icon', hideEpisodeStatus: 'repeat icon',
  hideDaypartChime: 'daypart chime', hideLocalAvailGlitch: 'local avail glitch',
  hideContentAdvisory: 'content advisory', hideCapabilityBadge: 'capability badge',
  notSubscribed: 'not subscribed', hidden: 'hide from tuning', rating: 'rating', aspectRatio: 'aspect ratio',
  resolutionOverride: 'resolution', displayAspectOverride: 'display aspect', color: 'color', volume: 'volume',
  adsEnabled: 'ads', defaultHasCC: 'default CC', defaultHasSAP: 'default SAP', defaultHasStereo: 'default stereo',
  iconOverrides: 'seasonal icons', logoBugProfiles: 'logo bug placement', dynamicOverlays: 'dynamic overlays',
  callLetters: 'call letters',
};

registerCommand('channel.set', {
  touches(cmd) { return [`channels/${cmd.channel}/${cmd.field}`]; },
  validate(config, cmd) {
    requireChannel(config, cmd.channel);
    if (!Object.prototype.hasOwnProperty.call(CHANNEL_FIELDS, cmd.field)) {
      throw new Error(`channel.set: "${cmd.field}" isn't an editable channel field`);
    }
  },
  apply(config, cmd) {
    const ch = findChannel(config, cmd.channel);
    const had = Object.prototype.hasOwnProperty.call(ch, cmd.field);
    const before = had ? cloneJson(ch[cmd.field]) : undefined;
    if (cmd.value === undefined) delete ch[cmd.field]; else ch[cmd.field] = cloneJson(cmd.value);
    return [{ type: 'channel.set', channel: cmd.channel, field: cmd.field, value: before }];
  },
  describe(config, cmd) {
    return `Change CH ${cmd.channel} ${CHANNEL_FIELDS[cmd.field]}`;
  },
});

// Whole top-level fields of one channel (its files, folders, commercials,
// credits speedup, ticker, identity…), for edits that change more than a plain
// value. Anything but the number, which identifies the channel: that's
// channel.renumber / channel.swapNumbers.
registerCommand('channel.setFields', {
  touches(cmd) { return Object.keys(cmd.fields || {}).map((field) => `channels/${cmd.channel}/${field}`); },
  validate(config, cmd) {
    requireChannel(config, cmd.channel);
    if (!isObject(cmd.fields) || !Object.keys(cmd.fields).length) throw new Error('channel.setFields needs fields');
    if (Object.prototype.hasOwnProperty.call(cmd.fields, 'number')) throw new Error('channel.setFields can\'t change the number; use channel.renumber');
  },
  apply(config, cmd) {
    const ch = findChannel(config, cmd.channel);
    const before = {};
    Object.keys(cmd.fields).forEach((field) => {
      before[field] = Object.prototype.hasOwnProperty.call(ch, field) ? cloneJson(ch[field]) : undefined;
      if (cmd.fields[field] === undefined) delete ch[field]; else ch[field] = cloneJson(cmd.fields[field]);
    });
    return [{ type: 'channel.setFields', channel: cmd.channel, fields: before }];
  },
  describe(config, cmd) {
    const fields = Object.keys(cmd.fields);
    if (fields.length !== 1) return `Edit CH ${cmd.channel}`;
    return `Change CH ${cmd.channel} ${CHANNEL_FIELDS[fields[0]] || humanizeKey(fields[0])}`;
  },
});

registerCommand('channel.renumber', {
  touches() { return ['channels']; },
  validate(config, cmd) {
    requireChannel(config, cmd.from);
    if (!Number.isFinite(cmd.to)) throw new Error('channel.renumber needs a number');
    if (cmd.to !== cmd.from && findChannel(config, cmd.to)) throw new Error(`Channel ${cmd.to} already exists`);
  },
  apply(config, cmd) {
    findChannel(config, cmd.from).number = cmd.to;
    return [{ type: 'channel.renumber', from: cmd.to, to: cmd.from }];
  },
  describe(config, cmd) {
    return `Renumber CH ${cmd.from} to ${cmd.to}`;
  },
});

// Two channels trade numbers (move up/down, drag to reorder).
registerCommand('channel.swapNumbers', {
  touches() { return ['channels']; },
  validate(config, cmd) {
    requireChannel(config, cmd.a);
    requireChannel(config, cmd.b);
  },
  apply(config, cmd) {
    const a = findChannel(config, cmd.a);
    const b = findChannel(config, cmd.b);
    [a.number, b.number] = [b.number, a.number];
    // Written the other way round so it never reads as "changes nothing".
    return [{ type: 'channel.swapNumbers', a: cmd.b, b: cmd.a }];
  },
  describe(config, cmd) {
    return `Swap CH ${cmd.a} and CH ${cmd.b}`;
  },
});

registerCommand('channel.rename', {
  touches(cmd) { return [`channels/${cmd.channel}/name`]; },
  validate(config, cmd) {
    requireChannel(config, cmd.channel);
    if (typeof cmd.name !== 'string') throw new Error('channel.rename needs a name');
  },
  apply(config, cmd) {
    const ch = findChannel(config, cmd.channel);
    const before = ch.name;
    ch.name = cmd.name;
    return [{ type: 'channel.rename', channel: cmd.channel, name: before == null ? '' : before }];
  },
  describe(config, cmd) {
    return `Rename CH ${cmd.channel}`;
  },
});

registerCommand('channel.remove', {
  touches() { return ['channels']; },
  validate(config, cmd) {
    requireChannel(config, cmd.channel);
  },
  apply(config, cmd) {
    const index = config.channels.findIndex((ch) => ch.number === cmd.channel);
    const [removed] = config.channels.splice(index, 1);
    return [{ type: 'channel.insert', index, channel: cloneJson(removed) }];
  },
  describe(config, cmd) {
    return `Remove CH ${cmd.channel}`;
  },
});

// ---------- Plugin registry state (config.plugins) ----------
// Written by the host process (main-plugins.js), not the setup screen: these
// used to be load-modify-save IPC handlers whose writes a later renderer save
// could silently revert. As commands they are applied by the host and replayed
// onto the renderer's copy (docs/design/05 §2.2). Each one sets a value rather
// than appending, so applying it twice is harmless — rebasing depends on that.

function pluginsSection(config) {
  if (!isObject(config.plugins)) config.plugins = { disabled: [] };
  if (!Array.isArray(config.plugins.disabled)) config.plugins.disabled = [];
  return config.plugins;
}

function requirePluginId(cmd) {
  if (!cmd.id || typeof cmd.id !== 'string') throw new Error(`${cmd.type} needs a plugin id`);
}

// signature: the approved capability signature, or null to revoke.
registerCommand('plugin.setApproval', {
  touches(cmd) { return [`plugins/${cmd.id}/approval`]; },
  validate(config, cmd) { requirePluginId(cmd); },
  apply(config, cmd) {
    const plugins = pluginsSection(config);
    const approvals = isObject(plugins.approvedCapabilities) ? plugins.approvedCapabilities : (plugins.approvedCapabilities = {});
    const before = Object.prototype.hasOwnProperty.call(approvals, cmd.id) ? approvals[cmd.id] : null;
    if (cmd.signature == null) delete approvals[cmd.id]; else approvals[cmd.id] = cmd.signature;
    return [{ type: 'plugin.setApproval', id: cmd.id, signature: before }];
  },
  describe(config, cmd) {
    return cmd.signature == null ? `Revoke ${cmd.id} permissions` : `Approve ${cmd.id} permissions`;
  },
});

// A plugin's whole settings object (config.pluginSettings[id]). Defined as an
// own property, so an id can never reach the object's prototype.
registerCommand('plugin.setSettings', {
  touches(cmd) { return [`plugins/${cmd.id}/settings`]; },
  validate(config, cmd) {
    requirePluginId(cmd);
    if (cmd.settings !== undefined && (!isObject(cmd.settings) || Array.isArray(cmd.settings))) throw new Error('plugin.setSettings needs a settings object');
  },
  apply(config, cmd) {
    if (!isObject(config.pluginSettings) || Array.isArray(config.pluginSettings)) config.pluginSettings = {};
    const root = config.pluginSettings;
    const before = Object.prototype.hasOwnProperty.call(root, cmd.id) ? cloneJson(root[cmd.id]) : undefined;
    if (cmd.settings === undefined) delete root[cmd.id];
    else Object.defineProperty(root, cmd.id, { value: cloneJson(cmd.settings), enumerable: true, configurable: true, writable: true });
    return [{ type: 'plugin.setSettings', id: cmd.id, settings: before }];
  },
  describe(config, cmd) {
    return `Change ${cmd.id} settings`;
  },
});

registerCommand('plugin.setEnabled', {
  touches(cmd) { return [`plugins/${cmd.id}/enabled`]; },
  validate(config, cmd) { requirePluginId(cmd); },
  apply(config, cmd) {
    const plugins = pluginsSection(config);
    const wasEnabled = !plugins.disabled.includes(cmd.id);
    // In place (config objects keep identity — CLAUDE.md), and never a
    // duplicate entry however many times this is applied.
    for (let i = plugins.disabled.length - 1; i >= 0; i--) if (plugins.disabled[i] === cmd.id) plugins.disabled.splice(i, 1);
    if (!cmd.enabled) plugins.disabled.push(cmd.id);
    return [{ type: 'plugin.setEnabled', id: cmd.id, enabled: wasEnabled }];
  },
  describe(config, cmd) {
    return `${cmd.enabled ? 'Enable' : 'Disable'} ${cmd.id}`;
  },
});

// After an uninstall: no lingering disabled/approved state for a gone plugin.
registerCommand('plugin.forget', {
  touches(cmd) { return [`plugins/${cmd.id}`]; },
  validate(config, cmd) { requirePluginId(cmd); },
  apply(config, cmd) {
    const plugins = pluginsSection(config);
    const wasDisabled = plugins.disabled.includes(cmd.id);
    const approvals = isObject(plugins.approvedCapabilities) ? plugins.approvedCapabilities : null;
    const signature = approvals && Object.prototype.hasOwnProperty.call(approvals, cmd.id) ? approvals[cmd.id] : null;
    for (let i = plugins.disabled.length - 1; i >= 0; i--) if (plugins.disabled[i] === cmd.id) plugins.disabled.splice(i, 1);
    if (approvals) delete approvals[cmd.id];
    const inverse = [];
    if (wasDisabled) inverse.push({ type: 'plugin.setEnabled', id: cmd.id, enabled: false });
    if (signature != null) inverse.push({ type: 'plugin.setApproval', id: cmd.id, signature });
    return inverse;
  },
  describe(config, cmd) {
    return `Forget ${cmd.id}`;
  },
});

// ---------- Plugin-owned commands (docs/design/05 §3) ----------
// A plugin registers its own named commands through ctx.commands.register
// (renderer/js/plugin/host.js), so its edits are undoable with its own labels
// instead of arriving as an anonymous patch.
//
// Two rules make this safe, and both are structural rather than checked:
//
//   * OWNERSHIP is the namespace. A registered type is always
//     `plugin:<id>.<name>`, built here from the id the plugin host supplies —
//     a plugin never states its own type string, so it cannot register into
//     another plugin's namespace or shadow a core command.
//   * SCOPE is the argument. The plugin's own apply/validate/describe never
//     receive `config`. They receive that plugin's settings object and nothing
//     else, so there is no path from a plugin command to another plugin's
//     settings, to the channel lineup, or to box settings — not because they
//     are told not to, but because they are never handed them.
//
// The inverse a plugin returns is in its own vocabulary too, and is mapped back
// into the namespace here.
const PLUGIN_COMMAND_PREFIX = 'plugin:';

export function pluginCommandType(pluginId, name) {
  return `${PLUGIN_COMMAND_PREFIX}${pluginId}.${name}`;
}

function pluginSettingsFor(config, pluginId) {
  if (!isObject(config.pluginSettings) || Array.isArray(config.pluginSettings)) config.pluginSettings = {};
  const root = config.pluginSettings;
  if (!isObject(root[pluginId]) || Array.isArray(root[pluginId])) {
    Object.defineProperty(root, pluginId, { value: {}, enumerable: true, configurable: true, writable: true });
  }
  return root[pluginId];
}

// Registers `plugin:<id>.<name>`. `definition` is the plugin's, written against
// its settings object. Returns the full type string.
export function registerPluginCommand(pluginId, name, definition) {
  if (!pluginId || typeof pluginId !== 'string') throw new Error('registerPluginCommand: a plugin id is required');
  if (!name || typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error(`registerPluginCommand("${pluginId}"): name must be letters, digits, dot, dash or underscore`);
  }
  if (!definition || typeof definition.apply !== 'function') {
    throw new Error(`registerPluginCommand("${pluginId}.${name}"): apply(settings, cmd) is required`);
  }
  const type = pluginCommandType(pluginId, name);
  if (registry.has(type)) throw new Error(`registerPluginCommand: ${type} is already registered`);

  const intoNamespace = (inverse) => {
    const list = Array.isArray(inverse) ? inverse : [inverse];
    return list.map((one) => {
      if (!isObject(one) || typeof one.name !== 'string') {
        throw new Error(`${type} must return its inverse as { name, ...payload } objects`);
      }
      const { name: inverseName, ...payload } = one;
      const inverseType = pluginCommandType(pluginId, inverseName);
      if (!registry.has(inverseType)) throw new Error(`${type} returned an inverse "${inverseName}" that ${pluginId} has not registered`);
      return { type: inverseType, ...payload };
    });
  };

  registerCommand(type, {
    validate(config, cmd) {
      if (definition.validate) definition.validate(pluginSettingsFor(config, pluginId), cmd);
    },
    apply(config, cmd) {
      return intoNamespace(definition.apply(pluginSettingsFor(config, pluginId), cmd));
    },
    describe(config, cmd) {
      if (!definition.describe) return `Change ${pluginId} settings`;
      return definition.describe(pluginSettingsFor(config, pluginId), cmd) || `Change ${pluginId} settings`;
    },
    // A plugin's touch tokens are relative to its own settings, so they are
    // prefixed here and cannot name anything outside them.
    touches(cmd) {
      const base = `plugins/${pluginId}/settings`;
      if (typeof definition.touches !== 'function') return [base];
      const tokens = definition.touches(cmd);
      if (!Array.isArray(tokens) || !tokens.length) return [base];
      return tokens.map((token) => `${base}/${String(token).replace(/^\/+/, '')}`);
    },
    // The host has no plugin renderers, so it never knows this type. Send the
    // settings this command produced, which it does know.
    toHost(config, cmd) {
      return [{ type: 'plugin.setSettings', id: pluginId, settings: cloneJson(pluginSettingsFor(config, pluginId)) }];
    },
  });
  return type;
}

// Every plugin command a given plugin registered — used when a plugin is
// disabled or reloaded, so a stale definition cannot keep answering for a type.
export function unregisterPluginCommands(pluginId) {
  const prefix = `${PLUGIN_COMMAND_PREFIX}${pluginId}.`;
  [...registry.keys()].filter((type) => type.startsWith(prefix)).forEach((type) => registry.delete(type));
}

// ---------- Per-file metadata (the TITLES panel) ----------
// A file lives in a channel's pool or in one of its schedule blocks' pools and
// is addressed by its path there: { channel, block?, file: path }. `fields`
// sets several at once, so an edit that has to keep two in step (facets and
// the tags mirrored from them) is one command. null clears a field.
const FILE_FIELDS = {
  title: 'title', tags: 'tags', description: 'description', facets: 'facets', rating: 'rating',
  advisory: 'advisory', advisoryCues: 'scene cues', creditsLeadS: 'credits lead', creditsSqueezeBgImage: 'credits backdrop',
  hasCC: 'CC', hasSAP: 'SAP', hasStereo: 'stereo',
};

function findFileOwner(config, cmd) {
  const ch = findChannel(config, cmd.channel);
  if (!ch) return null;
  if (cmd.block == null) return ch;
  return (ch.blocks || []).find((b) => b.id === cmd.block) || null;
}

// A file's touch token. The path is the last segment, so two edits to
// different files in the same channel don't read as the same touch.
function fileToken(cmd) {
  return `channels/${cmd.channel}/files/${cmd.block == null ? '-' : cmd.block}/${cmd.file}`;
}

function findFile(config, cmd) {
  const owner = findFileOwner(config, cmd);
  return owner && Array.isArray(owner.files) ? owner.files.find((f) => f.path === cmd.file) : null;
}

registerCommand('file.set', {
  touches(cmd) { return Object.keys(cmd.fields || {}).map((field) => `${fileToken(cmd)}/${field}`); },
  validate(config, cmd) {
    if (!isObject(cmd.fields) || !Object.keys(cmd.fields).length) throw new Error('file.set needs fields');
    const bad = Object.keys(cmd.fields).find((field) => !Object.prototype.hasOwnProperty.call(FILE_FIELDS, field));
    if (bad) throw new Error(`file.set: "${bad}" isn't an editable file field`);
    if (!findFileOwner(config, cmd)) throw new Error(`CH ${cmd.channel}${cmd.block ? ` block ${cmd.block}` : ''} doesn't exist`);
    if (!findFile(config, cmd)) throw new Error(`CH ${cmd.channel} has no file ${cmd.file}`);
  },
  apply(config, cmd) {
    const file = findFile(config, cmd);
    const before = {};
    Object.keys(cmd.fields).forEach((field) => {
      before[field] = Object.prototype.hasOwnProperty.call(file, field) ? cloneJson(file[field]) : undefined;
      const value = cmd.fields[field];
      if (value === undefined) delete file[field]; else file[field] = cloneJson(value);
    });
    return [{ type: 'file.set', channel: cmd.channel, block: cmd.block, file: cmd.file, fields: before }];
  },
  describe(config, cmd) {
    const fields = Object.keys(cmd.fields);
    return `Change CH ${cmd.channel} file ${fields.length === 1 ? FILE_FIELDS[fields[0]] : 'details'}`;
  },
});

// ---------- Id-addressed lists (ad pool, ad presets, flows, blocks) ----------
// Items in these arrays carry a stable `id`, which is how a command finds one
// no matter where it has moved in the list or what else changed around it.
// item.set replaces whole top-level fields of one item; nested objects inside a
// field are replaced as a unit. A channel-scoped list (a channel's schedule
// blocks) also takes `channel`, the owning channel's number.
const COLLECTIONS = {
  pool: { label: 'ad pool entry', plural: 'ad pool entries', path: ['interstitials', 'pool'] },
  presets: { label: 'ad preset', plural: 'ad presets', path: ['interstitials', 'presets'] },
  flows: { label: 'flow', plural: 'flows', path: ['interstitials', 'flows'] },
  blocks: { label: 'block', plural: 'blocks', channelScoped: true, path: ['blocks'] },
};

function collectionDef(cmd) {
  const def = COLLECTIONS[cmd.collection];
  if (!def) throw new Error(`${cmd.type}: "${cmd.collection}" isn't a list commands can edit`);
  return def;
}

// The touch token for the list a collection command edits. A channel-scoped
// collection (a channel's blocks) hangs off that channel.
function listToken(cmd) {
  const def = COLLECTIONS[cmd.collection];
  if (!def) return '*';
  return def.channelScoped
    ? `channels/${cmd.channel}/${def.path.join('/')}`
    : def.path.join('/');
}

function collectionArray(config, def, create, cmd) {
  let node = config;
  if (def.channelScoped) {
    node = findChannel(config, cmd && cmd.channel);
    if (!node) {
      if (create) throw new Error(`Channel ${cmd && cmd.channel} doesn't exist`);
      return null;
    }
  }
  for (let i = 0; i < def.path.length; i++) {
    const key = def.path[i];
    const last = i === def.path.length - 1;
    if (last ? !Array.isArray(node[key]) : !isObject(node[key])) {
      if (!create) return null;
      node[key] = last ? [] : {};
    }
    node = node[key];
  }
  return node;
}

// Carries a channel-scoped command's channel over to its inverse. Key order
// matches how callers build commands, so an inverse that changes nothing
// compares equal to the command (state.js commitInPlace relies on it).
function withScope(inverse, cmd) {
  if (cmd.channel == null) return inverse;
  const { type, collection, ...rest } = inverse;
  return { type, collection, channel: cmd.channel, ...rest };
}

function requireItem(config, cmd) {
  const def = collectionDef(cmd);
  const list = collectionArray(config, def, false, cmd);
  const index = list ? list.findIndex((item) => item && item.id === cmd.id) : -1;
  if (index === -1) throw new Error(`No ${def.label} with id ${cmd.id}`);
  return { def, list, index };
}

registerCommand('item.set', {
  touches(cmd) { return [`${listToken(cmd)}/${cmd.id}`]; },
  validate(config, cmd) {
    requireItem(config, cmd);
    if (!isObject(cmd.fields) || !Object.keys(cmd.fields).length) throw new Error('item.set needs fields');
    if (Object.prototype.hasOwnProperty.call(cmd.fields, 'id')) throw new Error("item.set can't change an item's id");
  },
  apply(config, cmd) {
    const { list, index } = requireItem(config, cmd);
    const item = list[index];
    const before = {};
    Object.keys(cmd.fields).forEach((field) => {
      before[field] = Object.prototype.hasOwnProperty.call(item, field) ? cloneJson(item[field]) : undefined;
      if (cmd.fields[field] === undefined) delete item[field]; else item[field] = cloneJson(cmd.fields[field]);
    });
    return [withScope({ type: 'item.set', collection: cmd.collection, id: cmd.id, fields: before }, cmd)];
  },
  describe(config, cmd) {
    const def = COLLECTIONS[cmd.collection];
    const fields = Object.keys(cmd.fields);
    return `Change ${def ? def.label : 'item'} ${fields.length === 1 ? humanizeKey(fields[0]) : 'settings'}`;
  },
});

registerCommand('item.insert', {
  touches(cmd) { return [listToken(cmd)]; },
  validate(config, cmd) {
    const def = collectionDef(cmd);
    if (!isObject(cmd.item) || !cmd.item.id) throw new Error('item.insert needs an item with an id');
    if (def.channelScoped && !findChannel(config, cmd.channel)) throw new Error(`Channel ${cmd.channel} doesn't exist`);
    const list = collectionArray(config, def, false, cmd);
    if (list && list.some((item) => item && item.id === cmd.item.id)) throw new Error(`A ${def.label} with id ${cmd.item.id} already exists`);
  },
  apply(config, cmd) {
    const list = collectionArray(config, collectionDef(cmd), true, cmd);
    const index = Math.max(0, Math.min(cmd.index == null ? list.length : cmd.index, list.length));
    list.splice(index, 0, cloneJson(cmd.item));
    return [withScope({ type: 'item.remove', collection: cmd.collection, id: cmd.item.id }, cmd)];
  },
  describe(config, cmd) {
    const def = COLLECTIONS[cmd.collection];
    return `Add ${def ? def.label : 'item'}`;
  },
});

registerCommand('item.remove', {
  touches(cmd) { return [listToken(cmd)]; },
  validate(config, cmd) {
    requireItem(config, cmd);
  },
  apply(config, cmd) {
    const { list, index } = requireItem(config, cmd);
    const [removed] = list.splice(index, 1);
    return [withScope({ type: 'item.insert', collection: cmd.collection, index, item: cloneJson(removed) }, cmd)];
  },
  describe(config, cmd) {
    const def = COLLECTIONS[cmd.collection];
    return `Remove ${def ? def.label : 'item'}`;
  },
});

// ---------- Schedule blocks (docs/design/02 §4.1, the editable timeline) ----------
// Named commands over a channel's blocks, so a timeline edit undoes as what it
// was ("Set Saturday Cartoons hours") and a remote editor can send the same
// thing. Each one sets a value rather than appending — a weekday copy sets the
// whole days list — so applying one twice is harmless, as host replay needs
// (docs/design/05 §4). A block is addressed by { channel, id }.

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function findBlock(config, cmd) {
  const ch = findChannel(config, cmd.channel);
  const index = ch && Array.isArray(ch.blocks) ? ch.blocks.findIndex((b) => b && b.id === cmd.id) : -1;
  return index === -1 ? null : { ch, index, block: ch.blocks[index] };
}

function requireBlock(config, cmd) {
  requireChannel(config, cmd.channel);
  const found = findBlock(config, cmd);
  if (!found) throw new Error(`CH ${cmd.channel} has no block ${cmd.id}`);
  return found;
}

function blockName(config, cmd) {
  const found = findBlock(config, cmd);
  const name = found && found.block.name && found.block.name.trim();
  return name ? `"${name}"` : 'block';
}

function hourLabel(h) {
  const hour = ((h % 24) + 24) % 24;
  return `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;
}

function isHour(value) {
  return Number.isInteger(value) && value >= 0 && value <= 23;
}

registerCommand('block.create', {
  touches(cmd) { return [`channels/${cmd.channel}/blocks`]; },
  validate(config, cmd) {
    requireChannel(config, cmd.channel);
    if (!isObject(cmd.block) || !cmd.block.id || !isObject(cmd.block.trigger)) throw new Error('block.create needs a block with an id and a trigger');
    if (findBlock(config, { channel: cmd.channel, id: cmd.block.id })) throw new Error(`A block with id ${cmd.block.id} already exists`);
  },
  apply(config, cmd) {
    const ch = findChannel(config, cmd.channel);
    // A channel that had no blocks list gets one; undo takes it away again,
    // so an add-then-undo leaves the channel exactly as it was.
    const created = !Array.isArray(ch.blocks);
    if (created) ch.blocks = [];
    const index = Math.max(0, Math.min(cmd.index == null ? ch.blocks.length : cmd.index, ch.blocks.length));
    ch.blocks.splice(index, 0, cloneJson(cmd.block));
    return [{ type: 'block.remove', channel: cmd.channel, id: cmd.block.id, ...(created ? { dropEmptyList: true } : {}) }];
  },
  describe(config, cmd) {
    const name = cmd.block.name && cmd.block.name.trim();
    return `Add ${name ? `"${name}"` : 'block'} to CH ${cmd.channel}`;
  },
});

registerCommand('block.remove', {
  touches(cmd) { return [`channels/${cmd.channel}/blocks`]; },
  validate(config, cmd) { requireBlock(config, cmd); },
  apply(config, cmd) {
    const { ch, index } = requireBlock(config, cmd);
    const [removed] = ch.blocks.splice(index, 1);
    if (cmd.dropEmptyList && !ch.blocks.length) delete ch.blocks;
    return [{ type: 'block.create', channel: cmd.channel, index, block: cloneJson(removed) }];
  },
  describe(config, cmd) {
    return `Remove ${blockName(config, cmd)} from CH ${cmd.channel}`;
  },
});

// Start/end hour of a time block, or of a date-range block's optional hour
// narrowing. startHour === endHour means all day, as hourInRange reads it.
// { clear: true } removes a date-range block's narrowing; it exists as the
// inverse of narrowing one that had no hours, so undo doesn't leave 0–0.
registerCommand('block.setHours', {
  touches(cmd) { return [`channels/${cmd.channel}/blocks/${cmd.id}/hours`]; },
  validate(config, cmd) {
    requireBlock(config, cmd);
    if (!cmd.clear && (!isHour(cmd.startHour) || !isHour(cmd.endHour))) throw new Error('block.setHours needs whole hours 0–23');
  },
  apply(config, cmd) {
    const { block } = requireBlock(config, cmd);
    const before = { startHour: block.trigger.startHour, endHour: block.trigger.endHour };
    if (cmd.clear) {
      delete block.trigger.startHour;
      delete block.trigger.endHour;
    } else {
      block.trigger.startHour = cmd.startHour;
      block.trigger.endHour = cmd.endHour;
    }
    if (before.startHour == null || before.endHour == null) {
      return [{ type: 'block.setHours', channel: cmd.channel, id: cmd.id, clear: true }];
    }
    return [{ type: 'block.setHours', channel: cmd.channel, id: cmd.id, ...before }];
  },
  describe(config, cmd) {
    if (cmd.clear) return `Clear ${blockName(config, cmd)} hours`;
    return `Set ${blockName(config, cmd)} to ${hourLabel(cmd.startHour)}–${hourLabel(cmd.endHour)}`;
  },
});

// Which weekdays a block airs (0 = Sunday). An empty list means every day.
registerCommand('block.setDays', {
  touches(cmd) { return [`channels/${cmd.channel}/blocks/${cmd.id}/days`]; },
  validate(config, cmd) {
    requireBlock(config, cmd);
    if (!Array.isArray(cmd.days) || cmd.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('block.setDays needs weekdays 0–6');
  },
  apply(config, cmd) {
    const { block } = requireBlock(config, cmd);
    const before = Array.isArray(block.trigger.days) ? [...block.trigger.days] : [];
    // Sorted and de-duplicated, and all seven collapse to "every day", the
    // same normal form the BLOCKS day buttons keep.
    const days = [...new Set(cmd.days)].sort((a, b) => a - b);
    block.trigger.days = days.length === 7 ? [] : days;
    return [{ type: 'block.setDays', channel: cmd.channel, id: cmd.id, days: before, ...(cmd.label ? { label: cmd.label } : {}) }];
  },
  describe(config, cmd) {
    if (cmd.label) return cmd.label;
    const days = cmd.days.length && cmd.days.length < 7 ? cmd.days.map((d) => DAY_NAMES[d].slice(0, 3)).join(', ') : 'every day';
    return `Air ${blockName(config, cmd)} on ${days}`;
  },
});

registerCommand('block.setPriority', {
  touches(cmd) { return [`channels/${cmd.channel}/blocks/${cmd.id}/priority`]; },
  validate(config, cmd) {
    requireBlock(config, cmd);
    if (!Number.isFinite(cmd.priority)) throw new Error('block.setPriority needs a number');
  },
  apply(config, cmd) {
    const { block } = requireBlock(config, cmd);
    const before = block.priority || 0;
    block.priority = cmd.priority;
    return [{ type: 'block.setPriority', channel: cmd.channel, id: cmd.id, priority: before }];
  },
  describe(config, cmd) {
    return `Set ${blockName(config, cmd)} priority to ${cmd.priority}`;
  },
});

// One calendar day's exception on a daily/weekly block (dayOverrides["MM-DD"]):
// a pinned file, a title, an unlock time, skip. null removes it.
registerCommand('block.overrideDay', {
  touches(cmd) { return [`channels/${cmd.channel}/blocks/${cmd.id}/overrides`]; },
  validate(config, cmd) {
    requireBlock(config, cmd);
    if (typeof cmd.key !== 'string' || !/^\d{2}-\d{2}$/.test(cmd.key)) throw new Error('block.overrideDay needs an MM-DD key');
    if (cmd.override !== null && !isObject(cmd.override)) throw new Error('block.overrideDay needs an override object or null');
  },
  apply(config, cmd) {
    const { block } = requireBlock(config, cmd);
    if (!isObject(block.dayOverrides) || Array.isArray(block.dayOverrides)) block.dayOverrides = {};
    const had = Object.prototype.hasOwnProperty.call(block.dayOverrides, cmd.key);
    const before = had ? cloneJson(block.dayOverrides[cmd.key]) : null;
    if (cmd.override === null) delete block.dayOverrides[cmd.key];
    else block.dayOverrides[cmd.key] = cloneJson(cmd.override);
    return [{ type: 'block.overrideDay', channel: cmd.channel, id: cmd.id, key: cmd.key, override: before }];
  },
  describe(config, cmd) {
    const [m, d] = cmd.key.split('-').map(Number);
    return `${cmd.override === null ? 'Clear' : 'Override'} ${m}/${d} on ${blockName(config, cmd)}`;
  },
});

// The channel's broadcast day: { enabled, startHour, endHour }.
registerCommand('channel.setBroadcastHours', {
  touches(cmd) { return [`channels/${cmd.channel}/broadcastHours`]; },
  validate(config, cmd) {
    requireChannel(config, cmd.channel);
    const bh = cmd.broadcastHours;
    if (!isObject(bh) || typeof bh.enabled !== 'boolean' || !isHour(bh.startHour) || !isHour(bh.endHour)) {
      throw new Error('channel.setBroadcastHours needs { enabled, startHour, endHour }');
    }
  },
  apply(config, cmd) {
    const ch = findChannel(config, cmd.channel);
    const before = isObject(ch.broadcastHours) ? cloneJson(ch.broadcastHours) : { enabled: false, startHour: 6, endHour: 0 };
    ch.broadcastHours = { ...before, ...cloneJson(cmd.broadcastHours) };
    return [{ type: 'channel.setBroadcastHours', channel: cmd.channel, broadcastHours: before }];
  },
  describe(config, cmd) {
    const bh = cmd.broadcastHours;
    return bh.enabled
      ? `Sign CH ${cmd.channel} off ${hourLabel(bh.endHour)}–${hourLabel(bh.startHour)}`
      : `Broadcast CH ${cmd.channel} around the clock`;
  },
});

// Top-level field changes between a copy of an item taken before an in-place
// edit and the item now: { fields, previous }, or null when nothing changed.
// Lets UI code that edits an item directly still record the edit as item.set
// (state.js commitItemEdit) without the command replacing live objects.
export function itemFieldChanges(before, after) {
  const fields = {};
  const previous = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  keys.forEach((key) => {
    if (key === 'id') return;
    const a = before ? before[key] : undefined;
    const b = after ? after[key] : undefined;
    if (a === undefined && b === undefined) return;
    if (deepEqual(a, b)) return;
    fields[key] = cloneJson(b);
    previous[key] = cloneJson(a);
  });
  return Object.keys(fields).length ? { fields, previous } : null;
}

export function collectionPlural(name) {
  return COLLECTIONS[name] ? COLLECTIONS[name].plural : 'items';
}

registerCommand('channel.insert', {
  touches() { return ['channels']; },
  validate(config, cmd) {
    if (!isObject(cmd.channel) || cmd.channel.number == null) throw new Error('channel.insert needs a channel');
    if (findChannel(config, cmd.channel.number)) throw new Error(`Channel ${cmd.channel.number} already exists`);
  },
  apply(config, cmd) {
    if (!Array.isArray(config.channels)) config.channels = [];
    const index = Math.max(0, Math.min(cmd.index == null ? config.channels.length : cmd.index, config.channels.length));
    config.channels.splice(index, 0, cloneJson(cmd.channel));
    return [{ type: 'channel.remove', channel: cmd.channel.number }];
  },
  describe(config, cmd) {
    return `Add CH ${cmd.channel.number}`;
  },
});
