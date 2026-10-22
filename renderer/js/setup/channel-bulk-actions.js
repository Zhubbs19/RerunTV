// The bulk actions bar (shown for a multi-channel selection) and its apply buttons,
// plus the run-behind / ahead anchor shift. Split out of channels.js; wires its
// listeners at import time.
import { CHANNEL_ASPECT_OPTIONS } from '../playback/power.js';
import { confirmDialog, alertDialog } from './dialogs.js';
import { describeShift, parseShiftHours, shiftedAnchor } from '../core/anchor-shift.js';
import { diffSchedules, proposeEdit } from '../core/schedule-query.js';
import { setFavorite } from '../personal/state.js';
import {
  bulkFavoriteOffBtn, bulkFavoriteOnBtn, bulkRatingApplyBtn, bulkRatingSelect, bulkRemoveBtn, bulkSelectAllBtn,
  bulkShuffleOffBtn, bulkShuffleOnBtn, bulkVolumeApplyBtn, bulkVolumeInheritBtn, bulkVolumeSlider,
} from '../core/dom.js';
import { attachSliderReadout, ownerFieldsCommand } from './util.js';
import { S, commitInPlace, dispatch, viewNow } from '../core/state.js';
import { shuffleArray } from '../core/util.js';
import { multiSelectFocus, selectedChannels } from './channel-selection.js';
import { renderChannelList } from './channels.js';
import { filteredSetupChannels, sortedForSetup } from './channel-list-helpers.js';
import { selectSetupChannel } from './channel-row-actions.js';

// Asks before moving channels' anchors, showing how many programs in the next
// three days the move changes (the same previewed-edit path ON AIR uses).
const SHIFT_PREVIEW_DAYS = 3;
async function confirmAnchorShift(targets, hours) {
  const from = viewNow();
  const to = from + SHIFT_PREVIEW_DAYS * 86400000;
  let moved = 0;
  targets.forEach((c) => {
    const cmd = { type: 'channel.set', channel: c.number, field: 'anchor', value: shiftedAnchor(c.anchor, hours, Date.now()) };
    const proposal = proposeEdit(S.config, c.number, [cmd]);
    moved += diffSchedules(c, proposal.channel, from, to, { breaks: false, afterConfig: proposal.config }).added.length;
  });
  const who = targets.length === 1 ? `CH ${targets[0].number}` : `${targets.length} channels`;
  return confirmDialog({
    title: 'Run behind / ahead',
    message: `Run ${who} ${describeShift(hours)}? About ${moved} program${moved === 1 ? '' : 's'} in the next ${SHIFT_PREVIEW_DAYS} days will move. You can undo this.`,
    danger: false,
    confirmText: 'SHIFT',
  });
}

async function shiftSelectedChannels(hours) {
  const targets = selectedChannels();
  if (!targets.length || !(await confirmAnchorShift(targets, hours))) return;
  const now = Date.now(); // anchors are real-clock timestamps
  dispatch(targets.map((c) => ({ type: 'channel.set', channel: c.number, field: 'anchor', value: shiftedAnchor(c.anchor, hours, now) })),
    { label: `Run ${targets.length} channel${targets.length === 1 ? '' : 's'} ${describeShift(hours)}` });
  renderChannelList();
}

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
async function setFavoriteOnSelected(value) {
  await Promise.all(selectedChannels().map((channel) => setFavorite(channel.number, value)));
  renderChannelList();
}
bulkFavoriteOnBtn.addEventListener('click', () => setFavoriteOnSelected(true));
bulkFavoriteOffBtn.addEventListener('click', () => setFavoriteOnSelected(false));
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
// More things worth setting across a whole selection at once: how the logo
// bug treats the channel number and ad breaks, and the aspect handling.
const bulkLogoNumberSelect = document.getElementById('bulk-logo-number-select');
const bulkLogoBreaksSelect = document.getElementById('bulk-logo-breaks-select');
const bulkAspectSelect = document.getElementById('bulk-aspect-select');
CHANNEL_ASPECT_OPTIONS.forEach((option) => {
  const opt = document.createElement('option');
  opt.value = option.value;
  opt.textContent = option.label;
  bulkAspectSelect.appendChild(opt);
});
document.getElementById('bulk-logo-number-apply-btn').addEventListener('click', () => {
  const v = bulkLogoNumberSelect.value;
  setOnSelected('logoBugHideNumber', v === 'hide' ? true : v === 'show' ? false : null, 'Set logo number');
  renderChannelList();
});
document.getElementById('bulk-logo-breaks-apply-btn').addEventListener('click', () => {
  const v = bulkLogoBreaksSelect.value;
  setOnSelected('logoBugHidesOnBreak', v === 'hide' ? true : v === 'show' ? 'show' : null, 'Set logo in breaks');
  renderChannelList();
});
document.getElementById('bulk-aspect-apply-btn').addEventListener('click', () => {
  setOnSelected('aspectRatio', bulkAspectSelect.value || null, 'Set aspect');
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
const bulkHideSelect = document.getElementById('bulk-hide-select');
document.getElementById('bulk-hide-apply-btn').addEventListener('click', () => {
  const v = bulkHideSelect.value;
  if (!v) return;
  setOnSelected('hidden', v === 'hide', v === 'hide' ? 'Hide from tuning' : 'Show in tuning');
  renderChannelList();
});
const bulkShiftInput = document.getElementById('bulk-shift-input');
document.getElementById('bulk-shift-apply-btn').addEventListener('click', async () => {
  const hours = parseShiftHours(bulkShiftInput.value);
  if (hours == null) { await alertDialog('Enter a number of hours other than zero.'); return; }
  await shiftSelectedChannels(hours);
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
