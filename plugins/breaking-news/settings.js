import { renderHeadlinesList, runBreakingNewsAlert, scheduleNextNewsAlert } from './renderer.js';

window.RCBPlugins.registerPluginSettings('breaking-news', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    // The section is edited through ctx.settings (labelled undo steps), not by
    // assigning to ctx.S.config; cfg is the same live object, kept for reading.
    const cfg = ctx.settings.ensureLegacyConfig('breaking-news');
    const update = (patch) => ctx.settings.updateLegacyConfig('breaking-news', patch);
    container.innerHTML = `
      <label class="panel-toggle"><input type="checkbox" data-el="enabled">BREAKING NEWS ALERTS</label>
      <div class="panel-body">
        <div class="panel-interval">
          RANDOM ALERTS: EVERY <input type="number" data-el="interval" min="1" max="1440" value="30"> MIN
        </div>
        <div class="panel-interval">
          ALERT STYLE
          <select data-el="style">
            <option value="retro-lower-third">RETRO LOWER THIRD (90s NEWSROOM)</option>
            <option value="full-slate">SPECIAL REPORT SLATE (FULL SCREEN)</option>
            <option value="ticker-flash">CABLE NEWS FLASH TICKER</option>
            <option value="alien-report">ALIEN / SCI-FI BULLETIN</option>
          </select>
        </div>
        <div class="panel-interval">
          BANNER POSITION
          <select data-el="position">
            <option value="bottom">BOTTOM</option>
            <option value="top">TOP</option>
            <option value="center">CENTER</option>
          </select>
        </div>
        <div class="panel-interval">
          DISPLAY DURATION <input type="number" data-el="duration" min="5" max="120" value="15"> SEC
        </div>
        <label class="shuffle-toggle"><input type="checkbox" data-el="stinger">SOUND INTRO STINGER</label>
        <label class="shuffle-toggle"><input type="checkbox" data-el="voiceover">VOICEOVER (TEXT-TO-SPEECH)</label>
      </div>
      <span class="panel-status">Press B while watching to trigger a Breaking News Alert on demand. Custom headlines cycle randomly or can be sent live from the party page.</span>
      <div style="margin-top: 12px;">
        <div class="panel-toggle" style="cursor:default">HEADLINE BANK</div>
        <div data-el="headlines-list" class="titles-list"></div>
        <div class="block-row">
          <button type="button" data-el="add-headline" class="btn">+ ADD HEADLINE</button>
          <button type="button" data-el="test" class="btn">&#9654; TEST BREAKING NEWS ALERT NOW</button>
        </div>
      </div>
    `;
    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = q('enabled');
    const intervalEl = q('interval');
    const styleEl = q('style');
    const positionEl = q('position');
    const durationEl = q('duration');
    const stingerEl = q('stinger');
    const voiceoverEl = q('voiceover');

    enabledEl.checked = !!cfg.enabled;
    intervalEl.value = cfg.intervalMinutes || 30;
    styleEl.value = cfg.style || 'retro-lower-third';
    positionEl.value = cfg.position || 'bottom';
    durationEl.value = cfg.durationSec || 15;
    stingerEl.checked = cfg.soundStinger !== false;
    voiceoverEl.checked = cfg.voiceover !== false;
    renderHeadlinesList(container, cfg, ctx.saveConfigDebounced);

    enabledEl.addEventListener('change', () => {
      update({ enabled: enabledEl.checked });
      scheduleNextNewsAlert();
    });
    intervalEl.addEventListener('change', () => {
      const n = parseInt(intervalEl.value, 10);
      update({ intervalMinutes: (Number.isFinite(n) && n > 0) ? n : 30 });
      scheduleNextNewsAlert();
    });
    styleEl.addEventListener('change', () => { update({ style: styleEl.value }); });
    positionEl.addEventListener('change', () => { update({ position: positionEl.value }); });
    durationEl.addEventListener('change', () => {
      const n = parseInt(durationEl.value, 10);
      update({ durationSec: (Number.isFinite(n) && n > 0) ? n : 15 });
    });
    stingerEl.addEventListener('change', () => { update({ soundStinger: stingerEl.checked }); });
    voiceoverEl.addEventListener('change', () => { update({ voiceover: voiceoverEl.checked }); });
    q('add-headline').addEventListener('click', () => {
      update({ headlines: [...(cfg.headlines || []), ''] });
      renderHeadlinesList(container, cfg, ctx.saveConfigDebounced);
    });
    q('test').addEventListener('click', () => runBreakingNewsAlert({ manual: true }));
    },
  }],
});

