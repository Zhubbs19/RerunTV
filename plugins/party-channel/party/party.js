// Standalone guest page, plain script (no build step, no ES modules) —
// mirrors remote/remote.js's approach exactly, just talking to main.js's
// party server (POST /post, POST /announce, GET/POST /soundboard*, GET
// /queue) instead of /command.
(function () {
  var queueStatusEl = document.getElementById('queue-status');
  var activityPickerEl = document.getElementById('activity-picker');

  // Trivia question/option text is host-authored (setup screen), but this
  // page builds its trivia markup via innerHTML — escape it before
  // interpolating so a config imported from an untrusted file (EXPORT/IMPORT
  // CONFIG supports this) can't inject markup into the guest-facing page.
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- Tabs ----------
  function selectActivity(tabName, focusPanel) {
      var btn = document.querySelector('.tab-btn[data-tab="' + tabName + '"]');
      if (!btn) return;
      document.querySelectorAll('.tab-btn').forEach(function (b) {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
        b.tabIndex = -1;
      });
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.add('hidden'); p.hidden = true; });
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      btn.tabIndex = 0;
      var panel = document.getElementById('panel-' + btn.dataset.tab);
      panel.classList.remove('hidden');
      panel.hidden = false;
      activityPickerEl.value = btn.dataset.tab;
      if (btn.dataset.tab === 'soundboard') loadSoundboard();
      if (btn.dataset.tab === 'vote') loadVoteOptions();
      if (btn.dataset.tab === 'caption') loadCaptionImage();
      clearInterval(triviaPollTimer);
      triviaPollTimer = null;
      if (btn.dataset.tab === 'trivia') {
        pollTrivia();
        triviaPollTimer = setInterval(pollTrivia, 2000);
      }
      if (focusPanel) panel.focus();
  }

  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    var panel = document.getElementById('panel-' + btn.dataset.tab);
    btn.id = 'tab-' + btn.dataset.tab;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-controls', panel.id);
    btn.setAttribute('aria-selected', btn.classList.contains('active') ? 'true' : 'false');
    btn.tabIndex = btn.classList.contains('active') ? 0 : -1;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', btn.id);
    panel.tabIndex = -1;
    panel.hidden = panel.classList.contains('hidden');
    btn.addEventListener('click', function () {
      selectActivity(btn.dataset.tab, false);
    });
    btn.addEventListener('keydown', function (event) {
      var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab-btn:not(.hidden)'));
      var index = tabs.indexOf(btn);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault();
      selectActivity(tabs[index].dataset.tab, false);
      tabs[index].focus();
    });
  });
  activityPickerEl.addEventListener('change', function () { selectActivity(activityPickerEl.value, true); });
  document.querySelectorAll('.status-msg').forEach(function (el) { el.setAttribute('aria-live', 'polite'); });

  // ---------- Queue status (polled) ----------
  function pollQueue() {
    fetch('/queue').then(function (r) { return r.json(); }).then(function (q) {
      if (q.current) {
        var kindLabel = q.current.kind === 'announce' ? 'Announcement playing'
          : q.current.kind === 'video' ? 'Video playing' : 'Photo showing';
        queueStatusEl.textContent = kindLabel + (q.queueLength ? ' · ' + q.queueLength + ' more waiting' : '');
      } else if (q.queueLength) {
        queueStatusEl.textContent = q.queueLength + ' post(s) waiting to show';
      } else {
        queueStatusEl.textContent = 'Nothing queued yet — be the first!';
      }
    }).catch(function () {
      queueStatusEl.textContent = 'Can’t reach the party channel right now';
    });
  }
  pollQueue();
  setInterval(pollQueue, 3000);

  // ---------- Watch Live link (cross-link to the LAN viewer) ----------
  // One-shot, not polled — the host's LAN addresses don't change mid-party.
  // Picks the first URL rather than listing every adapter (a guest just
  // wants one link that works, not a choice between WiFi/Ethernet like the
  // host sees in setup).
  var watchLiveLink = document.getElementById('watch-live-link');
  fetch('/viewer-url').then(function (r) { return r.json(); }).then(function (data) {
    if (data.urls && data.urls.length) {
      watchLiveLink.href = data.urls[0].url;
      watchLiveLink.classList.remove('hidden');
    }
  }).catch(function () {});

  // ---------- BULLETIN ----------
  var fileInput = document.getElementById('bulletin-file');
  var filePickerLabel = document.getElementById('file-picker-label');
  var filePickerText = document.getElementById('file-picker-text');
  var bulletinForm = document.getElementById('bulletin-form');
  var bulletinSubmit = document.getElementById('bulletin-submit');
  var bulletinStatus = document.getElementById('bulletin-status');

  fileInput.addEventListener('change', function () {
    var file = fileInput.files[0];
    if (file) {
      filePickerText.textContent = '✅ ' + file.name;
      filePickerLabel.classList.add('has-file');
      bulletinSubmit.disabled = false;
    } else {
      filePickerText.textContent = '📷 CHOOSE OR TAKE A PHOTO/VIDEO';
      filePickerLabel.classList.remove('has-file');
      bulletinSubmit.disabled = true;
    }
  });

  bulletinForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var file = fileInput.files[0];
    if (!file) return;
    bulletinSubmit.disabled = true;
    bulletinStatus.textContent = 'Uploading…';
    bulletinStatus.className = 'status-msg';

    var data = new FormData();
    data.append('file', file);
    data.append('caption', document.getElementById('bulletin-caption').value);

    fetch('/post', { method: 'POST', body: data }).then(function (r) {
      if (!r.ok) throw new Error('Upload failed');
      bulletinStatus.textContent = 'Posted! It’ll show up on the party channel soon.';
      bulletinStatus.className = 'status-msg ok';
      bulletinForm.reset();
      filePickerText.textContent = '📷 CHOOSE OR TAKE A PHOTO/VIDEO';
      filePickerLabel.classList.remove('has-file');
      pollQueue();
    }).catch(function () {
      bulletinStatus.textContent = 'Couldn’t post that — try again?';
      bulletinStatus.className = 'status-msg err';
      bulletinSubmit.disabled = false;
    });
  });

  // ---------- ANNOUNCE ----------
  var announceText = document.getElementById('announce-text');
  var announceSubmit = document.getElementById('announce-submit');
  var announceStatus = document.getElementById('announce-status');

  announceText.addEventListener('input', function () {
    announceSubmit.disabled = !announceText.value.trim();
  });

  announceSubmit.addEventListener('click', function () {
    var text = announceText.value.trim();
    if (!text) return;
    announceSubmit.disabled = true;
    announceStatus.textContent = 'Sending…';
    announceStatus.className = 'status-msg';

    fetch('/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    }).then(function (r) {
      if (!r.ok) throw new Error('Failed');
      announceStatus.textContent = 'Announced!';
      announceStatus.className = 'status-msg ok';
      announceText.value = '';
      pollQueue();
    }).catch(function () {
      announceStatus.textContent = 'Couldn’t send that — try again?';
      announceStatus.className = 'status-msg err';
      announceSubmit.disabled = false;
    });
  });

  // ---------- BREAKING NEWS ----------
  var newsText = document.getElementById('news-text');
  var newsSubmit = document.getElementById('news-submit');
  var newsStatus = document.getElementById('news-status');

  newsSubmit.addEventListener('click', function () {
    newsSubmit.disabled = true;
    newsStatus.textContent = 'Broadcasting alert…';
    newsStatus.className = 'status-msg';

    fetch('/news', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: newsText.value.trim() }),
    }).then(function (r) {
      if (!r.ok) throw new Error('Failed');
      newsStatus.textContent = '🚨 Breaking News Broadcasted to TV!';
      newsStatus.className = 'status-msg ok';
      newsText.value = '';
      setTimeout(function () {
        newsSubmit.disabled = false;
        newsStatus.textContent = '';
      }, 3000);
    }).catch(function () {
      newsStatus.textContent = 'Couldn’t broadcast news alert — try again.';
      newsStatus.className = 'status-msg err';
      newsSubmit.disabled = false;
    });
  });

  // ---------- BINGO ----------
  var bingoSubmitBtn = document.getElementById('bingo-submit-btn');
  var bingoStatus = document.getElementById('bingo-status');
  document.querySelectorAll('.bingo-tile').forEach(function (tile) {
    tile.addEventListener('click', function () {
      tile.classList.toggle('active');
    });
  });

  if (bingoSubmitBtn) {
    bingoSubmitBtn.addEventListener('click', function () {
      bingoSubmitBtn.disabled = true;
      bingoStatus.textContent = 'Shouting BINGO to the TV…';
      bingoStatus.className = 'status-msg';

      fetch('/bingo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Party Guest' })
      }).then(function (r) {
        if (!r.ok) throw new Error('Failed');
        bingoStatus.textContent = '🎉 BINGO BROADCASTED TO TV!';
        bingoStatus.className = 'status-msg ok';
        setTimeout(function () {
          bingoSubmitBtn.disabled = false;
          bingoStatus.textContent = '';
        }, 4000);
      }).catch(function () {
        bingoStatus.textContent = 'Couldn’t send Bingo — try again.';
        bingoStatus.className = 'status-msg err';
        bingoSubmitBtn.disabled = false;
      });
    });
  }

  // ---------- TRIVIA ----------
  var triviaBody = document.getElementById('trivia-body');
  var triviaPollTimer = null;
  var answeredForQuestion = null; // guards against double-submitting the same round

  function renderTriviaState(data) {
    if (!data.active) {
      triviaBody.innerHTML = '<div class="status-msg">No trivia round right now — check back soon!</div>';
      return;
    }
    if (data.revealed) {
      var totalVotes = data.votes.reduce(function (a, b) { return a + b; }, 0) || 1;
      var html = '<div class="hint">' + escapeHtml(data.question) + '</div>';
      data.options.forEach(function (opt, i) {
        var pct = Math.round((data.votes[i] / totalVotes) * 100);
        var isCorrect = i === data.correctIndex;
        html += '<div class="status-msg' + (isCorrect ? ' ok' : '') + '">'
          + (isCorrect ? '✅ ' : '') + escapeHtml(opt) + ' — ' + pct + '%</div>';
      });
      triviaBody.innerHTML = html;
      return;
    }
    var alreadyAnswered = answeredForQuestion === data.question;
    var body = '<div class="hint">' + escapeHtml(data.question) + '</div><div class="soundboard-grid" id="trivia-options-grid"></div>';
    if (alreadyAnswered) body += '<div class="status-msg ok">Answer submitted — waiting for reveal…</div>';
    triviaBody.innerHTML = body;
    if (alreadyAnswered) return;
    var grid = document.getElementById('trivia-options-grid');
    data.options.forEach(function (opt, i) {
      var btn = document.createElement('button');
      btn.className = 'sound-btn';
      btn.textContent = String.fromCharCode(65 + i) + '. ' + opt;
      btn.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        answeredForQuestion = data.question;
        fetch('/trivia/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: i }),
        }).then(pollTrivia).catch(function () {});
      });
      grid.appendChild(btn);
    });
  }

  function pollTrivia() {
    fetch('/trivia').then(function (r) { return r.json(); }).then(renderTriviaState).catch(function () {});
  }

  // ---------- CAPTION CONTEST ----------
  var captionImage = document.getElementById('caption-image');
  var captionImageEmpty = document.getElementById('caption-image-empty');
  var captionText = document.getElementById('caption-text');
  var captionSubmit = document.getElementById('caption-submit');
  var captionStatus = document.getElementById('caption-status');

  function loadCaptionImage() {
    fetch('/caption').then(function (r) { return r.json(); }).then(function (data) {
      if (data.hasImage) {
        captionImage.src = '/caption/image?t=' + Date.now();
        captionImage.classList.remove('hidden');
        captionImageEmpty.classList.add('hidden');
      } else {
        captionImage.classList.add('hidden');
        captionImageEmpty.classList.remove('hidden');
      }
    }).catch(function () {});
  }

  captionText.addEventListener('input', function () {
    captionSubmit.disabled = !captionText.value.trim();
  });
  captionSubmit.addEventListener('click', function () {
    var text = captionText.value.trim();
    if (!text) return;
    captionSubmit.disabled = true;
    fetch('/caption', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    }).then(function (r) {
      if (!r.ok) throw new Error('Failed');
      captionStatus.textContent = 'Submitted! Watch the party channel.';
      captionStatus.className = 'status-msg ok';
      captionText.value = '';
    }).catch(function () {
      captionStatus.textContent = 'Couldn’t submit — is there an image yet?';
      captionStatus.className = 'status-msg err';
      captionSubmit.disabled = false;
    });
  });

  // ---------- VOTE ----------
  var voteGrid = document.getElementById('vote-grid');

  function loadVoteOptions() {
    fetch('/vote').then(function (r) { return r.json(); }).then(function (data) {
      var options = data.options || [];
      voteGrid.innerHTML = '';
      if (!options.length) {
        var msg = document.createElement('div');
        msg.className = 'status-msg';
        msg.textContent = 'No channels set up for voting yet — ask the host to tag some as REMOTE QUICK-TAP.';
        voteGrid.appendChild(msg);
        return;
      }
      options.forEach(function (opt) {
        var btn = document.createElement('button');
        btn.className = 'sound-btn';
        btn.textContent = 'CH ' + opt.number + (opt.name ? '\n' + opt.name.toUpperCase() : '') + '\n(' + opt.votes + ' votes)';
        btn.style.whiteSpace = 'pre-line';
        btn.addEventListener('pointerdown', function (e) {
          e.preventDefault();
          fetch('/vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ number: opt.number }),
          }).then(function () { loadVoteOptions(); }).catch(function () {});
        });
        voteGrid.appendChild(btn);
      });
    }).catch(function () {
      voteGrid.innerHTML = '<div class="status-msg err">Couldn’t load voting options.</div>';
    });
  }

  // ---------- CHECK IN ----------
  var checkinName = document.getElementById('checkin-name');
  var checkinSubmit = document.getElementById('checkin-submit');
  var checkinStatus = document.getElementById('checkin-status');

  checkinName.addEventListener('input', function () {
    checkinSubmit.disabled = !checkinName.value.trim();
  });
  checkinSubmit.addEventListener('click', function () {
    var name = checkinName.value.trim();
    if (!name) return;
    checkinSubmit.disabled = true;
    fetch('/checkin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name }),
    }).then(function (r) {
      if (!r.ok) throw new Error('Failed');
      checkinStatus.textContent = 'You’re on the wall!';
      checkinStatus.className = 'status-msg ok';
      checkinName.value = '';
    }).catch(function () {
      checkinStatus.textContent = 'Couldn’t check in — try again?';
      checkinStatus.className = 'status-msg err';
      checkinSubmit.disabled = false;
    });
  });

  // ---------- EFFECTS ----------
  document.querySelectorAll('.effect-btn').forEach(function (btn) {
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      fetch('/effect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: btn.dataset.effect }),
      }).catch(function () {});
    });
  });

  // ---------- REACTIONS ----------
  document.querySelectorAll('.reaction-btn').forEach(function (btn) {
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      fetch('/reaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji: btn.dataset.emoji }),
      }).catch(function () {});
    });
  });

  // ---------- SOUNDBOARD ----------
  var soundboardGrid = document.getElementById('soundboard-grid');
  var soundboardLoaded = false;

  function loadSoundboard() {
    if (soundboardLoaded) return;
    fetch('/soundboard').then(function (r) { return r.json(); }).then(function (sounds) {
      soundboardLoaded = true;
      soundboardGrid.innerHTML = '';
      if (!sounds.length) {
        var msg = document.createElement('div');
        msg.className = 'status-msg';
        msg.textContent = 'No sounds set up yet — ask the host to add a soundboard folder in Setup.';
        soundboardGrid.appendChild(msg);
        return;
      }
      sounds.forEach(function (s) {
        var btn = document.createElement('button');
        btn.className = 'sound-btn';
        btn.textContent = s.label;
        btn.addEventListener('pointerdown', function (e) {
          e.preventDefault();
          fetch('/soundboard/play', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: s.id }),
          }).catch(function () {});
        });
        soundboardGrid.appendChild(btn);
      });
    }).catch(function () {
      soundboardGrid.innerHTML = '<div class="status-msg err">Couldn’t load the soundboard.</div>';
    });
  }

})();
