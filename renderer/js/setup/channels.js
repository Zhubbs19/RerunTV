// The CHANNELS tab: the channel list itself (row rendering, reordering,
// bulk-select actions), per-channel folder scanning, the channel EDIT
// panel's tab bar (wiring together the panels built in setup-panels.js and
// setup-schedule.js), and the box-wide config export/import/done buttons.
import { buildChannelPackage } from '../library/channel-package.js';
import { CHANNEL_ASPECT_OPTIONS } from '../playback/power.js';
import { templateFromChannel } from '../library/channel-builder.js';
import { confirmDialog, alertDialog, promptDialog } from './dialogs.js';
import { isFavorite, setFavorite } from '../personal/state.js';
import {
  buildChannelBadge, channelColor, formatChannelNumber, freshBroadcastHours, isSubChannel, parseChannelNumber,
  subChannelsEnabled, sortedChannels,
} from '../core/channels.js';
import { channelFilterEl, channelListEl, channelListPaneEl, subChannelsEnabledEl } from '../core/dom.js';
import { CHANNEL_DISPLAY_ASPECT_OPTIONS, CHANNEL_RESOLUTION_OPTIONS } from '../display/mode.js';
import {
  buildChannelAdsPanel, buildChannelIdentityPanel, buildCommercialsPanel, buildCreditsSpeedupPanel,
  buildDynamicOverlaysPanel, buildFoldersPanel, buildLogoBugPanel, buildTickerLayoutPanel, buildTitlesPanel,
} from './panels.js';
import { buildUnifiedSchedulePanel } from './schedule.js';
import {
  attachSliderReadout, commitOwnerFields, emptyState, remapChannelRefs, showScanStatus, hideScanStatusAfter,
} from './util.js';
import { computeLivePosition } from '../core/schedule.js';
import { BADGE_COLORS, S, dispatch, commitConfigPatch } from '../core/state.js';
import { getDisplayTitle, shuffleArray, randomInterstitialId, deepClone } from '../core/util.js';
import { CALL_LETTERS_MAX, abbreviateChannelName } from '../guide/model.js';
import {
  isMultiSelecting, parkBulkActionsBar, renderBulkActionsBar, renderMultiSelectDetail,
} from './channel-selection.js';
import { filteredSetupChannels, sortedForSetup, swapChannelNumbers } from './channel-list-helpers.js';
import { pluginChannelEntries, renderChannelListPane, renderPluginChannelSection } from './channel-list-pane.js';
import { buildChooseSourceControl, pickFilesForChannel } from './channel-sources.js';
import { openPreviewModal, openPreviewOnDialog } from './channel-preview-modal.js';
import { channelRowMenu } from './channel-row-actions.js';
export { selectAllChannelsFromSearch } from './channel-selection.js';
export { addPluginSourceToChannel, addFolderToChannel, addVideoFilesToChannel, pickFilesForChannel, removeFileFromChannel, createChannelFromFolder, rescanAllFolders, removeFolderFromChannel } from './channel-sources.js';
export { openPreviewModal } from './channel-preview-modal.js';

// Loads a file into a detached <video> element and confirms a frame
// actually decodes within timeoutMs — same check used live in
// playChannelLive, just against a hidden probe element instead of the
// on-screen player so it can run in bulk without disturbing playback.
function probePlayback(url, timeoutMs) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      v.pause();
      v.removeAttribute('src');
      resolve(ok);
    };
    v.addEventListener('error', () => finish(false));
    v.addEventListener('loadedmetadata', () => {
      v.play().catch(() => {});
      if (typeof v.requestVideoFrameCallback !== 'function') { finish(true); return; }
      const cbId = v.requestVideoFrameCallback(() => finish(true));
      setTimeout(() => {
        try { v.cancelVideoFrameCallback(cbId); } catch (e) {}
        finish(false);
      }, timeoutMs);
    });
    setTimeout(() => finish(false), timeoutMs + 4000); // absolute fallback (e.g. slow/network drive)
    v.src = url;
  });
}

export async function fixChannelPlayback(ch, btn) {
  if (S.batchFixRunning) return;
  S.batchFixRunning = ch;
  S.batchFixCancel = false;
  btn.textContent = 'STOP FIXING';
  showScanStatus('FIX PLAYBACK: STARTING…');

  // Default folder, every daypart block's files, and any per-channel or
  // per-block bumper reels.
  const allFiles = ch.files
    .concat(...(ch.blocks || []).map((b) => b.files || []))
    .concat((ch.commercials && ch.commercials.files) || [])
    .concat(...(ch.blocks || []).map((b) => (b.commercials && b.commercials.files) || []));

  let fixedCount = 0;
  try {
    for (let i = 0; i < allFiles.length; i++) {
      if (S.batchFixCancel) break;
      const file = allFiles[i];
      showScanStatus(`CH ${ch.number}: CHECKING ${i + 1} / ${allFiles.length} (${fixedCount} FIXED SO FAR)…`);

      const url = await window.api.toFileUrl(file.path);
      const ok = await probePlayback(url, 2500);
      if (S.batchFixCancel) break;

      if (!ok) {
        showScanStatus(`CH ${ch.number}: FIXING ${i + 1} / ${allFiles.length}…`);
        const result = await window.api.transcode(file.source || 'local', file.path);
        if (!result.error) fixedCount++;
      }
    }

    showScanStatus(S.batchFixCancel
      ? `STOPPED — ${fixedCount} FIXED THIS RUN. RE-RUN TO PICK UP WHERE IT LEFT OFF.`
      : `DONE — CHECKED ${allFiles.length}, FIXED ${fixedCount}.`);
  } catch (err) {
    showScanStatus(`FIX PLAYBACK FAILED — ${String((err && err.message) || err).slice(0, 120).toUpperCase()} (${fixedCount} FIXED BEFORE THE ERROR).`);
  } finally {
    hideScanStatusAfter(5000);
    // Without this a thrown transcode/IPC error left the button stuck on STOP FIXING
    // and S.batchFixRunning set, so no channel could ever be fixed again.
    S.batchFixRunning = null;
    btn.textContent = 'FIX PLAYBACK';
  }
}

const openChannelEditTabs = new Map();

// A channel's editor pages (docs/design/03 §3): OVERVIEW (the common options),
// CONTENT (folders above titles), SCHEDULE, LOOK (logo, overlays, ticker and
// identity on one page), BREAKS (ads and end credits) and ADVANCED (the
// remaining options). openChannelEditTabs remembers the page per channel; it
// may still hold a sub-tab id from the older two-level bar, mapped here.
const LEGACY_EDIT_TAB_PAGES = {
  folders: 'content', titles: 'content', schedule: 'schedule',
  logo: 'look', overlays: 'look', ticker: 'look', identity: 'look',
  ads: 'breaks', credits: 'breaks',
};
function channelPageFor(id) {
  return LEGACY_EDIT_TAB_PAGES[id] || id;
}

// A page made of several titled sections, each built into its own body.
function sectionedPage(parts) {
  return (ch, pageEl) => parts.forEach(([key, title, build]) => {
    const section = document.createElement('section');
    section.className = 'edit-section';
    section.dataset.editSection = key;
    const heading = document.createElement('h3');
    heading.className = 'edit-section-title';
    heading.textContent = title;
    const body = document.createElement('div');
    body.className = 'edit-section-body';
    section.append(heading, body);
    pageEl.appendChild(section);
    build(ch, body);
  });
}

// The page bar is created with each channel card, so the static
// setup-keyboard.js initializer never sees it. Give it the same
// roving Left/Right/Home/End behavior locally; activation still delegates
// to each button's normal click handler, keeping mouse and keyboard paths
// identical.
function enableDynamicBarKeyboard(bar, buttonSelector) {
  bar.addEventListener('keydown', (event) => {
    const buttons = Array.from(bar.querySelectorAll(buttonSelector));
    const current = buttons.indexOf(document.activeElement);
    if (current < 0 || !buttons.length) return;
    let target = null;
    if (event.key === 'ArrowRight') target = buttons[(current + 1) % buttons.length];
    else if (event.key === 'ArrowLeft') target = buttons[(current - 1 + buttons.length) % buttons.length];
    else if (event.key === 'Home') target = buttons[0];
    else if (event.key === 'End') target = buttons[buttons.length - 1];
    if (!target) return;
    event.preventDefault();
    target.focus();
    target.click();
  });
}

// The CHANNELS page is a list + detail (docs/design/03 §4): renderChannelList
// draws the compact lineup into #channel-list-pane and the selected channel's
// full editor into #channel-list (the detail pane). S.setupSelectedChannel is a
// channel number, 'plugins' for the plugin-channels section, or null.
export function renderChannelList() {
  if (!channelListEl) return;
  if (subChannelsEnabledEl) subChannelsEnabledEl.checked = subChannelsEnabled();
  parkBulkActionsBar();
  channelListEl.innerHTML = '';
  if (channelListPaneEl) channelListPaneEl.innerHTML = '';

  if (!S.config || !Array.isArray(S.config.channels)) {
    if (S.config) S.config.channels = [];
  }

  // A channel removed or renumbered elsewhere must not linger in the multi-select
  // (bulk actions would then act on, or count, a channel that no longer exists).
  if (S.bulkSelectedChannels && S.bulkSelectedChannels.size) {
    const live = new Set(S.config.channels.map((c) => c.number));
    [...S.bulkSelectedChannels].forEach((n) => { if (!live.has(n)) S.bulkSelectedChannels.delete(n); });
  }

  const fullList = sortedForSetup();
  const list = filteredSetupChannels(fullList);
  const pluginEntries = pluginChannelEntries();

  if (fullList.length === 0 && !pluginEntries.length) {
    channelListEl.appendChild(emptyState('No channels yet. Drop a folder of videos here to make your first channel, or add one and choose its folder.',
      { label: '+ ADD CHANNEL', run: () => document.getElementById('add-channel-btn')?.click() }));
    renderBulkActionsBar();
    return;
  }

  if (list.length === 0 && !pluginEntries.length) {
    channelListEl.appendChild(emptyState('No channels match that filter.', {
      label: 'CLEAR FILTER',
      run: () => { S.setupFilterQuery = ''; channelFilterEl.value = ''; renderChannelList(); channelFilterEl.focus(); },
    }));
    renderBulkActionsBar();
    return;
  }

  // Keep the selection if it's still listed (filtering can hide it), else
  // select the first thing that is.
  const selectable = [...list.map((c) => c.number), ...(pluginEntries.length ? ['plugins'] : [])];
  if (!selectable.includes(S.setupSelectedChannel)) S.setupSelectedChannel = selectable.length ? selectable[0] : null;
  renderChannelListPane(list, pluginEntries);
  // sortedChannels() once per render, not per card.
  const allChannelsForCopyFrom = sortedChannels();
  // The selected channel's editor card (was one card per channel, stacked).
  const buildCard = (ch) => {
      const row = document.createElement('div');
      row.className = 'channel-row' + (ch.hidden ? ' channel-row-hidden' : '');
      row.dataset.channelNumber = String(ch.number);

      const badge = buildChannelBadge(ch);

      const rejectNumberChange = (msg) => {
        showScanStatus(msg, 2500);
        numInput.value = ch.number;
      };

      const numInput = document.createElement('input');
      numInput.type = 'number';
      numInput.min = 0;
      // Whole-number stepping unless sub-channels are actually switched on:
      // `step` drives the up/down arrows, so a box-wide 0.1 would make every
      // ordinary channel's arrows crawl in tenths for the sake of a feature
      // most lineups never use. With the option on, a channel may sit at 7.1
      // the way a digital sub-channel does — one decimal place, rounded by
      // parseChannelNumber (channels.js) so a typed 7.1 is the same Map key
      // as a config-loaded one.
      numInput.step = subChannelsEnabled() ? '0.1' : '1';
      numInput.value = ch.number;
      numInput.setAttribute('aria-label', 'Channel number');
      numInput.addEventListener('change', () => {
        const v = parseChannelNumber(numInput.value);
        // No reserved range here — a real channel always takes priority
        // over a plugin's virtual one at the same number (isVirtualChannel,
        // virtual.js), the exact same collision rule already used for every
        // other plugin channel number (51, 88, 94-99). Core has no business
        // carving out a fixed "these numbers are off-limits" range for
        // whichever plugins happen to be installed.
        if (Number.isNaN(v) || v < 0 || v === ch.number) {
          numInput.value = ch.number;
          return;
        }
        // A decimal typed straight into the box bypasses `step` entirely, so
        // the option has to be enforced here too — otherwise switching it off
        // would only hide the arrows' tenths, not the feature.
        if (isSubChannel(v) && !subChannelsEnabled()) {
          rejectNumberChange('TURN ON ALLOW SUB-CHANNELS TO USE A NUMBER LIKE 7.1');
          return;
        }
        if (S.config.channels.some((c) => c !== ch && c.number === v)) {
          rejectNumberChange(`CH ${formatChannelNumber(v)} IS ALREADY IN USE`);
          return;
        }
        const oldNum = ch.number;
        ch.number = v;
        if (openChannelEditTabs.has(oldNum)) {
          openChannelEditTabs.set(v, openChannelEditTabs.get(oldNum));
          openChannelEditTabs.delete(oldNum);
        }
        // Ads, flows, presets and PIN locks that named the old number follow it.
        remapChannelRefs(S.config, new Map([[oldNum, v]]));
        commitConfigPatch(`Renumber CH ${formatChannelNumber(oldNum)} to ${formatChannelNumber(v)}`);
        S.setupSelectedChannel = v;
        renderChannelList();
      });

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'CHANNEL NAME';
      nameInput.value = ch.name || '';
      nameInput.addEventListener('input', () => {
        dispatch({ type: 'channel.rename', channel: ch.number, name: nameInput.value }, { coalesce: `rename:${ch.number}` });
        callInput.placeholder = abbreviateChannelName(nameInput.value) || 'CALL';
      });

      // Call letters for the guide's abbreviated channel names (DISPLAY >
      // Guide > Channel names). Empty means "derive them from the name", which
      // the placeholder shows.
      const callInput = document.createElement('input');
      callInput.type = 'text';
      callInput.className = 'call-letters-input';
      callInput.maxLength = CALL_LETTERS_MAX;
      callInput.value = ch.callLetters || '';
      callInput.placeholder = abbreviateChannelName(ch.name) || 'CALL';
      callInput.title = 'Call letters for the guide when channel names are abbreviated. Leave empty to use the automatic ones.';
      callInput.setAttribute('aria-label', `CH ${ch.number} call letters`);
      callInput.addEventListener('input', () => {
        const value = callInput.value.trim().toUpperCase();
        dispatch({ type: 'channel.set', channel: ch.number, field: 'callLetters', value: value || undefined }, { coalesce: `callLetters:${ch.number}` });
      });

      const folderBtn = buildChooseSourceControl(ch);
      const filesBtn = document.createElement('button');
      filesBtn.className = 'btn folder-btn';
      filesBtn.textContent = '+ ADD FILES';
      filesBtn.title = 'Pick individual videos to add to this channel, instead of a whole folder';
      filesBtn.addEventListener('click', () => pickFilesForChannel(ch));

      let fixBtn = null;
      if (ch.files.length > 0) {
        fixBtn = document.createElement('button');
        fixBtn.className = 'btn fix-btn';
        fixBtn.textContent = 'FIX PLAYBACK';
        fixBtn.addEventListener('click', () => {
          if (S.batchFixRunning === ch) {
            S.batchFixCancel = true;
          } else if (!S.batchFixRunning) {
            fixChannelPlayback(ch, fixBtn);
          }
        });
      }

      const schedCount = (ch.blocks || []).length;

      // Single detail view replacing the old one-button-per-panel sprawl —
      // sub-tabs registered generically (id/label/build) so a future tab
      // (e.g. per-channel Calendar) is "push a row", not "redesign this
      // view". SCHEDULE and CALENDAR used to be two separate entries here;
      // they're now one unified tab (buildUnifiedSchedulePanel, in
      // setup-schedule.js) with an internal BLOCKS/CALENDAR view toggle.
      const lookCustomized = !!(ch.logoBugProfiles || ch.dynamicOverlays || ch.tickerLayout
        || (ch.broadcastIdentity && Object.keys(ch.broadcastIdentity).length));
      const editTabs = [
        { id: 'overview', label: 'OVERVIEW', build: (c, p) => p.appendChild(overviewOptions) },
        {
          id: 'content',
          label: ch.files.length ? `CONTENT (${ch.files.length})` : 'CONTENT',
          build: sectionedPage([
            ['folders', ch.folders.length ? `FOLDERS (${ch.folders.length})` : 'FOLDERS', buildFoldersPanel],
            ...(ch.files.length ? [['titles', 'TITLES', buildTitlesPanel]] : []),
          ]),
        },
        { id: 'schedule', label: schedCount ? `SCHEDULE (${schedCount})` : 'SCHEDULE', build: buildUnifiedSchedulePanel },
        {
          id: 'look',
          label: lookCustomized ? 'LOOK ✓' : 'LOOK',
          build: sectionedPage([
            ['logo', 'LOGO', buildLogoBugPanel],
            ['overlays', 'OVERLAYS', buildDynamicOverlaysPanel],
            ['ticker', 'TICKER', buildTickerLayoutPanel],
            ['identity', 'IDENTITY', buildChannelIdentityPanel],
          ]),
        },
        {
          id: 'breaks',
          label: ch.creditsSpeedup && ch.creditsSpeedup.enabled ? 'BREAKS ✓' : 'BREAKS',
          build: sectionedPage([
            ['ads', 'ADS', (c, body) => buildChannelAdsPanel(c, body)],
            ['credits', 'END CREDITS', buildCreditsSpeedupPanel],
          ]),
        },
        { id: 'advanced', label: 'ADVANCED', build: (c, p) => p.appendChild(advancedOptions) },
      ];
      const simpleChannelView = document.getElementById('setup-screen')?.dataset.settingsView === 'simple';
      const availableEditTabs = simpleChannelView
        ? editTabs.filter((tab) => tab.id === 'overview' || tab.id === 'content')
        : editTabs;

      const editPanel = document.createElement('div');
      editPanel.className = 'titles-panel edit-panel hidden';

      // A separate row, never innerHTML-cleared by renderEditTabBar() below
      // (which rebuilds editTabBar's contents on every tab switch) — putting
      // the PREVIEW button inside editTabBar itself would wipe it out the
      // first time a tab is clicked.
      const editHeaderRow = document.createElement('div');
      editHeaderRow.className = 'edit-header-row';
      const editHeaderPreviewBtn = document.createElement('button');
      editHeaderPreviewBtn.className = 'btn';
      editHeaderPreviewBtn.textContent = 'PREVIEW ▶';
      editHeaderPreviewBtn.title = 'Jump straight to this channel on the TV screen, optionally as of a chosen date/time';
      editHeaderPreviewBtn.disabled = ch.files.length === 0;
      editHeaderPreviewBtn.addEventListener('click', () => openPreviewModal(ch));
      editHeaderRow.appendChild(editHeaderPreviewBtn);

      // docs/design/06 §5 "Preview on TV" — send this channel to another
      // connected screen (paired LAN viewer, Android TV client) instead of
      // this device's own setup-preview banner above.
      const previewOnBtn = document.createElement('button');
      previewOnBtn.className = 'btn setup-advanced-channel-action';
      previewOnBtn.textContent = 'PREVIEW ON…';
      previewOnBtn.title = 'Tune a connected TV or LAN viewer to this channel';
      previewOnBtn.disabled = ch.files.length === 0;
      previewOnBtn.addEventListener('click', () => openPreviewOnDialog(ch));
      editHeaderRow.appendChild(previewOnBtn);

      // Exports the channel plus only its directly referenced flows,
      // presets, and pool entries. IMPORT CHANNEL merges this package into
      // another box without replacing unrelated settings.
      const editHeaderExportBtn = document.createElement('button');
      editHeaderExportBtn.className = 'btn setup-advanced-channel-action';
      editHeaderExportBtn.textContent = 'EXPORT CHANNEL…';
      editHeaderExportBtn.title = 'Save just this channel\'s settings to its own JSON file';
      editHeaderExportBtn.addEventListener('click', async () => {
        try {
          const suggestedName = `channel-${ch.number}-${(ch.name || 'untitled').trim().replace(/\s+/g, '-').toLowerCase()}`;
          const filePath = await window.api.exportConfig(buildChannelPackage(S.config, ch), suggestedName);
          if (!filePath) return;
          showScanStatus(`EXPORTED TO ${filePath}`, 3000);
        } catch (e) {
          alertDialog(`Export failed: ${e.message}`, { variant: 'error' });
        }
      });
      editHeaderRow.appendChild(editHeaderExportBtn);

      const saveTemplateBtn = document.createElement('button');
      saveTemplateBtn.className = 'btn setup-advanced-channel-action';
      saveTemplateBtn.textContent = 'SAVE AS TEMPLATE…';
      saveTemplateBtn.title = 'Export this channel structure without media paths';
      saveTemplateBtn.disabled = !(ch.blocks || []).length && !(ch.files || []).length;
      saveTemplateBtn.addEventListener('click', async () => {
        try {
          const templateName = await promptDialog({ title: 'SAVE AS TEMPLATE', message: 'Name this reusable channel structure.', defaultValue: ch.name || `Channel ${ch.number}` });
          if (templateName == null || !templateName) return;
          const id = templateName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'channel-template';
          const filePath = await window.api.exportConfig(templateFromChannel(ch, { id, name: templateName }), `${id}.rerun-template`);
          if (filePath) await alertDialog(`Saved to ${filePath}`, { title: 'TEMPLATE EXPORTED' });
        } catch (e) { await alertDialog(`Template export failed: ${e.message}`, { variant: 'error' }); }
      });
      editHeaderRow.appendChild(saveTemplateBtn);

      // Copies another channel's SCHEDULE (blocks + broadcast hours) / ADS /
      // LOGO settings onto this one as a starting point — deliberately never
      // touches folders/files/name/number/anchor (this channel's own media
      // identity) or favorite/quickAccess (per-channel viewer-facing flags
      // that don't describe "how this channel broadcasts"). Blocks are
      // deep-cloned with fresh ids so editing the copy never mutates the
      // source channel's own blocks.
      const copyFromWrap = document.createElement('span');
      copyFromWrap.className = 'edit-header-copyfrom';
      const copyFromSelect = document.createElement('select');
      copyFromSelect.className = 'block-hour-select';
      copyFromSelect.setAttribute('aria-label', `Copy settings into channel ${ch.number} from another channel`);
      const copyFromOpt0 = document.createElement('option');
      copyFromOpt0.value = '';
      copyFromOpt0.textContent = 'COPY SETTINGS FROM…';
      copyFromSelect.appendChild(copyFromOpt0);
      allChannelsForCopyFrom.forEach((other) => {
        if (other.number === ch.number) return;
        const opt = document.createElement('option');
        opt.value = String(other.number);
        opt.textContent = `CH ${other.number} — ${other.name || 'UNNAMED'}`;
        copyFromSelect.appendChild(opt);
      });
      const copyFromBtn = document.createElement('button');
      copyFromBtn.className = 'btn';
      copyFromBtn.textContent = 'COPY';
      copyFromBtn.title = 'Copies SCHEDULE (blocks + broadcast hours), ADS, and LOGO settings from the selected channel onto this one — never touches folders/files/name/number';
      copyFromBtn.addEventListener('click', async () => {
        const srcNumber = parseChannelNumber(copyFromSelect.value);
        if (!Number.isFinite(srcNumber)) return; // blank placeholder is NaN; CH 0 is a real channel
        const src = S.config.channels.find((c) => c.number === srcNumber);
        if (!src) return;
        if (!(await confirmDialog(`Copy SCHEDULE, ADS, and LOGO settings from CH ${src.number} (${src.name || 'UNNAMED'}) onto CH ${ch.number} (${ch.name || 'UNNAMED'})? This overwrites this channel's current blocks, broadcast hours, ad/logo settings — its folders/files are untouched.`))) return;
        ch.blocks = deepClone(src.blocks || []).map((b) => ({ ...b, id: randomInterstitialId() }));
        ch.broadcastHours = deepClone(src.broadcastHours || freshBroadcastHours());
        ch.adsEnabled = src.adsEnabled;
        ch.logoBugProfiles = src.logoBugProfiles ? deepClone(src.logoBugProfiles) : null;
        commitOwnerFields(ch, ['blocks', 'broadcastHours', 'adsEnabled', 'logoBugProfiles'], { label: `Copy CH ${src.number} settings to CH ${ch.number}` });
        renderChannelList();
      });
      copyFromWrap.appendChild(copyFromSelect);
      copyFromWrap.appendChild(copyFromBtn);
      editHeaderRow.appendChild(copyFromWrap);

      const editTabBar = document.createElement('div');
      editTabBar.className = 'edit-tab-bar';
      editTabBar.setAttribute('role', 'tablist');
      editTabBar.setAttribute('aria-label', `Channel ${ch.number} pages`);
      const editTabContent = document.createElement('div');
      editTabContent.className = 'edit-tab-content';
      editTabContent.id = `channel-${ch.number}-edit-panel`;
      editTabContent.setAttribute('role', 'tabpanel');
      editPanel.appendChild(editTabBar);
      editPanel.appendChild(editHeaderRow);
      editPanel.appendChild(editTabContent);
      enableDynamicBarKeyboard(editTabBar, '.edit-tab-btn');

      let activeEditTab = channelPageFor(openChannelEditTabs.get(ch.number));
      if (!availableEditTabs.some((t) => t.id === activeEditTab)) activeEditTab = availableEditTabs[0].id;
      function renderEditTabBar() {
        editTabBar.innerHTML = '';
        availableEditTabs.forEach((t) => {
          const tabBtn = document.createElement('button');
          const tabActive = t.id === activeEditTab;
          tabBtn.className = 'btn edit-tab-btn' + (tabActive ? ' active' : '') + (t.soon ? ' edit-tab-soon' : '');
          tabBtn.setAttribute('role', 'tab');
          tabBtn.setAttribute('aria-selected', String(tabActive));
          tabBtn.setAttribute('aria-controls', editTabContent.id);
          tabBtn.tabIndex = tabActive ? 0 : -1;
          tabBtn.id = `channel-${ch.number}-edit-tab-${t.id}`;
          tabBtn.textContent = t.soon ? `${t.label} (SOON)` : t.label;
          tabBtn.addEventListener('click', () => {
            activeEditTab = t.id;
            if (openChannelEditTabs.has(ch.number)) {
              openChannelEditTabs.set(ch.number, activeEditTab);
            }
            renderEditTabBar();
            renderEditTabContent();
          });
          editTabBar.appendChild(tabBtn);
        });
      }
      function renderEditTabContent() {
        const t = availableEditTabs.find((t) => t.id === activeEditTab) || availableEditTabs[0];
        editTabContent.setAttribute('aria-labelledby', `channel-${ch.number}-edit-tab-${t.id}`);
        editTabContent.innerHTML = '';
        t.build(ch, editTabContent);
      }

      // In the detail pane the editor is simply open, on the page last used
      // for this channel. It renders once the options below exist.
      openChannelEditTabs.set(ch.number, activeEditTab);
      editPanel.classList.remove('hidden');

      const status = document.createElement('div');
      status.className = 'folder-status';
      const blockCount = (ch.blocks || []).filter((b) => b.files && b.files.length).length;
      const looseCount = ch.files.filter((f) => !f.folder).length;
      status.textContent = ch.folders.length || ch.files.length
        ? `${ch.files.length} video${ch.files.length === 1 ? '' : 's'}` +
          (ch.folders.length ? ` from ${ch.folders.length} folder${ch.folders.length === 1 ? '' : 's'}` : '') +
          (looseCount && ch.folders.length ? ` + ${looseCount} individual file${looseCount === 1 ? '' : 's'}` : '') +
          (blockCount ? `  ·  ${blockCount} schedule block${blockCount === 1 ? '' : 's'}` : '')
        : 'No folder assigned yet';

      // "NOW: <title>" — a snapshot at render time, not a live ticker (matches
      // every other setup-screen readout, which reflects state as of the last
      // render rather than self-updating). Cheap since computeLivePosition
      // already routes through the pure resolveActiveSource(ch, viewNow()).
      let nowLine = null;
      if (ch.files.length > 0 || (ch.blocks || []).some((b) => b.files && b.files.length)) {
        const pos = computeLivePosition(ch);
        nowLine = document.createElement('div');
        nowLine.className = 'folder-status channel-now';
        nowLine.textContent = pos && pos.file ? `NOW: ${getDisplayTitle(pos.file)}` : 'NOW: —';
      }

      const shuffleLabel = document.createElement('label');
      shuffleLabel.className = 'shuffle-toggle';
      const shuffleCheckbox = document.createElement('input');
      shuffleCheckbox.type = 'checkbox';
      shuffleCheckbox.checked = !!ch.shuffle;
      shuffleCheckbox.addEventListener('change', () => {
        // Only actually reshuffle on a real off->on transition — this used
        // to run shuffleArray any time the box read `checked: true` on
        // 'change', including a channel that already had shuffle on (e.g. a
        // re-render's checkbox re-synced against a since-unrelated event).
        // Real, permanent data loss already happened from this exact
        // pattern once before (see the CDP-testing gotcha memory) —
        // guarding on the previous value costs nothing and makes it safe.
        const wasOn = !!ch.shuffle;
        ch.shuffle = shuffleCheckbox.checked;
        if (ch.shuffle && !wasOn && ch.files.length > 1) shuffleArray(ch.files);
        commitOwnerFields(ch, ch.shuffle && !wasOn ? ['shuffle', 'files'] : ['shuffle']);
      });
      shuffleLabel.appendChild(shuffleCheckbox);
      shuffleLabel.appendChild(document.createTextNode('SHUFFLE ORDER'));

      const favoriteLabel = document.createElement('label');
      favoriteLabel.className = 'shuffle-toggle';
      const favoriteCheckbox = document.createElement('input');
      favoriteCheckbox.type = 'checkbox';
      favoriteCheckbox.checked = isFavorite(ch.number);
      favoriteCheckbox.addEventListener('change', async () => {
        try { await setFavorite(ch.number, favoriteCheckbox.checked); renderChannelList(); }
        catch (e) { favoriteCheckbox.checked = isFavorite(ch.number); await alertDialog(e.message, { variant: 'error' }); }
      });
      favoriteLabel.appendChild(favoriteCheckbox);
      favoriteLabel.appendChild(document.createTextNode('FAVORITE'));

      const quickAccessLabel = document.createElement('label');
      quickAccessLabel.className = 'shuffle-toggle';
      quickAccessLabel.title = 'Shows this channel as a one-tap button on the Android companion remote';
      const quickAccessCheckbox = document.createElement('input');
      quickAccessCheckbox.type = 'checkbox';
      quickAccessCheckbox.checked = !!ch.quickAccess;
      quickAccessCheckbox.addEventListener('change', () => { dispatch({ type: 'channel.set', channel: ch.number, field: 'quickAccess', value: quickAccessCheckbox.checked }); });
      quickAccessLabel.appendChild(quickAccessCheckbox);
      quickAccessLabel.appendChild(document.createTextNode('REMOTE QUICK-TAP'));

      const vhsLabel = document.createElement('label');
      vhsLabel.className = 'shuffle-toggle';
      vhsLabel.title = 'Renders this channel with tracking noise, chroma fringing, and a REC timestamp burn-in, like it\'s playing off a tape';
      const vhsCheckbox = document.createElement('input');
      vhsCheckbox.type = 'checkbox';
      vhsCheckbox.checked = !!ch.vhsQuality;
      vhsCheckbox.addEventListener('change', () => { dispatch({ type: 'channel.set', channel: ch.number, field: 'vhsQuality', value: vhsCheckbox.checked }); });
      vhsLabel.appendChild(vhsCheckbox);
      vhsLabel.appendChild(document.createTextNode('VHS'));

      // How many loops of this channel's content pool it takes to reach
      // maximum tape wear (--vhs-degradation, power.js's applyVhsQuality) —
      // only matters while VHS above is checked. Blank/0 falls back to the
      // original fixed default (7 loops).
      // A visible label rather than relying on the placeholder — "WEAR LOOPS
      // (DEFAULT 7)" doesn't fit inside .block-priority-input's 56px width
      // (shared with plain 1-2-digit priority fields elsewhere), so it used
      // to just render as "WEA" with no visible cue at all.
      const vhsWearLabel = document.createElement('span');
      vhsWearLabel.className = 'option-label';
      vhsWearLabel.title = 'How many loops of this channel\'s content it takes to reach maximum tape wear. Blank = default (7 loops).';
      vhsWearLabel.textContent = 'WEAR LOOPS';

      const vhsWearInput = document.createElement('input');
      vhsWearInput.type = 'number';
      vhsWearInput.min = 1;
      vhsWearInput.className = 'block-priority-input';
      vhsWearInput.title = 'How many loops of this channel\'s content it takes to reach maximum tape wear. Blank = default (7 loops).';
      vhsWearInput.placeholder = '7';
      vhsWearInput.value = ch.vhsWearLoops || '';
      vhsWearInput.addEventListener('change', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'vhsWearLoops', value: vhsWearInput.value.trim() === '' ? null : Math.max(1, parseInt(vhsWearInput.value, 10) || 7) });
      });

      const hideFormatDisclaimerLabel = document.createElement('label');
      hideFormatDisclaimerLabel.className = 'shuffle-toggle';
      hideFormatDisclaimerLabel.title = 'Never show the "formatted to fit your screen"/widescreen disclaimer card on this channel, even if a file\'s real aspect doesn\'t match the currently-applied one.';
      const hideFormatDisclaimerCheckbox = document.createElement('input');
      hideFormatDisclaimerCheckbox.type = 'checkbox';
      hideFormatDisclaimerCheckbox.checked = !!ch.hideFormatDisclaimer;
      hideFormatDisclaimerCheckbox.addEventListener('change', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'hideFormatDisclaimer', value: hideFormatDisclaimerCheckbox.checked });
      });
      hideFormatDisclaimerLabel.appendChild(hideFormatDisclaimerCheckbox);
      hideFormatDisclaimerLabel.appendChild(document.createTextNode('HIDE FORMAT DISCLAIMER'));

      // Hides the on-screen rating bug/full-screen movie card without
      // touching ch.rating/file.rating themselves — the rating value keeps
      // working for the parental lock (pin-lock.js), this only ever
      // suppresses the on-screen icon.
      const hideRatingBugLabel = document.createElement('label');
      hideRatingBugLabel.className = 'shuffle-toggle';
      hideRatingBugLabel.title = 'Never show the content-rating bug/movie rating card on this channel, even when a rating is set. The rating value itself is untouched — still used by the parental lock.';
      const hideRatingBugCheckbox = document.createElement('input');
      hideRatingBugCheckbox.type = 'checkbox';
      hideRatingBugCheckbox.checked = !!ch.hideRatingBug;
      hideRatingBugCheckbox.addEventListener('change', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'hideRatingBug', value: hideRatingBugCheckbox.checked });
      });
      hideRatingBugLabel.appendChild(hideRatingBugCheckbox);
      hideRatingBugLabel.appendChild(document.createTextNode('HIDE RATING ICON'));

      const hideEpisodeStatusLabel = document.createElement('label');
      hideEpisodeStatusLabel.className = 'shuffle-toggle';
      hideEpisodeStatusLabel.title = 'Never show the "NEW EPISODE"/"REPEAT" bug on this channel.';
      const hideEpisodeStatusCheckbox = document.createElement('input');
      hideEpisodeStatusCheckbox.type = 'checkbox';
      hideEpisodeStatusCheckbox.checked = !!ch.hideEpisodeStatus;
      hideEpisodeStatusCheckbox.addEventListener('change', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'hideEpisodeStatus', value: hideEpisodeStatusCheckbox.checked });
      });
      hideEpisodeStatusLabel.appendChild(hideEpisodeStatusCheckbox);
      hideEpisodeStatusLabel.appendChild(document.createTextNode('HIDE REPEAT ICON'));

      const hideDaypartChimeLabel = document.createElement('label');
      hideDaypartChimeLabel.className = 'shuffle-toggle';
      hideDaypartChimeLabel.title = 'Never play the dayparting transition chime on this channel, even when it\'s enabled box-wide (PICTURE & SOUND).';
      const hideDaypartChimeCheckbox = document.createElement('input');
      hideDaypartChimeCheckbox.type = 'checkbox';
      hideDaypartChimeCheckbox.checked = !!ch.hideDaypartChime;
      hideDaypartChimeCheckbox.addEventListener('change', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'hideDaypartChime', value: hideDaypartChimeCheckbox.checked });
      });
      hideDaypartChimeLabel.appendChild(hideDaypartChimeCheckbox);
      hideDaypartChimeLabel.appendChild(document.createTextNode('HIDE DAYPART CHIME'));

      const hideLocalAvailGlitchLabel = document.createElement('label');
      hideLocalAvailGlitchLabel.className = 'shuffle-toggle';
      hideLocalAvailGlitchLabel.title = 'Never flash the head-end-switch noise glitch when cutting into a local avail slot on this channel.';
      const hideLocalAvailGlitchCheckbox = document.createElement('input');
      hideLocalAvailGlitchCheckbox.type = 'checkbox';
      hideLocalAvailGlitchCheckbox.checked = !!ch.hideLocalAvailGlitch;
      hideLocalAvailGlitchCheckbox.addEventListener('change', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'hideLocalAvailGlitch', value: hideLocalAvailGlitchCheckbox.checked });
      });
      hideLocalAvailGlitchLabel.appendChild(hideLocalAvailGlitchCheckbox);
      hideLocalAvailGlitchLabel.appendChild(document.createTextNode('HIDE LOCAL AVAIL GLITCH'));

      // Covers both the start-of-program advisory and the mid-program cue
      // cards (file.advisory/file.advisoryCues, TITLES tab) — one switch
      // for "content advisories on this channel."
      const hideContentAdvisoryLabel = document.createElement('label');
      hideContentAdvisoryLabel.className = 'shuffle-toggle';
      hideContentAdvisoryLabel.title = 'Never show content advisory cards on this channel, whether set at program start or as a mid-program scene cue.';
      const hideContentAdvisoryCheckbox = document.createElement('input');
      hideContentAdvisoryCheckbox.type = 'checkbox';
      hideContentAdvisoryCheckbox.checked = !!ch.hideContentAdvisory;
      hideContentAdvisoryCheckbox.addEventListener('change', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'hideContentAdvisory', value: hideContentAdvisoryCheckbox.checked });
      });
      hideContentAdvisoryLabel.appendChild(hideContentAdvisoryCheckbox);
      hideContentAdvisoryLabel.appendChild(document.createTextNode('HIDE CONTENT ADVISORY'));

      const hideCapabilityBadgeLabel = document.createElement('label');
      hideCapabilityBadgeLabel.className = 'shuffle-toggle';
      hideCapabilityBadgeLabel.title = 'Never show the CC/SAP/STEREO capability badge on this channel.';
      const hideCapabilityBadgeCheckbox = document.createElement('input');
      hideCapabilityBadgeCheckbox.type = 'checkbox';
      hideCapabilityBadgeCheckbox.checked = !!ch.hideCapabilityBadge;
      hideCapabilityBadgeCheckbox.addEventListener('change', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'hideCapabilityBadge', value: hideCapabilityBadgeCheckbox.checked });
      });
      hideCapabilityBadgeLabel.appendChild(hideCapabilityBadgeCheckbox);
      hideCapabilityBadgeLabel.appendChild(document.createTextNode('HIDE CAPABILITY BADGE'));

      // Channel-wide default for the CC/SAP/STEREO badge — most channels
      // share the same audio/caption setup across their whole library, so
      // this saves tagging every file individually. A file's own TITLES-tab
      // selection (INHERIT/YES/NO, setup-panels.js) overrides this when set
      // to YES/NO; INHERIT (the default) falls back to these.
      const defaultCapabilityLabels = [['defaultHasCC', 'DEFAULT CC'], ['defaultHasSAP', 'DEFAULT SAP'], ['defaultHasStereo', 'DEFAULT STEREO']]
        .map(([field, text]) => {
          const label = document.createElement('label');
          label.className = 'shuffle-toggle';
          label.title = 'Default for every file on this channel that doesn\'t explicitly override it (TITLES tab).';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = !!ch[field];
          checkbox.addEventListener('change', () => {
            dispatch({ type: 'channel.set', channel: ch.number, field, value: checkbox.checked });
          });
          label.appendChild(checkbox);
          label.appendChild(document.createTextNode(text));
          return label;
        });

      const notSubscribedLabel = document.createElement('label');
      notSubscribedLabel.className = 'shuffle-toggle';
      notSubscribedLabel.title = 'Tuning to this channel shows a "please call your cable company to subscribe" card instead of playing anything — a simpler sibling to the scrambled PPV gag for a channel you just want blocked';
      const notSubscribedCheckbox = document.createElement('input');
      notSubscribedCheckbox.type = 'checkbox';
      notSubscribedCheckbox.checked = !!ch.notSubscribed;
      notSubscribedCheckbox.addEventListener('change', () => { dispatch({ type: 'channel.set', channel: ch.number, field: 'notSubscribed', value: notSubscribedCheckbox.checked }); });
      notSubscribedLabel.appendChild(notSubscribedCheckbox);
      notSubscribedLabel.appendChild(document.createTextNode('NOT SUBSCRIBED'));

      // Distinct from NOT SUBSCRIBED above (which still occupies its slot in
      // the guide/surf order and only blocks playback with a gag card) — a
      // hidden channel is pulled out of the lineup entirely: gone from the
      // guide grid and channel-up/down surfing (filteredChannels(),
      // changeChannel/changeFavoriteChannel, channels.js/playback.js), and
      // tuning directly to its number falls through to NO SIGNAL exactly as
      // if that number had never been configured (tuneToChannel, playback.js).
      // The config entry itself, its files, and its schedule are untouched —
      // this is purely "not in the lineup right now," reversible any time.
      const hiddenLabel = document.createElement('label');
      hiddenLabel.className = 'shuffle-toggle';
      hiddenLabel.title = 'Removes this channel from the guide and channel-surfing entirely, as if it wasn\'t configured at all. Tuning directly to its number does nothing. Its schedule/files are untouched — toggle off any time to bring it back.';
      const hiddenCheckbox = document.createElement('input');
      hiddenCheckbox.type = 'checkbox';
      hiddenCheckbox.checked = !!ch.hidden;
      hiddenCheckbox.addEventListener('change', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'hidden', value: hiddenCheckbox.checked });
        renderChannelList();
      });
      hiddenLabel.appendChild(hiddenCheckbox);
      hiddenLabel.appendChild(document.createTextNode('HIDE FROM TUNING'));

      const ratingSelect = document.createElement('select');
      ratingSelect.className = 'rating-select';
      ['NONE', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'].forEach((label) => {
        const opt = document.createElement('option');
        opt.value = label === 'NONE' ? '' : label;
        opt.textContent = label;
        ratingSelect.appendChild(opt);
      });
      ratingSelect.value = ch.rating || '';
      ratingSelect.addEventListener('change', () => { dispatch({ type: 'channel.set', channel: ch.number, field: 'rating', value: ratingSelect.value || null }); });

      // Forces this channel's content into a specific aspect ratio/crop
      // instead of inheriting the box-wide ASPECT RATIO setting (DISPLAY
      // tab) — same vocabulary as that setting (contain/stretch/fill) plus
      // a few named crop ratios, consumed by applyTvBezel (power.js), which
      // also auto-shrinks this into the active theme border's safe area.
      const aspectSelect = document.createElement('select');
      aspectSelect.className = 'aspect-select';
      aspectSelect.title = 'Overrides the box-wide ASPECT RATIO setting for this channel only — useful for a channel whose source material is a different shape than the rest of the lineup, or to deliberately frame it (e.g. 2.35:1 for a movie channel).';
      CHANNEL_ASPECT_OPTIONS.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        aspectSelect.appendChild(opt);
      });
      aspectSelect.value = ch.aspectRatio || '';
      aspectSelect.addEventListener('change', () => { dispatch({ type: 'channel.set', channel: ch.number, field: 'aspectRatio', value: aspectSelect.value || null }); });

      // Forces this channel into a specific simulated RESOLUTION tier
      // instead of AUTO-detecting it (real file resolution, then ERA tag)
      // — only takes effect while the box-wide RESOLUTION setting (DISPLAY
      // tab) is itself set to AUTO; ignored otherwise, same relationship
      // ch.aspectRatio has to the box-wide ASPECT RATIO setting.
      const resolutionSelect = document.createElement('select');
      resolutionSelect.className = 'resolution-select';
      resolutionSelect.title = 'Only takes effect while the box-wide RESOLUTION setting (PICTURE & SOUND) is set to AUTO — forces this channel to a specific tier instead of auto-detecting it from the currently-playing file\'s real resolution/ERA tag.';
      CHANNEL_RESOLUTION_OPTIONS.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        resolutionSelect.appendChild(opt);
      });
      resolutionSelect.value = ch.resolutionOverride || '';
      resolutionSelect.addEventListener('change', () => { dispatch({ type: 'channel.set', channel: ch.number, field: 'resolutionOverride', value: resolutionSelect.value || null }); });

      // Forces this channel to a specific simulated box ASPECT (screen
      // shape, #display-frame) instead of AUTO-detecting it — only takes
      // effect while the box-wide ASPECT setting (DISPLAY tab) is itself
      // set to AUTO; same relationship to it that resolutionSelect above
      // has to the box-wide RESOLUTION setting. Distinct from aspectSelect
      // above, which crops/fits video CONTENT inside #player.
      const displayAspectSelect = document.createElement('select');
      displayAspectSelect.className = 'display-aspect-select';
      displayAspectSelect.title = 'Only takes effect while the box-wide ASPECT setting (PICTURE & SOUND) is set to AUTO — forces this channel\'s simulated screen shape instead of auto-detecting it from the currently-playing file\'s real aspect ratio/ERA tag. Not the same as ASPECT RATIO above, which only affects how video content fits inside the player.';
      CHANNEL_DISPLAY_ASPECT_OPTIONS.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        displayAspectSelect.appendChild(opt);
      });
      displayAspectSelect.value = ch.displayAspectOverride || '';
      displayAspectSelect.addEventListener('change', () => { dispatch({ type: 'channel.set', channel: ch.number, field: 'displayAspectOverride', value: displayAspectSelect.value || null }); });

      const swatches = document.createElement('div');
      swatches.className = 'color-swatches';
      BADGE_COLORS.forEach((color) => {
        const sw = document.createElement('button');
        sw.className = 'color-swatch' + (channelColor(ch) === color ? ' active' : '');
        sw.style.background = color;
        sw.title = 'Channel accent color';
        sw.setAttribute('aria-label', `Channel accent color ${color}`);
        sw.setAttribute('aria-pressed', String(channelColor(ch) === color));
        sw.addEventListener('click', () => {
          dispatch({ type: 'channel.set', channel: ch.number, field: 'color', value: color });
          renderChannelList();
        });
        swatches.appendChild(sw);
      });

      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn titles-btn';
      previewBtn.textContent = 'PREVIEW';
      previewBtn.title = 'Jump straight to this channel on the TV screen, optionally as of a chosen date/time';
      previewBtn.disabled = ch.files.length === 0;
      previewBtn.addEventListener('click', () => openPreviewModal(ch));

      const actions = document.createElement('div');
      actions.className = 'channel-actions';
      // Reorder is drag in the list or Move up/down in the ⋯ menu (docs/design/03 §4);
      // Remove sits in the menu's last group.
      actions.appendChild(folderBtn);
      actions.appendChild(filesBtn);
      actions.appendChild(previewBtn);
      if (fixBtn) actions.appendChild(fixBtn);
      const cardMenu = channelRowMenu(ch);
      cardMenu.button.classList.add('channel-card-menu-btn');
      actions.appendChild(cardMenu.button);

      const ratingLabel = document.createElement('span');
      ratingLabel.className = 'option-label';
      ratingLabel.textContent = 'RATING';

      const aspectLabel = document.createElement('span');
      aspectLabel.className = 'option-label';
      aspectLabel.textContent = 'ASPECT RATIO';

      const resolutionLabel = document.createElement('span');
      resolutionLabel.className = 'option-label';
      resolutionLabel.textContent = 'RESOLUTION';

      const displayAspectLabel = document.createElement('span');
      displayAspectLabel.className = 'option-label';
      displayAspectLabel.textContent = 'DISPLAY ASPECT';

      // Always-visible slider (no separate "override" checkbox to find
      // first) — starts at 100 (= inherit the master volume, ch.volume
      // stays null until actually dragged) and simply becomes this
      // channel's override the moment it moves, same directness as the
      // box-wide COMMERCIAL/BUMPER VOLUME slider (AUDIO & SYSTEM tab).
      const volumeLabel = document.createElement('span');
      volumeLabel.className = 'option-label';
      volumeLabel.textContent = 'CONTENT VOL';
      const volumeSlider = document.createElement('input');
      volumeSlider.type = 'range';
      volumeSlider.min = 0;
      volumeSlider.max = 100;
      volumeSlider.className = 'channel-volume-slider';
      volumeSlider.title = 'This channel\'s content volume, as a percentage of the master volume. Drag away from 100 to override.';
      volumeSlider.value = ch.volume != null ? Math.round(ch.volume * 100) : 100;
      volumeSlider.addEventListener('input', () => { dispatch({ type: 'channel.set', channel: ch.number, field: 'volume', value: parseInt(volumeSlider.value, 10) / 100 }, { coalesce: `volume:${ch.number}` }); });
      const volumeReadout = attachSliderReadout(volumeSlider, { suffix: '%' });

      const volumeResetBtn = document.createElement('button');
      volumeResetBtn.className = 'btn';
      volumeResetBtn.textContent = 'RESET';
      volumeResetBtn.title = 'Clear this channel\'s override and inherit the master volume again';
      volumeResetBtn.addEventListener('click', () => {
        dispatch({ type: 'channel.set', channel: ch.number, field: 'volume', value: null });
        volumeSlider.value = 100;
        volumeReadout.refresh();
      });

      const overviewOptions = document.createElement('div');
      overviewOptions.className = 'channel-options channel-options-overview';
      const advancedOptions = document.createElement('div');
      advancedOptions.className = 'channel-options channel-options-advanced';
      const colorLabel = document.createElement('span');
      colorLabel.className = 'option-label';
      colorLabel.textContent = 'COLOR';

      // Everything below used to be appended straight into one wrapping flex
      // row: eighteen checkboxes in no particular order, with seven of them
      // phrased as HIDE-something negatives interleaved among the positives,
      // and a label free to wrap away from the control it names ("RESOLUTION"
      // ending one line above an unrelated <select>). Four named groups, each
      // keeping its own label/control pairs intact, make the row scannable
      // without changing a single setting's meaning.
      const optionField = (...parts) => {
        const field = document.createElement('div');
        field.className = 'channel-option-field';
        parts.forEach((part) => field.appendChild(part));
        return field;
      };
      const optionGroup = (into, title, items) => {
        const group = document.createElement('div');
        group.className = 'channel-option-group';
        const heading = document.createElement('div');
        heading.className = 'channel-option-group-title';
        heading.textContent = title;
        const body = document.createElement('div');
        body.className = 'channel-option-group-items';
        items.forEach((item) => body.appendChild(item));
        group.append(heading, body);
        into.appendChild(group);
      };

      optionGroup(overviewOptions, 'LINEUP', [
        optionField(colorLabel, swatches),
        shuffleLabel, favoriteLabel, quickAccessLabel, notSubscribedLabel, hiddenLabel,
      ]);
      optionGroup(overviewOptions, 'RATING & VOLUME', [
        optionField(ratingLabel, ratingSelect),
        optionField(volumeLabel, volumeSlider, volumeReadout.el, volumeResetBtn),
      ]);
      optionGroup(advancedOptions, 'PICTURE', [
        optionField(aspectLabel, aspectSelect),
        optionField(resolutionLabel, resolutionSelect),
        optionField(displayAspectLabel, displayAspectSelect),
        vhsLabel,
        optionField(vhsWearLabel, vhsWearInput),
      ]);
      optionGroup(advancedOptions, 'AUDIO & CAPTIONS', [
        ...defaultCapabilityLabels,
        hideDaypartChimeLabel,
      ]);
      optionGroup(advancedOptions, 'ON-SCREEN EXTRAS', [
        hideFormatDisclaimerLabel, hideRatingBugLabel, hideEpisodeStatusLabel,
        hideLocalAvailGlitchLabel, hideContentAdvisoryLabel, hideCapabilityBadgeLabel,
      ]);

      row.appendChild(badge);
      row.appendChild(numInput);
      row.appendChild(nameInput);
      row.appendChild(callInput);
      row.appendChild(status);
      if (nowLine) row.appendChild(nowLine);
      row.appendChild(actions);
      renderEditTabBar();
      renderEditTabContent();

      // Drag-to-reorder — a longer-range sibling to the ▲/▼ swap buttons
      // above, same underlying operation (swap two channels' `ch.number`,
      // the field that actually determines list order and what you tune to)
      // just usable for a move of 20 spots in one drag instead of 20 clicks.
      // Deliberately a swap, not a full renumber-everything-in-between —
      // renumbering a whole range would cascade into every pool entry/block
      // that references a channel number by ID (channelAffinity/
      // blockAffinity), which is a much bigger and riskier operation than
      // this UI is asking for.
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(ch.number));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => {
        // A drag carrying real OS files (see setup-dragdrop.js) is "drop a
        // video onto this channel", not a row-reorder — leave it alone so
        // that handler's own dragover/drop (and .os-drag-over highlight)
        // are the only ones that react to it.
        if (Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        const draggedNumber = parseChannelNumber(e.dataTransfer.getData('text/plain'));
        if (!Number.isFinite(draggedNumber) || draggedNumber === ch.number) return;
        const dragged = S.config.channels.find((c) => c.number === draggedNumber);
        if (!dragged) return;
        swapChannelNumbers(dragged, ch);
        renderChannelList();
      });

      channelListEl.appendChild(row);
      channelListEl.appendChild(editPanel);
    };
  if (isMultiSelecting()) {
    renderMultiSelectDetail();
  } else if (S.setupSelectedChannel === 'plugins') {
    renderPluginChannelSection(pluginEntries);
  } else {
    const selected = list.find((c) => c.number === S.setupSelectedChannel);
    if (selected) buildCard(selected);
  }
  renderBulkActionsBar();
}

subChannelsEnabledEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['subChannels', 'enabled'], value: subChannelsEnabledEl.checked });
  // Re-render so every number box picks up its new step immediately — the
  // step is set when a row is built, so without this the arrows keep their
  // old behaviour until something else happens to rebuild the list.
  renderChannelList();
});
