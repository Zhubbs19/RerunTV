// Virtual CH 1 — a continuously running broadcast-guide channel. Schedule
// resolution stays in core; this plugin owns only the presentation and its
// small rotation/clock lifecycle.
let currentContainer = null;
let clockTimer = null;
let rebuildTimer = null;
let spotlightTimer = null;
let spotlightIndex = 0;

function landingConfig(ctx) {
  const cfg = ctx.S.config.landing || {};
  return {
    label: typeof cfg.label === 'string' && cfg.label.trim() ? cfg.label.trim().slice(0, 28) : 'RERUNTV PROGRAM GUIDE',
    scrollPace: ['slow', 'classic', 'fast'].includes(cfg.scrollPace) ? cfg.scrollPace : 'classic',
    rotateSpotlight: cfg.rotateSpotlight !== false,
    spotlightSeconds: (Number.isFinite(cfg.spotlightSeconds) && cfg.spotlightSeconds >= 3) ? cfg.spotlightSeconds : 8,
    audio: cfg.audio || null,
  };
}

function channelSnapshot(ctx, channel) {
  const now = ctx.viewNow();
  const schedule = ctx.getChannelSchedule(channel, now, now + 3 * 3600000);
  const current = schedule.find((entry) => entry.start <= now && entry.end > now) || schedule[0] || null;
  const currentIndex = current ? schedule.indexOf(current) : -1;
  const next = currentIndex >= 0 ? schedule[currentIndex + 1] || null : schedule[1] || null;
  const progress = current && current.end > current.start
    ? Math.max(0, Math.min(1, (now - current.start) / (current.end - current.start)))
    : 0;
  return { channel, current, next, progress };
}

function programTitle(ctx, entry, fallback = 'NO PROGRAM INFORMATION') {
  return entry ? ctx.getDisplayTitle(entry.file) : fallback;
}

function buildLandingRows(ctx, snapshots, duplicate = false) {
  const rows = document.createElement('div');
  rows.className = 'landing-rowset';
  if (duplicate) rows.setAttribute('aria-hidden', 'true');
  snapshots.forEach(({ channel, current, next, progress }) => {
    const row = document.createElement('div');
    row.className = 'landing-row';
    row.dataset.channel = String(channel.number);
    row.appendChild(ctx.buildChannelBadge(channel, { small: true, editable: false }));

    const channelCell = document.createElement('div');
    channelCell.className = 'lr-channel';
    const number = document.createElement('strong');
    number.className = 'lr-number';
    number.textContent = String(channel.number).padStart(2, '0');
    const name = document.createElement('span');
    name.className = 'lr-name';
    name.textContent = channel.name || 'UNTITLED';
    channelCell.append(number, name);

    const nowCell = document.createElement('div');
    nowCell.className = 'lr-program lr-now';
    const nowTitle = document.createElement('strong');
    nowTitle.textContent = programTitle(ctx, current);
    const nowMeta = document.createElement('span');
    nowMeta.textContent = current
      ? `${ctx.formatSlotLabel(current.start)}–${ctx.formatSlotLabel(current.end)}`
      : 'SCHEDULE UNAVAILABLE';
    const progressTrack = document.createElement('span');
    progressTrack.className = 'lr-progress';
    progressTrack.setAttribute('aria-hidden', 'true');
    const progressFill = document.createElement('span');
    progressFill.style.width = `${Math.round(progress * 100)}%`;
    progressTrack.appendChild(progressFill);
    nowCell.append(nowTitle, nowMeta, progressTrack);

    const nextCell = document.createElement('div');
    nextCell.className = 'lr-program lr-next';
    const nextTitle = document.createElement('strong');
    nextTitle.textContent = programTitle(ctx, next, 'NO LATER LISTING');
    const nextMeta = document.createElement('span');
    nextMeta.textContent = next ? `STARTS ${ctx.formatSlotLabel(next.start)}` : '—';
    nextCell.append(nextTitle, nextMeta);

    row.append(channelCell, nowCell, nextCell);
    rows.appendChild(row);
  });
  return rows;
}

function snapshots(ctx) {
  return ctx.sortedChannels().map((channel) => channelSnapshot(ctx, channel));
}

function rebuildLandingScroll(ctx) {
  if (!currentContainer) return;
  const scroll = currentContainer.querySelector('[data-el="scroll"]');
  if (!scroll) return;
  const entries = snapshots(ctx);
  scroll.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'landing-empty';
    empty.textContent = 'NO CHANNELS HAVE BEEN CONFIGURED';
    scroll.appendChild(empty);
    scroll.classList.add('is-static');
    updateSpotlight(ctx, []);
    return;
  }
  scroll.classList.remove('is-static');
  scroll.append(buildLandingRows(ctx, entries), buildLandingRows(ctx, entries, true));
  const pace = { slow: 7, classic: 5, fast: 3 }[landingConfig(ctx).scrollPace];
  scroll.style.setProperty('--landing-scroll-secs', `${Math.max(14, entries.length * pace)}s`);
  updateSpotlight(ctx, entries);
}

function updateClock(ctx) {
  if (!currentContainer) return;
  const date = new Date(ctx.viewNow());
  const clock = currentContainer.querySelector('[data-el="clock"]');
  const dateElement = currentContainer.querySelector('[data-el="date"]');
  if (clock) clock.textContent = ctx.formatClock(date);
  if (dateElement) dateElement.textContent = `${ctx.WEEKDAYS[date.getDay()]} · ${ctx.MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function updateSpotlight(ctx, providedSnapshots) {
  if (!currentContainer) return;
  const entries = providedSnapshots || snapshots(ctx);
  const spotlight = currentContainer.querySelector('[data-el="spotlight"]');
  if (!spotlight) return;
  if (!entries.length) {
    spotlight.classList.add('is-empty');
    spotlight.querySelector('[data-el="spotlight-title"]').textContent = 'SET UP YOUR FIRST CHANNEL';
    spotlight.querySelector('[data-el="spotlight-meta"]').textContent = 'PRESS S TO OPEN CHANNEL SETUP';
    spotlight.querySelector('[data-el="spotlight-next"]').textContent = 'PROGRAM LISTINGS WILL APPEAR HERE';
    spotlight.querySelector('[data-el="spotlight-badge"]').innerHTML = '';
    return;
  }
  spotlight.classList.remove('is-empty');
  spotlightIndex %= entries.length;
  const { channel, current, next, progress } = entries[spotlightIndex];
  const badgeHost = spotlight.querySelector('[data-el="spotlight-badge"]');
  badgeHost.innerHTML = '';
  badgeHost.appendChild(ctx.buildChannelBadge(channel, { small: false, editable: false }));
  spotlight.querySelector('[data-el="spotlight-kicker"]').textContent = `NOW ON CHANNEL ${String(channel.number).padStart(2, '0')}`;
  spotlight.querySelector('[data-el="spotlight-title"]').textContent = programTitle(ctx, current);
  spotlight.querySelector('[data-el="spotlight-meta"]').textContent = current
    ? `${ctx.formatSlotLabel(current.start)}–${ctx.formatSlotLabel(current.end)} · ${channel.name || 'UNTITLED'}`
    : channel.name || 'UNTITLED';
  spotlight.querySelector('[data-el="spotlight-next"]').textContent = next
    ? `NEXT ${ctx.formatSlotLabel(next.start)} · ${programTitle(ctx, next)}`
    : 'NEXT · NO LATER LISTING';
  spotlight.style.setProperty('--spotlight-progress', `${Math.round(progress * 100)}%`);
  spotlight.classList.remove('is-changing');
  void spotlight.offsetWidth;
  spotlight.classList.add('is-changing');
}

function advanceSpotlight(ctx) {
  if (!currentContainer || !landingConfig(ctx).rotateSpotlight) return;
  spotlightIndex += 1;
  updateSpotlight(ctx);
}

function stopTimers() {
  if (clockTimer) clearInterval(clockTimer);
  if (rebuildTimer) clearInterval(rebuildTimer);
  if (spotlightTimer) clearInterval(spotlightTimer);
  clockTimer = null;
  rebuildTimer = null;
  spotlightTimer = null;
}

window.RCBPlugins.registerChannelType('guide-channel', {
  number: 1,
  label: 'PREVIEW GUIDE',
  nowText: 'Program Listings',
  badge: { bg: '#0077ff', label: 'GUIDE' },
  render(container, ctx) {
    stopTimers();
    currentContainer = container;
    spotlightIndex = 0;
    const cfg = landingConfig(ctx);
    container.innerHTML = `
      <div class="landing-channel" role="region" aria-label="Channel 1 program guide">
        <header class="landing-header">
          <section class="landing-identity">
            <span class="landing-eyebrow">CHANNEL 01 · LOCAL LISTINGS</span>
            <div class="landing-brand"></div>
            <span class="landing-tagline">WHAT'S ON NOW · WHAT'S ON NEXT</span>
          </section>
          <section class="landing-spotlight" data-el="spotlight" aria-live="polite">
            <div class="landing-spotlight-badge" data-el="spotlight-badge"></div>
            <div class="landing-spotlight-copy">
              <span class="landing-spotlight-kicker" data-el="spotlight-kicker">NOW ON CHANNEL</span>
              <strong class="landing-spotlight-title" data-el="spotlight-title">LOADING LISTINGS</strong>
              <span class="landing-spotlight-meta" data-el="spotlight-meta"></span>
              <span class="landing-spotlight-next" data-el="spotlight-next"></span>
            </div>
            <span class="landing-spotlight-progress" aria-hidden="true"><i></i></span>
          </section>
          <section class="landing-clockbox" aria-label="Current time and date">
            <span class="landing-live"><i></i> LIVE</span>
            <div class="landing-clock" data-el="clock">--:--</div>
            <div class="landing-date" data-el="date"></div>
          </section>
        </header>
        <div class="landing-bulletin" aria-hidden="true">
          <span>TONIGHT'S PROGRAMS ARE LISTED BELOW</span>
          <span>PRESS GUIDE FOR THE INTERACTIVE GRID</span>
          <span>CHANNEL TIMES UPDATE AUTOMATICALLY</span>
          <span>YOU'RE WATCHING CHANNEL 01</span>
        </div>
        <div class="landing-listing-head" aria-hidden="true">
          <span>CHANNEL</span><span>NOW PLAYING</span><span>UP NEXT</span>
        </div>
        <div class="landing-listings"><div class="landing-scroll" data-el="scroll"></div></div>
      </div>
    `;
    currentContainer.querySelector('.landing-brand').textContent = cfg.label;

    updateClock(ctx);
    rebuildLandingScroll(ctx);
    clockTimer = setInterval(() => updateClock(ctx), 1000);
    rebuildTimer = setInterval(() => rebuildLandingScroll(ctx), 30000);
    spotlightTimer = setInterval(() => advanceSpotlight(ctx), cfg.spotlightSeconds * 1000);

    if (cfg.audio) {
      window.api.toFileUrl(cfg.audio).then((url) => {
        if (currentContainer !== container) return;
        ctx.player.src = url;
        ctx.player.loop = true;
        ctx.player.play().catch(() => {});
      });
    }
  },
  stop() {
    stopTimers();
    currentContainer = null;
  },
});
