// Scratch: docs/design/03 steps 3-4 — SettingRow pages and the unified search.
import { chromium } from 'playwright-core';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

// Coverage: the static settings pages are on SettingRow now.
const coverage = await page.evaluate(() => {
  const pages = document.querySelectorAll('.setup-tab-panel[data-tab-panel="display"], .setup-tab-panel[data-tab-panel="guide"], .setup-tab-panel[data-tab-panel="household"], [data-subtab-panel="system"], [data-subtab-panel="librarysync"], [data-subtab-panel="presets"], [data-subtab-panel="onscreen"], [data-subtab-panel="updates"]');
  let rows = 0; let loose = 0; const looseList = [];
  const dynamic = '#custom-sounds-list, #reminders-list, #airchecks-list, #hintbar-items-list, #logobug-editor, #dynamic-overlays-editor, #backups-list, #presets-detail, #interstitials-detail, #library-sync-results, #connected-devices-list, #display-theme-font-settings, .guide-genre-color-list, #presets-list';
  pages.forEach((root) => {
    rows += root.querySelectorAll('.setting-row').length;
    root.querySelectorAll('.shuffle-toggle, .panel-interval, .crt-slider').forEach((el) => {
      if (el.closest(dynamic)) return;
      loose += 1; looseList.push(el.className + '@' + (el.closest('.panel')?.querySelector('.panel-toggle')?.textContent.trim() || el.id || el.outerHTML.slice(0, 80)));
    });
  });
  const labelled = Array.from(document.querySelectorAll('.setting-row')).every((row) => {
    const label = row.querySelector('label.setting-row-label');
    return !label || document.getElementById(label.htmlFor);
  });
  return { rows, loose, looseList, labelled };
});
record('static settings pages use SettingRow (no loose old-style rows left)', coverage.rows >= 60 && coverage.loose === 0 && coverage.labelled, JSON.stringify(coverage));

// Dependencies: a row under a switch is disabled, not hidden, while it's off.
const deps = await page.evaluate(() => {
  document.querySelector('.setup-tab-btn[data-tab="programming"]').click();
  document.querySelector('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="presets"]').click();
  const box = document.getElementById('trivia-enabled');
  const input = document.getElementById('trivia-interval');
  const row = input.closest('.setting-row');
  const r = {};
  box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));
  r.offDisabled = input.disabled && row.classList.contains('is-disabled') && getComputedStyle(row).display !== 'none';
  box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
  r.onEnabled = !input.disabled && !row.classList.contains('is-disabled');
  r.saved = window.S.config.trivia.enabled === true;
  box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));
  return r;
});
record('a dependent row disables (not hides) with its switch, and the switch still saves', deps.offDisabled && deps.onEnabled && deps.saved, JSON.stringify(deps));

const labelClick = await page.evaluate(() => {
  document.querySelector('[data-tab-panel="programming"] .setup-subtab-btn[data-subtab="onscreen"]').click();
  const box = document.getElementById('details-enabled');
  const before = box.checked;
  box.closest('.setting-row').querySelector('.setting-row-label').click();
  const after = box.checked;
  box.click();
  return before !== after;
});
record('clicking a row label toggles its control', labelClick);

// Unified search.
const search = page.locator('#setup-search');
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await page.locator('#setup-content').click({ position: { x: 5, y: 5 } }).catch(() => {});
await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
await page.keyboard.press('Control+k');
await wait(300);
const opened = await page.evaluate(() => ({ focused: document.activeElement.id, groups: Array.from(document.querySelectorAll('.setup-search-group')).map((g) => g.textContent), count: document.querySelectorAll('.setup-search-result').length, overlay: !!document.getElementById('command-palette') }));
record('Ctrl+K focuses the one search and lists actions (no separate palette)', opened.focused === 'setup-search' && opened.count > 5 && !opened.overlay && /ACTIONS/.test(opened.groups[0] || ''), JSON.stringify(opened));

const groupsFor = async (q) => {
  await search.fill(q);
  await wait(400);
  return page.evaluate(() => {
    const out = [];
    let group = null;
    Array.from(document.getElementById('setup-search-results').children).forEach((el) => {
      if (el.classList.contains('setup-search-group')) { group = { name: el.textContent, items: [] }; out.push(group); } else if (group) group.items.push(el.querySelector('.setup-search-result-path').textContent);
    });
    return out;
  });
};

let g = await groupsFor('gu');
const twoKeys = g[0] && g[0].name === "SETTINGS" && /Guide/.test(g[0].items[0]) && g[0].items.some((t) => /Guide width/.test(t));
record('"guide slots" is findable in 2 keystrokes ("gu" lists Guide width under SETTINGS)', twoKeys, JSON.stringify(g.map((x) => `${x.name}:${x.items.slice(0, 3).join('|')}`)));

g = await groupsFor('guide slots');
await page.keyboard.press('Enter');
await wait(700);
const landed = await page.evaluate(() => ({ tab: document.querySelector('.setup-tab-btn.active').dataset.tab, focused: document.activeElement.id }));
record('choosing a setting opens its page and focuses the control', landed.tab === 'guide' && landed.focused === 'guide-slots-select', JSON.stringify(landed));

const channelName = await page.evaluate(() => window.S.config.channels.slice().sort((a, b) => a.number - b.number)[2].name);
await page.keyboard.press('Control+k');
g = await groupsFor(channelName.split(' ')[0]);
const channelGroup = g.find((x) => x.name === 'CHANNELS');
record('channels are a result group', !!channelGroup && channelGroup.items.some((t) => t.includes(channelName)), JSON.stringify(channelGroup));
const channelIndex = await page.evaluate((name) => Array.from(document.querySelectorAll('.setup-search-result')).findIndex((b) => b.textContent.includes(name) && b.textContent.includes('CH ')), channelName);
if (channelIndex >= 0) await page.locator('.setup-search-result').nth(channelIndex).click();
await wait(600);
const opensChannel = await page.evaluate(() => ({ tab: document.querySelector('.setup-tab-btn.active').dataset.tab, card: document.querySelector('#channel-list .channel-row input[placeholder="CHANNEL NAME"]')?.value }));
record('choosing a channel opens it in the channel list + editor', opensChannel.tab === 'channels' && opensChannel.card === channelName, JSON.stringify(opensChannel));

await page.keyboard.press('Control+k');
g = await groupsFor('rescan');
record('actions are a result group ("rescan" finds Rescan all folders)', g.some((x) => x.name === 'ACTIONS' && x.items.some((t) => /Rescan all folders/.test(t))), JSON.stringify(g.map((x) => x.name)));

const programWord = await page.evaluate(async () => {
  const { searchUpcomingPrograms } = await import('app://bundle/renderer/js/guide/program-search.js');
  const st = await import('app://bundle/renderer/js/core/state.js');
  const now = st.viewNow();
  for (const ch of window.S.config.channels) {
    for (const f of (ch.files || []).slice(0, 40)) {
      const word = String(f.title || '').split(/\s+/).find((w) => /^[A-Za-z]{6,}$/.test(w));
      if (word && searchUpcomingPrograms(window.S.config.channels, word, now, { limit: 1 }).length) return word;
    }
  }
  return null;
});
if (programWord) {
  await page.keyboard.press('Control+k');
  g = await groupsFor(programWord);
  record('upcoming programs are a result group', g.some((x) => x.name === 'PROGRAMS' && x.items.length > 0), `${programWord}: ${JSON.stringify(g.map((x) => `${x.name}:${x.items.length}`))}`);
}
await search.fill('');
await page.keyboard.press('Escape');

const statusBtn = await page.evaluate(() => document.getElementById('setup-command-palette-btn').textContent.trim());
await page.locator('#setup-command-palette-btn').click();
await wait(300);
record('the status bar SEARCH button opens the same search', /SEARCH/.test(statusBtn) && (await page.evaluate(() => document.activeElement.id)) === 'setup-search', statusBtn);

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
