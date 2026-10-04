import { applyTickerState } from './renderer.js';

window.RCBPlugins.registerPluginSettings('ticker', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.ticker) ctx.S.config.ticker = { enabled: false, text: '', speed: 30 };
    const cfg = ctx.S.config.ticker;
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled">TEXT TICKER</label>
      <div class="panel-body">
        <textarea class="pubaccess-slide-input" rows="2" placeholder="Scrolling ticker text…" data-el="text"></textarea>
        <div class="panel-interval">
          SPEED <input type="number" min="5" max="120" data-el="speed"> SEC/LOOP (LOWER = FASTER)
        </div>
        <div class="panel-interval">
          POSITION <select data-el="position"><option value="bottom">BOTTOM</option><option value="top">TOP</option></select>
          SIZE <select data-el="size"><option value="0.8">SMALL</option><option value="1">NORMAL</option><option value="1.3">LARGE</option><option value="1.7">X-LARGE</option></select>
          <label><input type="checkbox" data-el="hide-breaks"> HIDE DURING AD BREAKS</label>
        </div>
        <div class="panel-interval">
          TEXT <input type="color" data-el="color" value="#d4af37">
          BAR <input type="color" data-el="bgcolor" value="#060a20">
          <input type="range" min="0" max="100" step="5" data-el="bgopacity" style="max-width:10em"> <span data-el="bgvalue"></span>
          <button class="btn" type="button" data-el="reset">THEME COLORS</button>
        </div>
      </div>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('enabled');
    const textEl = q('text');
    const speedEl = q('speed');
    enabledEl.checked = !!cfg.enabled;
    textEl.value = cfg.text || '';
    speedEl.value = cfg.speed || 30;
    const applyAll = () => { applyTickerState(); ctx.saveConfigDebounced(); };
    q('position').value = cfg.position === 'top' ? 'top' : 'bottom';
    q('size').value = String(cfg.sizeScale || 1);
    q('hide-breaks').checked = !!cfg.hideInBreaks;
    q('color').value = /^#[0-9a-f]{6}$/i.test(cfg.color || '') ? cfg.color : '#d4af37';
    q('bgcolor').value = /^#[0-9a-f]{6}$/i.test(cfg.bgColor || '') ? cfg.bgColor : '#060a20';
    q('bgopacity').value = Number.isFinite(cfg.bgOpacity) ? cfg.bgOpacity : 82;
    const showBg = () => { q('bgvalue').textContent = Number.isFinite(cfg.bgOpacity) ? `${cfg.bgOpacity}%` : 'THEME'; };
    showBg();
    q('position').addEventListener('change', () => { cfg.position = q('position').value; applyAll(); });
    q('size').addEventListener('change', () => { cfg.sizeScale = parseFloat(q('size').value) || 1; applyAll(); });
    q('hide-breaks').addEventListener('change', () => { cfg.hideInBreaks = q('hide-breaks').checked; applyAll(); });
    q('color').addEventListener('input', () => { cfg.color = q('color').value; applyAll(); });
    q('bgcolor').addEventListener('input', () => { cfg.bgColor = q('bgcolor').value; applyAll(); });
    q('bgopacity').addEventListener('input', () => { cfg.bgOpacity = parseInt(q('bgopacity').value, 10); showBg(); applyAll(); });
    q('reset').addEventListener('click', () => { delete cfg.color; delete cfg.bgColor; delete cfg.bgOpacity; showBg(); applyAll(); });
    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      applyTickerState();
      ctx.saveConfigDebounced();
    });
    textEl.addEventListener('input', () => {
      cfg.text = textEl.value;
      applyTickerState();
      ctx.saveConfigDebounced();
    });
    speedEl.addEventListener('change', () => {
      cfg.speed = parseInt(speedEl.value, 10) || 30;
      applyTickerState();
      ctx.saveConfigDebounced();
    });
    },
  }],
});

