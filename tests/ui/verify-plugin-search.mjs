// Scratch: docs/design/03 §6 — the setup search finds plugins and plugin settings without opening them.
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
const groupsFor = async (q) => {
  await page.locator('#setup-search').fill(q);
  await wait(300);
  return page.evaluate(() => {
    const out = []; let cur = null;
    document.querySelectorAll('#setup-search-results > *').forEach((el) => {
      if (el.classList.contains('setup-search-group')) { cur = { name: el.textContent, items: [] }; out.push(cur); } else if (cur) cur.items.push(el.querySelector('.setup-search-result-path').textContent);
    });
    return out;
  });
};

await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

record('ctx exposes search.registerEntries at v4', await page.evaluate(() => window.RCBPlugins.version === 4 && typeof window.RCBPlugins.ctx.search?.registerEntries === 'function'));

// A plugin by name, from Channels (Plug-ins never opened).
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
let g = await groupsFor('makemkv');
const plugGroup = g.find((x) => x.name === 'PLUG-INS');
record('a plugin is found by name under PLUG-INS', !!plugGroup && plugGroup.items.some((t) => /MakeMKV/i.test(t)), JSON.stringify(g));
await page.keyboard.press('Enter');
await wait(1500);
const opened = await page.evaluate(() => ({ tab: document.querySelector('.setup-tab-btn.active')?.dataset.tab, selected: document.querySelector('#plugins-list .plugin-entry.selected')?.dataset.pluginId }));
record('choosing it opens Plug-ins with that plugin selected', opened.tab === 'plugins' && opened.selected === 'makemkv', JSON.stringify(opened));

// A registered setting (prevue), with a filter that would hide it.
await page.locator('#plugins-filter-input').fill('zzz-nothing');
await page.locator('.setup-tab-btn[data-tab="guide"]').click();
g = await groupsFor('crawl speed');
const settingGroup = g.find((x) => x.name === 'SETTINGS');
record('a registered plugin setting is found under SETTINGS', !!settingGroup && settingGroup.items.some((t) => /PLUG-INS › .* › Listing crawl speed/.test(t)), JSON.stringify(g));
const idx = await page.evaluate(() => Array.from(document.querySelectorAll('.setup-search-result')).findIndex((b) => /Listing crawl speed/.test(b.textContent)));
await page.locator('.setup-search-result').nth(idx).click();
await wait(1800);
const landed = await page.evaluate(() => ({
  tab: document.querySelector('.setup-tab-btn.active')?.dataset.tab,
  selected: document.querySelector('#plugins-list .plugin-entry.selected')?.dataset.pluginId,
  filter: document.getElementById('plugins-filter-input').value,
  section: !!document.querySelector('#plugins-detail .plugin-settings-section[data-section-id="presentation"]'),
  sectionTop: Math.round(document.querySelector('#plugins-detail .plugin-settings-section[data-section-id="presentation"]')?.getBoundingClientRect().top ?? -1),
}));
record('choosing it clears the filter, selects the plugin and brings its section on screen', landed.tab === 'plugins' && landed.selected === 'prevue' && landed.filter === '' && landed.section && landed.sectionTop >= 0 && landed.sectionTop < 900, JSON.stringify(landed));

// Validation.
const bad = await page.evaluate(() => { try { window.RCBPlugins.ctx.search.registerEntries('prevue', [{ keywords: 'x' }]); return 'no throw'; } catch (e) { return e.message; } });
record('an entry without a label is rejected clearly', /needs a label/.test(bad), bad);

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
