// The CHANNELS tab toolbar and box-wide buttons: ADD CHANNEL, the list filter,
// RESCAN ALL, config/settings export and import, DONE and restore-from-disk.
// Split out of channels.js; wires its listeners at import time.
import { applyConfigDefaults, showTvScreen } from '../app.js';
import { mergeChannelPackage, normalizeChannelPackage } from '../library/channel-package.js';
import { applySettingsBundle, buildSettingsBundle, readSettingsBundle } from '../library/settings-bundle.js';
import { applyAspectMode, applyCrtState, applyHintBarState, applyPictureMode, applyVolume } from '../playback/power.js';
import { applyTheme } from '../display/themes.js';
import { describeChannel, validateTemplate } from '../library/channel-builder.js';
import { applyPreset, listAllPresets, presetShape } from './presets.js';
import { h } from '../ui/kit-core.js';
import { confirmDialog, alertDialog, promptDialog } from './dialogs.js';
import { Dialog } from '../ui/dialog.js';
import { takeRestorePoint } from './restore-point.js';
import { freshChannel, mediaRefId, nextChannelNumber, parseChannelNumber } from '../core/channels.js';
import {
  addChannelBtn, channelFilterEl, channelImportBtn, configExportBtn, configImportBtn, doneBtn, settingsExportBtn,
  settingsImportBtn, rescanAllBtn,
} from '../core/dom.js';
import { cancelBulkPreview, renderCommercialsPanel, renderStandbyPanel } from './interstitials.js';
import { renderSettingsPanels } from './settings.js';
import { showScanStatus, safeApi } from './util.js';
import { S, dispatch, saveConfigNow, resetUndoBaseline, commitConfigPatch } from '../core/state.js';
import { randomInterstitialId } from '../core/util.js';
import { applyLocalFolderRelink } from '../library/relink.js';
import { renderChannelList } from './channels.js';
import { rescanAllFolders } from './channel-sources.js';

async function chooseAddChannelSource() {
  return Dialog({
    title: 'ADD CHANNEL',
    message: 'Start empty, use your tagged library, or describe a weekly lineup.',
    dismissValue: null,
    actions: [
      { label: 'CANCEL', value: null },
      { label: 'EMPTY', value: 'empty' },
      { label: 'FROM TEMPLATE', value: 'template' },
      { label: 'DESCRIBE IT', variant: 'primary', value: 'describe', isDefault: true },
    ],
  }).result;
}

// Built-in, plugin and saved presets (LIBRARY › PRESETS) in one labelled
// select, grouped by where they came from, with a line about the chosen one —
// the same shape as PRESET FROM A CHANNEL, not a button per preset.
async function choosePreset() {
  const presets = await listAllPresets();
  const groupLabels = { builtin: 'Built in', plugin: 'Plugins', saved: 'Yours' };
  const select = h('select', { className: 'block-hour-select', id: 'add-channel-preset', attrs: { 'aria-label': 'Preset' } });
  ['saved', 'builtin', 'plugin'].forEach((source) => {
    const entries = presets.filter((entry) => entry.source === source);
    if (!entries.length) return;
    const group = h('optgroup', { label: groupLabels[source] });
    entries.forEach(({ template }) => group.appendChild(h('option', { value: template.id, text: template.name })));
    select.appendChild(group);
  });
  const about = h('p', { className: 'panel-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const describe = () => {
    const entry = presets.find((candidate) => candidate.template.id === select.value);
    about.textContent = entry ? [entry.template.description, presetShape(entry.template)].filter(Boolean).join(' — ') : '';
  };
  select.addEventListener('change', describe);
  describe();
  const picked = await Dialog({
    title: 'CHANNEL PRESETS',
    message: 'Presets contain scheduling intent only. Your library supplies the programs. Make your own under LIBRARY › PRESETS.',
    body: h('div', { className: 'library-form-field' }, h('label', { text: 'Preset', attrs: { for: 'add-channel-preset' } }), select, about),
    dismissValue: null,
    actions: [{ label: 'CANCEL', value: null }, { label: 'CONTINUE', variant: 'primary', value: true, isDefault: true }],
  }).result;
  if (!picked) return null;
  const entry = presets.find((candidate) => candidate.template.id === select.value);
  return entry ? entry.template : null;
}

// Resolve, preview and apply a preset — LIBRARY › PRESETS owns the flow.
const buildChannelFromPlan = (template) => applyPreset(template);

addChannelBtn.addEventListener('click', async () => {
  const source = await chooseAddChannelSource();
  if (!source) return;
  if (source === 'template') {
    const template = await choosePreset();
    if (template) await buildChannelFromPlan(template);
    return;
  }
  if (source === 'describe') {
    const description = await promptDialog({
      title: 'DESCRIBE A CHANNEL',
      message: 'Use comma-separated blocks, for example: “90s cartoons Saturdays 7 am to 11 am, sitcoms weeknights 8 pm to 10 pm”.',
      placeholder: 'Content + days + start time to end time',
    });
    if (description == null) return;
    try { await buildChannelFromPlan(describeChannel(description)); }
    catch (e) { await alertDialog(e.message, { title: 'CHECK THE DESCRIPTION', variant: 'error' }); }
    return;
  }
  const fresh = freshChannel();
  dispatch({ type: 'channel.insert', channel: fresh });
  S.setupSelectedChannel = fresh.number;
  // Clear any active filter so the new (nameless) channel is guaranteed to
  // actually show up in the list instead of silently vanishing into it.
  S.setupFilterQuery = '';
  channelFilterEl.value = '';
  renderChannelList();
});

channelFilterEl.addEventListener('input', () => {
  S.setupFilterQuery = channelFilterEl.value;
  renderChannelList();
});

rescanAllBtn.addEventListener('click', () => rescanAllFolders());

configExportBtn.addEventListener('click', async () => {
  try {
    const filePath = await window.api.exportConfig(S.config);
    if (!filePath) return; // user canceled the save dialog
    showScanStatus(`EXPORTED TO ${filePath}`, 3000);
  } catch (e) {
    alertDialog(`Export failed: ${e.message}`, { variant: 'error' });
  }
});

channelImportBtn.addEventListener('click', async () => {
  let imported;
  try { imported = await window.api.importConfig(); }
  catch (e) { alertDialog(`Import failed: ${e.message}`, { variant: 'error' }); return; }
  if (!imported) return;
  if (imported.templateVersion != null) {
    try { await buildChannelFromPlan(validateTemplate(imported)); }
    catch (e) { await alertDialog(e.message, { title: 'INVALID CHANNEL TEMPLATE', variant: 'error' }); }
    return;
  }
  const pkg = normalizeChannelPackage(imported);
  if (!pkg) {
    await alertDialog('Choose a single-channel package. Full configurations still use IMPORT CONFIG.', { title: 'NOT A CHANNEL PACKAGE' });
    return;
  }

  // Same range the channel-number field accepts (parseChannelNumber: up to three
  // digits). A package carrying anything else gets the next free number instead.
  let targetNumber = parseChannelNumber(pkg.channel.number);
  if (!Number.isInteger(targetNumber) || targetNumber < 1) targetNumber = nextChannelNumber();
  let replace = false;
  const conflict = S.config.channels.some((channel) => channel.number === targetNumber);
  if (conflict) {
    const fallback = nextChannelNumber();
    const entered = await promptDialog({
      title: 'CHANNEL NUMBER CONFLICT',
      message: `CH ${targetNumber} already exists. Enter a different channel number, or keep ${targetNumber} to replace it after confirmation.`,
      defaultValue: String(fallback),
    });
    if (entered == null) return;
    targetNumber = Number(entered);
    if (!Number.isInteger(targetNumber) || targetNumber < 1 || targetNumber > 999) {
      await alertDialog('Enter a whole-number channel from 1 to 999.', { variant: 'error' });
      return;
    }
    if (S.config.channels.some((channel) => channel.number === targetNumber)) {
      replace = await confirmDialog({
        title: `REPLACE CH ${targetNumber}?`,
        message: 'The existing channel will be replaced by the imported package. Other channels and box settings stay unchanged. This can be undone with Ctrl+Z.',
        danger: true, confirmText: 'REPLACE CHANNEL',
      });
      if (!replace) return;
    }
  }

  await takeRestorePoint('before-import');
  const result = mergeChannelPackage(S.config, pkg, {
    targetNumber, replace, makeId: randomInterstitialId,
  });

  // Offer source-root mapping immediately for folders that do not exist on
  // this machine. The same verified relink helper powers Channel Health.
  for (const folder of (result.channel.folders || []).filter((entry) => entry.source === 'local')) {
    let exists = true;
    try { [exists] = await window.api.checkPathsExist([{ source: 'local', ref: folder.ref }]); } catch (e) {}
    if (exists !== false) continue;
    const choose = await confirmDialog({
      title: 'MAP MISSING SOURCE FOLDER?', danger: false, confirmText: 'CHOOSE NEW LOCATION', cancelText: 'KEEP OLD PATH',
      message: `${folder.label || folder.ref}\n\nThis source folder is not available on this computer. Choose its new location now, or keep the saved path and relink it later from Channel Health.`,
    });
    if (!choose) continue;
    const newRoot = await safeApi('Opening the file picker', () => window.api.selectFolder());
    if (!newRoot) continue;
    applyLocalFolderRelink(S.config, {
      oldId: folder.id, oldRoot: folder.ref, newId: mediaRefId('local', newRoot), newRoot,
    });
  }

  commitConfigPatch(`${result.replaced ? 'Replace' : 'Import'} CH ${targetNumber}`);
  S.setupFilterQuery = '';
  channelFilterEl.value = '';
  renderChannelList();
  await alertDialog(
    `Imported CH ${targetNumber} with ${result.added.flows} flow(s), ${result.added.presets} preset(s), and ${result.added.pool} bumper/pool entr${result.added.pool === 1 ? 'y' : 'ies'}.`,
    { title: result.replaced ? 'CHANNEL REPLACED' : 'CHANNEL IMPORTED' },
  );
});

settingsExportBtn.addEventListener('click', async () => {
  try {
    const filePath = await window.api.exportConfig(buildSettingsBundle(S.config), 'reruntv-settings.json');
    if (!filePath) return;
    showScanStatus(`SETTINGS EXPORTED TO ${filePath}`, 3000);
  } catch (e) {
    alertDialog(`Export failed: ${e.message}`, { variant: 'error' });
  }
});

settingsImportBtn.addEventListener('click', async () => {
  let imported;
  try { imported = await window.api.importConfig(); }
  catch (e) { alertDialog(`Import failed: ${e.message}`, { variant: 'error' }); return; }
  if (!imported) return;
  const settings = readSettingsBundle(imported);
  if (!settings) {
    await alertDialog("That file isn't a settings-only export. Use EXPORT SETTINGS ONLY to make one; full configs still use IMPORT CONFIG.", { title: 'NOT A SETTINGS FILE', variant: 'error' });
    return;
  }
  const names = Object.keys(settings).length;
  if (!(await confirmDialog({
    title: 'IMPORT SETTINGS?',
    message: `This replaces ${names} settings group${names === 1 ? '' : 's'} (look, volume, controls, plug-in options). Channels, the ad pool and watching history are not touched. Undo (Ctrl+Z) reverts it.`,
    confirmText: 'IMPORT SETTINGS',
  }))) return;
  await takeRestorePoint('before-import');
  applySettingsBundle(S.config, settings);
  commitConfigPatch('Import settings');
  // Bring the live picture, sound and theme in line with what was imported.
  applyTheme();
  applyAspectMode();
  applyPictureMode();
  applyCrtState();
  applyHintBarState();
  applyVolume();
  renderCommercialsPanel();
  renderStandbyPanel();
  renderSettingsPanels();
});

configImportBtn.addEventListener('click', async () => {
  let imported;
  try {
    imported = await window.api.importConfig();
  } catch (e) {
    alertDialog(`Import failed: ${e.message}`, { variant: 'error' });
    return;
  }
  if (!imported) return; // user canceled the open dialog
  // A channel package or settings-only export is valid JSON too, and importing one
  // here would wipe the whole lineup. Name what the file actually is instead.
  if (typeof imported !== 'object' || Array.isArray(imported)) {
    await alertDialog("That file isn't a RerunTV configuration.", { title: 'NOT A CONFIG FILE', variant: 'error' });
    return;
  }
  if (imported.templateVersion != null || imported.kind === 'reruntv-channel-package') {
    await alertDialog('That file is a single-channel package or template, not a full configuration. Use IMPORT CHANNEL to add it.', { title: 'NOT A FULL CONFIG', variant: 'error' });
    return;
  }
  if (readSettingsBundle(imported)) {
    await alertDialog('That file is a settings-only export, not a full configuration. Use IMPORT SETTINGS to apply it.', { title: 'NOT A FULL CONFIG', variant: 'error' });
    return;
  }
  if (!Array.isArray(imported.channels)) {
    await alertDialog('That file has no channel list, so it is not a full RerunTV configuration. Nothing was changed.', { title: 'NOT A CONFIG FILE', variant: 'error' });
    return;
  }
  if (!(await confirmDialog('Import this config? It replaces every channel and setting currently loaded. You can undo it with Ctrl+Z until you leave setup.'))) return;

  await takeRestorePoint('before-import');
  S.config = applyConfigDefaults(imported);
  resetUndoBaseline();
  S.setupFilterQuery = '';
  channelFilterEl.value = '';
  renderChannelList();
  renderCommercialsPanel();
  renderStandbyPanel();
  renderSettingsPanels();
  await saveConfigNow();
});

doneBtn.addEventListener('click', async () => {
  cancelBulkPreview();
  if (!S.config.channels || S.config.channels.length === 0) {
    try {
      const fresh = await window.api.loadConfig();
      if (fresh && fresh.channels && fresh.channels.length > 0) {
        S.config = applyConfigDefaults(fresh);
      }
    } catch (e) {}
  }
  S.config.channels = (S.config.channels || []).filter((c) => (c.files && c.files.length > 0) || (c.name && c.name.trim()) || (c.folders && c.folders.length > 0)
    || (c.blocks || []).some((b) => b && ((b.files && b.files.length > 0) || (b.folders && b.folders.length > 0))));
  const saved = await saveConfigNow();
  // A refused or failed save keeps you in Setup with the reason, so nothing is
  // discarded by leaving.
  if (saved && saved.ok === false) {
    await alertDialog(saved.message || 'The changes could not be saved, so Setup stays open.', { variant: 'error', title: 'COULD NOT SAVE' });
    return;
  }
  resetUndoBaseline();
  showTvScreen();
});

const configRestoreAutoBtn = document.getElementById('config-restore-auto-btn');
if (configRestoreAutoBtn) {
  configRestoreAutoBtn.addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: 'RESTORE CHANNELS FROM DISK?',
      message: 'This loads your newest saved channel backup and replaces the lineup that is loaded now, then returns to the TV. The current state is itself backed up first.',
      confirmText: 'RESTORE',
    }))) return;
    try {
      let restored = await window.api.loadConfig();
      if (!restored || !Array.isArray(restored.channels) || restored.channels.length === 0) {
        const list = await window.api.listBackups();
        if (Array.isArray(list)) {
          // Newest first. (Largest-first used to restore an old bloated backup over a
          // recent good one.) The first non-empty one wins.
          const sortedBackups = [...list].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
          for (const b of sortedBackups) {
            try {
              const candidate = await window.api.restoreBackup(b.file);
              if (candidate && Array.isArray(candidate.channels) && candidate.channels.length > 0) {
                restored = candidate;
                break;
              }
            } catch (e) {}
          }
        }
      }
      if (restored && Array.isArray(restored.channels) && restored.channels.length > 0) {
        S.config = applyConfigDefaults(restored);
        await saveConfigNow();
        resetUndoBaseline();
        S.setupFilterQuery = '';
        if (channelFilterEl) channelFilterEl.value = '';
        renderChannelList();
        renderCommercialsPanel();
        renderStandbyPanel();
        renderSettingsPanels();
        showTvScreen();
        alertDialog(`Successfully restored ${S.config.channels.length} channels!`);
      } else {
        alertDialog('No saved channel backups were found on disk.');
      }
    } catch (err) {
      alertDialog(`Restore failed: ${err.message}`, { variant: 'error' });
    }
  });
}
