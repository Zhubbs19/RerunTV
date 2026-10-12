// Global enable + interval + per-channel override list — same per-channel-map
// shape as sponsor-billboard/settings.js. The section's own `ctx.settings` is
// a one-time snapshot (taken when the panel was expanded — see
// setup-plugin-settings.js's makeContext), not a live reference, so this
// reads/writes through window.RCBPlugins.ctx.settings.getPluginSettings/
// updatePluginSettings instead, same as sponsor-billboard/digital-music-channel.
window.RCBPlugins.registerPluginSettings('film-reel-marks', {
  sections: [{
    id: 'general',
    render(container, ctx) {
      const settings = window.RCBPlugins.ctx.settings.getPluginSettings('film-reel-marks');
      container.innerHTML = `
        <label class="panel-toggle"><input type="checkbox" data-el="enabled">FILM REEL-CHANGE CUE MARKS</label>
        <div class="panel-body">
          <div class="panel-interval">
            EVERY <input type="number" data-el="interval" min="1" style="max-width:5em"> MIN (MOVIES ONLY)
            DOT STAYS <input type="number" data-el="dot-seconds" min="0.3" max="10" step="0.1" style="max-width:5em"> SEC
            CORNER <select data-el="corner"><option value="right">TOP RIGHT</option><option value="left">TOP LEFT</option></select>
          </div>
          <div id="film-reel-marks-channel-list"></div>
        </div>
        <span class="panel-status">A small dot flashes briefly in the corner every N minutes during any file tagged CONTENT TYPE: MOVIE, marking where a projectionist would have swapped reels. A channel below can override the global on/off.</span>
      `;
      const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
      const enabledEl = q('enabled');
      const intervalEl = q('interval');
      enabledEl.checked = settings.enabled !== false;
      intervalEl.value = settings.intervalMin || 20;
      q('dot-seconds').value = Number.isFinite(settings.dotSeconds) ? settings.dotSeconds : 1.2;
      q('corner').value = settings.corner === 'left' ? 'left' : 'right';
      q('dot-seconds').addEventListener('change', () => {
        const n = Math.min(10, Math.max(0.3, parseFloat(q('dot-seconds').value) || 1.2));
        q('dot-seconds').value = n;
        window.RCBPlugins.ctx.settings.updatePluginSettings('film-reel-marks', { dotSeconds: n });
      });
      q('corner').addEventListener('change', () => {
        window.RCBPlugins.ctx.settings.updatePluginSettings('film-reel-marks', { corner: q('corner').value });
      });

      enabledEl.addEventListener('change', () => {
        window.RCBPlugins.ctx.settings.updatePluginSettings('film-reel-marks', { enabled: enabledEl.checked });
      });
      intervalEl.addEventListener('change', () => {
        window.RCBPlugins.ctx.settings.updatePluginSettings('film-reel-marks', { intervalMin: Math.max(1, parseInt(intervalEl.value, 10) || 20) });
      });

      const listEl = container.querySelector('#film-reel-marks-channel-list');
      const channelOverrides = { ...(settings.channelOverrides || {}) };
      window.RCBPlugins.ctx.channels.sortedChannels().forEach((ch) => {
        const row = document.createElement('div');
        row.className = 'panel-interval';
        const label = document.createElement('span');
        label.textContent = `CH ${ch.number} — ${ch.name || 'UNNAMED'}`;
        label.style.marginRight = '8px';
        const select = document.createElement('select');
        [['', 'INHERIT GLOBAL'], ['on', 'ON'], ['off', 'OFF']].forEach(([value, text]) => {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = text;
          select.appendChild(opt);
        });
        const current = channelOverrides[String(ch.number)];
        select.value = current == null ? '' : (current ? 'on' : 'off');
        select.addEventListener('change', () => {
          if (select.value === '') delete channelOverrides[String(ch.number)];
          else channelOverrides[String(ch.number)] = select.value === 'on';
          window.RCBPlugins.ctx.settings.updatePluginSettings('film-reel-marks', { channelOverrides: { ...channelOverrides } });
        });
        row.append(label, select);
        listEl.appendChild(row);
      });
    },
  }],
});
