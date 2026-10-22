// The cross-channel library search panel (CHANNELS tab). Split out of channels.js;
// wires its listeners at import time.
import { sortedChannels } from '../core/channels.js';
import {
  channelFilterEl, channelListEl, librarySearchToggleBtn, librarySearchPanelEl, librarySearchInputEl,
  librarySearchResultsEl, nowNextToggleBtn, nowNextPanelEl,
} from '../core/dom.js';
import { S } from '../core/state.js';
import { basenameNoExt, getDisplayTitle } from '../core/util.js';
import { renderChannelList } from './channels.js';

// ---------- Cross-channel library search ----------
// The existing Titles-tab filter and channel-list filter both search within
// one already-known scope (one channel's files, or the channel list by
// name) — this searches every channel's file list at once, for "which
// channel has this episode/show" when you don't remember where you put it.
function renderLibrarySearchResults(query) {
  librarySearchResultsEl.innerHTML = '';
  const q = query.trim().toLowerCase();
  if (!q) {
    const empty = document.createElement('div');
    empty.className = 'library-search-empty';
    empty.textContent = 'TYPE TO SEARCH EVERY CHANNEL AT ONCE.';
    librarySearchResultsEl.appendChild(empty);
    return;
  }
  const matches = [];
  sortedChannels().forEach((ch) => {
    (ch.files || []).forEach((f) => {
      const title = getDisplayTitle(f);
      const base = basenameNoExt(f.path);
      if (title.toLowerCase().includes(q) || base.toLowerCase().includes(q)) {
        matches.push({ ch, file: f, title });
      }
    });
  });
  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'library-search-empty';
    empty.textContent = `NO FILES MATCH "${query.trim()}".`;
    librarySearchResultsEl.appendChild(empty);
    return;
  }
  matches.slice(0, 200).forEach(({ ch, title }) => {
    const row = document.createElement('div');
    row.className = 'library-search-row';
    const chan = document.createElement('span');
    chan.className = 'lsr-chan';
    chan.textContent = `CH ${ch.number} — ${ch.name || 'UNNAMED'}`;
    const titleEl = document.createElement('span');
    titleEl.className = 'lsr-title';
    titleEl.textContent = title;
    const jumpBtn = document.createElement('button');
    jumpBtn.className = 'btn';
    jumpBtn.textContent = 'JUMP TO CHANNEL';
    jumpBtn.addEventListener('click', () => {
      librarySearchPanelEl.classList.add('hidden');
      librarySearchToggleBtn.classList.remove('active');
      S.setupFilterQuery = String(ch.number);
      channelFilterEl.value = String(ch.number);
      S.setupSelectedChannel = ch.number;
      renderChannelList();
      requestAnimationFrame(() => {
        const row = channelListEl.querySelector(`[data-channel-number="${ch.number}"]`);
        if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
    row.appendChild(chan);
    row.appendChild(titleEl);
    row.appendChild(jumpBtn);
    librarySearchResultsEl.appendChild(row);
  });
  if (matches.length > 200) {
    const note = document.createElement('div');
    note.className = 'library-search-empty';
    note.textContent = `+ ${matches.length - 200} MORE — NARROW YOUR SEARCH.`;
    librarySearchResultsEl.appendChild(note);
  }
}

librarySearchToggleBtn.addEventListener('click', () => {
  const opening = librarySearchPanelEl.classList.contains('hidden');
  librarySearchPanelEl.classList.toggle('hidden', !opening);
  librarySearchToggleBtn.classList.toggle('active', opening);
  nowNextPanelEl.classList.add('hidden');
  nowNextToggleBtn.classList.remove('active');
  if (opening) {
    librarySearchInputEl.value = '';
    renderLibrarySearchResults('');
    librarySearchInputEl.focus();
  }
});
// Debounced — this re-scans every channel's whole file list on every
// keystroke (see renderLibrarySearchResults above), which starts to visibly
// lag typing once a library grows into the hundreds/thousands of files.
let librarySearchDebounceTimer = null;
librarySearchInputEl.addEventListener('input', () => {
  clearTimeout(librarySearchDebounceTimer);
  librarySearchDebounceTimer = setTimeout(() => renderLibrarySearchResults(librarySearchInputEl.value), 150);
});
