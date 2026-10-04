window.RCBPlugins.registerPluginSettings('local-weather', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.weather) ctx.S.config.weather = {};
    const cfg = ctx.S.config.weather;
    container.innerHTML = `
      <label class="panel-toggle">LOCAL WEATHER (CH 3)</label>
      <div class="panel-body">
        <input type="text" data-el="location" class="title-row-input" placeholder="ANYTOWN, USA" maxlength="40">
        <select data-el="units"><option value="F">°F · MPH</option><option value="C">°C · KM/H</option></select>
        <button type="button" data-el="audio-btn" class="btn">CHOOSE BACKGROUND AUDIO</button>
        <button type="button" data-el="audio-clear-btn" class="btn remove-btn">CLEAR</button>
      </div>
      <span class="panel-status">Generated forecast — free-text location, not geocoded (used as a fallback label and to seed the synthetic forecast). Upgrades automatically to a real forecast, NWS's own resolved city/state name, wind, chance of precipitation, and forecast text once the NOAA Weather &amp; EAS plugin has a lat/lon set.</span>
      <span data-el="audio-status" class="panel-status"></span>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const locationEl = q('location');
    const audioStatusEl = q('audio-status');

    const renderAudioStatus = () => {
      audioStatusEl.textContent = cfg.audio
        ? `Now playing: ${cfg.audio.split(/[\\/]/).pop()}`
        : 'No audio assigned';
    };

    locationEl.value = cfg.location || '';
    q('units').value = cfg.units === 'C' ? 'C' : 'F';
    q('units').addEventListener('change', () => {
      cfg.units = q('units').value;
      ctx.saveConfigDebounced();
    });
    renderAudioStatus();

    locationEl.addEventListener('input', () => {
      cfg.location = locationEl.value;
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

