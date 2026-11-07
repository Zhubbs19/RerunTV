// The header every full-screen cable-guide page shares: logo slot, messages
// envelope and clock along the top, three lines of context (where you are,
// the focused item in the highlight colour, one sentence about it), and the
// live-picture box in the top-right corner. Help for the focused thing lives
// here and nowhere else; pages call setFocus() as focus moves.
//
// The clock reads viewNow() so it matches the schedule under the time machine.
import { S, viewNow } from '../core/state.js';
import { escapeHtml } from '../core/util.js';
import { isVideoMediaPath, resolveEffectiveIcon } from '../core/channels.js';
import { guideClock } from './model.js';

const ENVELOPE = '<svg viewBox="0 0 26 20" aria-hidden="true"><path d="M1 2h24v16H1zM3 4v.6l10 7 10-7V4zm0 3.1V16h20V7.1l-10 7z"/></svg>';

/**
 * Shows a channel's logo in an <img>: its icon, or the seasonal one in effect at
 * `atMs`. Hidden when the channel has none, or when its icon is a video (the
 * logo bug can play one; a still slot beside text can't). The cable-guide
 * surfaces put it beside the channel's number and call letters.
 * @param {HTMLImageElement} img The image element to fill.
 * @param {?object} ch The channel.
 * @param {number} [atMs=viewNow()] The instant whose seasonal icon applies, in ms.
 */
export function setChannelLogo(img, ch, atMs = viewNow()) {
  const icon = ch ? resolveEffectiveIcon(ch, atMs) : null;
  const show = !!icon && !isVideoMediaPath(icon);
  img.classList.toggle('hidden', !show);
  img.dataset.icon = show ? icon : '';
  if (!show) { img.removeAttribute('src'); return; }
  // A slow lookup must not paint the previous channel's logo late.
  window.api.toFileUrl(icon).then((url) => { if (img.dataset.icon === icon) img.src = url; });
}

/**
 * Builds a page header with its own clock timer.
 * @param {object} [opts] Header text.
 * @param {string} [opts.logo='RERUN TV'] The logo text.
 * @param {string} [opts.tagline='CABLE'] The small line under the logo.
 * @returns {object} `{ el, setFocus, setProgram, setMessages, refreshClock, destroy }`; call `destroy()` to stop the clock.
 */
export function createGuideHeader({ logo = 'RERUN TV', tagline = 'CABLE' } = {}) {
  const el = document.createElement('header');
  el.className = 'cg-header';
  el.innerHTML = `
    <div class="cg-logo">${escapeHtml(logo)}<small>${escapeHtml(tagline)}</small></div>
    <div class="cg-status">
      <span class="cg-messages hidden" title="Messages">${ENVELOPE}</span>
      <span class="cg-clock"></span>
    </div>
    <div class="cg-lines">
      <div class="cg-line cg-where"></div>
      <div class="cg-line cg-name"></div>
      <div class="cg-line cg-help"></div>
    </div>
    <div class="cg-picture" aria-hidden="true"></div>`;
  const clockEl = el.querySelector('.cg-clock');
  const messagesEl = el.querySelector('.cg-messages');
  const lines = {
    where: el.querySelector('.cg-where'),
    name: el.querySelector('.cg-name'),
    help: el.querySelector('.cg-help'),
  };

  const tick = () => {
    clockEl.textContent = guideClock(new Date(viewNow()), !!S.config?.display?.clock24);
  };
  tick();
  const timer = setInterval(tick, 15000);

  return {
    el,
    // Any line left undefined keeps its text; pass '' to clear it.
    setFocus({ where, name, help } = {}) {
      el.classList.remove('cg-program');
      if (where !== undefined) lines.where.textContent = where;
      if (name !== undefined) lines.name.textContent = name;
      if (help !== undefined) lines.help.textContent = help;
    },
    // A program page's header: title (highlight colour), time with a rating
    // badge, then the channel — the order program info uses. Given `ch`, the
    // channel line leads with its logo.
    setProgram({ title = '', time = '', channel = '', rating = '', ch = null } = {}) {
      el.classList.add('cg-program');
      lines.where.textContent = title;
      lines.name.textContent = time;
      lines.help.textContent = channel;
      if (ch) {
        const logo = document.createElement('img');
        logo.className = 'cg-chan-logo';
        logo.alt = '';
        setChannelLogo(logo, ch);
        lines.help.prepend(logo);
      }
      let badge = lines.name.querySelector('.cg-badge');
      if (rating) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'cg-badge'; }
        badge.textContent = rating;
        lines.name.appendChild(badge);
      } else if (badge) badge.remove();
    },
    setMessages(count) {
      messagesEl.classList.toggle('hidden', !(count > 0));
      messagesEl.title = count > 0 ? `${count} message${count === 1 ? '' : 's'}` : 'Messages';
    },
    refreshClock: tick,
    destroy() {
      clearInterval(timer);
      el.remove();
    },
  };
}
