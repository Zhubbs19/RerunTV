// PROGRAMMING > AIR CHECK — a QA surface over the real pure resolvers. It
// does not simulate a second schedule; every line comes from the same
// functions live playback and the guide use.
import { showTvScreen } from './app.js';
import { getChannel, sortedChannels } from './channels.js';
import { resolveBreakAt, boundarySlot, effectiveContentTags } from './interstitials.js';
import { tuneToChannel } from './playback-core.js';
import { forceInterstitialPreview } from './playback-breaks.js';
import { computeSourcePosition, isWithinBroadcastHours, resolveActiveCommercials, resolveActiveSource } from './schedule.js';
import { S, viewNow } from './state.js';
import { getDisplayTitle, toDatetimeLocalValue } from './util.js';

const channelEl = document.getElementById('aircheck-channel');
const datetimeEl = document.getElementById('aircheck-datetime');
const nowBtn = document.getElementById('aircheck-now');
const prevBtn = document.getElementById('aircheck-prev');
const nextBtn = document.getElementById('aircheck-next');
const runBtn = document.getElementById('aircheck-run');
const summaryEl = document.getElementById('aircheck-summary');
const poolEl = document.getElementById('aircheck-pool-entry');
const forceBtn = document.getElementById('aircheck-force');

function chosenTime() {
  const value = new Date(datetimeEl.value).getTime();
  return Number.isFinite(value) ? value : viewNow();
}

// A flow/preset by its NAME where it has one — the resolver key only carries
// the generated id (preset:preset-mtg…), which told nobody which one matched.
function interstitialName(kind, id) {
  const list = (S.config.interstitials && S.config.interstitials[kind]) || [];
  const found = list.find((item) => item.id === id);
  return found && found.name ? `"${found.name}"` : id;
}

export function reasonForCommercials(active) {
  if (active.key === 'disabled') return 'Channel ads are disabled.';
  if (typeof active.key === 'string' && active.key.startsWith('flow:')) return `Matched show/ad flow ${interstitialName('flows', active.key.slice(5))}.`;
  if (typeof active.key === 'string' && active.key.startsWith('preset:')) return `Matched tagged-content preset ${interstitialName('presets', active.key.slice(7))}.`;
  if (active.key !== -1) return `Matched block override ${active.key}.`;
  return 'Using the channel/global fallback cadence.';
}

function inspect(ch, atMs) {
  const source = resolveActiveSource(ch, atMs);
  const pos = computeSourcePosition(source, atMs, { ignoreContentLost: true });
  const activeCommercials = resolveActiveCommercials(ch, atMs, effectiveContentTags(ch, pos && pos.file));
  const resolvedBreak = resolveBreakAt(ch, atMs);
  const slot = boundarySlot(source, atMs, pos);
  return { source, pos, activeCommercials, resolvedBreak, slot, onAir: isWithinBroadcastHours(ch, atMs) };
}

function signature(ch, atMs) {
  const info = inspect(ch, atMs);
  return [
    info.onAir ? 'on' : 'off', info.source.key,
    info.pos ? info.pos.file.path : 'none',
    info.activeCommercials.key,
    info.resolvedBreak ? `${info.resolvedBreak.type}:${info.resolvedBreak.entry && info.resolvedBreak.entry.id}` : 'content',
  ].join('|');
}

// Second precision matches playback timers while remaining bounded. The
// console is intentionally interactive QA, not a background hot path.
function adjacentBoundary(ch, fromMs, direction) {
  const initial = signature(ch, fromMs);
  const step = direction < 0 ? -1000 : 1000;
  const limit = 36 * 3600;
  for (let i = 1; i <= limit; i++) {
    const at = fromMs + step * i;
    if (signature(ch, at) !== initial) return at;
  }
  return null;
}

function eligiblePool(ch, block) {
  return ((S.config.interstitials && S.config.interstitials.pool) || []).filter((entry) =>
    (entry.channelAffinity === 'any' || entry.channelAffinity === ch.number) &&
    (entry.blockAffinity == null || (block && entry.blockAffinity === block.id)));
}

function renderPool(ch, block) {
  const previous = poolEl.value;
  poolEl.innerHTML = '<option value="">— choose an eligible entry —</option>';
  eligiblePool(ch, block).forEach((entry) => {
    const option = document.createElement('option');
    option.value = entry.id;
    const file = (entry.file && entry.file.path) || (entry.bgFile && entry.bgFile.path);
    option.textContent = `${String(entry.type || 'item').toUpperCase()} — ${entry.text || (file ? file.split(/[\\/]/).pop() : entry.id)}`;
    poolEl.appendChild(option);
  });
  if (Array.from(poolEl.options).some((option) => option.value === previous)) poolEl.value = previous;
  forceBtn.disabled = !poolEl.value;
}

function render() {
  const ch = getChannel(Number(channelEl.value));
  if (!ch) { summaryEl.textContent = 'Choose a channel.'; return; }
  const atMs = chosenTime();
  datetimeEl.value = toDatetimeLocalValue(new Date(atMs));
  const info = inspect(ch, atMs);
  summaryEl.innerHTML = '';
  const rows = [
    ['TRANSMITTER', info.onAir ? 'ON AIR' : 'SIGNED OFF', info.onAir ? 'Inside configured broadcast hours.' : 'Outside configured broadcast hours.'],
    ['SOURCE', info.source.block ? (info.source.block.name || info.source.block.id) : 'DEFAULT LINEUP', info.source.block ? `Highest-priority matching block; resolver key ${info.source.key}.` : 'No active block with playable content matched this time.'],
    ['PROGRAM', info.pos ? getDisplayTitle(info.pos.file) : 'NO PLAYABLE CONTENT', info.pos ? `${Math.floor(info.pos.offset)}s into ${Math.floor(info.pos.file.duration || 0)}s · item ${info.pos.fileIndex + 1} of ${info.pos.files.length}.` : 'The active source has no duration-bearing files.'],
    ['AD POLICY', info.activeCommercials.commercials && info.activeCommercials.commercials.timing ? String(info.activeCommercials.commercials.timing).toUpperCase() : 'DISABLED', reasonForCommercials(info.activeCommercials)],
    ['OUTPUT', info.resolvedBreak ? `${String(info.resolvedBreak.type).toUpperCase()}${info.resolvedBreak.entry ? ` · ${info.resolvedBreak.entry.id}` : ''}` : 'PROGRAM CONTENT', info.resolvedBreak ? `Window ${new Date(info.resolvedBreak.windowStart).toLocaleTimeString()}–${new Date(info.resolvedBreak.windowEnd).toLocaleTimeString()}.` : (info.slot ? `Current file window ends ${new Date(info.slot.fileEndMs).toLocaleTimeString()}.` : 'No interstitial window currently resolves.')],
  ];
  rows.forEach(([label, value, detail]) => {
    const row = document.createElement('div');
    row.className = 'aircheck-row';
    const heading = document.createElement('strong'); heading.textContent = label;
    const result = document.createElement('span'); result.textContent = value;
    const explanation = document.createElement('small'); explanation.textContent = detail;
    row.append(heading, result, explanation);
    summaryEl.appendChild(row);
  });
  renderPool(ch, info.source.block);
}

function populateChannels() {
  const previous = channelEl.value;
  channelEl.innerHTML = '';
  sortedChannels().forEach((ch) => {
    const option = document.createElement('option');
    option.value = String(ch.number);
    option.textContent = `CH ${ch.number} — ${ch.name || 'UNNAMED'}`;
    channelEl.appendChild(option);
  });
  channelEl.value = Array.from(channelEl.options).some((option) => option.value === previous) ? previous : channelEl.options[0]?.value || '';
}

nowBtn?.addEventListener('click', () => { datetimeEl.value = toDatetimeLocalValue(new Date(viewNow())); render(); });
runBtn?.addEventListener('click', render);
channelEl?.addEventListener('change', render);
poolEl?.addEventListener('change', () => { forceBtn.disabled = !poolEl.value; });
prevBtn?.addEventListener('click', () => {
  const ch = getChannel(Number(channelEl.value));
  const at = ch && adjacentBoundary(ch, chosenTime() - 1000, -1);
  if (at != null) { datetimeEl.value = toDatetimeLocalValue(new Date(at)); render(); }
});
nextBtn?.addEventListener('click', () => {
  const ch = getChannel(Number(channelEl.value));
  const at = ch && adjacentBoundary(ch, chosenTime() + 1000, 1);
  if (at != null) { datetimeEl.value = toDatetimeLocalValue(new Date(at)); render(); }
});
forceBtn?.addEventListener('click', async () => {
  const ch = getChannel(Number(channelEl.value));
  const entry = ((S.config.interstitials && S.config.interstitials.pool) || []).find((item) => item.id === poolEl.value);
  if (!ch || !entry) return;
  const target = chosenTime();
  S.timeOffsetMs = target - Date.now();
  S.setupPreviewActive = true;
  showTvScreen();
  await tuneToChannel(ch.number);
  forceInterstitialPreview(ch, entry);
});

document.querySelector('.setup-subtab-btn[data-subtab="aircheck"]')?.addEventListener('click', () => {
  populateChannels();
  if (!datetimeEl.value) datetimeEl.value = toDatetimeLocalValue(new Date(viewNow()));
  render();
});
