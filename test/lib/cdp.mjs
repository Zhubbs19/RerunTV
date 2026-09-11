// Minimal Chrome DevTools Protocol client for driving the packaged/dev
// RerunTV Electron app over its --remote-debugging-port. No npm
// dependencies — Node 22's built-in `fetch` and `WebSocket` are enough.
//
// This intentionally only implements the handful of CDP domains the UI test
// suite actually needs (Page.captureScreenshot, Runtime.evaluate,
// Input.dispatchMouseEvent). It is NOT a general-purpose CDP client.

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

export async function waitForTarget(port, { timeoutMs = 20000, titleIncludes = 'RerunTV' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const targets = await listTargets(port);
      const page = targets.find((t) => t.type === 'page' && t.title && t.title.includes(titleIncludes));
      if (page) return page;
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error(`No CDP target with title including "${titleIncludes}" appeared within ${timeoutMs}ms (${lastErr ? lastErr.message : 'no targets seen'})`);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Thin request/response + event wrapper around one page's CDP WebSocket.
export class CdpSession {
  constructor(webSocketDebuggerUrl) {
    this.url = webSocketDebuggerUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventListeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error(`CDP WebSocket error: ${e.message || e}`)));
      this.ws.addEventListener('message', (event) => this._onMessage(event));
    });
  }

  _onMessage(event) {
    const msg = JSON.parse(event.data);
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const listeners = this.eventListeners.get(msg.method);
      if (listeners) listeners.forEach((fn) => fn(msg.params));
    }
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.eventListeners.has(method)) this.eventListeners.set(method, []);
    this.eventListeners.get(method).push(fn);
  }

  close() {
    try { this.ws.close(); } catch (e) { /* already closed */ }
  }

  // Evaluates an expression in the page's main world and returns its
  // (structured-cloned) value. Throws if the page-side expression throws.
  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error(`Page threw during evaluate: ${desc || JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result.value;
  }

  // Plain viewport screenshot. The app's own document/body never grows
  // taller than the window (#setup-screen is an internal overflow-y:auto
  // pane sized to fit it, not normal document flow) so a CDP full-page
  // clip does nothing useful here - the caller is expected to scroll that
  // inner pane itself and take additional shots for anything below the
  // fold (see scrollAndShot, run-ui-tests.mjs).
  async screenshot(outPath, { format = 'png' } = {}) {
    const { data } = await this.send('Page.captureScreenshot', { format, captureBeyondViewport: false });
    const fs = await import('node:fs/promises');
    await fs.writeFile(outPath, Buffer.from(data, 'base64'));
  }
}

export async function connectToApp(port, opts) {
  const target = await waitForTarget(port, opts);
  const session = new CdpSession(target.webSocketDebuggerUrl);
  await session.connect();
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  return session;
}
