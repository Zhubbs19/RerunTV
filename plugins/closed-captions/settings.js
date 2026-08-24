import { setCaptionsEnabled } from './renderer.js';

window.RCBPlugins.registerPluginSettings('closed-captions', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.closedCaptions) ctx.S.config.closedCaptions = { enabled: false };
    const c = ctx.S.config.closedCaptions;
    container.innerHTML = `
      <label class="panel-toggle">
        <input type="checkbox" id="cc-plugin-enabled">
        CLOSED CAPTIONS (K TO TOGGLE)
      </label>
      <span class="panel-status">Real captions only — a sidecar .srt/.vtt file next to the video, or a subtitle stream already embedded in the file. Nothing is auto-generated. Caption styling follows the active guide/OSD theme.</span>
    `;
    const enabledEl = container.querySelector('#cc-plugin-enabled');
    enabledEl.checked = !!c.enabled;
    enabledEl.addEventListener('change', () => {
      setCaptionsEnabled(enabledEl.checked);
    });
    },
  }],
});

