import { DEFAULT_ERA, ERAS, GENRE_THEMES, probeAllDurations } from './renderer.js';

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

// Rescanning = list the folder, probe durations for new files, then read each
// new file's tags (artist/title/album/year) so the channel's search can find
// songs by album and year even when the filenames carry neither. Files already
// probed and tag-read keep their saved data, so a rescan only pays for what
// changed. `onProgress(text)` reports each phase.
const TAG_BATCH = 25;

async function readTagsInto(tracks, onProgress) {
  if (!window.api.musicChoiceReadTags) return;
  const pending = tracks.filter((t) => !t.tagsRead);
  for (let i = 0; i < pending.length; i += TAG_BATCH) {
    onProgress(`READING SONG TAGS… ${i}/${pending.length}`);
    const batch = pending.slice(i, i + TAG_BATCH);
    // eslint-disable-next-line no-await-in-loop
    const result = await window.api.musicChoiceReadTags({ filePaths: batch.map((t) => t.path) }).catch(() => null);
    // A failed batch (the plugin's capability not yet approved, say) leaves
    // these unread so the next rescan tries them again.
    if (!result || !Array.isArray(result.tags)) return;
    batch.forEach((track, j) => {
      const tags = result.tags[j] || {};
      track.tags = Object.keys(tags).length ? tags : null;
      track.tagsRead = true;
    });
  }
}

async function scanStationTracks(station, onProgress) {
  onProgress('SCANNING FOLDER…');
  // Host-only: it reads the host's own filesystem, so it is absent on a LAN
  // viewer or control panel (renderer/js/api-contract.js).
  if (!window.api.musicChoiceScanFolder) throw new Error('SCANNING ONLY WORKS ON THE HOST DEVICE.');
  const { files, error } = await window.api.musicChoiceScanFolder({ folderPath: station.folderPath, kind: 'audio' });
  if (error) throw new Error(`SCAN FAILED — ${error}`);
  const existingByPath = new Map((station.tracks || []).map((t) => [t.path, t]));
  const tracks = (files || []).map((p) => existingByPath.get(p) || { path: p, artist: null, title: null, durationSec: 0 });
  onProgress(`PROBING DURATIONS… 0/${tracks.length}`);
  await probeAllDurations(tracks, (done, total) => onProgress(`PROBING DURATIONS… ${done}/${total}`));
  await readTagsInto(tracks, onProgress);
  return tracks;
}

function totalDuration(station) {
  const secs = (station.tracks || []).reduce((sum, t) => sum + (t.durationSec || 0), 0);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h ? `${h}H ${m}M` : `${m}M`;
}

window.RCBPlugins.registerPluginSettings('music-choice-channel', {
  schemaVersion: 2,
  defaults: { stations: [], selectedStationId: null, era: DEFAULT_ERA, factoids: [] },
  validate(settings) {
    if (!Array.isArray(settings.stations)) return 'stations must be an array';
    if (settings.factoids != null && !Array.isArray(settings.factoids)) return 'factoids must be an array';
    return true;
  },
  sections: [{
    id: 'presentation',
    label: 'ON-SCREEN STYLE',
    render(container) {
      const settings = window.RCBPlugins.ctx.settings.getPluginSettings('music-choice-channel');
      container.innerHTML = `
        <div class="panel-status">
          Real cable audio services ran a "freeze frame" format — still slides over the music showing
          artist, song, album and year, with a strip underneath carrying artist notes and
          &ldquo;Did You Know?&rdquo; factoids that swapped every 30 seconds or so. None of them ever showed a
          progress bar, an elapsed time, or an up-next line. Pick how faithful you want this channel to be.
        </div>
        <div class="field">
          <span class="field-label">ERA</span>
          <select class="block-hour-select" data-el="era"></select>
        </div>
        <div class="field">
          <span class="field-label">&ldquo;DID YOU KNOW?&rdquo; FACTOIDS — ONE PER LINE</span>
          <textarea class="pubaccess-slide-input" data-el="factoids" rows="5"
            placeholder="Your own notes about the music on this channel. Nothing ships here by default — invented trivia would put made-up claims on screen as if they were true."></textarea>
          <span class="panel-status">Rotates with slides built from your own library, in the strip along the bottom of the screen.</span>
        </div>
      `;
      const eraSelect = container.querySelector('[data-el="era"]');
      ERAS.forEach((era) => {
        const opt = document.createElement('option');
        opt.value = era.id;
        opt.textContent = era.label;
        if (era.id === (settings.era || DEFAULT_ERA)) opt.selected = true;
        eraSelect.appendChild(opt);
      });
      eraSelect.addEventListener('change', () => {
        window.RCBPlugins.ctx.settings.updatePluginSettings('music-choice-channel', { era: eraSelect.value });
      });

      const factoidsEl = container.querySelector('[data-el="factoids"]');
      factoidsEl.value = (settings.factoids || []).join('\n');
      factoidsEl.addEventListener('change', () => {
        const lines = factoidsEl.value.split('\n').map((l) => l.trim()).filter(Boolean);
        window.RCBPlugins.ctx.settings.updatePluginSettings('music-choice-channel', { factoids: lines });
      });
    },
  }, {
    id: 'stations',
    label: 'MUSIC CHOICE CHANNEL (CH 910)',
    layout: 'wide',
    render(container, ctx) {
      container.innerHTML = `
        <div class="panel-status">A retro digital-cable-style music channel (CH 910). Each "station" is a music folder plus a genre color theme — flip between them live with &larr;/&rarr;, or press OK for the station list and to search every station's songs by title, artist, album or year. Space (&#x23EF; on a remote) pauses; while paused or playing a search pick, &larr;/&rarr; seek.</div>
        <div class="panel-status">Searching by album and year uses each song's own tags, read when a station is rescanned. Stations scanned before this was added need one more RESCAN.</div>
        <div data-el="list"></div>
        <div class="block-row">
          <button type="button" data-el="add-station" class="btn btn-primary">+ ADD STATION</button>
          <button type="button" data-el="rescan-all" class="btn">RESCAN ALL STATIONS</button>
        </div>
        <div class="panel-status hidden" data-el="rescan-all-progress"></div>
      `;
      const listEl = container.querySelector('[data-el="list"]');
      const addBtn = container.querySelector('[data-el="add-station"]');
      const rescanAllBtn = container.querySelector('[data-el="rescan-all"]');
      const rescanAllProgress = container.querySelector('[data-el="rescan-all-progress"]');

      // The section's own `ctx.settings` is a one-time snapshot (taken when
      // the panel was expanded — see setup-plugin-settings.js's makeContext),
      // not a live reference, so re-reading it after a mutation would show
      // stale data. window.RCBPlugins.ctx.settings.getPluginSettings/
      // updatePluginSettings (the generic grouped accessor documented in
      // PLUGIN_DEVELOPMENT.md, same one renderer.js uses) always reads the
      // live store instead.
      function stations() {
        return window.RCBPlugins.ctx.settings.getPluginSettings('music-choice-channel').stations || [];
      }
      function commit(nextStations, extra) {
        window.RCBPlugins.ctx.settings.updatePluginSettings('music-choice-channel', { stations: nextStations, ...(extra || {}) });
      }
      function updateStationAt(idx, patch) {
        const next = stations().map((s, i) => (i === idx ? { ...s, ...patch } : s));
        commit(next);
      }
      // By id, not index: a scan is slow enough for the list to change under
      // it (a station removed or added meanwhile).
      function commitStationTracks(id, tracks) {
        const next = stations().map((s) => (s.id === id ? { ...s, tracks, anchorMs: s.anchorMs || Date.now() } : s));
        commit(next);
      }

      rescanAllBtn.addEventListener('click', async () => {
        const list = stations().filter((s) => s.folderPath);
        if (!list.length) return;
        rescanAllBtn.disabled = true;
        rescanAllProgress.classList.remove('hidden');
        let failed = 0;
        for (let i = 0; i < list.length; i++) {
          const st = list[i];
          const prefix = `${i + 1}/${list.length} ${st.name || 'UNTITLED STATION'}: `;
          try {
            // eslint-disable-next-line no-await-in-loop
            const tracks = await scanStationTracks(st, (text) => { rescanAllProgress.textContent = prefix + text; });
            commitStationTracks(st.id, tracks);
          } catch (e) {
            failed += 1;
            rescanAllProgress.textContent = prefix + e.message;
          }
        }
        rescanAllBtn.disabled = false;
        rescanAllProgress.textContent = failed
          ? `DONE — ${failed} OF ${list.length} STATIONS COULD NOT BE SCANNED.`
          : `DONE — ${list.length} STATIONS RESCANNED.`;
        setTimeout(renderList, 600);
      });

      addBtn.addEventListener('click', () => {
        const st = newStation();
        const current = window.RCBPlugins.ctx.settings.getPluginSettings('music-choice-channel');
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
            const current = window.RCBPlugins.ctx.settings.getPluginSettings('music-choice-channel');
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
            let tracks;
            try {
              tracks = await scanStationTracks(st, (text) => { progressEl.textContent = text; });
            } catch (e) {
              progressEl.textContent = e.message;
              return;
            }
            commitStationTracks(st.id, tracks);
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
