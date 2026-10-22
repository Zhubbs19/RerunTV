// The per-channel / per-block TITLES panel (file list with bulk edit, facets,
// ratings, credits-speedup overrides, download-to-local) plus the helpers only it
// uses. Split out of panels.js; panels.js re-exports buildTitlesPanel.
import { freshFileFacets, mirrorFacetsIntoTags, parseMediaRef } from '../core/channels.js';
import { titleRowActionEntries } from '../plugin/host.js';
import { S, dispatch, viewNow } from '../core/state.js';
import { basenameNoExt, formatDuration, guessCleanTitle, randomId, stripReleaseTags, suggestFacetsFromPath } from '../core/util.js';
import { attachTagAutocomplete, commitOwnerFields, buildMediaThumbnail, parsePositiveInt, safeApi } from './util.js';
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
    destDir = await safeApi('Opening the file picker', () => window.api.selectFolder());
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
  // 500+ episodes of one cartoon, all needing the same series tag to feed
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
        const path = await safeApi('Opening the file picker', () => window.api.selectImage());
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
