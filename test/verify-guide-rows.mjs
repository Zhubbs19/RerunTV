// Scratch: docs/design/11 phase 1 — guide rows. Specials in numeric order and
// selectable, selection by channel number, the selected row never clipped
// (docked and full, desktop and TV), docked row counts, two-line names.
// Run through run-ui-tests.ps1 -Script verify-guide-rows.mjs.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const port = process.argv[2] || '9222';
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'guide-rows-out');
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);
const only = process.env.GUIDE_ROWS_THEMES_ONLY === '1';

async function shot(file) {
  await wait(90);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
}

async function viewport(width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await wait(400);
}

await wait(4000);
for (let i = 0; i < 40; i += 1) {
  if (await page.evaluate(() => !!(window.S && window.S.config && window.S.config.channels))) break;
  await wait(500);
}
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => {
  const mode = await import('app://bundle/renderer/js/usage-mode.js');
  mode.setUsageModePreference('desktop');
  const { tuneToChannel } = await import('app://bundle/renderer/js/playback-core.js');
  const first = window.S.config.channels.slice().sort((a, b) => a.number - b.number)[0].number;
  await tuneToChannel(first);
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
});
await wait(1500);

const rowsInfo = () => page.evaluate(async () => {
  const guide = await import('app://bundle/renderer/js/guide.js');
  const rows = guide.currentGuideRows();
  return rows.map((r) => ({ kind: r.kind, number: r.number }));
});

// Is the selected row whole inside the rows viewport, and how many rows are?
const clipState = () => page.evaluate(() => {
  const box = document.getElementById('guide-rows');
  const b = box.getBoundingClientRect();
  const rowEls = Array.from(box.querySelectorAll('.guide-row'));
  const active = box.querySelector('.guide-row.active-row');
  const winBottom = Math.min(b.bottom, window.innerHeight);
  const inside = (el) => { const r = el.getBoundingClientRect(); return r.top >= b.top - 0.5 && r.bottom <= winBottom + 0.5; };
  const hint = document.querySelector('#guide-grid .guide-hint');
  const hr = hint && hint.getBoundingClientRect();
  const name = active && active.querySelector('.grc-name');
  return {
    selected: window.S.guideSelNumber,
    hintOnScreen: !hr || hr.height === 0 || hr.bottom <= window.innerHeight + 0.5,
    gridOnScreen: document.getElementById('guide-grid').getBoundingClientRect().bottom <= window.innerHeight + 0.5,
    activeVisible: !!active && inside(active),
    fullRows: rowEls.filter(inside).length,
    rowsH: Math.round(b.height),
    gridH: Math.round(document.getElementById('guide-grid').getBoundingClientRect().height),
    nameLines: name ? Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight || '14')) : 0,
  };
});

async function openGuide({ docked }) {
  await page.evaluate(async (d) => {
    const guide = await import('app://bundle/renderer/js/guide.js');
    guide.closeGuideGrid();
    window.S.guideDocked = d;
    guide.openGuideGrid();
  }, docked);
  await wait(900);
}

async function walkAll(label, { tv }) {
  const rows = await rowsInfo();
  const seen = new Set();
  let clipped = [];
  let minFull = Infinity;
  for (let i = 0; i < rows.length + 1; i += 1) {
    const st = await clipState();
    seen.add(st.selected);
    if (!st.activeVisible) clipped.push(st.selected);
    minFull = Math.min(minFull, st.fullRows);
    if (tv) await page.evaluate(() => window.RerunTVInput.native({ key: 'down' }));
    else await page.keyboard.press('ArrowDown');
    await wait(120);
  }
  const missing = rows.filter((r) => !seen.has(r.number)).map((r) => r.number);
  record(`${label}: every row reachable with ▼ (${rows.length} rows)`, missing.length === 0, missing.length ? `missing ${missing.join(',')}` : '');
  record(`${label}: selected row never clipped`, clipped.length === 0, clipped.length ? `clipped at ${clipped.join(',')}` : '');
  // back up the list too
  clipped = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (tv) await page.evaluate(() => window.RerunTVInput.native({ key: 'up' }));
    else await page.keyboard.press('ArrowUp');
    await wait(120);
    const st = await clipState();
    if (!st.activeVisible) clipped.push(st.selected);
  }
  record(`${label}: selected row never clipped going up`, clipped.length === 0, clipped.length ? `clipped at ${clipped.join(',')}` : '');
  return minFull;
}

if (!only) {
  const rows = await rowsInfo();
  const specials = rows.filter((r) => r.kind === 'special').map((r) => r.number);
  const numbers = rows.map((r) => r.number);
  record('guide has special rows', specials.length > 0, `specials ${specials.join(',')}`);
  record('rows are in numeric order with specials inline', numbers.every((n, i) => i === 0 || numbers[i - 1] < n), numbers.join(','));

  for (const [w, h] of [[1280, 720], [1920, 1080]]) {
    await viewport(w, h);
    for (const tv of [false, true]) {
      await page.evaluate(async (t) => {
        const mode = await import('app://bundle/renderer/js/usage-mode.js');
        mode.setUsageModePreference(t ? 'tv' : 'desktop');
      }, tv);
      await wait(300);
      for (const docked of [true, false]) {
        const label = `${w}x${h} ${tv ? 'TV' : 'desktop'} ${docked ? 'docked' : 'full'}`;
        await openGuide({ docked });
        const first = await clipState();
        await shot(path.join(outDir, `${w}x${h}-${tv ? 'tv' : 'desktop'}-${docked ? 'docked' : 'full'}.png`));
        record(`${label}: guide and hint bar inside the window`, first.gridOnScreen && first.hintOnScreen, JSON.stringify({ grid: first.gridH, rows: first.rowsH }));
        const minFull = await walkAll(label, { tv });
        if (docked) {
          const need = tv ? 4 : 5;
          record(`${label}: at least ${need} whole rows docked`, minFull >= need, `min ${minFull}, rows box ${first.rowsH}px, grid ${first.gridH}px`);
        }
        await page.evaluate(async () => (await import('app://bundle/renderer/js/guide.js')).closeGuideGrid());
        await wait(300);
      }
    }
  }

  await viewport(1280, 720);
  await page.evaluate(async () => (await import('app://bundle/renderer/js/usage-mode.js')).setUsageModePreference('desktop'));

  // Resizing with the guide open keeps it on screen and the selection whole.
  await openGuide({ docked: true });
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowDown');
  const resizeFails = [];
  for (const [w, h] of [[1000, 600], [1600, 900], [800, 480], [1920, 1080], [1280, 720]]) {
    await viewport(w, h);
    await wait(300);
    const st = await clipState();
    if (!st.activeVisible || !st.gridOnScreen || !st.hintOnScreen) resizeFails.push(`${w}x${h} ${JSON.stringify(st)}`);
    await shot(path.join(outDir, `resize-${w}x${h}.png`));
  }
  record('resizing the window keeps the guide, hints and selected row on screen', resizeFails.length === 0, resizeFails.join(' | '));
  await page.evaluate(async () => (await import('app://bundle/renderer/js/guide.js')).closeGuideGrid());

  // Selection sticks to a channel through a filter change.
  await openGuide({ docked: true });
  const filterCheck = await page.evaluate(async () => {
    const guide = await import('app://bundle/renderer/js/guide.js');
    const rows = guide.currentGuideRows();
    const target = rows[Math.min(3, rows.length - 1)];
    window.S.guideSelNumber = target.number;
    guide.renderGuideGrid();
    const name = target.kind === 'special' ? target.info.name : target.ch.name;
    const input = document.getElementById('guide-search');
    return { number: target.number, name, hasInput: !!input };
  });
  await page.evaluate(async (n) => {
    const guide = await import('app://bundle/renderer/js/guide.js');
    window.S.guideFilterQuery = String(n).slice(0, 1);
    guide.renderGuideGrid();
    window.S.guideFilterQuery = '';
    guide.renderGuideGrid();
  }, filterCheck.number);
  const afterFilter = await page.evaluate(() => window.S.guideSelNumber);
  record('selection is a channel number and survives a filter round trip', afterFilter === filterCheck.number, `${filterCheck.number} -> ${afterFilter}`);

  // Enter on a special row tunes it.
  const special = specials[0];
  if (special != null) {
    await page.evaluate(async (n) => {
      const guide = await import('app://bundle/renderer/js/guide.js');
      window.S.guideSelNumber = n;
      guide.renderGuideGrid();
      document.getElementById('guide-grid').focus();
    }, special);
    await wait(200);
    await page.keyboard.press('Enter');
    await wait(1500);
    const tuned = await page.evaluate(() => ({ current: window.S.currentNumber, guideHidden: document.getElementById('guide-grid').classList.contains('hidden') }));
    record('Enter on a special row tunes that channel and closes the guide', tuned.current === special && tuned.guideHidden, JSON.stringify(tuned));
    await page.evaluate(async () => {
      const { tuneToChannel } = await import('app://bundle/renderer/js/playback-core.js');
      await tuneToChannel(window.S.config.channels.slice().sort((a, b) => a.number - b.number)[0].number);
    });
    await wait(1200);
  }

  // Specials at the top: still selectable, placed first.
  await page.evaluate(async () => {
    const { dispatch } = await import('app://bundle/renderer/js/state.js');
    dispatch({ type: 'settings.set', path: ['display', 'guideSpecialsAtTop'], value: true });
  });
  await openGuide({ docked: true });
  const topRows = await rowsInfo();
  const firstNonSpecial = topRows.findIndex((r) => r.kind === 'channel');
  record('specials at the top puts every special first', topRows.slice(0, firstNonSpecial).every((r) => r.kind === 'special') && topRows.slice(firstNonSpecial).every((r) => r.kind === 'channel'), topRows.map((r) => r.number).join(','));
  await walkAll('specials at top, desktop docked', { tv: false });
  await page.evaluate(async () => {
    const { dispatch } = await import('app://bundle/renderer/js/state.js');
    dispatch({ type: 'settings.set', path: ['display', 'guideSpecialsAtTop'], value: false });
    (await import('app://bundle/renderer/js/guide.js')).closeGuideGrid();
  });

  // Names: the longest channel name wraps to at most two lines.
  await openGuide({ docked: false });
  const names = await page.evaluate(() => Array.from(document.querySelectorAll('.grc-name')).map((el) => {
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    return { text: el.textContent, lines: Math.round(el.getBoundingClientRect().height / lh), truncated: el.scrollHeight > el.clientHeight + 1 };
  }));
  const maxLines = Math.max(...names.map((n) => n.lines));
  record('channel names use at most two lines', maxLines <= 2, JSON.stringify(names.filter((n) => n.lines > 1).slice(0, 4)));
  await shot(path.join(outDir, 'names-full.png'));
  await page.evaluate(async () => (await import('app://bundle/renderer/js/guide.js')).closeGuideGrid());

  // Guide open cost (≤ 30 channels budget): time the synchronous render.
  const cost = await page.evaluate(async () => {
    const guide = await import('app://bundle/renderer/js/guide.js');
    const samples = [];
    for (let i = 0; i < 6; i += 1) {
      window.S.guideSelTime += 1; // defeat the fast path
      const t = performance.now();
      guide.renderGuideGrid();
      samples.push(performance.now() - t);
    }
    return samples;
  });
  const median = cost.slice().sort((a, b) => a - b)[3];
  const parts = await page.evaluate(async () => {
    const guide = await import('app://bundle/renderer/js/guide.js');
    const { getChannelSchedule } = await import('app://bundle/renderer/js/schedule.js');
    const { GUIDE_SLOT_MS } = await import('app://bundle/renderer/js/state.js');
    let t = performance.now();
    const rows = guide.currentGuideRows();
    const rowsMs = performance.now() - t;
    t = performance.now();
    rows.forEach((r) => { if (r.kind === 'channel') getChannelSchedule(r.ch, window.S.guideWindowStart, window.S.guideWindowStart + GUIDE_SLOT_MS * 4); });
    const schedMs = performance.now() - t;
    t = performance.now();
    void document.getElementById('guide-rows').offsetHeight;
    const layoutMs = performance.now() - t;
    return { rowsMs: rowsMs.toFixed(1), schedMs: schedMs.toFixed(1), layoutMs: layoutMs.toFixed(1) };
  });
  console.log('render parts', JSON.stringify(parts));
  record('guide render stays within one frame (median of 6, 16.7 ms)', median <= 16.7, cost.map((c) => c.toFixed(1)).join(' '));
}

// Theme sweep: every theme, docked and full, walk all rows.
const themes = await page.evaluate(async () => (await import('app://bundle/renderer/js/plugins.js')).themePackEntries().map((e) => e.id));
if (themes.length && process.env.GUIDE_ROWS_SKIP_THEMES !== '1') {
  await viewport(1280, 720);
  const failures = [];
  for (const id of themes) {
    await page.evaluate(async (theme) => {
      window.S.config.theme = theme;
      const { applyTheme } = await import('app://bundle/renderer/js/themes.js');
      applyTheme({ boxOnly: true });
    }, id);
    for (const docked of [true, false]) {
      await openGuide({ docked });
      const rows = await rowsInfo();
      for (let i = 0; i < rows.length; i += 1) {
        const st = await clipState();
        if (!st.activeVisible) { failures.push(`${id}/${docked ? 'docked' : 'full'}/${st.selected}`); break; }
        await page.keyboard.press('ArrowDown');
        await wait(60);
      }
      if (docked) await shot(path.join(outDir, `theme-${id}.png`));
    }
  }
  record(`theme sweep: selected row never clipped (${themes.length} themes)`, failures.length === 0, failures.join(' '));
} else {
  record('theme sweep skipped or no themes', process.env.GUIDE_ROWS_SKIP_THEMES === '1', `${themes.length} themes`);
}

await cdp.send('Emulation.clearDeviceMetricsOverride');
record('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
await browser.close();
process.exit(failed.length ? 1 : 0);
