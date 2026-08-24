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
  const tk = S.config.ticker;
  const staticText = (tk && tk.text || '').trim();
  const feedText = (S.config.party && S.config.party.feedTicker && S.partyTickerFeed && S.partyTickerFeed.length)
    ? S.partyTickerFeed.join('     •     ') : '';
  const text = [staticText, feedText].filter(Boolean).join('          ');
  const on = !!((tk && tk.enabled && staticText) || feedText);
  crawlEl.textContent = text;
  barEl.classList.toggle('hidden', !on);
  barEl.style.setProperty('--ticker-speed', `${Math.max(1, (tk && tk.speed) || 30)}s`);
}

// Kept as the exact global name documented in PLUGIN_DEVELOPMENT.md's
// "functions core exposes" table — core (app.js, party.js) and any other
// plugin calls window.applyTickerState() to re-render the bar without
// needing to import this plugin's module directly (different app://
// origin — see [[retro_cable_box_plugin_system]]).
window.applyTickerState = applyTickerState;
