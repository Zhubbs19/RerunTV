// Pay-per-view (CH 98) options: your own events and prices in place of the
// parody lineup, how often the featured event changes, and how long an
// order unscrambles the picture.
window.RCBPlugins.registerPluginSettings('pay-per-view', {
  sections: [{
    id: 'general',
    render(container, ctx) {
      const settings = ctx.settings;
      const get = () => settings.getPluginSettings('pay-per-view') || {};
      const save = (patch) => settings.updatePluginSettings('pay-per-view', patch);
      container.innerHTML = `
        <label class="panel-toggle">PAY-PER-VIEW (CH 98)</label>
        <div class="panel-interval">
          NEW EVENT EVERY <input type="number" min="1" max="240" data-el="rotate" style="width:4em"> MIN
          UNSCRAMBLED FOR <input type="number" min="5" max="600" data-el="seconds" style="width:4em"> SEC AFTER AN ORDER
        </div>
        <div class="panel-body" data-el="list"></div>
        <button type="button" class="btn" data-el="add">ADD EVENT</button>
        <button type="button" class="btn remove-btn" data-el="reset">USE THE PARODY LINEUP</button>
        <span class="panel-status">Events you add replace the built-in parody ones; with none listed the parody lineup airs. The channel is a joke order flow — nothing is ever charged.</span>
      `;
      const q = (el) => container.querySelector(`[data-el="${el}"]`);
      q('rotate').value = Number.isFinite(get().rotateMinutes) ? get().rotateMinutes : 15;
      q('seconds').value = Number.isFinite(get().unscrambleSeconds) ? get().unscrambleSeconds : 30;
      q('rotate').addEventListener('change', () => {
        const n = Math.round(Math.min(240, Math.max(1, parseFloat(q('rotate').value) || 15)));
        q('rotate').value = n;
        save({ rotateMinutes: n });
      });
      q('seconds').addEventListener('change', () => {
        const n = Math.round(Math.min(600, Math.max(5, parseFloat(q('seconds').value) || 30)));
        q('seconds').value = n;
        save({ unscrambleSeconds: n });
      });
      const renderList = () => {
        const events = (get().events || []).map((e) => ({ title: e.title || '', price: e.price || '' }));
        const list = q('list');
        list.innerHTML = '';
        events.forEach((event, i) => {
          const row = document.createElement('div');
          row.className = 'panel-interval';
          const title = document.createElement('input');
          title.type = 'text';
          title.className = 'title-row-input';
          title.placeholder = 'EVENT #501: YOUR EVENT HERE';
          title.value = event.title;
          const price = document.createElement('input');
          price.type = 'text';
          price.placeholder = '$29.95';
          price.style.width = '6em';
          price.value = event.price;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'btn remove-btn';
          remove.textContent = '✕';
          const commit = () => { events[i] = { title: title.value.trim(), price: price.value.trim() }; save({ events: events.filter((e) => e.title) }); };
          title.addEventListener('change', commit);
          price.addEventListener('change', commit);
          remove.addEventListener('click', () => { events.splice(i, 1); save({ events }); renderList(); });
          row.append(title, price, remove);
          list.appendChild(row);
        });
      };
      q('add').addEventListener('click', () => { save({ events: [...(get().events || []), { title: 'EVENT: NEW EVENT', price: '$29.95' }] }); renderList(); });
      q('reset').addEventListener('click', () => { save({ events: [] }); renderList(); });
      renderList();
    },
  }],
});
