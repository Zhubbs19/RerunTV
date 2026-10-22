// The CHANNELS list pane: the compact lineup (renderChannelListPane), its keyboard
// navigation, and the PLUGIN CHANNELS section. Split out of channels.js; the
// detail pane (renderChannelList) stays there.
import { isFavorite } from '../personal/state.js';
import { buildChannelBadge, formatChannelNumber, parseChannelNumber } from '../core/channels.js';
import { channelListEl, channelListPaneEl } from '../core/dom.js';
import { showScanStatus } from './util.js';
import {
  getPluginChannelOverride, getPluginChannelType, pluginChannelTypeIds, updatePluginChannelOverride,
} from '../plugin/host.js';
import { renderChannelDisplaySettings } from './plugin-settings.js';
import { computeLivePosition } from '../core/schedule.js';
import { S } from '../core/state.js';
import { getDisplayTitle } from '../core/util.js';
import {
  extendMultiSelect, isMultiSelecting, multiSelectFocus, selectAllListedChannels, toggleMultiSelect,
} from './channel-selection.js';
import { channelRowMenu, selectSetupChannel } from './channel-row-actions.js';
import { swapChannelNumbers } from './channel-list-helpers.js';
import { renderChannelList } from './channels.js';

// ---------- Lineup list (the left pane) ----------
// One compact row per channel: badge, number, name, and what's on now.
// Selecting a row shows that channel's editor in the detail pane. Rows drag to
// reorder (the same two-channel number swap the ▲▼ buttons make) and accept
// dropped video files (setup-dragdrop.js); Ctrl/Shift+click selects several
// (see Multi-select below).

export function renderChannelListPane(list, pluginEntries) {
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
    if (isFavorite(ch.number)) flags.push('★');
    if (ch.hidden) flags.push('HIDDEN');
    if (ch.notSubscribed) flags.push('LOCKED');
    if (flags.length) {
      const flagEl = document.createElement('span');
      flagEl.className = 'channel-list-flags';
      flagEl.textContent = flags.join(' ');
      item.appendChild(flagEl);
    }

    const rowMenu = channelRowMenu(ch);
    item.dataset.rowMenu = '';
    item.appendChild(rowMenu.button);
    item.addEventListener('contextmenu', (e) => {
      if (isMultiSelecting()) return;
      if (S.setupSelectedChannel !== ch.number) selectSetupChannel(ch.number);
      channelListPaneEl.querySelector(`.channel-list-item[data-channel-number="${ch.number}"] .row-menu-btn`)?.click();
      e.preventDefault();
    });
    item.addEventListener('click', (e) => {
      if (e.target.closest('.row-menu-btn')) return;
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
      swapChannelNumbers(dragged, ch);
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

// A registerChannelType channel (Digital Music, Party, Guide, Public Access,
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
export function pluginChannelEntries() {
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

export function renderPluginChannelSection(list) {
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
      // Some plugins (digital-music-channel, party-channel) internally
      // compare S.currentNumber against their OWN hardcoded channel-number
      // constant rather than reading a live effective number — renumbering
      // them here would desync those internal checks from the number the
      // channel actually moved to. See each plugin's registerChannelType
      // call for the specifics; this is an opt-out, not a core limitation.
      numInput.disabled = true;
      numInput.title = "This plugin's channel number can't be changed — its own code depends on staying at this number.";
    } else {
      numInput.addEventListener('change', () => {
        const v = parseChannelNumber(numInput.value);
        if (Number.isNaN(v) || v < 0 || v === override.number) { numInput.value = override.number; return; }
        const inUse = realNums.has(v) || ids.some((otherId) => {
          if (otherId === id) return false;
          const otherDef = getPluginChannelType(otherId);
          return otherDef && getPluginChannelOverride(otherId, otherDef).number === v;
        });
        if (inUse) {
          showScanStatus(`CH ${v} IS ALREADY IN USE`, 2500);
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
