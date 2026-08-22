// Virtual CH 2 — a community bulletin-board channel, rotating your own
// announcement slides. Migrated as-is from the old core virtual.js
// (showPubAccessSlide/updateVirtualClocks/playVirtualAudio's CH2 branch).
// Unlike most plugin channels, this one has its own independent on/off
// toggle (the `enabled` hook below) — installing/enabling this plugin makes
// CH 2 available to turn on, but doesn't show it on its own; see this
// plugin's own SETTINGS panel. Uses ctx.formatClock (window.RCBPlugins.ctx,
// see plugins.js's installGlobalApi) rather than its own copy, same
// can't-import-core-directly reason as prevue's identical clock display.
// This plugin's own config namespace, seeded here (not by core) — see
// [[retro_cable_box_plugin_system]].
if (!window.RCBPlugins.ctx.S.config.publicAccess) window.RCBPlugins.ctx.S.config.publicAccess = { enabled: false, slides: [] };

let currentContainer = null;
let clockTimer = null;
let slideTimer = null;
let slideIdx = 0;

function showSlide(ctx) {
  if (!currentContainer) return;
  const slideEl = currentContainer.querySelector('[data-el="slide"]');
  if (!slideEl) return;
  const slides = ((ctx.S.config.publicAccess && ctx.S.config.publicAccess.slides) || []).filter((s) => s && s.trim());
  if (slides.length === 0) {
    slideEl.textContent = 'Welcome to the community bulletin board.\nAdd announcements in this plugin’s settings.';
    return;
  }
  slideIdx = slideIdx % slides.length;
  slideEl.textContent = slides[slideIdx];
}

function updateClock(ctx) {
  if (!currentContainer) return;
  const d = new Date(ctx.viewNow());
  currentContainer.querySelector('[data-el="clock"]').textContent = ctx.formatClock(d);
}

window.RCBPlugins.registerChannelType('public-access', {
  number: 2,
  label: 'PUBLIC ACCESS',
  nowText: 'Community Bulletin Board',
  badge: { bg: '#f59e0b', label: 'PUB' },
  enabled(ctx) {
    return !!(ctx.S.config.publicAccess && ctx.S.config.publicAccess.enabled);
  },
  render(container, ctx) {
    currentContainer = container;
    slideIdx = 0;
    container.innerHTML = `
      <div class="public-access">
        <div class="pubaccess-eyebrow">COMMUNITY BULLETIN BOARD</div>
        <div class="pubaccess-clock" data-el="clock">--:--</div>
        <div class="pubaccess-slide" data-el="slide"></div>
      </div>
    `;

    updateClock(ctx);
    clockTimer = setInterval(() => updateClock(ctx), 1000);
    showSlide(ctx);
    slideTimer = setInterval(() => {
      slideIdx++;
      showSlide(ctx);
    }, 15000);

    // Background audio loop — same "resolve the file URL, bail if tuned
    // away before it resolves" pattern core's old playVirtualAudio used.
    const audioPath = ctx.S.config.publicAccess && ctx.S.config.publicAccess.audio;
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
    if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
    currentContainer = null;
  },
});

window.RCBPlugins.registerSettingsPanel('public-access', {
  render(container, ctx) {
    if (!ctx.S.config.publicAccess) ctx.S.config.publicAccess = { enabled: false, slides: [], audio: null };
    const cfg = ctx.S.config.publicAccess;
    container.innerHTML = `
      <label class="panel-toggle">
        <input type="checkbox" data-el="enabled">
        PUBLIC ACCESS CHANNEL (CH 2)
      </label>
      <div class="panel-body">
        <button type="button" data-el="audio-btn" class="btn">CHOOSE BACKGROUND AUDIO</button>
        <button type="button" data-el="audio-clear-btn" class="btn remove-btn">CLEAR</button>
      </div>
      <span data-el="audio-status" class="panel-status">No audio assigned</span>
      <div data-el="slides" class="titles-list"></div>
      <button type="button" data-el="add-slide-btn" class="btn">+ ADD BULLETIN SLIDE</button>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('enabled');
    const audioStatusEl = q('audio-status');
    const slidesEl = q('slides');

    const renderAudioStatus = () => {
      audioStatusEl.textContent = cfg.audio
        ? `Now playing: ${cfg.audio.split(/[\\/]/).pop()}`
        : 'No audio assigned';
    };

    const renderSlides = () => {
      slidesEl.innerHTML = '';
      (cfg.slides || []).forEach((text, idx) => {
        const row = document.createElement('div');
        row.className = 'pubaccess-slide-row';
        const input = document.createElement('textarea');
        input.className = 'pubaccess-slide-input';
        input.rows = 2;
        input.value = text;
        input.placeholder = 'Bulletin text…';
        input.addEventListener('input', () => {
          cfg.slides[idx] = input.value;
          ctx.saveConfigDebounced();
        });
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn remove-btn';
        removeBtn.textContent = 'X';
        removeBtn.title = 'REMOVE';
        removeBtn.setAttribute('aria-label', 'Remove slide');
        removeBtn.addEventListener('click', () => {
          cfg.slides.splice(idx, 1);
          renderSlides();
          ctx.saveConfigDebounced();
        });
        row.appendChild(input);
        row.appendChild(removeBtn);
        slidesEl.appendChild(row);
      });
    };

    enabledEl.checked = !!cfg.enabled;
    renderAudioStatus();
    renderSlides();

    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
    });
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
    q('add-slide-btn').addEventListener('click', () => {
      if (!cfg.slides) cfg.slides = [];
      cfg.slides.push('');
      renderSlides();
      ctx.saveConfigDebounced();
    });
  },
});
