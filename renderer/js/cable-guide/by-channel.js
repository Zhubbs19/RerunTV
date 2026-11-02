// Listings by Channel on the cable-guide layout: one channel's day as a list
// of time | title rows under a "‹ 67 ABCF ›" bar. ◀▶ change the channel
// (on a remote too: the rows take arrows, see data-ui-arrows in tv/input.js),
// ▲▼ move through the day, OK acts on the program: tune to what's on, watch an
// earlier one from its start with the time machine, or set / clear a reminder
// for a later one. The header describes the focused program.
import { S, viewNow } from '../core/state.js';
import { escapeHtml, getDisplayTitle } from '../core/util.js';
import { formatChannelNumber, sortedChannels } from '../core/channels.js';
import { getChannelSchedule } from '../core/schedule.js';
import { isHiddenForProfile } from '../personal/state.js';
import { guideGenreStyleForFile } from '../guide/genres.js';
import { channelCallLetters } from '../guide/model.js';
import { addProgramReminder, jumpToGuideEntry, listReminders, removeReminder } from '../guide/guide.js';
import { tuneToChannel } from '../playback/core.js';
import { byChannelAction, guideClock, guideRange } from './model.js';
import { setChannelLogo } from './header.js';
import { openCgPage } from './page.js';

const HOURS_SHOWN = 24;
const MAX_ROWS = 48;

function browsable() {
  return sortedChannels().filter((c) => !c.hidden && !isHiddenForProfile(c.number));
}

const ACTION_HELP = {
  watch: 'Press OK to watch.',
  rewind: 'Press OK to watch it from the start (time machine).',
  remind: 'Press OK to set a reminder.',
  unremind: 'Reminder set. Press OK to cancel it.',
  none: 'Already aired.',
};

export function openByChannelPage(startNumber = S.currentNumber) {
  let channels = browsable();
  let index = Math.max(0, channels.findIndex((c) => c.number === startNumber));
  let entries = [];
  const clock24 = () => !!(S.config.display && S.config.display.clock24);
  const tmOn = () => !!(S.config.timeMachine && S.config.timeMachine.enabled);

  return openCgPage({
    name: 'by-channel',
    build(body, page) {
      body.innerHTML = `
        <div class="cg-bychan-bar">
          <span class="cg-bychan-heading">Listings By Channel</span>
          <button type="button" class="cg-bychan-arrow" data-step="-1" aria-label="Previous channel">‹</button>
          <img class="cg-chan-logo hidden" alt="">
          <span class="cg-bychan-name"></span>
          <button type="button" class="cg-bychan-arrow" data-step="1" aria-label="Next channel">›</button>
        </div>
        <div class="cg-bychan-list" role="list" data-ui-arrows="horizontal"></div>`;
      const nameEl = body.querySelector('.cg-bychan-name');
      const logoEl = body.querySelector('.cg-chan-logo');
      const listEl = body.querySelector('.cg-bychan-list');

      const reminded = (entry, ch) => listReminders().some((r) => r.channelNumber === ch.number && r.start === entry.start && r.path === entry.file.path);

      const describe = (i) => {
        const ch = channels[index];
        const entry = entries[i];
        if (!ch || !entry) return;
        const rating = entry.file.rating === 'NONE' ? '' : (entry.file.rating || ch.rating || '');
        const action = byChannelAction(entry, viewNow(), tmOn(), reminded(entry, ch));
        page.header.setProgram({
          title: getDisplayTitle(entry.file),
          time: guideRange(new Date(entry.start), new Date(entry.end), clock24()),
          channel: ACTION_HELP[action],
          rating,
        });
      };

      const paint = (focusIndex = 0) => {
        channels = browsable();
        const ch = channels[index];
        setChannelLogo(logoEl, ch);
        if (!ch) { nameEl.textContent = 'No channels'; listEl.innerHTML = ''; return; }
        nameEl.textContent = `${formatChannelNumber(ch.number)} ${channelCallLetters(ch) || ch.name || ''}`.trim();
        const now = viewNow();
        // From the program on now through the rest of the day.
        entries = getChannelSchedule(ch, now - 6 * 3600000, now + HOURS_SHOWN * 3600000)
          .filter((e) => e.end > now - 2 * 3600000).slice(0, MAX_ROWS);
        const firstNow = Math.max(0, entries.findIndex((e) => e.end > now));
        entries = entries.slice(firstNow);
        const theme = document.documentElement.dataset.theme;
        listEl.innerHTML = entries.map((e, i) => {
          const genre = guideGenreStyleForFile(e.file, S.config, theme);
          const mark = reminded(e, ch) ? '<span class="cg-bychan-mark" aria-label="Reminder set">●</span>' : '';
          return `<button type="button" class="cg-bychan-row${genre ? ' guide-entry-genre' : ''}" data-index="${i}" role="listitem"${genre ? ` data-genre="${escapeHtml(genre.key)}" style="--guide-genre-bg:${escapeHtml(genre.background)}"` : ''}>`
            + `<span class="cg-bychan-time">${escapeHtml(guideClock(new Date(e.start), clock24(), true))}</span>`
            + `<span class="cg-bychan-title">${escapeHtml(getDisplayTitle(e.file))}</span>${mark}</button>`;
        }).join('');
        const target = listEl.querySelector(`[data-index="${Math.min(focusIndex, entries.length - 1)}"]`);
        if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); describe(Number(target.dataset.index)); }
      };

      const step = (direction) => {
        if (!channels.length) return;
        index = (index + direction + channels.length) % channels.length;
        paint(0);
      };

      page.step = step;
      body.querySelector('.cg-bychan-bar').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-step]');
        if (btn) step(Number(btn.dataset.step));
      });
      listEl.addEventListener('focusin', (e) => {
        const row = e.target.closest('[data-index]');
        if (row) describe(Number(row.dataset.index));
      });
      listEl.addEventListener('click', (e) => {
        const row = e.target.closest('[data-index]');
        if (!row) return;
        const i = Number(row.dataset.index);
        const ch = channels[index];
        const entry = entries[i];
        if (!ch || !entry) return;
        const action = byChannelAction(entry, viewNow(), tmOn(), reminded(entry, ch));
        if (action === 'watch') { page.close(); tuneToChannel(ch.number); }
        else if (action === 'rewind') { page.close(); jumpToGuideEntry(ch, entry); }
        else if (action === 'remind') { addProgramReminder({ channel: ch, entry, title: getDisplayTitle(entry.file) }); paint(i); }
        else if (action === 'unremind') {
          const r = listReminders().find((x) => x.channelNumber === ch.number && x.start === entry.start && x.path === entry.file.path);
          if (r) removeReminder(r.id);
          paint(i);
        }
      });
      paint(0);
    },
    onKey(e, page) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { page.step(e.key === 'ArrowLeft' ? -1 : 1); return true; }
      return false;
    },
  });
}
