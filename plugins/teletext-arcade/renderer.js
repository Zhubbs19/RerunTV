// Virtual CH 99 — a parody 90s teletext-style teletext service with a
// playable Snake game on page 999. No config, no settings panel, no
// main-process backend, migrated as-is from the old core
// teletext.js/virtual.js. Arrow-key routing to the Snake game goes through
// the generic onKey hook (see plugins.js's registerChannelType doc
// comment) instead of app.js special-casing this channel's number.
let currentContainer = null;
let teletextPage = 100;
let snakeTimer = null;
let snakeDir = { x: 1, y: 0 };
let snakeBody = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
let snakeFood = { x: 15, y: 15 };
let snakeScore = 0;

function stopSnakeGame() {
  if (snakeTimer) { clearInterval(snakeTimer); snakeTimer = null; }
}

function spawnFood() {
  snakeFood = { x: Math.floor(Math.random() * 20), y: Math.floor(Math.random() * 12) };
}

function tickSnakeGame() {
  if (!currentContainer) return;
  const canvas = currentContainer.querySelector('#snake-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  const head = { x: snakeBody[0].x + snakeDir.x, y: snakeBody[0].y + snakeDir.y };
  if (head.x < 0) head.x = 19;
  if (head.x >= 20) head.x = 0;
  if (head.y < 0) head.y = 11;
  if (head.y >= 12) head.y = 0;

  if (snakeBody.some((segment) => segment.x === head.x && segment.y === head.y)) {
    snakeBody = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    snakeScore = 0;
  } else {
    snakeBody.unshift(head);
    if (head.x === snakeFood.x && head.y === snakeFood.y) {
      snakeScore += 10;
      const scoreVal = currentContainer.querySelector('#snake-score-val');
      if (scoreVal) scoreVal.textContent = String(snakeScore);
      spawnFood();
    } else {
      snakeBody.pop();
    }
  }

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#22c55e';
  snakeBody.forEach((seg) => { ctx.fillRect(seg.x * 20 + 1, seg.y * 20 + 1, 18, 18); });
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(snakeFood.x * 20 + 2, snakeFood.y * 20 + 2, 16, 16);
}

function startSnakeGame() {
  snakeBody = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  snakeDir = { x: 1, y: 0 };
  snakeScore = 0;
  spawnFood();
  if (snakeTimer) clearInterval(snakeTimer);
  snakeTimer = setInterval(tickSnakeGame, 120);
}

function updatePage(pageNum) {
  if (!currentContainer) return;
  teletextPage = pageNum;
  const pageNumEl = currentContainer.querySelector('#teletext-page-num');
  const bodyEl = currentContainer.querySelector('#teletext-body');
  if (pageNumEl) pageNumEl.textContent = String(pageNum);

  stopSnakeGame();
  if (!bodyEl) return;

  if (pageNum === 999) {
    bodyEl.innerHTML = `
      <div class="teletext-arcade-box">
        <div class="teletext-arcade-title">🐍 CABLE SNAKE 95 // TELETEXT ARCADE</div>
        <div class="teletext-arcade-score">SCORE: <span id="snake-score-val">0</span> | HIGH SCORE: 140</div>
        <canvas id="snake-canvas" width="400" height="240"></canvas>
        <div class="teletext-arcade-hint">USE ARROW KEYS TO CONTROL THE SNAKE</div>
      </div>
    `;
    startSnakeGame();
  } else if (pageNum === 200) {
    bodyEl.innerHTML = `
      <div class="teletext-news-box">
        <div class="teletext-heading red">PAGE 200 — RETRO CABLE SPORTS WORLD</div>
        <div class="teletext-item">🏀 1995 FINALS: CHICAGO BULLS DEF. KNICKS 108-96</div>
        <div class="teletext-item">⚾ BRAVES TAKE GAME 7 IN 10TH INNING WALKOFF SLUG</div>
        <div class="teletext-item">🏈 DALLAS COWBOYS CLINCH DIVISION TITLE ON 47-YD FIELD GOAL</div>
        <div class="teletext-footer">PRESS 100 FOR NEWS | 300 FOR WEATHER | 999 FOR ARCADE GAME</div>
      </div>
    `;
  } else if (pageNum === 300) {
    bodyEl.innerHTML = `
      <div class="teletext-news-box">
        <div class="teletext-heading cyan">PAGE 300 — REGIONAL WEATHER & FORECAST</div>
        <div class="teletext-item">☀️ ANYTOWN, USA: 78°F CLEAR SKIES & HIGH HUMIDITY</div>
        <div class="teletext-item">🌧️ COASTAL REGION: 64°F LIGHT RAIN AND SEA BREEZE</div>
        <div class="teletext-item">🌩️ MIDWEST: 82°F EVENING THUNDERSTORMS EXPECTED</div>
        <div class="teletext-footer">PRESS 100 FOR NEWS | 200 FOR SPORTS | 999 FOR ARCADE GAME</div>
      </div>
    `;
  } else {
    bodyEl.innerHTML = `
      <div class="teletext-news-box">
        <div class="teletext-heading yellow">PAGE 100 — RERUN NEWS HEADLINES</div>
        <div class="teletext-item">📰 WORLD NEWS: DIAL-UP INTERNET REACHES RECORD 10 MILLION USERS</div>
        <div class="teletext-item">📺 CABLE DIGEST: VCR REWINDER DEMAND SOARS BEFORE MIDNIGHT</div>
        <div class="teletext-item">🛸 ROSWELL DAILY: UNIDENTIFIED FLOWERING CRAFT INTERCEPTED</div>
        <div class="teletext-footer">PRESS 200 FOR SPORTS | 300 FOR WEATHER | 999 FOR ARCADE GAME</div>
      </div>
    `;
  }
}

window.RCBPlugins.registerChannelType('teletext-arcade', {
  number: 99,
  label: 'TELETEXT ARCADE',
  nowText: 'Interactive Games & News',
  badge: { bg: '#eab308', label: 'TXT' },
  // TV mode (ctx v5): remote actions arrive here, forwarded to the same
  // handling onKey already does. Anything not handled goes back to core, so
  // ▲▼ still change channel and Back still asks to leave.
  onAction(action, ctx) {
    const key = ctx && ctx.input ? ctx.input.keyForAction(action) : null;
    return key ? this.onKey(key, ctx) : false;
  },
  onKey(key) {
    // Only claim arrows while a game is actually running (the loop is active);
    // otherwise Up/Down must still change channel.
    if (teletextPage !== 999 || !snakeTimer || !currentContainer) return false;
    if (key === 'ArrowUp' && snakeDir.y !== 1) { snakeDir = { x: 0, y: -1 }; return true; }
    if (key === 'ArrowDown' && snakeDir.y !== -1) { snakeDir = { x: 0, y: 1 }; return true; }
    if (key === 'ArrowLeft' && snakeDir.x !== 1) { snakeDir = { x: -1, y: 0 }; return true; }
    if (key === 'ArrowRight' && snakeDir.x !== -1) { snakeDir = { x: 1, y: 0 }; return true; }
    return false;
  },
  render(container) {
    currentContainer = container;
    container.innerHTML = `
      <div class="teletext-channel">
        <div class="teletext-header">
          <span>TELETEXT // RERUN TELETEXT</span>
          <span>P<span id="teletext-page-num">100</span></span>
        </div>
        <div class="teletext-nav">
          <button type="button" class="teletext-btn" data-page="100">100 NEWS</button>
          <button type="button" class="teletext-btn" data-page="200">200 SPORTS</button>
          <button type="button" class="teletext-btn" data-page="300">300 WEATHER</button>
          <button type="button" class="teletext-btn" data-page="999">999 ARCADE</button>
        </div>
        <div class="teletext-body" id="teletext-body"></div>
      </div>
    `;
    container.querySelectorAll('.teletext-btn').forEach((btn) => {
      btn.addEventListener('click', () => updatePage(parseInt(btn.dataset.page, 10)));
    });
    updatePage(100);
  },
  stop() {
    stopSnakeGame();
    currentContainer = null;
  },
});
