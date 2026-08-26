import { setCaptionsEnabled, applyCaptionStyle } from './renderer.js';

window.RCBPlugins.registerPluginSettings('closed-captions', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.closedCaptions) ctx.S.config.closedCaptions = { enabled: false };
    const c = ctx.S.config.closedCaptions;
    if (!c.sizeScale) c.sizeScale = 1;
    container.innerHTML = `
      <label class="panel-toggle">
        <input type="checkbox" id="cc-plugin-enabled">
        CLOSED CAPTIONS (K TO TOGGLE)
      </label>
      <div class="panel-interval">
        CAPTION SIZE
        <select data-el="size">
          <option value="0.85">SMALL</option>
          <option value="1">NORMAL</option>
          <option value="1.25">LARGE</option>
          <option value="1.5">X-LARGE</option>
        </select>
      </div>
      <span class="panel-status">Real captions only — a sidecar .srt/.vtt file next to the video, or a subtitle stream already embedded in the file. Nothing is auto-generated. Caption styling (color/background/font) follows the active guide/OSD theme; size is yours to scale independently.</span>
    `;
    const enabledEl = container.querySelector('#cc-plugin-enabled');
    const sizeEl = container.querySelector('[data-el="size"]');
    enabledEl.checked = !!c.enabled;
    sizeEl.value = String(c.sizeScale);
    enabledEl.addEventListener('change', () => {
      setCaptionsEnabled(enabledEl.checked);
    });
    sizeEl.addEventListener('change', () => {
      c.sizeScale = parseFloat(sizeEl.value) || 1;
      ctx.saveConfigDebounced();
      applyCaptionStyle();
    });
    },
  }],
});

