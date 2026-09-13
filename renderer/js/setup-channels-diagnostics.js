// CHANNELS/PERFORMANCE tabs: read-only diagnostic views split out of
// setup-channels.js — the cross-channel NOW/NEXT dashboard, the box-wide
// channel health check (missing files, orphaned ad presets, dangling pool
// entries, cross-channel file duplicates), and the combined BOX STATUS
// summary (PERFORMANCE tab). None of this edits channel data directly, and
// none of it is coupled to the channel-list/edit/bulk-action/preview UI that
// remains in setup-channels.js beyond a handful of shared dom.js element
// references (the NOW/NEXT and library-search toggle buttons are mutually
// exclusive — each file's own listener closes the other's panel).
import { findFolderEntry, mediaRefId, parseMediaRef, sortedChannels } from './channels.js';
import {
  boxStatusBackupEl, boxStatusChannelsEl, boxStatusCheckBtn, boxStatusFilesEl, boxStatusIssuesEl,
  healthCheckBtn, healthCheckResultsEl, librarySearchPanelEl, librarySearchToggleBtn,
  nowNextPanelEl, nowNextRowsEl, nowNextToggleBtn,
} from './dom.js';
import { getChannelSchedule } from './schedule.js';
import { alertDialog, confirmDialog } from './setup-dialogs.js';
import { applyLocalFolderRelink, replaceLocalRoot } from './library-relink.js';
import { collectRealContentTags } from './setup-util.js';
import { S, viewNow, commitConfigPatch } from './state.js';
import { formatSlotLabel, getDisplayTitle, titleNeedsMetadata } from './util.js';

// ---------- Cross-channel NOW/NEXT dashboard ----------
// Reuses the exact same getChannelSchedule() call a program-guide-style
// channel plugin already uses for its own now/next marquee — a
// glance-at-everything view from inside setup, without paging through the
// full guide or every channel row individually.
function renderNowNextDashboard() {
  nowNextRowsEl.innerHTML = '';
  sortedChannels().forEach((ch) => {
    const schedule = getChannelSchedule(ch, viewNow(), viewNow() + 3 * 3600000);
    const nowEntry = schedule[0];
    const nextEntry = schedule[1];
    const row = document.createElement('div');
    row.className = 'now-next-row';
    const num = document.createElement('span');
    num.className = 'nnr-chan';
    num.textContent = ch.number;
    const name = document.createElement('span');
    name.textContent = ch.name || 'UNNAMED';
    const now = document.createElement('span');
    now.textContent = nowEntry ? getDisplayTitle(nowEntry.file) : '—';
    const next = document.createElement('span');
    next.className = 'nnr-next';
    next.textContent = nextEntry ? `${formatSlotLabel(nextEntry.start)} ${getDisplayTitle(nextEntry.file)}` : '—';
    row.appendChild(num);
    row.appendChild(name);
    row.appendChild(now);
    row.appendChild(next);
    nowNextRowsEl.appendChild(row);
  });
}

nowNextToggleBtn.addEventListener('click', () => {
  const opening = nowNextPanelEl.classList.contains('hidden');
  nowNextPanelEl.classList.toggle('hidden', !opening);
  nowNextToggleBtn.classList.toggle('active', opening);
  librarySearchPanelEl.classList.add('hidden');
  librarySearchToggleBtn.classList.remove('active');
  if (opening) renderNowNextDashboard();
});
// ---------- Channel health check ----------
// A fast, box-wide complement to the existing per-channel FIX PLAYBACK
// (which decode-probes one channel's files at a time to catch bad codecs) —
// this instead does a cheap existence-only check across every channel's
// files at once (a moved/renamed/deleted file never triggers a codec error,
// it just silently becomes unreachable), plus flags config-level dangling
// references that only surface today as confusing runtime behavior: an ad
// preset OR pool entry whose contentTags never match any real content
// anywhere (collectRealContentTags, setup-util.js — file tags plus channel-
// level contentTags) will simply never fire, REGARDLESS of channel/block
// scope also being set — resolveActiveCommercials/poolFor (schedule.js/
// interstitials.js) both require an actual tag overlap whenever contentTags
// is set at all, so a channel scope narrows WHEN an entry could fire, it
// doesn't substitute for the tag match. (This is exactly the failure mode
// that broke jump-to-break on a real channel: 30 pool entries scoped to one
// channel via channelAffinity, but ALSO tagged with a contentTag nothing on
// that channel carried — silently dead, not just narrowed.) Also flags pool
// entries still targeting a channel/block that no longer exists.
function renderHealthCheckResults({ missingByChannel, missingFolderGroups, orphanedPresets, orphanedPoolEntries, danglingPoolEntries, missingPoolEntries, duplicateFiles, metadataByChannel }) {
  healthCheckResultsEl.innerHTML = '';
  const missingTotal = Array.from(missingByChannel.values()).reduce((n, s) => n + s.size, 0);
  const metadataTotal = Array.from(metadataByChannel.values()).reduce((total, files) => total + files.length, 0);
  const totalIssues = missingTotal + orphanedPresets.length + orphanedPoolEntries.length + danglingPoolEntries.length + missingPoolEntries.length + duplicateFiles.length + metadataTotal;

  const summary = document.createElement('div');
  summary.className = 'health-check-summary' + (totalIssues === 0 ? ' is-clean' : '');
  summary.textContent = totalIssues === 0 ? 'NO ISSUES FOUND.' : `${totalIssues} ISSUE(S) FOUND:`;
  healthCheckResultsEl.appendChild(summary);

  if (missingByChannel.size) {
    const title = document.createElement('div');
    title.className = 'health-check-group-title';
    title.textContent = 'MISSING/MOVED FILES';
    healthCheckResultsEl.appendChild(title);
    missingByChannel.forEach((paths, chNumber) => {
      const ch = S.config.channels.find((c) => c.number === chNumber);
      const item = document.createElement('div');
      item.className = 'health-check-item';
      item.textContent = `CH ${chNumber}${ch && ch.name ? ' — ' + ch.name : ''}: ${paths.size} file(s) not found on disk`;
      healthCheckResultsEl.appendChild(item);
    });
  }

  if (missingFolderGroups.size) {
    const title = document.createElement('div');
    title.className = 'health-check-group-title';
    title.textContent = 'RELINK MOVED LOCAL FOLDERS';
    healthCheckResultsEl.appendChild(title);
    missingFolderGroups.forEach(({ entry, paths }) => {
      const row = document.createElement('div');
      row.className = 'health-check-item health-check-relink-row';
      const copy = document.createElement('span');
      copy.textContent = `${entry.label || entry.ref} — ${paths.size} missing file(s)`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-small';
      button.textContent = 'RELINK…';
      button.addEventListener('click', async () => {
        const newRoot = await window.api.selectFolder();
        if (!newRoot || newRoot === entry.ref) return;
        const candidates = Array.from(paths).map((oldPath) => replaceLocalRoot(oldPath, entry.ref, newRoot));
        const checks = await window.api.checkPathsExist(candidates.map((ref) => ({ source: 'local', ref })));
        const found = checks.filter(Boolean).length;
        if (found === 0) {
          await alertDialog('None of the missing files were found under that folder. Choose the new location that corresponds to the old folder shown in the health check.', { title: 'NOT A MATCH' });
          return;
        }
        const unresolved = candidates.length - found;
        const message = `Found ${found} of ${candidates.length} missing file(s) under:\n${newRoot}` +
          (unresolved ? `\n\n${unresolved} file(s) will still be missing after the relink.` : '') +
          '\n\nUpdate every channel and schedule reference that uses this folder? This can be undone with Ctrl+Z.';
        if (!(await confirmDialog({ message, title: 'RELINK MOVED FOLDER', danger: false, confirmText: 'RELINK' }))) return;
        const newId = mediaRefId('local', newRoot);
        const result = applyLocalFolderRelink(S.config, {
          oldId: entry.id, oldRoot: entry.ref, newId, newRoot,
        });
        commitConfigPatch('Relink folder');
        await alertDialog(`Relinked ${result.fileReferences} media reference(s) across ${result.folderEntries} folder entr${result.folderEntries === 1 ? 'y' : 'ies'}.`, { title: 'FOLDER RELINKED' });
        checkChannelHealth();
      });
      row.append(copy, button);
      healthCheckResultsEl.appendChild(row);
    });
  }

  if (missingPoolEntries.length) {
    const title = document.createElement('div');
    title.className = 'health-check-group-title';
    title.textContent = 'MISSING BUMPER/POOL FILES';
    healthCheckResultsEl.appendChild(title);
    missingPoolEntries.forEach(({ entry, path }) => {
      const item = document.createElement('div');
      item.className = 'health-check-item';
      const fileName = path.split(/[\\/]/).pop();
      item.textContent = `${entry.type} entry — ${fileName} not found on disk`;
      healthCheckResultsEl.appendChild(item);
    });
  }

  if (orphanedPresets.length) {
    const title = document.createElement('div');
    title.className = 'health-check-group-title';
    title.textContent = 'AD PRESETS WITH NO MATCHING TAGGED CONTENT';
    healthCheckResultsEl.appendChild(title);
    orphanedPresets.forEach((p) => {
      const item = document.createElement('div');
      item.className = 'health-check-item';
      item.textContent = `"${p.name || 'UNTITLED'}" — tags: ${p.contentTags.join(', ')} (no file anywhere has any of these tags)`;
      healthCheckResultsEl.appendChild(item);
    });
  }

  if (orphanedPoolEntries.length) {
    const title = document.createElement('div');
    title.className = 'health-check-group-title';
    title.textContent = 'BUMPER POOL ENTRIES WITH NO MATCHING TAGGED CONTENT';
    healthCheckResultsEl.appendChild(title);
    orphanedPoolEntries.forEach((e) => {
      const item = document.createElement('div');
      item.className = 'health-check-item';
      const chLabel = e.channelAffinity === 'any' ? 'ANY CH' : `CH ${e.channelAffinity}`;
      item.textContent = `${e.type} entry (${chLabel}) — tags: ${e.contentTags.join(', ')} (no file or channel anywhere has any of these tags, so this can never play)`;
      healthCheckResultsEl.appendChild(item);
    });
  }

  if (danglingPoolEntries.length) {
    const title = document.createElement('div');
    title.className = 'health-check-group-title';
    title.textContent = 'BUMPER POOL ENTRIES TARGETING A DELETED CHANNEL/BLOCK';
    healthCheckResultsEl.appendChild(title);
    danglingPoolEntries.forEach((e) => {
      const item = document.createElement('div');
      item.className = 'health-check-item';
      item.textContent = `${e.type} entry — CH ${e.channelAffinity}, block ${e.blockAffinity} no longer exists`;
      healthCheckResultsEl.appendChild(item);
    });
  }

  if (duplicateFiles.length) {
    const title = document.createElement('div');
    title.className = 'health-check-group-title';
    title.textContent = 'SAME FILE ON MULTIPLE CHANNELS';
    healthCheckResultsEl.appendChild(title);
    duplicateFiles.forEach(({ path, channels }) => {
      const item = document.createElement('div');
      item.className = 'health-check-item';
      const fileName = path.split(/[\\/]/).pop();
      const chList = channels.map((n) => {
        const ch = S.config.channels.find((c) => c.number === n);
        return `CH ${n}${ch && ch.name ? ' (' + ch.name + ')' : ''}`;
      }).join(', ');
      item.textContent = `${fileName} — assigned to ${chList}`;
      healthCheckResultsEl.appendChild(item);
    });
  }

  if (metadataByChannel.size) {
    const title = document.createElement('div');
    title.className = 'health-check-group-title';
    title.textContent = 'TITLES THAT NEED METADATA';
    healthCheckResultsEl.appendChild(title);
    metadataByChannel.forEach((files, chNumber) => {
      const ch = S.config.channels.find((candidate) => candidate.number === chNumber);
      const item = document.createElement('div');
      item.className = 'health-check-item';
      const examples = files.slice(0, 3).map((file) => getDisplayTitle(file)).join('; ');
      item.textContent = `CH ${chNumber}${ch?.name ? ` — ${ch.name}` : ''}: ${files.length} suspicious fallback title(s)${examples ? ` — ${examples}` : ''}`;
      healthCheckResultsEl.appendChild(item);
    });
  }
}

export async function checkChannelHealth() {
  healthCheckBtn.disabled = true;
  healthCheckResultsEl.classList.remove('hidden');
  healthCheckResultsEl.innerHTML = '<div class="health-check-summary">SCANNING…</div>';

  const pathEntries = [];
  S.config.channels.forEach((ch) => {
    (ch.files || []).forEach((f) => pathEntries.push({ path: f.path, ch, file: f }));
    (ch.blocks || []).forEach((b) => (b.files || []).forEach((f) => pathEntries.push({ path: f.path, ch, file: f })));
  });

  // Bumper pool entries carry their own files (video-kind: `file`; a
  // DYNAMIC entry's own file is `bgFile` instead — see startBreak,
  // playback.js) independent of any channel's own content list
  // (channelAffinity can be 'any'), so they need their own pass rather than
  // folding into missingByChannel above.
  const interstitialsPool = (S.config.interstitials && S.config.interstitials.pool) || [];
  const poolFileEntries = [];
  interstitialsPool.forEach((e) => {
    const f = e.file || e.bgFile;
    if (f && f.path) poolFileEntries.push({ path: f.path, entry: e });
  });

  const uniquePaths = Array.from(new Set(pathEntries.map((e) => e.path).concat(poolFileEntries.map((e) => e.path))));
  const existsMap = {};
  try {
    // checkPathsExist wants [{source, ref}] with `ref` being each provider's
    // own raw, unprefixed ref (same convention every other media-source
    // dispatch call uses) — parseMediaRef strips ch.files[].path's wrapped
    // mediasource:<id>: form back to that; a plain local path round-trips
    // unchanged (parseMediaRef treats anything without the prefix as
    // source: 'local', ref: <the same string>). existsMap itself stays
    // keyed by the original (possibly wrapped) path, since that's what
    // pathEntries/poolFileEntries below still look it up by.
    const entries = uniquePaths.map((p) => parseMediaRef(p));
    const results = await window.api.checkPathsExist(entries);
    if (Array.isArray(results)) {
      uniquePaths.forEach((p, i) => { existsMap[p] = results[i]; });
    }
  } catch (e) { /* leave existsMap empty — nothing gets flagged rather than risk false positives */ }

  const missingByChannel = new Map();
  const missingFolderGroups = new Map();
  pathEntries.forEach(({ path, ch, file }) => {
    if (existsMap[path] === false) {
      if (!missingByChannel.has(ch.number)) missingByChannel.set(ch.number, new Set());
      missingByChannel.get(ch.number).add(path);
      const folder = file && findFolderEntry(file.folder);
      if (folder && folder.source === 'local' && replaceLocalRoot(path, folder.ref, folder.ref)) {
        if (!missingFolderGroups.has(folder.id)) missingFolderGroups.set(folder.id, { entry: folder, paths: new Set() });
        missingFolderGroups.get(folder.id).paths.add(path);
      }
    }
  });

  const missingPoolEntries = poolFileEntries.filter(({ path }) => existsMap[path] === false);

  const allFileTags = collectRealContentTags();
  // A tag scope has to actually overlap something real to ever fire — a
  // channel/block scope also being set doesn't substitute for that (see this
  // function's own header comment above). Applies identically to presets and
  // pool entries, since both gate on contentTags the same all-or-nothing way.
  const isDeadTagScope = (contentTags) => contentTags && contentTags.length && !contentTags.some((t) => allFileTags.has(t));
  const presets = (S.config.interstitials && S.config.interstitials.presets) || [];
  const orphanedPresets = presets.filter((p) => p.enabled !== false && isDeadTagScope(p.contentTags));

  const pool = (S.config.interstitials && S.config.interstitials.pool) || [];
  const orphanedPoolEntries = pool.filter((e) => isDeadTagScope(e.contentTags));
  const danglingPoolEntries = pool.filter((e) => {
    if (e.blockAffinity == null || e.channelAffinity === 'any') return false;
    const ch = S.config.channels.find((c) => c.number === e.channelAffinity);
    if (!ch) return true;
    return !(ch.blocks || []).some((b) => b.id === e.blockAffinity);
  });

  // Same file path assigned to more than one channel — not necessarily a
  // mistake (a user might genuinely want one file airing on two lineups),
  // but easy to do by accident (a copy-pasted folder path, a duplicate ADD
  // FOLDER click) and otherwise invisible until you notice a show airing
  // somewhere you didn't expect. Only channel-level `ch.files` are checked
  // here (not block-level files) — block-owned lists already come from a
  // channel's own folder scan, so a block/channel pairing on the *same*
  // channel isn't a cross-channel duplicate the way this check means.
  const channelsByPath = new Map();
  S.config.channels.forEach((ch) => {
    (ch.files || []).forEach((f) => {
      if (!channelsByPath.has(f.path)) channelsByPath.set(f.path, new Set());
      channelsByPath.get(f.path).add(ch.number);
    });
  });
  const duplicateFiles = [];
  channelsByPath.forEach((channelSet, path) => {
    if (channelSet.size > 1) duplicateFiles.push({ path, channels: Array.from(channelSet).sort((a, b) => a - b) });
  });

  const metadataByChannel = new Map();
  S.config.channels.forEach((ch) => {
    const files = (ch.files || []).filter(titleNeedsMetadata);
    if (files.length) metadataByChannel.set(ch.number, files);
  });

  renderHealthCheckResults({ missingByChannel, missingFolderGroups, orphanedPresets, orphanedPoolEntries, danglingPoolEntries, missingPoolEntries, duplicateFiles, metadataByChannel });
  healthCheckBtn.disabled = false;
  const missingTotal = Array.from(missingByChannel.values()).reduce((n, s) => n + s.size, 0);
  const metadataTotal = Array.from(metadataByChannel.values()).reduce((total, files) => total + files.length, 0);
  return missingTotal + orphanedPresets.length + orphanedPoolEntries.length + danglingPoolEntries.length + missingPoolEntries.length + duplicateFiles.length + metadataTotal;
}

healthCheckBtn.addEventListener('click', () => checkChannelHealth());

// ---------- Combined "BOX STATUS" summary (PERFORMANCE tab) ----------
// Pulls together three things that otherwise lived in three separate tabs
// (channel/file counts from CHANNELS, backup status from AUDIO & SYSTEM,
// health-check issues from CHANNELS) into one glanceable summary — the
// issue count is left blank until RUN HEALTH CHECK is actually clicked
// (it's a real IPC round-trip per file path, not free) rather than firing
// automatically every time this tab is opened.
function formatBackupAge(mtimeMs) {
  const mins = Math.round((Date.now() - mtimeMs) / 60000);
  if (mins < 1) return 'JUST NOW';
  if (mins < 60) return `${mins}m AGO`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h AGO`;
  return `${Math.round(hours / 24)}d AGO`;
}

export function renderBoxStatus() {
  if (!boxStatusChannelsEl) return;
  boxStatusChannelsEl.textContent = String(S.config.channels.length);
  const fileCount = S.config.channels.reduce((n, ch) => n + (ch.files ? ch.files.length : 0), 0);
  boxStatusFilesEl.textContent = fileCount.toLocaleString();
  window.api.listBackups().then((backups) => {
    boxStatusBackupEl.textContent = backups && backups.length ? formatBackupAge(backups[0].mtimeMs) : 'NONE YET';
  });
}

if (boxStatusCheckBtn) {
  boxStatusCheckBtn.addEventListener('click', async () => {
    boxStatusCheckBtn.disabled = true;
    boxStatusIssuesEl.textContent = '…';
    const total = await checkChannelHealth();
    boxStatusIssuesEl.textContent = String(total);
    boxStatusIssuesEl.closest('.box-status-item').classList.toggle('is-warn', total > 0);
    boxStatusCheckBtn.disabled = false;
    // Full breakdown lives in the existing CHANNELS-tab health-check panel
    // (checkChannelHealth already rendered it there) — jump there so the
    // click doesn't just update a number with no way to see what's wrong.
    const channelsTabBtn = document.querySelector('.setup-tab-btn[data-tab="channels"]');
    if (channelsTabBtn) channelsTabBtn.click();
    if (healthCheckResultsEl) healthCheckResultsEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
