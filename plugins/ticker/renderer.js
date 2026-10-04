// Continuous bottom-of-screen text ticker — migrated as-is from the old
// core power.js. Builds its own DOM (same "own your DOM" pattern as
// eas-alerts) and appends into .crt, replacing the old core-owned
// #ticker-bar/#ticker-crawl markup.
const barEl = document.createElement('div');
barEl.id = 'ticker-bar';
barEl.className = 'ticker-bar hidden';
barEl.innerHTML = '<div class="ticker-crawl" id="ticker-crawl"></div>';
document.querySelector('.crt').appendChild(barEl);
const crawlEl = barEl.querySelector('.ticker-crawl');

// Guest bulletin captions/announcements optionally scroll into this same
// ticker bar (see plugins/party-channel's pushToTickerFeed, which reads
// window.S.config.party.feedTicker/window.S.partyTickerFeed and calls
// window.applyTickerState() same as everything else here) — shown
// regardless of what channel is tuned, same as the static ticker itself
// already is, so party activity stays visible even while someone's
// watching a real channel instead of PARTY_CH. Independent of the static
// config.ticker.text/enabled toggle: live guest content should show up
// even if the host never set a static ticker message, and vice versa — the
// two are just concatenated.
export function applyTickerState() {
  const S = window.S;
  // ch.tickerContent (per-channel override, null = inherit) lets a channel
  // run its own crawl text/speed/on-off state instead of the box-wide
  // S.config.ticker — set from the per-channel TICKER tab
  // (setup-panels.js's buildTickerLayoutPanel), same inherit convention as
  // ch.logoBugProfiles/ch.dynamicOverlays.
  const ch = (S.config.channels || []).find((c) => c.number === S.currentNumber);
  const tk = (ch && ch.tickerContent) || S.config.ticker;
  const staticText = (tk && tk.text || '').trim();
  const feedText = (S.config.party && S.config.party.feedTicker && S.partyTickerFeed && S.partyTickerFeed.length)
    ? S.partyTickerFeed.join('     •     ') : '';
  const text = [staticText, feedText].filter(Boolean).join('          ');
  const on = !!((tk && tk.enabled && staticText) || feedText);
  crawlEl.textContent = text;
  barEl.classList.toggle('hidden', !on);
  barEl.style.setProperty('--ticker-speed', `${Math.max(1, (tk && tk.speed) || 30)}s`);
  applyTickerStyle();
}

// Look of the bar (SETTINGS › Plug-ins › Text ticker), always the box-wide
// config.ticker whichever text a channel runs. The size is a multiplier on a
// base that follows the screen's height, so it reads the same on 1080p and 4K.
function applyTickerStyle() {
  const S = window.S;
  const st = (S.config && S.config.ticker) || {};
  const crt = document.querySelector('.crt');
  const scale = crt && crt.clientHeight ? Math.min(3, Math.max(0.5, crt.clientHeight / 1080)) : 1;
  barEl.style.setProperty('--ticker-scale', String(scale * (Number(st.sizeScale) || 1)));
  barEl.classList.toggle('ticker-top', st.position === 'top');
  /^#[0-9a-f]{6}$/i.test(st.color || '') ? barEl.style.setProperty('--ticker-color', st.color) : barEl.style.removeProperty('--ticker-color');
  if (/^#[0-9a-f]{6}$/i.test(st.bgColor || '') || Number.isFinite(st.bgOpacity)) {
    const hex = /^#[0-9a-f]{6}$/i.test(st.bgColor || '') ? st.bgColor : '#060a20';
    const op = Number.isFinite(st.bgOpacity) ? Math.min(100, Math.max(0, st.bgOpacity)) / 100 : 0.82;
    const n = parseInt(hex.slice(1), 16);
    barEl.style.setProperty('--ticker-bg', `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${op})`);
  } else {
    barEl.style.removeProperty('--ticker-bg');
  }
}

// "Hide during ad breaks": the crawl would sit over a commercial, so it
// steps aside while a break is on screen and returns after.
setInterval(() => {
  const S = window.S;
  const st = (S.config && S.config.ticker) || {};
  barEl.classList.toggle('ticker-in-break', !!(st.hideInBreaks && S.activeBreakKey));
}, 500);
window.addEventListener('resize', applyTickerStyle);

// Kept as the exact global name documented in PLUGIN_DEVELOPMENT.md's
// "functions core exposes" table — core (app.js, party.js) and any other
// plugin calls window.applyTickerState() to re-render the bar without
// needing to import this plugin's module directly (different app://
// origin — see [[retro_cable_box_plugin_system]]).
window.applyTickerState = applyTickerState;
