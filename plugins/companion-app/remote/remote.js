// Standalone remote-control page, plain script (no build step, no ES
// modules) — POSTs to the local server's /command endpoint, which relays
// straight into the app's existing keyboard handler via IPC (see
// handleKey, renderer/js/app.js).
(function () {
  var nowWatchingEl = document.getElementById('now-watching');
  var commandFeedbackEl = document.getElementById('command-feedback');
  var feedbackTimer = null;

  // pointerdown, not click — click waits for the browser's touchend->click
  // synthesis (a real, ~300ms-class delay on mobile even with fast-tap CSS
  // in play), so a remote built on click always feels a beat behind a real
  // remote. pointerdown fires the instant a finger touches down. Guard
  // against the click that still follows by preventDefault()-ing here and
  // ignoring 'click' entirely below.
  document.querySelectorAll('.btn[data-key]').forEach(function (btn) {
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      sendCommand(btn.dataset.key, btn.dataset.shift === '1', btn.textContent.trim(), btn.dataset.ctrl === '1', btn.dataset.alt === '1');
    });
    // Keyboard/switch-control activation emits a click with detail 0 and no
    // pointerdown. Preserve that accessible path without double-sending a
    // normal touch/mouse activation.
    btn.addEventListener('click', function (e) {
      if (e.detail === 0) sendCommand(btn.dataset.key, btn.dataset.shift === '1', btn.textContent.trim(), btn.dataset.ctrl === '1', btn.dataset.alt === '1');
    });
  });

  function sendCommand(key, shift, label, ctrl, alt) {
    // Fire-and-forget — the button's own :active CSS state is the feedback
    // the user sees instantly, regardless of how long the round trip to the
    // app actually takes. Awaiting the response before allowing another
    // tap would only add perceived lag for zero benefit (POST /command
    // always just returns 204).
    commandFeedbackEl.textContent = label + ' SENT';
    commandFeedbackEl.classList.remove('error');
    commandFeedbackEl.classList.add('show');
    clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(function () { commandFeedbackEl.classList.remove('show'); }, 900);
    fetch('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, shift: shift, ctrl: !!ctrl, alt: !!alt }),
    }).catch(function () {
      commandFeedbackEl.textContent = 'REMOTE DISCONNECTED';
      commandFeedbackEl.classList.add('show', 'error');
    });
  }

  function loadQuickChannels() {
    var grid = document.getElementById('quick-channels');
    fetch('/channels')
      .then(function (r) { return r.json(); })
      .then(function (channels) {
        var quick = Array.isArray(channels) ? channels.filter(function (channel) { return channel.quickAccess; }) : [];
        grid.innerHTML = '';
        if (!quick.length) {
          grid.innerHTML = '<div class="remote-note">NO CHANNELS MARKED REMOTE QUICK-TAP</div>';
          return;
        }
        quick.forEach(function (channel) {
          var btn = document.createElement('button');
          btn.className = 'btn quick-channel';
          btn.textContent = 'CH ' + channel.number + (channel.name ? '\n' + String(channel.name).toUpperCase() : '');
          function tuneChannel() {
            commandFeedbackEl.textContent = 'CH ' + channel.number + ' SENT';
            commandFeedbackEl.classList.remove('error');
            commandFeedbackEl.classList.add('show');
            clearTimeout(feedbackTimer);
            feedbackTimer = setTimeout(function () { commandFeedbackEl.classList.remove('show'); }, 900);
            fetch('/tune', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ number: channel.number }),
            }).catch(function () {
              commandFeedbackEl.textContent = 'REMOTE DISCONNECTED';
              commandFeedbackEl.classList.add('show', 'error');
            });
          }
          btn.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            tuneChannel();
          });
          btn.addEventListener('click', function (e) { if (e.detail === 0) tuneChannel(); });
          grid.appendChild(btn);
        });
      })
      .catch(function () { grid.innerHTML = '<div class="remote-note">QUICK CHANNELS UNAVAILABLE</div>'; });
  }

  function pollState() {
    fetch('/state')
      .then(function (r) { return r.json(); })
      .then(function (state) {
        if (state && state.number != null) {
          var mode = state.timeMachineOn ? (state.shuttleDir < 0 ? ' • REW' : state.shuttleDir > 0 ? ' • FF' : ' • TIME MACHINE') : '';
          nowWatchingEl.textContent = 'CH ' + state.number + (state.name ? ' — ' + state.name.toUpperCase() : '') + mode;
        } else {
          nowWatchingEl.textContent = 'NO SIGNAL';
        }
      })
      .catch(function () {
        nowWatchingEl.textContent = 'DISCONNECTED';
      });
  }

  loadQuickChannels();
  pollState();
  setInterval(pollState, 2000);
})();
