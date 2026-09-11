// Virtual CH 100 — the mosaic preview channel a cable system used to carry:
// a grid of what is on every other channel right now, paging through the
// lineup a screenful at a time.
//
// Every tile is a PAUSED <video> seeked to that channel's live position, not
// a playing one. That is the whole design constraint. A wall of simultaneous
// decodes is exactly what the app's one-<video>-element rule exists to avoid
// (see the architecture notes on why picture-in-picture was rejected), and
// it is also what a real mosaic looked like — a page of near-stills that
// refreshed every few seconds, not twelve live feeds.
//
// A canvas snapshot would be cheaper still and is not available: media is
// served from app://media while this page is app://bundle, different origins
// on a standard scheme, and the media route sends no CORS header, so drawing
// a frame to a canvas taints it. The element itself is what gets shown.
//
// Schedule resolution stays in core (ctx.getChannelSchedule). This plugin
// owns only the presentation and its paging/refresh lifecycle.
const CHANNEL_NUMBER = 100;

let currentContainer = null;
let pageTimer = null;
let refreshTimer = null;
let clockTimer = null;
let pageIndex = 0;
// Every tile element currently on screen, so a teardown can positively
// release each one's decoder rather than trusting innerHTML alone to do it.
let liveTiles = [];

function settings(ctx) {
  const cfg = ctx.settings.getPluginSettings('mosaic') || {};
  const int = (value, min, max, fallback) => (
    Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : fallback
  );
  return {
    tilesPerPage: int(cfg.tilesPerPage, 4, 16, 9),
    pageSeconds: int(cfg.pageSeconds, 5, 120, 20),
    refreshSeconds: int(cfg.refreshSeconds, 5, 300, 15),
    showTitles: cfg.showTitles !== false,
  };
}

function stopTimers() {
  clearInterval(pageTimer); pageTimer = null;
  clearInterval(refreshTimer); refreshTimer = null;
  clearInterval(clockTimer); clockTimer = null;
}

// Dropping the src and calling load() is what actually frees a decoder;
// removing the element alone leaves it to the garbage collector, and a
// channel this page-heavy should not be waiting on that.
function releaseTiles() {
  liveTiles.forEach((video) => {
    try {
      video.removeAttribute('src');
      video.load();
    } catch (e) { /* already torn down */ }
  });
  liveTiles = [];
}

// Only real, tunable channels with content — a plugin channel has no
// schedule to resolve and nothing to pull a frame from, and a hidden channel
// is hidden everywhere else too.
function mosaicChannels(ctx) {
  return ctx.channels.sortedChannels().filter((channel) => (
    !channel.hidden && channel.number !== CHANNEL_NUMBER
  ));
}

// What is airing on one channel at this instant, plus how far into that file
// the schedule currently is — the offset is what each tile seeks to, so a
// mosaic page genuinely shows the moment those channels are at.
function liveEntry(ctx, channel) {
  const now = ctx.viewNow();
  const schedule = ctx.channels.getChannelSchedule(channel, now, now + 60000);
  const entry = schedule.find((row) => row.start <= now && row.end > now);
  if (!entry || !entry.file || !entry.file.path) return null;
  return { entry, offset: Math.max(0, (now - entry.start) / 1000) };
}

// Tiles load one after another rather than all at once. Nine simultaneous
// open-and-seek operations against the same disk (or the same network share)
// thrash it badly enough that a whole page can still be black seconds later,
// which is what the first build of this actually did. Sequenced, each frame
// lands quickly and the page fills in visibly from the top left.
const TILE_LOAD_STAGGER_MS = 140;

function buildTile(ctx, channel, opts) {
  const tile = document.createElement('div');
  tile.className = 'mosaic-tile';

  const frame = document.createElement('div');
  frame.className = 'mosaic-frame';
  tile.appendChild(frame);

  const label = document.createElement('div');
  label.className = 'mosaic-label';
  const number = document.createElement('strong');
  number.className = 'mosaic-number';
  number.textContent = String(channel.number).padStart(2, '0');
  const name = document.createElement('span');
  name.className = 'mosaic-name';
  name.textContent = channel.name || 'UNTITLED';
  label.append(number, name);
  tile.appendChild(label);

  const live = liveEntry(ctx, channel);

  if (opts.showTitles) {
    const title = document.createElement('div');
    title.className = 'mosaic-title';
    title.textContent = live ? ctx.channels.getDisplayTitle(live.entry.file) : 'OFF THE AIR';
    tile.appendChild(title);
  }

  if (!live) {
    const off = document.createElement('div');
    off.className = 'mosaic-offair';
    off.textContent = 'NO SIGNAL';
    frame.appendChild(off);
    return tile;
  }

  // Something to look at while the frame is on its way — a black rectangle
  // reads as a broken tile, and on a slow library every tile is black for a
  // moment.
  const pending = document.createElement('div');
  pending.className = 'mosaic-offair mosaic-pending';
  pending.textContent = 'TUNING';
  frame.appendChild(pending);

  const video = document.createElement('video');
  video.className = 'mosaic-video';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'metadata';
  video.tabIndex = -1;
  video.setAttribute('aria-hidden', 'true');
  frame.appendChild(video);
  liveTiles.push(video);

  const fail = () => {
    if (!frame.isConnected) return;
    video.classList.add('mosaic-video-failed');
    pending.textContent = 'NO PICTURE';
    pending.classList.remove('mosaic-pending');
  };

  video.addEventListener('loadedmetadata', () => {
    // Clamp inside the file: a schedule offset can sit a hair past the end
    // when a probed duration was slightly optimistic, and seeking past the
    // end leaves the element blank rather than erroring.
    const target = Math.min(live.offset, Math.max(0, (video.duration || 0) - 0.5));
    video.currentTime = Number.isFinite(target) ? target : 0;
  }, { once: true });
  video.addEventListener('seeked', () => {
    video.classList.add('mosaic-video-ready');
    pending.remove();
  }, { once: true });
  video.addEventListener('error', fail, { once: true });

  setTimeout(() => {
    // The tile may already have been torn down by a page turn or a tune-away
    // before its turn in the queue came up.
    if (!frame.isConnected) return;
    Promise.resolve(window.api.toFileUrl(live.entry.file.path))
      .then((url) => { if (frame.isConnected) video.src = url; })
      .catch(fail);
  }, opts.loadDelayMs || 0);

  return tile;
}

function renderPage(ctx) {
  if (!currentContainer) return;
  const grid = currentContainer.querySelector('[data-el="grid"]');
  const pager = currentContainer.querySelector('[data-el="pager"]');
  if (!grid) return;
  const opts = settings(ctx);
  const all = mosaicChannels(ctx);

  releaseTiles();
  grid.innerHTML = '';

  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'mosaic-empty';
    empty.textContent = 'NO CHANNELS TO PREVIEW — ADD ONE IN CHANNEL SETUP.';
    grid.appendChild(empty);
    if (pager) pager.textContent = '';
    return;
  }

  const pageCount = Math.max(1, Math.ceil(all.length / opts.tilesPerPage));
  // Clamped rather than wrapped: the lineup can shrink between pages, and a
  // stale index would otherwise render an empty screen once before
  // correcting itself on the next tick.
  if (pageIndex >= pageCount) pageIndex = 0;
  const start = pageIndex * opts.tilesPerPage;
  const page = all.slice(start, start + opts.tilesPerPage);

  // Column count follows the tile count so a 4-tile page fills the screen
  // instead of sitting in a 3-wide grid with a hole in it.
  const columns = Math.ceil(Math.sqrt(page.length));
  grid.style.setProperty('--mosaic-columns', String(columns));

  page.forEach((channel, i) => {
    grid.appendChild(buildTile(ctx, channel, { ...opts, loadDelayMs: i * TILE_LOAD_STAGGER_MS }));
  });
  if (pager) {
    pager.textContent = pageCount > 1
      ? `PAGE ${pageIndex + 1} OF ${pageCount} · ${all.length} CHANNELS`
      : `${all.length} CHANNEL${all.length === 1 ? '' : 'S'}`;
  }
}

function updateClock(ctx) {
  if (!currentContainer) return;
  const clock = currentContainer.querySelector('[data-el="clock"]');
  if (clock) clock.textContent = ctx.util.formatClock(new Date(ctx.viewNow()));
}

window.RCBPlugins.registerChannelType('mosaic', {
  number: CHANNEL_NUMBER,
  label: 'CHANNEL MOSAIC',
  nowText: 'What\'s On Now',
  badge: { bg: '#1d4ed8', label: 'MOSAIC' },
  // The mosaic resolves every channel through viewNow() like everything
  // else, so a time-shifted session shows what the lineup looked like then.
  supportsTimeMachine: true,
  timeMachineNowText(nowMs, ctx) {
    const count = mosaicChannels(ctx).length;
    return `MOSAIC · ${count} CHANNEL${count === 1 ? '' : 'S'}`;
  },
  render(container, ctx) {
    stopTimers();
    currentContainer = container;
    pageIndex = 0;
    container.innerHTML = `
      <div class="mosaic-channel" role="region" aria-label="Channel 100 mosaic preview">
        <header class="mosaic-header">
          <span class="mosaic-eyebrow">CHANNEL 100 · PREVIEW MOSAIC</span>
          <span class="mosaic-pager" data-el="pager"></span>
          <span class="mosaic-clock" data-el="clock">--:--</span>
        </header>
        <div class="mosaic-grid" data-el="grid"></div>
        <footer class="mosaic-footer">TYPE A CHANNEL NUMBER TO TUNE IT · PAGES ADVANCE AUTOMATICALLY</footer>
      </div>
    `;
    const opts = settings(ctx);
    renderPage(ctx);
    updateClock(ctx);
    clockTimer = setInterval(() => updateClock(ctx), 1000);
    // Refresh re-seeks the page in place so the stills track the schedule;
    // paging moves to the next screenful. Separate intervals because a
    // viewer may well want frequent refreshes on a slow page turn.
    refreshTimer = setInterval(() => renderPage(ctx), opts.refreshSeconds * 1000);
    pageTimer = setInterval(() => {
      const all = mosaicChannels(ctx);
      const pageCount = Math.max(1, Math.ceil(all.length / settings(ctx).tilesPerPage));
      pageIndex = (pageIndex + 1) % pageCount;
      renderPage(ctx);
    }, opts.pageSeconds * 1000);
  },
  stop() {
    stopTimers();
    releaseTiles();
    currentContainer = null;
  },
});
