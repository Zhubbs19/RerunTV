// PROGRAMMING > AUTO-CURATE — the wizard around the curation engine
// (curation.js). Lets the user save a themed profile, preview what it would
// generate (with a "Reshuffle" to re-roll the same profile deterministically),
// and only writes to S.config on an explicit APPLY — which is then just a
// normal config mutation, so it's covered by the existing undo stack
// (state.js) with no special-casing needed here. A profile can also be
// pointed at recurring background curation instead (regenerationMode:
// 'scheduled') — see curation-scheduler.js for that path, which skips the
// preview step entirely and auto-applies.
import { freshCurationProfile, freshDayPartSlot, sortedChannels } from '../core/channels.js';
import { applyCurationProposal, curateChannel } from '../library/curation.js';
import { S, commitConfigPatch } from '../core/state.js';
import { deepClone } from '../core/util.js';
import { attachTagAutocomplete } from './util.js';
import { alertDialog, confirmDialog } from './dialogs.js';
import { autocurateRootEl } from '../core/dom.js';
import { renderChannelList } from './channels.js';
import { labeledField, renderInterstitialsList } from './interstitials.js';

// Ephemeral UI-only state — same lifetime as the search/filter state other
// PROGRAMMING sub-tabs keep, resets on app restart.
let editingProfile = null; // a working CLONE open in the inline editor, or null — never the live S.config object; see ensureSaved()
let editingProfileOriginal = null; // the live S.config.curationProfiles entry editingProfile was cloned from, or null for a not-yet-saved new profile
let isNewProfile = false; // editingProfile hasn't been pushed to S.config.curationProfiles yet
let previewProposal = null; // last curateChannel() result for editingProfile, or null
let previewSeed = 0;
let editingProfileBaseline = ''; // JSON of editingProfile as opened/last saved — CLOSE compares against it to spot unsaved edits

// Profiles saved by an older build can lack whole sub-objects the editor reads
// unguarded (themeSeeds.genre, contentPoolScope.folders, dayPartTemplate.length).
function withProfileDefaults(profile) {
  const defaults = freshCurationProfile();
  profile.themeSeeds = { ...defaults.themeSeeds, ...(profile.themeSeeds || {}) };
  profile.contentPoolScope = { ...defaults.contentPoolScope, ...(profile.contentPoolScope || {}) };
  if (!Array.isArray(profile.dayPartTemplate)) profile.dayPartTemplate = [];
  if (!Array.isArray(profile.bumperStyleTags)) profile.bumperStyleTags = [];
  return profile;
}

// De-duped by id (a folder scanned into more than one channel — same
// physical path, same content-derived id, see mediaRefId in channels.js —
// only needs to appear once in the scope picker).
function allKnownFolders() {
  const byId = new Map();
  sortedChannels().forEach((ch) => (ch.folders || []).forEach((e) => { if (!byId.has(e.id)) byId.set(e.id, e); }));
  return Array.from(byId.values()).sort((a, b) => (a.label || a.ref).localeCompare(b.label || b.ref));
}

// A comma-separated tag-style input wired to autocomplete, wrapping an
// array field on the given object — same shape as the TITLES tab's own tag
// inputs (setup-panels.js), just generalized to any array field here since
// a profile has four of them (genre/era/mood/contentType theme seeds, plus
// bumper style tags).
function tagListInput(placeholder, initial, onChange) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'title-row-input';
  input.placeholder = placeholder;
  input.value = (initial || []).join(', ');
  input.addEventListener('change', () => {
    onChange(input.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean));
  });
  return attachTagAutocomplete(input);
}

// Writes a snapshot of the (working-clone) profile into S.config, either as
// a new entry or replacing the entry it was opened from — the only point
// where an edit actually reaches S.config, matching this file's header
// comment. Every field handler in buildProfileEditor() mutates `profile`
// (editingProfile, a clone made when the editor was opened — see the EDIT
// button and "+ NEW PROFILE" handlers below) directly and immediately, but
// that clone is never the object stored in S.config.curationProfiles, so
// those in-progress edits are invisible to the rest of the app — including
// this function's own caller, still holding a live reference to
// editingProfile — until SAVE PROFILE/APPLY calls this. Stores a fresh
// clone rather than `profile` itself so continuing to edit afterward keeps
// mutating only the open working copy, not the just-saved config entry.
function ensureSaved(profile) {
  const stored = deepClone(profile);
  if (isNewProfile) {
    S.config.curationProfiles.push(stored);
    isNewProfile = false;
  } else if (editingProfileOriginal) {
    const idx = S.config.curationProfiles.indexOf(editingProfileOriginal);
    if (idx !== -1) S.config.curationProfiles[idx] = stored;
  }
  editingProfileOriginal = stored;
  editingProfileBaseline = JSON.stringify(profile);
}

function buildFolderScopeEditor(profile) {
  const allFolders = allKnownFolders();
  const wrap = document.createElement('div');
  wrap.className = 'title-row-facets';
  if (!allFolders.length) {
    const note = document.createElement('span');
    note.className = 'panel-status';
    note.textContent = 'No folders scanned into any channel yet — this profile will draw from every file, once you have some.';
    wrap.appendChild(note);
    return wrap;
  }
  const allIds = allFolders.map((e) => e.id);
  allFolders.forEach((entry) => {
    const label = document.createElement('label');
    label.className = 'shuffle-toggle';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    const scoped = Array.isArray(profile.contentPoolScope.folders);
    cb.checked = !scoped || profile.contentPoolScope.folders.includes(entry.id);
    cb.addEventListener('change', () => {
      const current = Array.isArray(profile.contentPoolScope.folders)
        ? profile.contentPoolScope.folders.slice() : allIds.slice();
      const idx = current.indexOf(entry.id);
      if (cb.checked && idx === -1) current.push(entry.id);
      if (!cb.checked && idx !== -1) current.splice(idx, 1);
      profile.contentPoolScope.folders = current.length >= allIds.length ? 'all' : current;
    });
    label.appendChild(cb);
    const display = entry.label || entry.ref;
    label.appendChild(document.createTextNode(display.split(/[\\/]/).pop() || display));
    wrap.appendChild(label);
  });
  return wrap;
}

// contentPoolScope.tags is 'any' (unscoped, the default) or an explicit
// array a file must carry at least one of (curation.js's poolScope) — same
// shape as contentPoolScope.folders' 'all'/array pair just above.
function buildTagScopeInput(profile) {
  return tagListInput(
    'CONTENT MUST CARRY ONE OF THESE TAGS (BLANK = ANY)',
    Array.isArray(profile.contentPoolScope.tags) ? profile.contentPoolScope.tags : [],
    (v) => { profile.contentPoolScope.tags = v.length ? v : 'any'; },
  );
}

function buildHourSelect(value, onChange) {
  const select = document.createElement('select');
  select.className = 'block-hour-select';
  for (let h = 0; h < 24; h++) {
    const opt = document.createElement('option');
    opt.value = String(h);
    opt.textContent = `${String(h).padStart(2, '0')}:00`;
    select.appendChild(opt);
  }
  select.value = String(value);
  select.addEventListener('change', () => onChange(Number(select.value)));
  return select;
}

// The optional dayPartTemplate — a list of themed hour ranges the engine
// carves out as their own ch.blocks[] on top of the profile's flat
// whole-channel pool (curateChannel/buildDayPartPlan, curation.js). Empty
// by default: the profile behaves exactly as before until a slot is added.
function buildDayPartEditor(profile) {
  const wrap = document.createElement('div');
  wrap.className = 'daypart-slot-list';

  function render() {
    wrap.innerHTML = '';
    if (!profile.dayPartTemplate.length) {
      const note = document.createElement('div');
      note.className = 'panel-status';
      note.textContent = 'No day-part slots — this profile curates one flat rotation for the whole channel. Add a slot to carve out a themed hour range (e.g. "6am–9am, cartoons") as its own block instead.';
      wrap.appendChild(note);
    }
    profile.dayPartTemplate.forEach((slot) => {
      const row = document.createElement('div');
      row.className = 'daypart-slot-row';

      const labelInput = document.createElement('input');
      labelInput.type = 'text';
      labelInput.className = 'title-row-input';
      labelInput.placeholder = 'SLOT LABEL (E.G. SATURDAY MORNING CARTOONS)';
      labelInput.value = slot.label || '';
      labelInput.addEventListener('input', () => { slot.label = labelInput.value; });

      const startSelect = buildHourSelect(slot.startHour, (h) => { slot.startHour = h; });
      const endSelect = buildHourSelect(slot.endHour, (h) => { slot.endHour = h; });

      const contentTypeSelect = document.createElement('select');
      contentTypeSelect.className = 'block-hour-select';
      [['', 'CONTENT TYPE (INHERIT)'], ['show', 'SHOW'], ['movie', 'MOVIE'], ['short', 'SHORT'], ['promo', 'PROMO'], ['bumper', 'BUMPER']]
        .forEach(([value, label]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          contentTypeSelect.appendChild(opt);
        });
      contentTypeSelect.value = slot.contentType || '';
      contentTypeSelect.addEventListener('change', () => { slot.contentType = contentTypeSelect.value || null; });

      const genreWrap = tagListInput('GENRE OVERRIDE (BLANK = INHERIT)', slot.genre, (v) => { slot.genre = v; });

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn remove-btn';
      removeBtn.textContent = 'REMOVE';
      removeBtn.addEventListener('click', () => {
        const idx = profile.dayPartTemplate.indexOf(slot);
        if (idx !== -1) profile.dayPartTemplate.splice(idx, 1);
        render();
      });

      row.appendChild(labelInput);
      row.appendChild(startSelect);
      row.appendChild(document.createTextNode('–'));
      row.appendChild(endSelect);
      row.appendChild(contentTypeSelect);
      row.appendChild(genreWrap);
      row.appendChild(removeBtn);
      wrap.appendChild(row);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn';
    addBtn.style.alignSelf = 'flex-start'; // .daypart-slot-list is a flex column (stretch by default) — slot rows want full width, this button doesn't
    addBtn.textContent = '+ ADD SLOT';
    addBtn.addEventListener('click', () => {
      profile.dayPartTemplate.push(freshDayPartSlot());
      render();
    });
    wrap.appendChild(addBtn);
  }

  render();
  return wrap;
}

// A full-width divider/heading between groups of fields — plain
// .interstitial-card/.interstitial-card-body has no such convention since a
// pool/preset card is small enough not to need one; this editor grew past
// that size across three phases.
function sectionLabel(text) {
  const el = document.createElement('div');
  el.className = 'autocurate-section-label';
  el.textContent = text;
  return el;
}

function buildProfileEditor(profile) {
  const wrap = document.createElement('div');
  wrap.className = 'interstitial-card open autocurate-card-body';
  wrap.style.borderLeftColor = 'var(--gold)';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'title-row-input';
  nameInput.placeholder = 'PROFILE NAME (ALSO USED AS THE CHANNEL NAME)';
  nameInput.value = profile.name || '';
  nameInput.addEventListener('input', () => { profile.name = nameInput.value; });

  const targetSelect = document.createElement('select');
  targetSelect.className = 'block-hour-select';
  const newOpt = document.createElement('option');
  newOpt.value = '';
  newOpt.textContent = 'CREATE NEW CHANNEL';
  targetSelect.appendChild(newOpt);
  sortedChannels().forEach((ch) => {
    const opt = document.createElement('option');
    opt.value = String(ch.number);
    opt.textContent = `CH ${ch.number} — ${ch.name || '(untitled)'}`;
    targetSelect.appendChild(opt);
  });
  targetSelect.value = profile.targetChannel != null ? String(profile.targetChannel) : '';
  targetSelect.addEventListener('change', () => {
    profile.targetChannel = targetSelect.value ? Number(targetSelect.value) : null;
  });

  const genreInput = tagListInput('GENRE SEED(S)', profile.themeSeeds.genre, (v) => { profile.themeSeeds.genre = v; });
  const eraInput = tagListInput('ERA/DECADE SEED(S)', profile.themeSeeds.era, (v) => { profile.themeSeeds.era = v; });
  const moodInput = tagListInput('MOOD SEED(S)', profile.themeSeeds.mood, (v) => { profile.themeSeeds.mood = v; });
  const contentTypeInput = tagListInput('CONTENT TYPE SEED(S)', profile.themeSeeds.contentType, (v) => { profile.themeSeeds.contentType = v; });

  const adPresetSelect = document.createElement('select');
  adPresetSelect.className = 'block-hour-select';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'NO AD PRESET (BOX DEFAULT TIMING)';
  adPresetSelect.appendChild(noneOpt);
  (S.config.interstitials.presets || []).forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name && p.name.trim() ? p.name : '(untitled preset)';
    adPresetSelect.appendChild(opt);
  });
  adPresetSelect.value = profile.adDensity || '';
  adPresetSelect.addEventListener('change', () => { profile.adDensity = adPresetSelect.value || null; });

  const bumperTagsInput = tagListInput('BUMPER/STATION-ID STYLE TAG(S)', profile.bumperStyleTags, (v) => { profile.bumperStyleTags = v; });

  // Scheduled (auto-apply, no review) only makes sense against an existing
  // channel — a "CREATE NEW CHANNEL" target run on a recurring schedule
  // would spawn a fresh empty channel every interval forever, since there's
  // no "already created" state to check against. So SCHEDULED is only
  // selectable once a real target channel is chosen, and switching the
  // target back to "CREATE NEW CHANNEL" silently falls the profile back to
  // MANUAL rather than leaving a schedule pointed at nothing.
  const intervalSelect = document.createElement('select');
  intervalSelect.className = 'block-hour-select';
  [['daily', 'DAILY'], ['weekly', 'WEEKLY'], ['monthly', 'MONTHLY']].forEach(([value, label]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    intervalSelect.appendChild(opt);
  });
  intervalSelect.value = profile.scheduleInterval || 'weekly';
  intervalSelect.addEventListener('change', () => { profile.scheduleInterval = intervalSelect.value; });

  const regenSelect = document.createElement('select');
  regenSelect.className = 'block-hour-select';
  const manualOpt = document.createElement('option');
  manualOpt.value = 'manual';
  manualOpt.textContent = 'MANUAL (PREVIEW + APPLY BY HAND)';
  regenSelect.appendChild(manualOpt);
  const scheduledOpt = document.createElement('option');
  scheduledOpt.value = 'scheduled';
  scheduledOpt.textContent = 'SCHEDULED (AUTO-APPLIES, NO REVIEW)';
  regenSelect.appendChild(scheduledOpt);

  function refreshRegenAvailability() {
    const hasTarget = !!targetSelect.value;
    scheduledOpt.disabled = !hasTarget;
    if (!hasTarget && profile.regenerationMode === 'scheduled') profile.regenerationMode = 'manual';
    regenSelect.value = profile.regenerationMode === 'scheduled' ? 'scheduled' : 'manual';
    intervalSelect.parentElement.classList.toggle('hidden', profile.regenerationMode !== 'scheduled');
  }
  regenSelect.addEventListener('change', () => {
    profile.regenerationMode = regenSelect.value;
    refreshRegenAvailability();
  });
  targetSelect.addEventListener('change', refreshRegenAvailability);

  const previewBtn = document.createElement('button');
  previewBtn.type = 'button';
  previewBtn.className = 'btn';
  previewBtn.textContent = previewProposal ? 'RE-PREVIEW' : 'PREVIEW';
  previewBtn.addEventListener('click', () => {
    previewSeed += 1;
    previewProposal = curateChannel(profile, previewSeed);
    renderAutoCurateList();
  });

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn';
  saveBtn.textContent = 'SAVE PROFILE';
  saveBtn.addEventListener('click', () => {
    if (!profile.name || !profile.name.trim()) { alertDialog('Give this profile a name first.'); return; }
    ensureSaved(profile);
    commitConfigPatch('Save curation profile');
    renderAutoCurateList();
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn remove-btn';
  cancelBtn.textContent = 'CLOSE';
  cancelBtn.addEventListener('click', async () => {
    if (editingProfile && JSON.stringify(editingProfile) !== editingProfileBaseline
      && !(await confirmDialog({ title: 'DISCARD CHANGES?', message: 'This profile has edits that were not saved. Closing the editor throws them away.', confirmText: 'DISCARD', danger: true }))) return;
    // editingProfile is only ever a working clone (see ensureSaved()'s
    // comment) — discarding it here without saving is a real, working
    // revert, not just clearing the editor's own reference.
    editingProfile = null;
    editingProfileOriginal = null;
    isNewProfile = false;
    previewProposal = null;
    renderAutoCurateList();
  });

  // Split into labeled sections instead of one long undifferentiated grid —
  // the editor grew to 11 fields across three phases, and grouping them by
  // what they actually configure (identity / theme / content pool / ads &
  // bumpers / automation) is what makes that scannable instead of a wall
  // of identical-looking inputs.
  const identityGrid = document.createElement('div');
  identityGrid.className = 'flow-meta-row';
  identityGrid.appendChild(labeledField('NAME', nameInput, { wide: true }));
  identityGrid.appendChild(labeledField('TARGET', targetSelect));
  wrap.appendChild(identityGrid);

  wrap.appendChild(sectionLabel('THEME SEEDS'));
  const themeGrid = document.createElement('div');
  themeGrid.className = 'flow-meta-row';
  themeGrid.appendChild(labeledField('GENRE SEEDS', genreInput));
  themeGrid.appendChild(labeledField('ERA SEEDS', eraInput));
  themeGrid.appendChild(labeledField('MOOD SEEDS', moodInput));
  themeGrid.appendChild(labeledField('CONTENT TYPE SEEDS', contentTypeInput));
  wrap.appendChild(themeGrid);

  wrap.appendChild(sectionLabel('CONTENT POOL'));
  const poolGrid = document.createElement('div');
  poolGrid.className = 'flow-meta-row';
  poolGrid.appendChild(labeledField('FOLDERS', buildFolderScopeEditor(profile), { wide: true }));
  poolGrid.appendChild(labeledField('TAGS', buildTagScopeInput(profile), { wide: true }));
  wrap.appendChild(poolGrid);

  wrap.appendChild(sectionLabel('AD PRESET & BUMPERS'));
  const adGrid = document.createElement('div');
  adGrid.className = 'flow-meta-row';
  adGrid.appendChild(labeledField('AD PRESET', adPresetSelect));
  adGrid.appendChild(labeledField('BUMPER STYLE TAGS', bumperTagsInput));
  wrap.appendChild(adGrid);

  wrap.appendChild(sectionLabel('AUTOMATION'));
  const autoGrid = document.createElement('div');
  autoGrid.className = 'flow-meta-row';
  autoGrid.appendChild(labeledField('REGENERATION', regenSelect));
  autoGrid.appendChild(labeledField('SCHEDULE INTERVAL', intervalSelect));
  wrap.appendChild(autoGrid);
  refreshRegenAvailability();

  const advancedToggleBtn = document.createElement('button');
  advancedToggleBtn.type = 'button';
  advancedToggleBtn.className = 'btn title-row-desc-toggle';
  advancedToggleBtn.style.alignSelf = 'flex-start'; // wrap is a flex column (stretch by default) — this is a lone toggle, not a full-width row
  const slotCount = profile.dayPartTemplate.length;
  advancedToggleBtn.textContent = slotCount ? `ADVANCED: DAY-PART TEMPLATE (${slotCount}) ▾` : '+ ADVANCED: DAY-PART TEMPLATE';
  const dayPartWrap = buildDayPartEditor(profile);
  dayPartWrap.classList.toggle('hidden', !slotCount);
  advancedToggleBtn.addEventListener('click', () => {
    const nowHidden = dayPartWrap.classList.toggle('hidden');
    advancedToggleBtn.textContent = nowHidden
      ? `+ ADVANCED: DAY-PART TEMPLATE${profile.dayPartTemplate.length ? ` (${profile.dayPartTemplate.length})` : ''}`
      : `ADVANCED: DAY-PART TEMPLATE (${profile.dayPartTemplate.length}) ▾`;
  });
  wrap.appendChild(advancedToggleBtn);
  wrap.appendChild(dayPartWrap);

  const actions = document.createElement('div');
  actions.className = 'block-row';
  actions.appendChild(previewBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  wrap.appendChild(actions);

  return wrap;
}

function buildPreviewCard(profile) {
  const summary = previewProposal.diffSummary;
  const card = document.createElement('div');
  card.className = 'interstitial-card open autocurate-card-body';
  card.style.borderLeftColor = 'var(--cyan)';

  const title = document.createElement('div');
  title.className = 'interstitial-card-title';
  title.textContent = summary.isNewChannel
    ? `PREVIEW — NEW CHANNEL ${summary.channelNumber}: ${summary.channelName || '(untitled)'}`
    : `RE-CURATE — CHANNEL ${summary.channelNumber} (${summary.currentFileCount} FILE(S) CURRENTLY)`;
  card.appendChild(title);

  if (summary.targetMissing) {
    const warn = document.createElement('div');
    warn.className = 'panel-status';
    warn.style.color = 'var(--danger)';
    warn.textContent = `Channel ${summary.channelNumber} no longer exists (it may have been removed) — pick a different target or CREATE NEW CHANNEL before applying.`;
    card.appendChild(warn);
    return card;
  }

  const meta = document.createElement('div');
  meta.className = 'panel-status';
  meta.textContent = (summary.isNewChannel
    ? `${summary.fileCount} file(s) selected`
    : `+${summary.fileCount} new file(s) this run would add (existing content is left untouched — re-curate only ever adds)`) +
    ` (${summary.matchedCount} of ${summary.totalScanned} scanned matched the theme)` +
    (summary.adPresetName ? ` • ad preset: ${summary.adPresetName}` : '') +
    (summary.newInterstitialTypes.length ? ` • +${summary.newInterstitialTypes.length} new bumper(s): ${summary.newInterstitialTypes.join(', ')}` : '');
  card.appendChild(meta);

  if (summary.sampleTitles.length) {
    const sample = document.createElement('div');
    sample.className = 'panel-status';
    sample.textContent = `Sample: ${summary.sampleTitles.join(', ')}${summary.fileCount > summary.sampleTitles.length ? '…' : ''}`;
    card.appendChild(sample);
  } else if (!summary.isNewChannel) {
    const none = document.createElement('div');
    none.className = 'panel-status';
    none.textContent = 'Nothing new matches this theme right now — every matching file is already in the channel.';
    card.appendChild(none);
  }

  if (summary.dayPartSummaries.length) {
    const dayPartHeader = document.createElement('div');
    dayPartHeader.className = 'panel-status';
    dayPartHeader.textContent = 'Day-part slots:';
    card.appendChild(dayPartHeader);
    summary.dayPartSummaries.forEach((d) => {
      const line = document.createElement('div');
      line.className = 'panel-status';
      line.style.paddingLeft = '12px';
      line.textContent = `${d.isNewBlock ? '+ NEW BLOCK' : 'MERGE INTO EXISTING'} — ${d.label}: ${d.fileCount} file(s)`;
      card.appendChild(line);
    });
  }

  const actions = document.createElement('div');
  actions.className = 'block-row';

  const reshuffleBtn = document.createElement('button');
  reshuffleBtn.type = 'button';
  reshuffleBtn.className = 'btn';
  reshuffleBtn.textContent = 'RESHUFFLE';
  reshuffleBtn.addEventListener('click', () => {
    previewSeed += 1;
    previewProposal = curateChannel(profile, previewSeed);
    renderAutoCurateList();
  });

  const applyBtn = document.createElement('button');
  applyBtn.type = 'button';
  applyBtn.className = 'btn';
  applyBtn.textContent = 'APPLY';
  const dayPartFileTotal = summary.dayPartSummaries.reduce((sum, d) => sum + d.fileCount, 0);
  applyBtn.disabled = summary.fileCount === 0 && !summary.newInterstitialTypes.length && !dayPartFileTotal;
  applyBtn.addEventListener('click', async () => {
    if (!profile.name || !profile.name.trim()) { alertDialog('Give this profile a name first.'); return; }
    const dayPartNote = dayPartFileTotal ? ` plus ${dayPartFileTotal} file(s) across ${summary.dayPartSummaries.length} day-part block(s)` : '';
    const confirmMsg = summary.isNewChannel
      ? `Create channel ${summary.channelNumber} with this lineup${dayPartNote}? This can be undone with Ctrl+Z.`
      : `Add ${summary.fileCount} new file(s)${dayPartNote} and ${summary.newInterstitialTypes.length} new bumper(s) to channel ${summary.channelNumber}? Existing content is never removed. This can be undone with Ctrl+Z.`;
    if (!(await confirmDialog(confirmMsg))) return;
    // The preview was computed before the dialog opened; the lineup or the profile
    // may have changed under it. Recompute and only apply if it is what was confirmed.
    const fresh = curateChannel(profile, previewSeed);
    const was = previewProposal.diffSummary;
    const now = fresh.diffSummary;
    previewProposal = fresh;
    if (now.targetMissing || now.fileCount !== was.fileCount || now.channelNumber !== was.channelNumber) {
      renderAutoCurateList();
      await alertDialog('The lineup changed since this preview was made, so nothing was applied. Review the refreshed preview and APPLY again.');
      return;
    }
    profile.lastRunAt = Date.now();
    ensureSaved(profile);
    applyCurationProposal(previewProposal);
    previewProposal = null;
    editingProfile = null;
    commitConfigPatch('Apply curation');
    renderChannelList();
    renderInterstitialsList();
    renderAutoCurateList();
  });

  actions.appendChild(reshuffleBtn);
  actions.appendChild(applyBtn);
  card.appendChild(actions);
  return card;
}

function buildProfileRow(profile) {
  const card = document.createElement('div');
  card.className = 'interstitial-card';
  card.style.borderLeftColor = 'var(--gold)';

  const header = document.createElement('div');
  header.className = 'interstitial-card-summary';

  const title = document.createElement('span');
  title.className = 'interstitial-card-title';
  title.textContent = profile.name && profile.name.trim() ? profile.name : '(untitled profile)';
  header.appendChild(title);

  const targetChannelExists = profile.targetChannel == null || sortedChannels().some((c) => c.number === profile.targetChannel);
  const target = document.createElement('span');
  target.className = 'interstitial-card-meta';
  target.textContent = profile.targetChannel == null
    ? 'NEW CHANNEL'
    : targetChannelExists ? `CH ${profile.targetChannel}` : `CH ${profile.targetChannel} (REMOVED)`;
  if (!targetChannelExists) target.style.color = 'var(--danger)';
  header.appendChild(target);

  if (profile.regenerationMode === 'scheduled') {
    const sched = document.createElement('span');
    sched.className = 'interstitial-card-meta';
    sched.style.color = 'var(--cyan)';
    sched.textContent = `SCHEDULED — ${(profile.scheduleInterval || 'weekly').toUpperCase()}`;
    header.appendChild(sched);
  }

  if (profile.lastRunAt) {
    const last = document.createElement('span');
    last.className = 'interstitial-card-meta';
    last.textContent = `LAST RUN ${new Date(profile.lastRunAt).toLocaleDateString()}`;
    header.appendChild(last);
  }

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'btn';
  editBtn.textContent = 'EDIT / PREVIEW';
  editBtn.addEventListener('click', () => {
    // A clone, not the live S.config object — see ensureSaved()'s comment.
    editingProfile = withProfileDefaults(deepClone(profile));
    editingProfileBaseline = JSON.stringify(editingProfile);
    editingProfileOriginal = profile;
    isNewProfile = false;
    previewProposal = null;
    previewSeed = 0;
    renderAutoCurateList();
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn remove-btn';
  removeBtn.textContent = 'DELETE';
  removeBtn.addEventListener('click', async () => {
    if (!(await confirmDialog(`Delete the "${profile.name || 'untitled'}" curation profile? You can undo this.`))) return;
    const idx = S.config.curationProfiles.indexOf(profile);
    if (idx !== -1) S.config.curationProfiles.splice(idx, 1);
    // editingProfile is a clone (see EDIT button above), so compare against
    // editingProfileOriginal — the live entry it was cloned from — not
    // editingProfile itself, which is never === the array's own object.
    if (editingProfileOriginal === profile) { editingProfile = null; editingProfileOriginal = null; previewProposal = null; }
    commitConfigPatch('Delete curation profile');
    renderAutoCurateList();
  });

  header.appendChild(editBtn);
  header.appendChild(removeBtn);
  card.appendChild(header);
  return card;
}

export function renderAutoCurateList() {
  if (!autocurateRootEl) return;
  autocurateRootEl.innerHTML = '';

  const listWrap = document.createElement('div');
  listWrap.className = 'titles-list';
  const profiles = S.config.curationProfiles || [];
  profiles.forEach((p) => listWrap.appendChild(buildProfileRow(p)));
  if (!profiles.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO CURATION PROFILES YET';
    listWrap.appendChild(empty);
  }
  autocurateRootEl.appendChild(listWrap);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn';
  addBtn.style.alignSelf = 'flex-start'; // #autocurate-root is a flex column (stretch by default) — this is a lone button, not a full-width row
  addBtn.textContent = '+ NEW PROFILE';
  addBtn.addEventListener('click', () => {
    editingProfile = freshCurationProfile();
    editingProfileBaseline = JSON.stringify(editingProfile);
    editingProfileOriginal = null;
    isNewProfile = true;
    previewProposal = null;
    previewSeed = 0;
    renderAutoCurateList();
  });
  autocurateRootEl.appendChild(addBtn);

  if (editingProfile) autocurateRootEl.appendChild(buildProfileEditor(editingProfile));
  if (previewProposal && editingProfile) autocurateRootEl.appendChild(buildPreviewCard(editingProfile));
}
