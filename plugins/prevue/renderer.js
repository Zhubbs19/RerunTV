// Virtual CH 1 — the classic scrolling program-guide channel. Migrated
// as-is from the old core virtual.js (buildLandingRows/rebuildLandingScroll/
// updateVirtualClocks/playVirtualAudio's CH1 branch). Needs
// sortedChannels/buildChannelBadge/getChannelSchedule/getDisplayTitle/
// formatSlotLabel from core — a plugin can't import core modules directly
// (different app:// origin), so these are exposed on window.RCBPlugins.ctx
// (see plugins.js's installGlobalApi) specifically to support this channel's
// listing, which has to read the box's real channel lineup and live
// schedule rather than reimplementing that engine.
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function formatClock(d, cfg) {
  const h = d.getHours();
  const m = d.getMinutes();
  if (cfg.display && cfg.display.clock24) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  let hr = h % 12;
  if (hr === 0) hr = 12;
  return `${hr}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

let currentContainer = null;
let clockTimer = null;
let rebuildTimer = null;

function buildLandingRows(ctx) {
  const rows = document.createElement('div');
  ctx.sortedChannels().forEach((ch) => {
    const schedule = ctx.getChannelSchedule(ch, ctx.viewNow(), ctx.viewNow() + 3 * 3600000);
    const nowEntry = schedule[0];
    const nextEntry = schedule[1];

    const row = document.createElement('div');
    row.className = 'landing-row';
    row.appendChild(ctx.buildChannelBadge(ch, { small: true, editable: false }));

    const chanEl = document.createElement('div');
    chanEl.className = 'lr-chan';
    chanEl.textContent = `${String(ch.number).padStart(2, '0')} ${ch.name || 'UNTITLED'}`;
    row.appendChild(chanEl);

    const nowEl = document.createElement('div');
    nowEl.className = 'lr-now';
    nowEl.innerHTML = `<span class="lr-label">NOW</span>`;
    nowEl.appendChild(document.createTextNode(nowEntry ? ctx.getDisplayTitle(nowEntry.file) : '—'));
    row.appendChild(nowEl);

    const nextEl = document.createElement('div');
    nextEl.className = 'lr-next';
    nextEl.innerHTML = `<span class="lr-label">NEXT</span>`;
    nextEl.appendChild(document.createTextNode(nextEntry ? `${ctx.formatSlotLabel(nextEntry.start)} ${ctx.getDisplayTitle(nextEntry.file)}` : '—'));
    row.appendChild(nextEl);

    rows.appendChild(row);
  });
  return rows;
}

function rebuildLandingScroll(ctx) {
  if (!currentContainer) return;
  const scrollEl = currentContainer.querySelector('[data-el="scroll"]');
  if (!scrollEl) return;
  scrollEl.innerHTML = '';
  const first = buildLandingRows(ctx);
  const rowCount = first.children.length;
  scrollEl.appendChild(first);
  // Marquee technique: content duplicated once, keyframe scrolls -50%.
  scrollEl.appendChild(buildLandingRows(ctx));
  scrollEl.style.setProperty('--landing-scroll-secs', `${Math.max(12, rowCount * 5)}s`);
}

function updateClock(ctx) {
  if (!currentContainer) return;
  const d = new Date(ctx.viewNow());
  currentContainer.querySelector('[data-el="clock"]').textContent = formatClock(d, ctx.S.config);
  currentContainer.querySelector('[data-el="date"]').textContent = `${WEEKDAYS[d.getDay()]} · ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

window.RCBPlugins.registerChannelType('prevue', {
  number: 1,
  label: 'PREVIEW GUIDE',
  nowText: 'Program Listings',
  badge: { bg: '#0077ff', label: 'GUIDE' },
  render(container, ctx) {
    currentContainer = container;
    container.innerHTML = `
      <div class="landing-channel">
        <div class="landing-header">
          <div class="landing-brand">RETRO CABLE BOX</div>
          <div class="landing-promo" aria-hidden="true">
            <span>TONIGHT ON THE RETRO CABLE BOX</span>
            <span>STAY TUNED FOR MORE GREAT PROGRAMMING</span>
            <span>YOUR LOCAL CABLE COMPANY WELCOMES YOU</span>
            <span>PRESS GUIDE TO SEE WHAT'S PLAYING NOW</span>
          </div>
          <div class="landing-clockbox">
            <div class="landing-clock" data-el="clock">--:--</div>
            <div class="landing-date" data-el="date"></div>
          </div>
        </div>
        <div class="landing-listings">
          <div class="landing-scroll" data-el="scroll"></div>
        </div>
      </div>
    `;

    updateClock(ctx);
    clockTimer = setInterval(() => updateClock(ctx), 1000);
    rebuildLandingScroll(ctx);
    rebuildTimer = setInterval(() => rebuildLandingScroll(ctx), 30000);

    // Background audio loop — same "resolve the file URL, bail if tuned
    // away before it resolves" pattern core's old playVirtualAudio used.
    const audioPath = ctx.S.config.landing && ctx.S.config.landing.audio;
    if (audioPath) {
      window.api.toFileUrl(audioPath).then((url) => {
        if (currentContainer !== container) return; // tuned away while resolving
        ctx.player.src = url;
        ctx.player.loop = true;
        ctx.player.play().catch(() => {});
      });
    }
  },
  stop() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    if (rebuildTimer) { clearInterval(rebuildTimer); rebuildTimer = null; }
    currentContainer = null;
  },
});

window.RCBPlugins.registerSettingsPanel('prevue', {
  render(container, ctx) {
    if (!ctx.S.config.landing) ctx.S.config.landing = { audio: null };
    const cfg = ctx.S.config.landing;
    container.innerHTML = `
      <label class="panel-toggle">CH 1 — PREVIEW GUIDE CHANNEL AUDIO</label>
      <div class="panel-body">
        <button type="button" data-el="audio-btn" class="btn">CHOOSE BACKGROUND AUDIO</button>
        <button type="button" data-el="audio-clear-btn" class="btn remove-btn">CLEAR</button>
      </div>
      <span data-el="audio-status" class="panel-status">No audio assigned</span>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const audioStatusEl = q('audio-status');

    const renderAudioStatus = () => {
      audioStatusEl.textContent = cfg.audio
        ? `Now playing: ${cfg.audio.split(/[\\/]/).pop()}`
        : 'No audio assigned';
    };
    renderAudioStatus();

    q('audio-btn').addEventListener('click', async () => {
      const filePath = await window.api.selectAudio();
      if (!filePath) return;
      cfg.audio = filePath;
      renderAudioStatus();
      ctx.saveConfigDebounced();
    });
    q('audio-clear-btn').addEventListener('click', () => {
      cfg.audio = null;
      renderAudioStatus();
      ctx.saveConfigDebounced();
    });
  },
});
