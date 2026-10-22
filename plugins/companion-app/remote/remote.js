(function () {
  'use strict';
  var state = {
    channels: [], config: null, themes: [], pendingPatch: {}, fileRoot: null, filePath: '',
    fileEntries: [], watchingNumber: null, awaitingSettingsResult: false, settingsResultTimer: null,
  };
  var feedbackTimer = null;
  var repeatTimer = null;
  var repeatInterval = null;
  var lastPointerCommandAt = 0;
  var lastSettingsResultAt = 0;
  var feedbackEl = document.getElementById('command-feedback');

  // EVERYDAY is the short list of things someone actually picks up a phone
  // to change, lifted out of the buried groups they used to sit in (a
  // volume slider was four taps deep inside SYSTEM). Each of these is a
  // top-level scalar, so lifting them is just a move — no key appears in
  // two groups, and nothing else about how they save changes.
  var GROUPS = [
    ['EVERYDAY', ['volume', 'muted', 'contentVolume', 'adVolume', 'crtEnabled', 'pictureMode', 'aspectMode', 'controls']],
    ['DISPLAY', ['display', 'crtIntensity', 'displayMode', 'staticEffect', 'testPattern']],
    ['PROGRAMMING', ['interstitials', 'commercials', 'curationProfiles', 'tagTaxonomy', 'trivia', 'upNext', 'ticker', 'reminders', 'reminderLeadMinutes', 'stationId', 'details', 'vintageAudio', 'customSounds', 'timeMachine']],
    ['SYSTEM', ['autoStandby', 'network', 'pinLock', 'librarySync']],
    ['PLUGINS', ['pluginSettings']],
    ['UPDATES', ['updates']],
  ];
  // Everything a mechanically-derived label cannot say. Only for the
  // settings a person is likely to meet first — the rest of the tree is
  // still the box's own config, named after its own keys.
  var HELP = {
    volume: 'Master level for everything the box plays.',
    muted: 'Silences the box without changing the volume level.',
    contentVolume: 'Extra trim applied to shows and movies only.',
    adVolume: 'Extra trim applied to commercials and bumpers only — turn it down if ads are louder than the show.',
    crtEnabled: 'The scanline / curvature / grain picture treatment.',
    pictureMode: 'Overall picture look, the way a TV picture menu works.',
    aspectMode: 'How content that does not match the screen shape is fitted.',
    theme: 'Which era of on-screen guide and menus the box wears.',
    'display.uiScale': 'Size of the TV’s own interface, not this page.',
    'updates.strategy': 'When a downloaded update is allowed to install.',
    'controls.startupChannel': 'Where the TV tunes when it opens: last, first, or a channel number.',
    'controls.entryDelayMs': 'How long the box waits after the last digit before tuning.',
    'controls.scanDwellSec': 'How long SCAN stays on each channel.',
    'controls.sleepSteps': 'The sleep timer lengths, in minutes. The Z key cycles through them.',
    'controls.volumeStepPct': 'How much each volume press changes the level.',
    'controls.volumeMaxPct': 'The volume keys stop here — handy when the TV is much louder than the PC.',
    'controls.rememberChannelVolume': 'Tuning back to a channel returns it to the volume you left it at.',
    'controls.tuneFadeInMs': 'Fades the sound in after changing channel, to soften a loud start (0 = off).',
    'controls.sleepFadeOut': 'The sound fades over the last 25 seconds of the sleep timer instead of cutting off.',
    'display.guideSlotMinutes': 'Length of each guide column in minutes.',
    'display.autoFillWidescreen': 'Crop the sides of widescreen content so it fills the picture instead of showing black bars.',
    'display.autoFillMaxCropPct': 'The most of the width widescreen fill may crop; wider films keep their bars.',
    'display.removeBakedBars': 'Find black bars that are part of the video itself and frame just the picture.',
    'display.logoBugFollowPicture': 'Place and size the logo bug against the picture, so it never sits on black bars.',
    'display.logoBugHideOnBreaks': 'No logo bug over commercials and bumpers.',
    'display.logoBugHideNumber': 'Leave the channel number chip off logos.',
    'display.logoBugVaryWithContent': 'Switch logo size with the content’s aspect ratio and resolution instead of one size everywhere.',
    'timeMachine.showTimeShiftBadge': 'Show the TIME SHIFT badge while the picture is not live.',
    'commercials.noRepeatCommercials': 'Each commercial airs at most once per ad break.',
    'commercials.noRepeatBumpers': 'The bump-in and bump-out idents of a break can’t be the same clip.',
    'commercials.noRepeatInterstitials': 'Within a flow, a bumper or promo clip airs at most once.',
  };
  var EXCLUDED_SETTINGS = new Set(['channels', 'plugins', 'pluginSettingsMeta', 'lastChannel', 'theme']);
  var ENUMS = {
    pictureMode: [['standard', 'STANDARD'], ['vivid', 'VIVID'], ['cinema', 'CINEMA']],
    aspectMode: [['contain', 'STANDARD / SAFE'], ['stretch', 'STRETCH TO FILL'], ['fill', 'FILL / CROP']],
    'displayMode.aspect': [['16:9', '16:9 WIDESCREEN'], ['4:3', '4:3 CLASSIC'], ['auto', 'AUTO']],
    'displayMode.windowMode': [['letterbox', 'LETTERBOX'], ['lockWindow', 'LOCK WINDOW TO ASPECT']],
    'displayMode.resolution': [['native', 'NATIVE'], ['sd480', 'SD 480-LINE'], ['sd240', 'SD 240-LINE'], ['auto', 'AUTO']],
    'displayMode.autoPriority': [['metadata', 'FILE RESOLUTION FIRST'], ['era', 'ERA TAG FIRST']],
    'displayMode.uiExtent': [['confined', 'CONFINED TO CONTENT'], ['fullscreen', 'EXTEND BEYOND PILLARBOX']],
    'display.guideSlots': [['2', '2 / 1 HOUR'], ['3', '3 / 1.5 HOURS'], ['4', '4 / 2 HOURS']],
    'display.guideSlotMinutes': [['15', '15 MINUTES'], ['30', '30 MINUTES'], ['60', '1 HOUR']],
    'controls.tuneFadeInMs': [['0', 'OFF'], ['400', 'QUICK (0.4 SEC)'], ['900', 'SOFT (0.9 SEC)'], ['1800', 'SLOW (1.8 SEC)']],
    'display.uiScale': [['auto', 'AUTO (RECOMMENDED)'], ['100', '100%'], ['125', '125%'], ['150', '150%'], ['175', '175%'], ['200', '200%']],
    'display.logoBugMotion': [['none', 'NONE (STATIC)'], ['pulse', 'PULSE'], ['glow', 'GLOW'], ['slide-in', 'SLIDE IN ON TUNE']],
    'crtIntensity.overlayScope': [['video', 'VIDEO ONLY'], ['wholeScreen', 'WHOLE SCREEN']],
    'screensaver.variant': [['auto', 'AUTO (MATCH THEME)'], ['bounce', 'BOUNCING BRAND MARK'], ['testcard', 'TEST CARD'], ['standby', 'PLEASE STAND BY'], ['lineup', 'COMING UP TONIGHT'], ['diagnostics', 'SIGNAL DIAGNOSTICS']],
    'breakingNews.position': [['bottom', 'BOTTOM'], ['top', 'TOP'], ['center', 'CENTER']],
    'breakingNews.style': [['retro-lower-third', 'RETRO LOWER THIRD'], ['full-slate', 'SPECIAL REPORT SLATE'], ['ticker-flash', 'CABLE NEWS FLASH TICKER'], ['alien-report', 'ALIEN / SCI-FI BULLETIN']],
    'eas.signalDegradation.minSeverity': [['Minor', 'MINOR'], ['Moderate', 'MODERATE'], ['Severe', 'SEVERE'], ['Extreme', 'EXTREME']],
    'pluginSettings.cast-to-tv.mirrorQuality': [['1080p60', '1080P / 60 FPS'], ['4k60', '4K / 60 FPS'], ['720p30', '720P / 30 FPS']],
    'updates.strategy': [['startup-auto', 'INSTALL BEFORE APP OPENS'], ['background-auto', 'INSTALL WHEN APP QUITS'], ['background-notify', 'ASK WHEN READY'], ['manual', 'MANUAL'], ['off', 'OFF']],
  };

  // Explicit desktop control bounds, never infer units from the current
  // value (a count of 1 is not 100%, and CRT intensity 1 is only 1%).
  // Entries are [min, max, step, suffix, stored-value multiplier].
  var RANGES = {
    volume: [0, 100, 1, '%', 0.01], contentVolume: [0, 100, 1, '%', 0.01], adVolume: [0, 100, 1, '%', 0.01],
    'crtIntensity.scanlines': [0, 100, 1, '%', 1], 'crtIntensity.vignette': [0, 100, 1, '%', 1],
    'crtIntensity.grain': [0, 100, 1, '%', 1], 'crtIntensity.flicker': [0, 100, 1, '%', 1],
    'crtIntensity.curvature': [0, 100, 1, '%', 1], 'crtIntensity.burnIn': [0, 100, 1, '%', 1],
    'display.bezelInsetScale': [0, 200, 10, '%', 1],
    'display.guideOpenCloseAnimMs': [80, 400, 20, 'ms', 1],
    'display.guideCardDuration': [1000, 8000, 250, 'ms', 1],
    'display.hintBarShowDuration': [0, 1500, 50, 'ms', 1],
    'display.hintBarHideDuration': [0, 1500, 50, 'ms', 1],
    'staticEffect.intensity': [0, 100, 1, '%', 1], 'staticEffect.durationMs': [0, 1000, 50, 'ms', 1],
    'upNext.duration': [3000, 15000, 500, 'ms', 1], reminderLeadMinutes: [1, 30, 1, ' min', 1],
    'controls.entryDelayMs': [200, 3000, 100, 'ms', 1], 'controls.scanDwellSec': [2, 60, 1, ' sec', 1],
    'controls.volumeStepPct': [1, 25, 1, '%', 1], 'controls.volumeMaxPct': [10, 100, 5, '%', 1],
    'display.autoFillMaxCropPct': [2, 60, 1, '%', 1],
  };
  var LABELS = {
    'display.uiScale': 'TV INTERFACE SIZE', theme: 'TV THEME', controls: 'TUNING & CONTROLS',
    'controls.tuneFadeInMs': 'FADE IN AFTER TUNING', 'controls.sleepFadeOut': 'FADE OUT BEFORE SLEEP',
    'controls.entryDelayMs': 'CHANNEL NUMBER DELAY', 'controls.scanDwellSec': 'SCAN STAYS ON EACH CHANNEL',
    'controls.volumeStepPct': 'VOLUME STEP', 'controls.volumeMaxPct': 'MAXIMUM VOLUME',
    'display.guideSlotMinutes': 'GUIDE COLUMN LENGTH', 'display.autoFillWidescreen': 'FILL WIDESCREEN CONTENT',
    'display.removeBakedBars': 'REMOVE BAKED-IN BLACK BARS', 'display.logoBugFollowPicture': 'KEEP THE LOGO BUG ON THE PICTURE',
  };
  var localScale = document.getElementById('companion-ui-scale');
  function applyLocalScale(value) {
    value = ['100', '125', '150', '175', '200'].includes(value) ? value : '100';
    localScale.value = value;
    document.body.style.zoom = String(Number(value) / 100);
    document.documentElement.dataset.companionScale = value;
  }
  try { applyLocalScale(localStorage.getItem('reruntv.companion.uiScale')); } catch (e) { applyLocalScale('100'); }
  localScale.addEventListener('change', function () {
    applyLocalScale(localScale.value);
    try { localStorage.setItem('reruntv.companion.uiScale', localScale.value); } catch (e) { /* Private browsing may disable storage. */ }
  });
  // Scaling/wrapping changes the header height; keep the tab rail below it.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(function () {
      document.documentElement.style.setProperty('--companion-header-height', document.querySelector('.app-header').offsetHeight + 'px');
    }).observe(document.querySelector('.app-header'));
  }

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

  // A button carrying data-confirm interrupts whatever is on the TV, so it
  // asks first. Checked in both send paths below rather than inside
  // sendCommand, so a held repeat can never re-prompt mid-press.
  function confirmed(button) {
    var question = button.dataset.confirm;
    return !question || window.confirm(question);
  }

  document.addEventListener('pointerdown', function (event) {
    var button = event.target.closest('button[data-key]');
    if (!button || button.disabled) return;
    event.preventDefault();
    // Remembered so the click fallback below can tell a tap it already
    // handled from a real keyboard activation. Some browsers report
    // detail: 0 on the click a tap generates, which made every tap on those
    // send the command twice.
    lastPointerCommandAt = Date.now();
    if (!confirmed(button)) return;
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
    if (!button || event.detail !== 0) return;
    if (Date.now() - lastPointerCommandAt < 700) return; // the pointerdown above already sent it
    if (!confirmed(button)) return;
    sendCommand(button);
  });

  function activateTab(tab) {
    document.querySelectorAll('[data-tab]').forEach(function (item) {
      var on = item === tab;
      item.classList.toggle('active', on);
      item.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-panel]').forEach(function (panel) { panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab); });
    // The strip is wider than a phone, so the last tab sits off-screen with
    // no scrollbar to hint at it. Pulling the active one fully into view at
    // least makes its neighbours visible once you get there.
    if (tab.scrollIntoView) tab.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    if (tab.dataset.tab === 'settings' && !state.config) loadSettings();
    if ((tab.dataset.tab === 'channels' || tab.dataset.tab === 'guide') && !state.channels.length) loadChannels();
  }
  document.querySelectorAll('[data-tab]').forEach(function (tab) {
    tab.addEventListener('click', function () { activateTab(tab); });
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
    if (!quick.childElementCount) {
      // An empty state that can't be acted on is a dead end — send them to
      // the tab that fixes it rather than describing the fix.
      quick.replaceChildren();
      var blank = document.createElement('div'); blank.className = 'empty';
      blank.textContent = 'No quick channels yet. Mark a few with the ⚡ button and they appear here.';
      var goto = document.createElement('button'); goto.className = 'mini'; goto.textContent = 'OPEN LINEUP';
      goto.addEventListener('click', function () { activateTab(document.querySelector('[data-tab="channels"]')); });
      blank.appendChild(document.createElement('br'));
      blank.appendChild(goto);
      quick.appendChild(blank);
    }

    // GUIDE tab: what each channel is actually showing, which is the whole
    // point of a guide. `now`/`next` come from the box's own schedule
    // resolution (see pushCompanionLineup, app.js) — a box that hasn't
    // pushed a snapshot yet just shows the channel, same as before.
    var guideQuery = document.getElementById('guide-channel-search').value.trim().toLowerCase();
    var guide = document.getElementById('guide-channels');
    guide.replaceChildren();
    state.channels.filter(function (channel) { return channelMatches(channel, guideQuery); }).forEach(function (channel) {
      var row = document.createElement('button');
      row.className = 'guide-row' + (channel.number === state.watchingNumber ? ' is-watching' : '');
      var head = document.createElement('div'); head.className = 'guide-row-head';
      var num = document.createElement('b'); num.textContent = 'CH ' + channel.number;
      var name = document.createElement('span'); name.className = 'guide-row-name'; name.textContent = channel.name || 'Untitled';
      head.append(num, name);
      if (channel.favorite) { var star = document.createElement('i'); star.className = 'guide-row-star'; star.textContent = '★'; head.appendChild(star); }
      row.appendChild(head);
      var nowLine = document.createElement('div'); nowLine.className = 'guide-row-now';
      nowLine.textContent = channel.now || 'NO PROGRAMMING INFORMATION';
      if (!channel.now) nowLine.classList.add('is-unknown');
      row.appendChild(nowLine);
      if (channel.next) {
        var nextLine = document.createElement('div'); nextLine.className = 'guide-row-next';
        nextLine.textContent = (channel.endsAtMs ? 'UNTIL ' + clockOf(channel.endsAtMs) + ' · ' : '') + 'NEXT: ' + channel.next;
        row.appendChild(nextLine);
      }
      row.addEventListener('click', function () { tune(channel.number); });
      guide.appendChild(row);
    });
    if (!guide.childElementCount) guide.innerHTML = '<div class="empty">NO CHANNEL MATCHES THAT SEARCH.</div>';

    var query = document.getElementById('channel-search').value.trim().toLowerCase();
    var manager = document.getElementById('channel-manager'); manager.replaceChildren();
    state.channels.filter(function (channel) { return channelMatches(channel, query); }).forEach(function (channel) {
      var row = document.createElement('div'); row.className = 'channel-row';
      var main = document.createElement('button'); main.className = 'channel-main'; main.innerHTML = '<b>CH ' + channel.number + '</b><span></span>'; main.querySelector('span').textContent = channel.name || 'Untitled'; main.addEventListener('click', function () { tune(channel.number); });
      var actions = document.createElement('div'); actions.className = 'channel-actions';
      // Real buttons, not 18px checkboxes with 9px labels. These were the
      // only controls on the page under the 44px touch minimum every other
      // control already respected, and they are the tab's whole purpose.
      [['favorite', '★', 'Favorite'], ['quickAccess', '⚡', 'Quick-tap']].forEach(function (entry) {
        var toggle = document.createElement('button');
        toggle.className = 'flag-toggle';
        toggle.textContent = entry[1];
        toggle.setAttribute('aria-pressed', channel[entry[0]] ? 'true' : 'false');
        toggle.setAttribute('aria-label', entry[2] + ' — channel ' + channel.number);
        toggle.title = entry[2];
        toggle.classList.toggle('is-on', !!channel[entry[0]]);
        toggle.addEventListener('click', function () {
          var next = !channel[entry[0]];
          channel[entry[0]] = next;
          toggle.classList.toggle('is-on', next);
          toggle.setAttribute('aria-pressed', next ? 'true' : 'false');
          request('/channel/flag', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ number: channel.number, field: entry[0], value: next }) })
            .then(renderChannels).catch(function () { feedback('CHANNEL UPDATE FAILED', true); });
        });
        actions.appendChild(toggle);
      });
      row.append(main, actions); manager.appendChild(row);
    });
    if (!manager.childElementCount) manager.innerHTML = '<div class="empty">NO CHANNEL MATCHES THAT SEARCH.</div>';
  }

  function clockOf(ms) {
    try {
      return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toUpperCase();
    } catch (e) { return ''; }
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
    var dotted = path.join('.');
    var field = document.createElement('label'); field.className = 'field';
    field.dataset.search = (labelFor(key) + ' ' + (LABELS[dotted] || '') + ' ' + (HELP[dotted] || '') + ' ' + dotted).toLowerCase();
    var label = document.createElement('span'); label.textContent = LABELS[dotted] || labelFor(key); field.appendChild(label);
    return field;
  }
  // Appended after the control rather than inside fieldShell so it always
  // reads below the thing it describes, whichever control type was built.
  function withHelp(field, path) {
    var text = HELP[path.join('.')];
    if (!text) return field;
    var note = document.createElement('small'); note.className = 'field-help'; note.textContent = text;
    field.appendChild(note);
    return field;
  }

  function renderSetting(key, value, path) {
    var dotted = path.join('.');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      var details = document.createElement('details'); details.className = 'setting-object'; details.dataset.search = (labelFor(key) + ' ' + dotted).toLowerCase();
      var summary = document.createElement('summary'); summary.textContent = labelFor(key); var body = document.createElement('div'); body.className = 'settings-group-body';
      Object.keys(value).sort().forEach(function (childKey) { if (dotted === 'display' && childKey === 'uiScale') return; body.appendChild(renderSetting(childKey, value[childKey], path.concat(childKey))); });
      details.append(summary, body); return details;
    }
    var field = fieldShell(key, path);
    if (Array.isArray(value) && value.length && value.every(function (item) { return typeof item === 'string'; })) {
      // Simple text lists (headlines/tags/etc.) need no JSON knowledge.
      var items = value.slice(); var list = document.createElement('div'); list.className = 'setting-list';
      function drawList() {
        list.replaceChildren();
        items.forEach(function (item, index) {
          var row = document.createElement('div'); row.className = 'setting-list-row';
          var textInput = document.createElement('input'); textInput.value = item; textInput.setAttribute('aria-label', labelFor(key) + ' ' + (index + 1));
          textInput.addEventListener('change', function () { items[index] = textInput.value; setPatch(path, items.slice()); });
          var remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'REMOVE';
          remove.addEventListener('click', function () { items.splice(index, 1); setPatch(path, items.slice()); drawList(); });
          row.append(textInput, remove); list.appendChild(row);
        });
      }
      var add = document.createElement('button'); add.type = 'button'; add.textContent = '+ ADD ITEM';
      add.addEventListener('click', function () { items.push(''); setPatch(path, items.slice()); drawList(); list.lastElementChild.querySelector('input').focus(); });
      drawList(); field.append(list, add); return withHelp(field, path);
    }
    if (Array.isArray(value)) {
      field.classList.add('json-field'); var area = document.createElement('textarea'); area.value = JSON.stringify(value, null, 2); area.spellcheck = false;
      area.addEventListener('change', function () { try { var parsed = JSON.parse(area.value); if (!Array.isArray(parsed)) throw new Error(); field.classList.remove('invalid'); setPatch(path, parsed); } catch (e) { field.classList.add('invalid'); feedback('INVALID JSON LIST', true); } }); field.appendChild(area); return withHelp(field, path);
    }
    if (typeof value === 'boolean') {
      field.classList.add('checkbox'); field.replaceChildren(); var check = document.createElement('input'); check.type = 'checkbox'; check.checked = value; var text = document.createElement('span'); text.textContent = LABELS[dotted] || labelFor(key); check.addEventListener('change', function () { setPatch(path, check.checked); }); field.append(check, text); return withHelp(field, path);
    }
    var enumValues = dotted === 'theme' ? state.themes.map(function (theme) { return [theme.id, theme.label]; }) : ENUMS[dotted];
    if (enumValues) {
      // Preserve unknown/custom values until the user deliberately picks a
      // replacement. An empty catalog must not turn the theme into free text.
      if (!enumValues.some(function (entry) { return String(entry[0]) === String(value); })) enumValues = [[String(value), labelFor(value) + ' (CURRENT)']].concat(enumValues);
      var select = document.createElement('select'); enumValues.forEach(function (entry) { var option = document.createElement('option'); option.value = entry[0]; option.textContent = entry[1]; select.appendChild(option); }); select.value = String(value); select.addEventListener('change', function () { setPatch(path, typeof value === 'number' ? Number(select.value) : select.value); }); field.appendChild(select); return withHelp(field, path);
    }
    var bounds = RANGES[dotted];
    if (bounds && typeof value === 'number') {
      var wrap = document.createElement('div'); wrap.className = 'field-range';
      var range = document.createElement('input'); range.type = 'range'; range.min = String(bounds[0]); range.max = String(bounds[1]); range.step = String(bounds[2]); range.value = String(value / bounds[4]);
      var output = document.createElement('output'); output.textContent = String(Number((value / bounds[4]).toFixed(2))) + bounds[3];
      range.addEventListener('input', function () { output.textContent = range.value + bounds[3]; });
      range.addEventListener('change', function () { setPatch(path, Number((Number(range.value) * bounds[4]).toFixed(6))); });
      wrap.append(range, output); field.appendChild(wrap); return withHelp(field, path);
    }
    var input = document.createElement('input'); input.value = value == null ? '' : String(value); var sensitive = /(?:api.?key|token|secret|password|credential|auth)/i.test(key); input.type = sensitive ? 'password' : (typeof value === 'number' ? 'number' : 'text'); if (sensitive) input.placeholder = 'Current value hidden — enter a replacement'; if (typeof value === 'number') input.step = 'any'; input.addEventListener('change', function () { if (sensitive && !input.value) return; setPatch(path, typeof value === 'number' ? Number(input.value) : input.value); }); field.appendChild(input); return withHelp(field, path);
  }

  function renderSettings() {
    var editor = document.getElementById('settings-editor'); editor.replaceChildren();
    var appearance = document.createElement('details'); appearance.className = 'settings-group'; appearance.open = true;
    var heading = document.createElement('summary'); heading.textContent = 'TV APPEARANCE';
    var controls = document.createElement('div'); controls.className = 'settings-group-body';
    if (state.config.theme != null) controls.appendChild(renderSetting('theme', state.config.theme, ['theme']));
    if (state.config.display && state.config.display.uiScale != null) controls.appendChild(renderSetting('uiScale', state.config.display.uiScale, ['display', 'uiScale']));
    appearance.append(heading, controls); editor.appendChild(appearance);
    var known = new Set();
    GROUPS.forEach(function (group) { group[1].forEach(function (key) { known.add(key); }); });
    // Whatever the curated groups above don't claim — in practice the
    // config sections plugins and channel features add for themselves.
    // Sorted, because insertion order in the config file means nothing
    // to the person reading the list.
    var leftovers = Object.keys(state.config || {})
      .filter(function (key) { return !known.has(key) && !EXCLUDED_SETTINGS.has(key); })
      .sort();
    var groups = GROUPS.concat([['PLUGIN & CHANNEL FEATURES', leftovers]]);
    groups.forEach(function (group) {
      var keys = group[1].filter(function (key) { return state.config && Object.prototype.hasOwnProperty.call(state.config, key) && !EXCLUDED_SETTINGS.has(key); }); if (!keys.length) return;
      var details = document.createElement('details'); details.className = 'settings-group'; details.dataset.search = group[0].toLowerCase();
      var summary = document.createElement('summary'); summary.textContent = group[0] + ' · ' + keys.length; var body = document.createElement('div'); body.className = 'settings-group-body';
      keys.forEach(function (key) { body.appendChild(renderSetting(key, state.config[key], [key])); }); details.append(summary, body); editor.appendChild(details);
    });
    filterSettings();
  }

  function loadSettings() {
    var status = document.getElementById('settings-status');
    if (!state.awaitingSettingsResult) { status.className = 'notice'; status.textContent = 'Loading current settings…'; }
    return Promise.all([request('/api/config'), request('/api/themes').catch(function () { return []; })]).then(function (values) {
      state.config = values[0] || {}; state.themes = Array.isArray(values[1]) ? values[1] : []; state.pendingPatch = {}; renderSettings();
      // A reload runs right after a save, and the box's verdict on that save
      // lands a poll or so later — so this must not overwrite the one line
      // the user is actually waiting to read.
      if (!state.awaitingSettingsResult) {
        status.textContent = 'Choose settings below, then SAVE CHANGES. TV appearance applies to connected viewers. Advanced lists still use JSON editors.';
      }
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
      // Deliberately NOT "accepted" — all this response means is that the
      // box received the patch. What it actually did with it arrives in the
      // next /state poll (applySettingsResult), which then overwrites this
      // line with the truth, success or refusal.
      status.className = 'notice'; status.textContent = 'Sent to the box — waiting for it to confirm…';
      feedback('SETTINGS SENT');
      state.awaitingSettingsResult = true;
      // An older box (one whose renderer predates the reporting above) never
      // sends a verdict, so don't wait on it forever.
      clearTimeout(state.settingsResultTimer);
      state.settingsResultTimer = setTimeout(function () {
        if (!state.awaitingSettingsResult) return;
        state.awaitingSettingsResult = false;
        status.className = 'notice';
        status.textContent = 'Sent. This box does not report back what it applied — reload to see the current values.';
      }, 6000);
      setTimeout(loadSettings, 1200);
    }).catch(function (error) { button.disabled = false; button.textContent = 'RETRY SAVE'; status.className = 'notice error'; status.textContent = 'Could not reach the box: ' + error.message; });
  }

  function loadRoots() {
    var browser = document.getElementById('file-browser'); browser.innerHTML = '<div class="empty">LOADING FOLDERS…</div>';
    document.getElementById('file-search').hidden = true; // filters a folder's contents, not the root list
    state.fileRoot = null;
    request('/api/roots').then(function (roots) { browser.replaceChildren(); (roots || []).forEach(function (root) { var button = document.createElement('button'); button.className = 'root-button'; button.innerHTML = '<span>▣ ' + escapeHtml(root.label) + '</span><span>OPEN ›</span>'; button.addEventListener('click', function () { state.fileRoot = root; state.filePath = ''; loadFiles(); }); browser.appendChild(button); }); if (!browser.childElementCount) browser.innerHTML = '<div class="empty">NO LOCAL CHANNEL FOLDERS FOUND.</div>'; }).catch(function () { browser.innerHTML = '<div class="empty">FILES UNAVAILABLE.</div>'; });
  }

  function escapeHtml(value) { var span = document.createElement('span'); span.textContent = String(value || ''); return span.innerHTML; }
  // Human sizes and dates for the listing. The API has always returned
  // both; the browser used to render only the name, so you tapped DOWNLOAD
  // on a file without knowing whether it was 40MB or 4GB.
  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return (i === 0 ? bytes : bytes.toFixed(bytes < 10 ? 1 : 0)) + ' ' + units[i];
  }
  function formatDate(ms) {
    if (!Number.isFinite(ms)) return '';
    try { return new Date(ms).toLocaleDateString(); } catch (e) { return ''; }
  }

  function renderFiles() {
    var browser = document.getElementById('file-browser');
    var search = document.getElementById('file-search');
    var query = (search.value || '').trim().toLowerCase();
    browser.replaceChildren();

    var crumbs = document.createElement('div'); crumbs.className = 'breadcrumbs';
    var rootButton = document.createElement('button'); rootButton.className = 'mini'; rootButton.textContent = '‹ ROOTS';
    rootButton.addEventListener('click', loadRoots);
    crumbs.append(rootButton, document.createTextNode(state.fileRoot.label + (state.filePath ? ' / ' + state.filePath : '')));
    browser.appendChild(crumbs);

    if (state.filePath) {
      var up = document.createElement('button'); up.className = 'file-row'; up.textContent = '↰ PARENT FOLDER';
      up.addEventListener('click', function () { state.filePath = state.filePath.split('/').slice(0, -1).join('/'); loadFiles(); });
      browser.appendChild(up);
    }

    var shown = 0;
    state.fileEntries.forEach(function (entry) {
      if (query && entry.name.toLowerCase().indexOf(query) === -1) return;
      shown++;
      var rel = state.filePath ? state.filePath + '/' + entry.name : entry.name;
      var row = document.createElement('div'); row.className = 'file-row';
      var text = document.createElement('span'); text.className = 'file-text';
      var name = document.createElement('b'); name.textContent = (entry.isDir ? '▣ ' : '▤ ') + entry.name;
      text.appendChild(name);
      var meta = [entry.isDir ? 'FOLDER' : formatSize(entry.size), formatDate(entry.mtime)].filter(Boolean).join(' · ');
      if (meta) { var sub = document.createElement('small'); sub.textContent = meta; text.appendChild(sub); }
      row.appendChild(text);
      if (entry.isDir) {
        var open = document.createElement('button'); open.className = 'mini'; open.textContent = 'OPEN';
        open.addEventListener('click', function () { state.filePath = rel; loadFiles(); });
        row.appendChild(open);
      } else {
        var link = document.createElement('a'); link.textContent = 'DOWNLOAD';
        link.href = '/api/files/download?root=' + encodeURIComponent(state.fileRoot.id) + '&path=' + encodeURIComponent(rel);
        row.appendChild(link);
      }
      browser.appendChild(row);
    });
    if (!shown) {
      var none = document.createElement('div'); none.className = 'empty';
      none.textContent = query ? 'NOTHING IN THIS FOLDER MATCHES THAT.' : 'THIS FOLDER IS EMPTY.';
      browser.appendChild(none);
    }
    search.hidden = false;
  }

  function loadFiles() {
    var browser = document.getElementById('file-browser');
    var query = '?root=' + encodeURIComponent(state.fileRoot.id) + '&path=' + encodeURIComponent(state.filePath);
    browser.innerHTML = '<div class="empty">LOADING…</div>';
    request('/api/files' + query).then(function (result) {
      state.fileEntries = (result && result.entries) || [];
      renderFiles();
    }).catch(function () { browser.innerHTML = '<div class="empty">COULD NOT OPEN THIS FOLDER.</div>'; });
  }
  document.getElementById('file-search').addEventListener('input', function () {
    if (state.fileRoot) renderFiles();
  });

  document.addEventListener('click', function (event) {
    var button = event.target.closest('[data-action]'); if (!button) return;
    var action = button.dataset.action;
    if (action === 'watch-tv') request('/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'watch-tv' }) }).then(function () { feedback('RETURNED TO LIVE TV'); }).catch(function () { feedback('COULD NOT EXIT SETUP', true); });
    else if (action === 'refresh-channels') loadChannels();
    else if (action === 'reload-settings') loadSettings();
    else if (action === 'save-settings') saveSettings();
    else if (action === 'load-roots') loadRoots();
    else if (action === 'trigger-news') request('/news/trigger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ headline: document.getElementById('news-headline').value.trim() }) }).then(function () { feedback('NEWS ALERT TRIGGERED'); }).catch(function () { feedback('NEWS ALERT FAILED', true); });
    else if (action === 'trigger-trivia') request('/party/trivia/start', { method: 'POST' }).then(function () { feedback('TRIVIA TRIGGERED'); }).catch(function () { feedback('TRIVIA FAILED', true); });
    else if (action === 'ticker-on' || action === 'ticker-off') request('/ticker/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: document.getElementById('ticker-text').value, enabled: action === 'ticker-on' }) }).then(function () { feedback(action === 'ticker-on' ? 'TICKER ON' : 'TICKER OFF'); }).catch(function () { feedback('TICKER UPDATE FAILED', true); });
    else if (action === 'send-hotkey') { var key = document.getElementById('custom-hotkey').value; if (key) sendCommand({ dataset: { key: key }, textContent: key.toUpperCase() }); }
    else if (action === 'shutdown-pc') {
      // Asks on the phone (data-confirm); the box starts the countdown
      // without asking again, and the next /state poll shows it here.
      if (!confirmed(button)) return;
      request('/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'shutdown-pc' }) })
        .then(function (result) { applyPcShutdown(result && result.pcShutdown); feedback('SHUTTING DOWN THE PC'); })
        .catch(function (err) { feedback(/switched off/i.test(String(err && err.message)) ? 'NOT ALLOWED ON THE BOX' : 'COULD NOT SHUT DOWN', true); });
    } else if (action === 'cancel-pc-shutdown') {
      request('/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel-pc-shutdown' }) })
        .then(function (result) { applyPcShutdown(result && result.pcShutdown); feedback('SHUTDOWN CANCELLED'); })
        .catch(function () { feedback('COULD NOT CANCEL', true); });
    }
  });

  // ---------- PC shutdown countdown ----------
  // The box reports the countdown in every /state poll (pcShutdown: {
  // allowed, pending, at }). The notice counts down locally between polls
  // from the deadline, so it never looks frozen at a 1.5 s poll.
  var pcShutdown = { allowed: false, pending: false, at: null };
  var pcShutdownTimer = null;
  function renderPcShutdownCount() {
    var remaining = pcShutdown.pending && pcShutdown.at ? Math.max(0, Math.ceil((pcShutdown.at - Date.now()) / 1000)) : 0;
    document.getElementById('pc-shutdown-count').textContent = String(remaining);
  }
  function applyPcShutdown(status) {
    pcShutdown = status && typeof status === 'object' ? status : { allowed: false, pending: false, at: null };
    document.getElementById('pc-shutdown-actions').hidden = !pcShutdown.allowed;
    var notice = document.getElementById('pc-shutdown-notice');
    notice.hidden = !pcShutdown.pending;
    clearInterval(pcShutdownTimer); pcShutdownTimer = null;
    if (pcShutdown.pending) { renderPcShutdownCount(); pcShutdownTimer = setInterval(renderPcShutdownCount, 250); }
  }

  // ---------- Live box state -> the controls that change it ----------
  // The box reports mute, volume, CRT, picture/aspect/audio mode and the
  // time-machine slots in every /state poll, and none of it used to be
  // shown: MUTE was a coin flip, the four cycle buttons were pressed blind,
  // and the GO 1-4 buttons never said which slots had anything saved. All
  // of this is already arriving; it only ever needed to be rendered.
  var MODE_LABELS = {
    pictureMode: { standard: 'STANDARD', vivid: 'VIVID', cinema: 'CINEMA' },
    aspectMode: { contain: 'STANDARD', stretch: 'STRETCH', fill: 'FILL' },
    audioMode: { stereo: 'STEREO', sap: 'SAP', mono: 'MONO' },
  };
  function labelFrom(map, value) {
    if (value == null) return '';
    return (map && map[value]) || String(value).toUpperCase();
  }
  function setLiveText(name, text) {
    document.querySelectorAll('[data-live-text="' + name + '"]').forEach(function (node) {
      var slot = node.querySelector('.control-state');
      if (!slot) {
        slot = document.createElement('i');
        slot.className = 'control-state';
        node.appendChild(slot);
      }
      slot.textContent = text || '';
      node.classList.toggle('has-state', !!text);
    });
  }

  function applyBoxState(remoteState) {
    var muted = !!remoteState.muted;
    document.querySelectorAll('[data-live="muted"]').forEach(function (node) { node.classList.toggle('is-on', muted); });
    setLiveText('muted', muted ? 'MUTED' : '');

    var readout = document.getElementById('volume-readout');
    var fill = document.getElementById('volume-meter-fill');
    if (typeof remoteState.volume === 'number') {
      var percent = Math.round(Math.max(0, Math.min(1, remoteState.volume)) * 100);
      // A maximum volume below 100% (SETTINGS › Tuning & controls) is the end
      // of the meter, and is said so the phone doesn't look stuck short of full.
      var ceiling = typeof remoteState.volumeMax === 'number' && remoteState.volumeMax > 0 && remoteState.volumeMax < 1 ? remoteState.volumeMax : 1;
      readout.textContent = muted ? 'MUTED' : percent + '%' + (ceiling < 1 ? ' · MAX ' + Math.round(ceiling * 100) + '%' : '');
      readout.classList.toggle('is-muted', muted);
      fill.style.width = Math.min(100, Math.round((percent / (ceiling * 100)) * 100)) + '%';
    }

    // Recent channels: shown once there is somewhere to jump back to.
    var recentPanel = document.getElementById('recent-panel');
    var recentGrid = document.getElementById('recent-channels');
    var recent = Array.isArray(remoteState.recent) ? remoteState.recent : [];
    var recentKey = JSON.stringify(recent);
    if (recentGrid.dataset.key !== recentKey) {
      recentGrid.dataset.key = recentKey;
      recentGrid.replaceChildren();
      recent.forEach(function (channel) { recentGrid.appendChild(channelButton(channel)); });
    }
    recentPanel.hidden = !recent.length;

    setLiveText('pictureMode', labelFrom(MODE_LABELS.pictureMode, remoteState.pictureMode));
    setLiveText('aspectMode', labelFrom(MODE_LABELS.aspectMode, remoteState.aspectMode));
    setLiveText('audioMode', labelFrom(MODE_LABELS.audioMode, remoteState.audioMode));
    if (remoteState.crt != null) setLiveText('crt', remoteState.crt ? 'ON' : 'OFF');

    // A GO button for an empty slot does nothing on the box, so it says so
    // rather than looking identical to one that would jump somewhere.
    var slots = remoteState.quickJumpSlots || {};
    document.querySelectorAll('#jump-grid [data-slot]').forEach(function (button) {
      var filled = slots[button.dataset.slot] != null;
      button.disabled = !filled;
      button.title = filled ? 'Jump to saved point ' + button.dataset.slot : 'Nothing saved in slot ' + button.dataset.slot;
    });
  }

  // The settings route answers the instant it has relayed a patch — it can't
  // know what the box did with it. The box reports that here instead, so a
  // patch that was dropped (an unknown key, a section the companion isn't
  // allowed to write, a value of the wrong kind) stops being announced as a
  // success and then silently reverting on the next reload.
  function applySettingsResult(result) {
    if (!result || !result.at || result.at === lastSettingsResultAt) return;
    lastSettingsResultAt = result.at;
    state.awaitingSettingsResult = false;
    clearTimeout(state.settingsResultTimer);
    var status = document.getElementById('settings-status');
    var applied = result.applied || [];
    var rejected = result.rejected || [];
    if (!rejected.length) {
      status.className = 'notice success';
      status.textContent = applied.length
        ? 'Applied: ' + applied.join(', ') + '. Connected TVs have refreshed.'
        : 'Nothing changed — those values already matched the box.';
      return;
    }
    status.className = 'notice error';
    var reasons = rejected.map(function (item) { return item.section + ' (' + item.reason + ')'; }).join('; ');
    status.textContent = (applied.length ? 'Applied: ' + applied.join(', ') + '. ' : '')
      + 'The box refused ' + rejected.length + ': ' + reasons + '.';
    feedback('SOME SETTINGS REFUSED', true);
  }

  // "12 MIN LEFT · NEXT: TITLE · SLEEP 23:00" under the programme line. Times
  // are the box's clock when it pushed the state; minutes are good enough for
  // a 1.5 s poll, so a phone clock a little off doesn't matter.
  function applyNowDetail(remoteState) {
    var el = document.getElementById('now-detail');
    var parts = [];
    var now = Date.now();
    if (remoteState.number != null && remoteState.onAir !== 'break' && typeof remoteState.nowEndsAtMs === 'number' && remoteState.nowEndsAtMs > now) {
      parts.push(Math.max(1, Math.round((remoteState.nowEndsAtMs - now) / 60000)) + ' MIN LEFT');
    }
    if (remoteState.nextTitle) parts.push('NEXT: ' + String(remoteState.nextTitle).toUpperCase());
    if (typeof remoteState.sleepEndsAtMs === 'number' && remoteState.sleepEndsAtMs > now) {
      var secs = Math.round((remoteState.sleepEndsAtMs - now) / 1000);
      parts.push('SLEEP ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0'));
    }
    el.textContent = parts.join(' · ');
  }

  // The lamp in the header (every tab) and the now-playing card share one state.
  function setConnection(value) {
    document.getElementById('live-status').dataset.state = value;
    var header = document.getElementById('header-status');
    header.dataset.state = value;
    document.getElementById('header-status-text').textContent = value === 'online' ? 'ONLINE' : value === 'offline' ? 'NO SIGNAL' : 'CONNECTING';
  }

  // CHANNELS / KEYPAD / D-PAD: one card, one view at a time.
  document.querySelectorAll('[data-seg]').forEach(function (button) {
    button.addEventListener('click', function () {
      document.querySelectorAll('[data-seg]').forEach(function (other) {
        var on = other === button;
        other.classList.toggle('active', on);
        other.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('[data-seg-panel]').forEach(function (panel) {
        var on = panel.dataset.segPanel === button.dataset.seg;
        panel.hidden = !on;
        panel.classList.toggle('active', on);
      });
    });
  });

  function pollState() {
    request('/state').then(function (remoteState) {
      var watching = document.getElementById('now-watching');
      var program = document.getElementById('now-program');
      var live = document.getElementById('live-status');
      setConnection('online');
      remoteState = remoteState || {};
      state.watchingNumber = remoteState.number;
      document.getElementById('now-number').textContent = remoteState.number == null ? '--' : (Number.isInteger(remoteState.number) ? String(remoteState.number).padStart(2, '0') : String(remoteState.number));
      document.getElementById('skip-break').hidden = remoteState.onAir !== 'break';
      document.getElementById('channel-readout').textContent = remoteState.number == null ? '—' : 'CH ' + remoteState.number;
      if (remoteState.number != null) {
        var behind = remoteState.timeOffsetMin ? ' ' + (remoteState.timeOffsetMin < 0 ? '−' : '+') + Math.abs(remoteState.timeOffsetMin) + ' MIN' : '';
        var mode = remoteState.timeMachineOn ? (remoteState.shuttleDir < 0 ? ' · REW' : remoteState.shuttleDir > 0 ? ' · FF' : ' · TIME MACHINE') + behind : '';
        watching.textContent = 'CH ' + remoteState.number + (remoteState.name ? ' — ' + String(remoteState.name).toUpperCase() : '') + mode;
        // What is on this second, not just which channel. Deliberately says
        // "commercial break" during one rather than naming the show, which
        // would read as a stale remote.
        if (remoteState.onAir === 'break') {
          program.textContent = 'COMMERCIAL BREAK';
        } else {
          var row = (state.channels || []).find(function (c) { return c.number === remoteState.number; });
          program.textContent = (row && row.now) ? row.now.toUpperCase() : '';
        }
      } else {
        watching.textContent = remoteState.powered === false ? 'POWERED OFF' : 'NO SIGNAL';
        program.textContent = '';
      }
      applyNowDetail(remoteState);
      applyBoxState(remoteState);
      applySettingsResult(remoteState.settingsResult);
      applyPcShutdown(remoteState.pcShutdown);
    }).catch(function () {
      setConnection('offline');
      document.getElementById('now-number').textContent = '--';
      document.getElementById('skip-break').hidden = true;
      document.getElementById('now-watching').textContent = 'DISCONNECTED';
      document.getElementById('now-program').textContent = '';
    });
  }

  // The lineup carries what is on each channel, so it goes stale on its own
  // schedule rather than only when the user asks. Slow enough to be free.
  var LINEUP_REFRESH_MS = 60000;

  loadChannels(); pollState();
  setInterval(pollState, 1500);
  setInterval(function () { if (state.channels.length) loadChannels(); }, LINEUP_REFRESH_MS);
})();
