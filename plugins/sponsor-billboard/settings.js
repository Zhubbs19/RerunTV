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
        <span class="panel-status">Set a sponsor name and/or logo image/video for a channel to show a "THIS PROGRAM BROUGHT TO YOU BY..." card once at the start of every airing on that channel. Both blank = no card for that channel.</span>
      `;
      const listEl = container.querySelector('#sponsor-billboard-list');

      // A pre-media sponsor entry was a plain string (the name) —
      // normalized to { name, mediaPath } here so editing an old config
      // doesn't lose its name.
      function loadSponsors() {
        const raw = ctx.getPluginSettings('sponsor-billboard').sponsorsByChannel || {};
        const byChannel = {};
        Object.keys(raw).forEach((num) => {
          const v = raw[num];
          byChannel[num] = typeof v === 'string' ? { name: v, mediaPath: '' } : { name: v.name || '', mediaPath: v.mediaPath || '' };
        });
        return byChannel;
      }

      function commit(sponsorsByChannel) {
        ctx.updatePluginSettings('sponsor-billboard', { sponsorsByChannel: { ...sponsorsByChannel } });
      }

      function renderList() {
        const sponsorsByChannel = loadSponsors();
        listEl.innerHTML = '';
        ctx.sortedChannels().forEach((ch) => {
          const key = String(ch.number);
          if (!sponsorsByChannel[key]) sponsorsByChannel[key] = { name: '', mediaPath: '' };
          const entry = sponsorsByChannel[key];

          const row = document.createElement('div');
          row.className = 'panel-interval';
          const label = document.createElement('span');
          label.textContent = `CH ${ch.number} — ${ch.name || 'UNNAMED'}`;
          label.style.marginRight = '8px';

          const nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.className = 'title-row-input';
          nameInput.placeholder = 'SPONSOR NAME (BLANK = NONE)';
          nameInput.value = entry.name;
          nameInput.addEventListener('change', () => {
            entry.name = nameInput.value.trim();
            commit(sponsorsByChannel);
          });

          const imgBtn = document.createElement('button');
          imgBtn.type = 'button';
          imgBtn.className = 'btn';
          imgBtn.textContent = 'IMAGE…';
          imgBtn.addEventListener('click', async () => {
            const path = await window.api.selectImage();
            if (!path) return;
            entry.mediaPath = path;
            commit(sponsorsByChannel);
            renderList();
          });

          const vidBtn = document.createElement('button');
          vidBtn.type = 'button';
          vidBtn.className = 'btn';
          vidBtn.textContent = 'VIDEO…';
          vidBtn.addEventListener('click', async () => {
            const path = await window.api.selectVideo();
            if (!path) return;
            entry.mediaPath = path;
            commit(sponsorsByChannel);
            renderList();
          });

          const mediaName = document.createElement('span');
          mediaName.className = 'sponsor-billboard-media-name';
          mediaName.textContent = entry.mediaPath ? entry.mediaPath.split(/[\\/]/).pop() : '(no logo chosen)';

          const clearBtn = document.createElement('button');
          clearBtn.type = 'button';
          clearBtn.className = 'btn remove-btn';
          clearBtn.textContent = 'X';
          clearBtn.title = 'REMOVE LOGO';
          clearBtn.addEventListener('click', () => {
            entry.mediaPath = '';
            commit(sponsorsByChannel);
            renderList();
          });

          row.append(label, nameInput, imgBtn, vidBtn, mediaName, clearBtn);
          listEl.appendChild(row);
        });
      }

      renderList();
    },
  }],
});
