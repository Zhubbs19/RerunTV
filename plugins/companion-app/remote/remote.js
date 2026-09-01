(function () {
  'use strict';
  var state = { channels: [], config: null, themes: [], pendingPatch: {}, fileRoot: null, filePath: '' };
  var feedbackTimer = null;
  var repeatTimer = null;
  var repeatInterval = null;
  var feedbackEl = document.getElementById('command-feedback');

  var GROUPS = [
    ['DISPLAY', ['display', 'crtEnabled', 'crtIntensity', 'pictureMode', 'aspectMode', 'displayMode', 'staticEffect', 'testPattern', 'theme']],
    ['PROGRAMMING', ['interstitials', 'commercials', 'curationProfiles', 'tagTaxonomy', 'trivia', 'upNext', 'ticker', 'reminders', 'reminderLeadMinutes', 'stationId', 'details', 'vintageAudio', 'customSounds', 'timeMachine']],
    ['SYSTEM', ['volume', 'contentVolume', 'adVolume', 'muted', 'autoStandby', 'network', 'pinLock', 'librarySync']],
    ['PLUGINS', ['pluginSettings']],
    ['UPDATES', ['updates']],
  ];
  var EXCLUDED_SETTINGS = new Set(['channels', 'plugins', 'pluginSettingsMeta', 'lastChannel']);
  var ENUMS = {
    pictureMode: [['standard', 'STANDARD'], ['vivid', 'VIVID'], ['cinema', 'CINEMA']],
    aspectMode: [['contain', 'STANDARD / SAFE'], ['stretch', 'STRETCH TO FILL'], ['fill', 'FILL / CROP']],
    'displayMode.aspect': [['16:9', '16:9 WIDESCREEN'], ['4:3', '4:3 CLASSIC'], ['auto', 'AUTO']],
    'displayMode.windowMode': [['letterbox', 'LETTERBOX'], ['lockWindow', 'LOCK WINDOW TO ASPECT']],
    'displayMode.resolution': [['native', 'NATIVE'], ['sd480', 'SD 480-LINE'], ['sd240', 'SD 240-LINE'], ['auto', 'AUTO']],
    'displayMode.autoPriority': [['metadata', 'FILE RESOLUTION FIRST'], ['era', 'ERA TAG FIRST']],
    'display.guideSlots': [['2', '2 / 1 HOUR'], ['3', '3 / 1.5 HOURS'], ['4', '4 / 2 HOURS']],
    'updates.strategy': [['startup-auto', 'INSTALL BEFORE APP OPENS'], ['background-auto', 'INSTALL WHEN APP QUITS'], ['background-notify', 'ASK WHEN READY'], ['manual', 'MANUAL'], ['off', 'OFF']],
  };

  function request(url, options) {
    return fetch(url, options).then(function (response) {
      if (!response.ok) return response.text().then(function (text) { throw new Error(text || ('HTTP ' + response.status)); });
      if (response.status === 204 || response.status === 202) return null;
      return response.json();
    });
  }

  function feedback(message, error) {
    feedbackEl.textContent = message;
    feedbackEl.classList.toggle('error', !!error);
    feedbackEl.classList.add('show');
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(function () { feedbackEl.classList.remove('show'); }, 1100);
  }

  function commandPayload(button) {
    return { key: button.dataset.key, shift: button.dataset.shift === '1', ctrl: button.dataset.ctrl === '1', alt: button.dataset.alt === '1' };
  }

  function sendCommand(button, quiet) {
    var payload = commandPayload(button);
    if (!quiet) feedback((button.textContent || payload.key).trim() + ' SENT');
    return request('/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      .catch(function () { feedback('REMOTE DISCONNECTED', true); });
  }

  function stopRepeat() {
    clearTimeout(repeatTimer); clearInterval(repeatInterval); repeatTimer = null; repeatInterval = null;
  }

  document.addEventListener('pointerdown', function (event) {
    var button = event.target.closest('button[data-key]');
    if (!button || button.disabled) return;
    event.preventDefault();
    sendCommand(button);
    if (button.classList.contains('repeat')) {
      repeatTimer = setTimeout(function () { repeatInterval = setInterval(function () { sendCommand(button, true); }, 135); }, 330);
    }
  });
  document.addEventListener('pointerup', stopRepeat);
  document.addEventListener('pointercancel', stopRepeat);
  document.addEventListener('pointerleave', stopRepeat);
  document.addEventListener('click', function (event) {
    var button = event.target.closest('button[data-key]');
    if (button && event.detail === 0) sendCommand(button);
  });

  document.querySelectorAll('[data-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('[data-tab]').forEach(function (item) { item.classList.toggle('active', item === tab); });
      document.querySelectorAll('[data-panel]').forEach(function (panel) { panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab); });
      if (tab.dataset.tab === 'settings' && !state.config) loadSettings();
      if ((tab.dataset.tab === 'channels' || tab.dataset.tab === 'guide') && !state.channels.length) loadChannels();
    });
  });

  function tune(number) {
    feedback('TUNING CH ' + number);
    return request('/tune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: number }) })
      .catch(function () { feedback('TUNE FAILED', true); });
  }

  function channelMatches(channel, query) {
    return !query || String(channel.number).includes(query) || String(channel.name || '').toLowerCase().includes(query);
  }

  function channelButton(channel) {
    var button = document.createElement('button');
    button.innerHTML = '<b>CH ' + channel.number + '</b><span></span>';
    button.querySelector('span').textContent = String(channel.name || 'UNTITLED').toUpperCase();
    button.addEventListener('click', function () { tune(channel.number); });
    return button;
  }

  function renderChannels() {
    var quick = document.getElementById('quick-channels');
    quick.replaceChildren();
    state.channels.filter(function (channel) { return channel.quickAccess; }).forEach(function (channel) { quick.appendChild(channelButton(channel)); });
    if (!quick.childElementCount) quick.innerHTML = '<div class="empty">MARK A CHANNEL QUICK-TAP IN CHANNELS TO ADD IT HERE.</div>';

    var guideQuery = document.getElementById('guide-channel-search').value.trim().toLowerCase();
    var guide = document.getElementById('guide-channels');
    guide.replaceChildren();
    state.channels.filter(function (channel) { return channelMatches(channel, guideQuery); }).forEach(function (channel) {
      var row = document.createElement('div'); row.className = 'channel-row';
      var main = document.createElement('button'); main.className = 'channel-main'; main.innerHTML = '<b>CH ' + channel.number + '</b><span></span>'; main.querySelector('span').textContent = channel.name || 'Untitled'; main.addEventListener('click', function () { tune(channel.number); });
      var badge = document.createElement('span'); badge.textContent = channel.favorite ? '★ FAVORITE' : 'TUNE'; badge.style.color = channel.favorite ? 'var(--amber)' : 'var(--dim)';
      row.append(main, badge); guide.appendChild(row);
    });

    var query = document.getElementById('channel-search').value.trim().toLowerCase();
    var manager = document.getElementById('channel-manager'); manager.replaceChildren();
    state.channels.filter(function (channel) { return channelMatches(channel, query); }).forEach(function (channel) {
      var row = document.createElement('div'); row.className = 'channel-row';
      var main = document.createElement('button'); main.className = 'channel-main'; main.innerHTML = '<b>CH ' + channel.number + '</b><span></span>'; main.querySelector('span').textContent = channel.name || 'Untitled'; main.addEventListener('click', function () { tune(channel.number); });
      var actions = document.createElement('div'); actions.className = 'channel-actions';
      [['favorite', 'FAVORITE'], ['quickAccess', 'QUICK-TAP']].forEach(function (entry) {
        var label = document.createElement('label'); var input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!channel[entry[0]];
        input.addEventListener('change', function () {
          channel[entry[0]] = input.checked;
          request('/channel/flag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: channel.number, field: entry[0], value: input.checked }) })
            .then(renderChannels).catch(function () { feedback('CHANNEL UPDATE FAILED', true); });
        });
        label.append(input, document.createTextNode(entry[1])); actions.appendChild(label);
      });
      row.append(main, actions); manager.appendChild(row);
    });
  }

  function loadChannels() {
    return request('/channels').then(function (channels) { state.channels = Array.isArray(channels) ? channels : []; renderChannels(); })
      .catch(function () { feedback('CHANNELS UNAVAILABLE', true); });
  }
  document.getElementById('channel-search').addEventListener('input', renderChannels);
  document.getElementById('guide-channel-search').addEventListener('input', renderChannels);

  function setPatch(path, value) {
    var node = state.pendingPatch;
    path.slice(0, -1).forEach(function (segment) { if (!node[segment] || typeof node[segment] !== 'object') node[segment] = {}; node = node[segment]; });
    node[path[path.length - 1]] = value;
    var save = document.querySelector('[data-action="save-settings"]'); save.disabled = false; save.textContent = 'SAVE CHANGES';
    document.getElementById('settings-status').textContent = 'Unsaved changes are ready to apply.';
  }

  function labelFor(key) { return String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').toUpperCase(); }
  function fieldShell(key, path) {
    var field = document.createElement('label'); field.className = 'field'; field.dataset.search = (labelFor(key) + ' ' + path.join('.')).toLowerCase();
    var label = document.createElement('span'); label.textContent = labelFor(key); field.appendChild(label); return field;
  }

  function renderSetting(key, value, path) {
    var dotted = path.join('.');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      var details = document.createElement('details'); details.className = 'setting-object'; details.dataset.search = (labelFor(key) + ' ' + dotted).toLowerCase();
      var summary = document.createElement('summary'); summary.textContent = labelFor(key); var body = document.createElement('div'); body.className = 'settings-group-body';
      Object.keys(value).sort().forEach(function (childKey) { body.appendChild(renderSetting(childKey, value[childKey], path.concat(childKey))); });
      details.append(summary, body); return details;
    }
    var field = fieldShell(key, path);
    if (Array.isArray(value)) {
      field.classList.add('json-field'); var area = document.createElement('textarea'); area.value = JSON.stringify(value, null, 2); area.spellcheck = false;
      area.addEventListener('change', function () { try { var parsed = JSON.parse(area.value); if (!Array.isArray(parsed)) throw new Error(); field.classList.remove('invalid'); setPatch(path, parsed); } catch (e) { field.classList.add('invalid'); feedback('INVALID JSON LIST', true); } }); field.appendChild(area); return field;
    }
    if (typeof value === 'boolean') {
      field.classList.add('checkbox'); field.replaceChildren(); var check = document.createElement('input'); check.type = 'checkbox'; check.checked = value; var text = document.createElement('span'); text.textContent = labelFor(key); check.addEventListener('change', function () { setPatch(path, check.checked); }); field.append(check, text); return field;
    }
    var enumValues = dotted === 'theme' && state.themes.length ? state.themes.map(function (theme) { return [theme.id, theme.label]; }) : ENUMS[dotted];
    if (enumValues) {
      var select = document.createElement('select'); enumValues.forEach(function (entry) { var option = document.createElement('option'); option.value = entry[0]; option.textContent = entry[1]; select.appendChild(option); }); select.value = String(value); select.addEventListener('change', function () { setPatch(path, typeof value === 'number' ? Number(select.value) : select.value); }); field.appendChild(select); return field;
    }
    if (typeof value === 'number' && value >= 0 && value <= 1) {
      var wrap = document.createElement('div'); wrap.className = 'field-range'; var range = document.createElement('input'); range.type = 'range'; range.min = '0'; range.max = '100'; range.value = String(Math.round(value * 100)); var output = document.createElement('output'); output.textContent = range.value + '%'; range.addEventListener('input', function () { output.textContent = range.value + '%'; }); range.addEventListener('change', function () { setPatch(path, Number(range.value) / 100); }); wrap.append(range, output); field.appendChild(wrap); return field;
    }
    var input = document.createElement('input'); input.value = value == null ? '' : String(value); var sensitive = /(?:api.?key|token|secret|password|credential|auth)/i.test(key); input.type = sensitive ? 'password' : (typeof value === 'number' ? 'number' : 'text'); if (sensitive) input.placeholder = 'Current value hidden — enter a replacement'; if (typeof value === 'number') input.step = 'any'; input.addEventListener('change', function () { if (sensitive && !input.value) return; setPatch(path, typeof value === 'number' ? Number(input.value) : input.value); }); field.appendChild(input); return field;
  }

  function renderSettings() {
    var editor = document.getElementById('settings-editor'); editor.replaceChildren();
    var known = new Set();
    GROUPS.forEach(function (group) { group[1].forEach(function (key) { known.add(key); }); });
    var groups = GROUPS.concat([['MORE', Object.keys(state.config || {}).filter(function (key) { return !known.has(key) && !EXCLUDED_SETTINGS.has(key); })]]);
    groups.forEach(function (group) {
      var keys = group[1].filter(function (key) { return state.config && Object.prototype.hasOwnProperty.call(state.config, key) && !EXCLUDED_SETTINGS.has(key); }); if (!keys.length) return;
      var details = document.createElement('details'); details.className = 'settings-group'; details.dataset.search = group[0].toLowerCase();
      var summary = document.createElement('summary'); summary.textContent = group[0] + ' · ' + keys.length; var body = document.createElement('div'); body.className = 'settings-group-body';
      keys.forEach(function (key) { body.appendChild(renderSetting(key, state.config[key], [key])); }); details.append(summary, body); editor.appendChild(details);
    });
    filterSettings();
  }

  function loadSettings() {
    var status = document.getElementById('settings-status'); status.className = 'notice'; status.textContent = 'Loading current settings…';
    return Promise.all([request('/api/config'), request('/api/themes').catch(function () { return []; })]).then(function (values) {
      state.config = values[0] || {}; state.themes = values[1] || []; state.pendingPatch = {}; renderSettings();
      status.textContent = 'Every editable box-wide and plugin setting is available below. Arrays use validated JSON editors.';
      document.querySelector('[data-action="save-settings"]').disabled = true;
    }).catch(function (error) { status.className = 'notice error'; status.textContent = 'Settings unavailable: ' + error.message; });
  }

  function filterSettings() {
    var query = document.getElementById('settings-search').value.trim().toLowerCase();
    document.querySelectorAll('#settings-editor .field').forEach(function (node) { node.classList.toggle('filtered-out', !!query && !(node.dataset.search || '').includes(query)); });
    Array.from(document.querySelectorAll('#settings-editor .setting-object')).reverse().forEach(function (node) {
      var descendant = node.querySelector('.field:not(.filtered-out),.setting-object:not(.filtered-out)');
      node.classList.toggle('filtered-out', !!query && !(node.dataset.search || '').includes(query) && !descendant);
      if (query && descendant) node.open = true;
    });
    document.querySelectorAll('#settings-editor .settings-group').forEach(function (group) { var visible = group.querySelector('.field:not(.filtered-out),.setting-object:not(.filtered-out)'); group.classList.toggle('filtered-out', !!query && !visible && !(group.dataset.search || '').includes(query)); if (query && visible) group.open = true; });
  }
  document.getElementById('settings-search').addEventListener('input', filterSettings);

  function saveSettings() {
    var button = document.querySelector('[data-action="save-settings"]'); var status = document.getElementById('settings-status'); button.disabled = true; button.textContent = 'APPLYING…';
    request('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch: state.pendingPatch }) }).then(function () {
      status.className = 'notice success'; status.textContent = 'Changes accepted and applied live on RerunTV.'; feedback('SETTINGS APPLIED');
      setTimeout(loadSettings, 750);
    }).catch(function (error) { button.disabled = false; button.textContent = 'RETRY SAVE'; status.className = 'notice error'; status.textContent = 'Could not apply settings: ' + error.message; });
  }

  function loadRoots() {
    var browser = document.getElementById('file-browser'); browser.innerHTML = '<div class="empty">LOADING FOLDERS…</div>';
    request('/api/roots').then(function (roots) { browser.replaceChildren(); (roots || []).forEach(function (root) { var button = document.createElement('button'); button.className = 'root-button'; button.innerHTML = '<span>▣ ' + escapeHtml(root.label) + '</span><span>OPEN ›</span>'; button.addEventListener('click', function () { state.fileRoot = root; state.filePath = ''; loadFiles(); }); browser.appendChild(button); }); if (!browser.childElementCount) browser.innerHTML = '<div class="empty">NO LOCAL CHANNEL FOLDERS FOUND.</div>'; }).catch(function () { browser.innerHTML = '<div class="empty">FILES UNAVAILABLE.</div>'; });
  }

  function escapeHtml(value) { var span = document.createElement('span'); span.textContent = String(value || ''); return span.innerHTML; }
  function loadFiles() {
    var browser = document.getElementById('file-browser'); var query = '?root=' + encodeURIComponent(state.fileRoot.id) + '&path=' + encodeURIComponent(state.filePath); browser.innerHTML = '<div class="empty">LOADING…</div>';
    request('/api/files' + query).then(function (result) {
      browser.replaceChildren(); var crumbs = document.createElement('div'); crumbs.className = 'breadcrumbs'; var rootButton = document.createElement('button'); rootButton.className = 'mini'; rootButton.textContent = '‹ ROOTS'; rootButton.addEventListener('click', loadRoots); crumbs.append(rootButton, document.createTextNode(state.fileRoot.label + (state.filePath ? ' / ' + state.filePath : ''))); browser.appendChild(crumbs);
      if (state.filePath) { var up = document.createElement('button'); up.className = 'file-row'; up.textContent = '↰ PARENT FOLDER'; up.addEventListener('click', function () { state.filePath = state.filePath.split('/').slice(0, -1).join('/'); loadFiles(); }); browser.appendChild(up); }
      (result.entries || []).forEach(function (entry) { var rel = state.filePath ? state.filePath + '/' + entry.name : entry.name; var row = document.createElement('div'); row.className = 'file-row'; var name = document.createElement('span'); name.textContent = (entry.isDir ? '▣ ' : '▤ ') + entry.name; row.appendChild(name); if (entry.isDir) { var open = document.createElement('button'); open.className = 'mini'; open.textContent = 'OPEN'; open.addEventListener('click', function () { state.filePath = rel; loadFiles(); }); row.appendChild(open); } else { var link = document.createElement('a'); link.textContent = 'DOWNLOAD'; link.href = '/api/files/download?root=' + encodeURIComponent(state.fileRoot.id) + '&path=' + encodeURIComponent(rel); row.appendChild(link); } browser.appendChild(row); });
    }).catch(function () { browser.innerHTML = '<div class="empty">COULD NOT OPEN THIS FOLDER.</div>'; });
  }

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action]'); if (!button) return;
    var action = button.dataset.action;
    if (action === 'refresh-channels') loadChannels();
    else if (action === 'reload-settings') loadSettings();
    else if (action === 'save-settings') saveSettings();
    else if (action === 'load-roots') loadRoots();
    else if (action === 'trigger-news') request('/news/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ headline: document.getElementById('news-headline').value.trim() }) }).then(function () { feedback('NEWS ALERT TRIGGERED'); }).catch(function () { feedback('NEWS ALERT FAILED', true); });
    else if (action === 'trigger-trivia') request('/party/trivia/start', { method: 'POST' }).then(function () { feedback('TRIVIA TRIGGERED'); }).catch(function () { feedback('TRIVIA FAILED', true); });
    else if (action === 'ticker-on' || action === 'ticker-off') request('/ticker/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: document.getElementById('ticker-text').value, enabled: action === 'ticker-on' }) }).then(function () { feedback(action === 'ticker-on' ? 'TICKER ON' : 'TICKER OFF'); }).catch(function () { feedback('TICKER UPDATE FAILED', true); });
    else if (action === 'send-hotkey') { var key = document.getElementById('custom-hotkey').value; if (key) sendCommand({ dataset: { key: key }, textContent: key.toUpperCase() }); }
  });

  function pollState() {
    request('/state').then(function (remoteState) {
      var watching = document.getElementById('now-watching'); var live = document.getElementById('live-status'); live.dataset.state = 'online';
      if (remoteState && remoteState.number != null) { var mode = remoteState.timeMachineOn ? (remoteState.shuttleDir < 0 ? ' · REW' : remoteState.shuttleDir > 0 ? ' · FF' : ' · TIME MACHINE') : ''; watching.textContent = 'CH ' + remoteState.number + (remoteState.name ? ' — ' + String(remoteState.name).toUpperCase() : '') + mode; } else watching.textContent = remoteState && remoteState.powered === false ? 'POWERED OFF' : 'NO SIGNAL';
    }).catch(function () { document.getElementById('live-status').dataset.state = 'offline'; document.getElementById('now-watching').textContent = 'DISCONNECTED'; });
  }

  loadChannels(); pollState(); setInterval(pollState, 1500);
})();
