// Channel row actions shared by the lineup list menu and the channel card:
// move, duplicate (optionally shifted), remove, select. Split out of channels.js.
import { confirmDialog, alertDialog, promptDialog } from './dialogs.js';
import { describeShift, parseShiftHours, shiftedAnchor } from '../core/anchor-shift.js';
import { formatChannelNumber, nextChannelNumber } from '../core/channels.js';
import { channelFilterEl, channelListEl, channelListPaneEl } from '../core/dom.js';
import { MenuButton } from '../ui/menu.js';
import { S, dispatch } from '../core/state.js';
import { deepClone } from '../core/util.js';
import { sortedForSetup, swapChannelNumbers } from './channel-list-helpers.js';
import { renderChannelList } from './channels.js';
import { addFolderToChannel, pickFilesForChannel } from './channel-sources.js';
import { openPreviewModal } from './channel-preview-modal.js';

// ---------- Channel row actions (list ⋯ menu and the card's) ----------
/**
 * Moves a channel one place up or down the lineup by swapping numbers with its neighbor.
 * @param {object} ch The channel config.
 * @param {number} direction -1 to move up, 1 to move down.
 */
function moveSetupChannel(ch, direction) {
  const list = sortedForSetup();
  const neighbor = list[list.indexOf(ch) + direction];
  if (!neighbor) return;
  swapChannelNumbers(ch, neighbor);
  S.bulkSelectedChannels.clear();
  S.setupSelectedChannel = ch.number;
  renderChannelList();
  channelListPaneEl?.querySelector('.channel-list-item.selected')?.focus();
}

/**
 * Asks for a number of hours, then duplicates a channel running that far behind (or ahead, if negative).
 * @param {object} ch The channel config to copy.
 * @returns {Promise<void>}
 */
async function duplicateShiftedChannel(ch) {
  const answer = await promptDialog({
    title: 'Duplicate behind / ahead',
    message: `Copy CH ${ch.number} so it airs what this channel aired N hours ago. Use a negative number to run ahead.`,
    placeholder: 'hours, e.g. 3',
    defaultValue: '3',
  });
  if (answer == null) return;
  const hours = parseShiftHours(answer);
  if (hours == null) { await alertDialog('Enter a number of hours other than zero.'); return; }
  duplicateSetupChannel(ch, { shiftHours: hours });
}

/**
 * Inserts a copy of a channel at the next free number, optionally with its anchor shifted, and selects it.
 * @param {object} ch The channel config to copy.
 * @param {object} [opts] Options.
 * @param {number} [opts.shiftHours=0] Hours to shift the copy's anchor; 0 keeps it identical.
 */
function duplicateSetupChannel(ch, { shiftHours = 0 } = {}) {
  const clone = deepClone(ch);
  clone.number = nextChannelNumber();
  clone.name = ch.name && ch.name.trim() ? `${ch.name.trim()} COPY` : '';
  if (shiftHours) clone.anchor = shiftedAnchor(ch.anchor, shiftHours, Date.now());
  dispatch({ type: 'channel.insert', channel: clone }, { label: shiftHours ? `Duplicate CH ${ch.number}, ${describeShift(shiftHours)}` : `Duplicate CH ${ch.number}` });
  S.bulkSelectedChannels.clear();
  S.setupSelectedChannel = clone.number;
  S.setupFilterQuery = '';
  channelFilterEl.value = '';
  renderChannelList();
}

/**
 * Removes a channel after confirmation and selects its neighbor in the list.
 * @param {object} ch The channel config to remove.
 * @returns {Promise<void>}
 */
async function removeSetupChannel(ch) {
  const label = ch.name && ch.name.trim() ? `"${ch.name.trim()}"` : `channel ${ch.number}`;
  const detail = ch.files.length
    ? ` and its ${ch.files.length} video${ch.files.length === 1 ? '' : 's'}, schedule, and commercial settings`
    : '';
  if (!(await confirmDialog(`Remove ${label}${detail}? You can undo this.`))) return;
  const list = sortedForSetup();
  const at = list.indexOf(ch);
  const next = list[at + 1] || list[at - 1];
  dispatch({ type: 'channel.remove', channel: ch.number });
  S.bulkSelectedChannels.clear();
  S.setupSelectedChannel = next ? next.number : null;
  renderChannelList();
}

/**
 * Builds the ⋯ actions menu for a channel row or card.
 * @param {object} ch The channel config.
 * @returns {object} The `MenuButton` result; callers append its `button`.
 */
export function channelRowMenu(ch) {
  const list = sortedForSetup();
  const at = list.indexOf(ch);
  return MenuButton({
    label: `Actions for CH ${formatChannelNumber(ch.number)}`,
    groups: [
      [
        { label: 'Move up', run: () => moveSetupChannel(ch, -1), disabled: at <= 0 },
        { label: 'Move down', run: () => moveSetupChannel(ch, 1), disabled: at < 0 || at >= list.length - 1 },
      ],
      [
        { label: 'Add folder…', run: () => addFolderToChannel(ch) },
        { label: 'Add files…', run: () => pickFilesForChannel(ch) },
        { label: 'Preview…', run: () => openPreviewModal(ch), disabled: !ch.files.length },
        { label: 'Duplicate', run: () => duplicateSetupChannel(ch) },
        { label: 'Duplicate, running behind…', run: () => duplicateShiftedChannel(ch) },
      ],
      [{ label: 'Remove channel…', run: () => removeSetupChannel(ch), danger: true }],
    ],
  });
}

/**
 * Selects a channel (or the plugin-channels section) in the setup list and redraws it.
 * Clears any multi-selection and scrolls the editor back to its top.
 * @param {?(number|string)} value A channel number, 'plugins', or null for no selection.
 * @param {object} [opts] Options.
 * @param {boolean} [opts.focus=false] Also focus the selected list row.
 */
export function selectSetupChannel(value, { focus = false } = {}) {
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
