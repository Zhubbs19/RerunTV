// Per-channel sponsor list — stored via the generic plugin-settings system
// (getPluginSettings/updatePluginSettings, exposed on ctx) rather than a
// core config key, since this plugin owns nothing core needs to know about.
window.RCBPlugins.registerPluginSettings('sponsor-billboard', {
  sections: [{
    id: 'general',
    render(container, ctx) {
      container.innerHTML = `
        <label class="panel-toggle">SPONSOR BILLBOARD</label>
        <div class="panel-body">
          <div id="sponsor-billboard-list"></div>
        </div>
        <span class="panel-status">Set a sponsor name for a channel to show a "THIS PROGRAM BROUGHT TO YOU BY..." card once at the start of every airing on that channel. Blank = no card for that channel.</span>
      `;
      const listEl = container.querySelector('#sponsor-billboard-list');
      const settings = ctx.getPluginSettings('sponsor-billboard');
      const sponsorsByChannel = { ...(settings.sponsorsByChannel || {}) };

      ctx.sortedChannels().forEach((ch) => {
        const row = document.createElement('div');
        row.className = 'panel-interval';
        const label = document.createElement('span');
        label.textContent = `CH ${ch.number} — ${ch.name || 'UNNAMED'}`;
        label.style.marginRight = '8px';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'title-row-input';
        input.placeholder = 'SPONSOR NAME (BLANK = NONE)';
        input.value = sponsorsByChannel[String(ch.number)] || '';
        input.addEventListener('change', () => {
          if (input.value.trim()) sponsorsByChannel[String(ch.number)] = input.value.trim();
          else delete sponsorsByChannel[String(ch.number)];
          ctx.updatePluginSettings('sponsor-billboard', { sponsorsByChannel: { ...sponsorsByChannel } });
        });
        row.append(label, input);
        listEl.appendChild(row);
      });
    },
  }],
});
