import {
  lastStatusText,
  scheduleNextNoaaPoll,
  sdAppliedLevel,
  sdPreview,
  sdPreviewLevel,
  sdStart,
  sdStopPreview,
  setSettingsStatusElement,
  updateRoutineCrawl,
  updateSignalDegradation,
} from './renderer.js';

window.RCBPlugins.registerPluginSettings('noaa-weather', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    const cfg = ctx.S.config.eas;
    container.innerHTML = `
      <label class="panel-toggle">NOAA WEATHER &amp; EAS</label>
      <div class="panel-body">
        <label class="shuffle-toggle"><input type="checkbox" data-el="noaa-enabled">INTERRUPT FOR REAL NOAA/NWS ALERTS</label>
        <div class="panel-interval">
          LAT <input type="text" data-el="noaa-lat" class="title-row-input" placeholder="e.g. 39.0997" style="max-width:8em">
          LON <input type="text" data-el="noaa-lon" class="title-row-input" placeholder="e.g. -94.5786" style="max-width:8em">
        </div>
        <span data-el="noaa-status" class="panel-status"></span>
      </div>
      <span class="panel-status">Real alerts use your actual location (free, keyless api.weather.gov) and are checked every few minutes. See the Emergency Alert System plugin's own settings panel for the on-demand/random test-slate settings, which don't need this plugin.</span>
      <div class="panel-body">
        <label class="shuffle-toggle"><input type="checkbox" data-el="crawl-enabled">ROUTINE WEATHER CRAWL (LOWER-THIRD, ANY ACTIVE ALERT)</label>
      </div>
      <span class="panel-status">A plain scrolling crawl of whatever's currently active for your location, regardless of severity — separate from the full-screen EAS takeover above, which only fires for a genuinely new Severe/Extreme alert.</span>
      <div class="panel-body">
        <label class="shuffle-toggle"><input type="checkbox" data-el="sd-enabled">DEGRADE PICTURE DURING SEVERE WEATHER (SIGNAL FADE)</label>
        <div class="panel-interval">
          MIN. SEVERITY
          <select data-el="sd-severity" class="title-row-input" style="max-width:12em">
            <option value="Minor">MINOR</option>
            <option value="Moderate">MODERATE</option>
            <option value="Severe">SEVERE</option>
            <option value="Extreme">EXTREME</option>
          </select>
        </div>
        <div class="panel-interval">
          INTENSITY
          <input type="range" data-el="sd-intensity" min="0" max="100" step="5" style="max-width:14em">
          <span data-el="sd-intensity-value"></span>
        </div>
        <div class="panel-interval">
          TEST
          <button type="button" class="btn" data-el="sd-test-minor">MINOR</button>
          <button type="button" class="btn" data-el="sd-test-moderate">MODERATE</button>
          <button type="button" class="btn" data-el="sd-test-severe">SEVERE</button>
          <button type="button" class="btn" data-el="sd-test-extreme">EXTREME</button>
          <button type="button" class="btn remove-btn" data-el="sd-test-stop">STOP TEST</button>
        </div>
        <span data-el="sd-status" class="panel-status"></span>
      </div>
      <span class="panel-status">Turns real active NOAA/NWS alerts near your location into on-screen static/tearing (and, at EXTREME, brief signal-lost dropouts) — like real cable/satellite picture quality dropping during a storm. Uses the same lat/lon and poll above; does not interrupt playback like the EAS alert above does. TEST previews each level on live TV right now, independent of the ENABLE toggle and any real alert — click STOP TEST to return to normal.</span>
    `;

    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('noaa-enabled');
    const latEl = q('noaa-lat');
    const lonEl = q('noaa-lon');
    const statusEl = q('noaa-status');
    setSettingsStatusElement(statusEl);
    const sdEnabledEl = q('sd-enabled');
    const sdSeverityEl = q('sd-severity');
    const sdIntensityEl = q('sd-intensity');
    const sdIntensityValueEl = q('sd-intensity-value');
    const sdStatusEl = q('sd-status');
    const sdCfg = cfg.signalDegradation;
    const crawlEnabledEl = q('crawl-enabled');
    if (!cfg.routineCrawl) cfg.routineCrawl = { enabled: false };
    crawlEnabledEl.checked = !!cfg.routineCrawl.enabled;
    crawlEnabledEl.addEventListener('change', () => {
      cfg.routineCrawl.enabled = crawlEnabledEl.checked;
      ctx.saveConfigDebounced();
      updateRoutineCrawl();
    });

    enabledEl.checked = !!cfg.noaaEnabled;
    latEl.value = cfg.lat != null ? cfg.lat : '';
    lonEl.value = cfg.lon != null ? cfg.lon : '';
    statusEl.textContent = lastStatusText;
    sdEnabledEl.checked = !!sdCfg.enabled;
    sdSeverityEl.value = sdCfg.minSeverity;
    sdIntensityEl.value = String(sdCfg.intensity);
    sdIntensityValueEl.textContent = `${sdCfg.intensity}%`;
    function refreshSdStatus() {
      if (sdPreviewLevel != null) sdStatusEl.textContent = `Previewing level ${sdPreviewLevel}/4 — click STOP TEST to return to normal.`;
      else if (sdAppliedLevel > 0) sdStatusEl.textContent = `Signal currently degraded (level ${sdAppliedLevel}/4).`;
      else sdStatusEl.textContent = sdCfg.enabled ? 'No active alert meets the severity threshold right now.' : '';
    }
    refreshSdStatus();

    enabledEl.addEventListener('change', () => {
      cfg.noaaEnabled = enabledEl.checked;
      ctx.saveConfigDebounced();
      scheduleNextNoaaPoll();
    });
    function commitCoord(input, field) {
      const raw = input.value.trim();
      const num = raw === '' ? null : Number(raw);
      cfg[field] = (num == null || Number.isNaN(num)) ? null : num;
      ctx.saveConfigDebounced();
      scheduleNextNoaaPoll();
    }
    latEl.addEventListener('change', () => commitCoord(latEl, 'lat'));
    lonEl.addEventListener('change', () => commitCoord(lonEl, 'lon'));

    sdEnabledEl.addEventListener('change', () => {
      sdCfg.enabled = sdEnabledEl.checked;
      ctx.saveConfigDebounced();
      updateSignalDegradation();
      refreshSdStatus();
    });
    sdSeverityEl.addEventListener('change', () => {
      sdCfg.minSeverity = sdSeverityEl.value;
      ctx.saveConfigDebounced();
      updateSignalDegradation();
      refreshSdStatus();
    });
    sdIntensityEl.addEventListener('input', () => {
      sdCfg.intensity = Number(sdIntensityEl.value);
      sdIntensityValueEl.textContent = `${sdCfg.intensity}%`;
      ctx.saveConfigDebounced();
      // Re-applies the opacity live even if the level itself hasn't
      // changed (updateSignalDegradation() no-ops when level is unchanged,
      // so the intensity slider needs its own direct restart here).
      if (sdPreviewLevel != null) sdPreview(sdPreviewLevel, sdCfg.intensity);
      else if (sdAppliedLevel > 0) sdStart(sdAppliedLevel, sdCfg.intensity);
    });

    // TEST buttons — preview each severity level on live TV right now,
    // independent of the ENABLE toggle/real alerts (sdPreview/sdStopPreview
    // above). Doesn't touch S.noaaLastAlerts or sdCfg, so it can't leave any
    // stray state behind once stopped.
    [['sd-test-minor', 1], ['sd-test-moderate', 2], ['sd-test-severe', 3], ['sd-test-extreme', 4]].forEach(([el, level]) => {
      q(el).addEventListener('click', () => {
        sdPreview(level, sdCfg.intensity);
        refreshSdStatus();
      });
    });
    q('sd-test-stop').addEventListener('click', () => {
      sdStopPreview();
      refreshSdStatus();
    });
    },
  }],
});

