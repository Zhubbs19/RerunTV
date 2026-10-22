// Small pure helpers shared by the CHANNELS list modules: the number swap behind the
// up/down buttons and drag-reorder, the sorted lineup, and the filter-box narrowing.
// Split out of channels.js so the list-pane, row-action, selection and bulk
// modules can share them without importing each other in a cycle.
import { formatChannelNumber } from '../core/channels.js';
import { remapChannelRefs } from './util.js';
import { S, commitConfigPatch } from '../core/state.js';

// Two channels trade numbers. Every number-keyed reference (ad affinity, flow/preset
// channel lists, PIN locks) is swapped with them, and the whole thing is one undo
// step — a bare number swap left those references pointing at the wrong channel.
export function swapChannelNumbers(a, b) {
  const aNum = a.number;
  const bNum = b.number;
  [a.number, b.number] = [bNum, aNum];
  remapChannelRefs(S.config, new Map([[aNum, bNum], [bNum, aNum]]));
  commitConfigPatch(`Swap CH ${formatChannelNumber(aNum)} and CH ${formatChannelNumber(bNum)}`);
}

export function sortedForSetup() {
  return [...((S.config && S.config.channels) || [])].sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0));
}

// Channels shown in the setup list, narrowed by S.setupFilterQuery — same
// name-or-number substring match as the guide's filteredChannels().
export function filteredSetupChannels(fullList) {
  const q = (S.setupFilterQuery || '').trim().toLowerCase();
  if (!q) return fullList;
  return fullList.filter((ch) => (ch.name || '').toLowerCase().includes(q) || String(ch.number || '').includes(q));
}
