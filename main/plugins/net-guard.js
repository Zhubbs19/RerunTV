// Limits an isolated plugin's own outbound connections to the sites its
// manifest declares in capabilities.internet (see capabilities.js). Runs
// inside the plugin's forked process (isolation-runtime.js installs it before
// the plugin's main.js is required), so it covers every way that process can
// open a connection: net, tls, http/https and fetch all end in
// net.Socket#connect, and UDP goes through dgram.
//
// How far this goes, honestly: it is a check in the plugin's own JavaScript,
// not an OS wall. The patched methods are locked (non-writable,
// non-configurable) so the plugin can't put the originals back, and Node's
// permission model (isolation.js's execArgv) already refuses the usual ways
// around it: native addons, worker threads, and child processes the plugin
// didn't declare. A program the plugin is allowed to spawn is a separate
// process and is not limited by this. A plugin that declares no internet
// permission at all is not limited either; the approval prompt says so.
const net = require('net');
const dgram = require('dgram');
const { hostAllowed } = require('./capabilities');

// Where a net.Socket#connect call is going. Its arguments come in three
// shapes, (options, cb), (port, host, cb) and (path, cb), plus Node's own
// internal form, an array holding the already-normalized options.
function connectTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) [first] = first;
  if (first && typeof first === 'object') {
    if (first.path) return { pipe: true };
    return { host: first.host || 'localhost' };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { pipe: true };
  return { host: typeof args[1] === 'string' && args[1] ? args[1] : 'localhost' };
}

// The address a dgram send/connect is going to: the first string argument
// after the port. A send's message can itself be a string, so the scan
// starts after it.
function udpTarget(args, startAt) {
  for (let i = startAt; i < args.length; i++) {
    if (typeof args[i] === 'string') return args[i];
  }
  return 'localhost';
}

function blockedError(pluginId, host) {
  const err = new Error(`Plugin "${pluginId}" may not connect to ${host}: it isn't one of the sites in its manifest's capabilities.internet.`);
  err.code = 'ERR_PLUGIN_HOST_NOT_ALLOWED';
  return err;
}

function lock(proto, name, value) {
  Object.defineProperty(proto, name, { value, writable: false, configurable: false, enumerable: false });
}

// `patterns` null means the plugin declared nothing and isn't limited, but
// its connections are still reported. `onActivity(host, allowed)` is called
// for every attempt.
function installNetGuard({ pluginId, patterns, onActivity }) {
  const report = typeof onActivity === 'function' ? onActivity : () => {};
  const check = (host) => {
    const allowed = patterns ? hostAllowed(host, patterns) : true;
    report(host, allowed);
    return allowed;
  };

  const realConnect = net.Socket.prototype.connect;
  lock(net.Socket.prototype, 'connect', function guardedConnect(...args) {
    const target = connectTarget(args);
    if (!target.pipe && !check(target.host)) {
      // Fail the way a refused connection fails: asynchronously, through the
      // socket's own 'error' event, so callers' existing handling applies.
      process.nextTick(() => this.destroy(blockedError(pluginId, target.host)));
      return this;
    }
    return realConnect.apply(this, args);
  });

  const realSend = dgram.Socket.prototype.send;
  lock(dgram.Socket.prototype, 'send', function guardedSend(...args) {
    const host = udpTarget(args, 1);
    if (!check(host)) {
      const cb = args.find((a) => typeof a === 'function');
      const err = blockedError(pluginId, host);
      if (cb) process.nextTick(() => cb(err)); else process.nextTick(() => this.emit('error', err));
      return undefined;
    }
    return realSend.apply(this, args);
  });

  if (typeof dgram.Socket.prototype.connect === 'function') {
    const realUdpConnect = dgram.Socket.prototype.connect;
    lock(dgram.Socket.prototype, 'connect', function guardedUdpConnect(...args) {
      const host = udpTarget(args, 1);
      if (!check(host)) {
        process.nextTick(() => this.emit('error', blockedError(pluginId, host)));
        return undefined;
      }
      return realUdpConnect.apply(this, args);
    });
  }
}

// Collects connection attempts and hands them to `flush` in batches: allowed
// ones every few seconds, a blocked one straight away, so the activity view
// and the log show a refusal as it happens.
function createActivityBatcher(flush, intervalMs = 3000) {
  let pending = new Map(); // "host|allowed" -> { host, allowed, count }
  let timer = null;
  const send = () => {
    timer = null;
    if (!pending.size) return;
    const batch = [...pending.values()];
    pending = new Map();
    flush(batch);
  };
  return (host, allowed) => {
    const key = `${host}|${allowed}`;
    const entry = pending.get(key) || { host, allowed, count: 0 };
    entry.count += 1;
    pending.set(key, entry);
    if (!allowed) { if (timer) clearTimeout(timer); send(); return; }
    if (!timer) timer = setTimeout(send, intervalMs);
  };
}

module.exports = {
  installNetGuard, createActivityBatcher, connectTarget, udpTarget,
};
