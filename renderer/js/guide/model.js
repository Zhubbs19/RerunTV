// The guide grid's model, the DOM-free half (docs/design/11 §2). Which rows
// the grid has, in what order, which one is selected, and where the rows
// container must scroll to so that row is fully on screen. guide.js renders
// and handles input; everything here is plain data so node:test covers it.

// ---------- Rows ----------
// One ordered list. A special (plugin/virtual) channel is a normal row in its
// numeric place — it used to sit pinned above the lineup, outside arrow-key
// selection, which left it unreachable with a remote. `specialsAtTop` keeps
// the old placement for people who liked it; the rows stay selectable either
// way.
//
// channels: real channel records, already filtered and sorted.
// specials: [{ number, name, nowText }] from virtual.js.
export function guideRows(channels, specials, { specialsAtTop = false, query = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const specialRows = (specials || [])
    .filter((s) => !q || String(s.name || '').toLowerCase().includes(q) || String(s.number).includes(q))
    .map((s) => ({ kind: 'special', number: s.number, info: s }))
    .sort((a, b) => a.number - b.number);
  const channelRows = (channels || []).map((ch) => ({ kind: 'channel', number: ch.number, ch }));
  if (specialsAtTop) return [...specialRows, ...channelRows];
  const out = [];
  let i = 0;
  channelRows.forEach((row) => {
    while (i < specialRows.length && specialRows[i].number < row.number) out.push(specialRows[i++]);
    out.push(row);
  });
  while (i < specialRows.length) out.push(specialRows[i++]);
  return out;
}

// ---------- Selection ----------
// Selection is a channel number, not a row index: filtering, a plugin channel
// appearing, or the specials moving would otherwise silently move the
// highlight onto a different channel.

export function indexOfNumber(rows, number) {
  return rows.findIndex((row) => row.number === number);
}

// The selected row's index, falling back to the first row when the selected
// channel isn't in this list (filtered out, removed).
export function selectedIndex(rows, number) {
  if (!rows.length) return -1;
  const idx = indexOfNumber(rows, number);
  return idx === -1 ? 0 : idx;
}

// ▲▼ wrap round the list; a page (CH±) stops at the ends.
export function moveSelection(rows, number, delta, { wrap = true } = {}) {
  if (!rows.length) return null;
  const from = selectedIndex(rows, number);
  const to = wrap
    ? ((from + delta) % rows.length + rows.length) % rows.length
    : Math.max(0, Math.min(rows.length - 1, from + delta));
  return rows[to].number;
}

// ---------- Scrolling ----------
// Where the rows container should scroll so the selected row is fully
// visible. Rows have min-height (a wrapped title makes one taller), so this
// takes real offsets rather than assuming a fixed step.
//
// docked: the selected row keeps one neighbouring row of margin above and
//         below when there's room, scrolling only as far as needed, and the
//         result never leaves a row cut through at the top edge.
// full:   the selected row is centred.
//
// rows: [{ top, height }] in scroll-content coordinates. Returns a scrollTop.
export function rowScrollTop({ rows, selIdx, viewportH, scrollTop = 0, contentH = null, mode = 'docked' }) {
  if (!rows || !rows.length || selIdx < 0 || selIdx >= rows.length || !(viewportH > 0)) return scrollTop;
  const last = rows[rows.length - 1];
  const maxTop = Math.max(0, (contentH == null ? last.top + last.height : contentH) - viewportH);
  const clamp = (v) => Math.max(0, Math.min(maxTop, v));
  const sel = rows[selIdx];
  const selBottom = sel.top + sel.height;
  const fits = (top) => sel.top >= top && selBottom <= top + viewportH;

  if (mode === 'full') {
    return clamp(Math.round(sel.top + sel.height / 2 - viewportH / 2));
  }

  const prev = rows[selIdx - 1];
  const next = rows[selIdx + 1];
  const wantTop = prev ? prev.top : sel.top;
  const wantBottom = next ? next.top + next.height : selBottom;
  let top = scrollTop;
  if (wantBottom - wantTop <= viewportH) {
    if (wantTop < top) top = wantTop;
    else if (wantBottom > top + viewportH) top = wantBottom - viewportH;
  } else if (!fits(top)) {
    // Not enough room for both margins: the row itself still has to fit.
    top = selBottom - sel.top <= viewportH && sel.top < top ? sel.top : selBottom - viewportH;
  }
  top = clamp(top);

  // A row straddling the top edge reads as a glitch. Snap to a row edge,
  // whichever direction keeps the selected row whole.
  const straddling = rows.find((row) => row.top < top && row.top + row.height > top);
  if (straddling) {
    const up = clamp(straddling.top);
    const down = clamp(straddling.top + straddling.height);
    if (fits(up)) top = up;
    else if (fits(down)) top = down;
  }
  return top;
}

// ---------- Micro-program runs ----------
// A stretch of consecutive entries each too short to carry a readable label
// (bumpers, shorts) becomes one cell, "Shorts & bumpers (N)", that opens
// into a list (docs/design/11 §2.2). Pure presentation over the schedule:
// nothing about what airs changes.
//
// entries: getChannelSchedule entries ({ file, start, end, ... }), in order.
// minMs:   an entry shorter than this is "micro". guide.js derives it from the
//          label-hiding width, so a run merges exactly when its cells would
//          otherwise have gone label-less.
// Returns cells: { kind: 'program', entry, start, end } or
//                { kind: 'run', items: [entry…], start, end }.
// Whole durations decide, not the part inside the visible window, so a long
// show cut to a sliver at the window's edge stays itself and the cells don't
// change as the window scrolls. A run needs at least two entries that follow
// each other without a gap; a lone short stays a program.
export const RUN_GAP_TOLERANCE_MS = 1000;

export function mergeMicroPrograms(entries, minMs) {
  const cells = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) {
      cells.push({ kind: 'run', items: run, start: run[0].start, end: run[run.length - 1].end });
    } else if (run.length === 1) {
      cells.push({ kind: 'program', entry: run[0], start: run[0].start, end: run[0].end });
    }
    run = [];
  };
  (entries || []).forEach((entry) => {
    const micro = minMs > 0 && entry.end - entry.start < minMs;
    if (!micro) {
      flush();
      cells.push({ kind: 'program', entry, start: entry.start, end: entry.end });
      return;
    }
    const last = run[run.length - 1];
    if (last && Math.abs(entry.start - last.end) > RUN_GAP_TOLERANCE_MS) flush();
    run.push(entry);
  });
  flush();
  return cells;
}

// The cell containing an instant, or -1.
export function cellIndexAt(cells, atMs) {
  return cells.findIndex((cell) => atMs >= cell.start && atMs < cell.end);
}

// ---------- Call letters ----------
// Abbreviated channel names, the way a period cable box's guide showed "TMC"
// or "NICK" in its channel rail (DISPLAY > Guide > Channel names:
// Abbreviated). A channel's own `callLetters` wins; otherwise one is derived:
//   several words → initials ("The Movie Channel" → TMC, "WV Sports Channel"
//     → WVSC: a word already in capitals, like WV, keeps all its letters);
//   one word → itself when 6 letters or fewer ("GIGGLE"), else its first
//     letter plus consonants up to 6 ("Retrovision" → RTRVSN).
// "The" only counts when initials would otherwise be under 3 letters.
export const CALL_LETTERS_MAX = 6;

export function abbreviateChannelName(name) {
  const words = String(name || '').toUpperCase().match(/[A-Z0-9]+/g) || [];
  if (!words.length) return '';
  const rawWords = String(name || '').match(/[A-Za-z0-9]+/g) || [];
  const significant = words.filter((w) => w !== 'THE' && w !== 'A' && w !== 'OF' && w !== 'AND');
  const pick = significant.length ? significant : words;
  if (pick.length === 1) {
    const w = pick[0];
    if (w.length <= CALL_LETTERS_MAX) return w;
    return (w[0] + w.slice(1).replace(/[AEIOU]/g, '')).slice(0, CALL_LETTERS_MAX);
  }
  const initialsOf = (list) => list.map((w) => {
    const raw = rawWords.find((r) => r.toUpperCase() === w) || w;
    return raw.length <= 3 && raw === raw.toUpperCase() && /[A-Z]/.test(raw) ? w : w[0];
  }).join('');
  let initials = initialsOf(pick);
  if (initials.length < 3 && pick !== words) initials = initialsOf(words);
  return initials.slice(0, CALL_LETTERS_MAX);
}

export function channelCallLetters(ch) {
  const own = ch && typeof ch.callLetters === 'string' ? ch.callLetters.trim().toUpperCase() : '';
  return own ? own.slice(0, CALL_LETTERS_MAX) : abbreviateChannelName(ch && ch.name);
}
