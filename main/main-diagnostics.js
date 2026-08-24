// Bounded, redacted diagnostics shared by the plugin developer console and
// support-bundle export. No Electron dependency, so redaction is testable.
const os = require('os');

const MAX_LOGS = 250;
const logs = [];
let captureInstalled = false;

function printable(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (error) { return String(value); }
}

function push(entry) {
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
}

function recordDiagnostic(source, level, message, meta) {
  push({ at: new Date().toISOString(), source, level, message: printable(message), ...(meta === undefined ? {} : { meta }) });
}

function installMainLogCapture() {
  if (captureInstalled) return;
  captureInstalled = true;
  ['log', 'warn', 'error'].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      push({ at: new Date().toISOString(), source: 'main', level, message: args.map(printable).join(' ') });
      original(...args);
    };
  });
}

const SECRET_KEY = /(token|secret|password|passcode|api[-_]?key|authorization|cookie|credential)/i;

function redactString(value, roots) {
  let result = value;
  (roots || []).filter(Boolean).forEach((root) => { result = result.split(String(root)).join('[USER_PATH]'); });
  return result
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[REDACTED_TOKEN]');
}

function redactDiagnosticValue(value, opts = {}, key = '') {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  const roots = [opts.userDataPath, opts.homePath || os.homedir()].filter(Boolean);
  if (typeof value === 'string') return redactString(value, roots);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnosticValue(entry, opts));
  if (value && typeof value === 'object') {
    const redacted = {};
    Object.entries(value).forEach(([childKey, childValue]) => {
      redacted[childKey] = redactDiagnosticValue(childValue, opts, childKey);
    });
    return redacted;
  }
  return value;
}

function getMainLogs() { return logs.slice(); }

module.exports = { installMainLogCapture, recordDiagnostic, redactDiagnosticValue, getMainLogs };
