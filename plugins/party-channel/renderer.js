// Party Channel plugin — CH 94, the interactive party/bulletin channel.
// Guests post photos, videos, and text-to-speech announcements from the LAN
// party page (party/, served by this plugin's main.js) and this file owns
// the runtime queue (S.partyQueue/S.partyCurrentItem), renders whatever's
// currently up on screen via registerChannelType, and owns the settings
// panel. Full-ownership plugin (registered channel + settings, same as
// every other migrated channel) — the LAN server is main.js's concern.
//
// This still reaches into the box's own pre-existing #party-channel markup
// (index.html) rather than building into the container registerChannelType
// hands render() — that markup is sizeable (idle/active/vote/checkin/
// trivia/countdown cards) and moving it into JS-built DOM is a separate,
// larger effort than the channel-ownership migration this covers. Querying
// core-owned elements directly is an established, documented pattern for
// plugins (see PLUGIN_DEVELOPMENT.md) — it's only cross-origin `import` of
// core JS that's off-limits, not DOM access.
const PARTY_CH = 94;

// This plugin's own config namespace, seeded here (not by core) the same
// way every other plugin with real config seeds its own — see
// [[retro_cable_box_plugin_system]]. soundboardFolder is scanned
// server-side (main.js has no renderer-driven folder scan for it, unlike
// channel folders) since the LAN party page's GET /soundboard needs the
// list without a renderer round-trip.
if (!S.config.party) {
  S.config.party = { enabled: false, soundboardFolder: null, imageDurationSec: 8, videoMaxDurationSec: 60 };
}
if (S.config.party.imageDurationSec == null) S.config.party.imageDurationSec = 8;
if (S.config.party.videoMaxDurationSec == null) S.config.party.videoMaxDurationSec = 60;
// Guest captions/announcements scrolling into the box-wide ticker bar — see
// plugins/ticker's applyTickerState.
if (S.config.party.feedTicker == null) S.config.party.feedTicker = false;
// Vote-for-next-channel, shown on this channel's idle screen.
if (S.config.party.voteEnabled == null) S.config.party.voteEnabled = false;
if (S.config.party.voteWindowSec == null) S.config.party.voteWindowSec = 90;
// Countdown/hype display on this channel's idle screen.
if (!S.config.party.countdown) S.config.party.countdown = { enabled: false, targetMs: null, label: '' };
// Check-in wall (guest name list + chime) on this channel's idle screen.
if (S.config.party.checkinEnabled == null) S.config.party.checkinEnabled = false;
// Live trivia question bank — each {question, options: [4 strings], correctIndex}.
if (!S.config.party.triviaQuestions) S.config.party.triviaQuestions = [];

// This plugin's own runtime state on the shared S object — used to be
// declared in core state.js even though core never reads any of it. Ephemeral,
// never persisted — guest-submitted content only lasts the session, same as
// a real party's decorations. Each queue item:
// {id, kind:'image'|'video'|'announce', path/text, caption, postedAt}.
// Announcements are unshifted to the front (see enqueuePartyItem below) so a
// time-sensitive "pizza's here!" doesn't wait behind a long video queue.
if (S.partyQueue === undefined) S.partyQueue = [];
if (S.partyCurrentItem === undefined) S.partyCurrentItem = null;
if (S.partyItemTimer === undefined) S.partyItemTimer = null;
// Rotating buffer of recent guest captions/announcements, most recent
// first, shown in the box-wide ticker bar when config.party.feedTicker is
// on (see pushToTickerFeed below) — capped, not a full history.
if (S.partyTickerFeed === undefined) S.partyTickerFeed = [];
// ---------- Vote / countdown / check-in / trivia / caption contest ----------
if (S.partyVoteTally === undefined) S.partyVoteTally = {}; // { [channelNumber]: count }
if (S.partyVoteTimer === undefined) S.partyVoteTimer = null;
if (S.partyCheckins === undefined) S.partyCheckins = []; // [{name, at}], most recent first, capped
if (S.partyCaptionImagePath === undefined) S.partyCaptionImagePath = null;
if (S.partyTriviaRound === undefined) S.partyTriviaRound = null; // {question, options, correctIndex, votes: {index: count}, endsAtMs}
if (S.countdownTimer === undefined) S.countdownTimer = null;

// Channel root + idle screen (QR code / join URL prompt).
const partyChannelEl = document.getElementById('party-channel');
const partyIdleEl = document.getElementById('party-idle');
const partyQrEl = document.getElementById('party-qr');
const partyIdleUrlEl = document.getElementById('party-idle-url');

// Active content card — whatever's currently up from S.partyQueue.
const partyActiveEl = document.getElementById('party-active');
const partyImageEl = document.getElementById('party-image');
const partyAnnounceCardEl = document.getElementById('party-announce-card');
const partyAnnounceTextEl = document.getElementById('party-announce-text');
const partyCaptionEl = document.getElementById('party-caption');

// Countdown / vote / check-in / trivia overlays on the idle screen.
const partyCountdownEl = document.getElementById('party-countdown');
const partyCountdownLabelEl = document.getElementById('party-countdown-label');
const partyCountdownClockEl = document.getElementById('party-countdown-clock');
const partyVoteBoardEl = document.getElementById('party-vote-board');
const partyVoteListEl = document.getElementById('party-vote-list');
const partyCheckinWallEl = document.getElementById('party-checkin-wall');
const partyCheckinListEl = document.getElementById('party-checkin-list');
const partyTriviaCardEl = document.getElementById('party-trivia-card');
const partyTriviaQuestionTextEl = document.getElementById('party-trivia-question');
const partyTriviaOptionsEl = document.getElementById('party-trivia-options');
const partyTriviaStatusEl = document.getElementById('party-trivia-status');

// Guest-triggered visual effects (flash/confetti/applause) — overlay
// whatever's tuned, so these live outside #party-channel entirely.
const effectOverlayEl = document.getElementById('effect-overlay');
const effectFlashEl = document.getElementById('effect-flash');
const effectConfettiEl = document.getElementById('effect-confetti');
const effectApplauseEl = document.getElementById('effect-applause');
const crtContainer = document.querySelector('.crt');

function pad2(n) { return String(n).padStart(2, '0'); }

// ---------- Visual effects (guest-triggered from the party page's EFFECTS
// tab — main.js's POST /effect -> IPC 'party:effect' -> onPartyEffect below)
// — overlay whatever's tuned, not just this channel, so they stay separate
// from the party-content rendering below. ----------
const CONFETTI_COLORS = ['#f0b429', '#6fe0f2', '#ff5fa2', '#4ee08a', '#8b93f5', '#ff6b5b'];
const CONFETTI_PIECE_COUNT = 50;
let confettiTimer = null;
let flashTimer = null;
let applauseTimer = null;

function showEffectOverlay() {
  effectOverlayEl.classList.remove('hidden');
}
function hideEffectOverlayIfIdle() {
  if (effectFlashEl.classList.contains('hidden')
    && effectConfettiEl.classList.contains('hidden')
    && effectApplauseEl.classList.contains('hidden')) {
    effectOverlayEl.classList.add('hidden');
  }
}
// Shared by runFlash/runConfetti/runApplause below — all three follow the
// same "clear any still-pending previous hide, show, run effect-specific
// setup, auto-hide after durationMs" shape; only what setup() does, how
// long it stays up, and any extra teardown on hide differ per effect.
function runTimedEffect(el, prevTimer, durationMs, setup, onHide) {
  clearTimeout(prevTimer);
  el.classList.remove('hidden');
  setup();
  return setTimeout(() => {
    el.classList.add('hidden');
    if (onHide) onHide();
    hideEffectOverlayIfIdle();
  }, durationMs);
}
function runFlash() {
  flashTimer = runTimedEffect(effectFlashEl, flashTimer, 650, () => {
    effectFlashEl.style.animation = 'none';
    void effectFlashEl.offsetWidth; // force reflow so the animation restart takes
    effectFlashEl.style.animation = '';
  });
}
function runConfetti() {
  confettiTimer = runTimedEffect(effectConfettiEl, confettiTimer, 3200, () => {
    effectConfettiEl.innerHTML = '';
    for (let i = 0; i < CONFETTI_PIECE_COUNT; i++) {
      const piece = document.createElement('div');
      piece.className = 'confetti-piece';
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      piece.style.animationDuration = `${1.8 + Math.random() * 1.4}s`;
      piece.style.animationDelay = `${Math.random() * 0.4}s`;
      effectConfettiEl.appendChild(piece);
    }
  }, () => { effectConfettiEl.innerHTML = ''; });
}
function runApplause() {
  applauseTimer = runTimedEffect(effectApplauseEl, applauseTimer, 2300, () => {
    effectApplauseEl.style.animation = 'none';
    void effectApplauseEl.offsetWidth;
    effectApplauseEl.style.animation = '';
  });
}
function triggerVisualEffect(type) {
  showEffectOverlay();
  if (type === 'confetti') runConfetti();
  else if (type === 'flash') runFlash();
  else if (type === 'applause') runApplause();
}

// ---------- Vote-for-next-channel ----------
function pushVoteState() {
  window.api.sendPartyVoteState(window.S.partyVoteTally);
}

// Any guest can vote any time; the tally only actually *does* something
// (renders a leaderboard + eventually auto-tunes) while this channel is
// showing idle — see renderVoteBoard/armVoteTimer below. Voting while
// something else is on just banks votes quietly for whenever the party
// channel is next idle, same "the party continues in the background"
// spirit as the content queue itself.
function registerVote(number) {
  const S = window.S;
  S.partyVoteTally[number] = (S.partyVoteTally[number] || 0) + 1;
  pushVoteState();
  if (S.currentNumber === PARTY_CH && !S.partyCurrentItem) renderVoteBoard();
}

function clearVoteTimer() {
  clearTimeout(window.S.partyVoteTimer);
  window.S.partyVoteTimer = null;
}

function armVoteTimer() {
  const S = window.S;
  if (S.partyVoteTimer) return; // already counting down to this window's tally
  const windowMs = Math.max(15, S.config.party.voteWindowSec || 90) * 1000;
  S.partyVoteTimer = setTimeout(() => {
    S.partyVoteTimer = null;
    const finalTally = S.partyVoteTally;
    S.partyVoteTally = {};
    pushVoteState();
    const entries = Object.keys(finalTally).map(Number);
    if (!entries.length) { renderVoteBoard(); return; }
    entries.sort((a, b) => finalTally[b] - finalTally[a]);
    const winner = entries[0];
    renderVoteBoard(); // board's now empty — clear it before the tune-away
    if (S.currentNumber === PARTY_CH) window.tuneToChannel(winner);
  }, windowMs);
}

function renderVoteBoard() {
  const S = window.S;
  if (!S.config.party.voteEnabled) {
    partyVoteBoardEl.classList.add('hidden');
    clearVoteTimer();
    return;
  }
  const entries = Object.keys(S.partyVoteTally).map(Number);
  if (!entries.length) {
    partyVoteBoardEl.classList.add('hidden');
    return; // nothing to count down yet — armVoteTimer starts on the first vote (registerVote)
  }
  const total = entries.reduce((sum, n) => sum + S.partyVoteTally[n], 0);
  entries.sort((a, b) => S.partyVoteTally[b] - S.partyVoteTally[a]);
  partyVoteListEl.innerHTML = '';
  entries.forEach((num) => {
    const ch = window.getChannel(num);
    const votes = S.partyVoteTally[num];
    const row = document.createElement('div');
    row.className = 'party-vote-row';
    const label = document.createElement('span');
    label.textContent = `CH ${num}${ch && ch.name ? ' — ' + ch.name.toUpperCase() : ''} (${votes})`;
    const barWrap = document.createElement('div');
    barWrap.className = 'party-vote-row-bar';
    const bar = document.createElement('div');
    bar.className = 'party-vote-row-bar-fill';
    bar.style.width = `${Math.round((votes / total) * 100)}%`;
    barWrap.appendChild(bar);
    row.appendChild(label);
    row.appendChild(barWrap);
    partyVoteListEl.appendChild(row);
  });
  partyVoteBoardEl.classList.remove('hidden');
  armVoteTimer();
}

// ---------- Countdown ----------
function formatCountdown(remainingMs) {
  const totalSec = Math.max(0, Math.floor(remainingMs / 1000));
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  return days > 0 ? `${days}d ${pad2(hours)}:${pad2(mins)}:${pad2(secs)}` : `${pad2(hours)}:${pad2(mins)}:${pad2(secs)}`;
}

// Guards the auto-fire-on-zero effect from repeating every time the idle
// screen re-renders after the target has already passed (e.g. tuning away
// and back) — only fires once per distinct targetMs value, not persisted
// (a page reload re-arming it once is harmless).
let countdownFiredForTarget = null;

function fireCountdownComplete(label) {
  triggerVisualEffect('confetti');
  enqueuePartyItem({ id: `countdown-${Date.now()}`, kind: 'announce', text: label ? `🎉 ${label}!` : '🎉 Time’s up!' });
}

function renderCountdown() {
  const S = window.S;
  const cd = S.config.party.countdown;
  clearInterval(S.countdownTimer);
  S.countdownTimer = null;
  if (!cd || !cd.enabled || !cd.targetMs) {
    partyCountdownEl.classList.add('hidden');
    return;
  }
  const tick = () => {
    const remaining = cd.targetMs - Date.now();
    if (remaining <= 0) {
      clearInterval(S.countdownTimer);
      S.countdownTimer = null;
      partyCountdownEl.classList.add('hidden');
      if (countdownFiredForTarget !== cd.targetMs) {
        countdownFiredForTarget = cd.targetMs;
        fireCountdownComplete(cd.label);
      }
      return;
    }
    partyCountdownLabelEl.textContent = cd.label || 'COUNTING DOWN';
    partyCountdownClockEl.textContent = formatCountdown(remaining);
    partyCountdownEl.classList.remove('hidden');
  };
  tick();
  S.countdownTimer = setInterval(tick, 1000);
}

// ---------- Check-in wall ----------
const CHECKIN_MAX = 24;
function addPartyCheckin(name) {
  const S = window.S;
  const clean = String(name || '').trim().slice(0, 24);
  if (!clean) return;
  S.partyCheckins.unshift(clean);
  if (S.partyCheckins.length > CHECKIN_MAX) S.partyCheckins.length = CHECKIN_MAX;
  // Same two-note chime core's own audio.js sfxCheckin used to play,
  // built from ctx.playTone since a plugin can't import audio.js directly.
  window.RCBPlugins.ctx.playTone({ freq: 784, duration: 220, type: 'sine', gain: 0.14 });
  setTimeout(() => window.RCBPlugins.ctx.playTone({ freq: 659, duration: 320, type: 'sine', gain: 0.14 }), 180);
  pushToTickerFeed(`👋 ${clean} just checked in`);
  // The check-in wall only lives on the idle screen — re-render it if
  // that's what's currently showing so a new arrival appears immediately.
  if (S.currentNumber === PARTY_CH && !S.partyCurrentItem) renderPartyIdle();
}

// Capped display (S.partyCheckins itself can hold up to CHECKIN_MAX=24) —
// a long-running party's full check-in list stacked with the countdown/vote
// board is exactly what overflowed the idle screen (see .party-channel's
// overflow-y fix); showing only the most recent names plus a "+N more" chip
// keeps the common case compact without losing anyone from the underlying
// list guests actually see reflected in who's-arrived counts.
const CHECKIN_WALL_VISIBLE = 10;
function renderCheckinWall() {
  const S = window.S;
  if (!S.config.party.checkinEnabled || !S.partyCheckins.length) {
    partyCheckinWallEl.classList.add('hidden');
    return;
  }
  partyCheckinListEl.innerHTML = '';
  S.partyCheckins.slice(0, CHECKIN_WALL_VISIBLE).forEach((name) => {
    const chip = document.createElement('span');
    chip.className = 'party-checkin-chip';
    chip.textContent = name;
    partyCheckinListEl.appendChild(chip);
  });
  const remaining = S.partyCheckins.length - CHECKIN_WALL_VISIBLE;
  if (remaining > 0) {
    const more = document.createElement('span');
    more.className = 'party-checkin-chip';
    more.textContent = `+${remaining} more`;
    partyCheckinListEl.appendChild(more);
  }
  partyCheckinWallEl.classList.remove('hidden');
}

// ---------- Ticker feed ----------
// See plugins/ticker's applyTickerState for how this buffer actually
// renders (window.applyTickerState — a plugin, so it can't be imported
// directly here). Capped so a busy party doesn't leave the ticker
// scrolling through an ever-growing wall of stale text.
const TICKER_FEED_MAX = 8;
function pushToTickerFeed(text) {
  const S = window.S;
  if (!S.config.party.feedTicker || !text) return;
  S.partyTickerFeed.unshift(text.slice(0, 120));
  if (S.partyTickerFeed.length > TICKER_FEED_MAX) S.partyTickerFeed.length = TICKER_FEED_MAX;
  window.applyTickerState?.();
}

// ---------- Content queue ----------
// Unlike S.partyCheckins/S.partyTickerFeed above, this one has no natural
// display-time cap of its own to lean on — each item shows for
// imageDurationSec/videoMaxDurationSec (8-60s), so a lively party posting
// faster than that could otherwise grow this without bound. Capped the
// same "keep the most recent, drop the oldest" way as its siblings.
const PARTY_QUEUE_MAX = 40;
function pushPartyQueueState() {
  const S = window.S;
  window.api.sendPartyQueueState({
    current: S.partyCurrentItem && {
      kind: S.partyCurrentItem.kind, caption: S.partyCurrentItem.caption, text: S.partyCurrentItem.text,
    },
    queueLength: S.partyQueue.length,
  });
}

// Announcements jump to the front of the queue — a time-sensitive "pizza's
// here!" shouldn't wait behind a long-running video someone posted earlier.
// Everything else (images/videos) is FIFO, first posted first shown.
function enqueuePartyItem(item) {
  const S = window.S;
  if (item.kind === 'announce') S.partyQueue.unshift(item);
  else {
    S.partyQueue.push(item);
    // Trim from the front (oldest-waiting), not the end via .length= — the
    // newest item just got pushed onto the end, so shrinking .length would
    // drop that instead of the stale backlog.
    if (S.partyQueue.length > PARTY_QUEUE_MAX) S.partyQueue.splice(0, S.partyQueue.length - PARTY_QUEUE_MAX);
  }
  pushPartyQueueState();
  if (item.kind === 'announce') pushToTickerFeed('📢 ' + item.text);
  else if (item.caption) pushToTickerFeed((item.kind === 'video' ? '🎬 ' : '📷 ') + item.caption);
  // Channel's sitting idle right now — start the new item immediately
  // instead of waiting for a re-tune to notice the queue's no longer empty.
  if (S.currentNumber === PARTY_CH && !S.partyCurrentItem) playNextPartyItem();
}

function speakAnnouncement(text) {
  if (!window.speechSynthesis) return; // no TTS support — the on-screen card still shows the text
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

function renderCurrentPartyItem() {
  const S = window.S;
  const player = window.RCBPlugins.ctx.player;
  const item = S.partyCurrentItem;
  clearInterval(S.countdownTimer);
  S.countdownTimer = null;
  partyCountdownEl.classList.add('hidden');
  clearVoteTimer();
  partyVoteBoardEl.classList.add('hidden');
  partyIdleEl.classList.add('hidden');
  partyActiveEl.classList.remove('hidden');
  partyImageEl.classList.add('hidden');
  partyAnnounceCardEl.classList.add('hidden');
  partyTriviaCardEl.classList.add('hidden');
  partyChannelEl.classList.remove('party-video-mode');
  partyCaptionEl.classList.toggle('hidden', !item.caption);
  partyCaptionEl.textContent = item.caption || '';

  if (item.kind === 'image') {
    window.api.toFileUrl(item.path).then((url) => {
      if (S.partyCurrentItem !== item) return; // superseded while resolving (tuned away/skipped)
      partyImageEl.src = url;
      partyImageEl.classList.remove('hidden');
    });
    const durMs = Math.max(2, (S.config.party.imageDurationSec || 8)) * 1000;
    S.partyItemTimer = setTimeout(playNextPartyItem, durMs);
  } else if (item.kind === 'video') {
    partyChannelEl.classList.add('party-video-mode');
    window.api.toFileUrl(item.path).then((url) => {
      if (S.partyCurrentItem !== item) return;
      player.src = url;
      player.loop = false;
      player.play().catch(() => {});
    });
    // Both an 'ended' listener (the common case — a short clip finishes on
    // its own) and a hard cap (a guest posting a full-length movie
    // shouldn't monopolize the party channel indefinitely).
    const capMs = Math.max(5, (S.config.party.videoMaxDurationSec || 60)) * 1000;
    S.endedHandler = () => { if (S.partyCurrentItem === item) playNextPartyItem(); };
    player.addEventListener('ended', S.endedHandler);
    S.partyItemTimer = setTimeout(() => {
      if (S.partyCurrentItem === item) playNextPartyItem();
    }, capMs);
  } else if (item.kind === 'announce') {
    partyAnnounceTextEl.textContent = item.text;
    partyAnnounceCardEl.classList.remove('hidden');
    speakAnnouncement(item.text);
    // Dwell time is a rough reading-time estimate (~150wpm), not tied to
    // actual TTS playback duration — voices/rates vary by OS, and some
    // systems have no TTS voice installed at all, in which case the card
    // still needs to stay up long enough to actually read.
    const words = item.text.trim().split(/\s+/).filter(Boolean).length;
    const dwellMs = Math.min(20000, Math.max(4000, (words / 150) * 60000 + 1500));
    S.partyItemTimer = setTimeout(playNextPartyItem, dwellMs);
  } else if (item.kind === 'trivia') {
    S.partyTriviaRound = {
      question: item.question, options: item.options, correctIndex: item.correctIndex,
      votes: [0, 0, 0, 0], revealed: false,
    };
    renderTriviaCard();
    pushTriviaState();
    S.partyItemTimer = setTimeout(revealTrivia, TRIVIA_ANSWER_WINDOW_MS);
  }
}

const TRIVIA_ANSWER_WINDOW_MS = 20000;
const TRIVIA_REVEAL_DWELL_MS = 6000;
const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

function pushTriviaState() {
  const r = window.S.partyTriviaRound;
  window.api.sendPartyTriviaState(r ? {
    active: true, question: r.question, options: r.options, votes: r.votes,
    revealed: r.revealed, correctIndex: r.revealed ? r.correctIndex : null,
  } : { active: false });
}

function renderTriviaCard() {
  const r = window.S.partyTriviaRound;
  if (!r) { partyTriviaCardEl.classList.add('hidden'); return; }
  partyTriviaQuestionTextEl.textContent = r.question;
  const totalVotes = r.votes.reduce((a, b) => a + b, 0) || 1;
  partyTriviaOptionsEl.innerHTML = '';
  r.options.forEach((opt, idx) => {
    const row = document.createElement('div');
    row.className = 'trivia-option-row' + (r.revealed && idx === r.correctIndex ? ' correct' : '');
    const letter = document.createElement('span');
    letter.className = 'trivia-option-letter';
    letter.textContent = OPTION_LETTERS[idx];
    const text = document.createElement('span');
    text.textContent = opt;
    text.style.flex = '0 0 auto';
    text.style.minWidth = '35%';
    const barWrap = document.createElement('div');
    barWrap.className = 'trivia-option-bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'trivia-option-bar';
    bar.style.width = `${Math.round((r.votes[idx] / totalVotes) * 100)}%`;
    barWrap.appendChild(bar);
    row.appendChild(letter);
    row.appendChild(text);
    row.appendChild(barWrap);
    partyTriviaOptionsEl.appendChild(row);
  });
  partyTriviaStatusEl.textContent = r.revealed
    ? `THE ANSWER WAS ${OPTION_LETTERS[r.correctIndex]}`
    : 'ANSWER FROM THE PARTY PAGE — TRIVIA TAB';
  partyTriviaCardEl.classList.remove('hidden');
}

function revealTrivia() {
  const S = window.S;
  if (!S.partyTriviaRound || S.partyCurrentItem?.kind !== 'trivia') return;
  S.partyTriviaRound.revealed = true;
  renderTriviaCard();
  pushTriviaState();
  S.partyItemTimer = setTimeout(() => {
    S.partyTriviaRound = null;
    pushTriviaState();
    playNextPartyItem();
  }, TRIVIA_REVEAL_DWELL_MS);
}

// Guests can only answer while a round is live and unrevealed — see
// renderTriviaCard/revealTrivia above for the lifecycle. Picked randomly
// rather than in bank order, so a repeated round doesn't always open with
// the same question.
function startTriviaRound() {
  const S = window.S;
  const bank = S.config.party.triviaQuestions || [];
  if (!bank.length) {
    window.alertDialog('No trivia questions configured yet — add some in the PARTY panel first.');
    return;
  }
  const q = bank[Math.floor(Math.random() * bank.length)];
  S.partyQueue.unshift({
    id: `trivia-${Date.now()}`, kind: 'trivia', question: q.question, options: q.options, correctIndex: q.correctIndex,
  });
  pushPartyQueueState();
  if (S.currentNumber === PARTY_CH && !S.partyCurrentItem) playNextPartyItem();
}

function registerTriviaAnswer(index) {
  const S = window.S;
  const r = S.partyTriviaRound;
  if (!r || r.revealed || !Number.isInteger(index) || index < 0 || index > 3) return;
  r.votes[index] = (r.votes[index] || 0) + 1;
  pushTriviaState();
  if (S.currentNumber === PARTY_CH && S.partyCurrentItem && S.partyCurrentItem.kind === 'trivia') renderTriviaCard();
}

function renderFloatingReaction(emoji) {
  // .floating-reaction is position:absolute and needs a positioned ancestor
  // matching the TV picture itself, not the whole window — otherwise
  // "left: X%"/"bottom: 40px" resolve against the full viewport instead of
  // the CRT screen, and the emoji can land off the picture entirely
  // whenever the window is larger than the TV area.
  const container = crtContainer || document.body;
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  el.textContent = emoji;
  el.style.left = `${Math.floor(Math.random() * 80) + 10}%`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function playNextPartyItem() {
  const S = window.S;
  clearTimeout(S.partyItemTimer);
  S.partyItemTimer = null;
  const item = S.partyQueue.shift();
  pushPartyQueueState();
  if (!item) {
    S.partyCurrentItem = null;
    renderPartyIdle();
    return;
  }
  S.partyCurrentItem = item;
  renderCurrentPartyItem();
}

function renderPartyIdle() {
  const S = window.S;
  partyActiveEl.classList.add('hidden');
  partyChannelEl.classList.remove('party-video-mode');
  partyIdleEl.classList.remove('hidden');
  renderCheckinWall();
  renderCountdown();
  renderVoteBoard();
  window.api.getPartyJoinInfo().then((info) => {
    // Tuned away, or a new post arrived and already advanced us out of
    // idle, while this was resolving — don't stomp on whatever's current.
    if (S.currentNumber !== PARTY_CH || S.partyCurrentItem) return;
    partyQrEl.src = info.qrDataUrl || '';
    partyIdleUrlEl.textContent = info.url || '';
  }).catch(() => {});
}

// Soundboard: a deliberate, narrow exception to this app's single-video-
// element rule — a soundboard sting is a concurrent overlay any partygoer
// can trigger at any time regardless of what's tuned, fundamentally unlike
// "what's on the channel," so routing it through the shared #player would
// either cut off whatever's actually playing or be impossible to trigger
// while content's mid-play. A single persistent <audio> element (not
// per-play) so overlapping taps replace rather than stack, mirroring
// #player's own one-thing-at-a-time behavior as closely as this dual-
// pipeline case allows. Respects the box's mute/volume state so a muted
// box stays muted.
let soundboardAudio = null;
function playSoundboardSting(fileUrl) {
  const S = window.S;
  if (S.config.muted) return;
  if (!soundboardAudio) soundboardAudio = new Audio();
  soundboardAudio.volume = typeof S.config.volume === 'number' ? S.config.volume : 1;
  soundboardAudio.src = fileUrl;
  soundboardAudio.currentTime = 0;
  soundboardAudio.play().catch(() => {});
}

// ---------- Channel lifecycle ----------
function enterPartyChannel() {
  const S = window.S;
  partyChannelEl.classList.remove('hidden');
  if (S.partyQueue.length && !S.partyCurrentItem) playNextPartyItem();
  else if (S.partyCurrentItem) renderCurrentPartyItem();
  else renderPartyIdle();
}

// The in-progress item is dropped rather than resumed on return — its
// dwell/video timer is already cleared, and player.src will have been
// overwritten by whatever's tuned next anyway, so there's nothing
// meaningful left to resume mid-item.
function exitPartyChannel() {
  const S = window.S;
  clearTimeout(S.partyItemTimer);
  S.partyItemTimer = null;
  clearInterval(S.countdownTimer);
  S.countdownTimer = null;
  clearVoteTimer();
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  S.partyCurrentItem = null;
  if (S.partyTriviaRound) { S.partyTriviaRound = null; pushTriviaState(); }
  partyChannelEl.classList.remove('party-video-mode');
  partyIdleEl.classList.add('hidden');
  partyActiveEl.classList.add('hidden');
  partyChannelEl.classList.add('hidden');
}

window.RCBPlugins.registerChannelType('party-channel', {
  number: PARTY_CH,
  label: 'PARTY',
  nowText: () => (window.S.partyCurrentItem ? 'Live from your phones' : 'Scan to join'),
  badge: { bg: '#9333ea', label: 'PARTY' },
  // The user's own "PARTY CHANNEL (CH 5)" toggle, on top of the plugin
  // being installed+enabled (which loadPlugins() already gates before this
  // registration call even runs) — same enabled(ctx) gate pattern
  // public-access's own CH 2 toggle uses.
  enabled(ctx) {
    return !!(ctx.S.config.party && ctx.S.config.party.enabled);
  },
  // Optional capability any registerChannelType plugin can offer — a "watch
  // live" link the LAN viewer page shows when this channel is the one
  // actually live (see app.js's generic viewer-live-link code, which has no
  // idea this is "the party channel" specifically). Resolves to the URL a
  // guest would use to join, fetched from the main process's own generic
  // /api/viewer-live-link endpoint (main-viewer-server.js), which in turn
  // reads whatever this plugin's own main.js published onto
  // ctx.services.viewerLiveLinkUrls.
  viewerLink: {
    fetchUrl: () => fetch('/api/viewer-live-link').then((r) => r.json()).then((data) => (data.urls && data.urls.length ? data.urls[0].url : null)),
  },
  render() {
    // Ignores the container registerChannelType hands render() — this
    // channel reveals its own pre-existing #party-channel element instead
    // (see the file header comment).
    enterPartyChannel();
  },
  stop() {
    exitPartyChannel();
  },
});

// ---------- IPC wiring — guest actions posted from the party page ----------
window.api.onPartyPost((item) => {
  if (!item || (item.kind !== 'image' && item.kind !== 'video') || !item.path) return;
  enqueuePartyItem({ id: item.id, kind: item.kind, path: item.path, caption: item.caption || '', postedAt: Date.now() });
});
window.api.onPartyAnnounce((data) => {
  const text = data && typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) return;
  enqueuePartyItem({ id: data.id, kind: 'announce', text: text.slice(0, 280), postedAt: Date.now() });
});
window.api.onPartySoundboardPlay((data) => {
  if (!data || !data.path) return;
  window.api.toFileUrl(data.path).then(playSoundboardSting);
});
window.api.onPartyEffect((data) => {
  if (data && (data.type === 'confetti' || data.type === 'flash' || data.type === 'applause')) {
    triggerVisualEffect(data.type);
  }
});
window.api.onPartyCheckin((data) => {
  if (data && data.name) addPartyCheckin(data.name);
});
window.api.onPartyVote((data) => {
  if (data && Number.isFinite(data.number)) registerVote(data.number);
});
window.api.onPartyTriviaAnswer((data) => {
  if (data && Number.isInteger(data.index)) registerTriviaAnswer(data.index);
});
if (window.api.onPartyTriggerTrivia) {
  window.api.onPartyTriggerTrivia(() => startTriviaRound());
}
// Breaking-news headline submitted from the party page, and the "shout
// BINGO" celebration — both cross into the breaking-news interrupt
// (registerInterrupt, plugins.js) via the generic registry, not a direct
// import (different app:// origin), and are no-ops if that plugin isn't
// installed/enabled.
if (window.api.onPartyNews) {
  window.api.onPartyNews((data) => {
    window.RCBPlugins.getInterrupt('breaking-news')?.run({ manual: true, headline: data && data.text });
  });
}
if (window.api.onPartyBingo) {
  window.api.onPartyBingo((data) => {
    // Same five-note ascending chime core's own audio.js playBingoChime
    // used to play, built from ctx.playTone.
    [523.25, 659.25, 783.99, 1046.50, 1318.51].forEach((f, i) => {
      setTimeout(() => window.RCBPlugins.ctx.playTone({ freq: f, duration: 200, type: 'triangle', gain: 0.15 }), i * 100);
    });
    triggerVisualEffect('confetti');
    window.RCBPlugins.getInterrupt('breaking-news')?.run({
      manual: true, headline: `🎉 RETRO BINGO! ${(data && data.name) || 'A Party Guest'} SHOUTED BINGO ON THE PARTY PAGE!`,
    });
  });
}
// Caption-contest submission — a guest's caption for the image captured via
// this plugin's own settings-panel CAPTURE FRAME button (S.partyCaptionImagePath).
window.api.onPartyCaption((data) => {
  const text = data && typeof data.text === 'string' ? data.text.trim() : '';
  if (!text || !window.S.partyCaptionImagePath) return;
  enqueuePartyItem({
    id: `caption-${Date.now()}`, kind: 'image', path: window.S.partyCaptionImagePath, caption: text, postedAt: Date.now(),
  });
});
if (window.api && window.api.onPartyReaction) {
  window.api.onPartyReaction((data) => {
    if (data && data.emoji) renderFloatingReaction(data.emoji);
  });
}

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

function renderJoinInfo(urlEl, qrEl) {
  window.api.getPartyJoinInfo().then((info) => {
    if (!info || !info.url) {
      urlEl.textContent = 'No network connection found — connect this computer to WiFi/ethernet to host a party.';
      qrEl.classList.add('hidden');
      return;
    }
    urlEl.textContent = info.url;
    if (info.qrDataUrl) {
      qrEl.src = info.qrDataUrl;
      qrEl.classList.remove('hidden');
    } else {
      qrEl.classList.add('hidden');
    }
  });
}

window.RCBPlugins.registerSettingsPanel('party-channel', {
  render(container, ctx) {
    const cfg = ctx.S.config.party;

    container.innerHTML = `
      <label class="panel-toggle">
        <input type="checkbox" id="party-plugin-enabled">
        PARTY CHANNEL (CH 5)
      </label>
      <span class="panel-status">Guests on your WiFi can post photos/videos to the bulletin, send text-to-speech announcements, play soundboard sounds, vote, check in, and more — all from their own phone's browser, no app needed. Scan to join, or share the link below.</span>
      <div class="party-join-box">
        <img data-el="join-qr" class="party-join-qr" alt="Scan to join the party page">
        <div class="party-join-url" data-el="join-url">—</div>
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
    renderJoinInfo(joinUrlEl, joinQrEl);

    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
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
    joinRefreshBtn.addEventListener('click', () => renderJoinInfo(joinUrlEl, joinQrEl));
  },
});
