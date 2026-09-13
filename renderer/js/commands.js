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
const SETTINGS_SECTIONS = new Set([
  'crtEnabled', 'crtIntensity', 'staticEffect', 'contentVolume', 'adVolume', 'display', 'upNext', 'details',
  'timeMachine', 'stationId', 'trivia', 'theme', 'pictureMode', 'aspectMode',
]);
const SETTING_LABELS = {
  crtEnabled: 'CRT effect', crtIntensity: 'CRT', staticEffect: 'channel static', contentVolume: 'content volume',
  adVolume: 'commercial volume', display: 'display', upNext: 'up next banner', details: 'details page',
  timeMachine: 'time machine', stationId: 'station ID', trivia: 'trivia', theme: 'theme',
  pictureMode: 'picture mode', aspectMode: 'aspect',
};

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
    return cmd.path.length > 1 ? `Change ${section} ${cmd.path[cmd.path.length - 1]}` : `Change ${section}`;
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
};

registerCommand('channel.set', {
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

registerCommand('channel.rename', {
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

registerCommand('channel.insert', {
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
