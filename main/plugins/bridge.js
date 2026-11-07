// The generic plugin bridge: one way for any plugin's on-screen code to reach
// its own main-process code, so a locally installed plugin needs no named
// bridge in preload.js (and so no core release) of its own.
//
//   renderer: window.api.pluginInvoke(pluginId, channel, ...args)
//             (plugins use ctx.ipc.invoke, renderer/js/plugin/host.js)
//   main:     'plugins:invoke' looks the channel up here and calls it
//
// A call only goes through to a handler that the plugin registered itself,
// through its capability-checked ctx.ipcMain, for a channel its manifest
// declares and the user approved (plugins.js / isolation.js record it here
// at that point). A disabled or unapproved plugin answers with its own
// manifest fallbackIpc value, the same as its named channels do. Anything
// else is refused. Messages a plugin's main side sends to the window are
// also relayed on 'plugins:event', tagged here (not by the plugin) with the
// id of the plugin that sent them.
//
// This file also keeps each plugin's activity since the app started (bridge
// calls, refused calls, the sites it connected to and any it was blocked
// from), for the activity view on its PLUGINS page. It is kept in memory
// only.

const handlers = new Map(); // channel -> { pluginId, call(event, args) }
const fallbacks = new Map(); // channel -> { pluginId, value }
const activity = new Map(); // pluginId -> record

const MAX_HOSTS = 50;

/**
 * Returns a plugin's activity record, creating an empty one the first time.
 * @param {string} pluginId The plugin id.
 * @returns {object} `{ calls, refused, lastCallAt, hosts, blocked }`.
 */
function record(pluginId) {
  if (!activity.has(pluginId)) {
    activity.set(pluginId, {
      calls: 0, refused: 0, lastCallAt: null, hosts: new Map(), blocked: new Map(),
    });
  }
  return activity.get(pluginId);
}

/**
 * Records the handler a running plugin registered for a bridge channel.
 * @param {string} pluginId The plugin that owns the channel.
 * @param {string} channel The channel name.
 * @param {Function} call Called with `(event, args)` to answer an invoke.
 */
function registerPluginHandler(pluginId, channel, call) {
  handlers.set(channel, { pluginId, call });
}

/**
 * Records the manifest fallback value a disabled or unapproved plugin answers with.
 * @param {string} pluginId The plugin that owns the channel.
 * @param {string} channel The channel name.
 * @param {*} value The JSON value to answer with.
 */
function registerPluginFallback(pluginId, channel, value) {
  fallbacks.set(channel, { pluginId, value });
}

/**
 * A plugin process that exits can't answer any more; its channels go back to
 * being refused (or answered by fallback, if it declared one).
 * @param {string} pluginId The plugin whose handlers to drop.
 */
function unregisterPlugin(pluginId) {
  handlers.forEach((entry, channel) => { if (entry.pluginId === pluginId) handlers.delete(channel); });
}

/**
 * Adds to one host's count in a bounded host map.
 * @param {Map} map The host map (`hosts` or `blocked`).
 * @param {string} host The host name.
 * @param {number} count How many connections to add.
 * @param {number} at The timestamp to record as the latest.
 */
function bump(map, host, count, at) {
  const entry = map.get(host) || { count: 0, lastAt: null };
  entry.count += count;
  entry.lastAt = at;
  map.set(host, entry);
  // Bounded: a plugin hammering thousands of distinct hosts keeps its most
  // recent ones.
  if (map.size > MAX_HOSTS) map.delete(map.keys().next().value);
}

/**
 * `batch` is [{ host, allowed, count }] (net-guard.js's batcher). Returns the
 * blocked entries so the caller can log them.
 * @param {string} pluginId The plugin the batch came from.
 * @param {Array<object>} batch The batched connection attempts.
 * @returns {string[]} The hosts that were blocked.
 */
function recordNetwork(pluginId, batch) {
  const rec = record(pluginId);
  const at = Date.now();
  const blocked = [];
  (Array.isArray(batch) ? batch : []).forEach((e) => {
    if (!e || typeof e.host !== 'string') return;
    const host = e.host.slice(0, 255);
    const count = Math.max(1, Math.min(1e6, Number(e.count) || 1));
    if (e.allowed) bump(rec.hosts, host, count, at);
    else { bump(rec.blocked, host, count, at); blocked.push(host); }
  });
  return blocked;
}

/**
 * Summarizes a plugin's activity since the app started, hosts sorted by count.
 * @param {string} pluginId The plugin id.
 * @returns {object} `{ calls, refused, lastCallAt, hosts, blocked }` with host lists as arrays.
 */
function getActivity(pluginId) {
  const rec = activity.get(pluginId);
  const list = (map) => [...map.entries()]
    .map(([host, e]) => ({ host, count: e.count, lastAt: e.lastAt }))
    .sort((a, b) => b.count - a.count);
  return {
    calls: rec ? rec.calls : 0,
    refused: rec ? rec.refused : 0,
    lastCallAt: rec ? rec.lastCallAt : null,
    hosts: rec ? list(rec.hosts) : [],
    blocked: rec ? list(rec.blocked) : [],
  };
}

/**
 * The answer to one renderer call. Exported for tests; registerBridgeIpc
 * wires it to 'plugins:invoke'.
 * @param {object} event The IPC event.
 * @param {string} pluginId The plugin the call is addressed to.
 * @param {string} channel The channel name.
 * @param {Array} args The call's arguments.
 * @returns {Promise<*>} The handler's result, or a copy of the fallback value.
 * @throws {Error} When the ids are missing or the plugin has no handler or fallback for the channel.
 */
async function invoke(event, pluginId, channel, args) {
  if (typeof pluginId !== 'string' || typeof channel !== 'string' || !pluginId || !channel) {
    throw new Error('pluginInvoke needs a plugin id and a channel name.');
  }
  const argList = Array.isArray(args) ? args : [];
  const handler = handlers.get(channel);
  if (handler && handler.pluginId === pluginId) {
    const rec = record(pluginId);
    rec.calls += 1;
    rec.lastCallAt = Date.now();
    return handler.call(event, argList);
  }
  const fallback = fallbacks.get(channel);
  if (fallback && fallback.pluginId === pluginId) return JSON.parse(JSON.stringify(fallback.value));
  record(pluginId).refused += 1;
  throw new Error(`Plugin "${pluginId}" has no approved, running handler for "${channel}".`);
}

/**
 * A plugin's message to the window, relayed with its sender's id.
 * @param {string} pluginId The sending plugin.
 * @param {string} channel The event channel.
 * @param {*} data The payload.
 * @returns {object} `{ pluginId, channel, data }`.
 */
function eventEnvelope(pluginId, channel, data) {
  return { pluginId, channel: String(channel), data };
}

/**
 * Registers the `plugins:invoke` and `plugins:activity` IPC handlers.
 * @param {object} ipcMain Electron's `ipcMain`.
 */
function registerBridgeIpc(ipcMain) {
  ipcMain.handle('plugins:invoke', (event, pluginId, channel, args) => invoke(event, pluginId, channel, args));
  ipcMain.handle('plugins:activity', async (event, pluginId) => getActivity(String(pluginId || '')));
}

/**
 * Clears every handler, fallback and activity record.
 */
function resetForTests() {
  handlers.clear();
  fallbacks.clear();
  activity.clear();
}

module.exports = {
  registerPluginHandler, registerPluginFallback, unregisterPlugin, recordNetwork, getActivity,
  invoke, eventEnvelope, registerBridgeIpc, resetForTests,
};
