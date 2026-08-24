import { applyThemeAudio } from './renderer.js';

window.RCBPlugins.registerPluginSettings('vintage-audio', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.vintageAudio) ctx.S.config.vintageAudio = { enabled: true, cutoffHz: 3500, themeAmbient: true, clicks: true };
    const cfg = ctx.S.config.vintageAudio;
    if (cfg.themeAmbient == null) cfg.themeAmbient = true;
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled">VINTAGE CRT AUDIO FILTER, AMBIENT TEXTURE &amp; SFX</label>
      <div class="panel-body crt-sliders">
        <label class="crt-slider">SPEAKER LOWPASS CUTOFF (Hz) <input type="range" min="1500" max="8000" data-el="cutoff"></label>
        <label class="shuffle-toggle"><input type="checkbox" data-el="theme-ambient">THEME AMBIENT HUM / HISS / CARRIER</label>
        <label class="shuffle-toggle"><input type="checkbox" data-el="clicks">MECHANICAL CABLE BOX CLICK SFX</label>
      </div>
      <span class="panel-status">Adds a theme-tied ambient texture — tape hiss/crackle, console hum, UHF static, or satellite tone — depending on the active guide/OSD theme, plus a mechanical channel-change click.</span>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('enabled');
    const cutoffEl = q('cutoff');
    const ambientEl = q('theme-ambient');
    const clicksEl = q('clicks');
    enabledEl.checked = cfg.enabled !== false;
    cutoffEl.value = cfg.cutoffHz || 3500;
    ambientEl.checked = cfg.themeAmbient !== false;
    clicksEl.checked = cfg.clicks !== false;
    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
      applyThemeAudio();
    });
    cutoffEl.addEventListener('input', () => {
      cfg.cutoffHz = parseInt(cutoffEl.value, 10);
      ctx.saveConfigDebounced();
    });
    ambientEl.addEventListener('change', () => {
      cfg.themeAmbient = ambientEl.checked;
      ctx.saveConfigDebounced();
      applyThemeAudio();
    });
    clicksEl.addEventListener('change', () => {
      cfg.clicks = clicksEl.checked;
      ctx.saveConfigDebounced();
    });
    },
  }],
});

