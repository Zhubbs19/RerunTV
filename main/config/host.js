// The host's side of config ownership (docs/design/05-command-layer-and-sync.md
// §2.2–2.3, migration step 3).
//
// Before this, several main-process handlers (plugin approval, enable/disable,
// uninstall, the headless Companion settings patch) did their own
// load-modify-save of channels.json, while the renderer saved its whole
// in-memory config on every debounced edit. Whichever wrote last won, so a
// renderer save that started before a host edit silently reverted it — the
// capability-approval bug, patched per handler by mirroring each write into
// the renderer by hand.
//
// Now host-side edits are commands (renderer/js/commands.js, shared with the
// renderer). Each one applied here bumps a revision and is kept in a short
// ring. A renderer save carries the last revision that renderer has seen; if
// the host has applied commands since, they are replayed onto the incoming
// config before it is written, so neither side's change is lost. Host
// commands only ever set values, which is what makes replaying one that the
// renderer did in fact already have harmless.
//
// Step 6 (docs/design/05 §2.2-2.3) makes this the write path for every client,
// not just for the host's own edits. A client — the Electron renderer, and
// with doc 06 a browser control panel — applies a command optimistically,
// then posts the batch here with the revision it was built against and an id
// of its own. This host is the single writer, so it decides:
//
//   * duplicate    the same batch id arriving twice (a retry after a dropped
//                  reply) is answered with the first result, never applied
//                  again. Client commands are not all idempotent — an
//                  item.insert or a config.patch carrying array splices is
//                  not — so dedupe, not replay, is what makes delivery safe.
//   * conflict     a batch built against an older revision whose touch set
//                  (renderer/js/core/commands.js) intersects what another
//                  client changed since. Refused; the client resyncs.
//   * compatible   the same, but touching nothing another client touched:
//                  applied, because two people editing different channels is
//                  the ordinary case, not an error.
//   * stale-reset  a batch built before a backup restore. Refused outright
//                  rather than applied to a config it was never written for.
//   * stale-window a batch so old that the ring no longer proves it safe.
//
// Host-origin commands keep throwing on a bad batch, which is what the
// main-process callers already expect. Client-origin batches get a typed
// rejection object back instead, because it has to survive an IPC or HTTP
// boundary and be shown to somebody.

const RING_SIZE = 200;

// ---------- What a remote client may not do (docs/design/06 §4) ----------
// The `control` scope is "may edit the lineup", not "is the administrator".
// These stay on the host window, where the person changing them is sitting at
// the machine. The check is here rather than on the HTTP route so there is one
// list, and so it cannot be skipped by a future second remote transport.
//
// Note this is keyed on `remote`, not on `origin`: the Electron renderer is an
// origin-'client' writer too, and it is allowed all of these.
const REMOTE_DENIED_COMMANDS = {
  // Granting a plugin its declared capabilities is the single most
  // consequential thing in the app — it is what lets plugin code reach the
  // filesystem, the network or a shell. It needs a person at the host.
  'plugin.setApproval': 'Plugin permissions can only be changed on the host.',
  'plugin.setEnabled': 'Plugins can only be enabled or disabled on the host.',
  'plugin.forget': 'Plugins can only be removed on the host.',
};
// Whole settings sections a remote client may not write. `network` would let a
// remote editor turn off the very service it is connected through, or open new
// ones; `updates` chooses what code this machine installs; `pinLock` is the
// parental lock, which must not be removable from another room.
const REMOTE_DENIED_SETTINGS = {
  network: 'Network services can only be changed on the host.',
  updates: 'Update settings can only be changed on the host.',
  pinLock: 'The PIN lock can only be changed on the host.',
};

// The reason a remote client may not send this command, or null.
function remoteDenial(cmd) {
  if (!cmd || typeof cmd.type !== 'string') return null;
  if (REMOTE_DENIED_COMMANDS[cmd.type]) return REMOTE_DENIED_COMMANDS[cmd.type];
  if (cmd.type === 'settings.set' && Array.isArray(cmd.path)) {
    const denied = REMOTE_DENIED_SETTINGS[cmd.path[0]];
    if (denied) return denied;
  }
  // A structural patch names no single target, so it cannot be checked against
  // the lists above. Remote editors send named commands; the whole-config
  // transforms that produce a patch (an import, a restore, a curation run) are
  // host-side work anyway.
  if (cmd.type === 'config.patch') return 'This kind of change can only be made on the host.';
  return null;
}

// How many recent batch ids are remembered for duplicate detection. Matched to
// the ring so an id is forgotten no later than the batch it identifies.
const SEEN_IDS = RING_SIZE;

function createConfigHost({ load, save, broadcast = () => {}, loadCommands }) {
  let revision = 0;
  // { revision, commands, touches, origin, client } for an applied batch, or
  // { revision, reset: true } when config was replaced wholesale on disk (a
  // backup restore): nothing from before a reset may be replayed onto a save
  // made after it, and no client batch from before it may be applied at all.
  const ring = [];
  // batch id -> the result that batch got, so a redelivery is answered rather
  // than reapplied.
  const seen = new Map();
  let commandsModule = null;

  async function commands() {
    if (!commandsModule) commandsModule = await loadCommands();
    return commandsModule;
  }

  function remember(entry) {
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();
  }

  function rememberId(id, result) {
    if (!id) return;
    seen.set(id, result);
    while (seen.size > SEEN_IDS) seen.delete(seen.keys().next().value);
  }

  // The revision of the most recent wholesale replacement, or 0.
  function lastResetRevision() {
    return ring.reduce((found, entry) => (entry.reset ? entry.revision : found), 0);
  }

  // Entries applied after `baseRevision` by somebody other than `client`. A
  // client's own earlier commands are sequential with this one and never
  // conflict with it.
  function othersSince(baseRevision, client) {
    return ring.filter((entry) => !entry.reset && entry.revision > baseRevision
      && !(entry.origin === 'client' && client && entry.client === client));
  }

  function refuse(reason, message, extra = {}) {
    return { ok: false, reason, message, revision, ...extra };
  }

  // Why a client batch can't be applied as sent, or null when it can.
  // `touchesConflict` is the whole of the merge policy: no CRDTs, no field
  // merging — two edits either name overlapping parts of config or they
  // don't (docs/design/05 §2.3).
  function clientRefusal(batchTouchSet, meta, touchesConflict) {
    const base = meta.baseRevision;
    if (!Number.isInteger(base)) {
      return refuse('stale-window', 'This editor did not say which revision it was working from. Reload it.');
    }
    if (base > revision) {
      return refuse('stale-window', 'This editor reports a newer revision than the host has. Reload it.');
    }
    if (lastResetRevision() > base) {
      return refuse('stale-reset', 'Settings were restored from a backup on the host. Reload this editor before editing again.');
    }
    // The ring only proves safety back to its oldest entry. Older than that
    // and nothing is known about what happened in between, so the batch is
    // refused rather than guessed at.
    const oldestKept = ring.length ? ring[0].revision : revision + 1;
    if (base < oldestKept - 1 && base < revision) {
      return refuse('stale-window', 'This editor is too far behind to merge safely. Reload it.');
    }
    const clash = othersSince(base, meta.client)
      .find((entry) => touchesConflict(entry.touches || ['*'], batchTouchSet));
    if (clash) {
      return refuse('conflict', 'Another device changed this while you were editing.', {
        conflictsWith: clash.commands,
        conflictRevision: clash.revision,
      });
    }
    return null;
  }

  // Applies a batch to the config on disk, all or nothing, then saves and
  // tells every client. Returns { ok: true, revision, commands } — the same
  // payload the broadcast carries, so the caller can hand it straight to the
  // client that asked (applyHostUpdate dedupes by revision).
  //
  // meta: { source, origin: 'host' | 'client', id, baseRevision, client }.
  // A host-origin batch (the default) is trusted and throws on a bad command,
  // as its main-process callers expect. A client-origin batch is checked
  // against what other clients have done since its baseRevision and gets a
  // typed refusal back instead of an exception.
  async function applyCommands(batch, meta = {}) {
    const { applyCommand, cloneJson, batchTouches, touchesConflict } = await commands();
    const list = Array.isArray(batch) ? batch : [batch];
    const fromClient = meta.origin === 'client';

    if (meta.id && seen.has(meta.id)) return { ...seen.get(meta.id), duplicate: true };

    const config = load();
    if (config._configLoadError) {
      const message = 'Cannot edit an unreadable config';
      if (!fromClient) throw new Error(message);
      return refuse('unreadable', message);
    }

    if (meta.remote) {
      const denied = list.map(remoteDenial).find(Boolean);
      if (denied) {
        const refusal = refuse('forbidden', denied);
        rememberId(meta.id, refusal);
        return refusal;
      }
    }

    const touched = batchTouches(list);
    if (fromClient) {
      const refusal = clientRefusal(touched, meta, touchesConflict);
      if (refusal) { rememberId(meta.id, refusal); return refusal; }
    }

    const scratch = cloneJson(config);
    try {
      list.forEach((cmd) => applyCommand(scratch, cmd)); // validates the whole batch first
    } catch (e) {
      if (!fromClient) throw e;
      const refusal = refuse('invalid', e.message);
      rememberId(meta.id, refusal);
      return refusal;
    }
    list.forEach((cmd) => applyCommand(config, cmd));
    save(config);
    revision += 1;
    const update = {
      ok: true,
      revision,
      commands: cloneJson(list),
      source: meta.source || 'host',
      origin: fromClient ? 'client' : 'host',
      client: meta.client || null,
      batchId: meta.id || null,
    };
    remember({ revision, commands: update.commands, touches: touched, origin: update.origin, client: update.client });
    rememberId(meta.id, update);
    broadcast(update);
    return update;
  }

  // A client's whole-config save — still the transport for the handful of
  // edits a command can't describe (an import, a restore, the DONE flush, a
  // setting that recreates the window). baseRevision is the newest host
  // revision that client had applied when it built this config; undefined
  // means it doesn't know, and nothing is replayed (the old behaviour).
  //
  // Replaying is only sound for HOST-origin commands, which set values and so
  // survive being applied to a config that already has them. A command from
  // another client may splice an array, so it is never replayed: a save that
  // would bury one is refused instead, and the caller resyncs. In practice a
  // wholesale save follows a fresh load, so this rarely fires.
  async function reconcileSave(config, baseRevision, meta = {}) {
    let replayed = 0;
    if (Number.isInteger(baseRevision) && baseRevision < revision) {
      const { applyCommand } = await commands();
      const lastReset = ring.reduce((found, entry) => (entry.reset && entry.revision > baseRevision ? entry.revision : found), baseRevision);
      const oldestKept = ring.length ? ring[0].revision : revision + 1;
      if (lastReset === baseRevision && oldestKept > baseRevision + 1) {
        console.warn(`[config-host] save based on revision ${baseRevision} predates the ${RING_SIZE}-entry replay window; host edits older than ${oldestKept} can't be replayed`);
      }
      const others = othersSince(lastReset, meta.client).filter((entry) => entry.origin === 'client');
      if (others.length) {
        return {
          ok: false,
          reason: 'conflict',
          revision,
          message: 'Another device changed settings while this one was saving. Reload before saving again.',
          conflictsWith: others[0].commands,
        };
      }
      ring.filter((entry) => !entry.reset && entry.revision > lastReset && entry.origin !== 'client').forEach((entry) => {
        entry.commands.forEach((cmd) => {
          try {
            applyCommand(config, cmd);
            replayed += 1;
          } catch (e) {
            console.warn(`[config-host] could not replay ${cmd.type} onto a renderer save: ${e.message}`);
          }
        });
      });
    }
    save(config);
    return { ok: true, revision, replayed };
  }

  // Config on disk was replaced outside the command path (backup restore).
  // Batch ids from before it are forgotten too: a client retrying one must be
  // told the ground moved, not handed the answer it would have got.
  function noteReset() {
    revision += 1;
    remember({ revision, reset: true });
    seen.clear();
    return revision;
  }

  return {
    applyCommands,
    reconcileSave,
    noteReset,
    getRevision: () => revision,
    // Config and the revision it is at, read together. A client resyncing has
    // to have both from the same instant: taking them in two calls leaves a
    // window where a command lands in between, and the client then either
    // replays it onto a config that already has it or misses it entirely.
    // Main is single-threaded, so reading them in one call is that instant.
    snapshot: () => ({ config: load(), revision }),
    // What a client needs to start talking to this host.
    describeState: () => ({ revision, pending: ring.length }),
  };
}

// ---------- Telling LAN clients that config changed (doc 05, step 4) ----------
// Paired viewers (browsers, the Android TV client) used to find out about host
// edits only by re-downloading the whole config every 10 s. A write now
// announces itself on the viewer event bus instead — but only when something a
// viewer would care about changed. These fields are the host's own watching
// state, rewritten on every channel change or volume tap; a viewer keeps its
// own, so announcing them would make every TV refetch the whole lineup each
// time someone surfs on the host.
const HOST_LOCAL_FIELDS = ['lastChannel', 'muted', 'volume', 'pictureMode', 'aspectMode'];
const HOST_LOCAL_DISPLAY_FIELDS = ['hintBar'];

function viewerRelevantKey(config, hash) {
  const rest = { ...config };
  HOST_LOCAL_FIELDS.forEach((key) => { delete rest[key]; });
  if (rest.display && typeof rest.display === 'object') {
    rest.display = { ...rest.display };
    HOST_LOCAL_DISPLAY_FIELDS.forEach((key) => { delete rest.display[key]; });
  }
  return hash(JSON.stringify(rest));
}

// notify() is called only when a write changed something viewer-relevant.
function createChangeAnnouncer({ hash, notify }) {
  let lastKey = null;
  return {
    // Adopt what's on disk at boot without announcing it.
    prime(config) { lastKey = viewerRelevantKey(config, hash); },
    written(config) {
      const key = viewerRelevantKey(config, hash);
      if (key === lastKey) return false;
      lastKey = key;
      notify();
      return true;
    },
  };
}

module.exports = {
  createConfigHost, createChangeAnnouncer, viewerRelevantKey, remoteDenial,
  RING_SIZE, HOST_LOCAL_FIELDS, REMOTE_DENIED_COMMANDS, REMOTE_DENIED_SETTINGS,
};
