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
function createRpc(post, subscribe) {
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, reject}
  const handlers = new Map(); // method -> async (payload) => result
  const listeners = new Map(); // method -> (payload) => void

  subscribe((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'res') {
      const p = pending.get(msg.id);
      if (!p) return; // stale/duplicate — nothing to resolve
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || 'RPC call failed'));
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
      if (listener) listener(msg.payload);
    }
  });

  return {
    // Sends a request to the other side and resolves/rejects with its reply.
    request(method, payload) {
      return new Promise((resolve, reject) => {
        const id = nextId += 1;
        pending.set(id, { resolve, reject });
        post({ kind: 'req', id, method, payload });
      });
    },
    // Fire-and-forget — no reply expected, nothing to await.
    emit(method, payload) { post({ kind: 'evt', method, payload }); },
    // Registers what THIS side does when the other side sends a request for
    // `method` — return value (or thrown error) becomes the 'res' reply.
    handle(method, fn) { handlers.set(method, fn); },
    // Registers what THIS side does when the other side emits `method`.
    on(method, fn) { listeners.set(method, fn); },
  };
}

module.exports = { createRpc };
