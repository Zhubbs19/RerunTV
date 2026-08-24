// PROGRAMMING > TAG TAXONOMY — a curated per-category vocabulary
// (GENRES/ERAS/MOODS) that autocomplete draws from even before a tag's
// been used (collectAllTags, setup-util.js), plus a usage report + rename/
// remove-everywhere tool for tags already in use, since a real library
// drifts ("scifi" vs "sci-fi") and there was previously no way to fix that
// without hand-editing every file/entry using the stale spelling.
import { S, saveConfigDebounced } from './state.js';
import { collectTagUsage, removeTagEverywhere, renameTagEverywhere } from './tagtaxonomy.js';
import { buildMediaThumbnail } from './setup-util.js';
import { confirmDialog } from './setup-dialogs.js';
import { tagtaxonomyRootEl } from './dom.js';
import { renderChannelList } from './setup-channels.js';
import { renderInterstitialsList, renderPresetsList } from './setup-interstitials.js';
import { renderAutoCurateList } from './setup-autocurate.js';

const CATEGORIES = [
  ['genres', 'GENRES'],
  ['eras', 'ERAS'],
  ['moods', 'MOODS'],
];

// Everything a rename/remove could have touched — cheap enough to just
// refresh all of it rather than track exactly which panels are affected.
function refreshEverything() {
  renderChannelList();
  renderInterstitialsList();
  renderPresetsList();
  renderAutoCurateList();
  renderTagTaxonomyPanel();
}

function buildCategoryCard(categoryKey, label) {
  const card = document.createElement('div');
  card.className = 'interstitial-card open autocurate-card-body';
  card.style.borderLeftColor = 'var(--gold)';

  const title = document.createElement('div');
  title.className = 'interstitial-card-title';
  title.textContent = label;
  card.appendChild(title);

  const chipRow = document.createElement('div');
  chipRow.className = 'tagtaxonomy-chip-row';
  const list = S.config.tagTaxonomy[categoryKey];
  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'panel-status';
    empty.textContent = 'No canonical tags yet — add one below, or promote one from TAG USAGE.';
    chipRow.appendChild(empty);
  }
  list.slice().sort().forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'interstitial-tag-chip tagtaxonomy-chip';
    chip.textContent = tag;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'tagtaxonomy-chip-remove';
    removeBtn.textContent = '×';
    removeBtn.title = `Remove "${tag}" from ${label} (doesn't touch any file/entry already tagged with it)`;
    removeBtn.addEventListener('click', () => {
      S.config.tagTaxonomy[categoryKey] = S.config.tagTaxonomy[categoryKey].filter((t) => t !== tag);
      saveConfigDebounced();
      renderTagTaxonomyPanel();
    });
    chip.appendChild(removeBtn);
    chipRow.appendChild(chip);
  });
  card.appendChild(chipRow);

  const addRow = document.createElement('div');
  addRow.className = 'block-row';
  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'title-row-input';
  addInput.placeholder = `ADD A CANONICAL ${label.slice(0, -1)}…`;
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn';
  addBtn.textContent = '+ ADD';
  const commitAdd = () => {
    const t = addInput.value.trim().toLowerCase();
    if (!t) return;
    if (!S.config.tagTaxonomy[categoryKey].includes(t)) S.config.tagTaxonomy[categoryKey].push(t);
    addInput.value = '';
    saveConfigDebounced();
    renderTagTaxonomyPanel();
  };
  addBtn.addEventListener('click', commitAdd);
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitAdd(); } });
  addRow.appendChild(addInput);
  addRow.appendChild(addBtn);
  card.appendChild(addRow);

  return card;
}

function buildUsageRow(entry) {
  const row = document.createElement('div');
  row.className = 'interstitial-card';
  row.style.borderLeftColor = 'var(--cyan)';

  const summary = document.createElement('div');
  summary.className = 'interstitial-card-summary';
  summary.style.cursor = 'default';

  const previews = document.createElement('span');
  previews.className = 'tagtaxonomy-usage-thumbnails';
  const mediaPaths = (entry.mediaPaths || []).slice(0, 3);
  if (mediaPaths.length) {
    mediaPaths.forEach((path) => previews.appendChild(buildMediaThumbnail(path, {
      label: 'USE',
      className: 'tagtaxonomy-usage-thumbnail',
    })));
  } else {
    previews.appendChild(buildMediaThumbnail(null, {
      label: 'TAG',
      className: 'tagtaxonomy-usage-thumbnail',
    }));
  }
  summary.appendChild(previews);

  const title = document.createElement('span');
  title.className = 'interstitial-card-title';
  title.textContent = entry.tag;
  summary.appendChild(title);

  const count = document.createElement('span');
  count.className = 'interstitial-card-meta';
  count.textContent = `${entry.count} USE${entry.count === 1 ? '' : 'S'}`;
  summary.appendChild(count);

  CATEGORIES.forEach(([key, label]) => {
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'tagtaxonomy-category-badge' + (entry.categories.includes(key) ? ' active' : '');
    badge.textContent = label;
    badge.title = entry.categories.includes(key)
      ? `Remove from ${label}` : `Add to ${label} (marks this an official ${label.slice(0, -1).toLowerCase()})`;
    badge.addEventListener('click', () => {
      const list = S.config.tagTaxonomy[key];
      const idx = list.indexOf(entry.tag);
      if (idx === -1) list.push(entry.tag); else list.splice(idx, 1);
      saveConfigDebounced();
      renderTagTaxonomyPanel();
    });
    summary.appendChild(badge);
  });

  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'btn';
  renameBtn.textContent = 'RENAME';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn remove-btn';
  removeBtn.textContent = 'REMOVE';
  removeBtn.addEventListener('click', async () => {
    if (!(await confirmDialog(`Remove "${entry.tag}" from every file/entry that carries it (${entry.count} place(s))? This can be undone with Ctrl+Z.`))) return;
    removeTagEverywhere(entry.tag);
    saveConfigDebounced();
    refreshEverything();
  });

  summary.appendChild(renameBtn);
  summary.appendChild(removeBtn);
  row.appendChild(summary);

  // Inline rename form — revealed under the row rather than a browser
  // prompt(), consistent with the rest of this app's themed-dialog-only
  // convention (window.prompt has no themed equivalent, so this is a
  // small custom form instead of reaching for it).
  const renameForm = document.createElement('div');
  renameForm.className = 'block-row hidden';
  const renameInput = document.createElement('input');
  renameInput.type = 'text';
  renameInput.className = 'title-row-input';
  renameInput.placeholder = 'NEW NAME';
  const renameConfirmBtn = document.createElement('button');
  renameConfirmBtn.type = 'button';
  renameConfirmBtn.className = 'btn';
  renameConfirmBtn.textContent = 'CONFIRM RENAME';
  const commitRename = async () => {
    const newTag = renameInput.value.trim().toLowerCase();
    if (!newTag) return;
    if (newTag === entry.tag) { renameForm.classList.add('hidden'); return; }
    if (!(await confirmDialog(`Rename "${entry.tag}" to "${newTag}" everywhere (${entry.count} place(s))? This can be undone with Ctrl+Z.`))) return;
    renameTagEverywhere(entry.tag, newTag);
    saveConfigDebounced();
    refreshEverything();
  };
  renameConfirmBtn.addEventListener('click', commitRename);
  renameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } });
  renameBtn.addEventListener('click', () => {
    const nowHidden = renameForm.classList.toggle('hidden');
    if (!nowHidden) { renameInput.value = entry.tag; renameInput.focus(); renameInput.select(); }
  });
  renameForm.appendChild(renameInput);
  renameForm.appendChild(renameConfirmBtn);
  row.appendChild(renameForm);

  return row;
}

export function renderTagTaxonomyPanel() {
  if (!tagtaxonomyRootEl) return;
  tagtaxonomyRootEl.innerHTML = '';

  const categoryGrid = document.createElement('div');
  categoryGrid.className = 'flow-meta-row';
  CATEGORIES.forEach(([key, label]) => categoryGrid.appendChild(buildCategoryCard(key, label)));
  tagtaxonomyRootEl.appendChild(categoryGrid);

  const usageHeader = document.createElement('div');
  usageHeader.className = 'panel-status';
  usageHeader.style.marginTop = '4px';
  usageHeader.textContent = 'TAG USAGE — every tag currently in use anywhere, most-used first. Click GENRES/ERAS/MOODS to promote a tag into that category; RENAME fixes drift (e.g. "scifi" vs "sci-fi") everywhere at once.';
  tagtaxonomyRootEl.appendChild(usageHeader);

  const usageList = document.createElement('div');
  usageList.className = 'titles-list';
  const usage = collectTagUsage();
  if (!usage.length) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO TAGS IN USE YET';
    usageList.appendChild(empty);
  }
  usage.forEach((entry) => usageList.appendChild(buildUsageRow(entry)));
  tagtaxonomyRootEl.appendChild(usageList);
}

// The generic PROGRAMMING sub-tab switcher (setup-settings.js) only
// toggles which panel is visible — it doesn't re-render anything, since
// every other sub-tab there only ever changes in response to its own
// edits. The usage report is different: it's meant to reflect tags set
// from a completely different tab (TITLES), so without this it would show
// a stale snapshot from whenever the setup screen was first opened until
// the user happened to make an edit inside this panel itself.
const tagtaxonomySubtabBtn = document.querySelector('.setup-subtab-btn[data-subtab="tagtaxonomy"]');
if (tagtaxonomySubtabBtn) tagtaxonomySubtabBtn.addEventListener('click', renderTagTaxonomyPanel);
