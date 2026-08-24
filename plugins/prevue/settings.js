// Settings entry point for the Prevue channel. Core automatically prepends
// the standard channel display controls; this file contributes only the
// audio setting unique to Prevue.
window.RCBPlugins.registerPluginSettings('prevue', {
  sections: [{
    id: 'audio',
    label: 'PREVIEW GUIDE CHANNEL AUDIO',
    render(container, ctx) {
      if (!ctx.S.config.landing) ctx.S.config.landing = { audio: null };
      const cfg = ctx.S.config.landing;
      container.innerHTML = `
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
  }],
});
