import { S } from '../core/state.js';
import { pluginDiagnosticsSnapshot, themePackEntries } from './host.js';
import { allThemeCheckResults } from '../display/theme-check.js';

const MAX_LOGS = 200;
const rendererLogs = [];
let captureInstalled = false;

function printable(value) {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack || ''}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (error) { return String(value); }
}

function installRendererLogCapture() {
  if (captureInstalled) return;
  captureInstalled = true;
  ['log', 'warn', 'error'].forEach((level) => {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      rendererLogs.push({ at: new Date().toISOString(), source: 'renderer', level, message: args.map(printable).join(' ') });
      if (rendererLogs.length > MAX_LOGS) rendererLogs.splice(0, rendererLogs.length - MAX_LOGS);
      original(...args);
    };
  });
}

installRendererLogCapture();

function rendererSnapshot() {
  return {
    registrations: pluginDiagnosticsSnapshot(),
    logs: rendererLogs.slice(),
    runtime: {
      currentChannel: S.currentNumber,
      poweredOn: !!S.powerOn,
      setupOpen: !!S.setupOpen,
      timeMachineActive: !!S.timeMachineOn,
      channelCount: (S.config.channels || []).length,
      theme: S.config.theme || null,
    },
  };
}

function appendMetric(root, label, value) {
  const item = document.createElement('div');
  item.className = 'perf-telemetry-item';
  const name = document.createElement('span');
  name.textContent = `${label}:`;
  const data = document.createElement('strong');
  data.textContent = value;
  item.append(name, data);
  root.appendChild(item);
}

// Theme contrast (docs/design/04 §4.4): every theme with a pair below its
// minimum, worst first, with the colours that failed and any exemption.
function renderThemeContrast(summary) {
  const el = document.getElementById('plugin-diagnostics-contrast');
  const results = allThemeCheckResults();
  const labels = new Map(themePackEntries().map((entry) => [entry.id, entry.label]));
  const failing = results.filter((r) => r.failures.length);
  const exemptOnly = failing.filter((r) => r.failures.every((f) => f.exempt));
  appendMetric(summary, 'THEME CONTRAST', results.length
    ? `${failing.length - exemptOnly.length} of ${results.length} themes below minimum${exemptOnly.length ? `, ${exemptOnly.length} exempt` : ''}`
    : 'CHECKING…');
  if (!el) return;
  el.innerHTML = '';
  failing.forEach((result) => {
    const row = document.createElement('div');
    row.className = 'theme-contrast-row';
    const name = document.createElement('strong');
    name.textContent = labels.get(result.themeId) || result.themeId;
    const list = document.createElement('ul');
    result.failures.slice().sort((a, b) => a.ratio - b.ratio).forEach((f) => {
      const item = document.createElement('li');
      item.textContent = `${f.pair}: ${f.ratio}:1 (needs ${f.min}:1), ${f.fg} on ${f.bg}${f.exempt ? ` — exempt: ${f.exempt}` : ''}`;
      list.appendChild(item);
    });
    row.append(name, list);
    el.appendChild(row);
  });
}

export async function renderPluginDiagnostics() {
  const summary = document.getElementById('plugin-diagnostics-summary');
  const log = document.getElementById('plugin-diagnostics-log');
  const status = document.getElementById('plugin-diagnostics-status');
  if (!summary || !log) return;
  if (status) status.textContent = 'REFRESHING…';
  try {
    const main = await window.api.getDiagnostics();
    const renderer = rendererSnapshot();
    const registrations = renderer.registrations;
    const registrationCount = registrations.channelTypes.length + registrations.settingsPanels.length
      + registrations.settingsSections.reduce((sum, entry) => sum + entry.sections.length, 0)
      + registrations.themePacks.length + registrations.interrupts.length + registrations.tuneGates.length
      + registrations.overlayAudioSources.length + registrations.titleRowActions.length
      + registrations.coreHooks.reduce((sum, entry) => sum + entry.count, 0);
    summary.innerHTML = '';
    appendMetric(summary, 'PLUGIN STATES', `${main.plugins.filter((p) => p.state === 'active').length} active / ${main.plugins.length} installed`);
    appendMetric(summary, 'RENDERER REGISTRATIONS', String(registrationCount));
    appendMetric(summary, 'PUBLISHED SERVICES', String(main.services.length));
    appendMetric(summary, 'RELOAD STATUS', main.restartRequired ? 'RESTART REQUIRED' : 'CURRENT');
    appendMetric(summary, 'PLUGIN LOAD ERRORS', String(registrations.loadErrors.length + main.plugins.filter((p) => p.state === 'load-error' || p.state === 'manifest-error').length));
    appendMetric(summary, 'MEDIA SOURCES', String(Object.keys(main.mediaSourceProviders || {}).length));
    renderThemeContrast(summary);
    const combined = [...(main.logs || []), ...renderer.logs]
      .sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .slice(-250);
    log.textContent = combined.length
      ? combined.map((entry) => `${entry.at} [${entry.source}/${entry.level}] ${entry.message}`).join('\n')
      : 'NO MAIN OR RENDERER LOG ENTRIES CAPTURED THIS SESSION.';
    if (status) status.textContent = `LAST REFRESHED ${new Date().toLocaleTimeString()}`;
  } catch (error) {
    log.textContent = `DIAGNOSTICS ERROR: ${error.message}`;
    if (status) status.textContent = 'COULD NOT LOAD DIAGNOSTICS.';
  }
}

async function exportSupportBundle() {
  const status = document.getElementById('plugin-diagnostics-status');
  if (status) status.textContent = 'BUILDING REDACTED SUPPORT BUNDLE…';
  try {
    const result = await window.api.exportDiagnostics(rendererSnapshot());
    if (status) status.textContent = result && result.success ? `EXPORTED: ${result.filePath}` : 'EXPORT CANCELLED.';
  } catch (error) {
    if (status) status.textContent = `EXPORT FAILED: ${error.message}`;
  }
}

document.getElementById('plugin-diagnostics-refresh-btn')?.addEventListener('click', renderPluginDiagnostics);
document.getElementById('plugin-diagnostics-export-btn')?.addEventListener('click', exportSupportBundle);
