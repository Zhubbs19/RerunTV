// Search on the cable-guide layout: an on-screen keyboard (Delete / Space,
// then A–Z and 0–9 six to a row) with the matching programs listed beside it
// as you spell, the way the boxes searched by title. A keyboard types into it
// too. OK on a result shows that program in the full guide, where its
// actions (record, remind, watch from start) are one press away.
//
// With display.searchGroupByTitle on (the default; GUIDE & THEME › Guide),
// each show is one row with its number of airings, and OK on it lists them.
//
// The matching is the guide's own seven-day program search.
import { S, viewNow } from '../core/state.js';
import { escapeHtml } from '../core/util.js';
import { formatChannelNumber, sortedChannels } from '../core/channels.js';
import { isHiddenForProfile } from '../personal/state.js';
import { searchUpcomingPrograms } from '../guide/program-search.js';
import { showProgramInGuide } from '../guide/guide.js';
import { channelCallLetters } from '../guide/model.js';
import { groupResultsByTitle, guideDayLabel, guideRange, guideShortDay } from './model.js';
import { openCgPage } from './page.js';

export const KEY_ROWS = Object.freeze(['ABCDEF', 'GHIJKL', 'MNOPQR', 'STUVWX', 'YZ1234', '567890']);
const MAX_RESULTS = 40;
const MAX_QUERY = 30;
// Grouped, the search keeps every airing in its seven days: many airings of
// one show fold into a single row, and a cap would undercount a busy show and
// push later shows off the list.

const groupByTitle = () => !(S.config.display && S.config.display.searchGroupByTitle === false);

export function openSearchPage() {
  let query = '';
  let results = [];
  let groups = [];
  let openGroup = null; // the show whose airings are listed, when grouped
  let timer = null;
  const clock24 = () => !!(S.config.display && S.config.display.clock24);

  return openCgPage({
    name: 'search',
    build(body, page) {
      body.innerHTML = `
        <div class="cg-search-keys">
          <div class="cg-search-field"><span class="cg-search-text"></span><span class="cg-search-cursor">_</span></div>
          <div class="cg-search-edit">
            <button type="button" class="cg-key cg-key-wide" data-key="delete">Delete</button>
            <button type="button" class="cg-key cg-key-wide" data-key="space">Space</button>
          </div>
          <div class="cg-search-grid">${KEY_ROWS.join('').split('').map((c, i) => `<button type="button" class="cg-key" data-key="${c}"${i === 0 ? ' data-default-focus' : ''}>${c}</button>`).join('')}</div>
        </div>
        <div class="cg-search-results">
          <div class="cg-search-count"><span class="cg-search-total"></span><span class="cg-search-sort">Sorted by time</span></div>
          <div class="cg-search-tips">
            <div class="cg-search-tips-head">Search Tips:</div>
            <p>A few letters (ex.: DET) find more shows.</p>
            <p>A whole word or two (ex.: DETECTIVE) narrow the list.</p>
          </div>
          <div class="cg-search-list" role="list"></div>
        </div>`;
      const textEl = body.querySelector('.cg-search-text');
      const resultsEl = body.querySelector('.cg-search-results');
      const countEl = body.querySelector('.cg-search-total');
      const sortEl = body.querySelector('.cg-search-sort');
      const listEl = body.querySelector('.cg-search-list');
      page.wholeRows(listEl);

      const keyboardHelp = () => page.header.setFocus({
        where: 'Search',
        name: 'Search by Title',
        help: 'Spell any part of a title. Matching shows are listed on the right.',
      });

      // The airings listed right now: one show's when it is open, else all.
      const shown = () => (openGroup ? openGroup.results : results);
      const airingRow = (r, i, withTime) => `
          <button type="button" class="cg-search-result" data-index="${i}" role="listitem">
            <span class="cg-result-title">${escapeHtml(r.title)}</span>
            <span class="cg-result-when">${escapeHtml(guideShortDay(r.entry.start, viewNow()))}${withTime ? ` ${escapeHtml(guideRange(new Date(r.entry.start), new Date(r.entry.end), clock24()))}` : ''}</span>
          </button>`;

      const paintResults = () => {
        const spelling = query.trim().length < 2;
        resultsEl.classList.toggle('cg-search-empty', spelling);
        if (spelling) {
          countEl.textContent = '';
          listEl.innerHTML = '';
          return;
        }
        if (openGroup) {
          countEl.textContent = `${openGroup.title} · ${openGroup.results.length} Airings`;
          sortEl.textContent = 'Back: All Shows';
          listEl.innerHTML = openGroup.results.slice(0, MAX_RESULTS).map((r, i) => airingRow(r, i, true)).join('');
          return;
        }
        sortEl.textContent = 'Sorted by time';
        if (groupByTitle()) {
          countEl.textContent = `${groups.length} Show${groups.length === 1 ? '' : 's'}`;
          listEl.innerHTML = groups.slice(0, MAX_RESULTS).map((g, i) => `
          <button type="button" class="cg-search-result" data-group="${i}" role="listitem">
            <span class="cg-result-title">${escapeHtml(g.title)}${g.results.length > 1 ? ` <span class="cg-result-count">(${g.results.length})</span>` : ''}</span>
            <span class="cg-result-when">${escapeHtml(guideShortDay(g.results[0].entry.start, viewNow()))}</span>
          </button>`).join('');
          return;
        }
        countEl.textContent = `${results.length} Result${results.length === 1 ? '' : 's'}`;
        listEl.innerHTML = results.slice(0, MAX_RESULTS).map((r, i) => airingRow(r, i, false)).join('');
      };

      const search = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const channels = sortedChannels().filter((c) => !c.hidden && !isHiddenForProfile(c.number));
          const grouped = groupByTitle();
          results = query.trim().length >= 2 ? searchUpcomingPrograms(channels, query, viewNow(), grouped ? { limit: Infinity } : undefined) : [];
          groups = grouped ? groupResultsByTitle(results) : [];
          openGroup = null;
          paintResults();
        }, 120);
      };

      const setQuery = (next) => {
        query = next.slice(0, MAX_QUERY);
        textEl.textContent = query;
        search();
      };

      body.querySelector('.cg-search-keys').addEventListener('click', (e) => {
        const key = e.target.closest('[data-key]');
        if (!key) return;
        const k = key.dataset.key;
        if (k === 'delete') setQuery(query.slice(0, -1));
        else if (k === 'space') setQuery(`${query} `);
        else setQuery(query + k);
      });
      // From a show's airings back to the list of shows, on that show.
      const closeGroup = () => {
        const at = groups.indexOf(openGroup);
        openGroup = null;
        paintResults();
        const row = listEl.querySelector(`[data-group="${at}"]`);
        if (row) row.focus({ preventScroll: false });
      };
      page.closeGroup = () => { if (!openGroup) return false; closeGroup(); return true; };
      listEl.addEventListener('click', (e) => {
        const groupRow = e.target.closest('[data-group]');
        if (groupRow) {
          const group = groups[Number(groupRow.dataset.group)];
          if (!group) return;
          if (group.results.length > 1) {
            openGroup = group;
            paintResults();
            const first = listEl.querySelector('[data-index]');
            if (first) first.focus({ preventScroll: true });
            return;
          }
          page.close();
          showProgramInGuide(group.results[0]);
          return;
        }
        const row = e.target.closest('[data-index]');
        if (!row) return;
        const result = shown()[Number(row.dataset.index)];
        page.close();
        if (result) showProgramInGuide(result);
      });
      page.el.addEventListener('focusin', (e) => {
        const row = e.target.closest && e.target.closest('.cg-search-result');
        if (!row) { keyboardHelp(); return; }
        const group = row.dataset.group != null ? groups[Number(row.dataset.group)] : null;
        const r = group ? group.results[0] : shown()[Number(row.dataset.index)];
        if (!r) return;
        const rating = r.entry.file.rating === 'NONE' ? '' : (r.entry.file.rating || r.channel.rating || '');
        page.header.setProgram({
          title: r.title,
          time: `${group && group.results.length > 1 ? `${group.results.length} airings · next ` : ''}${guideDayLabel(r.entry.start, viewNow())} ${guideRange(new Date(r.entry.start), new Date(r.entry.end), clock24())}`,
          channel: `${formatChannelNumber(r.channel.number)} ${channelCallLetters(r.channel) || r.channel.name || ''}`.trim(),
          rating,
        });
      });
      page.typeKey = (key) => {
        if (key === 'Backspace') { if (!query) return false; setQuery(query.slice(0, -1)); return true; }
        if (/^[a-z0-9 ]$/i.test(key)) { setQuery(query + key.toUpperCase()); return true; }
        return false;
      };
      keyboardHelp();
      paintResults();
    },
    // A keyboard types straight in; arrows, OK and Back stay the page's.
    onKey(e, page) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      // Back in a show's airings goes up to the shows, not out of Search.
      if ((e.key === 'Escape' || e.key === 'Backspace') && document.activeElement && document.activeElement.closest('.cg-search-results') && page.closeGroup()) return true;
      if (e.key === ' ' && document.activeElement && document.activeElement.closest('.cg-search-results')) return false;
      return page.typeKey(e.key);
    },
  });
}
