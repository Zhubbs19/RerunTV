import { startTriviaRound } from './renderer.js';

function pad2(n) { return String(n).padStart(2, '0'); }

// ---------- Settings panel for the Party Channel plugin — join QR/URL,
// bulletin & soundboard, guest-engagement toggles (ticker/checkin/countdown/
// vote), caption contest capture, and the trivia question bank. ----------
function parsePositiveInt(str, fallback) {
  const n = parseInt(str, 10);
  return (Number.isFinite(n) && n > 0) ? n : fallback;
}
function toDatetimeLocalValue(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function renderTriviaQuestions(listEl, cfg, rerender) {
  listEl.innerHTML = '';
  (cfg.triviaQuestions || []).forEach((q, idx) => {
    const card = document.createElement('div');
    card.className = 'interstitial-card';
    card.style.padding = '10px';
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '6px';

    const qInput = document.createElement('textarea');
    qInput.className = 'title-row-input';
    qInput.style.width = '100%';
    qInput.style.resize = 'vertical';
    qInput.rows = 2;
    qInput.placeholder = 'Question…';
    qInput.value = q.question || '';
    qInput.addEventListener('input', () => { q.question = qInput.value; });
    card.appendChild(qInput);

    const optionsWrap = document.createElement('div');
    optionsWrap.style.display = 'grid';
    optionsWrap.style.gridTemplateColumns = '1fr 1fr';
    optionsWrap.style.gap = '6px';
    for (let i = 0; i < 4; i++) {
      const row = document.createElement('label');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '4px';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `trivia-correct-${idx}`;
      radio.checked = (q.correctIndex || 0) === i;
      radio.title = 'Correct answer';
      radio.addEventListener('change', () => { q.correctIndex = i; });
      const optInput = document.createElement('input');
      optInput.type = 'text';
      optInput.className = 'title-row-input';
      optInput.style.flex = '1';
      optInput.placeholder = `Option ${String.fromCharCode(65 + i)}`;
      optInput.value = (q.options && q.options[i]) || '';
      optInput.addEventListener('input', () => {
        if (!q.options) q.options = ['', '', '', ''];
        q.options[i] = optInput.value;
      });
      row.appendChild(radio);
      row.appendChild(optInput);
      optionsWrap.appendChild(row);
    }
    card.appendChild(optionsWrap);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn remove-btn';
    removeBtn.textContent = 'REMOVE QUESTION';
    removeBtn.addEventListener('click', () => {
      cfg.triviaQuestions.splice(idx, 1);
      rerender();
    });
    card.appendChild(removeBtn);

    listEl.appendChild(card);
  });
}

function renderJoinInfo(urlEl, qrEl, codeEl) {
  window.api.getPartyJoinInfo().then((info) => {
    if (!info || !info.url) {
      urlEl.textContent = 'Party LAN access is not active. Enable the channel and restart RerunTV, or connect the host to WiFi/ethernet.';
      codeEl.textContent = '--------';
      qrEl.classList.add('hidden');
      return;
    }
    urlEl.textContent = info.url;
    codeEl.textContent = info.pairingCode || '--------';
    if (info.qrDataUrl) {
      qrEl.src = info.qrDataUrl;
      qrEl.classList.remove('hidden');
    } else {
      qrEl.classList.add('hidden');
    }
  });
}

window.RCBPlugins.registerPluginSettings('party-channel', {
  sections: [{
    id: 'party-features',
    layout: 'two-column',
    render(container, ctx) {
    const cfg = ctx.S.config.party;

    container.innerHTML = `
      <label class="panel-toggle">
        <input type="checkbox" id="party-plugin-enabled">
        PARTY CHANNEL (CH 94)
      </label>
      <span class="panel-status">Guests can post photos/videos, announcements, votes, and more after opening the paired link. LAN access is off until this channel is enabled and RerunTV restarts.</span>
      <div class="party-join-box">
        <img data-el="join-qr" class="party-join-qr" alt="Scan to join the party page">
        <div class="party-join-details">
          <div class="party-join-url" data-el="join-url">—</div>
          <div class="party-join-code-label">PAIRING CODE</div>
          <div class="party-join-code" data-el="join-code">--------</div>
        </div>
        <button type="button" data-el="join-refresh-btn" class="btn">REFRESH</button>
      </div>
      <label class="panel-toggle" style="cursor:default; margin-top:16px;">BULLETIN &amp; SOUNDBOARD</label>
      <div class="panel-body">
        <button type="button" data-el="soundboard-btn" class="btn">CHOOSE SOUNDBOARD FOLDER</button>
        <button type="button" data-el="soundboard-clear-btn" class="btn remove-btn">CLEAR</button>
      </div>
      <div data-el="soundboard-status" class="panel-status">No soundboard folder assigned</div>
      <div class="panel-interval">
        IMAGE DURATION (SEC)
        <input type="number" data-el="image-duration-input" min="2" max="60" style="width:70px">
      </div>
      <div class="panel-interval">
        VIDEO MAX DURATION (SEC)
        <input type="number" data-el="video-duration-input" min="5" max="600" style="width:70px">
      </div>

      <label class="panel-toggle" style="cursor:default; margin-top:16px;">GUEST ENGAGEMENT</label>
      <div class="party-subgroup">
        <label class="panel-toggle">
          <input type="checkbox" data-el="feed-ticker-enabled">
          SCROLL GUEST CAPTIONS/ANNOUNCEMENTS INTO THE TICKER
        </label>
      </div>
      <div class="party-subgroup">
        <label class="panel-toggle">
          <input type="checkbox" data-el="checkin-enabled">
          CHECK-IN WALL (GUESTS ADD THEIR NAME, CHIME PLAYS)
        </label>
      </div>
      <div class="party-subgroup">
        <label class="panel-toggle">
          <input type="checkbox" data-el="countdown-enabled">
          COUNTDOWN (SHOWN ON THE IDLE SCREEN UNTIL A MOMENT YOU PICK)
        </label>
        <div class="panel-interval">
          COUNTS DOWN TO
          <input type="datetime-local" data-el="countdown-target-input" class="party-wide-input">
        </div>
        <div class="panel-interval">
          LABEL
          <input type="text" data-el="countdown-label-input" maxlength="40" placeholder="e.g. HAPPY NEW YEAR" class="party-wide-input">
        </div>
      </div>
      <div class="party-subgroup">
        <label class="panel-toggle">
          <input type="checkbox" data-el="vote-enabled">
          VOTE FOR NEXT CHANNEL (AMONG REMOTE QUICK-TAP CHANNELS)
        </label>
        <div class="panel-interval">
          VOTE WINDOW (SEC — 15 MINIMUM)
          <input type="number" data-el="vote-window-input" min="15" max="900" style="width:70px">
        </div>
      </div>

      <label class="panel-toggle" style="cursor:default; margin-top:16px;">CAPTION CONTEST</label>
      <div class="panel-body">
        <button type="button" data-el="caption-capture-btn" class="btn">&#128248; CAPTURE FRAME FOR CAPTION CONTEST</button>
      </div>
      <div data-el="caption-status" class="panel-status">No image captured yet — tune to a channel first, then capture.</div>

      <label class="panel-toggle" style="cursor:default; margin-top:16px;">TRIVIA QUESTION BANK</label>
      <div data-el="trivia-questions" class="titles-list"></div>
      <div class="panel-body">
        <button type="button" data-el="trivia-add-btn" class="btn">+ ADD QUESTION</button>
        <button type="button" data-el="trivia-start-btn" class="btn">&#9654; START TRIVIA ROUND NOW</button>
      </div>
    `;

    const q = (sel) => container.querySelector(`[data-el="${sel}"]`);
    const enabledEl = container.querySelector('#party-plugin-enabled');
    const joinUrlEl = q('join-url');
    const joinQrEl = q('join-qr');
    const joinCodeEl = q('join-code');
    const joinRefreshBtn = q('join-refresh-btn');
    const soundboardBtn = q('soundboard-btn');
    const soundboardClearBtn = q('soundboard-clear-btn');
    const soundboardStatusEl = q('soundboard-status');
    const imageDurationInputEl = q('image-duration-input');
    const videoDurationInputEl = q('video-duration-input');
    const feedTickerEnabledEl = q('feed-ticker-enabled');
    const checkinEnabledEl = q('checkin-enabled');
    const countdownEnabledEl = q('countdown-enabled');
    const countdownTargetInputEl = q('countdown-target-input');
    const countdownLabelInputEl = q('countdown-label-input');
    const voteEnabledEl = q('vote-enabled');
    const voteWindowInputEl = q('vote-window-input');
    const captionCaptureBtn = q('caption-capture-btn');
    const captionStatusEl = q('caption-status');
    const triviaQuestionsEl = q('trivia-questions');
    const triviaAddBtn = q('trivia-add-btn');
    const triviaStartBtn = q('trivia-start-btn');
    enabledEl.checked = !!cfg.enabled;
    imageDurationInputEl.value = cfg.imageDurationSec || 8;
    videoDurationInputEl.value = cfg.videoMaxDurationSec || 60;
    feedTickerEnabledEl.checked = !!cfg.feedTicker;
    checkinEnabledEl.checked = !!cfg.checkinEnabled;
    countdownEnabledEl.checked = !!cfg.countdown.enabled;
    countdownTargetInputEl.value = cfg.countdown.targetMs ? toDatetimeLocalValue(new Date(cfg.countdown.targetMs)) : '';
    countdownLabelInputEl.value = cfg.countdown.label || '';
    voteEnabledEl.checked = !!cfg.voteEnabled;
    voteWindowInputEl.value = cfg.voteWindowSec || 90;
    soundboardStatusEl.textContent = cfg.soundboardFolder ? `Folder: ${cfg.soundboardFolder}` : 'No soundboard folder assigned';

    const rerenderTrivia = () => renderTriviaQuestions(triviaQuestionsEl, cfg, rerenderTrivia);
    rerenderTrivia();
    renderJoinInfo(joinUrlEl, joinQrEl, joinCodeEl);

    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
      joinUrlEl.textContent = `${enabledEl.checked ? 'Party LAN access will start' : 'Party LAN access will stop'} after RerunTV restarts.`;
      joinCodeEl.textContent = '--------';
      joinQrEl.classList.add('hidden');
    });
    soundboardBtn.addEventListener('click', async () => {
      const folder = await window.api.selectFolder();
      if (!folder) return;
      cfg.soundboardFolder = folder;
      soundboardStatusEl.textContent = `Folder: ${folder}`;
      ctx.saveConfigDebounced();
    });
    soundboardClearBtn.addEventListener('click', () => {
      cfg.soundboardFolder = null;
      soundboardStatusEl.textContent = 'No soundboard folder assigned';
      ctx.saveConfigDebounced();
    });
    imageDurationInputEl.addEventListener('change', () => {
      cfg.imageDurationSec = parsePositiveInt(imageDurationInputEl.value, 8);
      ctx.saveConfigDebounced();
    });
    videoDurationInputEl.addEventListener('change', () => {
      cfg.videoMaxDurationSec = parsePositiveInt(videoDurationInputEl.value, 60);
      ctx.saveConfigDebounced();
    });
    feedTickerEnabledEl.addEventListener('change', () => {
      cfg.feedTicker = feedTickerEnabledEl.checked;
      if (window.applyTickerState) window.applyTickerState();
      ctx.saveConfigDebounced();
    });
    checkinEnabledEl.addEventListener('change', () => {
      cfg.checkinEnabled = checkinEnabledEl.checked;
      ctx.saveConfigDebounced();
    });
    countdownEnabledEl.addEventListener('change', () => {
      cfg.countdown.enabled = countdownEnabledEl.checked;
      ctx.saveConfigDebounced();
    });
    countdownTargetInputEl.addEventListener('change', () => {
      const ms = countdownTargetInputEl.value ? new Date(countdownTargetInputEl.value).getTime() : null;
      cfg.countdown.targetMs = Number.isFinite(ms) ? ms : null;
      ctx.saveConfigDebounced();
    });
    countdownLabelInputEl.addEventListener('input', () => {
      cfg.countdown.label = countdownLabelInputEl.value;
      ctx.saveConfigDebounced();
    });
    voteEnabledEl.addEventListener('change', () => {
      cfg.voteEnabled = voteEnabledEl.checked;
      ctx.saveConfigDebounced();
    });
    voteWindowInputEl.addEventListener('change', () => {
      cfg.voteWindowSec = parsePositiveInt(voteWindowInputEl.value, 90);
      ctx.saveConfigDebounced();
    });
    captionCaptureBtn.addEventListener('click', async () => {
      let filePath = null;
      try {
        filePath = decodeURIComponent(new URL(ctx.player.currentSrc).searchParams.get('p') || '');
      } catch (e) { /* not an app://media URL — filePath stays null */ }
      if (!filePath) {
        window.alertDialog('Nothing to capture — tune to a channel with video playing, then open Setup and try again.');
        return;
      }
      captionStatusEl.textContent = 'Capturing…';
      const savedPath = await window.api.captureVideoFrame(filePath, ctx.player.currentTime);
      if (!savedPath) {
        captionStatusEl.textContent = 'Capture failed — try again.';
        return;
      }
      ctx.S.partyCaptionImagePath = savedPath;
      captionStatusEl.textContent = `Captured! Guests can now submit captions for it on the party page — captured ${new Date().toLocaleTimeString()}.`;
    });
    triviaAddBtn.addEventListener('click', () => {
      cfg.triviaQuestions.push({ question: '', options: ['', '', '', ''], correctIndex: 0 });
      rerenderTrivia();
    });
    triviaStartBtn.addEventListener('click', () => startTriviaRound());
    joinRefreshBtn.addEventListener('click', () => renderJoinInfo(joinUrlEl, joinQrEl, joinCodeEl));
    },
  }],
});
