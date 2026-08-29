import { rearmSignalGlitches } from './renderer.js';

window.RCBPlugins.registerPluginSettings('signal-glitches', {
  sections: [{
    id: 'general',
    render(container, ctx) {
      const settings = ctx.getPluginSettings('signal-glitches');
      container.innerHTML = `
        <label class="panel-toggle"><input type="checkbox" data-el="enabled">AMBIENT SIGNAL GLITCHES</label>
        <div class="panel-body">
          <div class="panel-interval">
            EVERY <input type="number" data-el="min-interval" min="1" style="max-width:5em"> TO
            <input type="number" data-el="max-interval" min="1" style="max-width:5em"> MIN
          </div>
          <div class="panel-interval">
            INTENSITY
            <input type="range" data-el="intensity" min="0" max="100" step="5" style="max-width:14em">
            <span data-el="intensity-value"></span>
          </div>
        </div>
        <span class="panel-status">A brief, rare static/tearing burst with no real-world trigger — not tied to weather or anything else, just an old antenna having a bad day.</span>
      `;
      const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
      const enabledEl = q('enabled');
      const minEl = q('min-interval');
      const maxEl = q('max-interval');
      const intensityEl = q('intensity');
      const intensityValueEl = q('intensity-value');

      enabledEl.checked = !!settings.enabled;
      minEl.value = settings.minIntervalMin || 20;
      maxEl.value = settings.maxIntervalMin || 60;
      intensityEl.value = String(settings.intensity != null ? settings.intensity : 100);
      intensityValueEl.textContent = `${intensityEl.value}%`;

      function commit(patch) {
        ctx.updatePluginSettings('signal-glitches', patch);
        rearmSignalGlitches();
      }
      enabledEl.addEventListener('change', () => commit({ enabled: enabledEl.checked }));
      minEl.addEventListener('change', () => commit({ minIntervalMin: Math.max(1, parseInt(minEl.value, 10) || 20) }));
      maxEl.addEventListener('change', () => commit({ maxIntervalMin: Math.max(1, parseInt(maxEl.value, 10) || 60) }));
      intensityEl.addEventListener('input', () => {
        intensityValueEl.textContent = `${intensityEl.value}%`;
        ctx.updatePluginSettings('signal-glitches', { intensity: Number(intensityEl.value) });
      });
    },
  }],
});
