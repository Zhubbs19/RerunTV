// PROGRAMMING tab: the shared interstitials pool (commercial bumpers,
// station IDs, trivia facts, "up next" video idents — tagged by
// type/channel/block affinity) plus the box-wide commercials interval and
// auto-standby settings. renderer/js/interstitials.js does the actual
// deterministic selection at playback time; this module is setup-side only.
// The Interactive Show & Ad Flow Builder used to live at the end of this
// file too — split out to setup-interstitials-flowbuilder.js since it's a
// self-contained subsystem (own timeline canvas, own simulator) with almost
// no coupling to the pool/preset/standby UI here beyond the shared
// labeledField() helper (exported below for that file to reuse).
import { addInterstitialPoolEntry, sortedChannels } from './channels.js';
import {
  commercialsIntervalEl, interstitialsAddEntryBtn, interstitialsAddFolderBtn,
  interstitialsBulkBarEl, interstitialsBulkChannelApplyBtn, interstitialsBulkChannelSelectEl,
  interstitialsBulkCountEl, interstitialsBulkRemoveBtn, interstitialsBulkSelectAllBtn, interstitialsBulkTagApplyBtn,
  interstitialsBulkTagInputEl, interstitialsBulkToggleBtn, interstitialsCollapseAllBtn, interstitialsExpandAllBtn,
  interstitialsFilterChannelEl, interstitialsFilterTypeEl, interstitialsListEl, interstitialsSearchEl,
  presetsAddBtn, presetsCollapseAllBtn, presetsExpandAllBtn, presetsListEl, presetsSearchEl,
  scanProgressEl, standbyEnabledEl, standbyIntervalEl, player,
} from './dom.js';
import { blockPickerLabel } from './setup-schedule.js';
import { attachTagAutocomplete, buildBreakpointTrack, parsePositiveInt, probeDuration } from './setup-util.js';
import { S, saveConfigDebounced } from './state.js';
import { confirmDialog } from './setup-dialogs.js';
import { basenameNoExt } from './util.js';

export function renderCommercialsPanel() {
  const cm = S.config.commercials;
  commercialsIntervalEl.value = cm.intervalMinutes || 10;
}

commercialsIntervalEl.addEventListener('change', () => {
  S.config.commercials.intervalMinutes = parsePositiveInt(commercialsIntervalEl.value, 10);
  saveConfigDebounced();
});

// Data-driven type table for the interstitials pool editor — one row per
// break type, describing how its entry form should look (a video-file picker
// vs. a free-text field) so a new type (premiereJingle/promo/signOn/signOff/
// a dynamic background+text variant, all still-unbuilt spec phases) slots in
// as a new entry here rather than a rewrite of renderInterstitialsList's
// switch-on-type logic. contentKind drives the entry-form builder below;
// textPlaceholder only applies to contentKind: 'text'.
const INTERSTITIAL_TYPE_DEFS = [
  { id: 'commercial', label: 'COMMERCIAL', contentKind: 'video' },
  { id: 'channelId', label: 'STATION ID', contentKind: 'text', textPlaceholder: 'TEXT OVERRIDE (BLANK = AUTO)' },
  { id: 'trivia', label: 'TRIVIA', contentKind: 'text', textPlaceholder: 'DID YOU KNOW…' },
  { id: 'upNext', label: 'UP NEXT IDENT', contentKind: 'video' },
  { id: 'adBreakIn', label: 'AD POD — BUMP IN', contentKind: 'video' },
  { id: 'adBreakOut', label: 'AD POD — BUMP OUT', contentKind: 'video' },
  { id: 'signOff', label: 'SIGN-OFF', contentKind: 'video' },
  { id: 'signOn', label: 'SIGN-ON', contentKind: 'video' },
  // A promo's BLOCK field (below) isn't "which block this plays during"
  // like every other type — it's the *target* being promoted (a
  // dateRange-triggered block on the same channel), so needsLeadDays gates
  // a leadDays field onto the row and the channel/block selects effectively
  // become required rather than optional (an 'ANY'/unset target is simply
  // inert — see eligiblePromoEntries, interstitials.js).
  { id: 'promo', label: 'PROMO (UPCOMING BLOCK)', contentKind: 'video', needsLeadDays: true },
  // Same "BLOCK field names the target, not 'plays during'" shape as promo
  // just above — a one-shot sting fired exactly at a dateRange block's
  // premiere day (see eligiblePremiereJingleEntries, interstitials.js),
  // rather than counting down to it. No leadDays field: this doesn't count
  // down, it fires at the moment itself.
  { id: 'premiereJingle', label: 'PREMIERE JINGLE', contentKind: 'video' },
];

function interstitialTypeDef(type) {
  return INTERSTITIAL_TYPE_DEFS.find((t) => t.id === type) || INTERSTITIAL_TYPE_DEFS[0];
}

// Fixed per-type accent colors (not hash-derived like block/calendar
// colors — there are only 9 types and giving each a stable, memorable color
// makes the pool scannable at a glance once there are dozens of entries).
const TYPE_COLORS = {
  commercial: '#f0b429', channelId: '#6fe0f2', trivia: '#8b93f5', upNext: '#5fd68a',
  adBreakIn: '#e0895f', adBreakOut: '#e0895f', signOff: '#ff6b5b', signOn: '#ff6b5b',
  promo: '#ff9fd6', premiereJingle: '#a3e635',
};

// A <label>+control pair, stacked — see the .field/.field-label CSS rule's
// own comment for why this replaces relying on placeholder text alone.
// Exported for setup-interstitials-flowbuilder.js, which builds its own
// step-editor form rows the same way.
export function labeledField(labelText, controlEl, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'field' + (opts && opts.wide ? ' field-span-full' : '');
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(controlEl);
  return wrap;
}

// Filter-bar + collapsed-group state is deliberately ephemeral UI state, not
// persisted config — it resets to "show everything, all groups open" each
// time the app restarts, same as e.g. a scroll position would.
let interstitialsSearchText = '';
let interstitialsFilterType = 'any';
let interstitialsFilterChannel = 'all';
const collapsedInterstitialGroups = new Set();
// Individual entries default collapsed to a one-line summary (see
// .interstitial-card CSS) — this Set tracks which ones the user has
// expanded to edit, the inverse of collapsedInterstitialGroups above
// (channel sections default open, individual entries default closed).
const expandedInterstitialEntries = new Set();
// Set right before a render triggered by an actual expand/collapse click, so
// buildInterstitialCard can play a reveal fade on just that card's body —
// NOT on every rebuild (search-filter typing re-renders the whole list on a
// 150ms debounce too, and that must stay instant, not replay a fade on
// every already-open card each time a keystroke lands).
let justToggledEntryId = null;
// Bulk-select mode for the pool — same ephemeral-UI-state treatment as the
// filter/collapse state above: resets to "off, nothing selected" on restart.
let interstitialsBulkMode = false;
const selectedInterstitialEntries = new Set();

// Search boxes re-render the whole list on every keystroke (necessary since
// there's no virtualization) — trivial for a handful of entries, but once a
// pool grows into the hundreds, re-diffing/re-filtering on every single
// keypress starts to visibly lag typing. A short debounce keeps typing snappy
// without giving up "search re-filters live" responsiveness.
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function entrySearchHaystack(entry) {
  const parts = [entry.text, entry.file && entry.file.path, entry.bgFile && entry.bgFile.path];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function entryMatchesFilters(entry) {
  if (interstitialsFilterType !== 'any' && entry.type !== interstitialsFilterType) return false;
  if (interstitialsFilterChannel === 'any' && entry.channelAffinity !== 'any') return false;
  if (interstitialsFilterChannel !== 'all' && interstitialsFilterChannel !== 'any' &&
    String(entry.channelAffinity) !== interstitialsFilterChannel) return false;
  if (interstitialsSearchText && !entrySearchHaystack(entry).includes(interstitialsSearchText)) return false;
  return true;
}

function populateInterstitialsFilterOptions() {
  const typeVal = interstitialsFilterTypeEl.value || 'any';
  interstitialsFilterTypeEl.innerHTML = '<option value="any">ALL TYPES</option>';
  INTERSTITIAL_TYPE_DEFS.forEach((def) => {
    const opt = document.createElement('option');
    opt.value = def.id;
    opt.textContent = def.label;
    interstitialsFilterTypeEl.appendChild(opt);
  });
  interstitialsFilterTypeEl.value = typeVal;

  const chVal = interstitialsFilterChannelEl.value || 'all';
  interstitialsFilterChannelEl.innerHTML = '<option value="all">ALL CHANNELS</option><option value="any">UNASSIGNED (ANY CHANNEL)</option>';
  sortedChannels().forEach((c) => {
    const opt = document.createElement('option');
    opt.value = String(c.number);
    opt.textContent = `CH ${c.number}${c.name ? ' — ' + c.name : ''}`;
    interstitialsFilterChannelEl.appendChild(opt);
  });
  interstitialsFilterChannelEl.value = chVal;
}

// Groups the pool by channel affinity (ANY first, then each channel that
// actually has entries, in channel order) so a box with many channels' worth
// of interstitials reads as sections instead of one undifferentiated list —
// the filter bar above narrows within that, this just organizes what's left.
function groupInterstitialsByChannel(pool) {
  const groups = new Map();
  pool.forEach((entry, idx) => {
    if (!entryMatchesFilters(entry)) return;
    const key = entry.channelAffinity === 'any' ? 'any' : String(entry.channelAffinity);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ entry, idx });
  });
  const ordered = [];
  if (groups.has('any')) ordered.push({ key: 'any', label: 'ANY CHANNEL', items: groups.get('any') });
  sortedChannels().forEach((c) => {
    const key = String(c.number);
    if (groups.has(key)) {
      ordered.push({ key, label: `CH ${c.number}${c.name ? ' — ' + c.name : ''}`, items: groups.get(key) });
    }
  });
  return ordered;
}

// "9 COMMERCIAL, 2 STATION ID, 1 UP NEXT" — lets a channel group's header
// convey what's actually in it without opening it, which matters once a
// channel has dozens of entries of several different types mixed together.
function typeBreakdownText(items) {
  const counts = new Map();
  items.forEach(({ entry }) => counts.set(entry.type, (counts.get(entry.type) || 0) + 1));
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} ${interstitialTypeDef(type).label}`)
    .join(', ');
}

function entrySummaryTitle(entry, typeDef) {
  if (entry.dynamic) return entry.bgFile ? basenameNoExt(entry.bgFile.path) : '(no background clip)';
  if (typeDef.contentKind === 'video') return entry.file ? basenameNoExt(entry.file.path) : '(no file)';
  return entry.text ? entry.text : '(auto text)';
}

function buildInterstitialCard(entry, idx, pool) {
    const typeDef = interstitialTypeDef(entry.type);
    const card = document.createElement('div');
    const isOpen = expandedInterstitialEntries.has(entry.id);
    card.className = 'interstitial-card' + (isOpen ? ' open' : '');
    card.style.borderLeftColor = TYPE_COLORS[entry.type] || 'var(--line)';

    // ---------- Collapsed summary (always visible) ----------
    const summary = document.createElement('div');
    summary.className = 'interstitial-card-summary';

    if (interstitialsBulkMode) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'interstitial-bulk-checkbox';
      checkbox.checked = selectedInterstitialEntries.has(entry.id);
      checkbox.addEventListener('click', (e) => {
        e.stopPropagation();
        if (checkbox.checked) selectedInterstitialEntries.add(entry.id);
        else selectedInterstitialEntries.delete(entry.id);
        renderInterstitialsBulkBar();
      });
      summary.appendChild(checkbox);
    }

    const chevron = document.createElement('span');
    chevron.className = 'interstitial-card-chevron';
    chevron.textContent = '▸';
    summary.appendChild(chevron);

    const pill = document.createElement('span');
    pill.className = 'interstitial-type-pill';
    pill.style.background = TYPE_COLORS[entry.type] || 'var(--line)';
    pill.textContent = typeDef.label;
    summary.appendChild(pill);

    const title = document.createElement('span');
    title.className = 'interstitial-card-title';
    title.textContent = entrySummaryTitle(entry, typeDef);
    summary.appendChild(title);

    if (entry.contentTags && entry.contentTags.length) {
      const tagsWrap = document.createElement('span');
      tagsWrap.className = 'interstitial-card-tags';
      entry.contentTags.slice(0, 3).forEach((t) => {
        const chip = document.createElement('span');
        chip.className = 'interstitial-tag-chip';
        chip.textContent = t;
        tagsWrap.appendChild(chip);
      });
      summary.appendChild(tagsWrap);
    }

    const meta = document.createElement('span');
    meta.className = 'interstitial-card-meta';
    const chLabel = entry.channelAffinity === 'any' ? 'ANY CH' : `CH ${entry.channelAffinity}`;
    meta.textContent = `${chLabel} · WT ${entry.weight || 1}`;
    summary.appendChild(meta);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn remove-btn';
    removeBtn.textContent = 'REMOVE';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const label = (typeDef && typeDef.label) || entry.type || 'this entry';
      if (!(await confirmDialog(`Remove this ${label} pool entry? This can't be undone.`))) return;
      pool.splice(idx, 1);
      expandedInterstitialEntries.delete(entry.id);
      renderInterstitialsList();
      saveConfigDebounced();
    });
    summary.appendChild(removeBtn);

    summary.addEventListener('click', () => {
      const opening = !expandedInterstitialEntries.has(entry.id);
      if (opening) expandedInterstitialEntries.add(entry.id);
      else expandedInterstitialEntries.delete(entry.id);
      justToggledEntryId = opening ? entry.id : null;
      renderInterstitialsList();
    });
    card.appendChild(summary);

    if (!isOpen) return card;

    // ---------- Expanded body (built only while open) ----------
    const body = document.createElement('div');
    body.className = 'interstitial-card-body';
    if (justToggledEntryId === entry.id) {
      body.classList.add('reveal');
      justToggledEntryId = null;
    }

    const mainGrid = document.createElement('div');
    mainGrid.className = 'field-grid';

    const typeSelect = document.createElement('select');
    typeSelect.className = 'block-hour-select';
    INTERSTITIAL_TYPE_DEFS.forEach((def) => {
      const opt = document.createElement('option');
      opt.value = def.id;
      opt.textContent = def.label;
      typeSelect.appendChild(opt);
    });
    typeSelect.value = entry.type;
    typeSelect.addEventListener('change', () => {
      entry.type = typeSelect.value;
      const def = interstitialTypeDef(entry.type);
      // A dynamic entry's text is its template (still meaningful across a
      // video-kind-to-video-kind type switch) — only clear it for a
      // non-dynamic video type, where text has no role at all.
      if (def.contentKind === 'video' && !entry.dynamic) entry.text = null;
      if (def.contentKind !== 'video') { entry.file = null; entry.dynamic = false; entry.bgFile = null; }
      // Matches the LEAD DAYS field's own displayed fallback of 7 below —
      // without this, switching to PROMO and never touching the field would
      // silently behave as 0 lead days (fires exactly at the premiere
      // instant) despite the UI showing 7.
      if (def.needsLeadDays && entry.leadDays == null) entry.leadDays = 7;
      renderInterstitialsList();
      saveConfigDebounced();
    });
    mainGrid.appendChild(labeledField('TYPE', typeSelect));

    const channelSelect = document.createElement('select');
    channelSelect.className = 'block-hour-select';
    const anyOpt = document.createElement('option');
    anyOpt.value = 'any';
    anyOpt.textContent = 'ANY CHANNEL';
    channelSelect.appendChild(anyOpt);
    sortedChannels().forEach((c) => {
      const opt = document.createElement('option');
      opt.value = String(c.number);
      opt.textContent = `CH ${c.number}${c.name ? ' — ' + c.name : ''}`;
      channelSelect.appendChild(opt);
    });
    channelSelect.value = entry.channelAffinity === 'any' ? 'any' : String(entry.channelAffinity);
    channelSelect.addEventListener('change', () => {
      entry.channelAffinity = channelSelect.value === 'any' ? 'any' : parseInt(channelSelect.value, 10);
      // A block affinity only means something within the channel it was
      // picked from — switching channels drops it rather than carrying a
      // now-meaningless block id along silently.
      entry.blockAffinity = null;
      renderInterstitialsList();
      saveConfigDebounced();
    });
    mainGrid.appendChild(labeledField('CHANNEL', channelSelect));

    // Cascades off channelSelect: only a specific channel's own blocks are
    // ever offered, so this can't produce a dangling blockAffinity pointing
    // at another channel's block id.
    const blockSelect = document.createElement('select');
    blockSelect.className = 'block-hour-select';
    const affinityChannel = entry.channelAffinity === 'any' ? null : sortedChannels().find((c) => c.number === entry.channelAffinity);
    const anyBlockOpt = document.createElement('option');
    anyBlockOpt.value = 'any';
    anyBlockOpt.textContent = 'ANY BLOCK';
    blockSelect.appendChild(anyBlockOpt);
    if (affinityChannel) {
      (affinityChannel.blocks || []).forEach((block) => {
        const opt = document.createElement('option');
        opt.value = block.id;
        opt.textContent = blockPickerLabel(block);
        blockSelect.appendChild(opt);
      });
    } else {
      blockSelect.disabled = true;
      blockSelect.title = 'Pick a specific channel above to target one of its blocks';
    }
    blockSelect.value = entry.blockAffinity || 'any';
    blockSelect.addEventListener('change', () => {
      entry.blockAffinity = blockSelect.value === 'any' ? null : blockSelect.value;
      saveConfigDebounced();
    });
    mainGrid.appendChild(labeledField('BLOCK', blockSelect));

    const weightInput = document.createElement('input');
    weightInput.type = 'number';
    weightInput.min = 1;
    weightInput.className = 'block-priority-input';
    weightInput.title = 'How often this entry is picked relative to others';
    weightInput.value = entry.weight || 1;
    weightInput.addEventListener('change', () => {
      entry.weight = parseInt(weightInput.value, 10) || 1;
      saveConfigDebounced();
    });
    mainGrid.appendChild(labeledField('WEIGHT', weightInput));

    body.appendChild(mainGrid);

    // Targets this entry at content carrying at least one of these tags
    // (see the TITLES tab, setup-panels.js, for tagging files) — on top of
    // channel/block affinity, not instead of it. Blank (the default) means
    // untargeted: eligible next to any content, exactly today's behavior.
    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.className = 'title-row-input';
    tagsInput.placeholder = 'e.g. cartoon, halloween';
    tagsInput.value = (entry.contentTags || []).join(', ');
    const tagsField = labeledField('CONTENT TAGS (BLANK = ANY)', attachTagAutocomplete(tagsInput), { wide: true });
    body.appendChild(tagsField);

    const secondGrid = document.createElement('div');
    secondGrid.className = 'field-grid field-grid-wide';
    let secondGridUsed = false;

    let forcedTimingField = null;
    if (entry.type === 'commercial') {
      const timingSelect = document.createElement('select');
      timingSelect.className = 'block-hour-select';
      timingSelect.title = 'Force this ad to play right before/after tagged content, instead of only during normal ad breaks';
      [
        ['', 'ANY (NORMAL AD BREAKS)'],
        ['pre', 'FORCE — RIGHT BEFORE TAGGED CONTENT'],
        ['post', 'FORCE — RIGHT AFTER TAGGED CONTENT'],
        ['both', 'FORCE — BEFORE & AFTER TAGGED CONTENT'],
      ].forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        timingSelect.appendChild(opt);
      });
      timingSelect.value = entry.contentTiming || '';
      timingSelect.addEventListener('change', () => {
        entry.contentTiming = timingSelect.value || null;
        saveConfigDebounced();
      });
      forcedTimingField = labeledField('FORCED TIMING', timingSelect);
      if (entry.contentTags && entry.contentTags.length) {
        secondGrid.appendChild(forcedTimingField);
        secondGridUsed = true;
      }
    }

    tagsInput.addEventListener('change', () => {
      const tags = tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
      entry.contentTags = tags.length ? tags : null;
      if (!entry.contentTags) entry.contentTiming = null;
      if (forcedTimingField) {
        if (entry.contentTags && entry.contentTags.length) {
          if (!forcedTimingField.parentNode) {
            secondGrid.insertBefore(forcedTimingField, secondGrid.firstChild);
            if (!secondGrid.parentNode) body.appendChild(secondGrid);
          }
        } else if (forcedTimingField.parentNode) {
          forcedTimingField.parentNode.removeChild(forcedTimingField);
        }
      }
      saveConfigDebounced();
    });

    if (typeDef.needsLeadDays) {
      const leadInput = document.createElement('input');
      leadInput.type = 'number';
      leadInput.min = 0;
      leadInput.className = 'block-priority-input';
      leadInput.title = 'Starts airing this many days before the target block\'s start date';
      leadInput.value = entry.leadDays != null ? entry.leadDays : 7;
      leadInput.addEventListener('change', () => {
        entry.leadDays = parsePositiveInt(leadInput.value, 0);
        saveConfigDebounced();
      });
      secondGrid.appendChild(labeledField('LEAD DAYS', leadInput));
      secondGridUsed = true;
    }

    if (typeDef.contentKind === 'video') {
      // Orthogonal to type — any video-kind entry can loop a background
      // clip with live templated text instead of playing a fixed file. See
      // renderDynamicText (playback.js) for the {placeholder} vocabulary
      // and entryDurationS (interstitials.js) for why a dynamic entry needs
      // its own author-set duration (a looping clip has no natural length).
      const dynamicLabel = document.createElement('label');
      dynamicLabel.className = 'shuffle-toggle';
      dynamicLabel.title = 'Loop a background clip with live templated text instead of a fixed video file';
      const dynamicCheckbox = document.createElement('input');
      dynamicCheckbox.type = 'checkbox';
      dynamicCheckbox.checked = !!entry.dynamic;
      dynamicCheckbox.addEventListener('change', () => {
        entry.dynamic = dynamicCheckbox.checked;
        if (entry.dynamic) {
          entry.file = null;
          if (entry.durationS == null) entry.durationS = 15;
        } else {
          entry.bgFile = null;
          entry.text = null;
        }
        renderInterstitialsList();
        saveConfigDebounced();
      });
      dynamicLabel.appendChild(dynamicCheckbox);
      dynamicLabel.appendChild(document.createTextNode('DYNAMIC'));
      body.appendChild(dynamicLabel);

      if (entry.dynamic) {
        const bgBtn = document.createElement('button');
        bgBtn.className = 'btn';
        bgBtn.textContent = entry.bgFile ? basenameNoExt(entry.bgFile.path) : 'CHOOSE BACKGROUND CLIP';
        bgBtn.addEventListener('click', async () => {
          const path = await window.api.selectVideo();
          if (!path) return;
          entry.bgFile = { path };
          renderInterstitialsList();
          saveConfigDebounced();
        });
        body.appendChild(bgBtn);

        const templateInput = document.createElement('input');
        templateInput.type = 'text';
        templateInput.placeholder = '{channel} {time} {nextTitle} {daysUntil} {episodesUntil}';
        templateInput.value = entry.text || '';
        templateInput.addEventListener('input', () => {
          entry.text = templateInput.value;
          saveConfigDebounced();
        });
        body.appendChild(labeledField('TEMPLATE TEXT', templateInput, { wide: true }));

        const durationInput = document.createElement('input');
        durationInput.type = 'number';
        durationInput.min = 1;
        durationInput.className = 'block-priority-input';
        durationInput.title = 'How long the looping clip+text plays for — a background has no natural length of its own';
        durationInput.value = entry.durationS || 15;
        durationInput.addEventListener('change', () => {
          entry.durationS = parsePositiveInt(durationInput.value, 15);
          saveConfigDebounced();
        });
        secondGrid.appendChild(labeledField('SECONDS', durationInput));
        secondGridUsed = true;
      } else {
        const fileBtn = document.createElement('button');
        fileBtn.className = 'btn';
        fileBtn.textContent = entry.file ? basenameNoExt(entry.file.path) : 'CHOOSE FILE';
        fileBtn.addEventListener('click', async () => {
          const path = await window.api.selectVideo();
          if (!path) return;
          const duration = await probeDuration(path);
          entry.file = { path, duration };
          renderInterstitialsList();
          saveConfigDebounced();
        });
        body.appendChild(fileBtn);
      }
    } else {
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.placeholder = typeDef.textPlaceholder || 'TEXT OVERRIDE (BLANK = AUTO)';
      textInput.value = entry.text || '';
      textInput.addEventListener('input', () => {
        entry.text = textInput.value;
        saveConfigDebounced();
      });
      body.appendChild(labeledField('TEXT', textInput, { wide: true }));
    }

    if (secondGridUsed) body.appendChild(secondGrid);

    card.appendChild(body);
    return card;
}

// ---------- Bulk bumper/ad preview ----------
// Plays a channel-group's whole set of video/audio pool entries back-to-back
// through the same shared #player element every other playback path in this
// app uses (see the single-video-element rule) — safe to do from the setup
// screen specifically because #tv-screen (the only place #player is
// visible) is hidden while on setup, so this never visibly hijacks a live
// picture; showTvScreen() always re-tunes fresh via tuneToChannel on the
// way back in, so there's nothing to restore afterward. Capped at 8s per
// entry — long enough to confirm "this is the right bumper," not a full
// unattended watch-through.
const BULK_PREVIEW_MAX_MS = 8000;
let bulkPreviewActive = false;
let bulkPreviewCancelled = false;

async function startBulkPreview(entries, btn) {
  bulkPreviewActive = true;
  bulkPreviewCancelled = false;
  for (let i = 0; i < entries.length; i++) {
    if (bulkPreviewCancelled) break;
    const entry = entries[i];
    const f = entry.file || entry.bgFile;
    if (btn) btn.textContent = `■ STOP PREVIEW (${i + 1}/${entries.length})`;
    try {
      const resolved = await window.api.resolvePlayablePath(f.path);
      const url = await window.api.toFileUrl(resolved.path);
      player.src = url;
      await player.play().catch(() => {});
      const durationMs = f.duration ? Math.min(BULK_PREVIEW_MAX_MS, f.duration * 1000) : BULK_PREVIEW_MAX_MS;
      // eslint-disable-next-line no-await-in-loop -- intentionally sequential, this is a one-at-a-time preview
      await new Promise((resolve) => { setTimeout(resolve, durationMs); });
    } catch (e) { /* a file that fails to resolve/play is skipped, not fatal to the rest of the run */ }
  }
  bulkPreviewActive = false;
  player.pause();
  renderInterstitialsList(); // resets every group's preview button back to its default label
}

function stopBulkPreview() {
  bulkPreviewCancelled = true;
}

export function renderInterstitialsList() {
  interstitialsListEl.innerHTML = '';
  const pool = S.config.interstitials.pool;
  populateInterstitialsFilterOptions();
  renderInterstitialsBulkBar();

  if (pool.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO INTERSTITIALS — STATION ID FALLS BACK TO AUTO TEXT, ADS/TRIVIA STAY SILENT UNTIL YOU ADD SOME.';
    interstitialsListEl.appendChild(empty);
    return;
  }

  const groups = groupInterstitialsByChannel(pool);
  if (groups.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO ENTRIES MATCH THE CURRENT FILTER/SEARCH.';
    interstitialsListEl.appendChild(empty);
    return;
  }

  groups.forEach((group) => {
    const collapsed = collapsedInterstitialGroups.has(group.key);
    const header = document.createElement('div');
    header.className = 'interstitials-group-header' + (collapsed ? ' collapsed' : '');
    const chevron = document.createElement('span');
    chevron.className = 'interstitials-group-chevron';
    chevron.textContent = '▾';
    header.appendChild(chevron);
    header.appendChild(document.createTextNode(group.label + ' '));
    const count = document.createElement('span');
    count.className = 'interstitials-group-count';
    count.textContent = `(${group.items.length} — ${typeBreakdownText(group.items)})`;
    header.appendChild(count);

    const playable = group.items.filter(({ entry }) => (entry.file && entry.file.path) || (entry.bgFile && entry.bgFile.path));
    if (playable.length) {
      const previewBtn = document.createElement('button');
      previewBtn.className = 'btn interstitials-group-preview-btn';
      previewBtn.textContent = `▶ PREVIEW POOL (${playable.length})`;
      previewBtn.title = 'Plays every video/audio entry in this group back-to-back (up to 8s each) — muted picture, since this only runs while you\'re on the setup screen, not live TV.';
      previewBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (bulkPreviewActive) { stopBulkPreview(); return; }
        startBulkPreview(playable.map(({ entry }) => entry), previewBtn);
      });
      header.appendChild(previewBtn);
    }

    header.addEventListener('click', () => {
      if (collapsedInterstitialGroups.has(group.key)) collapsedInterstitialGroups.delete(group.key);
      else collapsedInterstitialGroups.add(group.key);
      renderInterstitialsList();
    });
    interstitialsListEl.appendChild(header);

    if (collapsed) return;
    group.items.forEach(({ entry, idx }) => {
      interstitialsListEl.appendChild(buildInterstitialCard(entry, idx, pool));
    });
  });
}

const debouncedRenderInterstitialsList = debounce(() => renderInterstitialsList(), 150);
interstitialsSearchEl.addEventListener('input', () => {
  interstitialsSearchText = interstitialsSearchEl.value.trim().toLowerCase();
  debouncedRenderInterstitialsList();
});
interstitialsFilterTypeEl.addEventListener('change', () => {
  interstitialsFilterType = interstitialsFilterTypeEl.value;
  renderInterstitialsList();
});
interstitialsFilterChannelEl.addEventListener('change', () => {
  interstitialsFilterChannel = interstitialsFilterChannelEl.value;
  renderInterstitialsList();
});

// Expand/collapse-all — once a pool has dozens of entries across several
// channel groups, clicking each one open/closed individually to scan or tidy
// up the whole thing stops being practical.
interstitialsExpandAllBtn.addEventListener('click', () => {
  collapsedInterstitialGroups.clear();
  S.config.interstitials.pool.forEach((entry) => {
    if (entryMatchesFilters(entry)) expandedInterstitialEntries.add(entry.id);
  });
  renderInterstitialsList();
});
interstitialsCollapseAllBtn.addEventListener('click', () => {
  expandedInterstitialEntries.clear();
  renderInterstitialsList();
});

// ---------- Bulk select mode ----------

function visibleInterstitialEntries() {
  return S.config.interstitials.pool.filter((entry) => entryMatchesFilters(entry));
}

function renderInterstitialsBulkBar() {
  const count = selectedInterstitialEntries.size;
  interstitialsBulkBarEl.classList.toggle('hidden', !interstitialsBulkMode || count === 0);
  interstitialsBulkCountEl.textContent = `${count} SELECTED`;

  const chVal = interstitialsBulkChannelSelectEl.value || 'any';
  interstitialsBulkChannelSelectEl.innerHTML = '<option value="any">ANY CHANNEL</option>';
  sortedChannels().forEach((c) => {
    const opt = document.createElement('option');
    opt.value = String(c.number);
    opt.textContent = `CH ${c.number}${c.name ? ' — ' + c.name : ''}`;
    interstitialsBulkChannelSelectEl.appendChild(opt);
  });
  interstitialsBulkChannelSelectEl.value = chVal;
}

function selectedInterstitialEntryObjs() {
  const pool = S.config.interstitials.pool;
  return pool.filter((entry) => selectedInterstitialEntries.has(entry.id));
}

interstitialsBulkToggleBtn.addEventListener('click', () => {
  interstitialsBulkMode = !interstitialsBulkMode;
  if (!interstitialsBulkMode) selectedInterstitialEntries.clear();
  interstitialsBulkToggleBtn.classList.toggle('active', interstitialsBulkMode);
  interstitialsBulkToggleBtn.textContent = interstitialsBulkMode ? 'DONE SELECTING' : 'SELECT ENTRIES';
  renderInterstitialsList();
});

interstitialsBulkSelectAllBtn.addEventListener('click', () => {
  const visible = visibleInterstitialEntries();
  const allSelected = visible.every((e) => selectedInterstitialEntries.has(e.id));
  if (allSelected) visible.forEach((e) => selectedInterstitialEntries.delete(e.id));
  else visible.forEach((e) => selectedInterstitialEntries.add(e.id));
  renderInterstitialsList();
});

interstitialsBulkChannelApplyBtn.addEventListener('click', () => {
  const val = interstitialsBulkChannelSelectEl.value;
  const channelAffinity = val === 'any' ? 'any' : parseInt(val, 10);
  selectedInterstitialEntryObjs().forEach((entry) => {
    entry.channelAffinity = channelAffinity;
    entry.blockAffinity = null; // stale once the channel changes — see the single-entry channelSelect handler above
  });
  renderInterstitialsList();
  saveConfigDebounced();
});

interstitialsBulkTagApplyBtn.addEventListener('click', () => {
  const tag = interstitialsBulkTagInputEl.value.trim().toLowerCase();
  if (!tag) return;
  selectedInterstitialEntryObjs().forEach((entry) => {
    const tags = new Set(entry.contentTags || []);
    tags.add(tag);
    entry.contentTags = Array.from(tags);
  });
  interstitialsBulkTagInputEl.value = '';
  renderInterstitialsList();
  saveConfigDebounced();
});

interstitialsBulkRemoveBtn.addEventListener('click', async () => {
  const targets = selectedInterstitialEntryObjs();
  if (!targets.length) return;
  if (!(await confirmDialog(`Remove ${targets.length} selected pool entr${targets.length === 1 ? 'y' : 'ies'}? This can't be undone.`))) return;
  const targetIds = new Set(targets.map((e) => e.id));
  S.config.interstitials.pool = S.config.interstitials.pool.filter((e) => !targetIds.has(e.id));
  selectedInterstitialEntries.clear();
  renderInterstitialsList();
  saveConfigDebounced();
});

interstitialsAddEntryBtn.addEventListener('click', () => {
  const entry = addInterstitialPoolEntry({});
  expandedInterstitialEntries.add(entry.id); // open immediately — a fresh entry has nothing worth summarizing yet
  renderInterstitialsList();
  saveConfigDebounced();
});

interstitialsAddFolderBtn.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;

  scanProgressEl.classList.remove('hidden');
  scanProgressEl.textContent = 'SCANNING INTERSTITIALS FOLDER…';
  const paths = await window.api.scanFolder(folder);
  for (let i = 0; i < paths.length; i++) {
    scanProgressEl.textContent = `PROBING ${i + 1} / ${paths.length}…`;
    const duration = await probeDuration(paths[i]);
    addInterstitialPoolEntry({ file: { path: paths[i], duration } });
  }
  scanProgressEl.classList.add('hidden');
  renderInterstitialsList();
  saveConfigDebounced();
});

// AD PRESETS — named break layouts targeted at tagged content (see the
// TITLES tab's per-file tags field) rather than at a channel or block. Each
// preset is a `commercials`-shaped object (same timing/intervalMinutes/
// breakpoints/podMin/podMax fields resolveBreakAt already reads off a
// channel or block's own commercials config — see resolveActiveCommercials,
// schedule.js) plus contentTags + a name, so it's a drop-in match for the
// exact same resolution code with zero special-casing at playback time.
function randomPresetId() {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function freshPreset() {
  return {
    id: randomPresetId(), name: '', enabled: true, contentTags: [],
    timing: 'interval', intervalMinutes: null, breakpoints: null, podMin: 1, podMax: 1,
  };
}

// Same ephemeral-UI-state treatment as the pool's filter/expand state above.
let presetsSearchText = '';
// Presets used to always render fully expanded — fine for a handful, but
// unreadable once there are a couple dozen. Now default-collapsed to a
// one-line summary, same as pool entries.
const expandedPresets = new Set();
// Same scoping as justToggledEntryId above — only an actual click plays the
// reveal, not a search-driven rebuild.
let justToggledPresetId = null;

function presetMatchesSearch(preset) {
  if (!presetsSearchText) return true;
  const haystack = [preset.name, ...(preset.contentTags || [])].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(presetsSearchText);
}

function buildPresetRow(preset, idx, presets) {
  const isOpen = expandedPresets.has(preset.id);
  const card = document.createElement('div');
  card.className = 'interstitial-card' + (isOpen ? ' open' : '');
  card.style.borderLeftColor = 'var(--gold)';

  const header = document.createElement('div');
  header.className = 'interstitial-card-summary';

  const chevron = document.createElement('span');
  chevron.className = 'interstitial-card-chevron';
  chevron.textContent = '▸';
  header.appendChild(chevron);

  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'shuffle-toggle';
  const enabledCheckbox = document.createElement('input');
  enabledCheckbox.type = 'checkbox';
  enabledCheckbox.title = 'Enabled';
  enabledCheckbox.checked = preset.enabled !== false;
  enabledCheckbox.addEventListener('click', (e) => e.stopPropagation());
  enabledCheckbox.addEventListener('change', () => {
    preset.enabled = enabledCheckbox.checked;
    saveConfigDebounced();
  });
  enabledLabel.appendChild(enabledCheckbox);
  header.appendChild(enabledLabel);

  const title = document.createElement('span');
  title.className = 'interstitial-card-title';
  title.textContent = preset.name && preset.name.trim() ? preset.name : '(untitled preset)';
  header.appendChild(title);

  if (preset.contentTags && preset.contentTags.length) {
    const tagsWrap = document.createElement('span');
    tagsWrap.className = 'interstitial-card-tags';
    preset.contentTags.slice(0, 3).forEach((t) => {
      const chip = document.createElement('span');
      chip.className = 'interstitial-tag-chip';
      chip.textContent = t;
      tagsWrap.appendChild(chip);
    });
    header.appendChild(tagsWrap);
  }

  const meta = document.createElement('span');
  meta.className = 'interstitial-card-meta';
  meta.textContent = preset.enabled === false ? 'DISABLED' : (preset.timing || 'interval').toUpperCase();
  header.appendChild(meta);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn remove-btn';
  removeBtn.textContent = 'REMOVE';
  removeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!(await confirmDialog(`Remove the "${preset.name || 'untitled'}" ad preset? This can't be undone.`))) return;
    presets.splice(idx, 1);
    expandedPresets.delete(preset.id);
    renderPresetsList();
    saveConfigDebounced();
  });
  header.appendChild(removeBtn);

  header.addEventListener('click', () => {
    const opening = !expandedPresets.has(preset.id);
    if (opening) expandedPresets.add(preset.id);
    else expandedPresets.delete(preset.id);
    justToggledPresetId = opening ? preset.id : null;
    renderPresetsList();
  });
  card.appendChild(header);

  if (!isOpen) return card;

  const body = document.createElement('div');
  body.className = 'interstitial-card-body';
  if (justToggledPresetId === preset.id) {
    body.classList.add('reveal');
    justToggledPresetId = null;
  }

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'title-row-input';
  nameInput.placeholder = 'e.g. 30-MIN CARTOON, 2 EPS';
  nameInput.value = preset.name || '';
  nameInput.addEventListener('input', () => {
    preset.name = nameInput.value;
    title.textContent = preset.name && preset.name.trim() ? preset.name : '(untitled preset)';
    saveConfigDebounced();
  });
  body.appendChild(labeledField('PRESET NAME', nameInput, { wide: true }));

  const tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.className = 'title-row-input';
  tagsInput.placeholder = 'e.g. cartoon, cartoon-30';
  tagsInput.value = (preset.contentTags || []).join(', ');
  tagsInput.addEventListener('change', () => {
    const tags = tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    preset.contentTags = tags;
    saveConfigDebounced();
  });
  body.appendChild(labeledField('APPLIES TO CONTENT TAGGED', attachTagAutocomplete(tagsInput), { wide: true }));

  const grid = document.createElement('div');
  grid.className = 'field-grid';

  const timingSelect = document.createElement('select');
  timingSelect.className = 'block-hour-select';
  [
    ['interval', 'ON A TIMER'],
    ['everyNMinutes', 'EVERY N MIN'],
    ['breakpoints', 'AT SET POINTS (%)'],
    ['pre', 'BEFORE'],
    ['post', 'AFTER'],
    ['both', 'BEFORE & AFTER'],
  ].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    timingSelect.appendChild(opt);
  });
  timingSelect.value = preset.timing || 'interval';
  timingSelect.addEventListener('change', () => {
    preset.timing = timingSelect.value;
    renderPresetsList();
    saveConfigDebounced();
  });
  grid.appendChild(labeledField('TIMING', timingSelect));

  if (preset.timing === 'interval' || preset.timing === 'everyNMinutes') {
    const intervalInput = document.createElement('input');
    intervalInput.type = 'number';
    intervalInput.min = 1;
    intervalInput.className = 'block-priority-input';
    intervalInput.value = preset.intervalMinutes || '';
    intervalInput.placeholder = '10';
    intervalInput.addEventListener('change', () => {
      preset.intervalMinutes = parsePositiveInt(intervalInput.value, null);
      saveConfigDebounced();
    });
    grid.appendChild(labeledField('EVERY (MIN)', intervalInput));
  }

  if (preset.timing === 'breakpoints') {
    const bpInput = document.createElement('input');
    bpInput.type = 'text';
    bpInput.className = 'title-row-input';
    bpInput.placeholder = 'e.g. 20, 45, 70';
    bpInput.value = (preset.breakpoints || []).join(', ');
    bpInput.addEventListener('change', () => {
      const pts = bpInput.value.split(',')
        .map((v) => parseFloat(v.trim()))
        .filter((v) => Number.isFinite(v) && v > 0 && v < 100);
      preset.breakpoints = pts.length ? pts : null;
      saveConfigDebounced();
      renderPresetsList(); // re-syncs the drag track below to whatever was just typed
    });
    grid.appendChild(labeledField('BREAK POINTS (%)', bpInput));
    const track = buildBreakpointTrack(
      () => preset.breakpoints,
      (pts) => { preset.breakpoints = pts; saveConfigDebounced(); },
      bpInput,
    );
    grid.appendChild(labeledField('DRAG TO SET', track, { wide: true }));
  }

  const podRow = document.createElement('div');
  podRow.className = 'block-card-row';
  const podMinInput = document.createElement('input');
  podMinInput.type = 'number';
  podMinInput.min = 1;
  podMinInput.className = 'block-priority-input';
  podMinInput.value = preset.podMin || 1;
  podMinInput.addEventListener('change', () => {
    preset.podMin = parsePositiveInt(podMinInput.value, 1);
    if ((preset.podMax || 1) < preset.podMin) {
      preset.podMax = preset.podMin;
      podMaxInput.value = preset.podMax;
    }
    podMaxInput.min = preset.podMin;
    saveConfigDebounced();
  });
  podRow.appendChild(podMinInput);
  const podSep = document.createElement('span');
  podSep.className = 'block-count';
  podSep.textContent = 'TO';
  podRow.appendChild(podSep);
  const podMaxInput = document.createElement('input');
  podMaxInput.type = 'number';
  podMaxInput.min = preset.podMin || 1;
  podMaxInput.className = 'block-priority-input';
  podMaxInput.value = preset.podMax || 1;
  podMaxInput.addEventListener('change', () => {
    preset.podMax = Math.max(parsePositiveInt(podMaxInput.value, 1), preset.podMin || 1);
    podMaxInput.value = preset.podMax;
    saveConfigDebounced();
  });
  podRow.appendChild(podMaxInput);
  grid.appendChild(labeledField('SPOTS PER BREAK', podRow));

  body.appendChild(grid);
  card.appendChild(body);
  return card;
}

export function renderPresetsList() {
  presetsListEl.innerHTML = '';
  const presets = S.config.interstitials.presets;
  if (!presets.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO AD PRESETS — EVERY SHOW USES ITS CHANNEL/BLOCK\'S OWN ADS SETTINGS.';
    presetsListEl.appendChild(empty);
    return;
  }
  const visible = presets
    .map((preset, idx) => ({ preset, idx }))
    .filter(({ preset }) => presetMatchesSearch(preset));
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO PRESETS MATCH THAT SEARCH.';
    presetsListEl.appendChild(empty);
    return;
  }
  visible.forEach(({ preset, idx }) => {
    presetsListEl.appendChild(buildPresetRow(preset, idx, presets));
  });
}

const debouncedRenderPresetsList = debounce(() => renderPresetsList(), 150);
presetsSearchEl.addEventListener('input', () => {
  presetsSearchText = presetsSearchEl.value.trim().toLowerCase();
  debouncedRenderPresetsList();
});
presetsExpandAllBtn.addEventListener('click', () => {
  S.config.interstitials.presets.forEach((p) => { if (presetMatchesSearch(p)) expandedPresets.add(p.id); });
  renderPresetsList();
});
presetsCollapseAllBtn.addEventListener('click', () => {
  expandedPresets.clear();
  renderPresetsList();
});

presetsAddBtn.addEventListener('click', () => {
  const preset = freshPreset();
  S.config.interstitials.presets.push(preset);
  expandedPresets.add(preset.id); // open immediately — a fresh preset has nothing worth summarizing yet
  renderPresetsList();
  saveConfigDebounced();
});

export function renderStandbyPanel() {
  const sb = S.config.autoStandby;
  standbyEnabledEl.checked = !!sb.enabled;
  standbyIntervalEl.value = sb.intervalMinutes || 15;
}

standbyEnabledEl.addEventListener('change', () => {
  S.config.autoStandby.enabled = standbyEnabledEl.checked;
  saveConfigDebounced();
});

standbyIntervalEl.addEventListener('change', () => {
  S.config.autoStandby.intervalMinutes = parsePositiveInt(standbyIntervalEl.value, 15);
  saveConfigDebounced();
});

