// Shutting the PC down from inside RerunTV: SYSTEM › POWER, the TV menu's
// SYSTEM section, the box's own power-off (when the setting asks for it) and
// the companion remote's SHUT DOWN PC button.
//
// One countdown lives here in the main process, so the host window and every
// paired remote see the same deadline and any of them can cancel it. Off until
// config.pcPower.enabled is switched on (SYSTEM › POWER): a request that
// arrives while it is off is refused, which is also what keeps a remote from
// shutting a box down whose owner never opted in.
//
// Windows hands the countdown to the OS (`shutdown /s /t N`, undone with
// `shutdown /a`), so a RerunTV crash mid-countdown still ends in the shutdown
// the user asked for. macOS and Linux have no cancellable OS timer that works
// without a password prompt, so there the timer runs here and the OS command
// is sent only when it expires.
const { execFile: nodeExecFile } = require('child_process');

const DEFAULT_DELAY_SEC = 20;
const MIN_DELAY_SEC = 5;
const MAX_DELAY_SEC = 120;

// ---------- Pure ----------

function clampDelay(delaySec) {
  const n = Number(delaySec);
  if (!Number.isFinite(n)) return DEFAULT_DELAY_SEC;
  return Math.min(MAX_DELAY_SEC, Math.max(MIN_DELAY_SEC, Math.round(n)));
}

// The OS command that shuts the machine down. On Windows it carries the
// countdown itself; elsewhere it is immediate and runs when our timer fires.
function shutdownCommand(platform, delaySec) {
  if (platform === 'win32') return { file: 'shutdown', args: ['/s', '/t', String(clampDelay(delaySec))], osCountdown: true };
  if (platform === 'darwin') return { file: 'osascript', args: ['-e', 'tell application "System Events" to shut down'], osCountdown: false };
  return { file: 'systemctl', args: ['poweroff'], osCountdown: false };
}

// How a scheduled OS countdown is undone, or null when ours is the only timer.
function cancelCommand(platform) {
  return platform === 'win32' ? { file: 'shutdown', args: ['/a'] } : null;
}

// ---------- Controller ----------

// createShutdownController({ platform, execFile, now, setTimer, clearTimer,
//   isAllowed, onChange }) → { schedule, cancel, status, isAllowed }
// Every dependency is injectable so tests never touch a real command.
function createShutdownController(opts = {}) {
  const platform = opts.platform || process.platform;
  const execFile = opts.execFile || nodeExecFile;
  const now = opts.now || Date.now;
  const setTimer = opts.setTimer || setTimeout;
  const clearTimer = opts.clearTimer || clearTimeout;
  const isAllowed = typeof opts.isAllowed === 'function' ? opts.isAllowed : () => true;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};

  let pending = null; // { at, delaySec, source }
  let timer = null;
  let lastError = '';

  function status() {
    const allowed = !!isAllowed();
    if (!pending) return { allowed, pending: false, at: null, delaySec: DEFAULT_DELAY_SEC, remainingSec: 0, source: null, error: lastError };
    return {
      allowed,
      pending: true,
      at: pending.at,
      delaySec: pending.delaySec,
      remainingSec: Math.max(0, Math.ceil((pending.at - now()) / 1000)),
      source: pending.source,
      error: lastError,
    };
  }

  function emit() { onChange(status()); }

  function run(command, done) {
    try {
      execFile(command.file, command.args, { windowsHide: true }, (err) => done(err || null));
    } catch (e) {
      done(e);
    }
  }

  // Starts the countdown. Returns the status; `error` says why it did not start.
  function schedule({ delaySec = DEFAULT_DELAY_SEC, source = 'box' } = {}) {
    if (!isAllowed()) { lastError = 'Shutting down the PC is switched off in SYSTEM › POWER.'; return status(); }
    if (pending) return status();
    lastError = '';
    const delay = clampDelay(delaySec);
    const command = shutdownCommand(platform, delay);
    pending = { at: now() + delay * 1000, delaySec: delay, source: String(source || 'box') };
    if (command.osCountdown) {
      run(command, (err) => {
        if (!err) return;
        lastError = `The shutdown command failed: ${err.message || err}`;
        pending = null;
        emit();
      });
    } else {
      timer = setTimer(() => {
        timer = null;
        run(command, (err) => {
          if (!err) return;
          lastError = `The shutdown command failed: ${err.message || err}`;
          pending = null;
          emit();
        });
      }, delay * 1000);
    }
    emit();
    return status();
  }

  function cancel() {
    if (!pending) return status();
    const command = cancelCommand(platform);
    pending = null;
    if (timer) { clearTimer(timer); timer = null; }
    if (command) run(command, (err) => { if (err) { lastError = `Cancelling failed: ${err.message || err}`; emit(); } });
    emit();
    return status();
  }

  return { schedule, cancel, status, isAllowed: () => !!isAllowed() };
}

// ---------- IPC ----------

// The host window's half (preload.js's shutdownPc / cancelPcShutdown /
// getPcShutdownStatus). `broadcast` is how a change reaches the window when
// a remote started or cancelled the countdown.
function registerShutdownIpc(ipcMain, controller) {
  ipcMain.handle('system:shutdownPc', async (event, opts) => controller.schedule(opts && typeof opts === 'object' ? opts : {}));
  ipcMain.handle('system:cancelPcShutdown', async () => controller.cancel());
  ipcMain.handle('system:pcShutdownStatus', async () => controller.status());
}

module.exports = {
  DEFAULT_DELAY_SEC, MIN_DELAY_SEC, MAX_DELAY_SEC,
  clampDelay, shutdownCommand, cancelCommand, createShutdownController, registerShutdownIpc,
};
