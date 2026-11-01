// Messages on the cable-guide layout: what the envelope in the header counts.
// Pending program reminders and a downloaded update, newest first as a
// date | title list; the header shows the focused message in full. OK on the
// update brings back its Install / Later prompt, and OK on a reminder whose
// program is on now tunes to it.
import { S } from '../core/state.js';
import { escapeHtml } from '../core/util.js';
import { formatChannelNumber, getChannel } from '../core/channels.js';
import { listReminders } from '../guide/guide.js';
import { channelCallLetters } from '../guide/model.js';
import { tuneToChannel } from '../playback/core.js';
import { showUpdatePrompt, updateReadyVersion } from '../update/notice.js';
import { guideRange } from './model.js';
import { openCgPage, setMessageCounter } from './page.js';

const monthDay = (t) => `${new Date(t).getMonth() + 1}/${new Date(t).getDate()}`;

// Reminders keep to the real clock (guide.js): they are appointments in the
// world, so the time machine neither fires nor hides them.
export function messageList(now = Date.now()) {
  const clock24 = !!(S.config.display && S.config.display.clock24);
  const items = [];
  const version = updateReadyVersion();
  if (version) {
    items.push({
      kind: 'update', date: monthDay(now), title: 'Update ready',
      body: `RerunTV v${version} is downloaded. Press OK to install it now or later.`,
    });
  }
  listReminders()
    .filter((r) => r.end > now)
    .sort((a, b) => a.start - b.start)
    .forEach((r) => {
      const ch = getChannel(r.channelNumber);
      items.push({
        kind: 'reminder', date: monthDay(r.start), title: `Reminder: ${r.title}`,
        body: `${guideRange(new Date(r.start), new Date(r.end), clock24)} on ${formatChannelNumber(r.channelNumber)} ${(ch && channelCallLetters(ch)) || r.channelName || ''}`.trim(),
        reminder: r,
        onNow: r.start <= now && r.end > now,
      });
    });
  return items;
}

export function messageCount() {
  return messageList().length;
}

setMessageCounter(messageCount);

export function openMessagesPage() {
  let items = messageList();
  return openCgPage({
    name: 'messages',
    build(body, page) {
      body.innerHTML = `<div class="cg-msg-title">Message Center</div><div class="cg-msg-list" role="list"></div>`;
      const listEl = body.querySelector('.cg-msg-list');
      const paint = () => {
        items = messageList();
        listEl.innerHTML = items.length
          ? items.map((m, i) => `<button type="button" class="cg-msg-row" data-index="${i}" role="listitem"><span class="cg-msg-date">${escapeHtml(m.date)}</span><span class="cg-msg-text">${escapeHtml(m.title)}</span></button>`).join('')
          : '<div class="cg-msg-empty">No messages.</div>';
        if (!items.length) page.header.setFocus({ where: 'Messages', name: '', help: 'Reminders and notices appear here.' });
      };
      listEl.addEventListener('focusin', (e) => {
        const row = e.target.closest('[data-index]');
        const m = row && items[Number(row.dataset.index)];
        if (m) page.header.setFocus({ where: 'Messages', name: m.title, help: m.body });
      });
      listEl.addEventListener('click', (e) => {
        const row = e.target.closest('[data-index]');
        const m = row && items[Number(row.dataset.index)];
        if (!m) return;
        if (m.kind === 'update') { page.close(); showUpdatePrompt(); }
        else if (m.kind === 'reminder' && m.onNow) { page.close(); tuneToChannel(m.reminder.channelNumber); }
      });
      paint();
    },
  });
}
