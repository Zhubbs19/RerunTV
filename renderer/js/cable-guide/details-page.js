// The info card (I on live TV, INFO in the guide's actions) as a program info
// page on the cable-guide layout: the shared header with the picture in its
// corner — title, time and rating, channel — then the description (with any
// matched cast as its last sentence), and a
// Back tile with its meaning underneath, like the guide's program info.
// tv/details.js still fills the legacy card; this draws next to it inside
// #details-overlay while the cable-guide layout is on.
import { S, viewNow } from '../core/state.js';
import { getChannel, formatChannelNumber } from '../core/channels.js';
import { getChannelSchedule } from '../core/schedule.js';
import { channelCallLetters } from '../guide/model.js';
import { createGuideHeader } from './header.js';
import { iconSvg } from './icons.js';
import { descriptionWithCast, guideRange, menuLabel } from './model.js';
import { hidePictureBox, showPictureBox } from './picture-box.js';

let page = null;
let header = null;
let resizeWatch = null;

// The airing this file belongs to on that channel around now, for the range.
function airingRange(ch, file) {
  if (!ch || !file) return '';
  const now = viewNow();
  const HALF_DAY = 12 * 3600000;
  const entries = getChannelSchedule(ch, now - HALF_DAY, now + HALF_DAY);
  const entry = entries.find((e) => e.start <= now && e.end > now && e.file.path === file.path)
    || entries.find((e) => e.end > now && e.file.path === file.path);
  return entry ? guideRange(new Date(entry.start), new Date(entry.end), !!(S.config.display && S.config.display.clock24)) : '';
}

export function showDetailsPage(overlay, { title, file, ctx, onBack }) {
  if (!page) {
    page = document.createElement('div');
    page.className = 'cg-surface cg-details';
    page.innerHTML = `<div class="cg-frame">
      <div class="cg-details-desc"></div>
      <div class="cg-details-extra"></div>
      <div class="cg-tiles"><button type="button" class="cg-tile focus" aria-label="Back">${iconSvg('back')}</button></div>
      <div class="cg-tile-meaning">Go back</div>
    </div>`;
    header = createGuideHeader();
    page.querySelector('.cg-frame').prepend(header.el);
    overlay.appendChild(page);
  }
  page.querySelector('.cg-tile').onclick = (e) => { e.stopPropagation(); onBack(); };
  const ch = ctx.channelNumber != null ? getChannel(ctx.channelNumber) : null;
  const rating = file ? (file.rating === 'NONE' ? '' : (file.rating || (ch && ch.rating) || '')) : '';
  const time = airingRange(ch, file) || ctx.airTime || '';
  const channel = ctx.channelNumber != null
    ? `${formatChannelNumber(ctx.channelNumber)} ${(ch && channelCallLetters(ch)) || ctx.channelName || ''}`.trim()
    : '';
  header.setProgram({ title, time, channel, rating, ch });
  const description = descriptionWithCast(file && typeof file.description === 'string' ? file.description : '', file);
  const desc = page.querySelector('.cg-details-desc');
  desc.textContent = description || 'No description available.';
  desc.classList.toggle('cg-info-desc-empty', !description);
  // "Why it's on" is written in caps for the legacy card.
  const extra = [ctx.why && menuLabel(ctx.why), ((file && file.tags) || []).join(', ')].filter(Boolean).join('  ·  ');
  page.querySelector('.cg-details-extra').textContent = extra;
  overlay.classList.add('cg-details-open');
  const crt = overlay.closest('.crt');
  showPictureBox(crt);
  if (!resizeWatch && typeof ResizeObserver !== 'undefined' && crt) {
    resizeWatch = new ResizeObserver(() => { if (page) showPictureBox(crt); });
    resizeWatch.observe(crt);
  }
}

export function hideDetailsPage(overlay) {
  if (resizeWatch) { resizeWatch.disconnect(); resizeWatch = null; }
  if (header) { header.destroy(); header = null; }
  if (page) { page.remove(); page = null; }
  overlay.classList.remove('cg-details-open');
  hidePictureBox();
}
