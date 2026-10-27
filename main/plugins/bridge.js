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

function record(pluginId) {
  if (!activity.has(pluginId)) {
    activity.set(pluginId, {
      calls: 0, refused: 0, lastCallAt: null, hosts: new Map(), blocked: new Map(),
    });
  }
  return activity.get(pluginId);
}

function registerPluginHandler(pluginId, channel, call) {
  handlers.set(channel, { pluginId, call });
}

function registerPluginFallback(pluginId, channel, value) {
  fallbacks.set(channel, { pluginId, value });
}

// A plugin process that exits can't answer any more; its channels go back to
// being refused (or answered by fallback, if it declared one).
function unregisterPlugin(pluginId) {
  handlers.forEach((entry, channel) => { if (entry.pluginId === pluginId) handlers.delete(channel); });
}

function bump(map, host, count, at) {
  const entry = map.get(host) || { count: 0, lastAt: null };
  entry.count += count;
  entry.lastAt = at;
  map.set(host, entry);
  // Bounded: a plugin hammering thousands of distinct hosts keeps its most
  // recent ones.
  if (map.size > MAX_HOSTS) map.delete(map.keys().next().value);
}

// `batch` is [{ host, allowed, count }] (net-guard.js's batcher). Returns the
// blocked entries so the caller can log them.
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

// The answer to one renderer call. Exported for tests; registerBridgeIpc
// wires it to 'plugins:invoke'.
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

// A plugin's message to the window, relayed with its sender's id.
function eventEnvelope(pluginId, channel, data) {
  return { pluginId, channel: String(channel), data };
}

function registerBridgeIpc(ipcMain) {
  ipcMain.handle('plugins:invoke', (event, pluginId, channel, args) => invoke(event, pluginId, channel, args));
  ipcMain.handle('plugins:activity', async (event, pluginId) => getActivity(String(pluginId || '')));
}

function resetForTests() {
  handlers.clear();
  fallbacks.clear();
  activity.clear();
}

module.exports = {
  registerPluginHandler, registerPluginFallback, unregisterPlugin, recordNetwork, getActivity,
  invoke, eventEnvelope, registerBridgeIpc, resetForTests,
};
