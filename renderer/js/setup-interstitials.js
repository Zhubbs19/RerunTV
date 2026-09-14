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
import { formatChannelNumber, getChannel, newInterstitialPoolEntry, parseMediaRef, sortedChannels, tryGetDisplayName } from './channels.js';
import { cloneJson } from './commands.js';
import {
  commercialsIntervalEl, interstitialsAddEntryBtn, interstitialsAddFolderBtn,
  interstitialsBulkBarEl, interstitialsBulkChannelApplyBtn, interstitialsBulkChannelSelectEl,
  interstitialsBulkCountEl, interstitialsBulkRemoveBtn, interstitialsBulkSelectAllBtn, interstitialsBulkTagApplyBtn,
  interstitialsBulkTagInputEl, interstitialsBulkToggleBtn, interstitialsDetailEl,
  interstitialsFilterChannelEl, interstitialsFilterTypeEl, interstitialsListEl, interstitialsSearchEl,
  preemptionWindowsEditorEl, presetsAddBtn, presetsDetailEl, presetsListEl, presetsSearchEl,
  scanProgressEl, standbyEnabledEl, standbyIntervalEl, player,
} from './dom.js';
import { getMediaSourcePicker } from './plugins.js';
import { blockPickerLabel } from './setup-schedule.js';
import {
  attachTagAutocomplete, buildBreakpointTrack, buildDeadTagWarning, buildMediaThumbnail, buildPreemptionWindowsEditor,
  emptyState, parsePositiveInt, probeDuration, probeDurationForEntry,
} from './setup-util.js';
import { S, commitInPlace, commitItemEdit, dispatch } from './state.js';
import { alertDialog, confirmDialog, promptDialog } from './setup-dialogs.js';
import { basenameNoExt } from './util.js';
import { MenuButton } from './ui/menu.js';

// ---------- Media sources (import bumpers/ads from a plugin folder) ----------
// Mirrors setup-channels.js's own CHOOSE SOURCE flow (addPluginSourceToChannel)
// — same three-tier folder-picker fallback (a plugin's own renderer-side
// picker, else its pickFolder verb, else a plain text prompt), same
// scan/probe dance — but feeding the shared interstitials pool instead of
// one channel's files, and (pickSingleFileFromProvider below) letting a
// single bumper/ad/promo entry point at exactly one plugin-sourced file
// instead of only ever a local one.
let cachedMediaSourceProviders = [];
let mediaSourceProvidersFetchStarted = false;
function ensureMediaSourceProvidersLoaded() {
  if (mediaSourceProvidersFetchStarted) return;
  mediaSourceProvidersFetchStarted = true;
  window.api.listMediaSourceProviders().then((providers) => {
    if (!providers || !providers.length) return;
    cachedMediaSourceProviders = providers;
    renderMediaSourceImportControl();
    renderInterstitialsList(); // re-render so already-drawn entries pick up the IMPORT FROM SOURCE option
  }).catch(() => {}); // no providers active — every control just stays local-only, same as before this existed
}
ensureMediaSourceProvidersLoaded();

async function pickFolderRefForProvider(providerId) {
  const providerInfo = cachedMediaSourceProviders.find((p) => p.providerId === providerId);
  const label = providerInfo ? providerInfo.displayName : providerId;
  const renderedPicker = getMediaSourcePicker(providerId);
  if (renderedPicker) return renderedPicker();
  try {
    return await window.api.callMediaSourceHook(providerId, 'pickFolder');
  } catch (err) {
    return promptDialog({
      title: `${label.toUpperCase()} FOLDER`,
      message: `Enter a folder reference for ${label} (this provider has no picker UI of its own):`,
    });
  }
}

// A breadcrumb-free "pick one" list — unlike a channel's folder scan (which
// wants every file), a single bumper/ad/promo slot wants exactly one, so a
// folder with more than one match needs a way to choose among them. Reuses
// the app's own confirm-dialog/folder-row CSS classes (setup.css) for visual
// consistency with a media-source plugin's own breadcrumb picker.
function pickOneFromList(refs, labels) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog';
    const box = document.createElement('div');
    box.className = 'confirm-dialog-box';
    overlay.appendChild(box);

    const title = document.createElement('div');
    title.className = 'confirm-dialog-title';
    title.textContent = 'CHOOSE A FILE';
    box.appendChild(title);

    const list = document.createElement('div');
    list.style.maxHeight = '40vh';
    list.style.overflowY = 'auto';
    list.style.margin = '0.5rem 0';
    box.appendChild(list);

    refs.forEach((ref, i) => {
      const row = document.createElement('div');
      row.className = 'folder-row';
      row.style.cursor = 'pointer';
      const nameEl = document.createElement('span');
      nameEl.className = 'folder-row-path';
      nameEl.textContent = labels[i];
      row.appendChild(nameEl);
      row.addEventListener('click', () => close(ref));
      list.appendChild(row);
    });

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'CANCEL';
    cancelBtn.addEventListener('click', () => close(null));
    actions.appendChild(cancelBtn);
    box.appendChild(actions);

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      overlay.remove();
      resolve(result);
    }
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } });

    document.body.appendChild(overlay);
    cancelBtn.focus();
  });
}

// Scans a plugin folder for a SINGLE bumper/ad/promo slot — auto-picks if
// only one file matched, otherwise shows pickOneFromList above. Returns
// {path, source, duration, title?} (same shape a channel's own file entry
// uses) or null if the user cancelled anywhere along the way.
async function pickSingleFileFromProvider(providerId) {
  const folderRef = await pickFolderRefForProvider(providerId);
  if (!folderRef) return null;
  scanProgressEl.classList.remove('hidden');
  scanProgressEl.textContent = 'SCANNING…';
  let refs;
  try {
    refs = await window.api.scanFolder(providerId, folderRef);
  } catch (err) {
    scanProgressEl.textContent = `COULDN'T REACH THAT SOURCE: ${(err && err.message) || 'unknown error'}`;
    setTimeout(() => scanProgressEl.classList.add('hidden'), 3000);
    return null;
  }
  scanProgressEl.classList.add('hidden');
  if (!refs || !refs.length) {
    await alertDialog({ title: 'NO FILES FOUND', message: 'That folder had no playable video files.' });
    return null;
  }
  let chosenRef = refs[0];
  if (refs.length > 1) {
    const labels = await Promise.all(refs.map(async (ref) => {
      const rawRef = parseMediaRef(ref).ref;
      const name = await tryGetDisplayName(providerId, rawRef);
      return name || basenameNoExt(rawRef);
    }));
    chosenRef = await pickOneFromList(refs, labels);
    if (!chosenRef) return null;
  }
  const rawRef = parseMediaRef(chosenRef).ref;
  const [duration, title] = await Promise.all([
    probeDurationForEntry(providerId, rawRef),
    tryGetDisplayName(providerId, rawRef),
  ]);
  return { path: chosenRef, source: providerId, duration, ...(title ? { title } : {}) };
}

// Asked once per bulk import (a whole folder's worth, local or plugin-
// sourced) rather than per file — lets the whole batch land pre-tagged
// with a channel affinity/type/tag instead of importing everything as
// generic ANY-CHANNEL commercials and then having to bulk-select and
// bulk-apply those same three things afterward via the SELECT ENTRIES
// toolbar below. Returns null if cancelled, in which case the caller
// should abort the import entirely rather than falling back to defaults —
// cancelling here means "I didn't mean to import this batch," not "use
// plain defaults."
async function promptBatchImportOptions(count) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-dialog';
    const box = document.createElement('div');
    box.className = 'confirm-dialog-box';
    overlay.appendChild(box);

    const title = document.createElement('div');
    title.className = 'confirm-dialog-title';
    title.textContent = `IMPORT ${count} FILE${count === 1 ? '' : 'S'}`;
    box.appendChild(title);

    const body = document.createElement('div');
    body.className = 'panel-body';
    body.style.flexDirection = 'column';
    body.style.alignItems = 'stretch';
    box.appendChild(body);

    const typeRow = document.createElement('div');
    typeRow.className = 'panel-interval';
    const typeLabel = document.createElement('span');
    typeLabel.textContent = 'TYPE (APPLIED TO ALL)';
    const typeSelect = document.createElement('select');
    typeSelect.className = 'block-hour-select';
    INTERSTITIAL_TYPE_DEFS.filter((d) => d.contentKind === 'video').forEach((d) => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.label;
      typeSelect.appendChild(opt);
    });
    typeSelect.value = 'commercial';
    typeRow.appendChild(typeLabel);
    typeRow.appendChild(typeSelect);
    body.appendChild(typeRow);

    const chRow = document.createElement('div');
    chRow.className = 'panel-interval';
    const chLabel = document.createElement('span');
    chLabel.textContent = 'CHANNEL (APPLIED TO ALL)';
    const chSelect = document.createElement('select');
    chSelect.className = 'block-hour-select';
    const anyOpt = document.createElement('option');
    anyOpt.value = 'any';
    anyOpt.textContent = 'ANY CHANNEL';
    chSelect.appendChild(anyOpt);
    sortedChannels().forEach((c) => {
      const opt = document.createElement('option');
      opt.value = String(c.number);
      opt.textContent = `CH ${c.number}${c.name ? ' — ' + c.name : ''}`;
      chSelect.appendChild(opt);
    });
    chRow.appendChild(chLabel);
    chRow.appendChild(chSelect);
    body.appendChild(chRow);

    const tagRow = document.createElement('div');
    tagRow.className = 'panel-interval';
    const tagLabel = document.createElement('span');
    tagLabel.textContent = 'TAG (OPTIONAL, APPLIED TO ALL)';
    const tagInput = document.createElement('input');
    tagInput.type = 'text';
    tagInput.className = 'title-row-input';
    tagInput.placeholder = 'e.g. halloween';
    tagRow.appendChild(tagLabel);
    tagRow.appendChild(tagInput);
    body.appendChild(tagRow);

    const actions = document.createElement('div');
    actions.className = 'confirm-dialog-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'CANCEL';
    const importBtn = document.createElement('button');
    importBtn.className = 'btn btn-primary';
    importBtn.textContent = 'IMPORT';
    actions.appendChild(cancelBtn);
    actions.appendChild(importBtn);
    box.appendChild(actions);

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      overlay.remove();
      resolve(result);
    }
    cancelBtn.addEventListener('click', () => close(null));
    importBtn.addEventListener('click', () => {
      const channelAffinity = chSelect.value === 'any' ? 'any' : parseInt(chSelect.value, 10);
      const tag = tagInput.value.trim().toLowerCase();
      close({ type: typeSelect.value, channelAffinity, contentTags: tag ? [tag] : [] });
    });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); close(null); } });

    document.body.appendChild(overlay);
    importBtn.focus();
  });
}

// Bulk pool import — the plugin-sourced counterpart to the existing
// interstitialsAddFolderBtn (local-only, unchanged). Adds every video file
// in the chosen folder as its own pool entry, same as scanning a local
// folder already does.
async function importPoolFromProvider(providerId) {
  const folderRef = await pickFolderRefForProvider(providerId);
  if (!folderRef) return;
  scanProgressEl.classList.remove('hidden');
  scanProgressEl.textContent = 'SCANNING…';
  let refs;
  try {
    refs = await window.api.scanFolder(providerId, folderRef);
  } catch (err) {
    scanProgressEl.textContent = `COULDN'T REACH THAT SOURCE: ${(err && err.message) || 'unknown error'}`;
    setTimeout(() => scanProgressEl.classList.add('hidden'), 3000);
    return;
  }
  if (!refs || !refs.length) {
    scanProgressEl.textContent = 'NO VIDEO FILES FOUND IN THAT FOLDER';
    setTimeout(() => scanProgressEl.classList.add('hidden'), 2500);
    return;
  }
  scanProgressEl.classList.add('hidden');
  const options = await promptBatchImportOptions(refs.length);
  if (!options) return;
  scanProgressEl.classList.remove('hidden');
  const added = [];
  for (let i = 0; i < refs.length; i++) {
    scanProgressEl.textContent = `PROBING ${i + 1} / ${refs.length}…`;
    const rawRef = parseMediaRef(refs[i]).ref;
    // eslint-disable-next-line no-await-in-loop
    const [duration, title] = await Promise.all([
      probeDurationForEntry(providerId, rawRef),
      tryGetDisplayName(providerId, rawRef),
    ]);
    added.push(newInterstitialPoolEntry({
      file: { path: refs[i], source: providerId, duration, ...(title ? { title } : {}) },
      type: options.type,
      channelAffinity: options.channelAffinity,
      contentTags: options.contentTags,
    }));
  }
  scanProgressEl.classList.add('hidden');
  addPoolEntries(added);
  renderInterstitialsList();
}

// Small select inserted right after the existing (local-only) ADD FOLDER
// button — only exists once at least one media-source provider is active,
// same "don't show it if there's nothing to show" rule buildChooseSourceControl
// (setup-channels.js) already follows for the per-channel equivalent.
function renderMediaSourceImportControl() {
  const existing = document.getElementById('interstitials-source-select');
  if (existing) existing.remove();
  if (!cachedMediaSourceProviders.length || !interstitialsAddFolderBtn) return;
  const select = document.createElement('select');
  select.id = 'interstitials-source-select';
  select.className = 'btn folder-btn';
  select.title = 'IMPORT FROM SOURCE';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'IMPORT FROM SOURCE…';
  select.appendChild(opt0);
  cachedMediaSourceProviders.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.providerId;
    opt.textContent = p.displayName.toUpperCase();
    select.appendChild(opt);
  });
  select.addEventListener('change', () => {
    const providerId = select.value;
    select.value = '';
    if (providerId) importPoolFromProvider(providerId);
  });
  interstitialsAddFolderBtn.insertAdjacentElement('afterend', select);
}

// A plugin-sourced entry.file/entry.bgFile carries a resolved `title` when
// its provider implements getDisplayName (pickSingleFileFromProvider above)
// — falls back to basenameNoExt(path) same as a local file, which for an
// opaque provider ref (a Drive file id, a Jellyfin item id) with no title
// resolved would otherwise show the raw ref string.
function interstitialFileLabel(file) {
  return file.title || basenameNoExt(file.path);
}

// A small "IMPORT FROM SOURCE" select dropped next to CHOOSE FILE/CHOOSE
// BACKGROUND CLIP — only ever built when at least one provider is active
// (callers already check cachedMediaSourceProviders.length first). Kept as
// its own <select> rather than folding into the CHOOSE FILE button itself,
// same reasoning buildChooseSourceControl (setup-channels.js) has for a
// channel's own folder picker: a single control can't be "a local file
// dialog" and "a themed provider list" at once.
function buildMediaSourcePickButton(onPick) {
  const select = document.createElement('select');
  select.className = 'btn folder-btn';
  select.title = 'IMPORT FROM SOURCE';
  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'FROM SOURCE…';
  select.appendChild(opt0);
  cachedMediaSourceProviders.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.providerId;
    opt.textContent = p.displayName.toUpperCase();
    select.appendChild(opt);
  });
  select.addEventListener('change', () => {
    const providerId = select.value;
    select.value = '';
    if (providerId) onPick(providerId);
  });
  return select;
}

// A folder import's new entries, as one undoable step.
function addPoolEntries(entries) {
  if (!entries.length) return;
  dispatch(entries.map((item) => ({ type: 'item.insert', collection: 'pool', item })),
    { label: `Import ${entries.length} ad pool entr${entries.length === 1 ? 'y' : 'ies'}` });
}

export function renderCommercialsPanel() {
  const cm = S.config.commercials;
  commercialsIntervalEl.value = cm.intervalMinutes || 10;
}

commercialsIntervalEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['commercials', 'intervalMinutes'], value: parsePositiveInt(commercialsIntervalEl.value, 10) });
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
  // A real network's filler for an ad slot with no sold spot — a house PSA
  // or sponsor card, not silently dead air. Opt-in like every other pool
  // entry: it only ever airs where a curator explicitly places one (a flow
  // step, standalone cadence, etc.) — an empty pool still just skips a
  // break entirely (see the mid-show cadence's own "commercials optional"
  // behavior), this is never auto-synthesized.
  { id: 'localAvail', label: 'LOCAL AVAIL / SPONSOR CARD', contentKind: 'text', textPlaceholder: 'THIS TIME PERIOD MADE POSSIBLE BY... (BLANK = AUTO)' },
  // Content shown during a configured preemption window (an absolute
  // real-clock range, edited separately — see buildPreemptionWindowsEditor
  // below — not this pool's usual cadence/affinity matching). channelAffinity/
  // blockAffinity/contentTags still apply normally to narrow WHICH entry
  // plays when more than one is eligible for a given window.
  { id: 'preemption', label: 'PREEMPTION / SPECIAL REPORT', contentKind: 'video' },
  // Nielsen sweeps stunt bumper — fires at ordinary content boundaries
  // during the real US sweeps months (Feb/May/Jul/Nov, isSweepsMonth,
  // interstitials.js), using plain channel/block/tag targeting like
  // upNext, not a special "names a target" shape like promo.
  { id: 'sweepsPromo', label: 'SWEEPS EVENT PROMO', contentKind: 'video' },
];

// Exported so setup-interstitials-flowbuilder.js can label its own tag
// fields with the exact pool-editor label they resolve against (e.g. "matches
// pool: AD POD — BUMP IN") instead of duplicating this lookup table.
export function interstitialTypeDef(type) {
  return INTERSTITIAL_TYPE_DEFS.find((t) => t.id === type) || INTERSTITIAL_TYPE_DEFS[0];
}

// Fixed per-type accent colors (not hash-derived like block/calendar
// colors — there are only 9 types and giving each a stable, memorable color
// makes the pool scannable at a glance once there are dozens of entries).
const TYPE_COLORS = {
  commercial: '#f0b429', channelId: '#6fe0f2', trivia: '#8b93f5', upNext: '#5fd68a',
  adBreakIn: '#e0895f', adBreakOut: '#e0895f', signOff: '#ff6b5b', signOn: '#ff6b5b',
  promo: '#ff9fd6', premiereJingle: '#a3e635', localAvail: '#94a3b8', preemption: '#ff3b3b', sweepsPromo: '#facc15',
};

// A <label>+control pair, stacked — see the .field/.field-label CSS rule's
// own comment for why this replaces relying on placeholder text alone.
// Exported for setup-interstitials-flowbuilder.js, which builds its own
// step-editor form rows the same way.
let fieldLabelId = 0;
export function labeledField(labelText, controlEl, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'field' + (opts && opts.wide ? ' field-span-full' : '');
  const label = document.createElement('span');
  label.className = 'field-label';
  label.textContent = labelText;
  fieldLabelId += 1;
  label.id = `setup-field-label-${fieldLabelId}`;
  wrap.appendChild(label);
  wrap.appendChild(controlEl);
  const controls = controlEl.matches && controlEl.matches('input, select, textarea')
    ? [controlEl]
    : Array.from(controlEl.querySelectorAll ? controlEl.querySelectorAll('input, select, textarea') : []);
  controls.forEach((control) => {
    if (!control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby')) {
      control.setAttribute('aria-labelledby', label.id);
    }
  });
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
// The pool is a list + detail (docs/design/03 §5.3): the list shows every
// entry's summary, the detail pane the selected one's editor.
let selectedPoolEntryId = null;
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

function buildInterstitialThumbnail(entry, typeDef) {
  const file = entry.dynamic ? entry.bgFile : entry.file;
  return buildMediaThumbnail(typeDef.contentKind === 'video' && file ? file.path : null, {
    label: typeDef.label || entry.type || 'AD',
    className: 'interstitial-thumbnail',
  });
}

// detail: build the open editor for the detail pane; otherwise the compact
// summary row for the list.
function buildInterstitialCard(entry, idx, pool, { detail = false } = {}) {
    const typeDef = interstitialTypeDef(entry.type);
    const card = document.createElement('div');
    const isOpen = detail;
    const isSelected = !detail && selectedPoolEntryId === entry.id;
    card.className = 'interstitial-card' + (isOpen ? ' open' : '') + (isSelected ? ' selected' : '');
    card.dataset.itemId = entry.id;
    card.style.borderLeftColor = TYPE_COLORS[entry.type] || 'var(--line)';

    // ---------- Collapsed summary (always visible) ----------
    const summary = document.createElement('div');
    summary.className = 'interstitial-card-summary';
    summary.setAttribute('role', 'button');
    summary.setAttribute('aria-expanded', String(isOpen));
    summary.tabIndex = 0;

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

    summary.appendChild(buildInterstitialThumbnail(entry, typeDef));

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

    const removeEntry = async () => {
      const label = (typeDef && typeDef.label) || entry.type || 'this entry';
      if (!(await confirmDialog(`Remove this ${label} pool entry? You can undo this.`))) return;
      dispatch({ type: 'item.remove', collection: 'pool', id: entry.id });
      if (selectedPoolEntryId === entry.id) selectedPoolEntryId = null;
      renderInterstitialsList();
    };
    if (detail) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn remove-btn';
      removeBtn.textContent = 'REMOVE';
      removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeEntry(); });
      summary.appendChild(removeBtn);
    } else {
      card.dataset.rowMenu = '';
      summary.appendChild(MenuButton({
        label: `Actions for ${title.textContent || 'this entry'}`,
        groups: [
          [{
            label: 'Duplicate',
            run: () => {
              const copy = { ...cloneJson(entry), id: newInterstitialPoolEntry({}).id };
              dispatch({ type: 'item.insert', collection: 'pool', item: copy }, { label: 'Duplicate ad pool entry' });
              selectedPoolEntryId = copy.id;
              renderInterstitialsList();
            },
          }],
          [{ label: 'Remove entry…', run: removeEntry, danger: true }],
        ],
      }).button);
    }

    summary.addEventListener('click', () => {
      if (detail) return;
      selectedPoolEntryId = entry.id;
      justToggledEntryId = entry.id;
      renderInterstitialsList();
      interstitialsListEl.querySelector(`.interstitial-card[data-item-id="${CSS.escape(entry.id)}"] .interstitial-card-summary`)?.focus();
    });
    summary.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === summary) { e.preventDefault(); summary.click(); }
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
      const prior = cloneJson(entry);
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
      commitItemEdit('pool', [entry, prior]);
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
      const prior = cloneJson(entry);
      entry.channelAffinity = channelSelect.value === 'any' ? 'any' : parseInt(channelSelect.value, 10);
      // A block affinity only means something within the channel it was
      // picked from — switching channels drops it rather than carrying a
      // now-meaningless block id along silently.
      entry.blockAffinity = null;
      renderInterstitialsList();
      commitItemEdit('pool', [entry, prior]);
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
      const prior = cloneJson(entry);
      entry.blockAffinity = blockSelect.value === 'any' ? null : blockSelect.value;
      commitItemEdit('pool', [entry, prior]);
    });
    mainGrid.appendChild(labeledField('BLOCK', blockSelect));

    const weightInput = document.createElement('input');
    weightInput.type = 'number';
    weightInput.min = 1;
    weightInput.className = 'block-priority-input';
    weightInput.title = 'How often this entry is picked relative to others';
    weightInput.value = entry.weight || 1;
    weightInput.addEventListener('change', () => {
      const prior = cloneJson(entry);
      entry.weight = parseInt(weightInput.value, 10) || 1;
      commitItemEdit('pool', [entry, prior]);
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
    const deadTagWarning = buildDeadTagWarning(() => entry.contentTags);
    body.appendChild(deadTagWarning.el);

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
        const prior = cloneJson(entry);
        entry.contentTiming = timingSelect.value || null;
        commitItemEdit('pool', [entry, prior]);
      });
      forcedTimingField = labeledField('FORCED TIMING', timingSelect);
      if (entry.contentTags && entry.contentTags.length) {
        secondGrid.appendChild(forcedTimingField);
        secondGridUsed = true;
      }
    }

    tagsInput.addEventListener('change', () => {
      const prior = cloneJson(entry);
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
      deadTagWarning.refresh();
      commitItemEdit('pool', [entry, prior]);
    });

    if (typeDef.needsLeadDays) {
      const leadInput = document.createElement('input');
      leadInput.type = 'number';
      leadInput.min = 0;
      leadInput.className = 'block-priority-input';
      leadInput.title = 'Starts airing this many days before the target block\'s start date';
      leadInput.value = entry.leadDays != null ? entry.leadDays : 7;
      leadInput.addEventListener('change', () => {
        const prior = cloneJson(entry);
        entry.leadDays = parsePositiveInt(leadInput.value, 0);
        commitItemEdit('pool', [entry, prior]);
      });
      secondGrid.appendChild(labeledField('LEAD DAYS', leadInput));
      secondGridUsed = true;
    }

    // Transition timing, all optional and all types — left blank, an entry
    // behaves exactly as before this existed (fadeOutPlayer/fadeInPlayer's
    // own defaults, playback.js). Explicitly setting a field, including 0,
    // opts into a different look (0 = instant hard cut, a real network-style
    // choice, not "unset"). Placeholders show what a real broadcast network
    // cut typically looks like: a snappy fade to black into the break, a
    // slightly slower fade back to content, and a brief held beat between
    // segments rather than an abrupt jump-cut.
    const fadeInInput = document.createElement('input');
    fadeInInput.type = 'number';
    fadeInInput.min = 0;
    fadeInInput.className = 'block-priority-input';
    fadeInInput.title = 'How long this entry fades in from black when it starts. Blank = default.';
    fadeInInput.placeholder = '220';
    fadeInInput.value = entry.fadeInMs != null ? entry.fadeInMs : '';
    fadeInInput.addEventListener('change', () => {
      const prior = cloneJson(entry);
      entry.fadeInMs = fadeInInput.value.trim() === '' ? null : parsePositiveInt(fadeInInput.value, 0);
      commitItemEdit('pool', [entry, prior]);
    });
    secondGrid.appendChild(labeledField('FADE IN (MS, BLANK = DEFAULT)', fadeInInput));

    const fadeOutInput = document.createElement('input');
    fadeOutInput.type = 'number';
    fadeOutInput.min = 0;
    fadeOutInput.className = 'block-priority-input';
    fadeOutInput.title = 'How long this entry fades to black when it ends. Blank = default.';
    fadeOutInput.placeholder = '180';
    fadeOutInput.value = entry.fadeOutMs != null ? entry.fadeOutMs : '';
    fadeOutInput.addEventListener('change', () => {
      const prior = cloneJson(entry);
      entry.fadeOutMs = fadeOutInput.value.trim() === '' ? null : parsePositiveInt(fadeOutInput.value, 0);
      commitItemEdit('pool', [entry, prior]);
    });
    secondGrid.appendChild(labeledField('FADE OUT (MS, BLANK = DEFAULT)', fadeOutInput));

    const waitInput = document.createElement('input');
    waitInput.type = 'number';
    waitInput.min = 0;
    waitInput.className = 'block-priority-input';
    waitInput.title = 'A brief held beat on black after this entry ends, before the next thing starts. Blank = none.';
    waitInput.placeholder = '0';
    waitInput.value = entry.waitMs || '';
    waitInput.addEventListener('change', () => {
      const prior = cloneJson(entry);
      entry.waitMs = parsePositiveInt(waitInput.value, 0);
      commitItemEdit('pool', [entry, prior]);
    });
    secondGrid.appendChild(labeledField('WAIT AFTER (MS, BLANK = NONE)', waitInput));
    secondGridUsed = true;

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
        const prior = cloneJson(entry);
        entry.dynamic = dynamicCheckbox.checked;
        if (entry.dynamic) {
          entry.file = null;
          if (entry.durationS == null) entry.durationS = 15;
        } else {
          entry.bgFile = null;
          entry.text = null;
        }
        renderInterstitialsList();
        commitItemEdit('pool', [entry, prior]);
      });
      dynamicLabel.appendChild(dynamicCheckbox);
      dynamicLabel.appendChild(document.createTextNode('DYNAMIC'));
      body.appendChild(dynamicLabel);

      if (entry.dynamic) {
        const bgBtn = document.createElement('button');
        bgBtn.className = 'btn';
        bgBtn.textContent = entry.bgFile ? interstitialFileLabel(entry.bgFile) : 'CHOOSE BACKGROUND CLIP';
        bgBtn.addEventListener('click', async () => {
          const prior = cloneJson(entry);
          const path = await window.api.selectVideo();
          if (!path) return;
          entry.bgFile = { path, source: 'local' };
          renderInterstitialsList();
          commitItemEdit('pool', [entry, prior]);
        });
        body.appendChild(bgBtn);
        if (cachedMediaSourceProviders.length) {
          body.appendChild(buildMediaSourcePickButton(async (providerId) => {
            const prior = cloneJson(entry);
            const picked = await pickSingleFileFromProvider(providerId);
            if (!picked) return;
            entry.bgFile = picked;
            renderInterstitialsList();
            commitItemEdit('pool', [entry, prior]);
          }));
        }

        const templateInput = document.createElement('input');
        templateInput.type = 'text';
        templateInput.placeholder = '{channel} {time} {nextTitle} {daysUntil} {episodesUntil}';
        templateInput.value = entry.text || '';
        templateInput.addEventListener('input', () => {
          const prior = cloneJson(entry);
          entry.text = templateInput.value;
          commitItemEdit('pool', [entry, prior], { coalesce: `pool:${entry.id}:text` });
        });
        body.appendChild(labeledField('TEMPLATE TEXT', templateInput, { wide: true }));

        const durationInput = document.createElement('input');
        durationInput.type = 'number';
        durationInput.min = 1;
        durationInput.className = 'block-priority-input';
        durationInput.title = 'How long the looping clip+text plays for — a background has no natural length of its own';
        durationInput.value = entry.durationS || 15;
        durationInput.addEventListener('change', () => {
          const prior = cloneJson(entry);
          entry.durationS = parsePositiveInt(durationInput.value, 15);
          commitItemEdit('pool', [entry, prior]);
        });
        secondGrid.appendChild(labeledField('SECONDS', durationInput));
        secondGridUsed = true;
      } else {
        const fileBtn = document.createElement('button');
        fileBtn.className = 'btn';
        fileBtn.textContent = entry.file ? interstitialFileLabel(entry.file) : 'CHOOSE FILE';
        fileBtn.addEventListener('click', async () => {
          const prior = cloneJson(entry);
          const path = await window.api.selectVideo();
          if (!path) return;
          const duration = await probeDuration(path);
          entry.file = { path, source: 'local', duration };
          renderInterstitialsList();
          commitItemEdit('pool', [entry, prior]);
        });
        body.appendChild(fileBtn);
        if (cachedMediaSourceProviders.length) {
          body.appendChild(buildMediaSourcePickButton(async (providerId) => {
            const prior = cloneJson(entry);
            const picked = await pickSingleFileFromProvider(providerId);
            if (!picked) return;
            entry.file = picked;
            renderInterstitialsList();
            commitItemEdit('pool', [entry, prior]);
          }));
        }
      }
    } else {
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.placeholder = typeDef.textPlaceholder || 'TEXT OVERRIDE (BLANK = AUTO)';
      textInput.value = entry.text || '';
      textInput.addEventListener('input', () => {
        const prior = cloneJson(entry);
        entry.text = textInput.value;
        commitItemEdit('pool', [entry, prior], { coalesce: `pool:${entry.id}:text` });
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
      const resolved = await window.api.resolvePlayablePath(f.source || 'local', f.path);
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
  if (interstitialsDetailEl) interstitialsDetailEl.innerHTML = '';
  const pool = S.config.interstitials.pool;
  populateInterstitialsFilterOptions();
  renderInterstitialsBulkBar();

  if (pool.length === 0) {
    interstitialsListEl.appendChild(emptyState('No bumpers or ads yet. Until you add some, station IDs use plain text and breaks stay silent.',
      { label: '+ ADD FROM FOLDER', run: () => document.getElementById('interstitials-add-folder-btn')?.click() }));
    return;
  }

  const groups = groupInterstitialsByChannel(pool);
  if (groups.length === 0) {
    interstitialsListEl.appendChild(emptyState('No entries match the search and filters.', {
      label: 'CLEAR FILTERS',
      run: () => {
        interstitialsSearchEl.value = '';
        interstitialsSearchEl.dispatchEvent(new Event('input', { bubbles: true }));
        interstitialsFilterTypeEl.value = 'any';
        interstitialsFilterTypeEl.dispatchEvent(new Event('change', { bubbles: true }));
        interstitialsFilterChannelEl.value = 'all';
        interstitialsFilterChannelEl.dispatchEvent(new Event('change', { bubbles: true }));
      },
    }));
    return;
  }

  groups.forEach((group) => {
    const collapsed = collapsedInterstitialGroups.has(group.key);
    const header = document.createElement('div');
    header.className = 'interstitials-group-header' + (collapsed ? ' collapsed' : '');
    header.setAttribute('role', 'button');
    header.setAttribute('aria-expanded', String(!collapsed));
    header.tabIndex = 0;
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

    // Selects (or, toggled, deselects) every entry in this one channel
    // group at once — the direct route to "select everything for CH 5" a
    // group header naturally invites, versus the existing global SELECT
    // ALL (which only respects whatever the filter bar happens to be set
    // to right now). Turns on bulk mode automatically if it wasn't already,
    // same as clicking a single entry's own checkbox already does.
    const groupIds = group.items.map(({ entry }) => entry.id);
    const groupAllSelected = groupIds.every((id) => selectedInterstitialEntries.has(id));
    const selectGroupBtn = document.createElement('button');
    selectGroupBtn.className = 'btn interstitials-group-select-btn';
    selectGroupBtn.textContent = groupAllSelected ? 'DESELECT ALL IN GROUP' : `SELECT ALL IN GROUP (${groupIds.length})`;
    selectGroupBtn.title = 'Select (or deselect) every entry in this channel group for a bulk action below — channel/tag apply, remove, etc.';
    selectGroupBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!interstitialsBulkMode) {
        interstitialsBulkMode = true;
        interstitialsBulkToggleBtn.classList.add('active');
        interstitialsBulkToggleBtn.textContent = 'DONE SELECTING';
      }
      if (groupAllSelected) groupIds.forEach((id) => selectedInterstitialEntries.delete(id));
      else groupIds.forEach((id) => selectedInterstitialEntries.add(id));
      renderInterstitialsList();
    });
    header.appendChild(selectGroupBtn);

    header.addEventListener('click', () => {
      if (collapsedInterstitialGroups.has(group.key)) collapsedInterstitialGroups.delete(group.key);
      else collapsedInterstitialGroups.add(group.key);
      renderInterstitialsList();
    });
    header.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === header) { e.preventDefault(); header.click(); }
    });
    interstitialsListEl.appendChild(header);

    if (collapsed) return;
    group.items.forEach(({ entry, idx }) => {
      interstitialsListEl.appendChild(buildInterstitialCard(entry, idx, pool));
    });
  });

  // The detail pane: the selected entry, or the first one the filters show.
  const visible = groups.flatMap((group) => group.items);
  let selected = pool.findIndex((entry) => entry.id === selectedPoolEntryId);
  // A filter that hides the selected entry moves the selection to what it shows.
  if (visible.length && (selected === -1 || !visible.some((item) => item.entry.id === selectedPoolEntryId))) {
    selectedPoolEntryId = visible[0].entry.id;
    selected = visible[0].idx;
    interstitialsListEl.querySelector(`.interstitial-card[data-item-id="${CSS.escape(selectedPoolEntryId)}"]`)?.classList.add('selected');
  }
  if (interstitialsDetailEl && selected !== -1) {
    const detailCard = buildInterstitialCard(pool[selected], selected, pool, { detail: true });
    keepListRowInStep(detailCard, interstitialsListEl, () => {
      const index = pool.indexOf(pool.find((entry) => entry.id === selectedPoolEntryId));
      return index === -1 ? null : buildInterstitialCard(pool[index], index, pool);
    });
    interstitialsDetailEl.appendChild(detailCard);
  }
}

// An edit in a detail pane changes what its list row summarizes (weight,
// title, tags); rebuild just that row, leaving the editor and its focus alone.
function keepListRowInStep(detailCard, listEl, buildRow) {
  const refresh = () => {
    const id = detailCard.dataset.itemId;
    const current = listEl.querySelector(`.interstitial-card[data-item-id="${CSS.escape(id)}"]`);
    const next = buildRow();
    if (current && next) current.replaceWith(next);
  };
  detailCard.addEventListener('change', refresh);
  detailCard.addEventListener('input', debounce(refresh, 250));
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
  const targets = selectedInterstitialEntryObjs();
  const priors = targets.map((entry) => [entry, cloneJson(entry)]);
  targets.forEach((entry) => {
    entry.channelAffinity = channelAffinity;
    entry.blockAffinity = null; // stale once the channel changes — see the single-entry channelSelect handler above
  });
  if (priors.length) commitItemEdit('pool', priors, { label: `Set channel for ${priors.length} ad pool entr${priors.length === 1 ? 'y' : 'ies'}` });
  renderInterstitialsList();
});

interstitialsBulkTagApplyBtn.addEventListener('click', () => {
  const tag = interstitialsBulkTagInputEl.value.trim().toLowerCase();
  if (!tag) return;
  const targets = selectedInterstitialEntryObjs();
  const priors = targets.map((entry) => [entry, cloneJson(entry)]);
  targets.forEach((entry) => {
    const tags = new Set(entry.contentTags || []);
    tags.add(tag);
    entry.contentTags = Array.from(tags);
  });
  if (priors.length) commitItemEdit('pool', priors, { label: `Tag ${priors.length} ad pool entr${priors.length === 1 ? 'y' : 'ies'}` });
  interstitialsBulkTagInputEl.value = '';
  renderInterstitialsList();
});

interstitialsBulkRemoveBtn.addEventListener('click', async () => {
  const targets = selectedInterstitialEntryObjs();
  if (!targets.length) return;
  if (!(await confirmDialog(`Remove ${targets.length} selected pool entr${targets.length === 1 ? 'y' : 'ies'}? You can undo this.`))) return;
  dispatch(targets.map((e) => ({ type: 'item.remove', collection: 'pool', id: e.id })),
    { label: `Remove ${targets.length} ad pool entr${targets.length === 1 ? 'y' : 'ies'}` });
  selectedInterstitialEntries.clear();
  renderInterstitialsList();
});

interstitialsAddEntryBtn.addEventListener('click', () => {
  const entry = newInterstitialPoolEntry({});
  dispatch({ type: 'item.insert', collection: 'pool', item: entry });
  selectedPoolEntryId = entry.id; // open it straight away — a fresh entry has nothing worth summarizing yet
  renderInterstitialsList();
});

interstitialsAddFolderBtn.addEventListener('click', async () => {
  const folder = await window.api.selectFolder();
  if (!folder) return;

  scanProgressEl.classList.remove('hidden');
  scanProgressEl.textContent = 'SCANNING INTERSTITIALS FOLDER…';
  const paths = await window.api.scanFolder('local', folder);
  scanProgressEl.classList.add('hidden');
  if (!paths || !paths.length) {
    scanProgressEl.classList.remove('hidden');
    scanProgressEl.textContent = 'NO VIDEO FILES FOUND IN THAT FOLDER';
    setTimeout(() => scanProgressEl.classList.add('hidden'), 2500);
    return;
  }
  const options = await promptBatchImportOptions(paths.length);
  if (!options) return;
  scanProgressEl.classList.remove('hidden');
  const added = [];
  for (let i = 0; i < paths.length; i++) {
    scanProgressEl.textContent = `PROBING ${i + 1} / ${paths.length}…`;
    // eslint-disable-next-line no-await-in-loop
    const duration = await probeDuration(paths[i]);
    added.push(newInterstitialPoolEntry({
      file: { path: paths[i], source: 'local', duration },
      type: options.type,
      channelAffinity: options.channelAffinity,
      contentTags: options.contentTags,
    }));
  }
  scanProgressEl.classList.add('hidden');
  addPoolEntries(added);
  renderInterstitialsList();
});

// AD PRESETS — named break layouts targeted at tagged content (see the
// TITLES tab's per-file tags field), specific channels, or both — an
// alternative to scoping a break structure via a channel or block's own
// commercials override. Each preset is a `commercials`-shaped object (same
// timing/intervalMinutes/breakpoints/podMin/podMax fields resolveBreakAt
// already reads off a channel or block's own commercials config — see
// resolveActiveCommercials, schedule.js) plus channels + contentTags + a
// name, so it's a drop-in match for the exact same resolution code with zero
// special-casing at playback time.
function randomPresetId() {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function freshPreset() {
  return {
    id: randomPresetId(), name: '', enabled: true, channels: [], contentTags: [],
    timing: 'interval', intervalMinutes: null, breakpoints: null, podMin: 1, podMax: 1,
  };
}

// Same ephemeral-UI-state treatment as the pool's filter/expand state above.
let presetsSearchText = '';
// Presets used to always render fully expanded — fine for a handful, but
// unreadable once there are a couple dozen. Now default-collapsed to a
// one-line summary, same as pool entries.
// Presets are a list + detail too (see selectedPoolEntryId).
let selectedPresetId = null;
// Same scoping as justToggledEntryId above — only an actual click plays the
// reveal, not a search-driven rebuild.
let justToggledPresetId = null;

function presetMatchesSearch(preset) {
  if (!presetsSearchText) return true;
  const haystack = [preset.name, ...(preset.contentTags || [])].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(presetsSearchText);
}

function buildPresetRow(preset, idx, presets, { detail = false } = {}) {
  const isOpen = detail;
  const card = document.createElement('div');
  card.className = 'interstitial-card' + (isOpen ? ' open' : '') + (!detail && selectedPresetId === preset.id ? ' selected' : '');
  card.dataset.itemId = preset.id;
  card.style.borderLeftColor = 'var(--gold)';

  const header = document.createElement('div');
  header.className = 'interstitial-card-summary';
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', String(isOpen));
  header.tabIndex = 0;

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
    const prior = cloneJson(preset);
    preset.enabled = enabledCheckbox.checked;
    commitItemEdit('presets', [preset, prior]);
  });
  enabledLabel.appendChild(enabledCheckbox);
  header.appendChild(enabledLabel);

  const title = document.createElement('span');
  title.className = 'interstitial-card-title';
  title.textContent = preset.name && preset.name.trim() ? preset.name : '(untitled preset)';
  header.appendChild(title);

  if (preset.channels && preset.channels.length) {
    const chWrap = document.createElement('span');
    chWrap.className = 'interstitial-card-tags';
    preset.channels.slice(0, 3).forEach((num) => {
      const chip = document.createElement('span');
      chip.className = 'interstitial-tag-chip';
      chip.textContent = `CH ${String(num).padStart(2, '0')}`;
      chWrap.appendChild(chip);
    });
    header.appendChild(chWrap);
  }

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

  const removePreset = async () => {
    if (!(await confirmDialog(`Remove the "${preset.name || 'untitled'}" ad preset? You can undo this.`))) return;
    dispatch({ type: 'item.remove', collection: 'presets', id: preset.id });
    if (selectedPresetId === preset.id) selectedPresetId = null;
    renderPresetsList();
  };
  if (detail) {
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn remove-btn';
    removeBtn.textContent = 'REMOVE';
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removePreset(); });
    header.appendChild(removeBtn);
  } else {
    card.dataset.rowMenu = '';
    header.appendChild(MenuButton({
      label: `Actions for ${preset.name || 'untitled preset'}`,
      groups: [
        [{
          label: 'Duplicate',
          run: () => {
            const copy = { ...cloneJson(preset), id: freshPreset().id, name: `${preset.name || 'Untitled'} copy` };
            dispatch({ type: 'item.insert', collection: 'presets', item: copy }, { label: 'Duplicate ad preset' });
            selectedPresetId = copy.id;
            renderPresetsList();
          },
        }],
        [{ label: 'Remove preset…', run: removePreset, danger: true }],
      ],
    }).button);
  }

  header.addEventListener('click', () => {
    if (detail) return;
    selectedPresetId = preset.id;
    justToggledPresetId = preset.id;
    renderPresetsList();
    presetsListEl.querySelector(`.interstitial-card[data-item-id="${CSS.escape(preset.id)}"] .interstitial-card-summary`)?.focus();
  });
  header.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === header) { e.preventDefault(); header.click(); }
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
    const prior = cloneJson(preset);
    preset.name = nameInput.value;
    title.textContent = preset.name && preset.name.trim() ? preset.name : '(untitled preset)';
    commitItemEdit('presets', [preset, prior], { coalesce: `presets:${preset.id}:name` });
  });
  body.appendChild(labeledField('PRESET NAME', nameInput, { wide: true }));

  const channelsContainer = document.createElement('div');
  const chSelect = document.createElement('select');
  chSelect.className = 'block-hour-select flow-select';
  chSelect.setAttribute('aria-label', 'Target channels');

  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'ALL CHANNELS';
  chSelect.appendChild(optAll);

  sortedChannels().forEach((c) => {
    const opt = document.createElement('option');
    opt.value = String(c.number);
    opt.textContent = `CH ${formatChannelNumber(c.number)} ${c.name || 'UNTITLED'}`;
    chSelect.appendChild(opt);
  });

  const pillsWrap = document.createElement('div');
  pillsWrap.className = 'flow-channel-pills-wrap';

  const renderChannelPills = () => {
    pillsWrap.innerHTML = '';
    const selected = preset.channels || [];
    if (!selected.length) {
      const badge = document.createElement('span');
      badge.className = 'flow-channel-pill all-chs';
      badge.textContent = '🌐 ALL CHANNELS';
      pillsWrap.appendChild(badge);
    } else {
      selected.forEach((num) => {
        const chObj = getChannel(num);
        const pill = document.createElement('span');
        pill.className = 'flow-channel-pill';
        pill.textContent = `CH ${String(num).padStart(2, '0')}${chObj && chObj.name ? ' (' + chObj.name + ')' : ''} `;
        const removeBtn = document.createElement('span');
        removeBtn.className = 'pill-remove';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', (e) => {
          const prior = cloneJson(preset);
          e.stopPropagation();
          preset.channels = preset.channels.filter((n) => n !== num);
          renderChannelPills();
          commitItemEdit('presets', [preset, prior]);
        });
        pill.appendChild(removeBtn);
        pillsWrap.appendChild(pill);
      });
    }
  };

  chSelect.addEventListener('change', () => {
    const prior = cloneJson(preset);
    const val = chSelect.value;
    if (val === 'all') {
      preset.channels = [];
    } else {
      const num = parseInt(val, 10);
      if (!preset.channels) preset.channels = [];
      if (!preset.channels.includes(num)) {
        preset.channels.push(num);
      }
    }
    chSelect.value = 'all';
    renderChannelPills();
    commitItemEdit('presets', [preset, prior]);
  });

  renderChannelPills();
  channelsContainer.appendChild(chSelect);
  channelsContainer.appendChild(pillsWrap);
  body.appendChild(labeledField('APPLIES TO CHANNELS', channelsContainer, { wide: true }));

  const tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.className = 'title-row-input';
  tagsInput.placeholder = 'e.g. cartoon, cartoon-30';
  tagsInput.value = (preset.contentTags || []).join(', ');
  const presetDeadTagWarning = buildDeadTagWarning(() => preset.contentTags);
  tagsInput.addEventListener('change', () => {
    const prior = cloneJson(preset);
    const tags = tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    preset.contentTags = tags;
    presetDeadTagWarning.refresh();
    commitItemEdit('presets', [preset, prior]);
  });
  body.appendChild(labeledField('APPLIES TO CONTENT TAGGED (BLANK = ANY)', attachTagAutocomplete(tagsInput), { wide: true }));
  body.appendChild(presetDeadTagWarning.el);

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
    const prior = cloneJson(preset);
    preset.timing = timingSelect.value;
    renderPresetsList();
    commitItemEdit('presets', [preset, prior]);
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
      const prior = cloneJson(preset);
      preset.intervalMinutes = parsePositiveInt(intervalInput.value, null);
      commitItemEdit('presets', [preset, prior]);
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
      const prior = cloneJson(preset);
      const pts = bpInput.value.split(',')
        .map((v) => parseFloat(v.trim()))
        .filter((v) => Number.isFinite(v) && v > 0 && v < 100);
      preset.breakpoints = pts.length ? pts : null;
      commitItemEdit('presets', [preset, prior]);
      renderPresetsList(); // re-syncs the drag track below to whatever was just typed
    });
    grid.appendChild(labeledField('BREAK POINTS (%)', bpInput));
    const track = buildBreakpointTrack(
      () => preset.breakpoints,
      (pts) => {
        preset.breakpoints = pts;
        commitInPlace({ type: 'item.set', collection: 'presets', id: preset.id, fields: { breakpoints: pts } }, { coalesce: `presets:${preset.id}:breakpoints` });
      },
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
    const prior = cloneJson(preset);
    preset.podMin = parsePositiveInt(podMinInput.value, 1);
    if ((preset.podMax || 1) < preset.podMin) {
      preset.podMax = preset.podMin;
      podMaxInput.value = preset.podMax;
    }
    podMaxInput.min = preset.podMin;
    commitItemEdit('presets', [preset, prior]);
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
    const prior = cloneJson(preset);
    preset.podMax = Math.max(parsePositiveInt(podMaxInput.value, 1), preset.podMin || 1);
    podMaxInput.value = preset.podMax;
    commitItemEdit('presets', [preset, prior]);
  });
  podRow.appendChild(podMaxInput);
  grid.appendChild(labeledField('SPOTS PER BREAK', podRow));

  body.appendChild(grid);
  card.appendChild(body);
  return card;
}

export function renderPresetsList() {
  presetsListEl.innerHTML = '';
  if (presetsDetailEl) presetsDetailEl.innerHTML = '';
  const presets = S.config.interstitials.presets;
  if (!presets.length) {
    presetsListEl.appendChild(emptyState('No ad presets yet. Every show uses its own channel\'s ad settings.',
      { label: '+ ADD PRESET', run: () => presetsAddBtn.click() }));
    return;
  }
  const visible = presets
    .map((preset, idx) => ({ preset, idx }))
    .filter(({ preset }) => presetMatchesSearch(preset));
  if (!visible.length) {
    presetsListEl.appendChild(emptyState('No presets match that search.', {
      label: 'CLEAR SEARCH',
      run: () => { presetsSearchEl.value = ''; presetsSearchEl.dispatchEvent(new Event('input', { bubbles: true })); presetsSearchEl.focus(); },
    }));
    return;
  }
  visible.forEach(({ preset, idx }) => {
    presetsListEl.appendChild(buildPresetRow(preset, idx, presets));
  });
  let selected = presets.findIndex((preset) => preset.id === selectedPresetId);
  if (selected === -1 || !visible.some((item) => item.preset.id === selectedPresetId)) {
    selectedPresetId = visible[0].preset.id;
    selected = visible[0].idx;
    presetsListEl.querySelector(`.interstitial-card[data-item-id="${CSS.escape(selectedPresetId)}"]`)?.classList.add('selected');
  }
  if (presetsDetailEl) {
    const detailCard = buildPresetRow(presets[selected], selected, presets, { detail: true });
    keepListRowInStep(detailCard, presetsListEl, () => {
      const index = presets.findIndex((preset) => preset.id === selectedPresetId);
      return index === -1 ? null : buildPresetRow(presets[index], index, presets);
    });
    presetsDetailEl.appendChild(detailCard);
  }
}

const debouncedRenderPresetsList = debounce(() => renderPresetsList(), 150);
presetsSearchEl.addEventListener('input', () => {
  presetsSearchText = presetsSearchEl.value.trim().toLowerCase();
  debouncedRenderPresetsList();
});


presetsAddBtn.addEventListener('click', () => {
  const preset = freshPreset();
  dispatch({ type: 'item.insert', collection: 'presets', item: preset });
  selectedPresetId = preset.id; // open it straight away — a fresh preset has nothing worth summarizing yet
  renderPresetsList();
});

// Rebuilt each time the setup screen shows, same as renderLogoBugEditor/
// renderDynamicOverlaysEditor (setup-settings.js) — this editor only
// mutates the array it's handed, it doesn't re-read S.config on its own.
export function renderPreemptionWindowsEditor() {
  if (!preemptionWindowsEditorEl) return;
  preemptionWindowsEditorEl.innerHTML = '';
  preemptionWindowsEditorEl.appendChild(buildPreemptionWindowsEditor(
    () => S.config.preemptionWindows,
    (windows) => {
      S.config.preemptionWindows = windows;
      commitInPlace({ type: 'settings.set', path: ['preemptionWindows'], value: windows }, { coalesce: 'preemptionWindows' });
    },
  ));
}

export function renderStandbyPanel() {
  const sb = S.config.autoStandby;
  standbyEnabledEl.checked = !!sb.enabled;
  standbyIntervalEl.value = sb.intervalMinutes || 15;
}

standbyEnabledEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['autoStandby', 'enabled'], value: standbyEnabledEl.checked });
});

standbyIntervalEl.addEventListener('change', () => {
  dispatch({ type: 'settings.set', path: ['autoStandby', 'intervalMinutes'], value: parsePositiveInt(standbyIntervalEl.value, 15) });
});

