// SCHEDULE > ON AIR — the week a channel will actually broadcast, and the
// place to change it (docs/design/02 §4). One strip per day: every program,
// every break pod and the stretches the channel is signed off, coloured by the
// source (a block or the default lineup) that produced them, under a lane
// showing which block owns each hour.
//
// It adds no resolution math of its own. What airs comes from
// schedule-query.js (queryDay / explainLayers), the same resolvers live
// playback and the guide use, and "now" is viewNow(), so it follows the time
// machine. Edits are built by timeline-edits.js as commands over the existing
// blocks, day overrides, broadcast hours and presets, previewed against a
// proposed copy (proposeEdit / diffSchedules) and dispatched as one undo step.
//
// Desktop gestures:
//   drag in a day's block lane         create a block for those hours
//   drag a block's edge                change its hours (previews that day live)
//   drag a block's colour chip         copy it to another weekday
//   click a block, Delete              remove it (the confirm shows the diff)
//   right-click / ⋯ on a program       only this day, replace, breaks
//   SIGN-OFF HOURS / a signed-off area  broadcast hours
// TV mode (html[data-mode="tv"]) is the same week read-only, driven by the
// remote: ◄► programs, ▲▼ days, OK explains, red/green (or CH−/CH+) weeks.
import { showTvScreen } from '../app.js';
import { GUIDE_BREAK_LABELS } from '../guide/guide.js';
import { breakMarkEl } from '../timeline/render.js';
import { tuneToChannel } from '../playback/core.js';
import { normalizeKey } from '../remote/input.js';
import { addDays, diffSchedules, explainLayers, proposeEdit, queryDay, startOfDay } from '../core/schedule-query.js';
import { confirmDialog } from './dialogs.js';
import { probeDuration } from './util.js';
import { MONTHS, S, WEEKDAYS, dispatch, viewNow } from '../core/state.js';
import {
  addBreakHereCommands, blockSpansForDay, copyToWeekdayCommand, createBlockCommand, diffCounts, exceptionBlockCommand,
  guardrailsFor, isDailyBlock, librarySources, noBreaksCommands, overlapsAny, pinFileOverrideCommand, pluginOwner,
  randomTimelineBlockId, reorderCommands, removeWeekdayCommand, resizeCommand,
} from '../timeline/edits.js';
import { MenuButton } from '../ui/menu.js';
import { Button } from '../ui/button.js';
import { Segmented } from '../ui/controls.js';
import { isTvMode } from '../tv/usage-mode.js';
import { formatClock, formatDuration, formatHourLabel, getDisplayTitle } from '../core/util.js';

// The guide's break labels are period copy (a commercial pod reads PAID
// PROGRAMMING, the way a real listings grid showed it); a setup screen
// explaining a schedule should just say what it is.
const BREAK_LABEL_OVERRIDES = { commercial: 'AD BREAK', adBreakIn: 'AD BREAK', adBreakOut: 'AD BREAK' };
function breakLabel(type) {
  return BREAK_LABEL_OVERRIDES[type] || GUIDE_BREAK_LABELS[type] || String(type).toUpperCase();
}

const ZOOM_LEVELS = [
  { label: 'DAY', pxPerHour: 60 },
  { label: 'PRIME', pxPerHour: 140 },
  { label: 'DETAIL', pxPerHour: 320 },
];

// Week and zoom survive the panel being rebuilt (an undo re-renders the whole
// channel editor), per channel number.
const viewStateByChannel = new Map();

function startOfWeek(ms) {
  const day = startOfDay(ms);
  return addDays(day, -new Date(day).getDay());
}

function sourceKey(ch, block) {
  return block ? block.id : `default-${ch.number}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className = 'btn') {
  const b = el('button', className, label);
  b.type = 'button';
  return b;
}

function formatDayHeading(dayMs) {
  const d = new Date(dayMs);
  return `${WEEKDAYS[d.getDay()].slice(0, 3)} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// WEEKDAYS is uppercase for the retro headings; sentences want 'Saturday'.
function dayName(weekday) {
  const name = WEEKDAYS[weekday];
  return name.charAt(0) + name.slice(1).toLowerCase();
}

function hourSpanLabel(startHour, endHour) {
  return `${formatHourLabel(startHour)}–${formatHourLabel(endHour % 24)}`;
}

function countsSentence({ programs, breaks, signOffDays }) {
  if (!programs && !breaks && !signOffDays) return 'nothing on screen changes this week';
  const parts = [];
  if (programs) parts.push(`${programs} program${programs === 1 ? '' : 's'}`);
  if (breaks) parts.push(`${breaks} break${breaks === 1 ? '' : 's'}`);
  if (signOffDays) parts.push(`sign-off hours on ${signOffDays} day${signOffDays === 1 ? '' : 's'}`);
  return `changes ${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')} this week`;
}

// "Edit this layer" destinations elsewhere in setup, reached the way a person
// would: by the section, sub-tab and row a click would use.
function goToChannelPage(ch, page) {
  document.getElementById(`channel-${ch.number}-edit-tab-${page}`)?.click();
}
function goToProgramming(subtab, rowSelector) {
  document.querySelector('.setup-tab-btn[data-tab="programming"]')?.click();
  document.querySelector(`.setup-subtab-btn[data-subtab="${subtab}"]`)?.click();
  if (rowSelector) requestAnimationFrame(() => document.querySelector(rowSelector)?.click());
}

// opts.colorFor(key)  — the same per-source colour CALENDAR uses
// opts.blockLabel(b)  — blockPickerLabel, so a block reads the same everywhere
// opts.onEditBlock(b) — jump to that block in the BLOCKS view
export function buildOnAirPanel(ch, panelEl, opts = {}) {
  panelEl.innerHTML = '';
  const colorFor = opts.colorFor || (() => '#5163b8');
  const blockLabel = opts.blockLabel || ((b) => b.name || b.id);
  const editable = !isTvMode();

  const remembered = viewStateByChannel.get(ch.number) || {};
  let weekStart = remembered.weekStart != null ? remembered.weekStart : startOfWeek(viewNow());
  let zoom = remembered.zoom || ZOOM_LEVELS[1];
  let renderToken = 0;
  let selected = null; // { start, dayStart } of the program in the detail panel
  let selectedBlockId = null;
  let days = []; // resolved days of the week on screen, in row order
  let rows = [];
  let impactRanges = [];
  const remember = () => viewStateByChannel.set(ch.number, { weekStart, zoom });

  panelEl.classList.add('onair-panel');
  panelEl.classList.toggle('onair-readonly', !editable);

  // The toolbar is kit components (docs/design/04 §3): week paging Buttons and
  // a Segmented zoom (one Tab stop, ◀▶ choose).
  const toolbar = el('div', 'onair-toolbar');
  const prevBtn = Button({ label: '◄ PREV WEEK', onPress: () => pageWeek(-7) });
  const todayBtn = Button({ label: 'THIS WEEK', onPress: () => { weekStart = startOfWeek(viewNow()); remember(); render({ scrollToNow: true }); } });
  const nextBtn = Button({ label: 'NEXT WEEK ►', onPress: () => pageWeek(7) });
  const weekLabel = el('span', 'onair-week-label');
  const signOffBtn = Button({ label: 'SIGN-OFF HOURS', className: 'onair-signoff-btn', onPress: () => openSignOffEditor() });
  const zoomGroup = Segmented({
    label: 'Zoom',
    className: 'onair-zoom',
    items: ZOOM_LEVELS.map((level) => ({ value: level.label, label: level.label })),
    value: zoom.label,
    onChange: (label) => { zoom = ZOOM_LEVELS.find((level) => level.label === label) || zoom; remember(); render({ keepScroll: true }); },
  });
  toolbar.append(prevBtn, todayBtn, nextBtn, weekLabel);
  if (editable) toolbar.appendChild(signOffBtn);
  toolbar.appendChild(zoomGroup);

  const intro = el('div', 'onair-intro', editable
    ? 'What this channel actually broadcasts, after blocks, calendar days, presets and flows are applied. Drag across a day\'s block lane to add a block, drag a block\'s edges to change its hours or its colour chip to another day to copy it, and right-click a program to change just that airing. Click anything to see why it airs.'
    : 'What this channel actually broadcasts this week. ◄ ► move between programs, ▲ ▼ between days, OK explains a program, and the red and green buttons change the week. Editing is done on a computer.');

  // Before-commit previews and after-commit results both land here, so the
  // outline on the grid always has a sentence next to it. It never collapses:
  // appearing mid-drag would push the grid out from under the pointer.
  const IMPACT_IDLE = 'Changes are previewed here, and outlined on the week, before they apply.';
  const impactBar = el('div', 'onair-impact-bar idle');
  impactBar.setAttribute('aria-live', 'polite');
  impactBar.appendChild(el('span', 'onair-impact-text', IMPACT_IDLE));
  impactBar.hidden = !editable;

  const editor = el('div', 'onair-editor');
  editor.hidden = true;

  const scroller = el('div', 'onair-scroller');
  scroller.tabIndex = -1;
  const grid = el('div', 'onair-grid');
  scroller.appendChild(grid);

  const legend = el('div', 'onair-legend');
  const detail = el('div', 'onair-detail');
  detail.setAttribute('aria-live', 'polite');
  const status = el('div', 'onair-status');

  panelEl.append(intro, toolbar, impactBar, editor, scroller, legend, status, detail);

  const pageWeek = (delta) => { weekStart = addDays(weekStart, delta); remember(); render(); };

  function xFor(dayStart, ms) {
    return ((ms - dayStart) / 3600000) * zoom.pxPerHour;
  }

  function hourFromPointer(dayEl, clientX) {
    const rect = dayEl.getBoundingClientRect();
    return Math.max(0, Math.min(24, (clientX - rect.left) / zoom.pxPerHour));
  }

  // ---------- impact preview ----------

  function showImpactBar(text, actions = []) {
    impactBar.innerHTML = '';
    impactBar.appendChild(el('span', 'onair-impact-text', text));
    actions.forEach((a) => impactBar.appendChild(a));
    impactBar.classList.remove('idle');
  }

  function hideImpactBar() {
    impactBar.innerHTML = '';
    impactBar.appendChild(el('span', 'onair-impact-text', IMPACT_IDLE));
    impactBar.classList.add('idle');
  }

  function drawImpact(ranges, { onlyDay = null } = {}) {
    impactRanges = ranges;
    rows.forEach(({ dayStart, row }) => {
      const track = row.querySelector('.onair-track');
      if (!track) return;
      track.querySelectorAll('.onair-impact-range').forEach((n) => n.remove());
      track.querySelectorAll('.onair-program.impacted').forEach((n) => n.classList.remove('impacted'));
      if (onlyDay != null && dayStart !== onlyDay) return;
      const dayEnd = addDays(dayStart, 1);
      ranges.filter((r) => r.end > dayStart && r.start < dayEnd).forEach((r) => {
        const mark = el('div', 'onair-impact-range');
        const left = xFor(dayStart, Math.max(r.start, dayStart));
        mark.style.left = `${left}px`;
        mark.style.width = `${Math.max(3, xFor(dayStart, Math.min(r.end, dayEnd)) - left)}px`;
        track.appendChild(mark);
      });
      track.querySelectorAll('.onair-program').forEach((node) => {
        const start = Number(node.dataset.start);
        const end = Number(node.dataset.end);
        if (overlapsAny({ start, end }, ranges)) node.classList.add('impacted');
      });
    });
  }

  function clearImpact() {
    drawImpact([]);
    hideImpactBar();
  }

  // The week on screen, before vs. with `commands` applied.
  function previewWeek(commands) {
    const began = performance.now();
    const proposal = proposeEdit(S.config, ch.number, commands);
    const diff = diffSchedules(ch, proposal.channel, weekStart, addDays(weekStart, 7), { afterConfig: proposal.config });
    panelEl.dataset.lastWeekPreviewMs = String(Math.round(performance.now() - began));
    return { diff, counts: diffCounts(diff) };
  }

  // One day, programs only — cheap enough to run on every drag frame (§4.4).
  function previewDay(commands, dayStart) {
    const began = performance.now();
    const proposal = proposeEdit(S.config, ch.number, commands);
    const diff = diffSchedules(ch, proposal.channel, dayStart, addDays(dayStart, 1), { breaks: false, afterConfig: proposal.config });
    const ms = performance.now() - began;
    panelEl.dataset.lastDragPreviewMs = String(Math.round(ms * 10) / 10);
    return { diff, counts: diffCounts(diff), ms };
  }

  // Preview the whole week, confirm when the guardrails call for it, apply as
  // one undo step and re-resolve. Returns whether it was applied.
  async function commitEdit(commands, label, { preview = null } = {}) {
    const list = (commands || []).filter(Boolean);
    if (!list.length) return false;
    let impact;
    try {
      impact = preview || previewWeek(list);
    } catch (e) {
      showImpactBar(`Can't do that: ${e.message}`);
      return false;
    }
    const guard = guardrailsFor(S.config, ch.number, list);
    drawImpact(impact.diff.changed);
    if (guard.confirm) {
      const lines = [];
      if (guard.reanchor) lines.push('Channel will re-anchor — what\'s on now will change.');
      if (guard.beyondWeek) lines.push('This block runs for more than a week, and the outline only shows this one.');
      lines.push(`This ${countsSentence(impact.counts).replace(' this week', ' in the week shown')}. You can undo this.`);
      const ok = await confirmDialog({ title: label, message: lines.join(' '), danger: false, confirmText: 'APPLY' });
      if (!ok) { clearImpact(); return false; }
    }
    try {
      dispatch(list, { label });
    } catch (e) {
      clearImpact();
      showImpactBar(`Can't do that: ${e.message}`);
      return false;
    }
    editor.hidden = true;
    render({ keepScroll: true, impact: impact.diff.changed, message: `${label}: ${countsSentence(impact.counts)}.` });
    return true;
  }

  // ---------- editors (create, replace, sign-off) ----------

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEditor(); }
  });

  function closeEditor() {
    editor.hidden = true;
    editor.innerHTML = '';
    clearImpact();
    rows.forEach(({ row }) => row.querySelector('.onair-lane-ghost')?.remove());
  }

  // Picks content for a block: a folder or tag already in the library (no
  // scanning), a folder to browse for, or, for a daily block, one of its own
  // episodes. `build(source)` turns the choice into commands; the preview
  // follows every change of choice.
  function openSourceEditor({ title, subtitle, commitLabel, nameDefault = '', askName = true, extraGroups = [], build, labelFor }) {
    editor.innerHTML = '';
    editor.hidden = false;
    const sources = librarySources(S.config);
    const byKey = new Map();

    editor.appendChild(el('div', 'onair-editor-title', title));
    if (subtitle) editor.appendChild(el('div', 'onair-editor-sub', subtitle));
    const fields = el('div', 'onair-editor-fields');

    let nameInput = null;
    if (askName) {
      const nameLabel = el('label', 'onair-editor-field');
      nameLabel.appendChild(el('span', null, 'Name'));
      nameInput = el('input', 'block-text-input onair-editor-name');
      nameInput.type = 'text';
      nameInput.value = nameDefault;
      nameInput.placeholder = 'e.g. Saturday Cartoons';
      nameLabel.appendChild(nameInput);
      fields.appendChild(nameLabel);
    }

    const sourceLabel = el('label', 'onair-editor-field');
    sourceLabel.appendChild(el('span', null, 'Plays'));
    const select = el('select', 'onair-editor-source');
    const placeholder = el('option', null, 'Choose a folder or tag…');
    placeholder.value = '';
    select.appendChild(placeholder);
    const addGroup = (label, list) => {
      if (!list.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      list.forEach((s) => {
        byKey.set(s.key, s);
        const opt = el('option', null, `${s.label} (${s.files.length})`);
        opt.value = s.key;
        group.appendChild(opt);
      });
      select.appendChild(group);
    };
    extraGroups.forEach((g) => addGroup(g.label, g.sources));
    addGroup('Folders in your library', sources.folders);
    addGroup('Tags', sources.tags);
    sourceLabel.appendChild(select);
    fields.appendChild(sourceLabel);

    const browseBtn = button('BROWSE FOR A FOLDER…');
    fields.appendChild(browseBtn);
    editor.appendChild(fields);

    const previewLine = el('div', 'onair-editor-preview', 'Pick what it plays to see what changes.');
    editor.appendChild(previewLine);

    const actions = el('div', 'onair-editor-actions');
    const commitBtn = button(commitLabel, 'btn btn-primary');
    commitBtn.disabled = true;
    const cancelBtn = button('CANCEL');
    actions.append(commitBtn, cancelBtn);
    editor.appendChild(actions);

    let current = null; // { source, commands, impact }
    const currentName = () => (nameInput && nameInput.value.trim()) || (current && current.source.label.replace(/^#/, '')) || '';

    function refresh() {
      const source = byKey.get(select.value);
      if (!source) {
        current = null;
        commitBtn.disabled = true;
        previewLine.textContent = 'Pick what it plays to see what changes.';
        drawImpact([]);
        return;
      }
      if (nameInput && !nameInput.dataset.touched) nameInput.value = source.label.replace(/^#/, '');
      try {
        const commands = build({ ...source, name: currentName() });
        const impact = previewWeek(commands);
        current = { source, commands, impact };
        commitBtn.disabled = false;
        previewLine.textContent = `${source.files.length} video${source.files.length === 1 ? '' : 's'} · ${countsSentence(impact.counts)} (outlined).`;
        drawImpact(impact.diff.changed);
      } catch (e) {
        current = null;
        commitBtn.disabled = true;
        previewLine.textContent = `Can't use that: ${e.message}`;
      }
    }

    select.addEventListener('change', refresh);
    if (nameInput) {
      nameInput.addEventListener('input', () => { nameInput.dataset.touched = '1'; });
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !commitBtn.disabled) { e.preventDefault(); commitBtn.click(); } });
    }
    browseBtn.addEventListener('click', async () => {
      const folder = await window.api.selectFolder();
      if (!folder) return;
      browseBtn.disabled = true;
      previewLine.textContent = 'Scanning folder…';
      const paths = await window.api.scanFolder('local', folder);
      const files = [];
      for (let i = 0; i < paths.length; i++) {
        previewLine.textContent = `Reading video ${i + 1} of ${paths.length}…`;
        // eslint-disable-next-line no-await-in-loop -- one video element at a time, as the BLOCKS folder picker does
        files.push({ path: paths[i], duration: await probeDuration(paths[i]), source: 'local' });
      }
      browseBtn.disabled = false;
      if (!files.length) { previewLine.textContent = 'No videos in that folder.'; return; }
      const key = `browse:${folder}`;
      const label = String(folder).split(/[\\/]/).filter(Boolean).pop() || folder;
      byKey.set(key, { kind: 'folder', key, label, folder, files });
      const opt = el('option', null, `${label} (${files.length})`);
      opt.value = key;
      select.insertBefore(opt, select.children[1] || null);
      select.value = key;
      refresh();
    });
    commitBtn.addEventListener('click', async () => {
      if (!current) return;
      // Built again with the final name; the preview's programs don't depend on it.
      const commands = build({ ...current.source, name: currentName() });
      await commitEdit(commands, labelFor({ ...current.source, name: currentName() }), { preview: current.impact });
    });
    cancelBtn.addEventListener('click', closeEditor);
    (nameInput && !nameDefault ? select : (nameInput || select)).focus({ preventScroll: true });
    editor.scrollIntoView({ block: 'nearest' });
  }

  function openCreateEditor(dayStart, startHour, endHour) {
    const weekday = dayName(new Date(dayStart).getDay());
    const span = hourSpanLabel(startHour, endHour);
    // The anchor records when content was assigned: real time, like the
    // BLOCKS folder picker (one of CLAUDE.md's deliberate exceptions). Taken
    // once, so the preview and the block that's created agree.
    const anchorMs = Date.now();
    const id = randomTimelineBlockId();
    openSourceEditor({
      title: `New block · ${weekday}s ${span}`,
      subtitle: `Airs every ${weekday}, above the time blocks already there. Holiday date ranges stay on top.`,
      commitLabel: 'CREATE BLOCK',
      build: (source) => [createBlockCommand(ch, {
        dayStart, startHour, endHour: endHour % 24, name: source.name, files: source.files, folder: source.folder, anchorMs, id,
      })],
      labelFor: (source) => `Make ${weekday} ${span} ${source.name || 'a block'}`,
    });
  }

  function openReplaceEditor(entry, day) {
    const id = randomTimelineBlockId();
    const live = entry.block;
    const title = getDisplayTitle(entry.file);
    const extraGroups = [];
    if (isDailyBlock(live)) {
      extraGroups.push({
        label: `An episode of ${blockLabel(live)} (this date only)`,
        sources: live.files.map((f) => ({ kind: 'episode', key: `episode:${f.path}`, label: getDisplayTitle(f), folder: null, files: [f] })),
      });
    }
    openSourceEditor({
      title: `Replace ${title}`,
      subtitle: `${formatDayHeading(entry.start)} only. Its hour${entry.end - entry.start > 3600000 ? 's' : ''} get their own one-day block; every other day is unchanged.`,
      commitLabel: 'REPLACE',
      askName: false,
      extraGroups,
      build: (source) => (source.kind === 'episode'
        ? [pinFileOverrideCommand(ch, live, day.dayStart, source.files[0].path)]
        : [exceptionBlockCommand(ch, entry, day.dayStart, { name: source.label.replace(/^#/, ''), files: source.files, folder: source.folder }, id)]),
      labelFor: (source) => `Replace ${title} on ${formatDayHeading(entry.start)} with ${source.label}`,
    });
  }

  function openChangeContentEditor(block) {
    // Real time, as when BLOCKS assigns a folder (a deliberate Date.now()),
    // taken once so the preview and the edit agree.
    const anchorMs = Date.now();
    openSourceEditor({
      title: `Change what ${blockLabel(block)} plays`,
      subtitle: 'Every airing of this block changes, and it starts its new folder from the beginning.',
      commitLabel: 'CHANGE CONTENT',
      askName: false,
      build: (source) => [{
        type: 'item.set', collection: 'blocks', channel: ch.number, id: block.id,
        fields: { files: source.files, folder: source.folder, anchor: anchorMs },
      }],
      labelFor: (source) => `Change ${blockLabel(block)} to ${source.label}`,
    });
  }

  function openSignOffEditor() {
    editor.innerHTML = '';
    editor.hidden = false;
    const bh = ch.broadcastHours || { enabled: false, startHour: 6, endHour: 0 };
    editor.appendChild(el('div', 'onair-editor-title', 'Sign-off hours'));
    editor.appendChild(el('div', 'onair-editor-sub', 'Outside its broadcast day the channel shows a sign-off card instead of programs.'));
    const fields = el('div', 'onair-editor-fields');
    const toggleLabel = el('label', 'shuffle-toggle');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = !!bh.enabled;
    toggleLabel.append(toggle, document.createTextNode(' Sign off overnight'));
    const hourSel = (value, label) => {
      const wrap = el('label', 'onair-editor-field');
      wrap.appendChild(el('span', null, label));
      const sel = el('select', 'block-hour-select');
      for (let h = 0; h < 24; h++) {
        const opt = el('option', null, formatHourLabel(h));
        opt.value = String(h);
        sel.appendChild(opt);
      }
      sel.value = String(value);
      wrap.appendChild(sel);
      return { wrap, sel };
    };
    const off = hourSel(bh.endHour, 'Signs off at');
    const on = hourSel(bh.startHour, 'Back on at');
    fields.append(toggleLabel, off.wrap, on.wrap);
    editor.appendChild(fields);
    const previewLine = el('div', 'onair-editor-preview');
    editor.appendChild(previewLine);
    const actions = el('div', 'onair-editor-actions');
    const applyBtn = button('APPLY', 'btn btn-primary');
    const cancelBtn = button('CANCEL');
    actions.append(applyBtn, cancelBtn);
    editor.appendChild(actions);

    let impact = null;
    const commandNow = () => ({
      type: 'channel.setBroadcastHours', channel: ch.number,
      broadcastHours: { enabled: toggle.checked, startHour: Number(on.sel.value), endHour: Number(off.sel.value) },
    });
    const refresh = () => {
      off.sel.disabled = !toggle.checked;
      on.sel.disabled = !toggle.checked;
      const cmd = commandNow();
      const same = !!bh.enabled === cmd.broadcastHours.enabled
        && (!cmd.broadcastHours.enabled || (bh.startHour === cmd.broadcastHours.startHour && bh.endHour === cmd.broadcastHours.endHour));
      if (cmd.broadcastHours.enabled && cmd.broadcastHours.startHour === cmd.broadcastHours.endHour) {
        impact = null;
        applyBtn.disabled = true;
        previewLine.textContent = 'Signing off and back on at the same hour would never sign off.';
        drawImpact([]);
        return;
      }
      impact = same ? null : previewWeek([cmd]);
      applyBtn.disabled = same;
      previewLine.textContent = same ? 'No change yet.' : `${countsSentence(impact.counts)} (outlined).`;
      drawImpact(impact ? impact.diff.changed : []);
    };
    [toggle, off.sel, on.sel].forEach((c) => c.addEventListener('change', refresh));
    applyBtn.addEventListener('click', () => {
      const cmd = commandNow();
      commitEdit([cmd], cmd.broadcastHours.enabled
        ? `Sign CH ${ch.number} off ${hourSpanLabel(cmd.broadcastHours.endHour, cmd.broadcastHours.startHour)}`
        : `Broadcast CH ${ch.number} around the clock`, { preview: impact });
    });
    cancelBtn.addEventListener('click', closeEditor);
    refresh();
    toggle.focus({ preventScroll: true });
    editor.scrollIntoView({ block: 'nearest' });
  }

  // ---------- explanation ----------

  const ROLE_TEXT = { wins: 'AIRS', outranked: 'OUTRANKED', skipped: 'SKIPPED', passes: 'ON AIR' };
  const BREAK_ROLE_TEXT = { wins: 'DECIDES', outranked: 'OUTRANKED', skipped: 'SKIPPED', passes: 'PASSES' };

  function describeLayer(layer, explained) {
    const { kind, item, role, reason } = layer;
    const bh = ch.broadcastHours;
    const winner = explained.layers.find((l) => l.group === layer.group && l.role === 'wins');
    const winnerName = winner && winner.item ? blockLabel(winner.item) : null;
    switch (kind) {
      case 'broadcastHours':
        return {
          name: 'Broadcast hours',
          text: role === 'wins'
            ? `Signed off until ${formatHourLabel(bh.startHour)}, so nothing below airs.`
            : `On the air ${hourSpanLabel(bh.startHour, bh.endHour)}.`,
        };
      case 'block': {
        const pr = `priority ${item.priority || 0}`;
        let text;
        if (reason === 'no-content') text = 'Matches this time, but has no folder, so it can\'t air.';
        else if (reason === 'not-started') text = 'Matches, but has nothing to show on this date yet.';
        else if (role === 'wins') text = 'The highest-priority block matching this time.';
        else if (role === 'outranked' && winner && winner.kind === 'block') text = `Matches, but "${winnerName}" (priority ${winner.item.priority || 0}) is higher.`;
        else text = 'Matches, but the channel is signed off.';
        return { name: `Block "${blockLabel(item)}" (${pr})`, text };
      }
      case 'dayOverride':
        return { name: `Day override ${layer.key}`, text: 'A calendar exception on this block for this date.' };
      case 'default':
        return {
          name: 'Default lineup',
          text: reason === 'no-content'
            ? 'The channel has no folders of its own.'
            : (role === 'wins' ? 'The channel\'s own folders, because no block matches this time.' : 'The channel\'s own folders, used whenever no block matches.'),
        };
      case 'adsSwitch':
        return { name: 'Ads off', text: 'Ads are switched off for this channel, so it never breaks.' };
      case 'flow':
        return { name: `Flow "${item.name || item.id}"`, text: role === 'wins' ? 'Decides every break in this show.' : 'Matches, but an earlier flow in the list wins.' };
      case 'preset':
        return { name: `Preset "${item.name || item.id}"`, text: role === 'wins' ? `Decides this show's breaks (${String(item.timing || 'interval').toLowerCase()}).` : 'Matches, but a flow or an earlier preset wins.' };
      case 'blockAds':
        return { name: `Ads on block "${blockLabel(item)}"`, text: role === 'wins' ? 'This block\'s own ad settings decide the breaks.' : 'Matches, but a flow or preset wins.' };
      case 'channelAds':
      case 'globalAds': {
        const cc = kind === 'channelAds' ? ch.commercials : S.config.commercials;
        const every = cc && cc.intervalMinutes ? `every ${cc.intervalMinutes} min` : String((cc && cc.timing) || 'interval');
        return { name: kind === 'channelAds' ? 'Channel ad cadence' : 'Default ad cadence', text: role === 'wins' ? `Breaks ${every}, because nothing above matches.` : `Breaks ${every} whenever nothing above matches.` };
      }
      default:
        return { name: kind, text: '' };
    }
  }

  function editLayerAction(layer) {
    const owner = pluginOwner(layer.item);
    if (owner) return { owned: owner };
    switch (layer.kind) {
      case 'broadcastHours': return { run: openSignOffEditor };
      case 'block': case 'dayOverride': case 'blockAds': return opts.onEditBlock ? { run: () => opts.onEditBlock(layer.item) } : null;
      case 'default': return { run: () => goToChannelPage(ch, 'content') };
      case 'adsSwitch': case 'channelAds': return { run: () => goToChannelPage(ch, 'breaks') };
      case 'flow': return { run: () => goToProgramming('flows', `#flow-list .flow-list-item[data-flow-id="${CSS.escape(layer.item.id)}"]`) };
      case 'preset': return { run: () => goToProgramming('presets', `#presets-list .interstitial-card[data-item-id="${CSS.escape(layer.item.id)}"] .interstitial-card-summary`) };
      case 'globalAds': return { run: () => goToProgramming('presets') };
      default: return null;
    }
  }

  // Every layer that had a say at `atMs`, in order, with "Edit this layer".
  // Blocks that aired or were outranked can be dragged (or moved with ▲▼) to
  // change which one wins (§4.2).
  function buildLayersList(atMs) {
    const explained = explainLayers(ch, atMs);
    const wrap = el('div', 'onair-layers');
    const orderable = explained.layers.filter((l) => l.kind === 'block' && l.reason !== 'no-content');

    const reorder = (block, toIndex) => {
      const order = orderable.map((l) => l.item).filter((b) => b !== block);
      order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, block);
      const commands = reorderCommands(ch, order);
      if (!commands.length) return;
      commitEdit(commands, `Put "${blockLabel(block)}" ${toIndex === 0 ? 'on top' : `at position ${toIndex + 1}`} at ${formatClock(new Date(atMs))}`);
    };

    [['content', 'WHAT AIRS'], ['breaks', 'BREAKS']].forEach(([group, heading]) => {
      const list = el('ol', 'onair-layer-list');
      list.setAttribute('aria-label', `${heading.toLowerCase()} layers, highest first`);
      wrap.appendChild(el('div', 'onair-layers-heading', heading));
      explained.layers.filter((l) => l.group === group).forEach((layer) => {
        const { name, text } = describeLayer(layer, explained);
        const row = el('li', `onair-layer role-${layer.role}`);
        row.dataset.kind = layer.kind;
        if (layer.item && layer.item.id) row.dataset.itemId = layer.item.id;
        const roleText = (group === 'breaks' ? BREAK_ROLE_TEXT : ROLE_TEXT)[layer.role] || layer.role.toUpperCase();
        row.append(el('span', 'onair-layer-role', roleText));
        const body = el('span', 'onair-layer-body');
        body.append(el('strong', 'onair-layer-name', name), el('small', 'onair-layer-text', text));
        row.appendChild(body);

        const orderIndex = orderable.indexOf(layer);
        if (editable && orderIndex !== -1 && orderable.length > 1) {
          row.draggable = true;
          row.classList.add('orderable');
          const up = button('▲', 'btn onair-layer-move');
          up.setAttribute('aria-label', `Raise ${name}`);
          up.disabled = orderIndex === 0;
          up.addEventListener('click', () => reorder(layer.item, orderIndex - 1));
          const down = button('▼', 'btn onair-layer-move');
          down.setAttribute('aria-label', `Lower ${name}`);
          down.disabled = orderIndex === orderable.length - 1;
          down.addEventListener('click', () => reorder(layer.item, orderIndex + 1));
          row.append(up, down);
          row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-onair-layer', layer.item.id); e.dataTransfer.effectAllowed = 'move'; });
          row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-onair-layer')) { e.preventDefault(); row.classList.add('drop-target'); } });
          row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('drop-target');
            const dragged = orderable.find((l) => l.item.id === e.dataTransfer.getData('text/x-onair-layer'));
            if (dragged && dragged !== layer) reorder(dragged.item, orderIndex);
          });
        }

        const action = editable ? editLayerAction(layer) : null;
        if (action && action.owned) {
          row.appendChild(el('span', 'onair-layer-owned', `OWNED BY ${String(action.owned).toUpperCase()}`));
        } else if (action) {
          const editBtn = button('EDIT THIS LAYER', 'btn onair-layer-edit');
          editBtn.addEventListener('click', action.run);
          row.appendChild(editBtn);
        }
        list.appendChild(row);
      });
      wrap.appendChild(list);
    });
    return wrap;
  }

  // ---------- program menu ----------

  function programMenuGroups(entry, day, atMs) {
    const title = getDisplayTitle(entry.file);
    const breaksInsideAt = Math.min(Math.max(atMs, entry.start + 1), entry.end - 1);
    const noBreaks = noBreaksCommands(ch, entry, breaksInsideAt);
    const addBreak = addBreakHereCommands(ch, entry, breaksInsideAt, title);
    const offAirNow = day.offAir.some((r) => breaksInsideAt >= r.start && breaksInsideAt < r.end);
    const groups = [
      [
        { label: 'Replace this airing with…', run: () => openReplaceEditor(entry, day), disabled: offAirNow, title: offAirNow ? 'The channel is signed off here.' : '' },
        {
          label: 'Only this day: give it its own block',
          title: 'Adds a one-day block that airs the same thing, so later edits to it change only this date.',
          disabled: offAirNow,
          run: () => {
            const cmd = exceptionBlockCommand(ch, entry, day.dayStart);
            selectedBlockId = cmd.block.id;
            commitEdit([cmd], `Give ${title} on ${formatDayHeading(entry.start)} its own block`);
          },
        },
      ],
      [
        {
          label: addBreak.label ? `Add a break here (${formatClock(new Date(breaksInsideAt))})` : 'Add a break here',
          disabled: !!addBreak.disabled,
          title: addBreak.disabled || addBreak.label,
          run: () => commitEdit(addBreak.commands, addBreak.label),
        },
        {
          label: noBreaks.label || 'No ad breaks in this show',
          disabled: !!noBreaks.disabled,
          title: noBreaks.disabled || '',
          run: () => commitEdit(noBreaks.commands, `${noBreaks.label}: ${title}`),
        },
      ],
      [
        ...(entry.block && opts.onEditBlock ? [{ label: `Edit block "${blockLabel(entry.block)}"`, run: () => opts.onEditBlock(entry.block) }] : []),
        { label: 'Watch from here', run: () => watchFrom(entry, day) },
      ],
    ];
    return groups;
  }

  function openProgramMenu(entry, day, event) {
    const atMs = event && event.clientX != null && event.currentTarget
      ? day.dayStart + (hourFromPointer(event.currentTarget.closest('.onair-day'), event.clientX) * 3600000)
      : entry.start + (entry.end - entry.start) / 2;
    const menu = MenuButton({ label: `Actions for ${getDisplayTitle(entry.file)}`, groups: programMenuGroups(entry, day, atMs) });
    if (event && event.clientX != null) menu.openAt(event);
    else menu.open();
  }

  async function watchFrom(entry, day) {
    // Same "preview at an instant" route AIR CHECK's FORCE ON TV takes:
    // shift the viewing clock to the program's start, then tune. Date.now()
    // is the deliberate real-time reference the offset is measured from.
    S.timeOffsetMs = Math.max(entry.start, day.dayStart) - Date.now();
    S.setupPreviewActive = true;
    showTvScreen();
    await tuneToChannel(ch.number);
  }

  function showDetail(entry, day) {
    selected = { start: entry.start, dayStart: day.dayStart };
    grid.querySelectorAll('.onair-program.selected').forEach((n) => n.classList.remove('selected'));
    grid.querySelector(`.onair-program[data-start="${entry.start}"][data-day="${day.dayStart}"]`)?.classList.add('selected');

    const mid = Math.max(entry.start, day.dayStart) + Math.max(1, (Math.min(entry.end, day.dayEnd) - Math.max(entry.start, day.dayStart)) / 2);
    const breaksInside = day.breaks.filter((b) => b.end > entry.start && b.start < entry.end);

    detail.innerHTML = '';
    detail.appendChild(el('div', 'onair-detail-title', getDisplayTitle(entry.file)));
    detail.appendChild(el('div', 'onair-detail-when',
      `${formatDayHeading(entry.start)} · ${formatClock(new Date(entry.start))}–${formatClock(new Date(entry.end))} · ${formatDuration((entry.end - entry.start) / 1000)}`));

    const facts = el('div', 'onair-facts');
    const fact = (label, value, why) => {
      const row = el('div', 'onair-fact');
      row.append(el('strong', null, label), el('span', null, value), el('small', null, why));
      facts.appendChild(row);
    };
    fact('BREAKS', breaksInside.length ? `${breaksInside.length} during this program` : 'NONE',
      breaksInside.length
        ? breaksInside.map((b) => `${formatClock(new Date(b.start))} ${breakLabel(b.breakType)}`).join(' · ')
        : (!day.breaks.length && ch.adsEnabled !== false
          ? 'No break airs anywhere on this day — usually nothing in the Bumper & Ad Pool is eligible for this channel.'
          : 'No break window resolves inside this program.'));
    fact('FILE', (entry.file && entry.file.path) || '—', '');
    detail.appendChild(facts);
    detail.appendChild(buildLayersList(mid));

    const actions = el('div', 'onair-detail-actions');
    const previewBtn = button('WATCH FROM HERE ▶', 'btn btn-primary');
    previewBtn.addEventListener('click', () => watchFrom(entry, day));
    actions.appendChild(previewBtn);
    if (editable) {
      const menu = MenuButton({ label: `Actions for ${getDisplayTitle(entry.file)}`, groups: programMenuGroups(entry, day, mid) });
      menu.button.textContent = 'CHANGE THIS AIRING ⋯';
      menu.button.classList.add('onair-detail-menu');
      actions.appendChild(menu.button);
    }
    detail.appendChild(actions);
  }

  // ---------- block lane ----------

  function spanMenuGroups(span, dayStart) {
    const block = span.block;
    const weekday = new Date(dayStart).getDay();
    const days = block.trigger.days && block.trigger.days.length ? block.trigger.days : null;
    const addDays_ = days
      ? [0, 1, 2, 3, 4, 5, 6].filter((d) => !days.includes(d)).map((d) => ({
        label: `Also air on ${dayName(d)}`,
        run: () => commitEdit([copyToWeekdayCommand(ch, block, d)], `Also air "${blockLabel(block)}" on ${dayName(d)}`),
      }))
      : [];
    const stop = removeWeekdayCommand(ch, block, weekday);
    return [
      [
        ...(opts.onEditBlock ? [{ label: 'Edit in BLOCKS', run: () => opts.onEditBlock(block) }] : []),
        { label: 'Change what it plays…', run: () => openChangeContentEditor(block) },
      ],
      block.trigger.type === 'dayOfWeek'
        ? [...addDays_, ...(stop ? [{ label: `Stop airing on ${dayName(weekday)}s`, run: () => commitEdit([stop], `Stop "${blockLabel(block)}" on ${dayName(weekday)}s`) }] : [])]
        : [],
      [{ label: 'Remove block', danger: true, run: () => removeBlock(block) }],
    ];
  }

  async function removeBlock(block) {
    const commands = [{ type: 'block.remove', channel: ch.number, id: block.id }];
    let impact;
    try { impact = previewWeek(commands); } catch (e) { showImpactBar(`Can't do that: ${e.message}`); return; }
    drawImpact(impact.diff.changed);
    const ok = await confirmDialog({
      title: `Remove "${blockLabel(block)}"?`,
      message: `Removing it ${countsSentence(impact.counts)} (outlined), and takes its day overrides, theme and ad settings with it. You can undo this.`,
    });
    if (!ok) { clearImpact(); return; }
    selectedBlockId = null;
    try {
      dispatch(commands, { label: `Remove "${blockLabel(block)}"` });
    } catch (e) {
      showImpactBar(`Can't do that: ${e.message}`);
      return;
    }
    render({ keepScroll: true, impact: impact.diff.changed, message: `Removed "${blockLabel(block)}": ${countsSentence(impact.counts)}.` });
  }

  function renderLane(dayStart, laneEl) {
    laneEl.innerHTML = '';
    const spans = blockSpansForDay(ch, dayStart);
    spans.forEach((span) => {
      const node = el('div', `onair-span${span.empty ? ' empty' : ''}${span.block.id === selectedBlockId ? ' selected' : ''}`);
      node.dataset.blockId = span.block.id;
      node.style.left = `${xFor(dayStart, span.start)}px`;
      node.style.width = `${Math.max(4, xFor(dayStart, span.end) - xFor(dayStart, span.start))}px`;
      node.style.setProperty('--onair-source', colorFor(sourceKey(ch, span.block)));
      node.tabIndex = editable ? 0 : -1;
      node.setAttribute('role', editable ? 'button' : 'img');
      const label = `${blockLabel(span.block)}${span.empty ? ' (no folder)' : ''}, ${formatClock(new Date(span.start))}–${formatClock(new Date(span.end))}`;
      node.setAttribute('aria-label', label);
      node.title = editable ? `${label}. Drag an edge to change its hours, the chip to copy it to another day; Delete removes it.` : label;
      const chip = el('span', 'onair-span-chip');
      chip.title = 'Drag to another day to copy this block there';
      node.append(chip, el('span', 'onair-span-label', blockLabel(span.block)));
      if (editable && span.startEdge) node.appendChild(Object.assign(el('span', 'onair-span-edge start'), { title: 'Drag to change when it starts' }));
      if (editable && span.endEdge) node.appendChild(Object.assign(el('span', 'onair-span-edge end'), { title: 'Drag to change when it ends' }));
      node._span = span;
      laneEl.appendChild(node);
    });
  }

  function selectBlock(blockId) {
    selectedBlockId = blockId;
    grid.querySelectorAll('.onair-span').forEach((n) => n.classList.toggle('selected', n.dataset.blockId === blockId));
  }

  // One pointer gesture on a lane: create, resize, copy, or a click to select.
  function attachLaneGestures(laneEl, dayEl, dayStart) {
    laneEl.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const spanEl = event.target.closest('.onair-span');
      const edgeEl = event.target.closest('.onair-span-edge');
      const chipEl = event.target.closest('.onair-span-chip');
      const startHour = hourFromPointer(dayEl, event.clientX);
      let gesture;
      if (edgeEl) gesture = { kind: 'resize', edge: edgeEl.classList.contains('start') ? 'start' : 'end', span: spanEl._span };
      else if (chipEl && spanEl._span.block.trigger.type === 'dayOfWeek') gesture = { kind: 'copy', span: spanEl._span };
      else if (spanEl) gesture = { kind: 'select', span: spanEl._span };
      else gesture = { kind: 'create', from: startHour };
      event.preventDefault();
      laneEl.setPointerCapture(event.pointerId);
      closeEditor();

      const ghost = el('div', 'onair-lane-ghost');
      let frame = 0;
      let pendingX = event.clientX;
      let pendingY = event.clientY;
      let command = null;
      let moved = false;
      let target = null;

      const update = () => {
        frame = 0;
        const hour = hourFromPointer(dayEl, pendingX);
        if (gesture.kind === 'create') {
          const a = Math.floor(Math.min(gesture.from, hour));
          const b = Math.ceil(Math.max(gesture.from, hour));
          gesture.range = [a, Math.max(a + 1, b)];
          if (!ghost.isConnected) laneEl.appendChild(ghost);
          ghost.style.left = `${gesture.range[0] * zoom.pxPerHour}px`;
          ghost.style.width = `${(gesture.range[1] - gesture.range[0]) * zoom.pxPerHour}px`;
          ghost.textContent = hourSpanLabel(gesture.range[0], gesture.range[1]);
        } else if (gesture.kind === 'resize') {
          const snapped = Math.round(hour);
          command = resizeCommand(ch, gesture.span.block, gesture.edge, snapped);
          const span = gesture.span;
          const left = gesture.edge === 'start' ? xFor(dayStart, dayStart + snapped * 3600000) : xFor(dayStart, span.start);
          const right = gesture.edge === 'end' ? xFor(dayStart, dayStart + snapped * 3600000) : xFor(dayStart, span.end);
          if (!ghost.isConnected) laneEl.appendChild(ghost);
          ghost.style.left = `${Math.min(left, right)}px`;
          ghost.style.width = `${Math.abs(right - left)}px`;
          if (!command) {
            ghost.textContent = 'NO CHANGE';
            drawImpact([], { onlyDay: dayStart });
            hideImpactBar();
            return;
          }
          const hours = `${hourSpanLabel(command.startHour, command.endHour)}`;
          ghost.textContent = hours;
          try {
            const preview = previewDay([command], dayStart);
            drawImpact(preview.diff.changed, { onlyDay: dayStart });
            showImpactBar(`"${blockLabel(span.block)}" ${hours}: ${countsSentence(preview.counts).replace('this week', `on ${formatDayHeading(dayStart)}`)} · release to apply to every week, Esc to cancel`);
          } catch (e) {
            showImpactBar(`Can't do that: ${e.message}`);
            command = null;
          }
        } else if (gesture.kind === 'copy') {
          const rowEl = document.elementFromPoint(pendingX, pendingY)?.closest('.onair-row[data-day-start]');
          grid.querySelectorAll('.onair-row.drop-target').forEach((r) => r.classList.remove('drop-target'));
          target = rowEl && Number(rowEl.dataset.dayStart) !== dayStart ? Number(rowEl.dataset.dayStart) : null;
          if (target != null) {
            rowEl.classList.add('drop-target');
            const weekday = new Date(target).getDay();
            command = copyToWeekdayCommand(ch, gesture.span.block, weekday);
            showImpactBar(command
              ? `Drop to also air "${blockLabel(gesture.span.block)}" on ${dayName(weekday)}s`
              : `"${blockLabel(gesture.span.block)}" already airs on ${dayName(weekday)}s`);
          } else {
            command = null;
            hideImpactBar();
          }
        }
      };

      const onMove = (e) => {
        pendingX = e.clientX;
        pendingY = e.clientY;
        if (Math.abs(e.clientX - event.clientX) > 3 || Math.abs(e.clientY - event.clientY) > 3) moved = true;
        if (gesture.kind === 'select' || !moved) return;
        if (!frame) frame = requestAnimationFrame(update);
      };
      const finish = (e, cancelled) => {
        laneEl.removeEventListener('pointermove', onMove);
        laneEl.removeEventListener('pointerup', onUp);
        laneEl.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        grid.querySelectorAll('.onair-row.drop-target').forEach((r) => r.classList.remove('drop-target'));
        if (laneEl.hasPointerCapture && laneEl.hasPointerCapture(event.pointerId)) laneEl.releasePointerCapture(event.pointerId);
        if (cancelled) { ghost.remove(); clearImpact(); return; }
        if (gesture.kind === 'select' || !moved) {
          ghost.remove();
          if (gesture.span) {
            selectBlock(gesture.span.block.id);
            spanElFor(dayStart, gesture.span.block.id)?.focus({ preventScroll: true });
          }
          return;
        }
        update();
        if (gesture.kind === 'create') {
          openCreateEditor(dayStart, gesture.range[0], gesture.range[1]);
          return;
        }
        ghost.remove();
        if (!command) { clearImpact(); return; }
        const block = gesture.span.block;
        const label = gesture.kind === 'resize'
          ? `Set "${blockLabel(block)}" to ${hourSpanLabel(command.startHour, command.endHour)}`
          : `Also air "${blockLabel(block)}" on ${dayName(new Date(target).getDay())}s`;
        selectedBlockId = block.id;
        commitEdit([command], label);
      };
      const onUp = (e) => finish(e, false);
      const onCancel = (e) => finish(e, true);
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(e, true); } };
      laneEl.addEventListener('pointermove', onMove);
      laneEl.addEventListener('pointerup', onUp);
      laneEl.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
    });

    laneEl.addEventListener('contextmenu', (event) => {
      const spanEl = event.target.closest('.onair-span');
      if (!spanEl) return;
      selectBlock(spanEl._span.block.id);
      MenuButton({ label: `Actions for ${blockLabel(spanEl._span.block)}`, groups: spanMenuGroups(spanEl._span, dayStart) }).openAt(event);
    });

    laneEl.addEventListener('keydown', (event) => {
      const spanEl = event.target.closest('.onair-span');
      if (!spanEl) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        removeBlock(spanEl._span.block);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectBlock(spanEl._span.block.id);
      } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const r = spanEl.getBoundingClientRect();
        MenuButton({ label: `Actions for ${blockLabel(spanEl._span.block)}`, groups: spanMenuGroups(spanEl._span, dayStart) })
          .openAt({ preventDefault() {}, clientX: r.left + 8, clientY: r.bottom + 2 });
      }
    });
  }

  function spanElFor(dayStart, blockId) {
    const row = rows.find((r) => r.dayStart === dayStart);
    return row && row.row.querySelector(`.onair-span[data-block-id="${CSS.escape(blockId)}"]`);
  }

  // ---------- grid ----------

  function renderHourHeader() {
    const header = el('div', 'onair-row onair-hours');
    header.appendChild(el('div', 'onair-day-label onair-corner'));
    const track = el('div', 'onair-track');
    track.style.width = `${24 * zoom.pxPerHour}px`;
    const step = zoom.pxPerHour >= 140 ? 1 : 3;
    for (let h = 0; h < 24; h += step) {
      const tick = el('span', 'onair-hour-tick', formatHourLabel(h));
      tick.style.left = `${h * zoom.pxPerHour}px`;
      track.appendChild(tick);
    }
    header.appendChild(track);
    return header;
  }

  function renderDayRow(day, rowEl) {
    const dayEl = rowEl.querySelector('.onair-day');
    const lane = dayEl.querySelector('.onair-lane');
    const track = dayEl.querySelector('.onair-track');
    renderLane(day.dayStart, lane);
    track.innerHTML = '';
    const now = viewNow();

    day.offAir.forEach((r) => {
      const block = el('div', 'onair-offair', 'SIGNED OFF');
      block.style.left = `${xFor(day.dayStart, r.start)}px`;
      block.style.width = `${xFor(day.dayStart, r.end) - xFor(day.dayStart, r.start)}px`;
      if (editable) {
        block.title = 'Signed off — click to change the sign-off hours';
        block.addEventListener('click', openSignOffEditor);
      }
      track.appendChild(block);
    });

    day.programs.forEach((entry) => {
      if (day.offAir.some((r) => entry.start >= r.start && entry.end <= r.end)) return;
      const left = xFor(day.dayStart, Math.max(entry.start, day.dayStart));
      const width = Math.max(2, xFor(day.dayStart, Math.min(entry.end, day.dayEnd)) - left);
      const btn = el('button', 'onair-program');
      btn.type = 'button';
      btn.tabIndex = -1;
      btn.dataset.start = String(entry.start);
      btn.dataset.end = String(entry.end);
      btn.dataset.day = String(day.dayStart);
      btn.style.left = `${left}px`;
      btn.style.width = `${width}px`;
      btn.style.setProperty('--onair-source', colorFor(sourceKey(ch, entry.block)));
      if (entry.end <= now) btn.classList.add('past');
      if (selected && selected.start === entry.start && selected.dayStart === day.dayStart) btn.classList.add('selected');
      const title = getDisplayTitle(entry.file);
      btn.title = `${formatClock(new Date(entry.start))} ${title}`;
      btn.setAttribute('aria-label', `${formatDayHeading(entry.start)} ${formatClock(new Date(entry.start))}, ${title}`);
      btn.appendChild(el('span', 'onair-program-label', title));
      btn.addEventListener('click', () => showDetail(entry, day));
      if (editable) {
        btn.addEventListener('contextmenu', (event) => {
          showDetail(entry, day);
          openProgramMenu(entry, day, event);
        });
      }
      btn._entry = entry;
      track.appendChild(btn);
    });

    day.breaks.forEach((b) => {
      const mark = breakMarkEl(b, { className: `onair-break onair-break-${b.breakType}` });
      mark.style.left = `${xFor(day.dayStart, b.start)}px`;
      mark.style.width = `${Math.max(2, xFor(day.dayStart, b.end) - xFor(day.dayStart, b.start))}px`;
      mark.title = `${formatClock(new Date(b.start))} ${breakLabel(b.breakType)}`;
      track.appendChild(mark);
    });

    if (now >= day.dayStart && now < day.dayEnd) {
      const line = el('div', 'onair-now');
      line.style.left = `${xFor(day.dayStart, now)}px`;
      track.appendChild(line);
      rowEl.classList.add('today');
    }
    rowEl.classList.remove('loading');
  }

  function renderLegend() {
    legend.innerHTML = '';
    const seen = new Map();
    days.forEach((day) => day.programs.forEach((p) => {
      const key = sourceKey(ch, p.block);
      if (!seen.has(key)) seen.set(key, p.block ? blockLabel(p.block) : 'DEFAULT LINEUP');
    }));
    seen.forEach((label, key) => {
      const item = el('span', 'onair-legend-item');
      const sw = el('span', 'onair-legend-swatch');
      sw.style.background = colorFor(key);
      item.append(sw, document.createTextNode(label));
      legend.appendChild(item);
    });
    const breakItem = el('span', 'onair-legend-item');
    breakItem.append(el('span', 'onair-legend-swatch onair-legend-break'), document.createTextNode('AD BREAK / BUMPER'));
    legend.appendChild(breakItem);
  }

  // ---------- keyboard / remote navigation over programs ----------

  function programsInRow(rowEl) {
    return Array.from(rowEl.querySelectorAll('.onair-program')).sort((a, b) => Number(a.dataset.start) - Number(b.dataset.start));
  }

  function focusProgram(node) {
    if (!node) return;
    grid.querySelectorAll('.onair-program[tabindex="0"]').forEach((n) => { n.tabIndex = -1; });
    node.tabIndex = 0;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // The program on `rowEl` airing at the same time of day as `node`, or the
  // nearest one.
  function programAtSameTime(node, rowEl) {
    const fromDay = Number(node.dataset.day);
    const mid = (Math.max(Number(node.dataset.start), fromDay) + Number(node.dataset.end)) / 2 - fromDay;
    const toDay = Number(rowEl.dataset.dayStart);
    const at = toDay + mid;
    const list = programsInRow(rowEl);
    return list.find((n) => Number(n.dataset.start) <= at && Number(n.dataset.end) > at)
      || list.reduce((best, n) => (!best || Math.abs(Number(n.dataset.start) - at) < Math.abs(Number(best.dataset.start) - at) ? n : best), null);
  }

  grid.addEventListener('keydown', (event) => {
    const node = event.target.closest('.onair-program');
    if (!node) return;
    if (editable && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
      event.preventDefault();
      const day = days.find((d) => d.dayStart === Number(node.dataset.day));
      const r = node.getBoundingClientRect();
      if (day) openProgramMenu(node._entry, day, { preventDefault() {}, clientX: r.left + 8, clientY: r.bottom + 2, currentTarget: node });
      return;
    }
    const key = normalizeKey(event);
    if (!key) return;
    const rowEl = node.closest('.onair-row');
    const rowIndex = rows.findIndex((r) => r.row === rowEl);
    if (key === 'left' || key === 'right') {
      const list = programsInRow(rowEl);
      const i = list.indexOf(node);
      const next = list[i + (key === 'right' ? 1 : -1)];
      if (next) { event.preventDefault(); focusProgram(next); }
    } else if (key === 'up' || key === 'down') {
      const other = rows[rowIndex + (key === 'down' ? 1 : -1)];
      if (other) { event.preventDefault(); focusProgram(programAtSameTime(node, other.row)); }
    } else if (key === 'ok' && !editable) {
      event.preventDefault();
      node.click();
    } else if (key === 'red' || key === 'green' || key === 'chUp' || key === 'chDown') {
      event.preventDefault();
      const back = key === 'red' || key === 'chDown';
      const focusAt = { weekday: new Date(Number(node.dataset.day)).getDay(), offset: Number(node.dataset.start) - Number(node.dataset.day) };
      pageWeek(back ? -7 : 7);
      pendingFocus = focusAt;
    }
  });

  let pendingFocus = null;

  function render({ scrollToNow = false, keepScroll = false, impact = null, message = null } = {}) {
    const token = ++renderToken;
    const scrollLeft = scroller.scrollLeft;
    const focusWasInGrid = grid.contains(document.activeElement);
    zoomGroup.setValue(zoom.label);
    const weekEnd = addDays(weekStart, 6);
    weekLabel.textContent = `${formatDayHeading(weekStart)} – ${formatDayHeading(weekEnd)}`;
    grid.innerHTML = '';
    grid.appendChild(renderHourHeader());
    if (!keepScroll || !selected) detail.innerHTML = '';
    if (message) {
      const undoHint = el('span', 'onair-impact-hint', 'Ctrl+Z undoes it.');
      showImpactBar(message, [undoHint]);
    } else {
      hideImpactBar();
    }

    rows = [];
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(weekStart, i);
      const row = el('div', 'onair-row loading');
      row.dataset.dayStart = String(dayStart);
      row.appendChild(el('div', 'onair-day-label', formatDayHeading(dayStart)));
      const dayEl = el('div', 'onair-day');
      dayEl.style.width = `${24 * zoom.pxPerHour}px`;
      const lane = el('div', 'onair-lane');
      lane.setAttribute('aria-label', `${formatDayHeading(dayStart)} blocks`);
      const track = el('div', 'onair-track');
      dayEl.append(lane, track);
      row.appendChild(dayEl);
      grid.appendChild(row);
      rows.push({ dayStart, row });
      if (editable) attachLaneGestures(lane, dayEl, dayStart);
    }
    if (keepScroll) scroller.scrollLeft = scrollLeft;

    // One day per frame, so a heavy channel fills in row by row instead of
    // freezing the setup screen for the whole week at once.
    days = [];
    let totalMs = 0;
    const began = performance.now();
    const step = (i) => {
      if (token !== renderToken) return;
      if (i >= rows.length) {
        renderLegend();
        panelEl.dataset.weekResolveMs = String(Math.round(totalMs));
        panelEl.dataset.weekRenderMs = String(Math.round(performance.now() - began));
        status.textContent = `Resolved ${days.reduce((n, d) => n + d.programs.length, 0)} programs and ${days.reduce((n, d) => n + d.breaks.length, 0)} breaks in ${Math.round(totalMs)} ms.`;
        if (impact && impact.length) drawImpact(impact);
        if (selected) {
          const day = days.find((d) => d.dayStart === selected.dayStart);
          const entry = day && day.programs.find((p) => Math.abs(p.start - selected.start) < 1);
          if (day && entry) showDetail(entry, day);
        }
        const firstProgram = grid.querySelector('.onair-program');
        if (firstProgram) firstProgram.tabIndex = 0;
        if (pendingFocus) {
          const row = rows.find((r) => new Date(r.dayStart).getDay() === pendingFocus.weekday);
          const target = row && programsInRow(row.row).find((n) => Number(n.dataset.start) - row.dayStart >= pendingFocus.offset - 1) || firstProgram;
          pendingFocus = null;
          focusProgram(target);
        } else if (focusWasInGrid && firstProgram && !grid.contains(document.activeElement)) {
          focusProgram(grid.querySelector('.onair-program.selected') || firstProgram);
        }
        panelEl.dispatchEvent(new CustomEvent('onair:resolved', { detail: { ms: totalMs } }));
        return;
      }
      const day = queryDay(ch, rows[i].dayStart);
      totalMs += day.ms;
      days.push(day);
      renderDayRow(day, rows[i].row);
      if (scrollToNow && viewNow() >= day.dayStart && viewNow() < day.dayEnd) {
        scroller.scrollLeft = Math.max(0, xFor(day.dayStart, viewNow()) - scroller.clientWidth / 3);
      }
      requestAnimationFrame(() => step(i + 1));
    };
    status.textContent = 'RESOLVING THE WEEK…';
    requestAnimationFrame(() => step(0));
  }

  if (!(ch.files && ch.files.length) && !(ch.blocks || []).some((b) => b.files && b.files.length)) {
    panelEl.innerHTML = '';
    panelEl.appendChild(el('div', 'titles-empty', 'NOTHING AIRS YET — ADD A FOLDER ON THE CONTENT PAGE OR A BLOCK ON THE BLOCKS VIEW.'));
    return;
  }
  render({ scrollToNow: remembered.weekStart == null, keepScroll: false });
}
