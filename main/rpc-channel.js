// Minimal symmetric request/response + fire-and-forget event channel over any
// postMessage-shaped transport. Used on BOTH sides of an isolated plugin's
// utilityProcess boundary (main-plugin-isolation.js on the host side,
// plugin-isolation-runtime.js inside the forked process) — same helper, same
// message shape, so either side can `.request()` something FROM the other
// side and `.handle()`/`.on()` something FROM the other side, without two
// different implementations to keep in sync.
//
// Message envelope (always a plain object, safe to pass straight to
// Electron's utilityProcess postMessage / process.parentPort.postMessage,
// which structured-clones — Buffers/arrays/plain objects all pass through
// untouched, functions do not and must never appear in a payload):
//   { kind: 'req', id, method, payload }              -- expects a 'res' back
//   { kind: 'res', id, ok, result }  |  { kind:'res', id, ok:false, error }
//   { kind: 'evt', method, payload }                   -- fire-and-forget
//
// options.timeoutMs bounds how long request() waits for a 'res' before
// rejecting on its own — without this, a request in flight when the other
// side's process dies (crash, forced kill) would hang forever, since
// nothing would ever deliver the matching 'res'. Every real caller on this
// channel (a proxied ipcMain.handle, a cross-plugin service call, a party
// route dispatch) is expected to settle in well under this; the default is
// generous headroom above fetchJsonCached's own internal 8s timeout, the
// slowest thing actually routed over this channel.
const DEFAULT_TIMEOUT_MS = 20000;

function createRpc(post, subscribe, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let nextId = 1;
  let disposed = false;
  const pending = new Map(); // id -> {resolve, reject, timer}
  const handlers = new Map(); // method -> async (payload) => result
  const listeners = new Map(); // method -> (payload) => void

  const settlePending = (id, fn) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    fn(p);
  };

  subscribe((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'res') {
      settlePending(msg.id, (p) => {
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(msg.error || 'RPC call failed'));
      });
      return;
    }
    if (msg.kind === 'req') {
      const handler = handlers.get(msg.method);
      Promise.resolve()
        .then(() => {
          if (!handler) throw new Error(`No RPC handler registered for "${msg.method}"`);
          return handler(msg.payload);
        })
        .then((result) => post({ kind: 'res', id: msg.id, ok: true, result }))
        .catch((err) => post({ kind: 'res', id: msg.id, ok: false, error: (err && err.message) || String(err) }));
      return;
    }
    if (msg.kind === 'evt') {
      const listener = listeners.get(msg.method);
      if (!listener) return;
      // A synchronous throw here (some listener's own bug) must not become
      // an unhandled exception inside this subscribe() callback — the 'req'
      // branch above already gets this protection for free via
      // Promise.resolve().then(); this branch has no promise chain of its
      // own to catch into, so it needs an explicit try/catch instead.
      try { listener(msg.payload); } catch (e) { /* one bad listener shouldn't take the channel down */ }
    }
  });

  return {
    // Sends a request to the other side and resolves/rejects with its reply,
    // or rejects on its own after timeoutMs if no reply ever arrives.
    request(method, payload) {
      if (disposed) return Promise.reject(new Error('RPC channel closed'));
      return new Promise((resolve, reject) => {
        const id = nextId += 1;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        post({ kind: 'req', id, method, payload });
      });
    },
    // Fire-and-forget — no reply expected, nothing to await.
    emit(method, payload) { if (!disposed) post({ kind: 'evt', method, payload }); },
    // Registers what THIS side does when the other side sends a request for
    // `method` — return value (or thrown error) becomes the 'res' reply.
    handle(method, fn) { handlers.set(method, fn); },
    // Registers what THIS side does when the other side emits `method`.
    on(method, fn) { listeners.set(method, fn); },
    // Call when the transport is known to be gone (e.g. the other side's
    // process exited) — immediately rejects every still-in-flight request()
    // instead of waiting out their individual timeouts, and makes any
    // request() called after this point reject right away.
    dispose(reason) {
      if (disposed) return;
      disposed = true;
      const err = new Error(reason || 'RPC channel closed');
      pending.forEach((p) => { clearTimeout(p.timer); p.reject(err); });
      pending.clear();
    },
  };
}

module.exports = { createRpc };
