// CHANNELS multi-select: Ctrl/Shift+click and keyboard range selection, the bulk
// actions bar parking, and the multi-select detail card. Split out of channels.js.
import { formatChannelNumber } from '../core/channels.js';
import { bulkActionsBar, bulkSelectedCountEl, channelListEl, channelListPaneEl } from '../core/dom.js';
import { S } from '../core/state.js';
import { filteredSetupChannels, sortedForSetup } from './channel-list-helpers.js';
import { renderChannelList } from './channels.js';
import { selectSetupChannel } from './channel-row-actions.js';

/**
 * Bulk-select mode's action bar — visible only once at least one channel is
 * checked, so it's not a permanent fixture crowding the CHANNELS tab.
 * Shows or hides the bulk actions bar and updates its selected count.
 */
export function renderBulkActionsBar() {
  const count = S.bulkSelectedChannels.size;
  bulkActionsBar.classList.toggle('hidden', count < 2);
  bulkSelectedCountEl.textContent = `${count} SELECTED`;
}

// ---------- Multi-select (docs/design/03 §4) ----------
// Ctrl/Cmd+click toggles a channel, Shift+click selects a range. With more
// than one channel selected the detail pane shows the bulk bar in place of
// a single channel's editor; a plain click goes back to one channel.
// The channel number a Shift+click range extends from.
let multiSelectAnchor = null;
// The channel number whose list row holds keyboard focus during multi-select.
export let multiSelectFocus = null;
// A placeholder comment node marking the bar's home in the page, so it can be put back.
const bulkActionsBarHome = document.createComment('bulk actions bar');
bulkActionsBar.before(bulkActionsBarHome);

/**
 * Whether more than one channel is selected.
 * @returns {boolean} True in multi-select mode.
 */
export function isMultiSelecting() {
  return S.bulkSelectedChannels.size > 1;
}

/**
 * The bar lives in the detail pane only while it is needed; renderChannelList
 * clears that pane, so it goes back to its place in the page first.
 * Moves the bulk actions bar back to its home position in the page.
 */
export function parkBulkActionsBar() {
  if (bulkActionsBar.parentNode !== bulkActionsBarHome.parentNode) bulkActionsBarHome.after(bulkActionsBar);
}

/**
 * Numbers of the channels currently shown in the list, in order.
 * @returns {Array<number>} Channel numbers after sorting and the list filter.
 */
function listedChannelNumbers() {
  return filteredSetupChannels(sortedForSetup()).map((c) => c.number);
}

/**
 * Finishes a selection change: a lone selected channel drops back to single selection; then redraws and focuses a row.
 * @param {number} focusNumber The channel number whose row gets focus.
 */
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

/**
 * Ctrl/Cmd+click: adds a channel to, or removes it from, the multi-selection.
 * The currently selected single channel joins the selection first.
 * @param {number} number The clicked channel's number.
 */
export function toggleMultiSelect(number) {
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

/**
 * Shift+click: selects the range of listed channels between the anchor and this one.
 * @param {number} number The clicked channel's number.
 */
export function extendMultiSelect(number) {
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

/**
 * Selects every listed channel (when there are at least two).
 */
export function selectAllListedChannels() {
  const listed = listedChannelNumbers();
  if (listed.length < 2) return;
  multiSelectAnchor = listed[0];
  S.bulkSelectedChannels = new Set(listed);
  settleMultiSelect(multiSelectFocus ?? listed[0]);
}

/**
 * Draws the multi-select card in the detail pane: the count, the selected names, CLEAR SELECTION and the bulk actions bar.
 */
export function renderMultiSelectDetail() {
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
/**
 * Opens the CHANNELS tab and selects every listed channel (the "select all channels" search action).
 */
export function selectAllChannelsFromSearch() {
  document.querySelector('.setup-tab-btn[data-tab="channels"]')?.click();
  selectAllListedChannels();
}

/**
 * The channel configs currently in the multi-selection.
 * @returns {Array<object>} Selected channel configs, in config order.
 */
export function selectedChannels() {
  return S.config.channels.filter((c) => S.bulkSelectedChannels.has(c.number));
}
