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
      <div class="panel-interval">
        LANGUAGE
        <input type="text" data-el="lang" maxlength="3" style="width:4em" placeholder="eng">
        <span class="panel-status">ISO code of the embedded subtitle stream to prefer (eng, spa, fre, ger, jpn…); "any" takes the first. A .srt/.vtt file next to the video always wins.</span>
      </div>
      <div class="panel-interval">
        POSITION
        <select data-el="position"><option value="bottom">BOTTOM</option><option value="top">TOP</option></select>
        TEXT COLOR
        <input type="color" data-el="color" value="#ffffff">
        <button class="btn" data-el="color-reset" type="button">THEME</button>
      </div>
      <div class="panel-interval">
        FONT
        <select data-el="font"><option value="">THEME</option><option value="sans">SANS</option><option value="serif">SERIF</option><option value="mono">MONO</option></select>
        EDGE
        <select data-el="edge"><option value="">THEME</option><option value="none">NONE</option><option value="shadow">SHADOW</option><option value="outline">OUTLINE</option></select>
        <label><input type="checkbox" data-el="caps"> ALL CAPS</label>
      </div>
      <div class="panel-interval">
        BACKGROUND
        <input type="range" data-el="bg" min="0" max="100" step="5" style="max-width:12em">
        <span data-el="bg-value"></span>
        <button class="btn" data-el="bg-reset" type="button">THEME</button>
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
    const q = (el) => container.querySelector(`[data-el="${el}"]`);
    const commit = () => { ctx.saveConfigDebounced(); applyCaptionStyle(); };
    q('lang').value = c.language || 'eng';
    q('position').value = c.position === 'top' ? 'top' : 'bottom';
    q('color').value = /^#[0-9a-f]{6}$/i.test(c.color || '') ? c.color : '#ffffff';
    q('font').value = c.font || '';
    q('edge').value = c.edge || '';
    q('caps').checked = !!c.allCaps;
    const showBg = () => { q('bg-value').textContent = Number.isFinite(c.bgOpacity) ? `${c.bgOpacity}%` : 'THEME'; };
    q('bg').value = Number.isFinite(c.bgOpacity) ? c.bgOpacity : 75;
    showBg();
    q('lang').addEventListener('change', () => { c.language = q('lang').value.trim().toLowerCase() || 'eng'; commit(); });
    q('position').addEventListener('change', () => { c.position = q('position').value; commit(); });
    q('color').addEventListener('input', () => { c.color = q('color').value; commit(); });
    q('color-reset').addEventListener('click', () => { delete c.color; q('color').value = '#ffffff'; commit(); });
    q('font').addEventListener('change', () => { if (q('font').value) c.font = q('font').value; else delete c.font; commit(); });
    q('edge').addEventListener('change', () => { if (q('edge').value) c.edge = q('edge').value; else delete c.edge; commit(); });
    q('caps').addEventListener('change', () => { c.allCaps = q('caps').checked; commit(); });
    q('bg').addEventListener('input', () => { c.bgOpacity = parseInt(q('bg').value, 10); showBg(); commit(); });
    q('bg-reset').addEventListener('click', () => { delete c.bgOpacity; showBg(); commit(); });
    sizeEl.addEventListener('change', () => {
      c.sizeScale = parseFloat(sizeEl.value) || 1;
      ctx.saveConfigDebounced();
      applyCaptionStyle();
    });
    },
  }],
});

