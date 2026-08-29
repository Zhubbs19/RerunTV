// Classic single-sponsor-era "brought to you by" billboard card — shown
// once per genuine file start (not on a break-resume of the same file) on
// any channel with a sponsor configured for it (see settings.js). Own DOM
// appended into .crt, same "own your DOM" idiom as ticker/eas-alerts;
// reacts to the 'content-playing' core hook (fired once per file start,
// playback.js's playChannelLive) so this needs zero core changes.
const cardEl = document.createElement('div');
cardEl.className = 'sponsor-billboard-card hidden';
cardEl.innerHTML = `
  <div class="sponsor-billboard-line">THIS PROGRAM BROUGHT TO YOU BY</div>
  <div class="sponsor-billboard-media"></div>
  <div class="sponsor-billboard-name"></div>
`;
document.querySelector('.crt').appendChild(cardEl);
const mediaEl = cardEl.querySelector('.sponsor-billboard-media');
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

const VIDEO_EXT_RE = /\.(mp4|webm|mov|m4v|ogv)$/i;

// A pre-image/video sponsor entry was a plain string (the name) —
// normalized to today's { name, mediaPath } shape here so an existing
// config keeps working unchanged after this upgrade.
function sponsorFor(channelNumber) {
  const settings = window.RCBPlugins.ctx.getPluginSettings('sponsor-billboard');
  const byChannel = (settings && settings.sponsorsByChannel) || {};
  const entry = byChannel[String(channelNumber)];
  if (!entry) return null;
  if (typeof entry === 'string') return entry ? { name: entry, mediaPath: '' } : null;
  return (entry.name || entry.mediaPath) ? entry : null;
}

window.RCBPlugins.registerCoreHook('content-playing', ({ file, ch }) => {
  const path = file && file.path;
  const isNewFile = path !== lastFilePath;
  lastFilePath = path;
  if (!isNewFile) return;
  const sponsor = ch && sponsorFor(ch.number);
  if (!sponsor) return;
  clearTimeout(hideTimer);
  nameEl.textContent = sponsor.name || '';
  nameEl.classList.toggle('hidden', !sponsor.name);
  mediaEl.innerHTML = '';
  if (sponsor.mediaPath) {
    const isVideo = VIDEO_EXT_RE.test(sponsor.mediaPath);
    const media = document.createElement(isVideo ? 'video' : 'img');
    if (isVideo) {
      media.muted = true;
      media.loop = true;
      media.autoplay = true;
      media.playsInline = true;
    }
    window.api.toFileUrl(sponsor.mediaPath).then((url) => {
      media.src = url;
      if (isVideo) media.play().catch(() => {});
    });
    mediaEl.appendChild(media);
    mediaEl.classList.remove('hidden');
  } else {
    mediaEl.classList.add('hidden');
  }
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
