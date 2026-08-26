// Per-channel edit-tab panels that don't need their own module: TITLES,
// FOLDERS, ADS (commercials), LOGO, and the THEME placeholder. SCHEDULE +
// CALENDAR live in setup-schedule.js (they're bigger and share a lot of
// row-editing code); channel-list/bulk-action rendering lives in
// setup-channels.js.
import { foldLogoBugCorner, freshCommercialsConfig, freshFileFacets, mirrorFacetsIntoTags } from './channels.js';
import { applyLogoBugPlacement } from './playback.js';
import { themePackEntries, titleRowActionEntries } from './plugins.js';
import { removeFolderFromChannel } from './setup-channels.js';
import { S, saveConfigDebounced, viewNow } from './state.js';
import { basenameNoExt, formatDuration, guessCleanTitle, stripReleaseTags, suggestFacetsFromPath } from './util.js';
import {
  attachTagAutocomplete, buildBreakpointTrack, buildDynamicOverlaysEditor, buildLogoBugProfileEditor, buildMediaThumbnail,
  openLiveLogoBugEditor, parsePositiveInt,
} from './setup-util.js';
import { confirmDialog, alertDialog, promptDialog } from './setup-dialogs.js';
import { fileAtOrder, folderFileOrder, naturalFileOrder, seededFileOrder } from './playback-order.js';

// `target` just needs a `.files` array — works for a channel (ch.files) or
// a single schedule block (block.files), since both store their file pool
// the same shape. `folders` (for the "select by folder" dropdown) defaults
// to target.folders (channels have several) but can be passed explicitly
// for a block, which only ever has the one folder it was scanned from.
export function buildTitlesPanel(target, panelEl, opts = {}) {
  panelEl.innerHTML = '';
  const folders = opts.folders || target.folders || [];

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'titles-search';
  search.placeholder = 'FILTER FILES…';

  const orderBar = document.createElement('div');
  orderBar.className = 'playback-order-bar';
  const orderLabel = document.createElement('strong');
  orderLabel.textContent = 'PLAYBACK ORDER';
  const naturalBtn = document.createElement('button');
  naturalBtn.className = 'btn'; naturalBtn.textContent = 'NATURAL EPISODE SORT';
  const seededBtn = document.createElement('button');
  seededBtn.className = 'btn'; seededBtn.textContent = 'SEEDED SHUFFLE…';
  const reverseBtn = document.createElement('button');
  reverseBtn.className = 'btn'; reverseBtn.textContent = 'REVERSE';
  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'btn'; restoreBtn.textContent = 'RESTORE FOLDER ORDER';
  orderBar.append(orderLabel, naturalBtn, seededBtn, reverseBtn, restoreBtn);

  async function applyProposedOrder(proposed, actionLabel) {
    if (proposed.length !== target.files.length || proposed.every((file, index) => file === target.files[index])) return;
    const now = viewNow();
    const before = fileAtOrder(target.files, target.anchor, now);
    const afterWithoutReset = fileAtOrder(proposed, target.anchor, now);
    const preview = proposed.slice(0, 6).map((file, index) => `${index + 1}. ${file.title || basenameNoExt(file.path)}`).join('\n');
    const impact = before && afterWithoutReset && before !== afterWithoutReset
      ? `\n\nWith the existing anchor, NOW would change from “${before.title || basenameNoExt(before.path)}” to “${afterWithoutReset.title || basenameNoExt(afterWithoutReset.path)}”.`
      : '';
    const accepted = await confirmDialog({
      title: actionLabel,
      message: `Preview of the new first items:\n\n${preview}${proposed.length > 6 ? '\n…' : ''}${impact}\n\nApply this order and reset this lineup's broadcast anchor to now so item 1 starts cleanly?`,
      danger: false, confirmText: 'APPLY & RE-ANCHOR',
    });
    if (!accepted) return;
    target.files.splice(0, target.files.length, ...proposed);
    // A channel/block anchor is deliberately real wall-clock state: this
    // user action starts a new continuous broadcast rotation from now.
    target.anchor = Date.now();
    saveConfigDebounced();
    renderRows(search.value);
  }

  naturalBtn.addEventListener('click', () => applyProposedOrder(naturalFileOrder(target.files), 'NATURAL EPISODE SORT'));
  reverseBtn.addEventListener('click', () => applyProposedOrder(target.files.slice().reverse(), 'REVERSE PLAYBACK ORDER'));
  restoreBtn.addEventListener('click', () => applyProposedOrder(folderFileOrder(target.files, folders), 'RESTORE FOLDER ORDER'));
  seededBtn.addEventListener('click', async () => {
    const seed = await promptDialog({
      title: 'SEEDED SHUFFLE', message: 'Enter a reusable seed. The same seed and file list always produce the same order.',
      defaultValue: new Date().toISOString().slice(0, 10),
    });
    if (seed == null) return;
    applyProposedOrder(seededFileOrder(target.files, seed), `SEEDED SHUFFLE · ${seed}`);
  });

  // Bulk-tag toolbar — lets tagging a whole channel's worth of files (e.g.
  // 500+ Spongebob episodes, all needing the same "spongebob" tag to feed
  // an ad preset, PROGRAMMING tab) happen in one action instead of typing
  // the same tag into hundreds of individual rows. `selected` is per-file-
  // object identity, not persisted — it resets whenever this panel is
  // rebuilt (switching away from TITLES and back), same lifetime as the
  // search filter above.
  const selected = new Set();
  const bulkBar = document.createElement('div');
  bulkBar.className = 'titles-bulk-bar';

  const countEl = document.createElement('span');
  countEl.className = 'titles-bulk-count';

  const selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.className = 'btn';
  selectAllBtn.textContent = 'SELECT VISIBLE';

  const selectNoneBtn = document.createElement('button');
  selectNoneBtn.type = 'button';
  selectNoneBtn.className = 'btn';
  selectNoneBtn.textContent = 'CLEAR';

  const folderSelect = document.createElement('select');
  folderSelect.className = 'block-hour-select';
  const folderOpt0 = document.createElement('option');
  folderOpt0.value = '';
  folderOpt0.textContent = 'SELECT BY FOLDER…';
  folderSelect.appendChild(folderOpt0);
  // `folders` entries are normally ch.folders[]-shaped { id, ref, label }
  // objects, but a block's own single folder (setup-schedule.js) is still
  // passed as a bare path string — support both without forcing a block's
  // singular `folder` field through the full entry-object migration too.
  folders.forEach((entry) => {
    const opt = document.createElement('option');
    const value = typeof entry === 'string' ? entry : entry.id;
    const display = typeof entry === 'string' ? entry : (entry.label || entry.ref);
    opt.value = value;
    opt.textContent = display.split(/[\\/]/).pop() || display;
    opt.title = display;
    folderSelect.appendChild(opt);
  });
  if (folders.length < 2) folderSelect.classList.add('hidden');
  folderSelect.addEventListener('change', () => {
    if (!folderSelect.value) return;
    target.files.filter((f) => f.folder === folderSelect.value).forEach((f) => selected.add(f));
    folderSelect.value = '';
    renderRows(search.value);
  });

  // Bulk title — same idea as bulk-tag below, but for the title field.
  // `{n}` auto-numbers in file order (1, 2, 3…) so a season dumped into one
  // folder can go from "S03E01.mkv", "S03E02.mkv"… to "Episode 1", "Episode
  // 2"… in one shot instead of hand-typing each row. Without `{n}` every
  // selected file just gets the literal text verbatim.
  const bulkTitleInput = document.createElement('input');
  bulkTitleInput.type = 'text';
  bulkTitleInput.className = 'title-row-input';
  bulkTitleInput.placeholder = 'TITLE FOR SELECTED (USE {n} TO NUMBER)';

  const bulkTitleBtn = document.createElement('button');
  bulkTitleBtn.type = 'button';
  bulkTitleBtn.className = 'btn';
  bulkTitleBtn.textContent = 'SET TITLE FOR SELECTED';
  bulkTitleBtn.addEventListener('click', () => {
    const template = bulkTitleInput.value.trim();
    if (!template || !selected.size) return;
    // File order (not Set insertion order) so numbering follows the list
    // on screen regardless of the order rows were clicked/selected in.
    const ordered = target.files.filter((f) => selected.has(f));
    ordered.forEach((f, i) => {
      f.title = template.includes('{n}') ? template.replace(/\{n\}/g, String(i + 1)) : template;
    });
    bulkTitleInput.value = '';
    renderRows(search.value);
    saveConfigDebounced();
  });

  const bulkTagInput = document.createElement('input');
  bulkTagInput.type = 'text';
  bulkTagInput.className = 'title-row-input';
  bulkTagInput.placeholder = 'TAGS TO ADD (COMMA-SEP)';
  const bulkTagWrap = attachTagAutocomplete(bulkTagInput);

  const bulkApplyBtn = document.createElement('button');
  bulkApplyBtn.type = 'button';
  bulkApplyBtn.className = 'btn';
  bulkApplyBtn.textContent = 'ADD TAG(S) TO SELECTED';
  bulkApplyBtn.addEventListener('click', () => {
    const toAdd = bulkTagInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (!toAdd.length || !selected.size) return;
    selected.forEach((f) => {
      const existing = new Set(f.tags || []);
      toAdd.forEach((t) => existing.add(t));
      f.tags = Array.from(existing);
    });
    bulkTagInput.value = '';
    renderRows(search.value);
    saveConfigDebounced();
  });

  const bulkClearTagsBtn = document.createElement('button');
  bulkClearTagsBtn.type = 'button';
  bulkClearTagsBtn.className = 'btn remove-btn';
  bulkClearTagsBtn.textContent = 'CLEAR TAGS FROM SELECTED';
  bulkClearTagsBtn.addEventListener('click', async () => {
    if (!selected.size) return;
    if (!(await confirmDialog(`Remove all tags from ${selected.size} selected file(s)?`))) return;
    selected.forEach((f) => { f.tags = null; });
    renderRows(search.value);
    saveConfigDebounced();
  });

  // Bulk release-tag cleanup — for libraries pulled straight from a
  // download client, where the title (or filename fallback) still carries
  // the full scene-release tag soup: "Title [Release Sources (Streaming
  // Service) 1 0 WEBDL-1080p][EAC3 2.0][h265]-RCVR". guessCleanTitle can't
  // reach these (it only strips a bracket group that's the very last thing
  // in the string, and a trailing "-RCVR" release-group tag defeats that),
  // so this uses the more aggressive stripReleaseTags instead. Only touches
  // files that don't already have a hand-set title, since a user-typed
  // title is intentional and shouldn't get silently rewritten by a bulk
  // action aimed at cleaning up machine-generated ones.
  const bulkCleanBtn = document.createElement('button');
  bulkCleanBtn.type = 'button';
  bulkCleanBtn.className = 'btn';
  bulkCleanBtn.textContent = 'STRIP RELEASE TAGS';
  bulkCleanBtn.title = 'Clean up scene-release filenames like "Title [1080p WEBDL][h265]-GROUP" for the selected files. Skips files that already have a title set.';
  bulkCleanBtn.addEventListener('click', () => {
    if (!selected.size) return;
    const files = Array.from(selected).filter((f) => !(f.title && f.title.trim()));
    if (!files.length) {
      alertDialog('Every selected file already has a title set — nothing to clean up. Clear a title first if you want it re-derived from the filename.');
      return;
    }
    files.forEach((f) => { f.title = stripReleaseTags(basenameNoExt(f.path)); });
    renderRows(search.value);
    saveConfigDebounced();
  });

  // Auto-tag suggestions (suggestFacetsFromPath, util.js) — an *addition*
  // to the manual tag/facet system above, not a replacement: it only ever
  // fills in a facet field that's currently empty on a given file (a year
  // in the path → era, "S01E02"/"Season"/"Episode" → show, a generic genre
  // word → genre), it's always reviewable/overridable afterward in the
  // per-row FACETS editor exactly like a hand-typed value, and a file with
  // every relevant facet already set is simply skipped rather than touched.
  const bulkSuggestBtn = document.createElement('button');
  bulkSuggestBtn.type = 'button';
  bulkSuggestBtn.className = 'btn';
  bulkSuggestBtn.textContent = 'SUGGEST FACETS';
  bulkSuggestBtn.title = 'Guess genre/era/content type for the selected files from each one\'s own filename and folder path. Only fills in a facet that\'s currently empty — never overwrites anything you (or a prior suggestion) already set.';
  bulkSuggestBtn.addEventListener('click', () => {
    if (!selected.size) return;
    let touched = 0;
    selected.forEach((f) => {
      const suggestion = suggestFacetsFromPath(f.path);
      if (!suggestion.genre.length && !suggestion.era && !suggestion.contentType) return;
      const facets = f.facets || freshFileFacets();
      let changed = false;
      if (suggestion.genre.length && !facets.genre.length) { facets.genre = suggestion.genre; changed = true; }
      if (suggestion.era && !facets.era) { facets.era = suggestion.era; changed = true; }
      if (suggestion.contentType && !facets.contentType) { facets.contentType = suggestion.contentType; changed = true; }
      if (!changed) return;
      f.facets = facets;
      mirrorFacetsIntoTags(f);
      touched += 1;
    });
    if (!touched) {
      alertDialog('No new facet suggestions for the selected files — either nothing in their paths matched, or they already have every facet set.');
      return;
    }
    renderRows(search.value);
    saveConfigDebounced();
  });

  // Bulk facets — same idea as the free-tag bulk bar above, but for the
  // structured facet fields (Tag System 2.0). Kept in its own collapsible
  // bar rather than crowding the always-visible one, since it's four
  // fields instead of one; only a field the user actually filled in gets
  // applied, so e.g. setting genre for 40 selected files doesn't also
  // stamp every one of them with a blank era. mirrorFacetsIntoTags keeps
  // the free TAGS field in sync the same way the per-row facets editor does.
  const bulkFacetsToggleBtn = document.createElement('button');
  bulkFacetsToggleBtn.type = 'button';
  bulkFacetsToggleBtn.className = 'btn';
  bulkFacetsToggleBtn.textContent = '+ BULK FACETS';

  const bulkFacetsBar = document.createElement('div');
  bulkFacetsBar.className = 'titles-bulk-bar titles-bulk-bar-facets hidden';

  const bulkGenreInput = document.createElement('input');
  bulkGenreInput.type = 'text';
  bulkGenreInput.className = 'title-row-input';
  bulkGenreInput.placeholder = 'GENRE(S) FOR SELECTED';
  const bulkGenreWrap = attachTagAutocomplete(bulkGenreInput);

  const bulkMoodInput = document.createElement('input');
  bulkMoodInput.type = 'text';
  bulkMoodInput.className = 'title-row-input';
  bulkMoodInput.placeholder = 'MOOD/ENERGY FOR SELECTED';
  const bulkMoodWrap = attachTagAutocomplete(bulkMoodInput);

  const bulkEraInput = document.createElement('input');
  bulkEraInput.type = 'text';
  bulkEraInput.className = 'title-row-input';
  bulkEraInput.placeholder = 'ERA/DECADE FOR SELECTED';

  const bulkContentTypeSelect = document.createElement('select');
  bulkContentTypeSelect.className = 'block-hour-select';
  [['', 'CONTENT TYPE (LEAVE UNSET)'], ['show', 'SHOW'], ['movie', 'MOVIE'], ['short', 'SHORT'], ['promo', 'PROMO'], ['bumper', 'BUMPER']]
    .forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      bulkContentTypeSelect.appendChild(opt);
    });

  const bulkFacetsApplyBtn = document.createElement('button');
  bulkFacetsApplyBtn.type = 'button';
  bulkFacetsApplyBtn.className = 'btn';
  bulkFacetsApplyBtn.textContent = 'APPLY FACETS TO SELECTED';
  bulkFacetsApplyBtn.addEventListener('click', () => {
    if (!selected.size) return;
    const genresToAdd = bulkGenreInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const moodsToAdd = bulkMoodInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    const era = bulkEraInput.value.trim().toLowerCase();
    const contentType = bulkContentTypeSelect.value;
    if (!genresToAdd.length && !moodsToAdd.length && !era && !contentType) return;
    selected.forEach((f) => {
      f.facets = f.facets || freshFileFacets();
      if (genresToAdd.length) f.facets.genre = Array.from(new Set([...f.facets.genre, ...genresToAdd]));
      if (moodsToAdd.length) f.facets.mood = Array.from(new Set([...f.facets.mood, ...moodsToAdd]));
      if (era) f.facets.era = era;
      if (contentType) f.facets.contentType = contentType;
      mirrorFacetsIntoTags(f);
    });
    bulkGenreInput.value = ''; bulkMoodInput.value = ''; bulkEraInput.value = ''; bulkContentTypeSelect.value = '';
    renderRows(search.value);
    saveConfigDebounced();
  });

  const bulkFacetsClearBtn = document.createElement('button');
  bulkFacetsClearBtn.type = 'button';
  bulkFacetsClearBtn.className = 'btn remove-btn';
  bulkFacetsClearBtn.textContent = 'CLEAR FACETS FROM SELECTED';
  bulkFacetsClearBtn.title = 'Resets each selected file\'s structured facets. Leaves the free TAGS field alone — any tags a facet previously contributed there stay unless removed by hand.';
  bulkFacetsClearBtn.addEventListener('click', async () => {
    if (!selected.size) return;
    if (!(await confirmDialog(`Clear facets (genre/mood/era/content type) from ${selected.size} selected file(s)? Their free TAGS field is left untouched.`))) return;
    selected.forEach((f) => { f.facets = freshFileFacets(); });
    renderRows(search.value);
    saveConfigDebounced();
  });

  bulkFacetsBar.appendChild(bulkGenreWrap);
  bulkFacetsBar.appendChild(bulkMoodWrap);
  bulkFacetsBar.appendChild(bulkEraInput);
  bulkFacetsBar.appendChild(bulkContentTypeSelect);
  bulkFacetsBar.appendChild(bulkFacetsApplyBtn);
  bulkFacetsBar.appendChild(bulkFacetsClearBtn);

  bulkFacetsToggleBtn.addEventListener('click', () => {
    const nowHidden = bulkFacetsBar.classList.toggle('hidden');
    bulkFacetsToggleBtn.textContent = nowHidden ? '+ BULK FACETS' : 'BULK FACETS ▾';
  });

  bulkBar.appendChild(countEl);
  bulkBar.appendChild(selectAllBtn);
  bulkBar.appendChild(selectNoneBtn);
  bulkBar.appendChild(folderSelect);
  bulkBar.appendChild(bulkCleanBtn);
  bulkBar.appendChild(bulkSuggestBtn);
  bulkBar.appendChild(bulkTitleInput);
  bulkBar.appendChild(bulkTitleBtn);
  bulkBar.appendChild(bulkTagWrap);
  bulkBar.appendChild(bulkApplyBtn);
  bulkBar.appendChild(bulkClearTagsBtn);
  bulkBar.appendChild(bulkFacetsToggleBtn);

  const list = document.createElement('div');
  list.className = 'titles-list';

  // A plugin's own per-file action (e.g. a metadata lookup) — core has no
  // idea what, if anything, is registered here; see registerTitleRowAction
  // (plugins.js). Bulk-action containers are built once per panel; per-row
  // cells are (re)built fresh inside renderRows() below, same lifetime as
  // every other row element.
  const titleRowActions = titleRowActionEntries();
  const titleRowActionCtx = {
    ...(window.RCBPlugins && window.RCBPlugins.ctx),
    getSelectedFiles: () => selected,
    rerender: () => renderRows(search.value),
  };
  titleRowActions.forEach((action) => {
    if (typeof action.renderBulkAction !== 'function') return;
    const container = document.createElement('span');
    action.renderBulkAction(container, titleRowActionCtx);
    bulkBar.appendChild(container);
  });

  function renderRows(filter) {
    list.innerHTML = '';
    const q = filter.trim().toLowerCase();
    const visibleFiles = [];
    target.files.forEach((file) => {
      const base = basenameNoExt(file.path);
      const tags = file.tags || [];
      if (q && !base.toLowerCase().includes(q) && !(file.title || '').toLowerCase().includes(q) &&
        !tags.some((t) => t.includes(q))) return;
      visibleFiles.push(file);

      const row = document.createElement('div');
      row.className = 'title-row';

      const selectCheckbox = document.createElement('input');
      selectCheckbox.type = 'checkbox';
      selectCheckbox.checked = selected.has(file);
      selectCheckbox.addEventListener('change', () => {
        if (selectCheckbox.checked) selected.add(file); else selected.delete(file);
        countEl.textContent = `${selected.size} SELECTED`;
      });

      const name = document.createElement('span');
      name.className = 'title-row-file';
      name.textContent = base;

      const thumbnail = buildMediaThumbnail(file.path, {
        label: 'VIDEO',
        className: 'title-row-thumbnail',
      });

      const duration = document.createElement('span');
      duration.className = 'title-row-duration';
      duration.textContent = formatDuration(file.duration);

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'title-row-input';
      input.placeholder = guessCleanTitle(base);
      input.value = file.title || '';
      input.addEventListener('input', () => {
        file.title = input.value;
        saveConfigDebounced();
      });

      // Tags a specific ad's CONTENT TAGS field (PROGRAMMING tab,
      // setup-interstitials.js) can target — e.g. tagging every Halloween
      // special "halloween" so a themed commercial pod only ever plays
      // around that content, not the whole channel.
      const tagsInput = document.createElement('input');
      tagsInput.type = 'text';
      tagsInput.className = 'title-row-input';
      tagsInput.placeholder = 'TAGS (COMMA-SEP)';
      tagsInput.value = tags.join(', ');
      tagsInput.addEventListener('change', () => {
        const parsed = tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        file.tags = parsed.length ? parsed : null;
        saveConfigDebounced();
      });
      const tagsWrap = attachTagAutocomplete(tagsInput);

      // Shown on the DETAILS page (press I while watching, or on the
      // highlighted show in the guide — see details.js). Collapsed by
      // default so a channel with hundreds of files doesn't turn this list
      // into hundreds of always-visible textareas; a file that already has
      // one starts expanded so it's never hidden without a hint.
      const hasDescription = !!(file.description && file.description.trim());
      const descToggleBtn = document.createElement('button');
      descToggleBtn.type = 'button';
      descToggleBtn.className = 'btn title-row-desc-toggle';
      descToggleBtn.textContent = hasDescription ? 'DESCRIPTION ▾' : '+ DESCRIPTION';

      const descInput = document.createElement('textarea');
      descInput.className = 'title-row-description' + (hasDescription ? '' : ' hidden');
      descInput.rows = 2;
      descInput.placeholder = 'DESCRIPTION / SYNOPSIS — SHOWN ON THE DETAILS PAGE (PRESS I WHILE WATCHING)';
      descInput.value = file.description || '';
      descInput.addEventListener('input', () => {
        file.description = descInput.value;
        saveConfigDebounced();
      });
      descToggleBtn.addEventListener('click', () => {
        const nowHidden = descInput.classList.toggle('hidden');
        descToggleBtn.textContent = nowHidden ? '+ DESCRIPTION' : 'DESCRIPTION ▾';
        if (!nowHidden) descInput.focus();
      });

      // Structured facets (Tag System 2.0, channels.js) — an optional layer
      // on top of the free TAGS field above, so PROGRAMMING > AUTO-CURATE
      // can score content by genre/era/mood/type instead of only fuzzy
      // free-text tag overlap. Collapsed by default, same reasoning as
      // DESCRIPTION above; whenever one changes it's mirrored into `tags`
      // too (mirrorFacetsIntoTags) so the free TAGS field above stays in
      // sync and existing tag-driven matching (ad presets, interstitials)
      // keeps working with zero changes on its end.
      const facets = file.facets || freshFileFacets();
      const hasFacets = !!(facets.genre.length || facets.era || facets.mood.length || facets.contentType);
      const facetsToggleBtn = document.createElement('button');
      facetsToggleBtn.type = 'button';
      facetsToggleBtn.className = 'btn title-row-desc-toggle';
      facetsToggleBtn.textContent = hasFacets ? 'FACETS ▾' : '+ FACETS';

      const facetsRow = document.createElement('div');
      facetsRow.className = 'title-row-facets' + (hasFacets ? '' : ' hidden');

      function commitFacet(mutate) {
        file.facets = file.facets || freshFileFacets();
        mutate(file.facets);
        mirrorFacetsIntoTags(file);
        tagsInput.value = (file.tags || []).join(', ');
        saveConfigDebounced();
      }

      const genreInput = document.createElement('input');
      genreInput.type = 'text';
      genreInput.className = 'title-row-input';
      genreInput.placeholder = 'GENRE(S)';
      genreInput.value = facets.genre.join(', ');
      genreInput.addEventListener('change', () => {
        const parsed = genreInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        commitFacet((f) => { f.genre = parsed; });
      });
      const genreWrap = attachTagAutocomplete(genreInput);

      const moodInput = document.createElement('input');
      moodInput.type = 'text';
      moodInput.className = 'title-row-input';
      moodInput.placeholder = 'MOOD / ENERGY';
      moodInput.value = facets.mood.join(', ');
      moodInput.addEventListener('change', () => {
        const parsed = moodInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        commitFacet((f) => { f.mood = parsed; });
      });
      const moodWrap = attachTagAutocomplete(moodInput);

      const eraInput = document.createElement('input');
      eraInput.type = 'text';
      eraInput.className = 'title-row-input';
      eraInput.placeholder = 'ERA / DECADE (E.G. 1980S)';
      eraInput.value = facets.era || '';
      eraInput.addEventListener('change', () => {
        commitFacet((f) => { f.era = eraInput.value.trim().toLowerCase() || null; });
      });

      const contentTypeSelect = document.createElement('select');
      contentTypeSelect.className = 'block-hour-select';
      [['', 'CONTENT TYPE…'], ['show', 'SHOW'], ['movie', 'MOVIE'], ['short', 'SHORT'], ['promo', 'PROMO'], ['bumper', 'BUMPER']]
        .forEach(([value, label]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = label;
          contentTypeSelect.appendChild(opt);
        });
      contentTypeSelect.value = facets.contentType || '';
      contentTypeSelect.addEventListener('change', () => {
        commitFacet((f) => { f.contentType = contentTypeSelect.value || null; });
      });

      facetsRow.appendChild(genreWrap);
      facetsRow.appendChild(moodWrap);
      facetsRow.appendChild(eraInput);
      facetsRow.appendChild(contentTypeSelect);

      facetsToggleBtn.addEventListener('click', () => {
        const nowHidden = facetsRow.classList.toggle('hidden');
        facetsToggleBtn.textContent = nowHidden ? '+ FACETS' : 'FACETS ▾';
        if (!nowHidden) genreInput.focus();
      });

      row.appendChild(selectCheckbox);
      row.appendChild(thumbnail);
      row.appendChild(name);
      row.appendChild(duration);
      row.appendChild(input);
      row.appendChild(tagsWrap);
      row.appendChild(descToggleBtn);
      row.appendChild(facetsToggleBtn);

      // A plugin's own per-file action (metadata lookup, etc.) — see
      // registerTitleRowAction (plugins.js). One cell per registered action,
      // so more than one plugin can add its own without fighting over a
      // shared cell. `file` is handed directly (not just via ctx) since it's
      // this specific row's own file, not shared panel state.
      titleRowActions.forEach((action) => {
        const cell = document.createElement('div');
        cell.className = 'title-row-plugin-cell';
        action.renderRowCell(cell, file, { ...titleRowActionCtx, descInput, descToggleBtn });
        row.appendChild(cell);
      });

      const wrap = document.createElement('div');
      wrap.className = 'title-row-wrap';
      wrap.draggable = !q;
      if (!q) {
        wrap.title = 'Drag to change playback order';
        wrap.addEventListener('dragstart', (event) => {
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(target.files.indexOf(file)));
          wrap.classList.add('is-dragging');
        });
        wrap.addEventListener('dragend', () => wrap.classList.remove('is-dragging'));
        wrap.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; });
        wrap.addEventListener('drop', (event) => {
          event.preventDefault();
          const from = Number(event.dataTransfer.getData('text/plain'));
          const to = target.files.indexOf(file);
          if (!Number.isInteger(from) || from < 0 || to < 0 || from === to) return;
          const proposed = target.files.slice();
          const [moved] = proposed.splice(from, 1);
          proposed.splice(to, 0, moved);
          applyProposedOrder(proposed, 'MANUAL PLAYBACK REORDER');
        });
      }
      wrap.appendChild(row);
      wrap.appendChild(descInput);
      wrap.appendChild(facetsRow);
      list.appendChild(wrap);
    });
    if (list.children.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'titles-empty';
      empty.textContent = 'NO FILES MATCH';
      list.appendChild(empty);
    }
    countEl.textContent = `${selected.size} SELECTED`;
    selectAllBtn.onclick = () => {
      visibleFiles.forEach((f) => selected.add(f));
      renderRows(search.value);
    };
    selectNoneBtn.onclick = () => {
      selected.clear();
      renderRows(search.value);
    };
  }

  search.addEventListener('input', () => renderRows(search.value));
  renderRows('');

  panelEl.appendChild(orderBar);
  panelEl.appendChild(search);
  panelEl.appendChild(bulkBar);
  panelEl.appendChild(bulkFacetsBar);
  panelEl.appendChild(list);
}

export function buildFoldersPanel(ch, panelEl) {
  panelEl.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'titles-list';

  (ch.folders || []).forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'folder-row';

    const display = entry.label || entry.ref;
    const path = document.createElement('span');
    path.className = 'folder-row-path';
    path.textContent = entry.source && entry.source !== 'local' ? `[${entry.source}] ${display}` : display;
    path.title = display;
    row.appendChild(path);

    const count = ch.files.filter((f) => f.folder === entry.id).length;
    const countEl = document.createElement('span');
    countEl.className = 'folder-row-count';
    countEl.textContent = `${count} video${count === 1 ? '' : 's'}`;
    row.appendChild(countEl);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn remove-btn';
    removeBtn.textContent = 'REMOVE';
    removeBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(`Remove this folder (${count} video${count === 1 ? '' : 's'}) from the channel?`))) return;
      removeFolderFromChannel(ch, entry);
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  });

  if (!ch.folders || ch.folders.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO FOLDERS';
    list.appendChild(empty);
  }

  panelEl.appendChild(list);
}

// Per-channel ADS tab: a simple on/off toggle for ch.adsEnabled.
// All ad timing, flow, and scheduling lives in the Programming tab's
// SHOW & AD FLOWS / CADENCE & PRESETS panels — not per-channel.
export function buildChannelAdsPanel(ch, panelEl) {
  panelEl.innerHTML = '';

  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'shuffle-toggle';
  const enabledCheckbox = document.createElement('input');
  enabledCheckbox.type = 'checkbox';
  enabledCheckbox.checked = ch.adsEnabled !== false;
  enabledCheckbox.addEventListener('change', () => {
    ch.adsEnabled = enabledCheckbox.checked;
    saveConfigDebounced();
  });
  enabledLabel.appendChild(enabledCheckbox);
  enabledLabel.appendChild(document.createTextNode('ADS ENABLED ON THIS CHANNEL'));
  panelEl.appendChild(enabledLabel);

  const hint = document.createElement('div');
  hint.className = 'titles-empty';
  hint.textContent = 'AD TIMING, BREAKS, POD SIZE, AND BUMPER POOL ARE CONFIGURED IN PROGRAMMING (CADENCE & PRESETS; ADVANCED FLOWS WHEN NEEDED). THIS TOGGLE IS A GLOBAL KILL-SWITCH FOR ADS ON THIS CHANNEL ONLY.';
  panelEl.appendChild(hint);
}

// Builds the ad-settings UI for a daypart block override (block.commercials).
// Only shown when a block opts out of inheriting the channel/flow default via
// the OVERRIDE ADS DURING THIS BLOCK checkbox (allowInherit: true).
// opts.onChange fires after every edit so the block row's summary can stay
// in sync without rebuilding the whole schedule panel.
export function buildCommercialsPanel(owner, panelEl, opts) {
  opts = opts || {};

  function render() {
    panelEl.innerHTML = '';

    if (opts.allowInherit) {
      const inheritLabel = document.createElement('label');
      inheritLabel.className = 'shuffle-toggle';
      const inheritCheckbox = document.createElement('input');
      inheritCheckbox.type = 'checkbox';
      inheritCheckbox.checked = !!owner.commercials;
      inheritCheckbox.addEventListener('change', () => {
        owner.commercials = inheritCheckbox.checked ? freshCommercialsConfig() : null;
        render();
        saveConfigDebounced();
      });
      inheritLabel.appendChild(inheritCheckbox);
      inheritLabel.appendChild(document.createTextNode('OVERRIDE ADS DURING THIS BLOCK'));
      panelEl.appendChild(inheritLabel);

      if (!owner.commercials) {
        const hint = document.createElement('div');
        hint.className = 'titles-empty';
        hint.textContent = 'USES THE CHANNEL\'S AD SETTINGS';
        panelEl.appendChild(hint);
        if (opts.onChange) opts.onChange();
        return;
      }
    }

    const cc = owner.commercials;

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'shuffle-toggle';
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = cc.enabled !== false;
    enabledCheckbox.addEventListener('change', () => {
      cc.enabled = enabledCheckbox.checked;
      render();
      saveConfigDebounced();
    });
    enabledLabel.appendChild(enabledCheckbox);
    enabledLabel.appendChild(document.createTextNode('ADS ENABLED'));
    panelEl.appendChild(enabledLabel);

    if (cc.enabled === false) {
      if (opts.onChange) opts.onChange();
      return;
    }

    const poolHint = document.createElement('div');
    poolHint.className = 'titles-empty';
    poolHint.textContent = 'BUMPER CONTENT COMES FROM THE INTERSTITIALS POOL (PROGRAMMING TAB), TAGGED TO THIS CHANNEL OR "ANY" — THIS PANEL IS JUST WHEN/WHETHER BREAKS HAPPEN.';
    panelEl.appendChild(poolHint);

    const timingRow = document.createElement('div');
    timingRow.className = 'block-row';
    const timingLabel = document.createElement('span');
    timingLabel.className = 'block-count';
    timingLabel.textContent = 'BREAKS';
    const timingSelect = document.createElement('select');
    timingSelect.className = 'block-hour-select';
    [
      ['interval', 'ON A TIMER'],
      ['everyNMinutes', 'DURING EACH SHOW, EVERY N MIN'],
      ['breakpoints', 'DURING EACH SHOW, AT SET POINTS (%)'],
      ['pre', 'BEFORE EACH SHOW'],
      ['post', 'AFTER EACH SHOW'],
      ['both', 'BEFORE & AFTER EACH SHOW'],
    ].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      timingSelect.appendChild(opt);
    });
    timingSelect.value = cc.timing || 'interval';
    timingSelect.addEventListener('change', () => {
      cc.timing = timingSelect.value;
      render();
      saveConfigDebounced();
    });
    timingRow.appendChild(timingLabel);
    timingRow.appendChild(timingSelect);
    panelEl.appendChild(timingRow);

    if (!cc.timing || cc.timing === 'interval' || cc.timing === 'everyNMinutes') {
      const intervalRow = document.createElement('div');
      intervalRow.className = 'block-row';
      const intervalLabel = document.createElement('span');
      intervalLabel.className = 'block-count';
      intervalLabel.textContent = 'EVERY';
      const intervalInput = document.createElement('input');
      intervalInput.type = 'number';
      intervalInput.min = 1;
      intervalInput.className = 'block-hour-select';
      intervalInput.value = cc.intervalMinutes || '';
      intervalInput.placeholder = String((S.config.commercials && S.config.commercials.intervalMinutes) || 10);
      intervalInput.addEventListener('change', () => {
        cc.intervalMinutes = parsePositiveInt(intervalInput.value, null);
        saveConfigDebounced();
      });
      const intervalSuffix = document.createElement('span');
      intervalSuffix.className = 'block-count';
      intervalSuffix.textContent = 'MIN (BLANK = BOX DEFAULT)';
      intervalRow.appendChild(intervalLabel);
      intervalRow.appendChild(intervalInput);
      intervalRow.appendChild(intervalSuffix);
      panelEl.appendChild(intervalRow);
    }

    if (cc.timing === 'breakpoints') {
      const bpRow = document.createElement('div');
      bpRow.className = 'block-row';
      const bpLabel = document.createElement('span');
      bpLabel.className = 'block-count';
      bpLabel.textContent = 'AT';
      const bpInput = document.createElement('input');
      bpInput.type = 'text';
      bpInput.className = 'title-row-input';
      bpInput.placeholder = 'BREAK POINTS, % THROUGH SHOW (E.G. 25, 50, 75)';
      bpInput.value = (cc.breakpoints || []).join(', ');
      bpInput.addEventListener('change', () => {
        const pts = bpInput.value.split(',')
          .map((v) => parseFloat(v.trim()))
          .filter((v) => Number.isFinite(v) && v > 0 && v < 100);
        cc.breakpoints = pts.length ? pts : null;
        saveConfigDebounced();
        render(); // re-syncs the drag track below to whatever was just typed
      });
      bpRow.appendChild(bpLabel);
      bpRow.appendChild(bpInput);
      panelEl.appendChild(bpRow);

      const track = buildBreakpointTrack(
        () => cc.breakpoints,
        (pts) => { cc.breakpoints = pts; saveConfigDebounced(); },
        bpInput,
      );
      panelEl.appendChild(track);
    }

    // Pod size: how many `commercial` entries play back-to-back per break.
    // 1/1 (the default) is exactly today's one-bumper-per-break behavior;
    // widening it plus adding adBreakIn/adBreakOut pool entries (PROGRAMMING
    // tab) gives a real ad "pod" — bump-in, 2-4 spots, bump-out.
    const podRow = document.createElement('div');
    podRow.className = 'block-row';
    const podLabel = document.createElement('span');
    podLabel.className = 'block-count';
    podLabel.textContent = 'POD SIZE';
    const podMinInput = document.createElement('input');
    podMinInput.type = 'number';
    podMinInput.min = 1;
    podMinInput.className = 'block-hour-select';
    podMinInput.value = cc.podMin || 1;
    podMinInput.addEventListener('change', () => {
      cc.podMin = parsePositiveInt(podMinInput.value, 1);
      if ((cc.podMax || 1) < cc.podMin) {
        cc.podMax = cc.podMin;
        podMaxInput.value = cc.podMax;
      }
      podMaxInput.min = cc.podMin;
      if (opts.onChange) opts.onChange();
      saveConfigDebounced();
    });
    const podSep = document.createElement('span');
    podSep.className = 'block-count';
    podSep.textContent = 'TO';
    const podMaxInput = document.createElement('input');
    podMaxInput.type = 'number';
    podMaxInput.min = cc.podMin || 1;
    podMaxInput.className = 'block-hour-select';
    podMaxInput.value = cc.podMax || 1;
    podMaxInput.addEventListener('change', () => {
      cc.podMax = Math.max(cc.podMin || 1, parsePositiveInt(podMaxInput.value, 1));
      podMaxInput.value = cc.podMax;
      if (opts.onChange) opts.onChange();
      saveConfigDebounced();
    });
    const podSuffix = document.createElement('span');
    podSuffix.className = 'block-count';
    podSuffix.textContent = 'SPOTS PER BREAK';
    podRow.appendChild(podLabel);
    podRow.appendChild(podMinInput);
    podRow.appendChild(podSep);
    podRow.appendChild(podMaxInput);
    podRow.appendChild(podSuffix);
    panelEl.appendChild(podRow);

    if (opts.onChange) opts.onChange();
  }

  render();
}

// Per-channel override for the logo bug's placement profiles, layered over
// the box-wide DISPLAY-tab default the same way a block's ADS button
// overrides the channel default — null means "inherit."
export function buildLogoBugPanel(ch, panelEl) {
  function render() {
    panelEl.innerHTML = '';

    const inheritLabel = document.createElement('label');
    inheritLabel.className = 'shuffle-toggle';
    const inheritCheckbox = document.createElement('input');
    inheritCheckbox.type = 'checkbox';
    inheritCheckbox.checked = ch.logoBugProfiles != null;
    inheritCheckbox.addEventListener('change', () => {
      if (inheritCheckbox.checked) {
        // Seed the override starting from the box-wide default (a plain
        // copy, not a shared reference) rather than a fresh corner — the
        // channel's placement doesn't visibly change the instant OVERRIDE is
        // checked, only once actually dragged.
        const display = S.config.display || {};
        ch.logoBugProfiles = (display.logoBugProfiles || foldLogoBugCorner(null, null)).map((p) => ({ ...p }));
      } else {
        ch.logoBugProfiles = null;
      }
      applyLogoBugPlacement(ch);
      render();
      saveConfigDebounced();
    });
    inheritLabel.appendChild(inheritCheckbox);
    inheritLabel.appendChild(document.createTextNode('OVERRIDE LOGO BUG FOR THIS CHANNEL'));
    panelEl.appendChild(inheritLabel);

    if (ch.logoBugProfiles == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'USES THE BOX-WIDE LOGO SETTINGS (DISPLAY TAB)';
      panelEl.appendChild(hint);
      return;
    }

    panelEl.appendChild(buildLogoBugProfileEditor(
      () => ch.logoBugProfiles,
      (profiles) => { ch.logoBugProfiles = profiles; saveConfigDebounced(); },
      () => applyLogoBugPlacement(ch),
    ));
  }

  render();
}

// Per-channel override for dynamic-overlay rules, same inherit/override
// convention as buildLogoBugPanel above — null means "use the box-wide
// DISPLAY-tab default list."
export function buildDynamicOverlaysPanel(ch, panelEl) {
  function render() {
    panelEl.innerHTML = '';

    const inheritLabel = document.createElement('label');
    inheritLabel.className = 'shuffle-toggle';
    const inheritCheckbox = document.createElement('input');
    inheritCheckbox.type = 'checkbox';
    inheritCheckbox.checked = ch.dynamicOverlays != null;
    inheritCheckbox.addEventListener('change', () => {
      if (inheritCheckbox.checked) {
        // Seed from the box-wide default (a plain copy) so the channel's
        // effective rules don't silently change the instant OVERRIDE is
        // checked — same reasoning as buildLogoBugPanel above.
        ch.dynamicOverlays = ((S.config.display && S.config.display.dynamicOverlays) || []).map((r) => ({ ...r }));
      } else {
        ch.dynamicOverlays = null;
      }
      render();
      saveConfigDebounced();
    });
    inheritLabel.appendChild(inheritCheckbox);
    inheritLabel.appendChild(document.createTextNode('OVERRIDE DYNAMIC OVERLAYS FOR THIS CHANNEL'));
    panelEl.appendChild(inheritLabel);

    if (ch.dynamicOverlays == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'USES THE BOX-WIDE DYNAMIC OVERLAYS (DISPLAY TAB)';
      panelEl.appendChild(hint);
      return;
    }

    panelEl.appendChild(buildDynamicOverlaysEditor(
      () => ch.dynamicOverlays,
      (rules) => { ch.dynamicOverlays = rules; saveConfigDebounced(); },
    ));
  }

  render();
}

// Per-channel override for the ticker plugin's on-screen placement AND its
// content (enabled/text/speed) — two independent inherit/override toggles,
// same convention as buildLogoBugPanel/buildDynamicOverlaysPanel above:
// null means "use the box-wide default." Placement
// (ch.tickerLayout, null = inherit S.config.display.overlayLayouts
// ['ticker-bar']) reuses the same live drag/resize editor every other HUD
// overlay is edited with — openLiveLogoBugEditor's perChannelOverlay option
// points its 'ticker-bar' target at ch.tickerLayout instead of the box-wide
// list while this editor session is open. Content
// (ch.tickerContent, null = inherit S.config.ticker) is edited inline here —
// same enabled/text/speed fields as plugins/ticker/settings.js's box-wide
// PLUGINS-tab panel, just scoped to this channel.
export function buildTickerLayoutPanel(ch, panelEl) {
  function render() {
    panelEl.innerHTML = '';

    // ---------- Placement ----------
    const placementInheritLabel = document.createElement('label');
    placementInheritLabel.className = 'shuffle-toggle';
    const placementInheritCheckbox = document.createElement('input');
    placementInheritCheckbox.type = 'checkbox';
    placementInheritCheckbox.checked = ch.tickerLayout != null;
    placementInheritCheckbox.addEventListener('change', () => {
      if (placementInheritCheckbox.checked) {
        // Seed from the box-wide default (a plain copy) so the channel's
        // effective placement doesn't silently change the instant OVERRIDE
        // is checked — same reasoning as buildLogoBugPanel above.
        const boxWide = (S.config.display && S.config.display.overlayLayouts && S.config.display.overlayLayouts['ticker-bar']) || [];
        ch.tickerLayout = boxWide.map((p) => ({ ...p }));
      } else {
        ch.tickerLayout = null;
      }
      render();
      saveConfigDebounced();
    });
    placementInheritLabel.appendChild(placementInheritCheckbox);
    placementInheritLabel.appendChild(document.createTextNode('OVERRIDE TICKER PLACEMENT FOR THIS CHANNEL'));
    panelEl.appendChild(placementInheritLabel);

    if (ch.tickerLayout == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'USES THE BOX-WIDE TICKER PLACEMENT (DISPLAY TAB)';
      panelEl.appendChild(hint);
    } else {
      const explanation = document.createElement('p');
      explanation.className = 'panel-status logobug-live-description';
      explanation.textContent = 'Edit the ticker bar over the running channel. Each aspect and resolution combination keeps its own placement.';
      const liveBtn = document.createElement('button');
      liveBtn.type = 'button';
      liveBtn.className = 'btn btn-primary logobug-live-open';
      liveBtn.textContent = 'EDIT ON CURRENT CHANNEL';
      liveBtn.addEventListener('click', () => openLiveLogoBugEditor({
        getProfiles: () => ch.tickerLayout,
        setProfiles: (profiles) => { ch.tickerLayout = profiles; },
        perChannelOverlay: {
          targetId: 'ticker-bar',
          getProfiles: () => ch.tickerLayout,
          setProfiles: (profiles) => { ch.tickerLayout = profiles; },
        },
      }));
      panelEl.append(explanation, liveBtn);
    }

    const divider = document.createElement('hr');
    divider.className = 'panel-divider';
    panelEl.appendChild(divider);

    // ---------- Content ----------
    const contentInheritLabel = document.createElement('label');
    contentInheritLabel.className = 'shuffle-toggle';
    const contentInheritCheckbox = document.createElement('input');
    contentInheritCheckbox.type = 'checkbox';
    contentInheritCheckbox.checked = ch.tickerContent != null;
    contentInheritCheckbox.addEventListener('change', () => {
      if (contentInheritCheckbox.checked) {
        const boxWide = S.config.ticker || { enabled: false, text: '', speed: 30 };
        ch.tickerContent = { ...boxWide };
      } else {
        ch.tickerContent = null;
      }
      window.applyTickerState?.();
      render();
      saveConfigDebounced();
    });
    contentInheritLabel.appendChild(contentInheritCheckbox);
    contentInheritLabel.appendChild(document.createTextNode('OVERRIDE TICKER TEXT/SPEED FOR THIS CHANNEL'));
    panelEl.appendChild(contentInheritLabel);

    if (ch.tickerContent == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'USES THE BOX-WIDE TICKER TEXT/SPEED (PLUGINS TAB)';
      panelEl.appendChild(hint);
      return;
    }

    const contentBody = document.createElement('div');
    contentBody.className = 'panel-body';
    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'panel-toggle';
    const enabledEl = document.createElement('input');
    enabledEl.type = 'checkbox';
    enabledEl.checked = !!ch.tickerContent.enabled;
    enabledLabel.append(enabledEl, document.createTextNode('TEXT TICKER'));
    const textEl = document.createElement('textarea');
    textEl.className = 'pubaccess-slide-input';
    textEl.rows = 2;
    textEl.placeholder = 'Scrolling ticker text…';
    textEl.value = ch.tickerContent.text || '';
    const speedRow = document.createElement('div');
    speedRow.className = 'panel-interval';
    const speedEl = document.createElement('input');
    speedEl.type = 'number';
    speedEl.min = '5';
    speedEl.max = '120';
    speedEl.value = ch.tickerContent.speed || 30;
    speedRow.append('SPEED ', speedEl, ' SEC/LOOP (LOWER = FASTER)');
    contentBody.append(enabledLabel, textEl, speedRow);
    panelEl.appendChild(contentBody);

    enabledEl.addEventListener('change', () => {
      ch.tickerContent.enabled = enabledEl.checked;
      window.applyTickerState?.();
      saveConfigDebounced();
    });
    textEl.addEventListener('input', () => {
      ch.tickerContent.text = textEl.value;
      window.applyTickerState?.();
      saveConfigDebounced();
    });
    speedEl.addEventListener('change', () => {
      ch.tickerContent.speed = parseInt(speedEl.value, 10) || 30;
      window.applyTickerState?.();
      saveConfigDebounced();
    });
  }

  render();
}

export function buildChannelIdentityPanel(ch, panelEl) {
  panelEl.innerHTML = '';
  const identity = ch.broadcastIdentity ? { ...ch.broadcastIdentity } : {};
  const persistIdentity = () => {
    if (Object.keys(identity).length) ch.broadcastIdentity = identity;
    else delete ch.broadcastIdentity;
    saveConfigDebounced();
  };
  const intro = document.createElement('div');
  intro.className = 'titles-empty';
  intro.textContent = 'OPTIONAL CHANNEL IDENTITY OVERRIDES. LEAVE A FIELD ON INHERIT TO FOLLOW THE BOX THEME AND BOX-WIDE SIGNAL COPY.';

  function selectField(label, key, options) {
    const wrap = document.createElement('label');
    wrap.className = 'channel-identity-field';
    wrap.append(document.createTextNode(label));
    const select = document.createElement('select');
    select.className = 'block-hour-select';
    options.forEach(([value, text]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option);
    });
    select.value = identity[key] || '';
    select.addEventListener('change', () => {
      if (select.value) identity[key] = select.value; else delete identity[key];
      persistIdentity();
    });
    wrap.appendChild(select);
    return wrap;
  }

  function textOverrideField(label, key, maxLength, placeholder) {
    const wrap = document.createElement('label');
    wrap.className = 'channel-identity-field channel-identity-field-wide';
    wrap.append(document.createTextNode(label));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'title-row-input';
    input.maxLength = maxLength;
    input.placeholder = placeholder;
    input.value = typeof identity[key] === 'string' ? identity[key] : '';
    input.addEventListener('input', () => {
      const value = input.value.slice(0, maxLength);
      if (value) identity[key] = value; else delete identity[key];
      persistIdentity();
    });
    wrap.appendChild(input);
    return wrap;
  }

  const grid = document.createElement('div');
  grid.className = 'channel-identity-grid';
  grid.append(
    selectField('THEME / ERA', 'theme', [['', 'INHERIT BOX THEME'], ...themePackEntries().map((entry) => [entry.id, entry.label])]),
    selectField('TUNE SOUND', 'tuneSfx', [['', 'INHERIT THEME'], ['soft', 'SOFT CHIME'], ['analog', 'ANALOG STATIC'], ['digital', 'DIGITAL CHIRP'], ['silent', 'SILENT']]),
    selectField('TUNING STATIC', 'staticStyle', [['', 'INHERIT THEME'], ['noise', 'CLASSIC NOISE'], ['quiet', 'QUIET BLIP'], ['roll', 'VERTICAL ROLL'], ['tear', 'TEARING SIGNAL'], ['acquire', 'DIGITAL ACQUIRE']]),
    textOverrideField('NO SIGNAL HEADING', 'noSignalTitle', 48, 'INHERIT BOX HEADING'),
    textOverrideField('NO SIGNAL DETAIL', 'noSignalMessage', 120, 'INHERIT BOX DETAIL — {channel} inserts number'),
  );
  function soundOverrideField(labelText, slot) {
    const label = document.createElement('div');
    label.className = 'channel-identity-field';
    label.append(document.createTextNode(labelText));
    const status = document.createElement('span');
    status.className = 'custom-sound-status';
    const refresh = async () => {
      const value = identity.sounds && identity.sounds[slot];
      status.textContent = value === false ? 'SILENT' : (typeof value === 'string' ? await window.api.basename(value) : 'INHERIT BOX');
    };
    const actions = document.createElement('span');
    actions.className = 'channel-identity-color';
    const choose = document.createElement('button');
    choose.type = 'button'; choose.className = 'btn'; choose.textContent = 'CHOOSE…';
    choose.disabled = !window.api.selectAudio;
    choose.addEventListener('click', async () => {
      const path = await window.api.selectAudio();
      if (!path) return;
      identity.sounds = { ...(identity.sounds || {}), [slot]: path };
      persistIdentity(); refresh();
    });
    const inherit = document.createElement('button');
    inherit.type = 'button'; inherit.className = 'btn'; inherit.textContent = 'INHERIT';
    inherit.addEventListener('click', () => {
      if (identity.sounds) delete identity.sounds[slot];
      if (identity.sounds && !Object.keys(identity.sounds).length) delete identity.sounds;
      persistIdentity(); refresh();
    });
    const silent = document.createElement('button');
    silent.type = 'button'; silent.className = 'btn'; silent.textContent = 'SILENT';
    silent.addEventListener('click', () => {
      identity.sounds = { ...(identity.sounds || {}), [slot]: false };
      persistIdentity(); refresh();
    });
    actions.append(choose, inherit, silent);
    label.append(status, actions);
    refresh();
    return label;
  }
  grid.append(
    soundOverrideField('CUSTOM TUNE SOUND', 'channelTune'),
    soundOverrideField('CUSTOM CARD SOUND', 'card'),
  );
  [['PRIMARY ACCENT', 'accent'], ['SECONDARY ACCENT', 'accent2'], ['STATIC TINT', 'staticTint']].forEach(([labelText, key]) => {
    const label = document.createElement('label');
    label.className = 'channel-identity-field';
    label.append(document.createTextNode(labelText));
    const input = document.createElement('input');
    input.type = 'color'; input.value = identity[key] || (key === 'accent2' ? '#56d9ff' : '#f4cf3f');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.checked = !!identity[key]; enabled.title = `Override ${labelText.toLowerCase()}`;
    const row = document.createElement('span'); row.className = 'channel-identity-color'; row.append(enabled, input);
    const commit = () => { if (enabled.checked) identity[key] = input.value; else delete identity[key]; persistIdentity(); };
    enabled.addEventListener('change', commit); input.addEventListener('input', () => { enabled.checked = true; commit(); });
    label.appendChild(row); grid.appendChild(label);
  });
  const clear = document.createElement('button');
  clear.className = 'btn'; clear.textContent = 'CLEAR ALL IDENTITY OVERRIDES';
  clear.addEventListener('click', () => { delete ch.broadcastIdentity; buildChannelIdentityPanel(ch, panelEl); saveConfigDebounced(); });
  panelEl.append(intro, grid, clear);
}
