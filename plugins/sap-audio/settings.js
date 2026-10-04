window.RCBPlugins.registerPluginSettings('sap-audio', {
  sections: [{
    id: 'general',
    render(container, ctx) {
      if (!ctx.S.config.sapAudio) ctx.S.config.sapAudio = { defaultTrack: 1 };
      const cfg = ctx.S.config.sapAudio;
      container.innerHTML = `
        <label class="panel-toggle">SAP / ALTERNATE AUDIO (U TO SWITCH)</label>
        <div class="panel-interval">
          START ON AUDIO TRACK
          <select data-el="track">
            <option value="1">1 (THE FILE'S DEFAULT)</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
          </select>
        </div>
        <span class="panel-status">Files with more than one audio track start on this one. The tracks carry no language label this app can read, so it is a number: set it to 2 if your second track is the one you want. A file with fewer tracks plays on its first.</span>
      `;
      const select = container.querySelector('[data-el="track"]');
      select.value = String(cfg.defaultTrack || 1);
      select.addEventListener('change', () => {
        cfg.defaultTrack = parseInt(select.value, 10) || 1;
        ctx.saveConfigDebounced();
      });
    },
  }],
});
