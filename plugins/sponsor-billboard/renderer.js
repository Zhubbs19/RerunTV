// Classic single-sponsor-era "brought to you by" billboard card — shown
// once per genuine file start (not on a break-resume of the same file) on
// any channel with a sponsor configured for it (see settings.js). Own DOM
// appended into .crt, same "own your DOM" idiom as ticker/eas-alerts;
// reacts to the 'content-playing' core hook (fired once per file start,
// playback.js's playChannelLive) so this needs zero core changes.
const cardEl = document.createElement('div');
cardEl.className = 'sponsor-billboard-card hidden';
cardEl.innerHTML = '<div class="sponsor-billboard-line">THIS PROGRAM BROUGHT TO YOU BY</div><div class="sponsor-billboard-name"></div>';
document.querySelector('.crt').appendChild(cardEl);
const nameEl = cardEl.querySelector('.sponsor-billboard-name');

const CARD_DURATION_MS = 12000;
let hideTimer = null;
// Tracks the last file path a card was (or wasn't) considered for — a
// break-resume of the SAME file re-fires 'content-playing' with an
// unchanged path, which should NOT re-show the card; a genuine new file
// (even a repeat airing later in the loop) has a path that differs from
// whatever aired immediately before it, so this is sufficient without
// needing playback.js's isEarlyInProgram machinery.
let lastFilePath = null;

function sponsorFor(channelNumber) {
  const settings = window.RCBPlugins.ctx.getPluginSettings('sponsor-billboard');
  const byChannel = (settings && settings.sponsorsByChannel) || {};
  return byChannel[String(channelNumber)] || '';
}

window.RCBPlugins.registerCoreHook('content-playing', ({ file, ch }) => {
  const path = file && file.path;
  const isNewFile = path !== lastFilePath;
  lastFilePath = path;
  if (!isNewFile) return;
  const sponsor = ch && sponsorFor(ch.number);
  if (!sponsor) return;
  clearTimeout(hideTimer);
  nameEl.textContent = sponsor;
  cardEl.classList.remove('hidden');
  // Force a reflow so a rapid re-trigger replays the entrance transition
  // instead of the browser coalescing it away — same trick dynamic-overlays.js
  // uses for its own re-trigger case.
  cardEl.classList.remove('show');
  void cardEl.offsetWidth;
  cardEl.classList.add('show');
  hideTimer = setTimeout(() => {
    cardEl.classList.remove('show');
    setTimeout(() => cardEl.classList.add('hidden'), 400);
  }, CARD_DURATION_MS);
});
