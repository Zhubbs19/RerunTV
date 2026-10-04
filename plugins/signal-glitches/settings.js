import { rearmSignalGlitches } from './renderer.js';

// The section's own `ctx.settings` is a one-time snapshot (taken when the
// panel was expanded — see setup-plugin-settings.js's makeContext), not a
// live reference, so this reads/writes through
// window.RCBPlugins.ctx.settings.getPluginSettings/updatePluginSettings
// instead, same as sponsor-billboard/music-choice-channel/film-reel-marks.
window.RCBPlugins.registerPluginSettings('signal-glitches', {
  sections: [{
    id: 'general',
    render(container, ctx) {
      const settings = window.RCBPlugins.ctx.settings.getPluginSettings('signal-glitches');
      container.innerHTML = `
        <label class="panel-toggle"><input type="checkbox" data-el="enabled">AMBIENT SIGNAL GLITCHES</label>
        <div class="panel-body">
          <div class="panel-interval">
            EVERY <input type="number" data-el="min-interval" min="1" style="max-width:5em"> TO
            <input type="number" data-el="max-interval" min="1" style="max-width:5em"> MIN
          </div>
          <div class="panel-interval">
            INTENSITY (ALL EFFECTS)
            <input type="range" data-el="intensity" min="0" max="100" step="5" style="max-width:14em">
            <span data-el="intensity-value"></span>
          </div>
          <div class="panel-interval">
            GLITCH LENGTH
            <select data-el="length">
              <option value="0.5">BRIEF (HALF)</option>
              <option value="1">NORMAL</option>
              <option value="2">LONG (DOUBLE)</option>
              <option value="3">VERY LONG</option>
            </select>
          </div>
          <div class="panel-interval">
            EFFECTS
            <label class="shuffle-toggle"><input type="checkbox" data-el="effect-static">STATIC/TEARING</label>
            <label class="shuffle-toggle"><input type="checkbox" data-el="effect-roll">PICTURE ROLL</label>
            <label class="shuffle-toggle"><input type="checkbox" data-el="effect-dropout">AUDIO WOBBLE/DROPOUT</label>
          </div>
        </div>
        <span class="panel-status">Each occurrence picks randomly among whichever effects are checked above — a brief static/tearing burst, a vertical picture roll (lost vertical hold), or an audio pitch-wobble with a couple of volume dips. None tied to weather or anything else, just an old antenna having a bad day.</span>
      `;
      const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
      const enabledEl = q('enabled');
      const minEl = q('min-interval');
      const maxEl = q('max-interval');
      const intensityEl = q('intensity');
      const intensityValueEl = q('intensity-value');
      const lengthEl = q('length');
      lengthEl.value = String(settings.lengthScale || 1);
      lengthEl.addEventListener('change', () => {
        window.RCBPlugins.ctx.settings.updatePluginSettings('signal-glitches', { lengthScale: parseFloat(lengthEl.value) || 1 });
      });
      const effectStaticEl = q('effect-static');
      const effectRollEl = q('effect-roll');
      const effectDropoutEl = q('effect-dropout');

      enabledEl.checked = !!settings.enabled;
      minEl.value = settings.minIntervalMin || 20;
      maxEl.value = settings.maxIntervalMin || 60;
      intensityEl.value = String(settings.intensity != null ? settings.intensity : 100);
      intensityValueEl.textContent = `${intensityEl.value}%`;
      const effects = settings.effects || {};
      effectStaticEl.checked = effects.static !== false;
      effectRollEl.checked = !!effects.roll;
      effectDropoutEl.checked = !!effects.dropout;

      function commit(patch) {
        window.RCBPlugins.ctx.settings.updatePluginSettings('signal-glitches', patch);
        rearmSignalGlitches();
      }
      function commitEffect(key, checked) {
        commit({ effects: { ...(window.RCBPlugins.ctx.settings.getPluginSettings('signal-glitches').effects || {}), [key]: checked } });
      }
      enabledEl.addEventListener('change', () => commit({ enabled: enabledEl.checked }));
      minEl.addEventListener('change', () => commit({ minIntervalMin: Math.max(1, parseInt(minEl.value, 10) || 20) }));
      maxEl.addEventListener('change', () => commit({ maxIntervalMin: Math.max(1, parseInt(maxEl.value, 10) || 60) }));
      intensityEl.addEventListener('input', () => {
        intensityValueEl.textContent = `${intensityEl.value}%`;
        window.RCBPlugins.ctx.settings.updatePluginSettings('signal-glitches', { intensity: Number(intensityEl.value) });
      });
      effectStaticEl.addEventListener('change', () => commitEffect('static', effectStaticEl.checked));
      effectRollEl.addEventListener('change', () => commitEffect('roll', effectRollEl.checked));
      effectDropoutEl.addEventListener('change', () => commitEffect('dropout', effectDropoutEl.checked));
    },
  }],
});
