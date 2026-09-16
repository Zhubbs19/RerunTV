// Scratch: docs/design/03 §9 — body text on setup pages meets 4.5:1 (3:1 for large text) in every theme.
// Usage: node tests/ui/verify-setup-contrast.mjs [--theme=<id>]  (through run-ui-tests.ps1 -Script)
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
const pages = [
  ['channels', null], ['programming', 'presets'], ['programming', 'pool'], ['library', 'librarysync'], ['display', 'picture'],
  ['guide', null], ['household', null], ['audio', 'system'], ['audio', 'backups'], ['audio', 'status'], ['plugins', 'installed'], ['help', 'guide'],
];

const report = {};
for (const theme of themes) {
  await page.evaluate((id) => { window.S.config.theme = id; document.documentElement.dataset.theme = id; }, theme);
  await wait(250);
  const failures = new Map();
  for (const [tab, sub] of pages) {
    await page.locator(`.setup-tab-btn[data-tab="${tab}"]`).click();
    if (sub) await page.locator(`.setup-tab-panel[data-tab-panel="${tab}"] .setup-subtab-btn[data-subtab="${sub}"]`).click();
    await wait(350);
    // A tab panel caught mid fade-in scores its text at alpha 0–0.6 (seen when the app is busy);
    // wait for every finite animation to settle before measuring.
    await page.evaluate(() => Promise.race([
      Promise.all(document.getAnimations().filter((a) => Number.isFinite(a.effect?.getTiming?.().iterations)).map((a) => a.finished.catch(() => {}))),
      new Promise((r) => setTimeout(r, 5000)),
    ]));
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
          const stops = [...String(cs.backgroundImage || '').matchAll(/rgba?\([^)]+\)|color\(srgb [^)]+\)/gi)].map((m) => parse(m[0])).filter(Boolean);
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
      const root = document.getElementById('setup-screen');
      root.querySelectorAll('*').forEach((el) => {
        if (el.offsetParent === null || el.closest('.is-disabled, [disabled], .channel-badge, .theme-browser, .logobug-preview, svg, canvas, video, img, option')) return;
        const text = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
        if (text.length < 2) return;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
        let fg = parse(cs.color);
        if (!fg) return;
        // The element's own opacity dims its text as much as an ancestor's does.
        let opacity = 1;
        for (let n = el; n; n = n.parentElement) { const o = parseFloat(getComputedStyle(n).opacity); opacity *= Number.isFinite(o) ? o : 1; }
        fg = { ...fg, a: fg.a * opacity };
        const size = parseFloat(cs.fontSize);
        const bold = parseInt(cs.fontWeight, 10) >= 700;
        const large = size >= 24 || (bold && size >= 18.66);
        const need = large ? 3 : 4.5;
        const scored = backgrounds(el).map((bg) => ({ bg, r: ratio(over(fg, bg), bg) })).sort((a, b) => a.r - b.r)[0];
        const worst = scored.r;
        if (worst < need) {
          const key = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join('')}`;
          const hex = (c) => `#${[c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
          out.push({ key, ratio: Math.round(worst * 100) / 100, need, where, sample: text.slice(0, 40), fg: `${hex(fg)}@${Math.round(fg.a * 100) / 100}`, bg: hex(scored.bg), color: cs.color });
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
fs.writeFileSync('tests/ui/setup-contrast-report.json', JSON.stringify(report, null, 1));
const total = Object.values(report).reduce((n, list) => n + list.length, 0);
console.log(total === 0 ? 'PASS every theme meets body-text contrast on setup pages' : `FAIL ${total} failing text styles across ${Object.values(report).filter((l) => l.length).length} themes`);
await browser.close();
process.exit(total === 0 ? 0 : 1);
