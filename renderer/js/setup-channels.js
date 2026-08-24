// The CHANNELS tab: the channel list itself (row rendering, reordering,
// bulk-select actions), per-channel folder scanning, the channel EDIT
// panel's tab bar (wiring together the panels built in setup-panels.js and
// setup-schedule.js), and the box-wide config export/import/done buttons.
import { applyConfigDefaults, showTvScreen } from './app.js';
import { buildChannelPackage, mergeChannelPackage, normalizeChannelPackage } from './channel-package.js';
import { confirmDialog, alertDialog, promptDialog } from './setup-dialogs.js';
import {
  buildChannelBadge, channelColor, freshBroadcastHours, freshChannel, mediaRefId, nextChannelNumber, parseMediaRef, sortedChannels,
} from './channels.js';
import {
  addChannelBtn, bulkActionsBar, bulkFavoriteOffBtn, bulkFavoriteOnBtn, bulkRatingApplyBtn,
  bulkRatingSelect, bulkRemoveBtn, bulkSelectAllBtn, bulkSelectedCountEl, bulkSelectToggleBtn, bulkShuffleOffBtn,
  bulkShuffleOnBtn, bulkVolumeApplyBtn, bulkVolumeInheritBtn, bulkVolumeSlider,
  channelFilterEl, channelImportBtn, channelListEl, configExportBtn, configImportBtn, doneBtn,
  previewBannerEl, previewModalBlockEl, previewModalCancelBtn, previewModalChannelLabelEl, previewModalDatetimeEl,
  previewModalEl, previewModalGoBtn, previewModalNowBtn, previewModalQuickEl, rescanAllBtn, scanProgressEl,
} from './dom.js';
import { CHANNEL_DISPLAY_ASPECT_OPTIONS, CHANNEL_RESOLUTION_OPTIONS } from './display-mode.js';
import { tuneToChannel } from './playback.js';
import { CHANNEL_ASPECT_OPTIONS } from './power.js';
import { buildChannelAdsPanel, buildChannelIdentityPanel, buildCommercialsPanel, buildFoldersPanel, buildLogoBugPanel, buildTitlesPanel } from './setup-panels.js';
import { renderCommercialsPanel, renderStandbyPanel } from './setup-interstitials.js';
import { renderSettingsPanels } from './setup-settings.js';
import { buildUnifiedSchedulePanel, blockPickerLabel } from './setup-schedule.js';
import { toggleLazyPanel, probeDurationForEntry, attachSliderReadout } from './setup-util.js';
import { getMediaSourcePicker } from './plugins.js';
import { computeLivePosition, computeSourcePosition, resolveActiveSource } from './schedule.js';
import { BADGE_COLORS, S, saveConfigDebounced, resetUndoBaseline, viewNow } from './state.js';
import { basenameNoExt, getDisplayTitle, shuffleArray, randomInterstitialId, toDatetimeLocalValue } from './util.js';
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

// Per-channel collapse state for the OPTIONS row (color/shuffle/favorite/
// VHS/rating/volume) — ephemeral UI state (resets on app restart), keyed by
// channel number, and only populated once the user actually clicks the
// toggle. Left absent, a row's default (collapsed vs. expanded) is derived
// fresh each render from whether it has anything worth showing (see
// hasCustomChannelOptions) rather than being a fixed default — with 13+
// near-identical rows this is what keeps a channel with nothing customized
// from taking up the same vertical space as one that does.
const channelOptionsCollapse = new Map();
const openChannelEditTabs = new Map();

// Only the genuinely uncommon overrides force a row open by default — a
// per-channel RATING turned out to be something most real setups set on
// nearly every channel (unlike FAVORITE/VHS/SHUFFLE/a volume override,
// which stay rare), so gating collapse on it too would leave most rows
// expanded regardless, defeating the point. summaryParts below still
// surfaces the rating on a collapsed row's header either way, so nothing
// already set is ever hidden without a hint.
function hasCustomChannelOptions(ch) {
  return !!(ch.favorite || ch.quickAccess || ch.vhsQuality || ch.notSubscribed || ch.shuffle || ch.volume != null || ch.aspectRatio || ch.resolutionOverride || ch.displayAspectOverride);
}

function sortedForSetup() {
  return [...((S.config && S.config.channels) || [])].sort((a, b) => (parseInt(a.number, 10) || 0) - (parseInt(b.number, 10) || 0));
}

// Channels shown in the setup list, narrowed by S.setupFilterQuery — same
// name-or-number substring match as the guide's filteredChannels().
function filteredSetupChannels(fullList) {
  const q = (S.setupFilterQuery || '').trim().toLowerCase();
  if (!q) return fullList;
  return fullList.filter((ch) => (ch.name || '').toLowerCase().includes(q) || String(ch.number || '').includes(q));
}

export function renderChannelList() {
  if (!channelListEl) return;
  ensureMediaSourceProvidersLoaded();
  channelListEl.innerHTML = '';
  channelListEl.classList.toggle('select-mode', !!S.bulkSelectMode);
  
  if (!S.config || !Array.isArray(S.config.channels)) {
    if (S.config) S.config.channels = [];
  }

  const fullList = sortedForSetup();
  const list = filteredSetupChannels(fullList);

  if (fullList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO CHANNELS LOADED — CLICK "🔄 RESTORE CHANNELS FROM DISK" BELOW TO RELOAD YOUR CHANNELS';
    channelListEl.appendChild(empty);
    renderBulkActionsBar();
    return;
  }

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO CHANNELS MATCH THAT FILTER';
    channelListEl.appendChild(empty);
    renderBulkActionsBar();
    return;
  }
  // Precomputed once per render rather than inside the per-row loop below —
  // fullList.indexOf(ch) and a fresh sortedChannels() call per row were both
  // O(n) (the latter O(n log n)), making the whole render O(n^2) on channel
  // count; a large channel list made this render loop visibly slower than
  // it needs to be.
  const fullIndexOf = new Map(fullList.map((c, i) => [c, i]));
  const allChannelsForCopyFrom = sortedChannels();
  list
    .forEach((ch) => {
      const fullIdx = fullIndexOf.get(ch);
      const row = document.createElement('div');
      row.className = 'channel-row';
      row.dataset.channelNumber = String(ch.number);

      const selectCheckbox = document.createElement('input');
      selectCheckbox.type = 'checkbox';
      selectCheckbox.className = 'channel-select-checkbox';
      selectCheckbox.checked = S.bulkSelectedChannels.has(ch.number);
      selectCheckbox.addEventListener('change', () => {
        if (selectCheckbox.checked) S.bulkSelectedChannels.add(ch.number);
        else S.bulkSelectedChannels.delete(ch.number);
        renderBulkActionsBar();
      });
      row.appendChild(selectCheckbox);

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
      numInput.value = ch.number;
      numInput.setAttribute('aria-label', 'Channel number');
      numInput.addEventListener('change', () => {
        const v = parseInt(numInput.value, 10);
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
        if (S.config.channels.some((c) => c !== ch && c.number === v)) {
          rejectNumberChange(`CH ${v} IS ALREADY IN USE`);
          return;
        }
        const oldNum = ch.number;
        ch.number = v;
        if (openChannelEditTabs.has(oldNum)) {
          openChannelEditTabs.set(v, openChannelEditTabs.get(oldNum));
          openChannelEditTabs.delete(oldNum);
        }
        saveConfigDebounced();
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
        [ch.number, neighbor.number] = [neighbor.number, ch.number];
        saveConfigDebounced();
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
        [ch.number, neighbor.number] = [neighbor.number, ch.number];
        saveConfigDebounced();
        renderChannelList();
      });

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = 'CHANNEL NAME';
      nameInput.value = ch.name || '';
      nameInput.addEventListener('input', () => { ch.name = nameInput.value; saveConfigDebounced(); });

      const folderBtn = buildChooseSourceControl(ch);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn remove-btn';
      removeBtn.textContent = 'REMOVE';
      removeBtn.addEventListener('click', async () => {
        const label = ch.name && ch.name.trim() ? `"${ch.name.trim()}"` : `channel ${ch.number}`;
        const detail = ch.files.length
          ? ` and its ${ch.files.length} video${ch.files.length === 1 ? '' : 's'}, schedule, and commercial settings`
          : '';
        if (!(await confirmDialog(`Remove ${label}${detail}? This can't be undone.`))) return;
        S.config.channels = S.config.channels.filter((c) => c !== ch);
        saveConfigDebounced();
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
      const editTabs = [
        { id: 'folders', label: ch.folders.length ? `FOLDERS (${ch.folders.length})` : 'FOLDERS', build: buildFoldersPanel },
        { id: 'schedule', label: schedCount ? `SCHEDULE (${schedCount})` : 'SCHEDULE', build: buildUnifiedSchedulePanel },
      ];
      if (ch.files.length > 0) {
        editTabs.push({ id: 'titles', label: 'TITLES', build: buildTitlesPanel });
      }
      editTabs.push({ id: 'ads', label: 'ADS', build: (c, p) => buildChannelAdsPanel(c, p) });
      editTabs.push({ id: 'logo', label: 'LOGO', build: buildLogoBugPanel });
      editTabs.push({ id: 'identity', label: ch.broadcastIdentity && Object.keys(ch.broadcastIdentity).length ? 'IDENTITY ✓' : 'IDENTITY', build: buildChannelIdentityPanel });

      const editPanel = document.createElement('div');
      editPanel.className = 'titles-panel edit-panel hidden';

      const editHeading = document.createElement('div');
      editHeading.className = 'edit-channel-heading';
      const editHeadingTitle = document.createElement('strong');
      editHeadingTitle.textContent = `EDITING CH ${String(ch.number).padStart(2, '0')} — ${ch.name || 'UNTITLED'}`;
      const editHeadingSummary = document.createElement('span');
      editHeadingSummary.textContent = `${ch.files.length} MEDIA FILE${ch.files.length === 1 ? '' : 'S'} · ${ch.folders.length} FOLDER${ch.folders.length === 1 ? '' : 'S'} · ${schedCount} SCHEDULE BLOCK${schedCount === 1 ? '' : 'S'}`;
      editHeading.append(editHeadingTitle, editHeadingSummary);

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
        ch.blocks = JSON.parse(JSON.stringify(src.blocks || [])).map((b) => ({ ...b, id: randomInterstitialId() }));
        ch.broadcastHours = JSON.parse(JSON.stringify(src.broadcastHours || freshBroadcastHours()));
        ch.adsEnabled = src.adsEnabled;
        ch.logoBugProfiles = src.logoBugProfiles ? JSON.parse(JSON.stringify(src.logoBugProfiles)) : null;
        saveConfigDebounced();
        renderChannelList();
      });
      copyFromWrap.appendChild(copyFromSelect);
      copyFromWrap.appendChild(copyFromBtn);
      editHeaderRow.appendChild(copyFromWrap);

      const editTabBar = document.createElement('div');
      editTabBar.className = 'edit-tab-bar';
      editTabBar.setAttribute('role', 'tablist');
      const editTabContent = document.createElement('div');
      editTabContent.className = 'edit-tab-content';
      editTabContent.id = `channel-${ch.number}-edit-panel`;
      editTabContent.setAttribute('role', 'tabpanel');
      editPanel.appendChild(editHeading);
      editPanel.appendChild(editHeaderRow);
      editPanel.appendChild(editTabBar);
      editPanel.appendChild(editTabContent);

      let activeEditTab = openChannelEditTabs.get(ch.number) || editTabs[0].id;
      function renderEditTabBar() {
        editTabBar.innerHTML = '';
        editTabs.forEach((t) => {
          const tabBtn = document.createElement('button');
          const tabActive = t.id === activeEditTab;
          tabBtn.className = 'btn edit-tab-btn' + (tabActive ? ' active' : '') + (t.soon ? ' edit-tab-soon' : '');
          tabBtn.setAttribute('role', 'tab');
          tabBtn.setAttribute('aria-selected', String(tabActive));
          tabBtn.setAttribute('aria-controls', editTabContent.id);
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

      const editBtn = document.createElement('button');
      editBtn.className = 'btn titles-btn edit-btn';
      const isInitiallyOpen = openChannelEditTabs.has(ch.number);
      editBtn.textContent = isInitiallyOpen ? 'EDIT ▾' : 'EDIT';
      if (isInitiallyOpen) {
        editBtn.classList.add('edit-btn-open');
        editPanel.classList.remove('hidden');
        renderEditTabBar();
        renderEditTabContent();
      }

      editBtn.addEventListener('click', () => {
        toggleLazyPanel(editPanel, () => {
          renderEditTabBar();
          renderEditTabContent();
        });
        const isOpenNow = !editPanel.classList.contains('hidden');
        if (isOpenNow) {
          openChannelEditTabs.set(ch.number, activeEditTab);
        } else {
          openChannelEditTabs.delete(ch.number);
        }
        editBtn.classList.toggle('edit-btn-open', isOpenNow);
        editBtn.setAttribute('aria-expanded', String(isOpenNow));
        editBtn.textContent = isOpenNow ? 'EDIT ▾' : 'EDIT';
      });
      editBtn.setAttribute('aria-expanded', String(isInitiallyOpen));

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
        saveConfigDebounced();
      });
      shuffleLabel.appendChild(shuffleCheckbox);
      shuffleLabel.appendChild(document.createTextNode('SHUFFLE ORDER'));

      const favoriteLabel = document.createElement('label');
      favoriteLabel.className = 'shuffle-toggle';
      const favoriteCheckbox = document.createElement('input');
      favoriteCheckbox.type = 'checkbox';
      favoriteCheckbox.checked = !!ch.favorite;
      favoriteCheckbox.addEventListener('change', () => { ch.favorite = favoriteCheckbox.checked; saveConfigDebounced(); });
      favoriteLabel.appendChild(favoriteCheckbox);
      favoriteLabel.appendChild(document.createTextNode('FAVORITE'));

      const quickAccessLabel = document.createElement('label');
      quickAccessLabel.className = 'shuffle-toggle';
      quickAccessLabel.title = 'Shows this channel as a one-tap button on the Android companion remote';
      const quickAccessCheckbox = document.createElement('input');
      quickAccessCheckbox.type = 'checkbox';
      quickAccessCheckbox.checked = !!ch.quickAccess;
      quickAccessCheckbox.addEventListener('change', () => { ch.quickAccess = quickAccessCheckbox.checked; saveConfigDebounced(); });
      quickAccessLabel.appendChild(quickAccessCheckbox);
      quickAccessLabel.appendChild(document.createTextNode('REMOTE QUICK-TAP'));

      const vhsLabel = document.createElement('label');
      vhsLabel.className = 'shuffle-toggle';
      vhsLabel.title = 'Renders this channel with tracking noise, chroma fringing, and a REC timestamp burn-in, like it\'s playing off a tape';
      const vhsCheckbox = document.createElement('input');
      vhsCheckbox.type = 'checkbox';
      vhsCheckbox.checked = !!ch.vhsQuality;
      vhsCheckbox.addEventListener('change', () => { ch.vhsQuality = vhsCheckbox.checked; saveConfigDebounced(); });
      vhsLabel.appendChild(vhsCheckbox);
      vhsLabel.appendChild(document.createTextNode('VHS'));

      const notSubscribedLabel = document.createElement('label');
      notSubscribedLabel.className = 'shuffle-toggle';
      notSubscribedLabel.title = 'Tuning to this channel shows a "please call your cable company to subscribe" card instead of playing anything — a simpler sibling to the scrambled PPV gag for a channel you just want blocked';
      const notSubscribedCheckbox = document.createElement('input');
      notSubscribedCheckbox.type = 'checkbox';
      notSubscribedCheckbox.checked = !!ch.notSubscribed;
      notSubscribedCheckbox.addEventListener('change', () => { ch.notSubscribed = notSubscribedCheckbox.checked; saveConfigDebounced(); });
      notSubscribedLabel.appendChild(notSubscribedCheckbox);
      notSubscribedLabel.appendChild(document.createTextNode('NOT SUBSCRIBED'));

      const ratingSelect = document.createElement('select');
      ratingSelect.className = 'rating-select';
      ['NONE', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'].forEach((label) => {
        const opt = document.createElement('option');
        opt.value = label === 'NONE' ? '' : label;
        opt.textContent = label;
        ratingSelect.appendChild(opt);
      });
      ratingSelect.value = ch.rating || '';
      ratingSelect.addEventListener('change', () => { ch.rating = ratingSelect.value || null; saveConfigDebounced(); });

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
      aspectSelect.addEventListener('change', () => { ch.aspectRatio = aspectSelect.value || null; saveConfigDebounced(); });

      // Forces this channel into a specific simulated RESOLUTION tier
      // instead of AUTO-detecting it (real file resolution, then ERA tag)
      // — only takes effect while the box-wide RESOLUTION setting (DISPLAY
      // tab) is itself set to AUTO; ignored otherwise, same relationship
      // ch.aspectRatio has to the box-wide ASPECT RATIO setting.
      const resolutionSelect = document.createElement('select');
      resolutionSelect.className = 'resolution-select';
      resolutionSelect.title = 'Only takes effect while the box-wide RESOLUTION setting (DISPLAY tab) is set to AUTO — forces this channel to a specific tier instead of auto-detecting it from the currently-playing file\'s real resolution/ERA tag.';
      CHANNEL_RESOLUTION_OPTIONS.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        resolutionSelect.appendChild(opt);
      });
      resolutionSelect.value = ch.resolutionOverride || '';
      resolutionSelect.addEventListener('change', () => { ch.resolutionOverride = resolutionSelect.value || null; saveConfigDebounced(); });

      // Forces this channel to a specific simulated box ASPECT (screen
      // shape, #display-frame) instead of AUTO-detecting it — only takes
      // effect while the box-wide ASPECT setting (DISPLAY tab) is itself
      // set to AUTO; same relationship to it that resolutionSelect above
      // has to the box-wide RESOLUTION setting. Distinct from aspectSelect
      // above, which crops/fits video CONTENT inside #player.
      const displayAspectSelect = document.createElement('select');
      displayAspectSelect.className = 'display-aspect-select';
      displayAspectSelect.title = 'Only takes effect while the box-wide ASPECT setting (DISPLAY tab) is set to AUTO — forces this channel\'s simulated screen shape instead of auto-detecting it from the currently-playing file\'s real aspect ratio/ERA tag. Not the same as ASPECT RATIO above, which only affects how video content fits inside the player.';
      CHANNEL_DISPLAY_ASPECT_OPTIONS.forEach(({ value, label }) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        displayAspectSelect.appendChild(opt);
      });
      displayAspectSelect.value = ch.displayAspectOverride || '';
      displayAspectSelect.addEventListener('change', () => { ch.displayAspectOverride = displayAspectSelect.value || null; saveConfigDebounced(); });

      const swatches = document.createElement('div');
      swatches.className = 'color-swatches';
      BADGE_COLORS.forEach((color) => {
        const sw = document.createElement('button');
        sw.className = 'color-swatch' + (channelColor(ch) === color ? ' active' : '');
        sw.style.background = color;
        sw.title = 'Channel accent color';
        sw.addEventListener('click', () => {
          ch.color = color;
          saveConfigDebounced();
          renderChannelList();
        });
        swatches.appendChild(sw);
      });

      const duplicateBtn = document.createElement('button');
      duplicateBtn.className = 'btn titles-btn';
      duplicateBtn.textContent = 'DUPLICATE';
      duplicateBtn.title = 'Clone this channel\'s folders, schedule, and settings as a new channel';
      duplicateBtn.addEventListener('click', () => {
        const clone = JSON.parse(JSON.stringify(ch));
        clone.number = nextChannelNumber();
        clone.name = ch.name && ch.name.trim() ? `${ch.name.trim()} COPY` : '';
        S.config.channels.push(clone);
        S.setupFilterQuery = '';
        channelFilterEl.value = '';
        saveConfigDebounced();
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
      actions.appendChild(editBtn);
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
      volumeSlider.addEventListener('input', () => { ch.volume = parseInt(volumeSlider.value, 10) / 100; saveConfigDebounced(); });
      const volumeReadout = attachSliderReadout(volumeSlider, { suffix: '%' });

      const volumeResetBtn = document.createElement('button');
      volumeResetBtn.className = 'btn';
      volumeResetBtn.textContent = 'RESET';
      volumeResetBtn.title = 'Clear this channel\'s override and inherit the master volume again';
      volumeResetBtn.addEventListener('click', () => {
        ch.volume = null;
        volumeSlider.value = 100;
        volumeReadout.refresh();
        saveConfigDebounced();
      });

      const optionsCollapsed = channelOptionsCollapse.has(ch.number)
        ? channelOptionsCollapse.get(ch.number)
        : !hasCustomChannelOptions(ch);

      const optionsHeader = document.createElement('div');
      optionsHeader.className = 'channel-options-header' + (optionsCollapsed ? ' collapsed' : '');
      const optionsChevron = document.createElement('span');
      optionsChevron.className = 'channel-options-chevron';
      optionsChevron.textContent = '▾';
      optionsHeader.appendChild(optionsChevron);
      optionsHeader.appendChild(document.createTextNode('OPTIONS'));
      const summaryParts = [];
      if (ch.favorite) summaryParts.push('FAVORITE');
      if (ch.quickAccess) summaryParts.push('REMOTE QUICK-TAP');
      if (ch.rating) summaryParts.push(ch.rating);
      if (ch.aspectRatio) summaryParts.push(`ASPECT ${ch.aspectRatio.toUpperCase()}`);
      if (ch.resolutionOverride) summaryParts.push(`RES ${ch.resolutionOverride.toUpperCase()}`);
      if (ch.displayAspectOverride) summaryParts.push(`DISPLAY ${ch.displayAspectOverride.toUpperCase()}`);
      if (ch.vhsQuality) summaryParts.push('VHS');
      if (ch.notSubscribed) summaryParts.push('NOT SUBSCRIBED');
      if (ch.shuffle) summaryParts.push('SHUFFLE');
      if (ch.volume != null) summaryParts.push(`VOL ${Math.round(ch.volume * 100)}%`);
      if (summaryParts.length) {
        const summary = document.createElement('span');
        summary.className = 'channel-options-summary';
        summary.textContent = summaryParts.join(' · ');
        optionsHeader.appendChild(summary);
      }
      optionsHeader.addEventListener('click', () => {
        channelOptionsCollapse.set(ch.number, !optionsCollapsed);
        renderChannelList();
      });

      const options = document.createElement('div');
      options.className = 'channel-options' + (optionsCollapsed ? ' hidden' : '');
      const colorLabel = document.createElement('span');
      colorLabel.className = 'option-label';
      colorLabel.textContent = 'COLOR';
      options.appendChild(colorLabel);
      options.appendChild(swatches);
      options.appendChild(shuffleLabel);
      options.appendChild(favoriteLabel);
      options.appendChild(quickAccessLabel);
      options.appendChild(vhsLabel);
      options.appendChild(notSubscribedLabel);
      options.appendChild(ratingLabel);
      options.appendChild(ratingSelect);
      options.appendChild(aspectLabel);
      options.appendChild(aspectSelect);
      options.appendChild(resolutionLabel);
      options.appendChild(resolutionSelect);
      options.appendChild(displayAspectLabel);
      options.appendChild(displayAspectSelect);
      options.appendChild(volumeLabel);
      options.appendChild(volumeSlider);
      options.appendChild(volumeReadout.el);
      options.appendChild(volumeResetBtn);

      const optionsWrap = document.createElement('div');
      optionsWrap.className = 'channel-options-wrap';
      optionsWrap.appendChild(optionsHeader);
      optionsWrap.appendChild(options);

      row.appendChild(badge);
      row.appendChild(numInput);
      row.appendChild(nameInput);
      row.appendChild(status);
      if (nowLine) row.appendChild(nowLine);
      row.appendChild(actions);
      row.appendChild(optionsWrap);

      // Drag-to-reorder — a longer-range sibling to the ▲/▼ swap buttons
      // above, same underlying operation (swap two channels' `ch.number`,
      // the field that actually determines list order and what you tune to)
      // just usable for a move of 20 spots in one drag instead of 20 clicks.
      // Deliberately a swap, not a full renumber-everything-in-between —
      // renumbering a whole range would cascade into every pool entry/block
      // that references a channel number by ID (channelAffinity/
      // blockAffinity), which is a much bigger and riskier operation than
      // this UI is asking for.
      row.draggable = true;
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
        [dragged.number, ch.number] = [ch.number, dragged.number];
        saveConfigDebounced();
        renderChannelList();
      });

      channelListEl.appendChild(row);
      channelListEl.appendChild(editPanel);
    });
  renderBulkActionsBar();
}

// Bulk-select mode's action bar — visible only once at least one channel is
// checked, so it's not a permanent fixture crowding the CHANNELS tab.
function renderBulkActionsBar() {
  const count = S.bulkSelectedChannels.size;
  bulkActionsBar.classList.toggle('hidden', !S.bulkSelectMode || count === 0);
  bulkSelectedCountEl.textContent = `${count} SELECTED`;
}

function selectedChannels() {
  return S.config.channels.filter((c) => S.bulkSelectedChannels.has(c.number));
}

bulkSelectToggleBtn.addEventListener('click', () => {
  S.bulkSelectMode = !S.bulkSelectMode;
  if (!S.bulkSelectMode) S.bulkSelectedChannels.clear();
  bulkSelectToggleBtn.classList.toggle('active', S.bulkSelectMode);
  bulkSelectToggleBtn.textContent = S.bulkSelectMode ? 'DONE SELECTING' : 'SELECT CHANNELS';
  renderChannelList();
});

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
      renderChannelList();
      requestAnimationFrame(() => {
        const row = channelListEl.querySelector(`[data-channel-number="${ch.number}"]`);
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  if (allSelected) visible.forEach((c) => S.bulkSelectedChannels.delete(c.number));
  else visible.forEach((c) => S.bulkSelectedChannels.add(c.number));
  renderChannelList();
});

bulkFavoriteOnBtn.addEventListener('click', () => { selectedChannels().forEach((c) => { c.favorite = true; }); saveConfigDebounced(); renderChannelList(); });
bulkFavoriteOffBtn.addEventListener('click', () => { selectedChannels().forEach((c) => { c.favorite = false; }); saveConfigDebounced(); renderChannelList(); });
bulkShuffleOnBtn.addEventListener('click', () => {
  selectedChannels().forEach((c) => { c.shuffle = true; if (c.files.length > 1) shuffleArray(c.files); });
  saveConfigDebounced();
  renderChannelList();
});
bulkShuffleOffBtn.addEventListener('click', () => { selectedChannels().forEach((c) => { c.shuffle = false; }); saveConfigDebounced(); renderChannelList(); });
bulkRatingApplyBtn.addEventListener('click', () => {
  const value = bulkRatingSelect.value || null;
  selectedChannels().forEach((c) => { c.rating = value; });
  saveConfigDebounced();
  renderChannelList();
});
attachSliderReadout(bulkVolumeSlider, { suffix: '%' });
bulkVolumeApplyBtn.addEventListener('click', () => {
  const value = parseInt(bulkVolumeSlider.value, 10) / 100;
  selectedChannels().forEach((c) => { c.volume = value; });
  saveConfigDebounced();
  renderChannelList();
});
bulkVolumeInheritBtn.addEventListener('click', () => {
  selectedChannels().forEach((c) => { c.volume = null; });
  saveConfigDebounced();
  renderChannelList();
});
bulkRemoveBtn.addEventListener('click', async () => {
  const targets = selectedChannels();
  if (!targets.length) return;
  if (!(await confirmDialog(`Remove ${targets.length} selected channel${targets.length === 1 ? '' : 's'} and all their content/settings? This can't be undone.`))) return;
  S.config.channels = S.config.channels.filter((c) => !S.bulkSelectedChannels.has(c.number));
  S.bulkSelectedChannels.clear();
  saveConfigDebounced();
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
// Optional per-provider verb (PLUGIN_DEVELOPMENT.md's "Media sources"
// section) — a plugin-sourced file's `path` is that provider's opaque ref
// (e.g. a Drive file id), which has no meaningful basename the way a local
// path's filename does, so without this the TITLES panel/NOW-playing
// bar/etc. all fall back to showing the raw ref (getDisplayTitle, util.js).
// Called once per file at scan time; a provider that doesn't implement it
// just leaves the title unset, same as today.
async function tryGetDisplayName(providerId, rawRef) {
  try {
    return await window.api.callMediaSourceHook(providerId, 'getDisplayName', rawRef);
  } catch (err) {
    return null;
  }
}

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
    // Independent lookups (duration, title) for the same file — run in
    // parallel rather than sequentially awaited. Found in review: for a
    // 200-file Drive folder this was doubling scan wall-clock time for no
    // reason, since neither call depends on the other's result.
    // eslint-disable-next-line no-await-in-loop -- files themselves are still scanned one at a time, only the two per-file lookups are parallelized
    const [duration, title] = await Promise.all([
      probeDurationForEntry(providerId, rawRef),
      tryGetDisplayName(providerId, rawRef),
    ]);
    newFiles.push({
      path: refs[i], duration, folder: entry.id, source: providerId, ...(title ? { title } : {}),
    });
  }
  ch.folders.push(entry);
  ch.files = ch.files.concat(newFiles);
  if (ch.shuffle) shuffleArray(ch.files);
  if (!ch.anchor) ch.anchor = Date.now();
  scanProgressEl.classList.add('hidden');
  saveConfigDebounced();
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
  saveConfigDebounced();
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
  for (const ch of targets) {
    for (const entry of ch.folders) {
      const label = ch.name && ch.name.trim() ? ch.name.trim() : `CH ${ch.number}`;
      scanProgressEl.textContent = `RESCANNING ${label}: ${entry.label || entry.ref}…`;
      let paths;
      try {
        paths = await window.api.scanFolder(entry.source, entry.ref);
      } catch (err) {
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
        const [duration, title] = await Promise.all([
          probeDurationForEntry(entry.source, rawRef),
          entry.source === 'local' ? Promise.resolve(null) : tryGetDisplayName(entry.source, rawRef),
        ]);
        ch.files.push({
          path: newPaths[i], duration, folder: entry.id, source: entry.source, ...(title ? { title } : {}),
        });
        added++;
      }
      if (ch.shuffle && newPaths.length > 0) shuffleArray(ch.files);
    }
  }
  scanProgressEl.textContent = added > 0
    ? `RESCAN COMPLETE — ${added} NEW VIDEO${added === 1 ? '' : 'S'} ADDED`
    : 'RESCAN COMPLETE — NO NEW VIDEOS FOUND';
  setTimeout(() => scanProgressEl.classList.add('hidden'), 3000);
  renderChannelList();
}

export function removeFolderFromChannel(ch, folderEntry) {
  ch.folders = ch.folders.filter((e) => e.id !== folderEntry.id);
  ch.files = ch.files.filter((f) => f.folder !== folderEntry.id);
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

addChannelBtn.addEventListener('click', () => {
  S.config.channels.push(freshChannel());
  // Clear any active filter so the new (nameless) channel is guaranteed to
  // actually show up in the list instead of silently vanishing into it.
  S.setupFilterQuery = '';
  channelFilterEl.value = '';
  saveConfigDebounced();
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

  saveConfigDebounced();
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
  await window.api.saveConfig(S.config);
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
  await window.api.saveConfig(S.config);
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
        await window.api.saveConfig(S.config);
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
