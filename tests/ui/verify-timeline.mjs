// Scratch: docs/design/02 §4 — SCHEDULE > ON AIR as the editable timeline, driven with real
// pointer gestures against a throwaway copy of the installed config (run through run-ui-tests.ps1).
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';

const OUT = 'tests/ui/screenshots/timeline';
fs.mkdirSync(OUT, { recursive: true });
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
const cdp = await page.context().newCDPSession(page);
const shot = async (name) => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(s.data, 'base64')); };
async function step(name, fn) { try { await fn(); } catch (e) { record(name, false, e.message.split('\n')[0]); } }

await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

// ---------- the week resolves in budget for every real channel ----------
await step('week resolve budget', async () => {
  const timings = await page.evaluate(async () => {
    const q = await import('app://bundle/renderer/js/core/schedule-query.js');
    const { S, bumpConfigGeneration } = await import('app://bundle/renderer/js/core/state.js');
    bumpConfigGeneration();
    const week = q.addDays(q.startOfDay(Date.now() + S.timeOffsetMs), -new Date(Date.now() + S.timeOffsetMs).getDay());
    return S.config.channels.filter((c) => c.files.length || (c.blocks || []).length).map((ch) => {
      const began = performance.now();
      for (let i = 0; i < 7; i++) q.queryDay(ch, q.addDays(week, i));
      return { number: ch.number, files: ch.files.length, ms: Math.round(performance.now() - began) };
    }).sort((a, b) => b.ms - a.ms);
  });
  console.log('slowest channels:', JSON.stringify(timings.slice(0, 4)));
  record('ON AIR week resolves < 300 ms for the slowest real channel', timings[0].ms < 300, `CH ${timings[0].number}: ${timings[0].ms} ms (${timings[0].files} files)`);
});

const pick = await page.evaluate(() => {
  const chans = window.S.config.channels.slice().sort((a, b) => a.number - b.number);
  const plain = chans.find((c) => c.files.length > 20 && !(c.blocks || []).length && (c.folders || []).length);
  return { plain: plain.number, ads: chans.some((c) => c.number === 67) ? 67 : plain.number };
});
console.log('channels', JSON.stringify(pick));

async function openOnAir(num) {
  await page.locator('.setup-tab-btn[data-tab="channels"]').click();
  await page.locator(`#channel-list-pane .channel-list-item[data-channel-number="${num}"]`).click();
  await wait(500);
  await page.locator(`#channel-${num}-edit-tab-schedule`).click();
  await wait(300);
  await page.locator(`#channel-${num}-schedule-tab-onair`).click();
  await waitResolved(num);
}
async function waitResolved(num) {
  const panel = page.locator(`#channel-${num}-schedule-panel`);
  for (let i = 0; i < 160; i += 1) {
    const txt = await panel.locator('.onair-status').textContent().catch(() => '');
    if (txt && txt.startsWith('Resolved')) return txt;
    await wait(100);
  }
  return null;
}
const num = pick.plain;
const panelSel = `#channel-${num}-schedule-panel`;

await step('toggle', async () => {
  await openOnAir(num);
  const views = await page.evaluate((n) => Array.from(document.querySelectorAll(`#channel-${n}-schedule-panel`)[0].parentElement.querySelectorAll('.schedule-view-toggle .edit-tab-btn')).map((b) => b.textContent), num);
  record('SCHEDULE views are ON AIR, BLOCKS, CALENDAR (TIMELINE merged into ON AIR)', JSON.stringify(views) === JSON.stringify(['ON AIR', 'BLOCKS', 'CALENDAR']), views.join(','));
  record('each day has a block lane', await page.locator(`${panelSel} .onair-row[data-day-start] .onair-lane`).count() === 7);
  // DAY zoom (60 px an hour): at 1280×720 the channel detail pane is ~610 px wide.
  await page.locator(`${panelSel} .onair-zoom .btn`, { hasText: 'DAY' }).click();
  await waitResolved(num);
});

// Scrolls a weekday's row into view (both ways) so an hour range is on screen.
async function showRow(weekday, fromHour, toHour) {
  await page.evaluate(({ n, weekday, fromHour, toHour }) => {
    const row = Array.from(document.querySelectorAll(`#channel-${n}-schedule-panel .onair-row[data-day-start]`)).find((r) => new Date(Number(r.dataset.dayStart)).getDay() === weekday);
    row.scrollIntoView({ block: 'center' });
    const scroller = row.closest('.onair-scroller');
    const px = row.querySelector('.onair-day').getBoundingClientRect().width / 24;
    // Just right of the sticky 92px day label, which covers the scroller's left edge.
    scroller.scrollLeft = Math.max(0, fromHour * px - 130);
  }, { n: num, weekday, fromHour, toHour });
  await wait(100);
}

// A pixel for an hour in a weekday's lane, without scrolling anything.
async function laneAt(weekday, hour) {
  return page.evaluate(({ n, weekday, hour }) => {
    const row = Array.from(document.querySelectorAll(`#channel-${n}-schedule-panel .onair-row[data-day-start]`)).find((r) => new Date(Number(r.dataset.dayStart)).getDay() === weekday);
    const lane = row.querySelector('.onair-lane');
    const rect = row.querySelector('.onair-day').getBoundingClientRect();
    const lr = lane.getBoundingClientRect();
    return { x: rect.left + hour * (rect.width / 24), y: lr.top + lr.height / 2, dayStart: Number(row.dataset.dayStart) };
  }, { n: num, weekday, hour });
}

const configSnapshot = () => page.evaluate(() => JSON.stringify(window.S.config.channels.find((c) => c.number === window.__tlNum)));
await page.evaluate((n) => { window.__tlNum = n; }, num);

// ---------- acceptance: Saturday 7–11 AM cartoons, from ON AIR, with the impact preview ----------
let beforeJson = null;
await step('create by drag', async () => {
  await page.evaluate(async () => {
    const { cloneJson } = await import('app://bundle/renderer/js/core/commands.js');
    window.__tlBefore = cloneJson(window.S.config.channels.find((c) => c.number === window.__tlNum));
  });
  beforeJson = await configSnapshot();
  const began = Date.now();
  await showRow(6, 7, 11);
  const a = await laneAt(6, 7.2);
  const b = await laneAt(6, 10.8);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + ((b.x - a.x) * i) / 8, a.y);
  await page.mouse.up();
  await wait(200);
  const title = await page.locator(`${panelSel} .onair-editor-title`).textContent();
  record('dragging 7–11 AM in Saturday\'s lane opens a new-block editor for those hours', /Saturday.*7:00.*11:00|Saturday.*7.*11/i.test(title), title);
  const source = await page.evaluate((sel) => {
    const select = document.querySelector(`${sel} .onair-editor-source`);
    const options = Array.from(select.querySelectorAll('optgroup[label="Folders in your library"] option'));
    const opt = options.find((o) => /cartoon|toon|animat/i.test(o.textContent)) || options[0];
    return opt.value;
  }, panelSel);
  await page.locator(`${panelSel} .onair-editor-source`).selectOption(source);
  await wait(300);
  const preview = await page.locator(`${panelSel} .onair-editor-preview`).textContent();
  const outlined = await page.locator(`${panelSel} .onair-impact-range`).count();
  record('choosing a source shows the impact preview, outlined on the grid', /changes \d+ program/.test(preview) && outlined > 0, `${preview} · ${outlined} outlines`);
  await shot('create-preview');
  await page.locator(`${panelSel} .onair-editor-actions .btn-primary`).click();
  await waitResolved(num);
  const elapsed = Date.now() - began;
  const block = await page.evaluate(() => window.S.config.channels.find((c) => c.number === window.__tlNum).blocks.slice(-1)[0]);
  record('CREATE makes a Saturday 7–11 time block', block && block.trigger.startHour === 7 && block.trigger.endHour === 11 && JSON.stringify(block.trigger.days) === '[6]' && block.files.length > 0, JSON.stringify(block && block.trigger));
  record('done in one drag, one pick and one click, well under 30 s', elapsed < 30000, `${elapsed} ms automated`);
  const undoLabel = await page.evaluate(async () => (await import('app://bundle/renderer/js/core/state.js')).undoLabel());
  record('one named undo step', /^Make Saturday/.test(undoLabel || ''), undoLabel);
  record('the lane shows the new block on Saturday', await page.locator(`${panelSel} .onair-span[data-block-id="${block.id}"]`).count() === 1);
  record('the committed change stays outlined with a sentence', await page.locator(`${panelSel} .onair-impact-bar`).isVisible() && await page.locator(`${panelSel} .onair-impact-range`).count() > 0);
});

// ---------- explanation names every layer ----------
await step('explanation', async () => {
  const checked = await page.evaluate(async (sel) => {
    const q = await import('app://bundle/renderer/js/core/schedule-query.js');
    const ch = window.S.config.channels.find((c) => c.number === window.__tlNum);
    const programs = Array.from(document.querySelectorAll(`${sel} .onair-program`));
    const sample = programs.filter((_, i) => i % Math.max(1, Math.floor(programs.length / 12)) === 0).slice(0, 12);
    const out = [];
    for (const node of sample) {
      node.click();
      const day = Number(node.dataset.day);
      const start = Math.max(Number(node.dataset.start), day);
      const end = Math.min(Number(node.dataset.end), day + 86400000);
      const expected = q.explainLayers(ch, start + Math.max(1, (end - start) / 2)).layers.map((l) => `${l.kind}:${l.item ? l.item.id : ''}`);
      const shown = Array.from(document.querySelectorAll(`${sel} .onair-layer`)).map((r) => `${r.dataset.kind}:${r.dataset.itemId || ''}`);
      out.push({ ok: JSON.stringify(expected) === JSON.stringify(shown), n: shown.length });
    }
    return out;
  }, panelSel);
  record('every sampled program\'s explanation lists every contributing layer', checked.length >= 6 && checked.every((c) => c.ok), `${checked.filter((c) => c.ok).length}/${checked.length}`);
  await showRow(6, 8, 10);
  const sat = await laneAt(6, 9);
  const node = await page.evaluate(({ sel, dayStart }) => {
    const at = dayStart + 9 * 3600000;
    const n = Array.from(document.querySelectorAll(`${sel} .onair-program[data-day="${dayStart}"]`)).find((p) => Number(p.dataset.start) <= at && Number(p.dataset.end) > at);
    n.scrollIntoView({ inline: 'center', block: 'nearest' });
    const r = n.getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + r.height / 2 };
  }, { sel: panelSel, dayStart: sat.dayStart });
  await page.mouse.click(node.x, node.y);
  const roles = await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .onair-layer`)).map((r) => `${r.dataset.kind}:${r.className.match(/role-(\w+)/)[1]}`), panelSel);
  record('Saturday 9 AM: the new block wins over the default lineup', roles.includes('block:wins') && roles.includes('default:outranked'), roles.join(' '));
  record('each layer has EDIT THIS LAYER', await page.locator(`${panelSel} .onair-layer .onair-layer-edit`).count() === roles.length);
  await shot('explanation');

  // Right-click menu on that program.
  await page.mouse.click(node.x, node.y, { button: 'right' });
  await wait(150);
  const items = await page.evaluate(() => Array.from(document.querySelectorAll('.row-menu .row-menu-item')).map((b) => b.textContent));
  record('right-click on a program offers replace, only this day and break edits', ['Replace this airing with…', 'Only this day: give it its own block', 'No ad breaks in this show'].every((l) => items.includes(l)) && items.some((l) => l.startsWith('Add a break here')), items.join(' | '));
  await shot('program-menu');

  // Only this day → a one-day block that outranks the weekly one; then reorder it below.
  await page.locator('.row-menu .row-menu-item', { hasText: 'Only this day' }).click();
  await waitResolved(num);
  await wait(200);
  const exception = await page.evaluate(() => window.S.config.channels.find((c) => c.number === window.__tlNum).blocks.slice(-1)[0]);
  record('"Only this day" adds a one-day block for that date', exception.trigger.type === 'dateRange' && exception.trigger.startDay === exception.trigger.endDay, exception.name);
  const identicalProgramsText = await page.locator(`${panelSel} .onair-impact-bar`).textContent();
  record('…which airs exactly what was there (no program changes)', !/\d+ program/.test(identicalProgramsText), identicalProgramsText);
  await page.mouse.click(node.x, node.y);
  const order = await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .onair-layer[data-kind="block"]`)).map((r) => r.dataset.itemId), panelSel);
  record('the explanation lists the one-day block above the weekly block', order[0] === exception.id && order.length >= 2, order.join(','));
  await page.locator(`${panelSel} .onair-layer[data-item-id="${exception.id}"] .onair-layer-move`).nth(1).click();
  await waitResolved(num);
  await wait(200);
  await page.mouse.click(node.x, node.y);
  const reordered = await page.evaluate((sel) => Array.from(document.querySelectorAll(`${sel} .onair-layer[data-kind="block"]`)).map((r) => `${r.dataset.itemId}:${r.className.match(/role-(\w+)/)[1]}`), panelSel);
  record('▼ in the layer list lowers its priority so the weekly block wins', reordered[1] === `${exception.id}:outranked` && reordered[0].endsWith(':wins'), reordered.join(' '));
  // Take the exception back out (two undo steps: reorder, create).
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await wait(600);
});

// ---------- resize: live one-day preview under 50 ms a frame, full week on drop ----------
await step('resize', async () => {
  await openOnAir(num);
  const blockId = await page.evaluate(() => window.S.config.channels.find((c) => c.number === window.__tlNum).blocks.slice(-1)[0].id);
  const edge = await page.evaluate(({ sel, id }) => {
    const spans = Array.from(document.querySelectorAll(`${sel} .onair-span[data-block-id="${id}"] .onair-span-edge.end`));
    const e = spans[0];
    e.scrollIntoView({ inline: 'center', block: 'nearest' });
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, { sel: panelSel, id: blockId });
  const hourPx = await page.evaluate((sel) => document.querySelector(`${sel} .onair-day`).getBoundingClientRect().width / 24, panelSel);
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  const frameMs = [];
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(edge.x + (hourPx * 2 * i) / 12, edge.y);
    await wait(40);
    const ms = await page.evaluate((sel) => Number(document.querySelector(sel).dataset.lastDragPreviewMs || 'NaN'), panelSel);
    if (Number.isFinite(ms)) frameMs.push(ms);
  }
  const barText = await page.locator(`${panelSel} .onair-impact-bar`).textContent();
  await shot('resize-drag');
  await page.mouse.up();
  await waitResolved(num);
  const block = await page.evaluate((id) => window.S.config.channels.find((c) => c.number === window.__tlNum).blocks.find((b) => b.id === id), blockId);
  record('dragging the end edge previews that day live', /on (Sat|Saturday)/i.test(barText) && /release to apply/.test(barText), barText);
  record('drag preview < 50 ms per frame', frameMs.length > 0 && Math.max(...frameMs) < 50, `max ${Math.max(...frameMs)} ms over ${frameMs.length} frames`);
  record('dropping sets the new hours (7 AM–1 PM after a 2 h drag, snapped)', block.trigger.startHour === 7 && block.trigger.endHour === 13, `${block.trigger.startHour}-${block.trigger.endHour}`);
  record('the week re-resolved after the drop', Number(await page.evaluate((sel) => document.querySelector(sel).dataset.weekResolveMs, panelSel)) >= 0);
});

// ---------- copy to another weekday by the colour chip ----------
await step('copy', async () => {
  const blockId = await page.evaluate(() => window.S.config.channels.find((c) => c.number === window.__tlNum).blocks.slice(-1)[0].id);
  const chip = await page.evaluate(({ sel, id }) => {
    const c = document.querySelector(`${sel} .onair-span[data-block-id="${id}"] .onair-span-chip`);
    c.scrollIntoView({ inline: 'center', block: 'nearest' });
    const r = c.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, { sel: panelSel, id: blockId });
  await showRow(6, 8, 12);
  const sunday = await laneAt(5, 9); // Friday: the row next to Saturday, so both are on screen
  const chip2 = await page.evaluate(({ sel, id }) => { const r = document.querySelector(`${sel} .onair-span[data-block-id="${id}"] .onair-span-chip`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, { sel: panelSel, id: blockId });
  await page.mouse.move(chip2.x, chip2.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(chip2.x, chip2.y + ((sunday.y - chip2.y) * i) / 10);
  await wait(100);
  await page.mouse.up();
  await waitResolved(num);
  const days = await page.evaluate((id) => window.S.config.channels.find((c) => c.number === window.__tlNum).blocks.find((b) => b.id === id).trigger.days, blockId);
  record('dragging the chip onto Friday copies the block to Fridays', JSON.stringify(days) === '[5,6]', JSON.stringify(days) + ` (chip at ${Math.round(chip.y)})`);
});

// ---------- Delete a selected span ----------
await step('delete', async () => {
  const blockId = await page.evaluate(() => window.S.config.channels.find((c) => c.number === window.__tlNum).blocks.slice(-1)[0].id);
  await page.evaluate(({ sel, id }) => { const s = document.querySelector(`${sel} .onair-span[data-block-id="${id}"] .onair-span-label`); s.scrollIntoView({ inline: 'center', block: 'nearest' }); }, { sel: panelSel, id: blockId });
  await page.locator(`${panelSel} .onair-span[data-block-id="${blockId}"] .onair-span-label`).first().click();
  await page.keyboard.press('Delete');
  await wait(300);
  const message = await page.locator('.confirm-dialog, .setup-dialog, [role="alertdialog"]').first().textContent().catch(() => '');
  record('Delete on a selected block confirms with the schedule diff', /changes \d+ (program|break)/.test(message), message.replace(/\s+/g, ' ').slice(0, 160));
  await page.locator('.confirm-dialog-actions .btn-danger').click();
  await waitResolved(num);
  const gone = await page.evaluate((id) => !window.S.config.channels.find((c) => c.number === window.__tlNum).blocks.some((b) => b.id === id), blockId);
  record('…and removes it', gone);
});

// ---------- undo restores the week exactly ----------
await step('undo exact', async () => {
  for (let i = 0; i < 12; i++) {
    const now = await configSnapshot();
    if (now === beforeJson) break;
    await page.keyboard.press('Control+z');
    await wait(250);
  }
  const same = await configSnapshot();
  const diff = await page.evaluate(async () => {
    const q = await import('app://bundle/renderer/js/core/schedule-query.js');
    const live = window.S.config.channels.find((c) => c.number === window.__tlNum);
    const week = q.addDays(q.startOfDay(Date.now()), -new Date().getDay());
    const d = q.diffSchedules(window.__tlBefore, live, week, q.addDays(week, 7));
    return { identical: d.identical, changed: d.changed.length };
  });
  let where = '';
  if (same !== beforeJson) {
    const a = JSON.parse(beforeJson);
    const b = JSON.parse(same);
    where = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => `${k}: ${JSON.stringify(a[k]).slice(0, 60)} → ${JSON.stringify(b[k]).slice(0, 60)}`).join(' | ');
  }
  record('undoing every edit restores the channel byte-for-byte', same === beforeJson, where);
  record('undo restores the previous week exactly (diffSchedules empty)', diff.identical, JSON.stringify(diff));
});

// ---------- breaks, sign-off, plugin-owned, BLOCKS editor ----------
await step('breaks and sign-off', async () => {
  await openOnAir(pick.ads);
  const ads = `#channel-${pick.ads}-schedule-panel`;
  const target = await page.evaluate((sel) => {
    const row = Array.from(document.querySelectorAll(`${sel} .onair-row[data-day-start]`)).find((r) => r.querySelector('.onair-break'));
    if (!row) return null;
    const brk = row.querySelector('.onair-break');
    const at = Number(row.dataset.dayStart) + (parseFloat(brk.style.left) / row.querySelector('.onair-day').getBoundingClientRect().width) * 86400000;
    const prog = Array.from(row.querySelectorAll('.onair-program')).find((p) => Number(p.dataset.start) <= at && Number(p.dataset.end) > at);
    prog.scrollIntoView({ inline: 'center', block: 'center' });
    const r = prog.getBoundingClientRect();
    // The visible part of the program: not under the sticky day label, not past the scroller.
    const sr = row.closest('.onair-scroller').getBoundingClientRect();
    const left = Math.max(r.left, sr.left + 100);
    const right = Math.min(r.right, sr.right - 10);
    return { x: (left + right) / 2, y: r.top + r.height / 2 };
  }, ads);
  if (!target) { record('CH with breaks has a program with a break', false); return; }
  const breaksBefore = await page.locator(`${ads} .onair-break`).count();
  await page.mouse.click(target.x, target.y, { button: 'right' });
  await wait(150);
  const item = page.locator('.row-menu .row-menu-item', { hasText: /ad breaks in this show/ });
  const disabled = await item.isDisabled();
  if (disabled) {
    record('"No ad breaks in this show" explains why it can\'t (a flow decides)', /FLOWS|Ads are off/.test(await item.getAttribute('title') || ''), await item.getAttribute('title'));
    await page.keyboard.press('Escape');
  } else {
    await item.click();
    await waitResolved(pick.ads);
    const breaksAfter = await page.locator(`${ads} .onair-break`).count();
    record('"No ad breaks in this show" removes that show\'s breaks', breaksAfter < breaksBefore, `${breaksBefore} → ${breaksAfter}`);
    await page.keyboard.press('Control+z');
    await wait(600);
  }

  await openOnAir(pick.ads);
  await page.locator(`${ads} .onair-signoff-btn`).click();
  await page.locator(`${ads} .onair-editor input[type="checkbox"]`).check();
  await wait(300);
  const preview = await page.locator(`${ads} .onair-editor-preview`).textContent();
  record('SIGN-OFF HOURS previews before applying, naming the sign-off hours', /changes .*sign-off hours on \d+ day/.test(preview), preview);
  await page.locator(`${ads} .onair-editor-actions .btn-primary`).click();
  await waitResolved(pick.ads);
  record('applying draws the signed-off stretches', await page.locator(`${ads} .onair-offair`).count() >= 7);
  const label = await page.evaluate(async () => (await import('app://bundle/renderer/js/core/state.js')).undoLabel());
  record('broadcast hours are one named undo step', /^Sign CH/.test(label || ''), label);
  await page.keyboard.press('Control+z');
  await wait(600);

  // A preset a plugin owns is explained, not editable.
  await page.evaluate(async (n) => {
    const { S, bumpConfigGeneration } = await import('app://bundle/renderer/js/core/state.js');
    S.config.interstitials.presets.unshift({ id: 'tl-plugin-preset', pluginId: 'weather-channel', name: 'Weather breaks', enabled: true, channels: [n], contentTags: [], timing: 'interval', intervalMinutes: 15 });
    bumpConfigGeneration();
  }, pick.ads);
  await openOnAir(pick.ads);
  await page.locator(`${ads} .onair-program`).first().click();
  const owned = await page.locator(`${ads} .onair-layer[data-item-id="tl-plugin-preset"] .onair-layer-owned`).textContent().catch(() => '');
  record('a plugin-owned preset is explained with its owner and no edit button', /WEATHER-CHANNEL/.test(owned) && await page.locator(`${ads} .onair-layer[data-item-id="tl-plugin-preset"] .onair-layer-edit`).count() === 0, owned);
  await page.evaluate(async () => {
    const { S, bumpConfigGeneration } = await import('app://bundle/renderer/js/core/state.js');
    S.config.interstitials.presets = S.config.interstitials.presets.filter((p) => p.id !== 'tl-plugin-preset');
    bumpConfigGeneration();
  });

  // BLOCKS: the broadcast-hours checkbox is now a named, undoable edit.
  await page.locator(`#channel-${pick.ads}-schedule-tab-blocks`).click();
  await wait(300);
  const box = page.locator(`${ads} label.shuffle-toggle`, { hasText: 'BROADCAST HOURS' }).locator('input');
  await box.click();
  await wait(200);
  const blocksLabel = await page.evaluate(async () => (await import('app://bundle/renderer/js/core/state.js')).undoLabel());
  record('BLOCKS broadcast-hours toggle records an undo step', /^Sign CH|^Broadcast CH/.test(blocksLabel || ''), blocksLabel);
  await page.keyboard.press('Control+z');
  await wait(400);
});

// ---------- TV mode: read-only week, remote navigation ----------
await step('tv mode', async () => {
  await page.evaluate(async () => { (await import('app://bundle/renderer/js/tv/usage-mode.js')).setUsageModePreference('tv'); });
  await openOnAir(num);
  record('TV mode: read-only (no SIGN-OFF HOURS, no edge handles)', await page.locator(`${panelSel}.onair-readonly`).count() === 1 && await page.locator(`${panelSel} .onair-signoff-btn`).count() === 0 && await page.locator(`${panelSel} .onair-span-edge`).count() === 0);
  await page.locator(`${panelSel} .onair-program[tabindex="0"]`).focus();
  const at = () => page.evaluate(() => { const a = document.activeElement; return a && a.classList.contains('onair-program') ? { start: Number(a.dataset.start), day: Number(a.dataset.day) } : null; });
  const first = await at();
  await page.keyboard.press('ArrowRight');
  const right = await at();
  await page.keyboard.press('ArrowDown');
  const down = await at();
  record('◄► moves along a day, ▲▼ across days', first && right && down && right.start > first.start && down.day > right.day, JSON.stringify({ first, right, down }));
  await page.keyboard.press('Enter');
  await wait(150);
  record('OK explains the focused program', await page.locator(`${panelSel} .onair-layer`).count() > 0);
  const weekBefore = await page.locator(`${panelSel} .onair-week-label`).textContent();
  await page.keyboard.press('PageUp');
  await waitResolved(num);
  await wait(200);
  const weekAfter = await page.locator(`${panelSel} .onair-week-label`).textContent();
  record('CH+ / green pages to the next week and keeps focus in the grid', weekAfter !== weekBefore && await page.evaluate(() => document.activeElement.classList.contains('onair-program')), `${weekBefore} → ${weekAfter}`);
  await shot('tv-mode');
  await page.evaluate(async () => { (await import('app://bundle/renderer/js/tv/usage-mode.js')).setUsageModePreference('auto'); });
});

await step('screenshot', async () => {
  await openOnAir(num);
  await page.evaluate((sel) => { document.querySelectorAll(`${sel} .onair-program`)[3].click(); }, panelSel);
  await wait(200);
  await page.evaluate((sel) => document.querySelector(`${sel} .onair-scroller`).scrollIntoView({ block: 'start' }), panelSel);
  await shot('onair-desktop-1280');
  await page.evaluate((sel) => document.querySelector(`${sel} .onair-layers`).scrollIntoView({ block: 'center' }), panelSel);
  await shot('onair-layers-1280');
});

record('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await cdp.send('Emulation.clearDeviceMetricsOverride');
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
