// Scratch: doc 05 step 5 round 2 — ad pool, presets and flow builder edits
// are id-addressed item commands, through their real listeners and real config.
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
  const inter = await import('app://bundle/renderer/js/setup-interstitials.js');
  const flows = await import('app://bundle/renderer/js/setup-interstitials-flowbuilder.js');
  const S = window.S;
  const r = {};
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const $ = (id) => document.getElementById(id);
  const byText = (root, sel, text) => [...root.querySelectorAll(sel)].find((el) => el.textContent.trim() === text);
  const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
  inter.renderInterstitialsList();
  inter.renderPresetsList();
  flows.renderFlowsList();
  st.resetUndoBaseline();
  const original = JSON.stringify(S.config);
  r.poolSize = S.config.interstitials.pool.length;
  r.presetCount = S.config.interstitials.presets.length;
  r.flowCount = (S.config.interstitials.flows || []).length;

  // --- ad pool: add, edit (opens expanded), weight, text burst, remove ---
  $('interstitials-add-entry-btn').click();
  r.addLabel = st.undoLabel();
  const added = S.config.interstitials.pool[S.config.interstitials.pool.length - 1];
  r.added = S.config.interstitials.pool.length === r.poolSize + 1;
  const card = $('interstitials-detail').querySelector('.interstitial-card.open');
  const weight = card && card.querySelector('input[title="How often this entry is picked relative to others"]');
  if (weight) {
    const liveEntry = added;
    weight.value = '4'; fire(weight, 'change');
    r.weightLabel = st.undoLabel();
    r.weightInPlace = S.config.interstitials.pool.includes(liveEntry) && liveEntry.weight === 4;
  }
  st.performUndo(); // weight
  r.weightUndone = added.weight === 1;
  st.performUndo(); // add
  r.addUndone = S.config.interstitials.pool.length === r.poolSize && !S.config.interstitials.pool.some((e) => e.id === added.id);
  st.performRedo();
  r.addRedone = S.config.interstitials.pool.some((e) => e.id === added.id);
  st.performUndo();

  // Bulk tag every entry in the real pool, then remove two, as one step each.
  inter.renderInterstitialsList();
  if (!$('interstitials-bulk-toggle-btn').classList.contains('active')) $('interstitials-bulk-toggle-btn').click();
  $('interstitials-bulk-select-all-btn').click();
  $('interstitials-bulk-tag-input').value = 'step5-lists';
  $('interstitials-bulk-tag-apply-btn').click();
  r.bulkTagLabel = st.undoLabel();
  r.bulkTagged = S.config.interstitials.pool.filter((e) => (e.contentTags || []).includes('step5-lists')).length;
  st.performUndo();
  r.bulkTagUndone = !S.config.interstitials.pool.some((e) => (e.contentTags || []).includes('step5-lists'));

  // --- presets: add, rename by typing, remove via dispatch path is exercised by undo ---
  $('presets-add-btn').click();
  const preset = S.config.interstitials.presets[S.config.interstitials.presets.length - 1];
  const presetCard = $('presets-detail').querySelector('.interstitial-card.open');
  const nameInput = presetCard && presetCard.querySelector('input[placeholder="e.g. 30-MIN CARTOON, 2 EPS"]');
  if (nameInput) {
    for (const t of ['S', 'St', 'Step5']) { nameInput.value = t; fire(nameInput, 'input'); }
    r.presetNameLabel = st.undoLabel();
    r.presetName = preset.name;
  }
  st.performUndo();
  st.performUndo();
  r.presetUndone = S.config.interstitials.presets.length === r.presetCount;

  // --- flows: add a step, edit its name, move, cadence toggle, undo all ---
  const flow = (S.config.interstitials.flows || []).find((f) => f.id === $('flow-template-select').value) || S.config.interstitials.flows[0];
  const stepsBefore = (flow.steps || []).length;
  $('flow-add-pod-btn').click();
  r.addStepLabel = st.undoLabel();
  r.stepAdded = flow.steps.length === stepsBefore + 1;
  const cadenceBox = $('flow-cadence-container') && $('flow-cadence-container').querySelector('input[type=checkbox]');
  if (cadenceBox) {
    const cadenceObj = flow.cadence;
    cadenceBox.checked = !cadenceBox.checked; fire(cadenceBox, 'change');
    r.cadenceLabel = st.undoLabel();
    r.cadenceSameObject = flow.cadence === cadenceObj;
  }
  const leftBtns = $('flow-timeline-canvas') ? [...$('flow-timeline-canvas').querySelectorAll('button[aria-label="Move step earlier"]')] : [];
  const lastLeft = leftBtns[leftBtns.length - 1];
  if (lastLeft && !lastLeft.disabled) {
    const lastId = flow.steps[flow.steps.length - 1].id;
    lastLeft.click();
    r.moved = flow.steps[flow.steps.length - 2].id === lastId;
  }
  const flowName = $('flow-name-input');
  const oldFlowName = flow.name;
  for (const t of ['X', 'XY']) { flowName.value = t; fire(flowName, 'input'); }
  r.flowNameLabel = st.undoLabel();
  r.flowName = flow.name;

  let guard = 0;
  while (st.canUndo() && guard++ < 60) st.performUndo();
  r.flowNameRestored = flow.name === oldFlowName;
  r.stepsRestored = flow.steps.length === stepsBefore;
  await sleep(900);
  r.identicalAfterUndo = JSON.stringify(S.config) === original;
  if (!r.identicalAfterUndo) {
    const a = JSON.parse(original); const b = S.config;
    r.diffKeys = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  }
  return r;
});

console.log(JSON.stringify(out, null, 1));
record('adding an ad pool entry is an undoable "Add ad pool entry"', out.added && out.addLabel === 'Add ad pool entry' && out.addUndone && out.addRedone, out.addLabel);
record('editing an entry records item.set and keeps the live entry object', out.weightLabel === 'Change ad pool entry weight' && out.weightInPlace && out.weightUndone, out.weightLabel);
record(`bulk-tagging the pool (${out.poolSize} entries) is one step and undoes`, out.bulkTagged === out.poolSize && out.bulkTagUndone && /^Tag \d+ ad pool entr/.test(out.bulkTagLabel), `${out.bulkTagLabel}`);
record('typing a preset name is one step; the added preset undoes away', out.presetNameLabel === 'Change ad preset name' && out.presetName === 'Step5' && out.presetUndone, out.presetNameLabel);
record('adding a flow step is a labelled step', out.stepAdded && out.addStepLabel === 'Add Mid-Roll Commercial Pod', out.addStepLabel);
record('a cadence edit keeps the cadence object the panel holds', out.cadenceLabel === undefined || (out.cadenceLabel === 'Change flow cadence' && out.cadenceSameObject), `${out.cadenceLabel}`);
record('moving a step works through the same path', out.moved !== false, String(out.moved));
record('typing a flow name coalesces', out.flowNameLabel === 'Change flow name' && out.flowName === 'XY', out.flowNameLabel);
record('undoing everything leaves config byte-identical', out.identicalAfterUndo && out.flowNameRestored && out.stepsRestored, JSON.stringify(out.diffKeys || []));
record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
