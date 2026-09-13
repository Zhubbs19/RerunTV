// The CHANNELS tab: the channel list itself (row rendering, reordering,
// bulk-select actions), per-channel folder scanning, the channel EDIT
// panel's tab bar (wiring together the panels built in setup-panels.js and
// setup-schedule.js), and the box-wide config export/import/done buttons.
import { applyConfigDefaults, showTvScreen } from './app.js';
import { buildChannelPackage, mergeChannelPackage, normalizeChannelPackage } from './channel-package.js';
import { confirmDialog, alertDialog, promptDialog } from './setup-dialogs.js';
import {
  buildChannelBadge, channelColor, formatChannelNumber, freshBroadcastHours, freshChannel, freshFileFacets, isSubChannel, mediaRefId, nextChannelNumber, parseChannelNumber, parseMediaRef,
  subChannelsEnabled,
  sortedChannels, tryGetDisplayName, tryGetMetadata,
} from './channels.js';
import {
  addChannelBtn, bulkActionsBar, bulkFavoriteOffBtn, bulkFavoriteOnBtn, bulkRatingApplyBtn,
  bulkRatingSelect, bulkRemoveBtn, bulkSelectAllBtn, bulkSelectedCountEl, bulkShuffleOffBtn,
  bulkShuffleOnBtn, bulkVolumeApplyBtn, bulkVolumeInheritBtn, bulkVolumeSlider,
  channelFilterEl, channelImportBtn, channelListEl, channelListPaneEl, configExportBtn, configImportBtn, doneBtn,
  previewBannerEl, previewModalBlockEl, previewModalCancelBtn, previewModalChannelLabelEl, previewModalDatetimeEl,
  previewModalEl, previewModalGoBtn, previewModalNowBtn, previewModalQuickEl, rescanAllBtn, scanProgressEl,
  subChannelsEnabledEl,
} from './dom.js';
import { CHANNEL_DISPLAY_ASPECT_OPTIONS, CHANNEL_RESOLUTION_OPTIONS } from './display-mode.js';
import { tuneToChannel } from './playback-core.js';
import { CHANNEL_ASPECT_OPTIONS } from './power.js';
import {
  buildChannelAdsPanel, buildChannelIdentityPanel, buildCommercialsPanel, buildCreditsSpeedupPanel, buildDynamicOverlaysPanel, buildFoldersPanel,
  buildLogoBugPanel, buildTickerLayoutPanel, buildTitlesPanel,
} from './setup-panels.js';
import { renderCommercialsPanel, renderStandbyPanel } from './setup-interstitials.js';
import { renderSettingsPanels } from './setup-settings.js';
import { buildUnifiedSchedulePanel, blockPickerLabel } from './setup-schedule.js';
import { attachSliderReadout, commitOwnerFields, ownerFieldsCommand, probeDurationForEntry } from './setup-util.js';
import {
  getMediaSourcePicker, getPluginChannelOverride, getPluginChannelType, pluginChannelTypeIds, updatePluginChannelOverride,
} from './plugins.js';
import { renderChannelDisplaySettings } from './setup-plugin-settings.js';
import { computeLivePosition, computeSourcePosition, resolveActiveSource } from './schedule.js';
import { BADGE_COLORS, S, commitInPlace, dispatch, saveConfigNow, resetUndoBaseline, viewNow, commitConfigPatch } from './state.js';
import { basenameNoExt, getDisplayTitle, shuffleArray, randomInterstitialId, toDatetimeLocalValue, deepClone } from './util.js';
import { formatPreviewBannerTime, nextBlockActiveMs, nextBreakStartMs, randomPreviewMs } from './setup-channel-preview.js';
import { applyLocalFolderRelink } from './library-relink.js';
import {
  librarySearchToggleBtn, librarySearchPanelEl, librarySearchInputEl, librarySearchResultsEl,
  nowNextToggleBtn, nowNextPanelEl,
} from './dom.js';

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
  scanProgressEl.classList.remove('hidden');

  // Default folder, every daypart block's files, and any per-channel or
  // per-block bumper reels.
  const allFiles = ch.files
    .concat(...(ch.blocks || []).map((b) => b.files || []))
    .concat((ch.commercials && ch.commercials.files) || [])
    .concat(...(ch.blocks || []).map((b) => (b.commercials && b.commercials.files) || []));

  let fixedCount = 0;
  for (let i = 0; i < allFiles.length; i++) {
    if (S.batchFixCancel) break;
    const file = allFiles[i];
    scanProgressEl.textContent = `CH ${ch.number}: CHECKING ${i + 1} / ${allFiles.length} (${fixedCount} FIXED SO FAR)…`;

    const url = await window.api.toFileUrl(file.path);
    const ok = await probePlayback(url, 2500);
    if (S.batchFixCancel) break;

    if (!ok) {
      scanProgressEl.textContent = `CH ${ch.number}: FIXING ${i + 1} / ${allFiles.length}…`;
      const result = await window.api.transcode(file.source || 'local', file.path);
      if (!result.error) fixedCount++;
    }
  }

  scanProgressEl.textContent = S.batchFixCancel
    ? `STOPPED — ${fixedCount} FIXED THIS RUN. RE-RUN TO PICK UP WHERE IT LEFT OFF.`
    : `DONE — CHECKED ${allFiles.length}, FIXED ${fixedCount}.`;
  setTimeout(() => scanProgressEl.classList.add('hidden'), 5000);

  S.batchFixRunning = null;
  btn.textContent = 'FIX PLAYBACK';
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

function sortedForSetup() {
  return [...((S.config && S.config.channels) || [])].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
}

// Channels shown in the setup list, narrowed by S.setupFilterQuery — same
// name-or-number substring match as the guide's filteredChannels().
function filteredSetupChannels(fullList) {
  const q = (S.setupFilterQuery || '').trim().toLowerCase();
  if (!q) return fullList;
  return fullList.filter((ch) => (ch.name || '').toLowerCase().includes(q) || String(ch.number || '').includes(q));
}

// The CHANNELS page is a list + detail (docs/design/03 §4): renderChannelList
// draws the compact lineup into #channel-list-pane and the selected channel's
// full editor into #channel-list (the detail pane). S.setupSelectedChannel is a
// channel number, 'plugins' for the plugin-channels section, or null.
export function renderChannelList() {
  if (!channelListEl) return;
  if (subChannelsEnabledEl) subChannelsEnabledEl.checked = subChannelsEnabled();
  ensureMediaSourceProvidersLoaded();
  parkBulkActionsBar();
  channelListEl.innerHTML = '';
  if (channelListPaneEl) channelListPaneEl.innerHTML = '';

  if (!S.config || !Array.isArray(S.config.channels)) {
    if (S.config) S.config.channels = [];
  }

  const fullList = sortedForSetup();
  const list = filteredSetupChannels(fullList);
  const pluginEntries = pluginChannelEntries();

  if (fullList.length === 0 && !pluginEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO CHANNELS YET — + ADD CHANNEL TO MAKE ONE, OR RESTORE A BACKUP FROM SYSTEM › BACKUPS';
    channelListEl.appendChild(empty);
    renderBulkActionsBar();
    return;
  }

  if (list.length === 0 && !pluginEntries.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO CHANNELS MATCH THAT FILTER';
    channelListEl.appendChild(empty);
    renderBulkActionsBar();
    return;
  }

  // Keep the selection if it's still listed (filtering can hide it), else
  // select the first thing that is.
  const selectable = [...list.map((c) => c.number), ...(pluginEntries.length ? ['plugins'] : [])];
  if (!selectable.includes(S.setupSelectedChannel)) S.setupSelectedChannel = selectable.length ? selectable[0] : null;
  renderChannelListPane(list, pluginEntries);
  // Precomputed once per render rather than inside the per-row loop below —
  // fullList.indexOf(ch) and a fresh sortedChannels() call per row were both
  // O(n) (the latter O(n log n)), making the whole render O(n^2) on channel
  // count; a large channel list made this render loop visibly slower than
  // it needs to be.
  const fullIndexOf = new Map(fullList.map((c, i) => [c, i]));
  const allChannelsForCopyFrom = sortedChannels();
  // The selected channel's editor card (was one card per channel, stacked).
  const buildCard = (ch) => {
      const fullIdx = fullIndexOf.get(ch);
      const row = document.createElement('div');
      row.className = 'channel-row' + (ch.hidden ? ' channel-row-hidden' : '');
      row.dataset.channelNumber = String(ch.number);

      const badge = buildChannelBadge(ch);

      const rejectNumberChange = (msg) => {
        scanProgressEl.classList.remove('hidden');
        scanProgressEl.textContent = msg;
        setTimeout(() => scanProgressEl.classList.add('hidden'), 2500);
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
        commitInPlace({ type: 'channel.renumber', from: oldNum, to: v });
        S.setupSelectedChannel = v;
        renderChannelList();
      });

      const moveUpBtn = document.createElement('button');
      moveUpBtn.className = 'btn move-btn';
      moveUpBtn.textContent = '▲';
      moveUpBtn.title = 'Swap with the channel above';
      moveUpBtn.disabled = fullIdx === 0;
      moveUpBtn.addEventListener('click', () => {
        const neighbor = fullList[fullIdx - 1];
        if (!neighbor) return;
        const swap = { type: 'channel.swapNumbers', a: ch.number, b: neighbor.number };
        [ch.number, neighbor.number] = [neighbor.number, ch.number];
        commitInPlace(swap);
        S.setupSelectedChannel = ch.number;
        renderChannelList();
      });

      const moveDownBtn = document.createElement('button');
      moveDownBtn.className = 'btn move-btn';
      moveDownBtn.textContent = '▼';
      moveDownBtn.title = 'Swap with the channel below';
      moveDownBtn.disabled = fullIdx === fullList.length - 1;
      moveDownBtn.addEventListener('click', () => {
        const neighbor = fullList[fullIdx + 1];
        if (!neighbor) return;
        const swap = { type: 'channel.swapNumbers', a: ch.number, b: neighbor.number };
        [ch.number, neighbor.number] = [neighbor.number, ch.number];
        commitInPlace(swap);
        S.setupSelectedChannel = ch.number;
        renderChannelList();
      });

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'CHANNEL NAME';
      nameInput.value = ch.name || '';
      nameInput.addEventListener('input', () => { dispatch({ type: 'channel.rename', channel: ch.number, name: nameInput.value }, { coalesce: `rename:${ch.number}` }); });

      const folderBtn = buildChooseSourceControl(ch);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn remove-btn';
      removeBtn.textContent = 'REMOVE';
      removeBtn.addEventListener('click', async () => {
        const label = ch.name && ch.name.trim() ? `"${ch.name.trim()}"` : `channel ${ch.number}`;
        const detail = ch.files.length
          ? ` and its ${ch.files.length} video${ch.files.length === 1 ? '' : 's'}, schedule, and commercial settings`
          : '';
        if (!(await confirmDialog(`Remove ${label}${detail}? You can undo this.`))) return;
        const next = fullList[fullIdx + 1] || fullList[fullIdx - 1];
        dispatch({ type: 'channel.remove', channel: ch.number });
        S.setupSelectedChannel = next ? next.number : null;
        renderChannelList();
      });

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

      // Exports the channel plus only its directly referenced flows,
      // presets, and pool entries. IMPORT CHANNEL merges this package into
      // another box without replacing unrelated settings.
      const editHeaderExportBtn = document.createElement('button');
      editHeaderExportBtn.className = 'btn';
      editHeaderExportBtn.textContent = 'EXPORT CHANNEL…';
      editHeaderExportBtn.title = 'Save just this channel\'s settings to its own JSON file';
      editHeaderExportBtn.addEventListener('click', async () => {
        try {
          const suggestedName = `channel-${ch.number}-${(ch.name || 'untitled').trim().replace(/\s+/g, '-').toLowerCase()}`;
          const filePath = await window.api.exportConfig(buildChannelPackage(S.config, ch), suggestedName);
          if (!filePath) return;
          scanProgressEl.classList.remove('hidden');
          scanProgressEl.textContent = `EXPORTED TO ${filePath}`;
          setTimeout(() => scanProgressEl.classList.add('hidden'), 3000);
        } catch (e) {
          alertDialog(`Export failed: ${e.message}`, { variant: 'error' });
        }
      });
      editHeaderRow.appendChild(editHeaderExportBtn);

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
        const srcNumber = parseInt(copyFromSelect.value, 10);
        if (!srcNumber) return;
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
      if (!editTabs.some((t) => t.id === activeEditTab)) activeEditTab = editTabs[0].id;
      function renderEditTabBar() {
        editTabBar.innerHTML = '';
        editTabs.forEach((t) => {
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
        const t = editTabs.find((t) => t.id === activeEditTab) || editTabs[0];
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
      status.textContent = ch.folders.length
        ? `${ch.files.length} video${ch.files.length === 1 ? '' : 's'} from ${ch.folders.length} folder${ch.folders.length === 1 ? '' : 's'}` +
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
      favoriteCheckbox.checked = !!ch.favorite;
      favoriteCheckbox.addEventListener('change', () => { dispatch({ type: 'channel.set', channel: ch.number, field: 'favorite', value: favoriteCheckbox.checked }); });
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

      const duplicateBtn = document.createElement('button');
      duplicateBtn.className = 'btn titles-btn';
      duplicateBtn.textContent = 'DUPLICATE';
      duplicateBtn.title = 'Clone this channel\'s folders, schedule, and settings as a new channel';
      duplicateBtn.addEventListener('click', () => {
        const clone = deepClone(ch);
        clone.number = nextChannelNumber();
        clone.name = ch.name && ch.name.trim() ? `${ch.name.trim()} COPY` : '';
        dispatch({ type: 'channel.insert', channel: clone }, { label: `Duplicate CH ${ch.number}` });
        S.setupSelectedChannel = clone.number;
        S.setupFilterQuery = '';
        channelFilterEl.value = '';
        renderChannelList();
      });

      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn titles-btn';
      previewBtn.textContent = 'PREVIEW';
      previewBtn.title = 'Jump straight to this channel on the TV screen, optionally as of a chosen date/time';
      previewBtn.disabled = ch.files.length === 0;
      previewBtn.addEventListener('click', () => openPreviewModal(ch));

      const actions = document.createElement('div');
      actions.className = 'channel-actions';
      actions.appendChild(moveUpBtn);
      actions.appendChild(moveDownBtn);
      actions.appendChild(folderBtn);
      actions.appendChild(previewBtn);
      const more = document.createElement('details');
      more.className = 'channel-more';
      const moreSummary = document.createElement('summary');
      moreSummary.className = 'btn';
      moreSummary.textContent = 'MORE…';
      moreSummary.setAttribute('aria-label', `More actions for channel ${ch.number}`);
      const moreMenu = document.createElement('div');
      moreMenu.className = 'channel-more-menu';
      if (fixBtn) moreMenu.appendChild(fixBtn);
      moreMenu.appendChild(duplicateBtn);
      moreMenu.appendChild(removeBtn);
      more.append(moreSummary, moreMenu);
      actions.appendChild(more);

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
        const draggedNumber = parseInt(e.dataTransfer.getData('text/plain'), 10);
        if (!draggedNumber || draggedNumber === ch.number) return;
        const dragged = S.config.channels.find((c) => c.number === draggedNumber);
        if (!dragged) return;
        const swap = { type: 'channel.swapNumbers', a: dragged.number, b: ch.number };
        [dragged.number, ch.number] = [ch.number, dragged.number];
        commitInPlace(swap);
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

// ---------- Lineup list (the left pane) ----------
// One compact row per channel: badge, number, name, and what's on now.
// Selecting a row shows that channel's editor in the detail pane. Rows drag to
// reorder (the same two-channel number swap the ▲▼ buttons make) and accept
// dropped video files (setup-dragdrop.js); Ctrl/Shift+click selects several
// (see Multi-select below).
function selectSetupChannel(value, { focus = false } = {}) {
  S.bulkSelectedChannels.clear();
  S.setupSelectedChannel = value;
  renderChannelList();
  const item = channelListPaneEl && channelListPaneEl.querySelector('.channel-list-item.selected');
  if (focus && item) item.focus({ preventScroll: false });
  // Start the editor at its top when the page had been scrolled down a long
  // one; the list itself stays where it is.
  const content = document.getElementById('setup-content');
  if (content && channelListEl) {
    const top = channelListEl.getBoundingClientRect().top - content.getBoundingClientRect().top;
    if (top < 0) content.scrollTop += top;
  }
}

function renderChannelListPane(list, pluginEntries) {
  if (!channelListPaneEl) return;
  list.forEach((ch) => {
    const multi = isMultiSelecting();
    const selected = multi ? false : S.setupSelectedChannel === ch.number;
    const inMulti = multi && S.bulkSelectedChannels.has(ch.number);
    const item = document.createElement('div');
    item.className = 'channel-list-item' + (selected ? ' selected' : '') + (inMulti ? ' multi-selected' : '') + (ch.hidden ? ' is-hidden' : '');
    item.dataset.channelNumber = String(ch.number);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(selected || inMulti));
    item.tabIndex = (selected || (multi && ch.number === multiSelectFocus)) ? 0 : -1;

    const badge = buildChannelBadge(ch);
    badge.classList.add('channel-list-badge');
    item.appendChild(badge);

    const text = document.createElement('div');
    text.className = 'channel-list-text';
    const title = document.createElement('div');
    title.className = 'channel-list-title';
    const num = document.createElement('span');
    num.className = 'channel-list-number';
    num.textContent = formatChannelNumber(ch.number);
    const name = document.createElement('span');
    name.className = 'channel-list-name';
    name.textContent = ch.name || 'UNTITLED';
    title.append(num, name);
    const sub = document.createElement('div');
    sub.className = 'channel-list-sub';
    if (!ch.files.length && !(ch.blocks || []).some((b) => b.files && b.files.length)) {
      sub.textContent = ch.folders.length ? 'NO VIDEOS FOUND' : 'NO FOLDER YET';
      item.classList.add('needs-content');
    } else {
      const pos = computeLivePosition(ch);
      sub.textContent = pos && pos.file ? getDisplayTitle(pos.file) : '—';
    }
    text.append(title, sub);
    item.appendChild(text);

    const flags = [];
    if (ch.favorite) flags.push('★');
    if (ch.hidden) flags.push('HIDDEN');
    if (ch.notSubscribed) flags.push('LOCKED');
    if (flags.length) {
      const flagEl = document.createElement('span');
      flagEl.className = 'channel-list-flags';
      flagEl.textContent = flags.join(' ');
      item.appendChild(flagEl);
    }

    item.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) toggleMultiSelect(ch.number);
      else if (e.shiftKey) extendMultiSelect(ch.number);
      else selectSetupChannel(ch.number, { focus: true });
    });

    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(ch.number));
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => item.classList.remove('dragging'));
    item.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer.types || []).includes('Files')) return; // dropped videos: setup-dragdrop.js
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (e) => {
      if (Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      item.classList.remove('drag-over');
      const draggedNumber = parseChannelNumber(e.dataTransfer.getData('text/plain'));
      if (!Number.isFinite(draggedNumber) || draggedNumber === ch.number) return;
      const dragged = S.config.channels.find((c) => c.number === draggedNumber);
      if (!dragged) return;
      const swap = { type: 'channel.swapNumbers', a: dragged.number, b: ch.number };
      [dragged.number, ch.number] = [ch.number, dragged.number];
      commitInPlace(swap);
      S.setupSelectedChannel = dragged.number;
      renderChannelList();
    });

    channelListPaneEl.appendChild(item);
  });

  if (pluginEntries.length) {
    const selected = S.setupSelectedChannel === 'plugins';
    const item = document.createElement('div');
    item.className = 'channel-list-item channel-list-plugins' + (selected ? ' selected' : '');
    item.dataset.channelNumber = 'plugins';
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    const text = document.createElement('div');
    text.className = 'channel-list-text';
    const title = document.createElement('div');
    title.className = 'channel-list-title';
    title.textContent = `PLUGIN CHANNELS (${pluginEntries.length})`;
    const sub = document.createElement('div');
    sub.className = 'channel-list-sub';
    sub.textContent = pluginEntries.map((entry) => entry.override.number).join(' · ');
    text.append(title, sub);
    item.appendChild(text);
    item.addEventListener('click', () => selectSetupChannel('plugins', { focus: true }));
    channelListPaneEl.appendChild(item);
  }
}

// ▲▼ / Home / End move the selection through the list, like any list box.
channelListPaneEl?.addEventListener('keydown', (e) => {
  if (!e.target.matches || !e.target.matches('.channel-list-item')) return;
  const items = Array.from(channelListPaneEl.querySelectorAll('.channel-list-item'));
  const index = items.indexOf(e.target);
  const numberOf = (el) => (el && el.dataset.channelNumber !== 'plugins' ? parseChannelNumber(el.dataset.channelNumber) : null);
  // Multi-select from the keyboard: Shift+▲▼ extends, Ctrl+Space toggles,
  // Ctrl+A takes every listed channel, Esc goes back to one.
  if (e.shiftKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    const next = numberOf(items[index + (e.key === 'ArrowDown' ? 1 : -1)]);
    if (next != null) { e.preventDefault(); extendMultiSelect(next); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
    const here = numberOf(e.target);
    if (here != null) { e.preventDefault(); toggleMultiSelect(here); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    selectAllListedChannels();
    return;
  }
  if (e.key === 'Escape' && isMultiSelecting()) {
    e.preventDefault();
    e.stopPropagation();
    selectSetupChannel(numberOf(e.target) ?? multiSelectFocus, { focus: true });
    return;
  }
  let target = null;
  if (e.key === 'ArrowDown') target = items[index + 1];
  else if (e.key === 'ArrowUp') target = items[index - 1];
  else if (e.key === 'Home') target = items[0];
  else if (e.key === 'End') target = items[items.length - 1];
  else if (e.key === 'Enter') {
    e.preventDefault();
    channelListEl.querySelector('input, select, button')?.focus();
    return;
  }
  if (!target) return;
  e.preventDefault();
  const value = target.dataset.channelNumber === 'plugins' ? 'plugins' : parseChannelNumber(target.dataset.channelNumber);
  selectSetupChannel(value, { focus: true });
});

// Per-plugin-channel expand state — mirrors openChannelEditTabs' role for
// real channels below, but there's only ever one panel (CHANNEL DISPLAY) per
// plugin channel today, so this only needs to remember open/closed.
const openPluginChannelPanels = new Set();

// A registerChannelType channel (Music Choice, Party, Prevue, Public Access,
// etc. — plugins.js) has no entry in S.config.channels at all (see that
// file's registerChannelType doc comment and virtual.js) — its content comes
// entirely from the plugin's own render(), not from folders/files/a
// schedule. So unlike a real channel row above, this section only exposes
// what actually applies to a plugin channel: renaming/renumbering it (backed
// by getPluginChannelOverride/updatePluginChannelOverride, plugins.js) and
// the same CHANNEL DISPLAY resolution/aspect override its PLUGINS-tab
// settings row already offers (renderChannelDisplaySettings, imported from
// setup-plugin-settings.js) — no FOLDERS/SCHEDULE/TITLES/ADS tabs, since
// none of those concepts exist for a plugin-supplied channel.
function pluginChannelEntries() {
  const ids = pluginChannelTypeIds();
  if (!ids.length) return [];

  const realNums = new Set((S.config.channels || []).map((c) => c.number));
  const entries = ids
    .map((id) => ({ id, def: getPluginChannelType(id) }))
    .filter(({ def }) => !!def)
    .map(({ id, def }) => ({ id, def, override: getPluginChannelOverride(id, def) }))
    // A real user channel at the same number always wins (same priority
    // rule as virtual.js's virtualChannelNumbers) — that real channel is
    // already shown, edited, and tuned to above; showing a second,
    // currently-inert row for the plugin it's shadowing would just confuse
    // "which one is actually live right now".
    .filter(({ override }) => !realNums.has(override.number));

  const q = (S.setupFilterQuery || '').trim().toLowerCase();
  const list = q
    ? entries.filter(({ override }) => override.name.toLowerCase().includes(q) || String(override.number).includes(q))
    : entries;
  return list.sort((a, b) => a.override.number - b.override.number);
}

function renderPluginChannelSection(list) {
  if (!list.length) return;
  const ids = pluginChannelTypeIds();
  const realNums = new Set((S.config.channels || []).map((c) => c.number));

  const heading = document.createElement('div');
  heading.className = 'plugin-channel-section-heading';
  heading.textContent = 'PLUGIN CHANNELS';
  channelListEl.appendChild(heading);

  const note = document.createElement('span');
  note.className = 'panel-status';
  note.textContent = 'Provided by an installed plugin — content comes from the plugin itself, so only its name, channel number, and display can be changed here.';
  channelListEl.appendChild(note);

  list.forEach(({ id, def, override }) => {
    const row = document.createElement('div');
    row.className = 'channel-row plugin-channel-row';
    row.dataset.channelNumber = String(override.number);

    const badge = document.createElement('div');
    badge.className = 'channel-badge';
    const badgeInfo = def.badge || { bg: '#3b82f6', label: String(override.number) };
    badge.style.background = badgeInfo.bg;
    badge.textContent = badgeInfo.label;
    row.appendChild(badge);

    const numInput = document.createElement('input');
    numInput.type = 'number';
    numInput.min = 0;
    numInput.value = override.number;
    numInput.setAttribute('aria-label', 'Channel number');
    if (def.numberLocked) {
      // Some plugins (music-choice-channel, party-channel) internally
      // compare S.currentNumber against their OWN hardcoded channel-number
      // constant rather than reading a live effective number — renumbering
      // them here would desync those internal checks from the number the
      // channel actually moved to. See each plugin's registerChannelType
      // call for the specifics; this is an opt-out, not a core limitation.
      numInput.disabled = true;
      numInput.title = "This plugin's channel number can't be changed — its own code depends on staying at this number.";
    } else {
      numInput.addEventListener('change', () => {
        const v = parseInt(numInput.value, 10);
        if (Number.isNaN(v) || v < 0 || v === override.number) { numInput.value = override.number; return; }
        const inUse = realNums.has(v) || ids.some((otherId) => {
          if (otherId === id) return false;
          const otherDef = getPluginChannelType(otherId);
          return otherDef && getPluginChannelOverride(otherId, otherDef).number === v;
        });
        if (inUse) {
          scanProgressEl.classList.remove('hidden');
          scanProgressEl.textContent = `CH ${v} IS ALREADY IN USE`;
          setTimeout(() => scanProgressEl.classList.add('hidden'), 2500);
          numInput.value = override.number;
          return;
        }
        updatePluginChannelOverride(id, { number: v });
        renderChannelList();
      });
    }
    row.appendChild(numInput);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = 'CHANNEL NAME';
    nameInput.value = override.name;
    // Unlike a real channel's name field (which mutates ch.name directly and
    // lets saveConfigDebounced() alone persist it), there's no live object
    // reference to mutate here — updatePluginChannelOverride always writes
    // straight to config. Deliberately not re-rendering the list on every
    // keystroke (only on blur/Enter's 'change') so the input doesn't lose
    // focus mid-type.
    nameInput.addEventListener('change', () => {
      updatePluginChannelOverride(id, { name: nameInput.value.trim() || null });
    });
    row.appendChild(nameInput);

    const idLabel = document.createElement('span');
    idLabel.className = 'plugin-channel-id-label';
    idLabel.textContent = `PLUGIN: ${id}`;
    row.appendChild(idLabel);

    const displayToggle = document.createElement('button');
    displayToggle.className = 'btn';
    displayToggle.textContent = openPluginChannelPanels.has(id) ? 'DISPLAY ▲' : 'DISPLAY ▾';
    row.appendChild(displayToggle);

    channelListEl.appendChild(row);

    const displayPanel = document.createElement('div');
    displayPanel.className = 'titles-panel edit-panel' + (openPluginChannelPanels.has(id) ? '' : ' hidden');
    channelListEl.appendChild(displayPanel);
    if (openPluginChannelPanels.has(id)) renderChannelDisplaySettings(displayPanel, id, def);

    displayToggle.addEventListener('click', () => {
      const nowOpen = !openPluginChannelPanels.has(id);
      if (nowOpen) openPluginChannelPanels.add(id); else openPluginChannelPanels.delete(id);
      displayPanel.classList.toggle('hidden', !nowOpen);
      displayToggle.textContent = nowOpen ? 'DISPLAY ▲' : 'DISPLAY ▾';
      if (nowOpen) renderChannelDisplaySettings(displayPanel, id, def);
    });
  });
}

// Bulk-select mode's action bar — visible only once at least one channel is
// checked, so it's not a permanent fixture crowding the CHANNELS tab.
function renderBulkActionsBar() {
  const count = S.bulkSelectedChannels.size;
  bulkActionsBar.classList.toggle('hidden', count < 2);
  bulkSelectedCountEl.textContent = `${count} SELECTED`;
}

// ---------- Multi-select (docs/design/03 §4) ----------
// Ctrl/Cmd+click toggles a channel, Shift+click selects a range. With more
// than one channel selected the detail pane shows the bulk bar in place of
// a single channel's editor; a plain click goes back to one channel.
let multiSelectAnchor = null;
let multiSelectFocus = null;
const bulkActionsBarHome = document.createComment('bulk actions bar');
bulkActionsBar.before(bulkActionsBarHome);

function isMultiSelecting() {
  return S.bulkSelectedChannels.size > 1;
}

// The bar lives in the detail pane only while it is needed; renderChannelList
// clears that pane, so it goes back to its place in the page first.
function parkBulkActionsBar() {
  if (bulkActionsBar.parentNode !== bulkActionsBarHome.parentNode) bulkActionsBarHome.after(bulkActionsBar);
}

function listedChannelNumbers() {
  return filteredSetupChannels(sortedForSetup()).map((c) => c.number);
}

function settleMultiSelect(focusNumber) {
  if (S.bulkSelectedChannels.size === 1) {
    const [only] = S.bulkSelectedChannels;
    S.bulkSelectedChannels.clear();
    S.setupSelectedChannel = only;
  }
  multiSelectFocus = focusNumber;
  renderChannelList();
  channelListPaneEl?.querySelector(`.channel-list-item[data-channel-number="${focusNumber}"]`)?.focus();
}

function toggleMultiSelect(number) {
  if (!isMultiSelecting()) {
    S.bulkSelectedChannels.clear();
    if (typeof S.setupSelectedChannel === 'number') S.bulkSelectedChannels.add(S.setupSelectedChannel);
    multiSelectAnchor = S.setupSelectedChannel;
  }
  if (S.bulkSelectedChannels.has(number)) S.bulkSelectedChannels.delete(number);
  else S.bulkSelectedChannels.add(number);
  multiSelectAnchor = number;
  if (S.bulkSelectedChannels.size === 0) S.setupSelectedChannel = number;
  settleMultiSelect(number);
}

function extendMultiSelect(number) {
  const listed = listedChannelNumbers();
  const anchor = isMultiSelecting() && multiSelectAnchor != null ? multiSelectAnchor
    : (typeof S.setupSelectedChannel === 'number' ? S.setupSelectedChannel : number);
  multiSelectAnchor = anchor;
  const from = listed.indexOf(anchor);
  const to = listed.indexOf(number);
  if (from < 0 || to < 0) return;
  S.bulkSelectedChannels = new Set(listed.slice(Math.min(from, to), Math.max(from, to) + 1));
  settleMultiSelect(number);
}

function selectAllListedChannels() {
  const listed = listedChannelNumbers();
  if (listed.length < 2) return;
  multiSelectAnchor = listed[0];
  S.bulkSelectedChannels = new Set(listed);
  settleMultiSelect(multiSelectFocus ?? listed[0]);
}

function renderMultiSelectDetail() {
  const card = document.createElement('div');
  card.className = 'channel-multi-detail';
  const heading = document.createElement('div');
  heading.className = 'channel-multi-heading';
  const title = document.createElement('strong');
  title.textContent = `${S.bulkSelectedChannels.size} CHANNELS SELECTED`;
  const names = document.createElement('span');
  names.textContent = selectedChannels().sort((a, b) => a.number - b.number)
    .map((c) => `${formatChannelNumber(c.number)} ${c.name || 'UNTITLED'}`).join(' · ');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn';
  clear.textContent = 'CLEAR SELECTION';
  clear.addEventListener('click', () => selectSetupChannel(multiSelectFocus, { focus: true }));
  heading.append(title, clear);
  const hint = document.createElement('p');
  hint.className = 'channel-multi-hint';
  hint.textContent = 'Ctrl+click adds or removes a channel, Shift+click selects a range, Esc goes back to one channel.';
  card.append(heading, names, bulkActionsBar, hint);
  channelListEl.appendChild(card);
}

window.addEventListener('reruntv:select-all-channels', () => selectAllChannelsFromSearch());
export function selectAllChannelsFromSearch() {
  document.querySelector('.setup-tab-btn[data-tab="channels"]')?.click();
  selectAllListedChannels();
}

function selectedChannels() {
  return S.config.channels.filter((c) => S.bulkSelectedChannels.has(c.number));
}


// ---------- Cross-channel library search ----------
// The existing Titles-tab filter and channel-list filter both search within
// one already-known scope (one channel's files, or the channel list by
// name) — this searches every channel's file list at once, for "which
// channel has this episode/show" when you don't remember where you put it.
function renderLibrarySearchResults(query) {
  librarySearchResultsEl.innerHTML = '';
  const q = query.trim().toLowerCase();
  if (!q) {
    const empty = document.createElement('div');
    empty.className = 'library-search-empty';
    empty.textContent = 'TYPE TO SEARCH EVERY CHANNEL AT ONCE.';
    librarySearchResultsEl.appendChild(empty);
    return;
  }
  const matches = [];
  sortedChannels().forEach((ch) => {
    (ch.files || []).forEach((f) => {
      const title = getDisplayTitle(f);
      const base = basenameNoExt(f.path);
      if (title.toLowerCase().includes(q) || base.toLowerCase().includes(q)) {
        matches.push({ ch, file: f, title });
      }
    });
  });
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'library-search-empty';
    empty.textContent = `NO FILES MATCH "${query.trim()}".`;
    librarySearchResultsEl.appendChild(empty);
    return;
  }
  matches.slice(0, 200).forEach(({ ch, title }) => {
    const row = document.createElement('div');
    row.className = 'library-search-row';
    const chan = document.createElement('span');
    chan.className = 'lsr-chan';
    chan.textContent = `CH ${ch.number} — ${ch.name || 'UNNAMED'}`;
    const titleEl = document.createElement('span');
    titleEl.className = 'lsr-title';
    titleEl.textContent = title;
    const jumpBtn = document.createElement('button');
    jumpBtn.className = 'btn';
    jumpBtn.textContent = 'JUMP TO CHANNEL';
    jumpBtn.addEventListener('click', () => {
      librarySearchPanelEl.classList.add('hidden');
      librarySearchToggleBtn.classList.remove('active');
      S.setupFilterQuery = String(ch.number);
      channelFilterEl.value = String(ch.number);
      S.setupSelectedChannel = ch.number;
      renderChannelList();
      requestAnimationFrame(() => {
        const row = channelListEl.querySelector(`[data-channel-number="${ch.number}"]`);
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
    row.appendChild(chan);
    row.appendChild(titleEl);
    row.appendChild(jumpBtn);
    librarySearchResultsEl.appendChild(row);
  });
  if (matches.length > 200) {
    const note = document.createElement('div');
    note.className = 'library-search-empty';
    note.textContent = `+ ${matches.length - 200} MORE — NARROW YOUR SEARCH.`;
    librarySearchResultsEl.appendChild(note);
  }
}

librarySearchToggleBtn.addEventListener('click', () => {
  const opening = librarySearchPanelEl.classList.contains('hidden');
  librarySearchPanelEl.classList.toggle('hidden', !opening);
  librarySearchToggleBtn.classList.toggle('active', opening);
  nowNextPanelEl.classList.add('hidden');
  nowNextToggleBtn.classList.remove('active');
  if (opening) {
    librarySearchInputEl.value = '';
    renderLibrarySearchResults('');
    librarySearchInputEl.focus();
  }
});
// Debounced — this re-scans every channel's whole file list on every
// keystroke (see renderLibrarySearchResults above), which starts to visibly
// lag typing once a library grows into the hundreds/thousands of files.
let librarySearchDebounceTimer = null;
librarySearchInputEl.addEventListener('input', () => {
  clearTimeout(librarySearchDebounceTimer);
  librarySearchDebounceTimer = setTimeout(() => renderLibrarySearchResults(librarySearchInputEl.value), 150);
});

bulkSelectAllBtn.addEventListener('click', () => {
  const visible = filteredSetupChannels(sortedForSetup());
  const allSelected = visible.every((c) => S.bulkSelectedChannels.has(c.number));
  if (allSelected) {
    selectSetupChannel(multiSelectFocus, { focus: true });
    return;
  }
  visible.forEach((c) => S.bulkSelectedChannels.add(c.number));
  renderChannelList();
});

// Bulk actions: one undo step for however many channels are selected.
function setOnSelected(field, value, label) {
  const targets = selectedChannels();
  if (!targets.length) return;
  dispatch(targets.map((c) => ({ type: 'channel.set', channel: c.number, field, value })),
    { label: `${label} on ${targets.length} channel${targets.length === 1 ? '' : 's'}` });
}
bulkFavoriteOnBtn.addEventListener('click', () => { setOnSelected('favorite', true, 'Favorite'); renderChannelList(); });
bulkFavoriteOffBtn.addEventListener('click', () => { setOnSelected('favorite', false, 'Unfavorite'); renderChannelList(); });
bulkShuffleOnBtn.addEventListener('click', () => {
  const targets = selectedChannels();
  targets.forEach((c) => { c.shuffle = true; if (c.files.length > 1) shuffleArray(c.files); });
  if (targets.length) commitInPlace(targets.map((c) => ownerFieldsCommand(c, ['shuffle', 'files'])), { label: `Shuffle ${targets.length} channel${targets.length === 1 ? '' : 's'}` });
  renderChannelList();
});
bulkShuffleOffBtn.addEventListener('click', () => {
  const targets = selectedChannels();
  targets.forEach((c) => { c.shuffle = false; });
  if (targets.length) commitInPlace(targets.map((c) => ownerFieldsCommand(c, ['shuffle'])), { label: `Unshuffle ${targets.length} channel${targets.length === 1 ? '' : 's'}` });
  renderChannelList();
});
bulkRatingApplyBtn.addEventListener('click', () => {
  setOnSelected('rating', bulkRatingSelect.value || null, 'Set rating');
  renderChannelList();
});
attachSliderReadout(bulkVolumeSlider, { suffix: '%' });
bulkVolumeApplyBtn.addEventListener('click', () => {
  setOnSelected('volume', parseInt(bulkVolumeSlider.value, 10) / 100, 'Set volume');
  renderChannelList();
});
bulkVolumeInheritBtn.addEventListener('click', () => {
  setOnSelected('volume', null, 'Reset volume');
  renderChannelList();
});
bulkRemoveBtn.addEventListener('click', async () => {
  const targets = selectedChannels();
  if (!targets.length) return;
  if (!(await confirmDialog(`Remove ${targets.length} selected channel${targets.length === 1 ? '' : 's'} and all their content/settings? You can undo this.`))) return;
  dispatch(targets.map((c) => ({ type: 'channel.remove', channel: c.number })),
    { label: `Remove ${targets.length} channel${targets.length === 1 ? '' : 's'}` });
  S.bulkSelectedChannels.clear();
  S.setupSelectedChannel = null;
  renderChannelList();
});

// ---------- Media sources (CHOOSE SOURCE) ----------
// Which media-source provider plugins are actually activated right now
// (main.js's plugins:listMediaSourceProviders — a filtered projection of
// discoverPlugins(), see main.js's own comment). Fetched once per session,
// not per row-render — a plugin's activation state can't change without an
// app restart (same "restart to activate" convention every capability
// change already follows), so there's nothing to gain from re-fetching on
// every renderChannelList() call, only IPC round-trips to avoid.
let cachedMediaSourceProviders = [];
let mediaSourceProvidersFetchStarted = false;
function ensureMediaSourceProvidersLoaded() {
  if (mediaSourceProvidersFetchStarted) return;
  mediaSourceProvidersFetchStarted = true;
  window.api.listMediaSourceProviders().then((providers) => {
    if (!providers || !providers.length) return;
    cachedMediaSourceProviders = providers;
    renderChannelList(); // re-render once so already-drawn rows pick up the real picker instead of just "CHOOSE FOLDER"
  }).catch(() => {}); // no providers active — cachedMediaSourceProviders stays [], every row just shows the plain local button
}

// The per-channel folder/source picker — a plain "CHOOSE FOLDER" button
// when no media-source provider plugin is active (true for the overwhelming
// majority of setups, and exactly what every existing screenshot/muscle
// memory already expects — zero visual change), or a small select offering
// "Local Folder" plus each active provider once at least one exists.
function buildChooseSourceControl(ch) {
  if (!cachedMediaSourceProviders.length) {
    const btn = document.createElement('button');
    btn.className = 'btn folder-btn';
    btn.textContent = ch.folders.length ? '+ ADD FOLDER' : 'CHOOSE FOLDER';
    btn.addEventListener('click', () => addFolderToChannel(ch));
    return btn;
  }

  const select = document.createElement('select');
  select.className = 'btn folder-btn';
  select.title = 'CHOOSE SOURCE';
  const localOpt = document.createElement('option');
  localOpt.value = '';
  localOpt.textContent = ch.folders.length ? '+ ADD FOLDER…' : 'CHOOSE SOURCE…';
  select.appendChild(localOpt);
  const localSubOpt = document.createElement('option');
  localSubOpt.value = 'local';
  localSubOpt.textContent = 'LOCAL FOLDER';
  select.appendChild(localSubOpt);
  cachedMediaSourceProviders.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.providerId;
    opt.textContent = p.displayName.toUpperCase();
    select.appendChild(opt);
  });
  select.addEventListener('change', () => {
    const providerId = select.value;
    select.value = '';
    if (!providerId || providerId === 'local') { addFolderToChannel(ch); return; }
    addPluginSourceToChannel(ch, providerId);
  });
  return select;
}

// Mirrors addFolderToChannel's picker -> scan -> probe -> merge flow below,
// but for a plugin-provided source: the plugin owns what "picking a
// folder" even means for its own namespace (core has no folder-browser UI
// for e.g. a Drive folder). Three-tier fallback, richest first:
//   1. A renderer-registered picker (registerMediaSourcePicker, plugins.js)
//      — the plugin's own renderer.js builds and shows a real modal
//      (breadcrumbs, a clickable list, whatever fits its data), same-window
//      plain function call, no IPC involved.
//   2. A main-process pickFolder service verb (PLUGIN_DEVELOPMENT.md's
//      "Media sources" section) — for a provider that would rather not
//      ship any renderer UI at all.
//   3. A plain text-input prompt (setup-dialogs.js's promptDialog) — always
//      available, so CHOOSE SOURCE never dead-ends even for the simplest
//      possible provider.
// tryGetDisplayName moved to channels.js (see its own comment there) — it's
// pure logic setup-interstitials.js needs too, and living there avoids that
// module and this one importing from each other.

export async function addPluginSourceToChannel(ch, providerId) {
  const providerInfo = cachedMediaSourceProviders.find((p) => p.providerId === providerId);
  const label = providerInfo ? providerInfo.displayName : providerId;

  let folderRef;
  const renderedPicker = getMediaSourcePicker(providerId);
  if (renderedPicker) {
    folderRef = await renderedPicker();
  } else {
    try {
      folderRef = await window.api.callMediaSourceHook(providerId, 'pickFolder');
    } catch (err) {
      // No pickFolder hook registered for this provider either — raw
      // window.prompt() is never used anywhere else in this app (it has
      // its own styled dialog system, setup-dialogs.js) and turned out to
      // be silently inert in this app's Electron context, so this uses the
      // same in-theme prompt every other text-input flow in setup uses.
      folderRef = await promptDialog({
        title: `${label.toUpperCase()} FOLDER`,
        message: `Enter a folder reference for ${label} (this provider has no picker UI of its own):`,
      });
    }
  }
  if (!folderRef) return;

  if (ch.folders.some((e) => e.source === providerId && e.ref === folderRef)) {
    scanProgressEl.classList.remove('hidden');
    scanProgressEl.textContent = 'THAT SOURCE IS ALREADY ON THIS CHANNEL';
    setTimeout(() => scanProgressEl.classList.add('hidden'), 2000);
    return;
  }

  scanProgressEl.classList.remove('hidden');
  scanProgressEl.textContent = `SCANNING ${label.toUpperCase()}…`;

  let refs;
  try {
    refs = await window.api.scanFolder(providerId, folderRef);
  } catch (err) {
    scanProgressEl.textContent = `COULDN'T REACH ${label.toUpperCase()}: ${(err && err.message) || 'unknown error'}`;
    setTimeout(() => scanProgressEl.classList.add('hidden'), 3500);
    return;
  }
  if (!refs || refs.length === 0) {
    scanProgressEl.textContent = `NO VIDEO FILES FOUND IN THAT ${label.toUpperCase()} FOLDER`;
    setTimeout(() => scanProgressEl.classList.add('hidden'), 2500);
    return;
  }

  const entry = { id: mediaRefId(providerId, folderRef), source: providerId, ref: folderRef, label: null };
  const newFiles = [];
  for (let i = 0; i < refs.length; i++) {
    scanProgressEl.textContent = `PROBING VIDEO ${i + 1} / ${refs.length}…`;
    // refs[i] is already the wrapped mediasource:<providerId>: form (main.js's
    // fs:scanFolder handler applies that once, at scan time) — probing
    // needs the raw ref back, same convention every provider call uses.
    const rawRef = parseMediaRef(refs[i]).ref;
    // Independent lookups (duration, title, metadata) for the same file —
    // run in parallel rather than sequentially awaited. Found in review: for
    // a 200-file Drive folder this was doubling scan wall-clock time for no
    // reason, since neither call depends on the other's result.
    // eslint-disable-next-line no-await-in-loop -- files themselves are still scanned one at a time, only the per-file lookups are parallelized
    const [duration, title, metadata] = await Promise.all([
      probeDurationForEntry(providerId, rawRef),
      tryGetDisplayName(providerId, rawRef),
      tryGetMetadata(providerId, rawRef),
    ]);
    newFiles.push({
      path: refs[i], duration, folder: entry.id, source: providerId, ...(title ? { title } : {}),
      ...(metadata && metadata.description ? { description: metadata.description } : {}),
      ...(metadata && metadata.facets ? { facets: { ...freshFileFacets(), ...metadata.facets } } : {}),
    });
  }
  ch.folders.push(entry);
  ch.files = ch.files.concat(newFiles);
  if (ch.shuffle) shuffleArray(ch.files);
  if (!ch.anchor) ch.anchor = Date.now();
  scanProgressEl.classList.add('hidden');
  commitOwnerFields(ch, ['folders', 'files', 'anchor'], { label: `Add folder to CH ${ch.number}` });
  renderChannelList();
}

// Adds a folder to a channel's playlist, alongside whatever's already there
// — CHOOSE/CHANGE FOLDER used to replace ch.files outright, but multi-folder
// channels need the scan to merge in rather than clobber. Always local —
// see addPluginSourceToChannel above for the plugin-provided-source
// counterpart CHOOSE SOURCE offers once at least one provider is active.
export async function addFolderToChannel(ch) {
  const folder = await window.api.selectFolder();
  if (!folder) return;
  if (ch.folders.some((e) => e.source === 'local' && e.ref === folder)) {
    scanProgressEl.classList.remove('hidden');
    scanProgressEl.textContent = 'THAT FOLDER IS ALREADY ON THIS CHANNEL';
    setTimeout(() => scanProgressEl.classList.add('hidden'), 2000);
    return;
  }

  scanProgressEl.classList.remove('hidden');
  scanProgressEl.textContent = 'SCANNING FOLDER…';

  const paths = await window.api.scanFolder('local', folder);
  if (paths.length === 0) {
    scanProgressEl.textContent = 'NO VIDEO FILES FOUND IN THAT FOLDER';
    setTimeout(() => scanProgressEl.classList.add('hidden'), 2500);
    return;
  }

  const entry = { id: mediaRefId('local', folder), source: 'local', ref: folder, label: null };
  const newFiles = [];
  for (let i = 0; i < paths.length; i++) {
    scanProgressEl.textContent = `PROBING VIDEO ${i + 1} / ${paths.length}…`;
    const duration = await probeDurationForEntry('local', paths[i]);
    newFiles.push({ path: paths[i], duration, folder: entry.id, source: 'local' });
  }
  ch.folders.push(entry);
  ch.files = ch.files.concat(newFiles);
  if (ch.shuffle) shuffleArray(ch.files);
  // Anchor is set once, the first time a channel gets any content — later
  // folder additions extend the loop from that same reference point rather
  // than restarting the "always live" clock.
  if (!ch.anchor) ch.anchor = Date.now();
  scanProgressEl.classList.add('hidden');
  commitOwnerFields(ch, ['folders', 'files', 'anchor'], { label: `Add folder to CH ${ch.number}` });
  renderChannelList();
}

// Re-scans every folder already assigned to every channel, picking up files
// added to disk (or, for a plugin source, added at the source) since the
// last scan. Additive only — a file that vanished stays in the channel list
// (and keeps any custom title) rather than being silently dropped, matching
// the "no silent destructive action" rule the confirm-on-remove dialogs
// follow. A non-'local' entry whose provider is currently unreachable/
// disabled (a stale reference in a hand-edited config, or a plugin toggled
// off) is skipped with its own error caught per-entry, not per-channel —
// one broken source shouldn't abort rescanning every other channel's
// folders in the same pass.
export async function rescanAllFolders() {
  const targets = S.config.channels.filter((c) => c.folders && c.folders.length > 0);
  if (targets.length === 0) return;

  scanProgressEl.classList.remove('hidden');
  let added = 0;
  let unreachable = 0;
  for (const ch of targets) {
    for (const entry of ch.folders) {
      const label = ch.name && ch.name.trim() ? ch.name.trim() : `CH ${ch.number}`;
      scanProgressEl.textContent = `RESCANNING ${label}: ${entry.label || entry.ref}…`;
      let paths;
      try {
        paths = await window.api.scanFolder(entry.source, entry.ref);
      } catch (err) {
        unreachable++;
        continue; // eslint-disable-line no-continue
      }
      const known = new Set(ch.files.filter((f) => f.folder === entry.id).map((f) => f.path));
      const newPaths = paths.filter((p) => !known.has(p));
      for (let i = 0; i < newPaths.length; i++) {
        scanProgressEl.textContent = `${label}: PROBING NEW VIDEO ${i + 1} / ${newPaths.length}…`;
        // newPaths[i] is already the wrapped form (main.js's fs:scanFolder
        // handler applies that once, at scan time) — probing needs the raw,
        // provider-native ref back, same as any provider's own probe(ref).
        const rawRef = entry.source === 'local' ? newPaths[i] : parseMediaRef(newPaths[i]).ref;
        // Parallel, not sequential — see addPluginSourceToChannel's own
        // comment on the same pattern above.
        // eslint-disable-next-line no-await-in-loop
        const [duration, title, metadata] = await Promise.all([
          probeDurationForEntry(entry.source, rawRef),
          entry.source === 'local' ? Promise.resolve(null) : tryGetDisplayName(entry.source, rawRef),
          entry.source === 'local' ? Promise.resolve(null) : tryGetMetadata(entry.source, rawRef),
        ]);
        ch.files.push({
          path: newPaths[i], duration, folder: entry.id, source: entry.source, ...(title ? { title } : {}),
          ...(metadata && metadata.description ? { description: metadata.description } : {}),
          ...(metadata && metadata.facets ? { facets: { ...freshFileFacets(), ...metadata.facets } } : {}),
        });
        added++;
      }
      if (ch.shuffle && newPaths.length > 0) shuffleArray(ch.files);
    }
  }
  const addedText = added > 0 ? `${added} NEW VIDEO${added === 1 ? '' : 'S'} ADDED` : 'NO NEW VIDEOS FOUND';
  const unreachableText = unreachable > 0 ? ` — ${unreachable} FOLDER${unreachable === 1 ? '' : 'S'} UNREACHABLE, LEFT UNCHANGED` : '';
  scanProgressEl.textContent = `RESCAN COMPLETE — ${addedText}${unreachableText}`;
  setTimeout(() => scanProgressEl.classList.add('hidden'), unreachable > 0 ? 5000 : 3000);
  renderChannelList();
}

export function removeFolderFromChannel(ch, folderEntry) {
  ch.folders = ch.folders.filter((e) => e.id !== folderEntry.id);
  ch.files = ch.files.filter((f) => f.folder !== folderEntry.id);
  commitOwnerFields(ch, ['folders', 'files'], { label: `Remove folder from CH ${ch.number}` });
  renderChannelList();
}

// ---------- PREVIEW (test-tune a channel from setup) ----------
// Jumps straight to the TV screen tuned to a specific channel, optionally
// "as of" a chosen date/time rather than right now — configurable because
// so much of what a channel actually looks like (blocks, ad presets,
// breakpoints, VHS quality, broadcast-hours sign-off) only depends on real
// time via viewNow(), and the only way to see "what does this look like on
// Christmas Day at 3pm" otherwise is to wait for it or use the in-viewer
// time machine after already tuning in manually. Reuses the exact same
// S.timeOffsetMs mechanism the time machine uses (state.js's viewNow()),
// so a preview is indistinguishable from live playback to every other
// module — nothing scheduling-related needs to know "this is a preview."
// Which channel the modal's currently open for — needed by the block
// dropdown and quick-jump buttons below, which all need ch.blocks/
// ch.broadcastHours, not just the number already stashed on the dataset.
let previewChannel = null;

export function openPreviewModal(ch) {
  previewChannel = ch;
  previewPreciseMs = null;
  previewModalChannelLabelEl.textContent = `CH ${ch.number}${ch.name ? ' — ' + ch.name : ''}`;
  previewModalDatetimeEl.value = toDatetimeLocalValue(new Date());
  previewModalEl.dataset.channelNumber = String(ch.number);

  previewModalBlockEl.innerHTML = '<option value="">— pick a block —</option>';
  (ch.blocks || []).forEach((b, idx) => {
    if (!b.files || !b.files.length) return; // nothing would ever actually air
    const opt = document.createElement('option');
    opt.value = String(idx);
    opt.textContent = blockPickerLabel(b);
    previewModalBlockEl.appendChild(opt);
  });
  previewModalBlockEl.value = '';

  previewModalEl.classList.remove('hidden');
  previewModalDatetimeEl.focus();
}

function closePreviewModal() {
  previewModalEl.classList.add('hidden');
  previewChannel = null;
}

// datetime-local only stores minute precision, but a quick-jump chain (e.g.
// SHOW START then SHOW END) needs the exact millisecond that was actually
// computed — truncating to the displayed minute and re-parsing it can round
// backward across a file boundary (a show ending at :54:37 displays as :54,
// which re-parses as :54:00 and lands 37s into the *previous* file instead).
// previewPreciseMs carries the real value between quick-jump clicks; it's
// only trusted while the field still shows the same minute it was set to —
// the moment the user types a new value by hand, this goes stale and
// getPreviewFieldMs falls back to parsing the field like before.
let previewPreciseMs = null;

function getPreviewFieldMs() {
  const raw = previewModalDatetimeEl.value;
  if (previewPreciseMs != null && raw === toDatetimeLocalValue(new Date(previewPreciseMs))) {
    return previewPreciseMs;
  }
  const ms = raw ? new Date(raw).getTime() : Date.now();
  return Number.isFinite(ms) ? ms : Date.now();
}

function setPreviewFieldMs(ms) {
  previewPreciseMs = ms;
  previewModalDatetimeEl.value = toDatetimeLocalValue(new Date(ms));
}

// Scans forward hour-by-hour (trigger matching is hour-granular — see
// hourInRange, schedule.js) looking for the next moment this specific
// block's own trigger matches, ignoring priority/other-block overlap — this
// is a "when would THIS block ever be live" jump for testing it in
// isolation, not a promise resolveActiveSource will pick it once there
// (a higher-priority block could still win at that instant).
// nextBreakBoundary returns the *end* of a break already in progress at
// fromMs, or the *start* of the next one otherwise — looping past any
// already-in-progress break so NEXT BREAK always lands you at a break's
// start, never its tail end.
previewModalCancelBtn.addEventListener('click', closePreviewModal);
previewModalNowBtn.addEventListener('click', () => {
  previewPreciseMs = null;
  previewModalDatetimeEl.value = toDatetimeLocalValue(new Date());
});
// A hand-typed edit always wins — never let a stale previewPreciseMs from an
// earlier quick-jump silently override what the user just typed.
previewModalDatetimeEl.addEventListener('input', () => { previewPreciseMs = null; });
previewModalEl.addEventListener('click', (e) => {
  if (e.target === previewModalEl) closePreviewModal(); // click on the dimmed backdrop
});

previewModalBlockEl.addEventListener('change', () => {
  if (!previewChannel || previewModalBlockEl.value === '') return;
  const block = (previewChannel.blocks || [])[parseInt(previewModalBlockEl.value, 10)];
  if (!block) return;
  const targetMs = nextBlockActiveMs(block, getPreviewFieldMs());
  if (targetMs == null) {
    alertDialog('That block\'s trigger never matches within the next year — check its date range/hours.');
    return;
  }
  setPreviewFieldMs(targetMs);
});

// Each quick-jump button rewrites the datetime field from its *current*
// value (not always "now"), so they compose — e.g. +1 DAY then NEXT BREAK
// finds the next break after that later time.
previewModalQuickEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-jump]');
  if (!btn || !previewChannel) return;
  const fromMs = getPreviewFieldMs();
  const ch = previewChannel;
  switch (btn.dataset.jump) {
    case 'show-start':
    case 'show-end': {
      const pos = computeSourcePosition(resolveActiveSource(ch, fromMs), fromMs);
      if (!pos) { alertDialog('Nothing scheduled to air at that moment.'); return; }
      const startMs = fromMs - pos.offset * 1000;
      setPreviewFieldMs(btn.dataset.jump === 'show-start' ? startMs : startMs + pos.file.duration * 1000);
      break;
    }
    case 'next-break': {
      const targetMs = nextBreakStartMs(ch, fromMs);
      if (targetMs == null) { alertDialog('No break scheduled within the lookahead window.'); return; }
      setPreviewFieldMs(targetMs);
      break;
    }
    case 'top-of-hour': {
      const d = new Date(fromMs);
      d.setMinutes(0, 0, 0);
      setPreviewFieldMs(d.getTime() + 3600000);
      break;
    }
    case 'plus-1h': setPreviewFieldMs(fromMs + 3600000); break;
    case 'plus-1d': setPreviewFieldMs(fromMs + 86400000); break;
    case 'random': setPreviewFieldMs(randomPreviewMs(ch, fromMs)); break;
  }
});

previewModalGoBtn.addEventListener('click', () => {
  const chNumber = parseInt(previewModalEl.dataset.channelNumber, 10);
  // getPreviewFieldMs(), not a raw re-parse of the field — a quick-jump
  // button (NEXT BREAK especially, whose windows are often a handful of
  // seconds long) computes sub-minute precision that the visible field can
  // only display truncated to the minute; re-parsing that truncated text
  // here silently threw the precision away and could land you outside the
  // very break window NEXT BREAK just found.
  const targetMs = getPreviewFieldMs();
  if (!Number.isFinite(targetMs)) {
    alertDialog('That date/time isn\'t valid.');
    return;
  }
  S.timeOffsetMs = targetMs - Date.now();
  S.setupPreviewActive = true;
  closePreviewModal();
  showTvScreen();
  tuneToChannel(chNumber);
  previewBannerEl.textContent = `SETUP PREVIEW — CH ${chNumber} @ ${formatPreviewBannerTime(targetMs)} — PRESS S TO RETURN`;
  previewBannerEl.classList.remove('hidden');
});

subChannelsEnabledEl?.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['subChannels', 'enabled'], value: subChannelsEnabledEl.checked });
  // Re-render so every number box picks up its new step immediately — the
  // step is set when a row is built, so without this the arrows keep their
  // old behaviour until something else happens to rebuild the list.
  renderChannelList();
});

addChannelBtn.addEventListener('click', () => {
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
    scanProgressEl.classList.remove('hidden');
    scanProgressEl.textContent = `EXPORTED TO ${filePath}`;
    setTimeout(() => scanProgressEl.classList.add('hidden'), 3000);
  } catch (e) {
    alertDialog(`Export failed: ${e.message}`, { variant: 'error' });
  }
});

channelImportBtn.addEventListener('click', async () => {
  let imported;
  try { imported = await window.api.importConfig(); }
  catch (e) { alertDialog(`Import failed: ${e.message}`, { variant: 'error' }); return; }
  if (!imported) return;
  const pkg = normalizeChannelPackage(imported);
  if (!pkg) {
    await alertDialog('Choose a single-channel package. Full configurations still use IMPORT CONFIG.', { title: 'NOT A CHANNEL PACKAGE' });
    return;
  }

  let targetNumber = Number(pkg.channel.number);
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
    if (!Number.isInteger(targetNumber) || targetNumber < 1 || targetNumber > 9999) {
      await alertDialog('Enter a whole-number channel from 1 to 9999.', { variant: 'error' });
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
    const newRoot = await window.api.selectFolder();
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

configImportBtn.addEventListener('click', async () => {
  let imported;
  try {
    imported = await window.api.importConfig();
  } catch (e) {
    alertDialog(`Import failed: ${e.message}`, { variant: 'error' });
    return;
  }
  if (!imported) return; // user canceled the open dialog
  if (!(await confirmDialog('Import this config? It replaces every channel and setting currently loaded — anything not saved yet will be lost.'))) return;

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
  if (!S.config.channels || S.config.channels.length === 0) {
    try {
      const fresh = await window.api.loadConfig();
      if (fresh && fresh.channels && fresh.channels.length > 0) {
        S.config = applyConfigDefaults(fresh);
      }
    } catch (e) {}
  }
  S.config.channels = (S.config.channels || []).filter((c) => (c.files && c.files.length > 0) || (c.name && c.name.trim()) || (c.folders && c.folders.length > 0));
  await saveConfigNow();
  resetUndoBaseline();
  showTvScreen();
});

const configRestoreAutoBtn = document.getElementById('config-restore-auto-btn');
if (configRestoreAutoBtn) {
  configRestoreAutoBtn.addEventListener('click', async () => {
    try {
      let restored = await window.api.loadConfig();
      if (!restored || !Array.isArray(restored.channels) || restored.channels.length === 0) {
        const list = await window.api.listBackups();
        if (Array.isArray(list)) {
          const sortedBackups = [...list].sort((a, b) => (b.size || 0) - (a.size || 0));
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
