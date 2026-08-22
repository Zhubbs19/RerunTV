// NOAA Weather & EAS plugin — settings panel (interrupt-for-real-alerts
// toggle + lat/lon + status readout) AND the real-alert poll loop itself
// (moved in from core eas.js — this plugin is the only thing that needs
// it). A genuine Severe/Extreme alert triggers the breaking-news plugin's
// interrupt slate via getInterrupt('breaking-news').run({real}) — plugin-to-
// plugin, not through core, since it's a real-alert override specific to
// this pairing (see [[retro_cable_box_plugin_system]]); anything milder
// just updates this panel's own status line.
//
// Shares config.eas with core (renderer/js/eas.js is gone now, but the
// namespace name stuck since eas-alerts' random-test settings live in
// config.eas too) rather than having its own config namespace — same
// "plugin config inside a core-shared namespace" pattern documented before.
// This plugin's own runtime state on the shared S object — used to be
// declared in core state.js even though core never reads either field.
if (S.noaaPollTimer === undefined) S.noaaPollTimer = null;
if (S.noaaSeenAlertIds === undefined) S.noaaSeenAlertIds = null;
if (S.noaaLastAlerts === undefined) S.noaaLastAlerts = [];

// Signal degradation's own config, seeded here — see
// [[retro_cable_box_plugin_system]] for the "plugin config inside a
// core-shared namespace" pattern this and noaaEnabled/lat/lon above both
// follow (config.eas, not a dedicated namespace, since it rides the same
// alert poll this plugin already runs).
if (!S.config.eas.signalDegradation) {
  S.config.eas.signalDegradation = { enabled: false, minSeverity: 'Severe', intensity: 100 };
}

let statusEl = null;
let lastStatusText = '';

function setStatusText(text) {
  lastStatusText = text;
  if (statusEl) statusEl.textContent = text;
}

const NOAA_POLL_INTERVAL_MS = 5 * 60 * 1000;
const NOAA_INTERRUPT_SEVERITIES = new Set(['Severe', 'Extreme']);

// ---------- Signal degradation ----------
// Turns the real active-alert severity this plugin already polls into a
// persistent "rain fade" cable-signal quality drop on top of whatever's
// tuned — a full-screen overlay appended into .crt once here, same pattern
// as breaking-news'/ticker's/eas-alerts' own persistent overlays.
const SD_SEVERITY_RANK = { Minor: 1, Moderate: 2, Severe: 3, Extreme: 4 };
const SD_BASE_OPACITY = { 1: 0.10, 2: 0.20, 3: 0.38, 4: 0.60 };
const SD_CANVAS_W = 160;
const SD_CANVAS_H = 90;
const SD_DRAW_INTERVAL_MS = 130;

const sdRoot = document.createElement('div');
sdRoot.className = 'signal-degrade-overlay hidden';
sdRoot.innerHTML = `
  <canvas class="signal-degrade-canvas" width="${SD_CANVAS_W}" height="${SD_CANVAS_H}"></canvas>
  <div class="signal-degrade-caption hidden">SIGNAL LOST — SEVERE WEATHER IN AREA</div>
`;
document.querySelector('.crt').appendChild(sdRoot);
const sdCanvas = sdRoot.querySelector('canvas');
const sdCaptionEl = sdRoot.querySelector('.signal-degrade-caption');
const sdCtx = sdCanvas.getContext('2d');

let sdDrawTimer = null;
let sdDropoutTimer = null;
let sdAppliedLevel = 0;

function sdDrawNoise(level) {
  const w = sdCanvas.width, h = sdCanvas.height;
  const imgData = sdCtx.createImageData(w, h);
  const buf = imgData.data;
  for (let i = 0; i < buf.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    buf[i] = v; buf[i + 1] = v; buf[i + 2] = v; buf[i + 3] = 255;
  }
  sdCtx.putImageData(imgData, 0, 0);
  // A couple of short torn/shifted bands at the higher severities — the
  // "signal can barely hold on" look, same technique showStaticBurst
  // (playback.js) uses for its own 'tear' theme style.
  if (level >= 3) {
    const bands = level >= 4 ? 3 : 1;
    for (let b = 0; b < bands; b++) {
      const bandY = Math.floor(Math.random() * h);
      const bandH = 1 + Math.floor(Math.random() * 3);
      const xShift = ((Math.random() * 10) - 5) | 0;
      sdCtx.drawImage(sdCanvas, 0, bandY, w, bandH, xShift, bandY, w, bandH);
    }
  }
}

function sdScheduleDropout() {
  clearTimeout(sdDropoutTimer);
  const delay = 18000 + Math.random() * 14000;
  sdDropoutTimer = setTimeout(() => {
    if (sdAppliedLevel < 4) return; // degradation cleared/downgraded while this was waiting
    sdRoot.classList.add('signal-lost');
    sdCaptionEl.classList.remove('hidden');
    if (window.playNoiseBurst) window.playNoiseBurst({ duration: 260, gain: 0.07, filterFreq: 1800 });
    setTimeout(() => {
      sdRoot.classList.remove('signal-lost');
      sdCaptionEl.classList.add('hidden');
      sdScheduleDropout();
    }, 1300);
  }, delay);
}

function sdStop() {
  clearInterval(sdDrawTimer); sdDrawTimer = null;
  clearTimeout(sdDropoutTimer); sdDropoutTimer = null;
  sdRoot.className = 'signal-degrade-overlay hidden';
  sdCaptionEl.classList.add('hidden');
}

function sdStart(level, intensityPct) {
  clearInterval(sdDrawTimer);
  clearTimeout(sdDropoutTimer);
  sdRoot.className = `signal-degrade-overlay level-${level}`;
  const scale = Math.max(0, Math.min(1, (intensityPct != null ? intensityPct : 100) / 100));
  sdCanvas.style.setProperty('--sd-opacity', String((SD_BASE_OPACITY[level] || 0) * scale));
  sdDrawNoise(level);
  sdDrawTimer = setInterval(() => sdDrawNoise(level), SD_DRAW_INTERVAL_MS);
  if (level >= 4) sdScheduleDropout();
}

// Non-null while the settings panel's TEST buttons (below) are previewing a
// level manually — updateSignalDegradation() defers to it instead of
// computing from real alerts, so a real poll landing mid-preview can't yank
// the effect out from under a user who's just trying to see what EXTREME
// looks like. Cleared by the panel's own STOP TEST button.
let sdPreviewLevel = null;

// Recomputes the degradation level from the most recently polled alerts
// (S.noaaLastAlerts) + the current settings, and (re)applies it — called
// after every poll and whenever a signal-degradation setting changes, so a
// settings edit takes effect immediately rather than waiting for the next
// 5-minute poll.
function updateSignalDegradation() {
  if (sdPreviewLevel != null) return;
  const cfg = S.config.eas.signalDegradation;
  let level = 0;
  if (cfg && cfg.enabled) {
    const minRank = SD_SEVERITY_RANK[cfg.minSeverity] || SD_SEVERITY_RANK.Severe;
    (S.noaaLastAlerts || []).forEach((a) => {
      const rank = SD_SEVERITY_RANK[a.severity] || 0;
      if (rank >= minRank && rank > level) level = rank;
    });
  }
  if (level === sdAppliedLevel) return;
  sdAppliedLevel = level;
  if (level > 0) sdStart(level, cfg.intensity);
  else sdStop();
}

// Settings-panel TEST controls (below) call these directly — lets a user
// preview each severity level (including EXTREME's dropout) on demand
// instead of waiting for a real storm, the same "see it before it happens
// for real" role the EAS plugin's own on-demand test-slate button plays.
function sdPreview(level, intensityPct) {
  sdPreviewLevel = level;
  sdAppliedLevel = level;
  sdStart(level, intensityPct);
}
function sdStopPreview() {
  sdPreviewLevel = null;
  sdAppliedLevel = -1; // sentinel so updateSignalDegradation() can't no-op against a stale match
  updateSignalDegradation();
}

async function pollNoaaAlerts() {
  const S = window.RCBPlugins.ctx.S;
  clearTimeout(S.noaaPollTimer);
  const cfg = S.config.eas;
  if (!cfg || !cfg.noaaEnabled || cfg.lat == null || cfg.lon == null) {
    S.noaaLastAlerts = [];
    updateSignalDegradation();
    return;
  }

  try {
    const { alerts, error } = await window.api.noaaGetActiveAlerts({ lat: cfg.lat, lon: cfg.lon });
    setStatusText(error
      ? `NOAA lookup failed: ${error}`
      : (alerts.length ? `${alerts.length} active alert${alerts.length === 1 ? '' : 's'} for this location.` : 'No active alerts for this location.'));

    if (!error) {
      S.noaaLastAlerts = alerts;
      updateSignalDegradation();
    }

    if (!S.noaaSeenAlertIds) S.noaaSeenAlertIds = new Set();
    const stillActiveIds = new Set(alerts.map((a) => a.id));
    // Drop ids for alerts that have since expired/cleared so the same event
    // id could interrupt again if NOAA ever re-issues it later.
    S.noaaSeenAlertIds.forEach((id) => { if (!stillActiveIds.has(id)) S.noaaSeenAlertIds.delete(id); });

    const fresh = alerts.find((a) => NOAA_INTERRUPT_SEVERITIES.has(a.severity) && !S.noaaSeenAlertIds.has(a.id));
    if (fresh) {
      S.noaaSeenAlertIds.add(fresh.id);
      window.RCBPlugins.getInterrupt('breaking-news')?.run({ real: fresh });
    }
  } catch (err) {
    setStatusText(`NOAA lookup failed: ${err.message}`);
  } finally {
    S.noaaPollTimer = setTimeout(pollNoaaAlerts, NOAA_POLL_INTERVAL_MS);
  }
}

// Called here at plugin load (once per session — S.config is already set by
// the time plugins load, see app.js's init()) and again whenever the
// enabled/lat/lon settings change below. Cheap no-op if nothing's actually
// configured, otherwise (re)starts the poll loop from now.
function scheduleNextNoaaPoll() {
  const S = window.RCBPlugins.ctx.S;
  clearTimeout(S.noaaPollTimer);
  const cfg = S.config.eas;
  if (!cfg || !cfg.noaaEnabled || cfg.lat == null || cfg.lon == null) {
    setStatusText('');
    return;
  }
  pollNoaaAlerts();
}
scheduleNextNoaaPoll();

window.RCBPlugins.registerSettingsPanel('noaa-weather', {
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
    statusEl = q('noaa-status');
    const sdEnabledEl = q('sd-enabled');
    const sdSeverityEl = q('sd-severity');
    const sdIntensityEl = q('sd-intensity');
    const sdIntensityValueEl = q('sd-intensity-value');
    const sdStatusEl = q('sd-status');
    const sdCfg = cfg.signalDegradation;

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
});
