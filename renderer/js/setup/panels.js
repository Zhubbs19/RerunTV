// Per-channel edit-tab panels that don't need their own module: TITLES,
// FOLDERS, ADS (commercials), LOGO, and the THEME placeholder. SCHEDULE +
// CALENDAR live in setup-schedule.js (they're bigger and share a lot of
// row-editing code); channel-list/bulk-action rendering lives in
// setup-channels.js.
import { foldLogoBugCorner, freshCommercialsConfig, freshFileFacets, mirrorFacetsIntoTags, parseMediaRef } from '../core/channels.js';
import { applyLogoBugPlacement } from '../playback/broadcast-fx.js';
import { themePackEntries, titleRowActionEntries } from '../plugin/host.js';
import { removeFolderFromChannel } from './channels.js';
import { S, commitInPlace, dispatch, viewNow } from '../core/state.js';
import { basenameNoExt, formatDuration, guessCleanTitle, randomId, stripReleaseTags, suggestFacetsFromPath } from '../core/util.js';
import {
  attachTagAutocomplete, buildBreakpointTrack, commitOwnerFields, buildDynamicOverlaysEditor, buildIconOverridesEditor, buildLogoBugProfileEditor,
  buildMediaThumbnail, openLiveLogoBugEditor, parsePositiveInt,
} from './util.js';
import { confirmDialog, alertDialog, promptDialog } from './dialogs.js';
import { fileAtOrder, folderFileOrder, naturalFileOrder, seededFileOrder } from '../playback/order.js';

// Downloads a mediaSource-plugin file's full bytes to a local folder (via
// main-media-dispatch.js's media:downloadFile, which loops the provider's
// own readRange the same way live playback already does — no plugin-side
// change needed), then repoints this one file entry to the resulting real
// local path. From that point on it plays as a genuine local file: no more
// network dependency, and it becomes eligible for FIX PLAYBACK the way a
// plugin-sourced file never is (media:resolvePlayablePath's
// transcodable:false).
//
// `target` is whatever the destination directory gets remembered on — same
// "just needs a .files array" shape this whole panel already treats
// uniformly (a channel or a block), so a block gets its own remembered
// download directory too rather than needing special-casing here. Asked
// once per target, not once per file: the first download on a given
// channel/block prompts for a folder, every later one just reuses it.
async function downloadFileToLocal(target, file, btn) {
  if (btn.disabled) return;
  let destDir = target.downloadDir;
  if (!destDir) {
    destDir = await window.api.selectFolder();
    if (!destDir) return;
    target.downloadDir = destDir;
    commitOwnerFields(target, ['downloadDir']);
  }
  const { source, ref } = parseMediaRef(file.path);
  if (!source || source === 'local') return; // the button is only ever shown for a non-local file — defensive only

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'DOWNLOADING…';

  function formatProgress(payload) {
    if (payload.totalBytes) return `DOWNLOADING… ${Math.min(99, Math.round((payload.downloadedBytes / payload.totalBytes) * 100))}%`;
    return `DOWNLOADING… ${(payload.downloadedBytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  const unsubscribe = window.api.onMediaDownloadProgress((payload) => {
    if (payload.source !== source || payload.ref !== ref) return;
    btn.textContent = formatProgress(payload);
  });

  try {
    const result = await window.api.downloadMediaFile(source, ref, destDir, file.title || null);
    if (!result || result.error) {
      await alertDialog({ title: 'DOWNLOAD FAILED', message: (result && result.error) || 'Unknown error.' });
      btn.disabled = false;
      btn.textContent = originalText;
      return;
    }
    file.path = result.path;
    file.source = 'local';
    // Detach from whatever remote folder this file came from — a future
    // library-sync rescan of that folder (library-sync.js) compares its own
    // provider refs against tracked files' CURRENT path, and this file's
    // path is no longer that provider's ref at all now that it's a real
    // local copy. Leaving `folder` pointed at it would make the sync think
    // the original ref went missing while the provider still reports it
    // present — this file is standalone from here on, same as one added
    // without going through any tracked folder at all.
    file.folder = null;
    commitOwnerFields(target, ['files'], { label: 'Download file' });
    btn.textContent = 'DOWNLOADED ✓';
  } catch (e) {
    await alertDialog({ title: 'DOWNLOAD FAILED', message: e.message || 'Unknown error.' });
    btn.disabled = false;
    btn.textContent = originalText;
  } finally {
    unsubscribe();
  }
}

// Per-file metadata edits go through file.set (commands.js): one named undo
// step per user action, however many files it touches. `target` is the
// channel or schedule block whose pool the files are in, found in S.config by
// identity. `fieldsFor(file)` returns the fields to set on that file, or null
// to leave it alone. Returns whether anything changed.
function setFileFields(target, files, fieldsFor, opts = {}) {
  const changes = files.map((file) => [file, fieldsFor(file)]).filter(([, fields]) => fields);
  if (!changes.length) return false;
  const channels = (S.config && S.config.channels) || [];
  let address = null;
  if (channels.includes(target)) {
    address = { channel: target.number };
  } else {
    const owner = channels.find((ch) => (ch.blocks || []).includes(target));
    if (owner && target.id) address = { channel: owner.number, block: target.id };
  }
  // file.set finds a file by path, so a pool holding the same path twice (or
  // a panel for something no longer in config) keeps the in-place edit.
  const ambiguous = changes.some(([file]) => (target.files || []).filter((f) => f.path === file.path).length !== 1);
  if (!address || ambiguous) {
    changes.forEach(([file, fields]) => Object.assign(file, fields));
    commitOwnerFields(target, ['files'], opts);
    return true;
  }
  dispatch(changes.map(([file, fields]) => ({ type: 'file.set', ...address, file: file.path, fields })), opts);
  return true;
}

// The facets a file would have after `mutate`, and the tags mirrored from
// them (mirrorFacetsIntoTags), without touching the file itself.
function facetFields(file, mutate) {
  const next = {
    facets: JSON.parse(JSON.stringify(file.facets || freshFileFacets())),
    tags: file.tags ? [...file.tags] : file.tags,
  };
  mutate(next.facets);
  mirrorFacetsIntoTags(next);
  return next;
}

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
    commitOwnerFields(target, ['files', 'anchor'], { label: actionLabel });
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
    const numberOf = new Map(ordered.map((f, i) => [f, i + 1]));
    setFileFields(target, ordered, (f) => ({
      title: template.includes('{n}') ? template.replace(/\{n\}/g, String(numberOf.get(f))) : template,
    }), { label: `Set title for ${ordered.length} file${ordered.length === 1 ? '' : 's'}` });
    bulkTitleInput.value = '';
    renderRows(search.value);
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
    setFileFields(target, Array.from(selected), (f) => ({ tags: Array.from(new Set([...(f.tags || []), ...toAdd])) }),
      { label: `Tag ${selected.size} file${selected.size === 1 ? '' : 's'}` });
    bulkTagInput.value = '';
    renderRows(search.value);
  });

  const bulkClearTagsBtn = document.createElement('button');
  bulkClearTagsBtn.type = 'button';
  bulkClearTagsBtn.className = 'btn remove-btn';
  bulkClearTagsBtn.textContent = 'CLEAR TAGS FROM SELECTED';
  bulkClearTagsBtn.addEventListener('click', async () => {
    if (!selected.size) return;
    if (!(await confirmDialog(`Remove all tags from ${selected.size} selected file(s)?`))) return;
    setFileFields(target, Array.from(selected), () => ({ tags: null }), { label: `Clear tags from ${selected.size} file${selected.size === 1 ? '' : 's'}` });
    renderRows(search.value);
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
    setFileFields(target, files, (f) => ({ title: stripReleaseTags(basenameNoExt(f.path)) }), { label: 'Strip release tags' });
    renderRows(search.value);
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
    const touched = setFileFields(target, Array.from(selected), (f) => {
      const suggestion = suggestFacetsFromPath(f.path);
      if (!suggestion.genre.length && !suggestion.era && !suggestion.contentType) return null;
      let changed = false;
      const fields = facetFields(f, (facets) => {
        if (suggestion.genre.length && !facets.genre.length) { facets.genre = suggestion.genre; changed = true; }
        if (suggestion.era && !facets.era) { facets.era = suggestion.era; changed = true; }
        if (suggestion.contentType && !facets.contentType) { facets.contentType = suggestion.contentType; changed = true; }
      });
      return changed ? fields : null;
    }, { label: 'Suggest facets' });
    if (!touched) {
      alertDialog('No new facet suggestions for the selected files — either nothing in their paths matched, or they already have every facet set.');
      return;
    }
    renderRows(search.value);
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
    setFileFields(target, Array.from(selected), (f) => facetFields(f, (facets) => {
      if (genresToAdd.length) facets.genre = Array.from(new Set([...facets.genre, ...genresToAdd]));
      if (moodsToAdd.length) facets.mood = Array.from(new Set([...facets.mood, ...moodsToAdd]));
      if (era) facets.era = era;
      if (contentType) facets.contentType = contentType;
    }), { label: `Set facets on ${selected.size} file${selected.size === 1 ? '' : 's'}` });
    bulkGenreInput.value = ''; bulkMoodInput.value = ''; bulkEraInput.value = ''; bulkContentTypeSelect.value = '';
    renderRows(search.value);
  });

  const bulkFacetsClearBtn = document.createElement('button');
  bulkFacetsClearBtn.type = 'button';
  bulkFacetsClearBtn.className = 'btn remove-btn';
  bulkFacetsClearBtn.textContent = 'CLEAR FACETS FROM SELECTED';
  bulkFacetsClearBtn.title = 'Resets each selected file\'s structured facets. Leaves the free TAGS field alone — any tags a facet previously contributed there stay unless removed by hand.';
  bulkFacetsClearBtn.addEventListener('click', async () => {
    if (!selected.size) return;
    if (!(await confirmDialog(`Clear facets (genre/mood/era/content type) from ${selected.size} selected file(s)? Their free TAGS field is left untouched.`))) return;
    setFileFields(target, Array.from(selected), () => ({ facets: freshFileFacets() }), { label: `Clear facets from ${selected.size} file${selected.size === 1 ? '' : 's'}` });
    renderRows(search.value);
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
  list.className = 'titles-list title-rows-list';

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

  // In-flow virtualization (docs/design/03 §4): rows are built a chunk at a
  // time as the list nears the bottom of the page. Every row carries a video
  // thumbnail and a dozen inputs, and a 1,300-file channel used to take over a
  // second (80,000 nodes) to open. Filtering, select-all and reordering work on
  // the data, so they see every file whether its row is built yet or not.
  const TITLE_ROW_CHUNK = 60;
  let rowObserver = null;

  function renderRows(filter) {
    list.innerHTML = '';
    if (rowObserver) { rowObserver.disconnect(); rowObserver = null; }
    const q = filter.trim().toLowerCase();
    const visibleFiles = target.files.filter((file) => {
      const base = basenameNoExt(file.path);
      const tags = file.tags || [];
      return !q || base.toLowerCase().includes(q) || (file.title || '').toLowerCase().includes(q) || tags.some((t) => t.includes(q));
    });

    const buildRow = (file) => {
      const base = basenameNoExt(file.path);
      const tags = file.tags || [];

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
        setFileFields(target, [file], () => ({ title: input.value }), { coalesce: `file:${file.path}:title` });
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
        setFileFields(target, [file], () => ({ tags: parsed.length ? parsed : null }));
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
        setFileFields(target, [file], () => ({ description: descInput.value }), { coalesce: `file:${file.path}:description` });
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
        setFileFields(target, [file], () => facetFields(file, mutate));
        tagsInput.value = (file.tags || []).join(', ');
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

      // Per-file rating override (channels.js's ch.rating is channel-wide;
      // this lets a mixed-content channel, e.g. a movie channel airing both
      // PG and PG-13 titles, show the right rating bug per title — see the
      // fallback chain in playback.js's tune-time rating check and
      // pin-lock.js's parental lock, both of which prefer this over
      // ch.rating when set). Blank = inherit the channel-wide rating,
      // exactly today's behavior.
      const ratingSelect = document.createElement('select');
      ratingSelect.className = 'rating-select';
      ['INHERIT CHANNEL RATING', 'NONE', 'TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'].forEach((label) => {
        const opt = document.createElement('option');
        opt.value = label === 'INHERIT CHANNEL RATING' ? '' : (label === 'NONE' ? 'NONE' : label);
        opt.textContent = label;
        ratingSelect.appendChild(opt);
      });
      ratingSelect.value = file.rating || '';
      ratingSelect.addEventListener('change', () => {
        setFileFields(target, [file], () => ({ rating: ratingSelect.value || null }));
      });

      // Content advisory disclaimer — distinct from the rating VALUE above:
      // free text like "CONTAINS SCENES OF A GRAPHIC NATURE" or "EDITED FOR
      // CONTENT AND TO FIT THE TIME ALLOTTED", flashed as its own full-width
      // card once per airing (see flashContentAdvisory, playback.js) rather
      // than folded into the rating bug's small badge. Blank = none for this
      // file, same "explicit opt-in per file" shape as localAvail entries.
      const advisoryInput = document.createElement('input');
      advisoryInput.type = 'text';
      advisoryInput.className = 'title-row-input';
      advisoryInput.placeholder = 'CONTENT ADVISORY (BLANK = NONE)';
      advisoryInput.title = 'Shown as its own disclaimer card once per airing, e.g. "CONTAINS SCENES OF A GRAPHIC NATURE" or "EDITED FOR CONTENT AND TO FIT THE TIME ALLOTTED".';
      advisoryInput.value = file.advisory || '';
      advisoryInput.addEventListener('change', () => {
        setFileFields(target, [file], () => ({ advisory: advisoryInput.value.trim() || null }));
      });

      // Mid-program scene-specific cues — same disclaimer card as
      // ADVISORY above (flashContentAdvisory, playback.js), just fired at
      // specific timestamps within this file instead of once at start. One
      // "TIME TEXT" pair per line rather than a full add/remove row list —
      // this row is already dense and can render for every file in a
      // channel, so a single compact textarea keeps the per-file DOM cost
      // flat regardless of how many files have cues.
      const cuesInput = document.createElement('textarea');
      cuesInput.className = 'title-row-input';
      cuesInput.rows = 2;
      cuesInput.placeholder = 'SCENE CUES, ONE PER LINE: "12:30 CONTAINS FLASHING LIGHTS"';
      cuesInput.title = 'Mid-program content warnings at specific timestamps ("M:SS text" or "H:MM:SS text" per line), shown via the same disclaimer card as ADVISORY above.';
      cuesInput.value = (file.advisoryCues || []).map((c) => `${formatDuration(c.offsetS)} ${c.text}`).join('\n');
      cuesInput.addEventListener('change', () => {
        const advisoryCues = cuesInput.value.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const m = line.match(/^(\d+):(\d{2})(?::(\d{2}))?\s+(.+)$/);
          if (!m) return null;
          const offsetS = m[3]
            ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
            : parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
          return { id: randomId('cue'), offsetS, text: m[4] };
        }).filter(Boolean);
        setFileFields(target, [file], () => ({ advisoryCues }));
      });

      // End-credits speedup override (ch.creditsSpeedup's channel-wide
      // default, setup-panels.js's buildCreditsSpeedupPanel) — blank
      // inherits that default; 0 explicitly opts THIS file out even when
      // the channel has speedup enabled, same "explicit value always wins,
      // blank inherits" shape as rating's 'NONE' sentinel above.
      const creditsLeadInput = document.createElement('input');
      creditsLeadInput.type = 'number';
      creditsLeadInput.min = 0;
      creditsLeadInput.className = 'title-row-input';
      creditsLeadInput.placeholder = 'CREDITS LEAD (SEC, BLANK = CHANNEL DEFAULT)';
      creditsLeadInput.title = 'Seconds before this file ends where its credits start — overrides the channel\'s default lead time. 0 disables the speedup for this file specifically.';
      creditsLeadInput.value = file.creditsLeadS != null ? file.creditsLeadS : '';
      creditsLeadInput.addEventListener('change', () => {
        setFileFields(target, [file], () => ({ creditsLeadS: creditsLeadInput.value.trim() === '' ? null : parsePositiveInt(creditsLeadInput.value, 0) }));
      });

      const creditsBgBtn = document.createElement('button');
      creditsBgBtn.type = 'button';
      creditsBgBtn.className = 'btn';
      creditsBgBtn.title = 'This title\'s own UP NEXT card backdrop during the credits squeeze, instead of the channel\'s default.';
      creditsBgBtn.textContent = file.creditsSqueezeBgImage ? basenameNoExt(file.creditsSqueezeBgImage) : 'CREDITS BACKDROP…';
      creditsBgBtn.addEventListener('click', async () => {
        const path = await window.api.selectImage();
        if (!path) return;
        setFileFields(target, [file], () => ({ creditsSqueezeBgImage: path }));
        creditsBgBtn.textContent = basenameNoExt(path);
      });

      facetsRow.appendChild(genreWrap);
      facetsRow.appendChild(moodWrap);
      facetsRow.appendChild(eraInput);
      facetsRow.appendChild(contentTypeSelect);
      // CC/SAP/STEREO capability badge — manually curator-tagged, same as
      // rating/contentType/advisory, rather than auto-detected: neither the
      // closed-captions nor sap-audio plugin exposes queryable per-file
      // state today, and nothing classifies mono/stereo at all, so building
      // this on native track auto-detection would mean adding unreliable
      // new plumbing to two already-shipped plugins for one small badge.
      // Tri-state per field (null = inherit the channel's default*Enabled
      // setting, true/false = explicit override for this file) — same
      // "blank inherits, explicit value always wins" shape as rating's
      // INHERIT/NONE/value select above, resolved at playback time in
      // playback.js's onMeta (not displayed here, same as rating).
      const capabilityWrap = document.createElement('span');
      capabilityWrap.className = 'title-row-capabilities';
      [['hasCC', 'CC'], ['hasSAP', 'SAP'], ['hasStereo', 'STEREO']].forEach(([field, label]) => {
        const capSelect = document.createElement('select');
        capSelect.className = 'block-hour-select';
        capSelect.title = `${label}: INHERIT uses the channel's default (its DEFAULT ${label} option toggle), YES/NO overrides it for this file specifically.`;
        [['', `${label} (INHERIT)`], ['yes', `${label}: YES`], ['no', `${label}: NO`]].forEach(([value, text]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = text;
          capSelect.appendChild(opt);
        });
        capSelect.value = file[field] === true ? 'yes' : file[field] === false ? 'no' : '';
        capSelect.addEventListener('change', () => {
          setFileFields(target, [file], () => ({ [field]: capSelect.value === '' ? null : capSelect.value === 'yes' }));
        });
        capabilityWrap.appendChild(capSelect);
      });

      facetsRow.appendChild(ratingSelect);
      facetsRow.appendChild(advisoryInput);
      facetsRow.appendChild(cuesInput);
      facetsRow.appendChild(capabilityWrap);
      facetsRow.appendChild(creditsLeadInput);
      facetsRow.appendChild(creditsBgBtn);

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

      // A core action (not plugin-contributed, hence not going through
      // registerTitleRowAction like the cells above) — every mediaSource
      // provider already implements the readRange verb this downloads via,
      // so this works identically for archive/webdav/jellyfin/gdrive with
      // no per-plugin code. Reuses the same title-row-plugin-cell styling
      // for visual consistency with the row's other action cells.
      if (file.source && file.source !== 'local') {
        const downloadCell = document.createElement('div');
        downloadCell.className = 'title-row-plugin-cell';
        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'btn btn-small';
        downloadBtn.textContent = 'DOWNLOAD';
        downloadBtn.title = 'Download this file to a local folder. Once complete, it plays as a real local file — no more network dependency.';
        downloadBtn.addEventListener('click', () => downloadFileToLocal(target, file, downloadBtn));
        downloadCell.appendChild(downloadBtn);
        row.appendChild(downloadCell);
      }

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
    };

    let built = 0;
    const sentinel = document.createElement('div');
    sentinel.className = 'title-rows-more';
    const buildMore = () => {
      sentinel.remove();
      const end = Math.min(built + TITLE_ROW_CHUNK, visibleFiles.length);
      for (; built < end; built += 1) buildRow(visibleFiles[built]);
      if (built >= visibleFiles.length) return;
      sentinel.textContent = `Showing ${built} of ${visibleFiles.length} — scroll for more`;
      list.appendChild(sentinel);
      // Re-observing reports the sentinel's position straight away, so a
      // sentinel still inside the margin builds the next chunk too.
      if (rowObserver) { rowObserver.unobserve(sentinel); rowObserver.observe(sentinel); }
    };
    buildMore();
    if (built < visibleFiles.length && typeof IntersectionObserver === 'function') {
      rowObserver = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting) && sentinel.isConnected) buildMore();
      }, { root: document.getElementById('setup-content'), rootMargin: '0px 0px 1200px 0px' });
      rowObserver.observe(sentinel);
    }
    if (visibleFiles.length === 0) {
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
    commitOwnerFields(ch, ['adsEnabled']);
  });
  enabledLabel.appendChild(enabledCheckbox);
  enabledLabel.appendChild(document.createTextNode('ADS ENABLED ON THIS CHANNEL'));
  panelEl.appendChild(enabledLabel);

  const hint = document.createElement('div');
  hint.className = 'titles-empty';
  hint.textContent = 'AD TIMING, BREAKS, POD SIZE, AND BUMPER POOL ARE CONFIGURED IN PROGRAMMING (CADENCE & PRESETS; ADVANCED FLOWS WHEN NEEDED). THIS TOGGLE IS A GLOBAL KILL-SWITCH FOR ADS ON THIS CHANNEL ONLY.';
  panelEl.appendChild(hint);

  // Channel-wide content tags — applied to EVERY file on this channel, on
  // top of that file's own tags, wherever an ad-pool entry/preset/flow
  // checks content tags (interstitials.js's effectiveContentTags). Exists
  // for a themed channel (a 24/7 holiday-movies channel, say) where tagging
  // every individual file the same way would be pure busywork when a preset
  // or pool entry just wants to target "this channel's content."
  const tagsLabel = document.createElement('div');
  tagsLabel.className = 'flow-label';
  tagsLabel.textContent = 'CHANNEL CONTENT TAGS (APPLY TO EVERY FILE ON THIS CHANNEL)';
  panelEl.appendChild(tagsLabel);

  const tagsInput = document.createElement('input');
  tagsInput.type = 'text';
  tagsInput.className = 'title-row-input';
  tagsInput.placeholder = 'e.g. christmas-ad, holiday';
  tagsInput.value = (ch.contentTags || []).join(', ');
  tagsInput.addEventListener('change', () => {
    ch.contentTags = tagsInput.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    commitOwnerFields(ch, ['contentTags']);
  });
  panelEl.appendChild(attachTagAutocomplete(tagsInput));

  const tagsHint = document.createElement('div');
  tagsHint.className = 'titles-empty';
  tagsHint.textContent = 'MATCHES AD-POOL ENTRIES, PRESETS, AND FLOWS THAT TARGET CONTENT TAGS — NO NEED TO TAG EVERY FILE INDIVIDUALLY.';
  panelEl.appendChild(tagsHint);
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
        commitOwnerFields(owner, ['commercials']);
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
      commitOwnerFields(owner, ['commercials']);
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
      commitOwnerFields(owner, ['commercials']);
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
        commitOwnerFields(owner, ['commercials']);
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
        commitOwnerFields(owner, ['commercials']);
        render(); // re-syncs the drag track below to whatever was just typed
      });
      bpRow.appendChild(bpLabel);
      bpRow.appendChild(bpInput);
      panelEl.appendChild(bpRow);

      const track = buildBreakpointTrack(
        () => cc.breakpoints,
        (pts) => { cc.breakpoints = pts; commitOwnerFields(owner, ['commercials'], { coalesce: 'commercials:breakpoints' }); },
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
      commitOwnerFields(owner, ['commercials']);
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
      commitOwnerFields(owner, ['commercials']);
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

    // Per-channel/block "no repeats" overrides of the box-wide switches
    // (SETTINGS › Break cadence). Unset inherits.
    [
      ['noRepeatCommercials', 'NO REPEAT ADS'],
      ['noRepeatBumpers', 'NO REPEAT BUMPERS'],
      ['noRepeatInterstitials', 'NO REPEAT INTERSTITIALS'],
    ].forEach(([key, label]) => {
      const row = document.createElement('div');
      row.className = 'block-row';
      const text = document.createElement('span');
      text.className = 'block-count';
      text.textContent = label;
      const select = document.createElement('select');
      select.className = 'block-hour-select';
      [['', 'BOX DEFAULT'], ['on', 'ON'], ['off', 'OFF']].forEach(([value, name]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = name;
        select.appendChild(opt);
      });
      select.value = cc[key] === true ? 'on' : cc[key] === false ? 'off' : '';
      select.addEventListener('change', () => {
        if (select.value === '') delete cc[key];
        else cc[key] = select.value === 'on';
        commitOwnerFields(owner, ['commercials']);
      });
      row.appendChild(text);
      row.appendChild(select);
      panelEl.appendChild(row);
    });

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
      commitOwnerFields(ch, ['logoBugProfiles']);
    });
    inheritLabel.appendChild(inheritCheckbox);
    inheritLabel.appendChild(document.createTextNode('OVERRIDE LOGO BUG FOR THIS CHANNEL'));
    panelEl.appendChild(inheritLabel);

    // Some real networks drop their corner bug during commercial/bumper
    // breaks, some keep it up through them — independent of placement
    // override above, so it works whether or not this channel overrides the
    // box-wide profile. Default off (today's "always visible" behavior).
    const hideOnBreakLabel = document.createElement('label');
    hideOnBreakLabel.className = 'shuffle-toggle';
    const hideOnBreakCheckbox = document.createElement('input');
    hideOnBreakCheckbox.type = 'checkbox';
    hideOnBreakCheckbox.checked = !!ch.logoBugHidesOnBreak;
    hideOnBreakCheckbox.addEventListener('change', () => {
      ch.logoBugHidesOnBreak = hideOnBreakCheckbox.checked;
      commitOwnerFields(ch, ['logoBugHidesOnBreak']);
    });
    hideOnBreakLabel.appendChild(hideOnBreakCheckbox);
    hideOnBreakLabel.appendChild(document.createTextNode('HIDE LOGO BUG DURING BREAKS'));
    panelEl.appendChild(hideOnBreakLabel);

    // Seasonal icon overrides (ch.iconOverrides, channels.js) — independent
    // of the placement-override checkbox above, since the icon is always
    // per-channel to begin with (no box-wide default icon to inherit from).
    const seasonalHeading = document.createElement('div');
    seasonalHeading.className = 'panel-toggle';
    seasonalHeading.textContent = 'SEASONAL ICON OVERRIDES';
    panelEl.appendChild(seasonalHeading);
    panelEl.appendChild(buildIconOverridesEditor(
      () => ch.iconOverrides,
      (overrides) => {
        ch.iconOverrides = overrides;
        commitInPlace({ type: 'channel.set', channel: ch.number, field: 'iconOverrides', value: overrides }, { coalesce: `ch:${ch.number}:iconOverrides` });
        applyLogoBugPlacement(ch);
      },
    ));

    if (ch.logoBugProfiles == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'USES THE BOX-WIDE LOGO SETTINGS (GUIDE & THEME)';
      panelEl.appendChild(hint);
      return;
    }

    panelEl.appendChild(buildLogoBugProfileEditor(
      () => ch.logoBugProfiles,
      (profiles) => {
        ch.logoBugProfiles = profiles;
        commitInPlace({ type: 'channel.set', channel: ch.number, field: 'logoBugProfiles', value: profiles }, { coalesce: `ch:${ch.number}:logoBugProfiles` });
      },
      () => applyLogoBugPlacement(ch),
      ch,
    ));
  }

  render();
}

// End-credits speedup — a real syndicated-TV trick: fast-forward (muted)
// through a movie's last stretch once its credits begin, squeezing the
// picture over to make room for an "UP NEXT" card, then resume normal speed
// for whatever airs next (playback.js's scheduleCreditsSpeedup/
// startCreditsSpeedup). Per-file overrides (creditsLeadS, 0 = never for
// that file) live in the TITLES tab's facets row instead, next to `rating` —
// this panel is only the channel-wide default.
export function buildCreditsSpeedupPanel(ch, panelEl) {
  function render() {
    panelEl.innerHTML = '';
    if (!ch.creditsSpeedup) ch.creditsSpeedup = { enabled: false, leadSeconds: 90, rate: 3, squeezeMode: 'text', squeezeBgImage: null };
    const cfg = ch.creditsSpeedup;

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'shuffle-toggle';
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = !!cfg.enabled;
    enabledCheckbox.addEventListener('change', () => {
      cfg.enabled = enabledCheckbox.checked;
      render();
      commitOwnerFields(ch, ['creditsSpeedup']);
    });
    enabledLabel.appendChild(enabledCheckbox);
    enabledLabel.appendChild(document.createTextNode('SPEED UP END CREDITS'));
    panelEl.appendChild(enabledLabel);

    const hint = document.createElement('span');
    hint.className = 'panel-status';
    hint.textContent = 'Fast-forwards (muted) through the last stretch of a file once its credits begin, squeezing the picture aside for an UP NEXT card, then resumes normal speed for whatever airs next. A specific title can opt out (or set its own lead time) from the TITLES tab.';
    panelEl.appendChild(hint);

    if (!cfg.enabled) return;

    const grid = document.createElement('div');
    grid.className = 'field-grid';

    const leadInput = document.createElement('input');
    leadInput.type = 'number';
    leadInput.min = 1;
    leadInput.className = 'block-priority-input';
    leadInput.title = 'How many seconds before a file ends its credits are assumed to start, by default — a specific title can override this.';
    leadInput.value = cfg.leadSeconds || 90;
    leadInput.addEventListener('change', () => {
      cfg.leadSeconds = parsePositiveInt(leadInput.value, 90);
      commitOwnerFields(ch, ['creditsSpeedup']);
    });
    grid.appendChild(leadInput);
    const leadLabel = document.createElement('span');
    leadLabel.className = 'option-label';
    leadLabel.textContent = 'DEFAULT LEAD TIME (SEC BEFORE END)';
    grid.insertBefore(leadLabel, leadInput);

    const rateInput = document.createElement('input');
    rateInput.type = 'number';
    rateInput.min = 2;
    rateInput.max = 8;
    rateInput.className = 'block-priority-input';
    rateInput.title = 'Playback speed multiplier during the sped-up stretch.';
    rateInput.value = cfg.rate || 3;
    rateInput.addEventListener('change', () => {
      cfg.rate = Math.max(2, parsePositiveInt(rateInput.value, 3));
      commitOwnerFields(ch, ['creditsSpeedup']);
    });
    grid.appendChild(rateInput);
    const rateLabel = document.createElement('span');
    rateLabel.className = 'option-label';
    rateLabel.textContent = 'SPEED (×)';
    grid.insertBefore(rateLabel, rateInput);

    panelEl.appendChild(grid);

    // What fills the space #player's squeeze transform frees up. 'text' (the
    // original, still the default) is a static UP NEXT card; 'video' plays a
    // real, audible upNext-pool promo instead (startCreditsSpeedup falls
    // back to the text card if nothing eligible resolves in the pool for
    // this channel, so switching to VIDEO is never a silent no-op).
    const modeLabel = document.createElement('span');
    modeLabel.className = 'option-label';
    modeLabel.textContent = 'UP NEXT PANEL';
    panelEl.appendChild(modeLabel);
    const modeSelect = document.createElement('select');
    modeSelect.className = 'block-hour-select';
    [['text', 'TEXT CARD'], ['video', 'REAL PROMO VIDEO (FROM POOL)']].forEach(([value, label]) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      modeSelect.appendChild(opt);
    });
    modeSelect.value = cfg.squeezeMode === 'video' ? 'video' : 'text';
    modeSelect.addEventListener('change', () => {
      cfg.squeezeMode = modeSelect.value;
      render();
      commitOwnerFields(ch, ['creditsSpeedup']);
    });
    panelEl.appendChild(modeSelect);

    // Channel-wide default backdrop for the squeeze panel — a specific
    // title can override this from the TITLES tab; blank at both levels
    // falls back to a plain card tinted with this channel's own accent
    // color (startCreditsSpeedup, playback.js). Only relevant in TEXT mode.
    if (cfg.squeezeMode !== 'video') {
      const bgBtn = document.createElement('button');
      bgBtn.type = 'button';
      bgBtn.className = 'btn';
      bgBtn.textContent = cfg.squeezeBgImage ? basenameNoExt(cfg.squeezeBgImage) : 'UP NEXT CARD BACKDROP…';
      bgBtn.addEventListener('click', async () => {
        const path = await window.api.selectImage();
        if (!path) return;
        cfg.squeezeBgImage = path;
        render();
        commitOwnerFields(ch, ['creditsSpeedup']);
      });
      panelEl.appendChild(bgBtn);
      if (cfg.squeezeBgImage) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'btn remove-btn';
        clearBtn.textContent = 'CLEAR BACKDROP';
        clearBtn.addEventListener('click', () => {
          cfg.squeezeBgImage = null;
          render();
          commitOwnerFields(ch, ['creditsSpeedup']);
        });
        panelEl.appendChild(clearBtn);
      }
    }
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
      commitOwnerFields(ch, ['dynamicOverlays']);
    });
    inheritLabel.appendChild(inheritCheckbox);
    inheritLabel.appendChild(document.createTextNode('OVERRIDE DYNAMIC OVERLAYS FOR THIS CHANNEL'));
    panelEl.appendChild(inheritLabel);

    if (ch.dynamicOverlays == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'USES THE BOX-WIDE DYNAMIC OVERLAYS (GUIDE & THEME)';
      panelEl.appendChild(hint);
      return;
    }

    panelEl.appendChild(buildDynamicOverlaysEditor(
      () => ch.dynamicOverlays,
      (rules) => {
        ch.dynamicOverlays = rules;
        commitInPlace({ type: 'channel.set', channel: ch.number, field: 'dynamicOverlays', value: rules }, { coalesce: `ch:${ch.number}:dynamicOverlays` });
      },
      ch,
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
      commitOwnerFields(ch, ['tickerLayout']);
    });
    placementInheritLabel.appendChild(placementInheritCheckbox);
    placementInheritLabel.appendChild(document.createTextNode('OVERRIDE TICKER PLACEMENT FOR THIS CHANNEL'));
    panelEl.appendChild(placementInheritLabel);

    if (ch.tickerLayout == null) {
      const hint = document.createElement('div');
      hint.className = 'titles-empty';
      hint.textContent = 'USES THE BOX-WIDE TICKER PLACEMENT (GUIDE & THEME)';
      panelEl.appendChild(hint);
    } else {
      const explanation = document.createElement('p');
      explanation.className = 'panel-status logobug-live-description';
      explanation.textContent = `Edit the ticker bar on channel ${ch.number}. Each aspect and resolution combination keeps its own placement.`;
      const liveBtn = document.createElement('button');
      liveBtn.type = 'button';
      liveBtn.className = 'btn btn-primary logobug-live-open';
      liveBtn.textContent = `TUNE TO CHANNEL ${ch.number} & EDIT`;
      liveBtn.addEventListener('click', () => openLiveLogoBugEditor({
        getProfiles: () => ch.tickerLayout,
        setProfiles: (profiles) => { ch.tickerLayout = profiles; },
        perChannelOverlay: {
          targetId: 'ticker-bar',
          getProfiles: () => ch.tickerLayout,
          setProfiles: (profiles) => { ch.tickerLayout = profiles; },
        },
        channelNumber: ch.number,
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
      commitOwnerFields(ch, ['tickerContent']);
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
      commitOwnerFields(ch, ['tickerContent']);
    });
    textEl.addEventListener('input', () => {
      ch.tickerContent.text = textEl.value;
      window.applyTickerState?.();
      commitOwnerFields(ch, ['tickerContent'], { coalesce: `ch:${ch.number}:ticker-text` });
    });
    speedEl.addEventListener('change', () => {
      ch.tickerContent.speed = parseInt(speedEl.value, 10) || 30;
      window.applyTickerState?.();
      commitOwnerFields(ch, ['tickerContent']);
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
    commitOwnerFields(ch, ['broadcastIdentity'], { coalesce: `ch:${ch.number}:identity` });
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
  clear.addEventListener('click', () => { delete ch.broadcastIdentity; buildChannelIdentityPanel(ch, panelEl); commitOwnerFields(ch, ['broadcastIdentity'], { label: `Clear CH ${ch.number} identity` }); });
  panelEl.append(intro, grid, clear);
}
