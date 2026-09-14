// Scratch: docs/design/02 §4 — the editable ON AIR timeline (lane, editor, layer list, impact bar) meets
// the setup-page contrast rule in every theme. Derived from verify-setup-contrast.mjs.
// Usage: node test/verify-setup-contrast.mjs [--theme=<id>]  (through run-ui-tests.ps1 -Script)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const onlyTheme = process.argv.find((a) => a.startsWith('--theme='))?.split('=')[1] || process.env.CONTRAST_THEME || '';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const wait = (ms) => page.waitForTimeout(ms);
await wait(4000);
await page.evaluate(async () => { if (window.api?.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } } });
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1200);

let themes = await page.evaluate(() => Array.from(document.querySelectorAll('#theme-select option')).map((o) => o.value).filter(Boolean));
if (onlyTheme) themes = themes.filter((t) => t === onlyTheme);
const pages = [['onair', null]];
// Scratch blocks (a real one and one with no folder) so the lane, AIRS / OUTRANKED / SKIPPED
// layer rows all render; the userData is a throwaway copy.
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
const num = await page.evaluate(async () => {
  const { dispatch } = await import('app://bundle/renderer/js/state.js');
  const ch = window.S.config.channels.slice().sort((a, b) => a.number - b.number).find((c) => c.files.length > 20);
  const at = new Date(Date.now() + window.S.timeOffsetMs);
  const day = at.getDay();
  const hour = at.getHours();
  dispatch([
    { type: 'block.create', channel: ch.number, block: { id: 'contrast-a', name: 'Contrast Block', priority: 1, mode: 'loop', anchor: Date.now(), trigger: { type: 'dayOfWeek', startHour: hour, endHour: (hour + 3) % 24, days: [day] }, files: ch.files.slice(0, 5), dayOverrides: {} } },
    { type: 'block.create', channel: ch.number, block: { id: 'contrast-b', name: 'Filler', priority: 0, mode: 'loop', anchor: Date.now(), trigger: { type: 'dayOfWeek', startHour: 0, endHour: 0, days: [] }, files: ch.files.slice(5, 9), dayOverrides: {} } },
    { type: 'block.create', channel: ch.number, block: { id: 'contrast-c', name: 'No Folder', priority: 2, trigger: { type: 'dayOfWeek', startHour: hour, endHour: (hour + 1) % 24, days: [] }, files: [] } },
  ], { label: 'contrast scratch' });
  return ch.number;
});
await page.locator(`#channel-list-pane .channel-list-item[data-channel-number="${num}"]`).click();
await wait(500);
await page.locator(`#channel-${num}-edit-tab-schedule`).click();
await wait(300);
await page.locator(`#channel-${num}-schedule-tab-onair`).click();
for (let i = 0; i < 100; i += 1) {
  if (((await page.locator(`#channel-${num}-schedule-panel .onair-status`).textContent()) || '').startsWith('Resolved')) break;
  await wait(100);
}
await page.evaluate((n) => {
  const panel = document.getElementById(`channel-${n}-schedule-panel`);
  const now = Date.now() + window.S.timeOffsetMs;
  const prog = Array.from(panel.querySelectorAll('.onair-row.today .onair-program')).find((p) => Number(p.dataset.start) <= now && Number(p.dataset.end) > now);
  (prog || panel.querySelector('.onair-program')).click();
  panel.querySelector('.onair-signoff-btn').click();
}, num);
await wait(400);

const report = {};
for (const theme of themes) {
  await page.evaluate((id) => { window.S.config.theme = id; document.documentElement.dataset.theme = id; }, theme);
  await wait(250);
  const failures = new Map();
  for (const [tab, sub] of pages) {
    await wait(150);
    const found = await page.evaluate((where) => {
      const parse = (v) => {
        // color-mix() computes to color(srgb r g b / a) with 0–1 channels.
        const srgb = String(v || '').match(/color\(srgb ([^)]+)\)/i);
        if (srgb) { const q = srgb[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: q[0] * 255, g: q[1] * 255, b: q[2] * 255, a: Number.isFinite(q[3]) ? q[3] : 1 }; }
        const m = String(v || '').match(/rgba?\(([^)]+)\)/i);
        if (!m) return null;
        const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: Number.isFinite(p[3]) ? p[3] : 1 };
      };
      const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
      const lum = (c) => {
        const f = (x) => { const s = x / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      // The colours behind an element: its nearest painted backgrounds, with
      // gradient stops as separate candidates (the worst one counts).
      const backgrounds = (el) => {
        const layers = [];
        for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
          const cs = getComputedStyle(node);
          const stops = [...String(cs.backgroundImage || '').matchAll(/rgba?\([^)]+\)/gi)].map((m) => parse(m[0])).filter(Boolean);
          const color = parse(cs.backgroundColor);
          if (stops.length) layers.push({ stops });
          else if (color && color.a > 0) layers.push({ stops: [color] });
          if ((color && color.a >= 0.99) || (stops.length && stops.every((s) => s.a >= 0.99))) break;
        }
        let candidates = [{ r: 0, g: 0, b: 0, a: 1 }];
        for (let i = layers.length - 1; i >= 0; i -= 1) {
          const next = [];
          layers[i].stops.forEach((stop) => candidates.forEach((base) => next.push(over(stop, base))));
          candidates = next.slice(0, 12);
        }
        return candidates;
      };
      const out = [];
      const root = document.querySelector('.onair-panel');
      root.querySelectorAll('*').forEach((el) => {
        if (el.offsetParent === null || el.closest('.is-disabled, [disabled], .channel-badge, .theme-browser, .logobug-preview, svg, canvas, video, img, option')) return;
        const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
        if (text.length < 2) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.99) return;
        let fg = parse(cs.color);
        if (!fg) return;
        let opacity = 1;
        for (let n = el.parentElement; n; n = n.parentElement) opacity *= parseFloat(getComputedStyle(n).opacity) || 1;
        fg = { ...fg, a: fg.a * opacity };
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        const need = large ? 3 : 4.5;
        const worst = Math.min(...backgrounds(el).map((bg) => ratio(over(fg, bg), bg)));
        if (worst < need) {
          const key = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join('')}`;
          out.push({ key, ratio: Math.round(worst * 100) / 100, need, where, sample: text.slice(0, 40) });
        }
      });
      return out;
    }, sub ? `${tab}/${sub}` : tab);
    found.forEach((f) => {
      const prev = failures.get(f.key);
      if (!prev || f.ratio < prev.ratio) failures.set(f.key, { ...f, count: (prev?.count || 0) + 1 });
      else prev.count += 1;
    });
  }
  report[theme] = [...failures.values()].sort((a, b) => a.ratio - b.ratio);
  console.log(`THEME ${theme}: ${report[theme].length} failing text styles${report[theme].length ? ` — worst ${report[theme].slice(0, 4).map((f) => `${f.key} ${f.ratio} (${f.where} "${f.sample}")`).join(' | ')}` : ''}`);
}
fs.writeFileSync('test/onair-contrast-report.json', JSON.stringify(report, null, 1));
const layerKinds = await page.evaluate(() => Array.from(document.querySelectorAll('.onair-layer')).map((r) => r.className.match(/role-(\w+)/)[1]));
console.log('layer roles on screen:', layerKinds.join(' '), '· editor open:', await page.evaluate(() => !document.querySelector('.onair-editor').hidden), '· spans:', await page.locator('.onair-span').count());
const total = Object.values(report).reduce((n, list) => n + list.length, 0);
console.log(total === 0 ? 'PASS every theme meets body-text contrast on ON AIR' : `FAIL ${total} failing text styles across ${Object.values(report).filter((l) => l.length).length} themes`);
await browser.close();
process.exit(total === 0 ? 0 : 1);
