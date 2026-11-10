// ---------- Companion: on-screen navigation and calendar routes ----------
// The routes that let the phone see and drive whatever is on the box's screen
// (GET/POST /api/ui) and edit a channel's schedule CALENDAR (GET/POST
// /api/calendar, POST /api/calendar/folder). Split out of main.js so they can
// be tested with plain fakes (tests/companion-control.test.js): main.js hands
// in everything that touches Electron, the disk or the config host.
//
// Two ways things reach the box:
// - Reading the screen, and anything that needs the renderer's schedule
//   resolution, is a question to the renderer (createQueryBroker below). The
//   question rides the existing `remote:command` IPC channel and the answer
//   the existing `remote:state` one (renderer/js/remote/companion-control.js),
//   so this plugin needs no new IPC capability and no preload change.
// - Calendar edits are config commands applied by the config host as a
//   remote client batch (calendar-ops.js builds them), the same writer the
//   LAN control panel uses. The deny-lists in main/config/host.js apply.

const { calendarCommands, blocksForPhone } = require('./calendar-ops');

// How long a question to the renderer may take before the phone is told the
// box didn't answer.
const QUERY_TIMEOUT_MS = 4000;
const UI_OPS = ['activate', 'focus', 'set', 'text'];

/**
 * Asks the renderer questions and matches up its answers by id.
 * @param {object} deps Dependencies.
 * @param {(message: object) => boolean} deps.send Sends `{ action: 'companion-query', id, kind, args }` to the renderer; false when there is none.
 * @param {number} [deps.timeoutMs] How long to wait for an answer.
 * @returns {object} `{ ask, receive, pendingCount }`.
 */
function createQueryBroker({ send, timeoutMs = QUERY_TIMEOUT_MS }) {
  const pending = new Map();
  let seq = 0;
  /**
   * Asks the renderer one question.
   * @param {string} kind The question (`ui.snapshot`, `ui.act`, `calendar.month`, `calendar.setFolder`).
   * @param {object} [args={}] Its arguments.
   * @returns {Promise<*>} The answer, or undefined when no renderer is running. Rejects when the renderer reports an error or doesn't answer in time.
   */
  function ask(kind, args = {}) {
    seq += 1;
    const id = `cq${seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error("The box didn't answer in time."), { status: 504 }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      let sent;
      try { sent = send({ action: 'companion-query', id, kind, args }); } catch (e) { sent = false; }
      if (!sent) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(undefined);
      }
    });
  }
  /**
   * Settles the question an answer belongs to.
   * @param {object} reply `{ id, ok, result, error }` from the renderer.
   * @returns {boolean} True when it matched a pending question.
   */
  function receive(reply) {
    const entry = reply && pending.get(reply.id);
    if (!entry) return false;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.result);
    else entry.reject(Object.assign(new Error(String(reply.error || 'The box could not do that.')), { status: 409 }));
    return true;
  }
  return { ask, receive, pendingCount: () => pending.size };
}

/**
 * Writes a JSON response.
 * @param {http.ServerResponse} res The response.
 * @param {number} status The HTTP status.
 * @param {*} body The body, serialized as JSON.
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
}

/**
 * Maps a config host refusal to an HTTP status.
 * @param {object} refusal `{ reason }` from configHost.applyCommands.
 * @returns {number} 403, 400 or 409.
 */
function refusalStatus(refusal) {
  if (refusal.reason === 'forbidden') return 403;
  if (refusal.reason === 'invalid' || refusal.reason === 'unreadable') return 400;
  return 409;
}

/**
 * Checks a POST /api/ui body.
 * @param {*} body The parsed body.
 * @returns {object} `{ args }` to pass to the renderer, or `{ error }`.
 */
function cleanUiAction(body) {
  if (!body || !UI_OPS.includes(body.op)) return { error: `op is one of ${UI_OPS.join(', ')}.` };
  const args = { op: body.op };
  if (body.op !== 'text') {
    if (!Number.isInteger(body.snapshot) || !Number.isInteger(body.index) || body.index < 0) {
      return { error: 'snapshot and index from GET /api/ui are required.' };
    }
    args.snapshot = body.snapshot;
    args.index = body.index;
  } else if (Number.isInteger(body.snapshot) && Number.isInteger(body.index)) {
    // Text for a listed field rather than whichever one has focus.
    args.snapshot = body.snapshot;
    args.index = body.index;
  }
  if (body.op === 'set') {
    const ok = ['string', 'number', 'boolean'].includes(typeof body.value);
    if (!ok) return { error: 'value must be a string, number or boolean.' };
    if (typeof body.value === 'string' && body.value.length > 2000) return { error: 'value is too long.' };
    args.value = body.value;
  }
  if (body.op === 'text') {
    if (typeof body.text !== 'string' || body.text.length > 2000) return { error: 'text is a string of up to 2000 characters.' };
    args.text = body.text;
    args.submit = !!body.submit;
  }
  return { args };
}

/**
 * Builds the request handler for the navigation and calendar routes.
 * @param {object} deps Dependencies.
 * @param {Function} deps.ask The query broker's `ask`.
 * @param {() => Promise<object>|object} deps.loadConfig Reads the config from disk.
 * @param {Function} deps.applyCommands The config host's applyCommands, already forced to a remote client batch.
 * @param {() => number} deps.getRevision The config host's current revision.
 * @param {Function} deps.readJsonBody Parses a JSON request body.
 * @param {(config: object) => Array<object>} deps.buildRoots The browsable channel folders.
 * @param {(root: object, rel: string) => ?string} deps.resolveWithinRoot Resolves a path inside a root.
 * @param {(absPath: string) => boolean} deps.isDirectory Whether a path is a folder.
 * @param {(req: object) => string} deps.clientFor This phone's client id, for conflict checks.
 * @returns {(req: object, res: object, url: URL) => Promise<boolean>} Resolves true when it answered the request.
 */
function createControlRoutes(deps) {
  const { ask, loadConfig, applyCommands, getRevision, readJsonBody, buildRoots, resolveWithinRoot, isDirectory, clientFor } = deps;

  async function uiRoutes(req, res) {
    if (req.method === 'GET') {
      const snapshot = await ask('ui.snapshot', {});
      if (snapshot === undefined) { sendJson(res, 503, { error: 'The box has no screen running.' }); return; }
      sendJson(res, 200, snapshot);
      return;
    }
    const checked = cleanUiAction(await readJsonBody(req));
    if (checked.error) { sendJson(res, 400, { error: checked.error }); return; }
    const result = await ask('ui.act', checked.args);
    if (result === undefined) { sendJson(res, 503, { error: 'The box has no screen running.' }); return; }
    sendJson(res, 200, result);
  }

  async function calendarRead(res, url) {
    const number = Number(url.searchParams.get('channel'));
    const config = await loadConfig();
    const ch = (config.channels || []).find((c) => c && c.number === number);
    if (!ch) { sendJson(res, 404, { error: 'No channel has that number.' }); return; }
    const year = Number(url.searchParams.get('year'));
    const month = Number(url.searchParams.get('month'));
    const args = { channel: number };
    if (Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12) Object.assign(args, { year, month });
    let monthView;
    try {
      monthView = (await ask('calendar.month', args)) || null;
    } catch (e) {
      monthView = null; // the blocks below still let the phone edit
    }
    sendJson(res, 200, {
      channel: { number: ch.number, name: ch.name || '' },
      revision: getRevision(),
      blocks: blocksForPhone(ch),
      // Null on a box with no renderer (headless): the days can't be worked
      // out there, but every block is still listed and editable.
      month: monthView,
    });
  }

  async function calendarWrite(req, res) {
    const body = await readJsonBody(req);
    if (!body || !Number.isFinite(body.channel)) { sendJson(res, 400, { error: 'channel is required.' }); return; }
    const built = calendarCommands(await loadConfig(), body.channel, body.ops);
    if (built.error) { sendJson(res, built.status, { error: built.error }); return; }
    const applied = await applyCommands(built.commands, {
      source: 'companion',
      client: clientFor(req),
      baseRevision: body.baseRevision,
      id: typeof body.id === 'string' ? body.id.slice(0, 80) : undefined,
    });
    if (!applied || !applied.ok) {
      sendJson(res, refusalStatus(applied || {}), { error: (applied && applied.message) || 'The box refused that change.', reason: applied && applied.reason });
      return;
    }
    sendJson(res, 200, { ok: true, revision: applied.revision, created: built.created });
  }

  async function calendarFolder(req, res) {
    const body = await readJsonBody(req);
    if (!body || !Number.isFinite(body.channel) || typeof body.blockId !== 'string') {
      sendJson(res, 400, { error: 'channel and blockId are required.' });
      return;
    }
    const config = await loadConfig();
    const root = buildRoots(config).find((r) => r.id === String(body.root));
    const folder = root && resolveWithinRoot(root, typeof body.path === 'string' ? body.path : '');
    if (!folder || !isDirectory(folder)) { sendJson(res, 400, { error: 'Pick a folder inside one of your channel folders.' }); return; }
    const result = await ask('calendar.setFolder', { channel: body.channel, blockId: body.blockId, folder });
    if (result === undefined) { sendJson(res, 503, { error: 'Choosing a folder needs the box running with its screen.' }); return; }
    sendJson(res, 202, result);
  }

  return async function handle(req, res, url) {
    const route = url.pathname;
    const known = (route === '/api/ui' && (req.method === 'GET' || req.method === 'POST'))
      || (route === '/api/calendar' && (req.method === 'GET' || req.method === 'POST'))
      || (route === '/api/calendar/folder' && req.method === 'POST');
    if (!known) return false;
    try {
      if (route === '/api/ui') await uiRoutes(req, res);
      else if (route === '/api/calendar' && req.method === 'GET') await calendarRead(res, url);
      else if (route === '/api/calendar') await calendarWrite(req, res);
      else await calendarFolder(req, res);
    } catch (e) {
      if (!res.headersSent) sendJson(res, e && e.status ? e.status : 400, { error: (e && e.message) || 'Bad request' });
    }
    return true;
  };
}

module.exports = { createControlRoutes, createQueryBroker, cleanUiAction, QUERY_TIMEOUT_MS };
