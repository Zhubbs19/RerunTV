// Per-channel edit-tab panels: FOLDERS and channel identity live here; TITLES,
// ADS/commercials and the LOGO/overlay panels live in titles-panel.js,
// ad-panels.js and overlay-panels.js and are re-exported below so importers
// keep using this module. SCHEDULE + CALENDAR live in schedule.js; channel-list/
// bulk-action rendering lives in channels.js.
import { themePackEntries } from '../plugin/host.js';
import { pickFilesForChannel, removeFileFromChannel, removeFolderFromChannel } from './channels.js';
import { getDisplayTitle } from '../core/util.js';
import { commitOwnerFields, safeApi } from './util.js';
import { confirmDialog } from './dialogs.js';

export { buildTitlesPanel } from './titles-panel.js';
export { buildChannelAdsPanel, buildCommercialsPanel } from './ad-panels.js';
export { buildLogoBugPanel, buildCreditsSpeedupPanel, buildDynamicOverlaysPanel, buildTickerLayoutPanel } from './overlay-panels.js';

export function buildFoldersPanel(ch, panelEl) {
  panelEl.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'titles-list';

  (ch.folders || []).forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'folder-row';

    const display = entry.label || entry.ref;
    const path = document.createElement('span');
    path.className = 'folder-row-path';
    path.textContent = entry.source && entry.source !== 'local' ? `[${entry.source}] ${display}` : display;
    path.title = display;
    row.appendChild(path);

    const count = ch.files.filter((f) => f.folder === entry.id).length;
    const countEl = document.createElement('span');
    countEl.className = 'folder-row-count';
    countEl.textContent = `${count} video${count === 1 ? '' : 's'}`;
    row.appendChild(countEl);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn remove-btn';
    removeBtn.textContent = 'REMOVE';
    removeBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(`Remove this folder (${count} video${count === 1 ? '' : 's'}) from the channel?`))) return;
      removeFolderFromChannel(ch, entry);
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  });

  // Videos added one at a time (ADD FILES, or dropped onto the channel) are not
  // part of any folder, so they get their own rows, each removable by itself.
  const looseFiles = ch.files.filter((f) => !f.folder);
  looseFiles.forEach((file) => {
    const row = document.createElement('div');
    row.className = 'folder-row';

    const name = document.createElement('span');
    name.className = 'folder-row-path';
    name.textContent = getDisplayTitle(file);
    name.title = file.path;
    row.appendChild(name);

    const countEl = document.createElement('span');
    countEl.className = 'folder-row-count';
    countEl.textContent = 'FILE';
    row.appendChild(countEl);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn remove-btn';
    removeBtn.textContent = 'REMOVE';
    removeBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(`Remove "${getDisplayTitle(file)}" from the channel? The file itself is not deleted.`))) return;
      removeFileFromChannel(ch, file);
    });
    row.appendChild(removeBtn);

    list.appendChild(row);
  });

  if ((!ch.folders || ch.folders.length === 0) && looseFiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'titles-empty';
    empty.textContent = 'NO FOLDERS OR FILES';
    list.appendChild(empty);
  }

  const addFilesBtn = document.createElement('button');
  addFilesBtn.className = 'btn folder-btn';
  addFilesBtn.textContent = '+ ADD FILES';
  addFilesBtn.title = 'Pick individual videos to add to this channel, instead of a whole folder';
  addFilesBtn.addEventListener('click', () => pickFilesForChannel(ch));

  panelEl.appendChild(list);
  panelEl.appendChild(addFilesBtn);
}

export function buildChannelIdentityPanel(ch, panelEl) {
  panelEl.innerHTML = '';
  const identity = ch.broadcastIdentity ? { ...ch.broadcastIdentity } : {};
  const persistIdentity = () => {
    if (Object.keys(identity).length) ch.broadcastIdentity = identity;
    else delete ch.broadcastIdentity;
    commitOwnerFields(ch, ['broadcastIdentity'], { coalesce: `ch:${ch.number}:identity` });
  };
  const intro = document.createElement('div');
  intro.className = 'titles-empty';
  intro.textContent = 'Optional channel identity overrides. Leave a field on Inherit to follow the box theme and box-wide signal copy.';

  function selectField(label, key, options) {
    const wrap = document.createElement('label');
    wrap.className = 'channel-identity-field';
    wrap.append(document.createTextNode(label));
    const select = document.createElement('select');
    select.className = 'block-hour-select';
    options.forEach(([value, text]) => {
      const option = document.createElement('option'); option.value = value; option.textContent = text; select.appendChild(option);
    });
    select.value = identity[key] || '';
    select.addEventListener('change', () => {
      if (select.value) identity[key] = select.value; else delete identity[key];
      persistIdentity();
    });
    wrap.appendChild(select);
    return wrap;
  }

  function textOverrideField(label, key, maxLength, placeholder) {
    const wrap = document.createElement('label');
    wrap.className = 'channel-identity-field channel-identity-field-wide';
    wrap.append(document.createTextNode(label));
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'title-row-input';
    input.maxLength = maxLength;
    input.placeholder = placeholder;
    input.value = typeof identity[key] === 'string' ? identity[key] : '';
    input.addEventListener('input', () => {
      const value = input.value.slice(0, maxLength);
      if (value) identity[key] = value; else delete identity[key];
      persistIdentity();
    });
    wrap.appendChild(input);
    return wrap;
  }

  const grid = document.createElement('div');
  grid.className = 'channel-identity-grid';
  grid.append(
    selectField('THEME / ERA', 'theme', [['', 'INHERIT BOX THEME'], ...themePackEntries().map((entry) => [entry.id, entry.label])]),
    selectField('TUNE SOUND', 'tuneSfx', [['', 'INHERIT THEME'], ['soft', 'SOFT CHIME'], ['analog', 'ANALOG STATIC'], ['digital', 'DIGITAL CHIRP'], ['silent', 'SILENT']]),
    selectField('TUNING STATIC', 'staticStyle', [['', 'INHERIT THEME'], ['noise', 'CLASSIC NOISE'], ['quiet', 'QUIET BLIP'], ['roll', 'VERTICAL ROLL'], ['tear', 'TEARING SIGNAL'], ['acquire', 'DIGITAL ACQUIRE']]),
    textOverrideField('NO SIGNAL HEADING', 'noSignalTitle', 48, 'INHERIT BOX HEADING'),
    textOverrideField('NO SIGNAL DETAIL', 'noSignalMessage', 120, 'INHERIT BOX DETAIL — {channel} inserts number'),
  );
  function soundOverrideField(labelText, slot) {
    const label = document.createElement('div');
    label.className = 'channel-identity-field';
    label.append(document.createTextNode(labelText));
    const status = document.createElement('span');
    status.className = 'custom-sound-status';
    const refresh = async () => {
      const value = identity.sounds && identity.sounds[slot];
      status.textContent = value === false ? 'SILENT' : (typeof value === 'string' ? await window.api.basename(value) : 'INHERIT BOX');
    };
    const actions = document.createElement('span');
    actions.className = 'channel-identity-color';
    const choose = document.createElement('button');
    choose.type = 'button'; choose.className = 'btn'; choose.textContent = 'CHOOSE…';
    choose.disabled = !window.api.selectAudio;
    choose.addEventListener('click', async () => {
      const path = await safeApi('Opening the file picker', () => window.api.selectAudio());
      if (!path) return;
      identity.sounds = { ...(identity.sounds || {}), [slot]: path };
      persistIdentity(); refresh();
    });
    const inherit = document.createElement('button');
    inherit.type = 'button'; inherit.className = 'btn'; inherit.textContent = 'INHERIT';
    inherit.addEventListener('click', () => {
      if (identity.sounds) delete identity.sounds[slot];
      if (identity.sounds && !Object.keys(identity.sounds).length) delete identity.sounds;
      persistIdentity(); refresh();
    });
    const silent = document.createElement('button');
    silent.type = 'button'; silent.className = 'btn'; silent.textContent = 'SILENT';
    silent.addEventListener('click', () => {
      identity.sounds = { ...(identity.sounds || {}), [slot]: false };
      persistIdentity(); refresh();
    });
    actions.append(choose, inherit, silent);
    label.append(status, actions);
    refresh();
    return label;
  }
  grid.append(
    soundOverrideField('CUSTOM TUNE SOUND', 'channelTune'),
    soundOverrideField('CUSTOM CARD SOUND', 'card'),
  );
  [['PRIMARY ACCENT', 'accent'], ['SECONDARY ACCENT', 'accent2'], ['STATIC TINT', 'staticTint']].forEach(([labelText, key]) => {
    const label = document.createElement('label');
    label.className = 'channel-identity-field';
    label.append(document.createTextNode(labelText));
    const input = document.createElement('input');
    input.type = 'color'; input.value = identity[key] || (key === 'accent2' ? '#56d9ff' : '#f4cf3f');
    const enabled = document.createElement('input');
    enabled.type = 'checkbox'; enabled.checked = !!identity[key]; enabled.title = `Override ${labelText.toLowerCase()}`;
    const row = document.createElement('span'); row.className = 'channel-identity-color'; row.append(enabled, input);
    const commit = () => { if (enabled.checked) identity[key] = input.value; else delete identity[key]; persistIdentity(); };
    enabled.addEventListener('change', commit); input.addEventListener('input', () => { enabled.checked = true; commit(); });
    label.appendChild(row); grid.appendChild(label);
  });
  // The artist / song card a music-video channel shows as each video starts
  // and ends (playback/track-card.js). Per channel, off by default; the Music
  // Television preset turns it on when it builds a channel.
  const trackWrap = document.createElement('label');
  trackWrap.className = 'channel-identity-field channel-identity-field-wide';
  trackWrap.append(document.createTextNode('ARTIST / SONG CARD'));
  const trackRow = document.createElement('span');
  trackRow.className = 'channel-identity-color';
  const trackEnabled = document.createElement('input');
  trackEnabled.type = 'checkbox';
  trackEnabled.checked = !!(ch.trackCard && ch.trackCard.enabled);
  trackEnabled.title = 'Show the artist and song as each video starts and ends';
  const trackSeconds = document.createElement('select');
  trackSeconds.className = 'block-hour-select';
  [4, 6, 8, 10, 12, 15].forEach((seconds) => {
    const option = document.createElement('option'); option.value = String(seconds); option.textContent = `${seconds} S ON SCREEN`; trackSeconds.appendChild(option);
  });
  trackSeconds.value = String((ch.trackCard && ch.trackCard.seconds) || 8);
  trackSeconds.disabled = !trackEnabled.checked;
  const commitTrack = () => {
    ch.trackCard = trackEnabled.checked ? { enabled: true, atStart: true, atEnd: true, seconds: Number(trackSeconds.value) || 8 } : null;
    trackSeconds.disabled = !trackEnabled.checked;
    commitOwnerFields(ch, ['trackCard'], { coalesce: `ch:${ch.number}:trackCard` });
  };
  trackEnabled.addEventListener('change', commitTrack);
  trackSeconds.addEventListener('change', commitTrack);
  trackRow.append(trackEnabled, trackSeconds);
  trackWrap.appendChild(trackRow);
  grid.appendChild(trackWrap);

  const clear = document.createElement('button');
  clear.className = 'btn'; clear.textContent = 'CLEAR ALL IDENTITY OVERRIDES';
  clear.addEventListener('click', async () => { if (!(await confirmDialog({ title: 'CLEAR IDENTITY OVERRIDES?', message: `Remove every identity override on CH ${ch.number} and go back to the box defaults? You can undo this.`, confirmText: 'CLEAR', danger: true }))) return; delete ch.broadcastIdentity; buildChannelIdentityPanel(ch, panelEl); commitOwnerFields(ch, ['broadcastIdentity'], { label: `Clear CH ${ch.number} identity` }); });
  panelEl.append(intro, grid, clear);
}
