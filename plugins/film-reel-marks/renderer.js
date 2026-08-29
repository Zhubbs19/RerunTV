// The real projectionist's reel-change cue dot — a small circle that
// flashed briefly in a movie's top-right corner every ~20 minutes marking
// where a projectionist needed to swap reels. Own DOM appended into .crt,
// same idiom as sponsor-billboard; reacts to the existing 'content-playing'
// core hook so this needs zero core changes. Distinct from the VHS
// progressive-tape-wear feature — that's tape artifacts, this is film-print
// artifacts, and only ever applies to contentType:'movie' files.
const dotEl = document.createElement('div');
dotEl.className = 'film-reel-mark hidden';
document.querySelector('.crt').appendChild(dotEl);

let lastFilePath = null;
let intervalTimer = null;

function cfg() {
  const settings = window.RCBPlugins.ctx.getPluginSettings('film-reel-marks');
  return {
    enabled: settings.enabled !== false, // default on
    intervalMin: settings.intervalMin || 20,
    channelOverrides: settings.channelOverrides || {},
  };
}

// A per-channel override (true/false) beats the global default; unset
// (no key in channelOverrides) inherits it. Same shape as sponsor-
// billboard's sponsorsByChannel map, just booleans instead of names.
function enabledForChannel(ch) {
  const { enabled, channelOverrides } = cfg();
  const override = channelOverrides[String(ch.number)];
  return override != null ? override : enabled;
}

function flashDot() {
  dotEl.classList.remove('hidden');
  dotEl.classList.remove('show');
  void dotEl.offsetWidth; // force reflow so back-to-back flashes replay
  dotEl.classList.add('show');
  setTimeout(() => dotEl.classList.remove('show'), 1200);
}

function stopChain() {
  clearInterval(intervalTimer);
  intervalTimer = null;
}

window.RCBPlugins.registerCoreHook('content-playing', ({ file, ch }) => {
  const path = file && file.path;
  const isNewFile = path !== lastFilePath;
  lastFilePath = path;
  if (!isNewFile) return; // break-resume of the same file — chain already running
  stopChain();
  const isMovie = file && file.facets && file.facets.contentType === 'movie';
  if (!isMovie || !ch || !enabledForChannel(ch)) return;
  const { intervalMin } = cfg();
  intervalTimer = setInterval(flashDot, Math.max(1, intervalMin) * 60000);
});
