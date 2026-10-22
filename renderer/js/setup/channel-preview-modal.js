// The PREVIEW and PREVIEW ON dialogs opened from the channel list and card.
// Split out of channels.js; wires its listeners at import time.
import { showTvScreen } from '../app.js';
import { alertDialog } from './dialogs.js';
import { Dialog } from '../ui/dialog.js';
import { previewOnClient, refreshPersonalClients } from '../personal/state.js';
import { parseChannelNumber } from '../core/channels.js';
import {
  previewBannerEl, previewModalBlockEl, previewModalCancelBtn, previewModalChannelLabelEl, previewModalDatetimeEl,
  previewModalEl, previewModalGoBtn, previewModalNowBtn, previewModalQuickEl,
} from '../core/dom.js';
import { tuneToChannel } from '../playback/core.js';
import { openTimeCalendar } from '../playback/time-calendar.js';
import { blockPickerLabel } from './schedule.js';
import { showScanStatus } from './util.js';
import { computeSourcePosition, resolveActiveSource } from '../core/schedule.js';
import { S, getClientId } from '../core/state.js';
import { toDatetimeLocalValue } from '../core/util.js';
import { formatPreviewBannerTime, nextBlockActiveMs, nextBreakStartMs, randomPreviewMs } from './channel-preview.js';

// ---------- PREVIEW ON… (docs/design/06 §5 — send a channel to another screen) ----------
export async function openPreviewOnDialog(ch) {
  let clients = [];
  try { clients = (await refreshPersonalClients()).filter((c) => c.id !== getClientId()); } catch (e) { clients = (S.personalClients || []).filter((c) => c.id !== getClientId()); }
  if (!clients.length) {
    await alertDialog('No other screens are connected right now — pair a LAN viewer or Android TV client first.', { title: 'PREVIEW ON…' });
    return;
  }
  const targetId = await Dialog({
    title: 'PREVIEW ON…',
    message: `Tune a connected screen to CH ${ch.number}${ch.name ? ' — ' + ch.name : ''}.`,
    kind: 'prompt',
    dismissValue: null,
    actions: [
      { label: 'CANCEL', value: null },
      ...clients.map((c) => ({ label: c.label.toUpperCase(), value: c.id })),
    ],
  }).result;
  if (!targetId) return;
  try {
    await previewOnClient(targetId, ch.number);
    showScanStatus(`SENT CH ${ch.number} TO ${(clients.find((c) => c.id === targetId) || {}).label || 'SCREEN'}`, 3000);
  } catch (e) { await alertDialog(`Could not preview there: ${e.message}`, { variant: 'error' }); }
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
let previewReturnFocus = null;

export function openPreviewModal(ch) {
  previewChannel = ch;
  previewReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  const back = previewReturnFocus;
  previewReturnFocus = null;
  if (back && back.isConnected) back.focus();
}

// Esc closes; Tab stays inside the dialog while it is open.
previewModalEl.addEventListener('keydown', (e) => {
  if (previewModalEl.classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePreviewModal();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusable = Array.from(previewModalEl.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
    .filter((el) => !el.disabled && el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || !previewModalEl.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

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
// CALENDAR…: the time machine's calendar picks the date and time for the preview.
const previewCalendarBtn = document.getElementById('preview-modal-calendar-btn');
if (previewCalendarBtn) {
  previewCalendarBtn.addEventListener('click', () => {
    if (!previewChannel) return;
    openTimeCalendar({
      channel: previewChannel, startMs: getPreviewFieldMs(), title: 'PREVIEW · PICK A DATE', goText: 'USE THIS TIME',
      needsTimeMachine: false, onGo: (ms) => setPreviewFieldMs(ms),
    });
  });
}
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
  const chNumber = parseChannelNumber(previewModalEl.dataset.channelNumber);
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
