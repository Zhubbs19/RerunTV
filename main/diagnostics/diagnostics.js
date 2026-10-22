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
  // Scrub at capture time: the ring feeds the developer console and the
  // support bundle, and a console line can carry a pairing URL.
  if (typeof entry.message === 'string') entry = { ...entry, message: redactString(entry.message, []) };
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
    .replace(/([?&](?:pair|token|access_token|key|api_?key|secret|password|passcode|code|sig|signature|auth)=)[^&\s#"'<>]+/gi, '$1[REDACTED]')
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

// diagnostics:get/export are the one place this otherwise Electron-free
// module needs Electron (app.getVersion/getPath, dialog.showSaveDialog) and
// several boot-populated `let`s that live in main.js — rather than require()
// electron/main-plugins/main-config here (which would break this file's own
// "no Electron dependency, so redaction is testable" header promise), every
// bit of that is injected via `deps`, including accessor functions (not raw
// values) for pluginDisabledAtBoot/pluginMainLoadErrors/pluginsNeedingApproval/
// pluginsNeedingIntegrityApproval/activatedMediaSourceProviders/
// pluginServicesRef — all `let`s main.js reassigns once inside
// app.whenReady(), after this is called, so a snapshot taken here at
// registration time would silently stay stale forever.
function registerDiagnosticsIpc(ipcMain, deps) {
  const {
    app, dialog, fs, getMainWindow, discoverPlugins, loadConfig,
    getPluginDisabledAtBoot, getPluginMainLoadErrors, getPluginsNeedingApproval,
    getPluginsNeedingIntegrityApproval, getActivatedMediaSourceProviders, getPluginServicesRef,
  } = deps;

  function pluginDiagnosticInventory() {
    const pluginMainLoadErrors = getPluginMainLoadErrors();
    const pluginsNeedingApproval = getPluginsNeedingApproval();
    const pluginsNeedingIntegrityApproval = getPluginsNeedingIntegrityApproval();
    const currentDisabled = new Set(((loadConfig().plugins || {}).disabled) || []);
    const bootDisabled = new Set(getPluginDisabledAtBoot());
    return discoverPlugins().map((plugin) => (plugin.error ? {
      id: plugin.dir, state: 'manifest-error', error: plugin.error,
    } : {
      id: plugin.id, name: plugin.name, version: plugin.version, isolated: !!plugin.isolated,
      state: pluginMainLoadErrors[plugin.id] ? 'load-error'
        : (bootDisabled.has(plugin.id) ? 'disabled'
          : (pluginsNeedingApproval.includes(plugin.id) ? 'needs-capability-approval'
            : (pluginsNeedingIntegrityApproval.includes(plugin.id) ? 'needs-integrity-approval' : 'active'))),
      configuredEnabled: !currentDisabled.has(plugin.id),
      loadError: pluginMainLoadErrors[plugin.id] || null,
      capabilities: plugin.capabilities,
    }));
  }

  function pluginRestartPending() {
    const current = ((loadConfig().plugins || {}).disabled || []).slice().sort();
    const boot = getPluginDisabledAtBoot().slice().sort();
    return JSON.stringify(current) !== JSON.stringify(boot);
  }

  ipcMain.handle('diagnostics:get', async () => ({
    generatedAt: new Date().toISOString(),
    app: { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron },
    plugins: pluginDiagnosticInventory(),
    mediaSourceProviders: { ...getActivatedMediaSourceProviders() },
    services: Object.keys(getPluginServicesRef()).sort(),
    restartRequired: pluginRestartPending(),
    logs: getMainLogs(),
  }));

  ipcMain.handle('diagnostics:export', async (event, rendererSnapshot) => {
    const result = await dialog.showSaveDialog(getMainWindow(), {
      title: 'Export redacted support bundle',
      defaultPath: `reruntv-support-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { cancelled: true };
    const bundle = {
      format: 'reruntv-support-bundle', version: 1, generatedAt: new Date().toISOString(),
      app: { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron },
      plugins: pluginDiagnosticInventory(), mediaSourceProviders: { ...getActivatedMediaSourceProviders() },
      services: Object.keys(getPluginServicesRef()).sort(), restartRequired: pluginRestartPending(), mainLogs: getMainLogs(), renderer: rendererSnapshot || {},
    };
    fs.writeFileSync(result.filePath, `${JSON.stringify(redactDiagnosticValue(bundle, { userDataPath: app.getPath('userData') }), null, 2)}\n`, 'utf8');
    recordDiagnostic('diagnostics', 'log', 'Exported redacted support bundle');
    return { success: true, filePath: result.filePath };
  });
}

module.exports = {
  installMainLogCapture, recordDiagnostic, redactDiagnosticValue, redactString, getMainLogs, registerDiagnosticsIpc,
};
