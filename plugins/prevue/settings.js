// Settings unique to CH 1. Core prepends the standard channel display-mode
// controls registered for every plugin-owned channel.
window.RCBPlugins.registerPluginSettings('prevue', {
  sections: [{
    id: 'presentation',
    label: 'PREVIEW GUIDE PRESENTATION',
    description: 'Customize the guide station identity and the pace of its broadcast crawl.',
    layout: 'two-column',
    render(container, ctx) {
      if (!ctx.S.config.landing || typeof ctx.S.config.landing !== 'object') ctx.S.config.landing = {};
      const cfg = ctx.S.config.landing;
      if (!['slow', 'classic', 'fast'].includes(cfg.scrollPace)) cfg.scrollPace = 'classic';
      if (cfg.rotateSpotlight == null) cfg.rotateSpotlight = true;
      container.innerHTML = `
        <label class="plugin-settings-field">
          <span>GUIDE STATION LABEL</span>
          <input type="text" data-el="label" maxlength="28" placeholder="RERUNTV PROGRAM GUIDE">
          <small>Shown in the upper-left station identity block.</small>
        </label>
        <label class="plugin-settings-field">
          <span>LISTING CRAWL SPEED</span>
          <select data-el="pace">
            <option value="slow">SLOW · 7 SECONDS PER ROW</option>
            <option value="classic">CLASSIC · 5 SECONDS PER ROW</option>
            <option value="fast">FAST · 3 SECONDS PER ROW</option>
          </select>
          <small>The complete channel lineup always loops continuously.</small>
        </label>
        <label class="plugin-settings-field plugin-settings-checkbox">
          <input type="checkbox" data-el="rotate">
          <span>ROTATE THE NOW-PLAYING SPOTLIGHT</span>
          <small>Cycles the upper program card through configured channels every eight seconds.</small>
        </label>
        <div class="plugin-settings-field">
          <span>BACKGROUND AUDIO</span>
          <div class="plugin-settings-actions">
            <button type="button" data-el="audio-btn" class="btn">CHOOSE AUDIO</button>
            <button type="button" data-el="audio-clear-btn" class="btn remove-btn">CLEAR</button>
          </div>
          <small data-el="audio-status">No audio assigned</small>
        </div>
      `;
      const q = (name) => container.querySelector(`[data-el="${name}"]`);
      const label = q('label');
      const pace = q('pace');
      const rotate = q('rotate');
      const audioStatus = q('audio-status');
      label.value = typeof cfg.label === 'string' ? cfg.label : '';
      pace.value = cfg.scrollPace;
      rotate.checked = cfg.rotateSpotlight !== false;

      const renderAudioStatus = () => {
        audioStatus.textContent = cfg.audio
          ? `Now playing: ${cfg.audio.split(/[\\/]/).pop()}`
          : 'No audio assigned';
      };
      renderAudioStatus();
      label.addEventListener('input', () => {
        const value = label.value.trim().slice(0, 28);
        if (value) cfg.label = value; else delete cfg.label;
        ctx.saveConfigDebounced();
      });
      pace.addEventListener('change', () => {
        cfg.scrollPace = pace.value;
        ctx.saveConfigDebounced();
      });
      rotate.addEventListener('change', () => {
        cfg.rotateSpotlight = rotate.checked;
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
    },
  }],
});
