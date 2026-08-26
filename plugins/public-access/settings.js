window.RCBPlugins.registerPluginSettings('public-access', {
  sections: [{
    id: 'general',
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
      <div class="panel-interval">
        SLIDE ROTATION <input type="number" min="3" max="120" data-el="slide-interval" style="width:70px"> SEC
      </div>
      <div data-el="slides" class="titles-list"></div>
      <button type="button" data-el="add-slide-btn" class="btn">+ ADD BULLETIN SLIDE</button>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('enabled');
    const audioStatusEl = q('audio-status');
    const slideIntervalEl = q('slide-interval');
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
    slideIntervalEl.value = cfg.slideIntervalSec || 15;
    renderAudioStatus();
    renderSlides();

    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
    });
    slideIntervalEl.addEventListener('change', () => {
      const n = parseInt(slideIntervalEl.value, 10);
      cfg.slideIntervalSec = (Number.isFinite(n) && n >= 3) ? n : 15;
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
  }],
});

