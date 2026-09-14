// Scratch: doc 05 step 5 — setup-settings and TITLES-panel edits are named
// commands through their real listeners, against the real config.
import { chromium } from 'playwright-core';

const port = process.argv[2] || '9222';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
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

await wait(3500);
await page.evaluate(async () => {
  if (window.api && window.api.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } }
});
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();
await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await wait(1800);

const out = await page.evaluate(async () => {
  const st = await import('app://bundle/renderer/js/state.js');
  const panels = await import('app://bundle/renderer/js/setup-panels.js');
  const S = window.S;
  const r = {};
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
  st.resetUndoBaseline();
  const original = JSON.stringify(S.config);

  // --- settings: a checkbox, a slider drag, a two-field reset, the PIN ---
  const clock = document.getElementById('clock24-enabled');
  clock.checked = !clock.checked; fire(clock, 'change');
  r.clockLabel = st.undoLabel();
  r.clockValue = S.config.display.clock24 === clock.checked;

  const slider = document.getElementById('ad-volume-slider');
  const startVol = S.config.adVolume;
  for (const v of [10, 20, 30, 40]) { slider.value = String(v); fire(slider, 'input'); }
  r.sliderLabel = st.undoLabel();
  r.sliderValue = S.config.adVolume;
  st.performUndo();
  r.sliderUndoneInOneStep = S.config.adVolume === startVol && st.undoLabel() === r.clockLabel;

  const hint = document.getElementById('hintbar-show-duration');
  if (hint) { hint.value = '450'; fire(hint, 'input'); r.hintLabel = st.undoLabel(); r.hintText = document.getElementById('hintbar-show-duration-val')?.textContent; }

  const reset = document.getElementById('no-signal-copy-reset');
  S.config.display.noSignalTitle = S.config.display.noSignalTitle || '';
  if (reset) { reset.click(); r.resetLabel = st.undoLabel(); }

  // --- TITLES panel on the channel with the most files ---
  const ch = S.config.channels.filter((c) => Array.isArray(c.files) && c.files.length >= 3)
    .sort((a, b) => b.files.length - a.files.length)[0];
  r.channel = ch && ch.number;
  r.fileCount = ch && ch.files.length;
  const host = document.createElement('div');
  panels.buildTitlesPanel(ch, host);
  const rows = host.querySelectorAll('.title-row');
  r.rows = rows.length;
  const firstTitle = rows[0].querySelector('input.title-row-input');
  const f0 = ch.files[0];
  const oldTitle = f0.title;
  for (const text of ['E', 'Ep', 'Ep 1']) { firstTitle.value = text; fire(firstTitle, 'input'); }
  r.typeLabel = st.undoLabel();
  r.typedTitle = f0.title;

  const rowWrap = rows[0].parentElement;
  const rating = rowWrap.querySelector('select.rating-select');
  rating.value = 'TV-PG'; fire(rating, 'change');
  r.ratingLabel = st.undoLabel();

  // Bulk: select everything visible, then add a tag.
  const selectAll = [...host.querySelectorAll('button')].find((b) => b.textContent === 'SELECT VISIBLE');
  selectAll.click();
  const tagInput = [...host.querySelectorAll('input')].find((i) => i.placeholder === 'TAGS TO ADD (COMMA-SEP)');
  tagInput.value = 'step5-verify';
  const t0 = performance.now();
  [...host.querySelectorAll('button')].find((b) => b.textContent === 'ADD TAG(S) TO SELECTED').click();
  r.bulkMs = Math.round(performance.now() - t0);
  r.bulkLabel = st.undoLabel();
  r.bulkTagged = ch.files.every((f) => (f.tags || []).includes('step5-verify'));
  st.performUndo();
  r.bulkUndone = ch.files.every((f) => !(f.tags || []).includes('step5-verify'));

  // Facet edit keeps tags mirrored, as one step.
  const facetsRow = rowWrap.querySelector('.title-row-facets');
  const era = facetsRow && [...facetsRow.querySelectorAll('input')].find((i) => i.placeholder.startsWith('ERA'));
  if (era) {
    era.value = '1990s'; fire(era, 'change');
    r.facetLabel = st.undoLabel();
    r.facetMirrored = f0.facets && f0.facets.era === '1990s' && (f0.tags || []).includes('1990s');
  }

  // Undo everything and compare.
  let guard = 0;
  while (st.canUndo() && guard++ < 60) st.performUndo();
  r.titleRestored = f0.title === oldTitle;
  await sleep(900);
  r.identicalAfterUndo = JSON.stringify(S.config) === original;
  return r;
});

console.log(JSON.stringify(out, null, 1));
record('a settings checkbox is a named step', out.clockLabel === 'Change display clock24' && out.clockValue, out.clockLabel);
record('a slider drag is one step and undoes in one', out.sliderUndoneInOneStep && out.sliderLabel === 'Change commercial volume', `${out.sliderLabel}`);
record('hint bar duration reads back into its label', !out.hintLabel || (out.hintLabel === 'Change display hint bar show duration' && out.hintText === '450ms'), `${out.hintLabel} ${out.hintText}`);
record('the no-signal reset is one labelled step', !out.resetLabel || out.resetLabel === 'Reset no-signal message', out.resetLabel);
record('typing a file title is one file.set step', out.typeLabel === `Change CH ${out.channel} file title` && out.typedTitle === 'Ep 1', out.typeLabel);
record('a per-file rating is its own step', out.ratingLabel === `Change CH ${out.channel} file rating`, out.ratingLabel);
record(`bulk-tagging ${out.fileCount} files is one step, and undoes`, out.bulkTagged && out.bulkUndone && /^Tag \d+ files?$/.test(out.bulkLabel), `${out.bulkLabel} in ${out.bulkMs} ms`);
record('a facet edit mirrors into tags in one step', out.facetLabel === undefined || (out.facetMirrored && out.facetLabel === `Change CH ${out.channel} file details`), `${out.facetLabel}`);
record('undoing everything leaves config byte-identical', out.identicalAfterUndo && out.titleRestored);
record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
