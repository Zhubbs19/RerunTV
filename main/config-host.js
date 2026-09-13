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
// Electron-free and storage-agnostic on purpose: load/save/broadcast and the
// command module are injected, so tests can drive it directly.

const RING_SIZE = 200;

function createConfigHost({ load, save, broadcast = () => {}, loadCommands }) {
  let revision = 0;
  // { revision, commands } for an applied batch, or { revision, reset: true }
  // when config was replaced wholesale on disk (a backup restore): nothing
  // from before a reset may be replayed onto a save made after it.
  const ring = [];
  let commandsModule = null;

  async function commands() {
    if (!commandsModule) commandsModule = await loadCommands();
    return commandsModule;
  }

  function remember(entry) {
    ring.push(entry);
    if (ring.length > RING_SIZE) ring.shift();
  }

  // Applies a batch to the config on disk, all or nothing, then saves and
  // tells every renderer. Returns { revision, commands } — the same payload
  // the broadcast carries, so the caller can hand it straight to the
  // renderer that asked (applyHostUpdate dedupes by revision).
  async function applyCommands(batch, meta = {}) {
    const { applyCommand, cloneJson } = await commands();
    const list = Array.isArray(batch) ? batch : [batch];
    const config = load();
    if (config._configLoadError) throw new Error('Cannot edit an unreadable config');
    const scratch = cloneJson(config);
    list.forEach((cmd) => applyCommand(scratch, cmd)); // validates the whole batch first
    list.forEach((cmd) => applyCommand(config, cmd));
    save(config);
    revision += 1;
    const update = { revision, commands: cloneJson(list), source: meta.source || 'host' };
    remember({ revision, commands: update.commands });
    broadcast(update);
    return update;
  }

  // A renderer's whole-config save. baseRevision is the newest host revision
  // that renderer had applied when it built this config; undefined means it
  // doesn't know, and nothing is replayed (the old behaviour).
  async function reconcileSave(config, baseRevision) {
    let replayed = 0;
    if (Number.isInteger(baseRevision) && baseRevision < revision) {
      const { applyCommand } = await commands();
      const lastReset = ring.reduce((found, entry) => (entry.reset && entry.revision > baseRevision ? entry.revision : found), baseRevision);
      const oldestKept = ring.length ? ring[0].revision : revision + 1;
      if (lastReset === baseRevision && oldestKept > baseRevision + 1) {
        console.warn(`[config-host] save based on revision ${baseRevision} predates the ${RING_SIZE}-entry replay window; host edits older than ${oldestKept} can't be replayed`);
      }
      ring.filter((entry) => !entry.reset && entry.revision > lastReset).forEach((entry) => {
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
    return { revision, replayed };
  }

  // Config on disk was replaced outside the command path (backup restore).
  function noteReset() {
    revision += 1;
    remember({ revision, reset: true });
    return revision;
  }

  return {
    applyCommands,
    reconcileSave,
    noteReset,
    getRevision: () => revision,
  };
}

module.exports = { createConfigHost, RING_SIZE };
