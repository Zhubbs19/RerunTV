// HDMI-CEC for an Electron mini-PC under a TV (docs/design/01 §5.4, §9; Phase
// E). Optional and off unless RerunTV is launched with --cec: it runs libcec's
// `cec-client` (installed separately) and turns the TV remote's button presses,
// which the TV passes along HDMI, into RemoteKeys for the renderer. Android TV
// needs none of this — CEC keys already arrive there as ordinary key events.
//
// UNVERIFIED on real hardware (most PC HDMI ports can't do CEC without a
// Pulse-Eight style adapter). The parser is covered by unit tests against
// cec-client's documented output.
const { spawn: nodeSpawn } = require('child_process');

// CEC user-control codes (hex, as cec-client prints them) → RemoteKey.
const CEC_CODES = {
  0x00: 'ok', 0x01: 'up', 0x02: 'down', 0x03: 'left', 0x04: 'right',
  0x09: 'menu', 0x0a: 'settings', 0x0b: 'menu', 0x0d: 'back',
  0x20: 'digit0', 0x21: 'digit1', 0x22: 'digit2', 0x23: 'digit3', 0x24: 'digit4',
  0x25: 'digit5', 0x26: 'digit6', 0x27: 'digit7', 0x28: 'digit8', 0x29: 'digit9', 0x2a: 'dot',
  0x30: 'chUp', 0x31: 'chDown', 0x32: 'last', 0x35: 'info',
  0x40: 'power', 0x41: 'volUp', 0x42: 'volDown', 0x43: 'mute',
  0x44: 'play', 0x45: 'stop', 0x46: 'pause', 0x47: 'record', 0x48: 'rewind', 0x49: 'fastForward',
  0x4b: 'next', 0x4c: 'prev', 0x53: 'guide', 0x61: 'playPause',
  0x71: 'blue', 0x72: 'red', 0x73: 'green', 0x74: 'yellow',
};

// One line of cec-client output → { key, code } for a press, or null.
// Presses look like "... key pressed: channel up (30)"; releases and every
// other log line are ignored (repeats arrive as further "pressed" lines).
function parseCecLine(line) {
  const match = /key pressed:\s*(.+?)\s*\(([0-9a-f]+)\)/i.exec(String(line || ''));
  if (!match) return null;
  const code = parseInt(match[2], 16);
  const key = CEC_CODES[code];
  return key ? { key, code, name: match[1].trim() } : null;
}

// Starts cec-client and calls onKey({ key, code }) for each press. Returns
// stop(). Missing cec-client is reported once through onError, not thrown.
function startCecHelper({ onKey, onError = () => {}, command = 'cec-client', args = ['-d', '1'], spawn = nodeSpawn } = {}) {
  let child;
  try {
    child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    onError(e);
    return () => {};
  }
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach((line) => {
      const press = parseCecLine(line);
      if (press) onKey(press);
    });
  });
  child.on('error', (e) => onError(e));
  return () => { try { child.kill(); } catch (e) { /* already gone */ } };
}

module.exports = { CEC_CODES, parseCecLine, startCecHelper };
