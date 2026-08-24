import { renderHeadlinesList, runBreakingNewsAlert, scheduleNextNewsAlert } from './renderer.js';

window.RCBPlugins.registerPluginSettings('breaking-news', {
  sections: [{
    id: 'general',
  render(container, ctx) {
    if (!ctx.S.config.breakingNews) ctx.S.config.breakingNews = {};
    const cfg = ctx.S.config.breakingNews;
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
      cfg.enabled = enabledEl.checked;
      scheduleNextNewsAlert();
      ctx.saveConfigDebounced();
    });
    intervalEl.addEventListener('change', () => {
      const n = parseInt(intervalEl.value, 10);
      cfg.intervalMinutes = (Number.isFinite(n) && n > 0) ? n : 30;
      scheduleNextNewsAlert();
      ctx.saveConfigDebounced();
    });
    styleEl.addEventListener('change', () => { cfg.style = styleEl.value; ctx.saveConfigDebounced(); });
    positionEl.addEventListener('change', () => { cfg.position = positionEl.value; ctx.saveConfigDebounced(); });
    durationEl.addEventListener('change', () => {
      const n = parseInt(durationEl.value, 10);
      cfg.durationSec = (Number.isFinite(n) && n > 0) ? n : 15;
      ctx.saveConfigDebounced();
    });
    stingerEl.addEventListener('change', () => { cfg.soundStinger = stingerEl.checked; ctx.saveConfigDebounced(); });
    voiceoverEl.addEventListener('change', () => { cfg.voiceover = voiceoverEl.checked; ctx.saveConfigDebounced(); });
    q('add-headline').addEventListener('click', () => {
      if (!cfg.headlines) cfg.headlines = [];
      cfg.headlines.push('');
      renderHeadlinesList(container, cfg, ctx.saveConfigDebounced);
      ctx.saveConfigDebounced();
    });
    q('test').addEventListener('click', () => runBreakingNewsAlert({ manual: true }));
    },
  }],
});

