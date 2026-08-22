// Standalone remote-control page, plain script (no build step, no ES
// modules) — POSTs to the local server's /command endpoint, which relays
// straight into the app's existing keyboard handler via IPC (see
// handleKey, renderer/js/app.js).
(function () {
  var nowWatchingEl = document.getElementById('now-watching');

  // pointerdown, not click — click waits for the browser's touchend->click
  // synthesis (a real, ~300ms-class delay on mobile even with fast-tap CSS
  // in play), so a remote built on click always feels a beat behind a real
  // remote. pointerdown fires the instant a finger touches down. Guard
  // against the click that still follows by preventDefault()-ing here and
  // ignoring 'click' entirely below.
  document.querySelectorAll('.btn[data-key]').forEach(function (btn) {
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      sendCommand(btn.dataset.key, btn.dataset.shift === '1');
    });
  });
  // Some browsers need this to actually suppress the trailing synthetic
  // click/zoom gesture on a fast repeated tap.
  document.addEventListener('click', function (e) { e.preventDefault(); }, true);

  function sendCommand(key, shift) {
    // Fire-and-forget — the button's own :active CSS state is the feedback
    // the user sees instantly, regardless of how long the round trip to the
    // app actually takes. Awaiting the response before allowing another
    // tap would only add perceived lag for zero benefit (POST /command
    // always just returns 204).
    fetch('/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, shift: shift }),
    }).catch(function () {});
  }

  function pollState() {
    fetch('/state')
      .then(function (r) { return r.json(); })
      .then(function (state) {
        if (state && state.number != null) {
          nowWatchingEl.textContent = 'CH ' + state.number + (state.name ? ' — ' + state.name.toUpperCase() : '');
        } else {
          nowWatchingEl.textContent = 'NO SIGNAL';
        }
      })
      .catch(function () {
        nowWatchingEl.textContent = 'DISCONNECTED';
      });
  }

  pollState();
  setInterval(pollState, 2000);
})();
