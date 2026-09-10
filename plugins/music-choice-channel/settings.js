import { GENRE_THEMES, probeAllDurations } from './renderer.js';

function newId() {
  return (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `mc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function newStation() {
  return {
    id: newId(),
    name: 'NEW STATION',
    themeId: GENRE_THEMES[0].id,
    folderPath: null,
    tracks: [],
    background: { mode: 'gradient', imageFolderPath: null, images: [], videoPath: null },
    anchorMs: null,
  };
}

function totalDuration(station) {
  const secs = (station.tracks || []).reduce((sum, t) => sum + (t.durationSec || 0), 0);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h}H ${m}M` : `${m}M`;
}

window.RCBPlugins.registerPluginSettings('music-choice-channel', {
  schemaVersion: 1,
  defaults: { stations: [], selectedStationId: null },
  validate(settings) {
    return Array.isArray(settings.stations) ? true : 'stations must be an array';
  },
  sections: [{
    id: 'stations',
    label: 'MUSIC CHOICE CHANNEL (CH 910)',
    layout: 'wide',
    render(container, ctx) {
      container.innerHTML = `
        <div class="panel-status">A retro digital-cable-style music channel (CH 910). Each "station" is a music folder plus a genre color theme — flip between them live with &uarr;/&darr; or OK while tuned to the channel.</div>
        <div data-el="list"></div>
        <button type="button" data-el="add-station" class="btn btn-primary">+ ADD STATION</button>
      `;
      const listEl = container.querySelector('[data-el="list"]');
      const addBtn = container.querySelector('[data-el="add-station"]');

      function stations() {
        return ctx.getPluginSettings('music-choice-channel').stations || [];
      }
      function commit(nextStations, extra) {
        ctx.updatePluginSettings('music-choice-channel', { stations: nextStations, ...(extra || {}) });
      }
      function updateStationAt(idx, patch) {
        const next = stations().map((s, i) => (i === idx ? { ...s, ...patch } : s));
        commit(next);
      }

      addBtn.addEventListener('click', () => {
        const st = newStation();
        const current = ctx.getPluginSettings('music-choice-channel');
        commit([...(current.stations || []), st], { selectedStationId: current.selectedStationId || st.id });
        renderList();
      });

      function renderList() {
        const list = stations();
        listEl.innerHTML = '';
        list.forEach((station, idx) => {
          const theme = GENRE_THEMES.find((t) => t.id === station.themeId) || GENRE_THEMES[0];
          const bgMode = (station.background && station.background.mode) || 'gradient';
          const card = document.createElement('div');
          card.className = 'mc-settings-card';
          card.innerHTML = `
            <div class="mc-settings-card-head">
              <span class="mc-settings-swatch" style="background:${theme.accent}"></span>
              <input type="text" class="title-row-input" data-el="name" maxlength="40" value="${(station.name || '').replace(/"/g, '&quot;')}">
              <select class="block-hour-select" data-el="theme"></select>
              <button type="button" class="btn remove-btn" data-el="remove">REMOVE</button>
            </div>
            <div class="panel-interval">
              FOLDER
              <input type="text" class="title-row-input" data-el="folder" value="${station.folderPath || ''}" placeholder="No folder chosen" readonly>
              <button type="button" class="btn" data-el="browse-folder">BROWSE…</button>
              <button type="button" class="btn" data-el="rescan" ${station.folderPath ? '' : 'disabled'}>RESCAN + PROBE</button>
            </div>
            <div class="panel-status" data-el="track-summary">${(station.tracks || []).length} TRACKS &middot; ${totalDuration(station)}</div>
            <div class="panel-status hidden" data-el="scan-progress"></div>
            <div class="field-grid">
              <div class="field">
                <span class="field-label">BACKGROUND</span>
                <select class="block-hour-select" data-el="bg-mode">
                  <option value="gradient">GENRE GRADIENT (DEFAULT)</option>
                  <option value="slideshow">IMAGE SLIDESHOW</option>
                  <option value="video">LOOPING VIDEO</option>
                </select>
              </div>
              <div class="field hidden" data-el="bg-slideshow-field">
                <span class="field-label">IMAGE FOLDER</span>
                <div class="block-row">
                  <input type="text" class="title-row-input" data-el="bg-image-folder" value="${(station.background && station.background.imageFolderPath) || ''}" placeholder="No folder chosen" readonly>
                  <button type="button" class="btn" data-el="bg-image-browse">BROWSE…</button>
                </div>
                <span class="panel-status">${((station.background && station.background.images) || []).length} IMAGES</span>
              </div>
              <div class="field hidden" data-el="bg-video-field">
                <span class="field-label">VIDEO FILE (MUTED, LOOPED)</span>
                <div class="block-row">
                  <input type="text" class="title-row-input" data-el="bg-video-path" value="${(station.background && station.background.videoPath) || ''}" placeholder="No file chosen" readonly>
                  <button type="button" class="btn" data-el="bg-video-browse">BROWSE…</button>
                </div>
              </div>
            </div>
          `;
          listEl.appendChild(card);

          const q = (sel) => card.querySelector(`[data-el="${sel}"]`);
          const themeSelect = q('theme');
          GENRE_THEMES.forEach((t) => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.label;
            if (t.id === station.themeId) opt.selected = true;
            themeSelect.appendChild(opt);
          });

          q('name').addEventListener('change', (e) => updateStationAt(idx, { name: e.target.value.trim() || 'UNTITLED STATION' }));
          themeSelect.addEventListener('change', (e) => { updateStationAt(idx, { themeId: e.target.value }); renderList(); });
          q('remove').addEventListener('click', () => {
            const current = ctx.getPluginSettings('music-choice-channel');
            const next = current.stations.filter((_, i) => i !== idx);
            const patch = { stations: next };
            if (current.selectedStationId === station.id) patch.selectedStationId = next[0] ? next[0].id : null;
            commit(next, { selectedStationId: patch.selectedStationId });
            renderList();
          });

          q('browse-folder').addEventListener('click', async () => {
            const folder = await window.api.selectFolder();
            if (!folder) return;
            updateStationAt(idx, { folderPath: folder });
            renderList();
          });

          q('rescan').addEventListener('click', async () => {
            const st = stations()[idx];
            if (!st || !st.folderPath) return;
            const progressEl = q('scan-progress');
            progressEl.classList.remove('hidden');
            progressEl.textContent = 'SCANNING FOLDER…';
            const { files, error } = await window.api.musicChoiceScanFolder({ folderPath: st.folderPath, kind: 'audio' });
            if (error) { progressEl.textContent = `SCAN FAILED — ${error}`; return; }
            const existingByPath = new Map((st.tracks || []).map((t) => [t.path, t]));
            const tracks = (files || []).map((p) => existingByPath.get(p) || { path: p, artist: null, title: null, durationSec: 0 });
            progressEl.textContent = `PROBING DURATIONS… 0/${tracks.length}`;
            await probeAllDurations(tracks, (done, total) => {
              progressEl.textContent = `PROBING DURATIONS… ${done}/${total}`;
            });
            updateStationAt(idx, { tracks, anchorMs: st.anchorMs || Date.now() });
            progressEl.textContent = `DONE — ${tracks.length} TRACKS.`;
            setTimeout(renderList, 600);
          });

          const bgModeSelect = q('bg-mode');
          bgModeSelect.value = bgMode;
          q('bg-slideshow-field').classList.toggle('hidden', bgMode !== 'slideshow');
          q('bg-video-field').classList.toggle('hidden', bgMode !== 'video');
          bgModeSelect.addEventListener('change', () => {
            updateStationAt(idx, { background: { ...station.background, mode: bgModeSelect.value } });
            renderList();
          });

          q('bg-image-browse').addEventListener('click', async () => {
            const folder = await window.api.selectFolder();
            if (!folder) return;
            const { files, error } = await window.api.musicChoiceScanFolder({ folderPath: folder, kind: 'image' });
            if (error) return;
            updateStationAt(idx, { background: { ...station.background, mode: 'slideshow', imageFolderPath: folder, images: files || [] } });
            renderList();
          });

          q('bg-video-browse').addEventListener('click', async () => {
            const video = await window.api.selectVideo();
            if (!video) return;
            updateStationAt(idx, { background: { ...station.background, mode: 'video', videoPath: video } });
            renderList();
          });
        });
      }

      renderList();
    },
  }],
});
