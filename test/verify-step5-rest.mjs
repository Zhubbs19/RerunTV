// Scratch: doc 05 step 5 round 3 — channel list, schedule blocks, per-channel
// panels, TV-screen toggles and labelled whole-config patches, through real
// listeners against the real config.
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
page.on('console', (m) => { if (m.type() === 'error' || (m.type() === 'warning' && /\[history\]/.test(m.text()))) errors.push(`[${m.type()}] ${m.text()}`); });
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);

await wait(3500);
await page.evaluate(async () => {
  if (window.api && window.api.getPostUpdateNotice) { try { await window.api.getPostUpdateNotice(); } catch (e) { /* none */ } }
});
await wait(300);
if (await page.locator('#update-changelog:not(.hidden)').count()) await page.locator('#update-changelog-done').click();

// TV-screen toggles first: they are watching state and must add no steps.
const tv = await page.evaluate(async () => {
  const st = await import('app://bundle/renderer/js/state.js');
  const power = await import('app://bundle/renderer/js/power.js');
  const r = {};
  st.resetUndoBaseline();
  const vol = window.S.config.volume;
  power.toggleMute();
  power.adjustVolume(-0.05);
  power.cyclePictureMode();
  r.stepsAfterToggles = st.canUndo();
  r.volumeChanged = window.S.config.volume !== vol;
  power.toggleMute();
  power.adjustVolume(0.05);
  for (let i = 0; i < 10 && window.S.config.pictureMode !== undefined; i++) {
    power.cyclePictureMode();
    if (window.S.config.pictureMode === r.pic0) break;
  }
  return r;
});
record('mute, volume and picture mode from the TV add no undo steps', tv.stepsAfterToggles === false && tv.volumeChanged, JSON.stringify(tv));

await page.evaluate(async () => { const { showSetupScreen } = await import('app://bundle/renderer/js/app.js'); await showSetupScreen(); });
await page.locator('.setup-tab-btn[data-tab="channels"]').click();
await wait(1500);

const out = await page.evaluate(async () => {
  const st = await import('app://bundle/renderer/js/state.js');
  const sched = await import('app://bundle/renderer/js/setup-schedule.js');
  const panels = await import('app://bundle/renderer/js/setup-panels.js');
  const S = window.S;
  const r = {};
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
  const sleep = (ms) => new Promise((res) => { setTimeout(res, ms); });
  st.resetUndoBaseline();
  const original = JSON.stringify(S.config);
  const sorted = () => S.config.channels.slice().sort((a, b) => a.number - b.number);

  // --- channel list: swap with the channel below ---
  const [first, second] = sorted();
  const a = first.number; const b = second.number; const firstName = first.name;
  const row = document.querySelector(`.channel-row[data-channel-number="${a}"]`);
  const down = row && row.querySelector('button[title="Swap with the channel below"]');
  if (down) {
    down.click();
    r.swapLabel = st.undoLabel();
    r.swapped = S.config.channels.find((c) => c.name === firstName && c.number === b) != null;
  }

  // --- add a channel, bulk-favorite two, remove it again by bulk remove path via undo ---
  const before = S.config.channels.length;
  document.getElementById('add-channel-btn').click();
  r.addLabel = st.undoLabel();
  r.added = S.config.channels.length === before + 1;

  // --- schedule blocks on the first channel ---
  const ch = sorted()[0];
  const host = document.createElement('div');
  sched.buildSchedulePanel(ch, host);
  const blocksBefore = (ch.blocks || []).length;
  const presetItem = host.querySelector('.block-add-menu-item');
  presetItem.click();
  r.addBlockLabel = st.undoLabel();
  r.blockAdded = (ch.blocks || []).length === blocksBefore + 1;
  const card = [...host.querySelectorAll('.block-card')].pop();
  const blockName = card && card.querySelector('input[placeholder="LABEL (E.G. HOLIDAY SPECIAL)"]');
  const block = ch.blocks[ch.blocks.length - 1];
  if (blockName) {
    for (const t of ['H', 'Ho', 'Holiday']) { blockName.value = t; fire(blockName, 'input'); }
    r.blockNameLabel = st.undoLabel();
    r.blockName = block.name;
  }
  const priority = card && card.querySelector('input.block-priority-input');
  if (priority) {
    priority.value = '7'; fire(priority, 'change');
    r.priorityLabel = st.undoLabel();
    r.sameBlockObject = ch.blocks.includes(block) && block.priority === 7;
  }

  // --- a block's ADS panel (inherit toggle), recorded on the block ---
  const adsHost = document.createElement('div');
  panels.buildCommercialsPanel(block, adsHost, { allowInherit: true, onChange: () => {} });
  const inherit = adsHost.querySelector('input[type=checkbox]');
  if (inherit) {
    inherit.checked = !inherit.checked; fire(inherit, 'change');
    r.adsLabel = st.undoLabel();
  }

  // --- credits speedup on the channel ---
  const creditsHost = document.createElement('div');
  panels.buildCreditsSpeedupPanel(ch, creditsHost);
  const creditsBox = creditsHost.querySelector('input[type=checkbox]');
  if (creditsBox) {
    creditsBox.checked = !creditsBox.checked; fire(creditsBox, 'change');
    r.creditsLabel = st.undoLabel();
  }

  // --- a labelled whole-config patch ---
  S.config.channels.forEach((c) => { c.contentTags = [...(c.contentTags || []), 'step5-rest']; });
  st.commitConfigPatch('Tag every channel');
  r.patchLabel = st.undoLabel();

  let guard = 0;
  while (st.canUndo() && guard++ < 80) st.performUndo();
  await sleep(900);
  const after = JSON.parse(JSON.stringify(S.config));
  const orig = JSON.parse(original);
  r.identicalAfterUndo = JSON.stringify(after) === original;
  if (!r.identicalAfterUndo) {
    r.diffKeys = Object.keys(orig).filter((k) => JSON.stringify(orig[k]) !== JSON.stringify(after[k]));
  }
  return r;
});

console.log(JSON.stringify(out, null, 1));
record('swapping with the channel below is a named step', out.swapped && /^Swap CH /.test(out.swapLabel), out.swapLabel);
record('adding a channel is "Add CH n"', out.added && /^Add CH /.test(out.addLabel), out.addLabel);
record('adding a preset block is a labelled insert', out.blockAdded && /block$/.test(out.addBlockLabel), out.addBlockLabel);
record('typing a block name coalesces into one "Change block name"', out.blockName === 'Holiday' && out.blockNameLabel === 'Change block name', out.blockNameLabel);
record('a block edit keeps the live block object', out.sameBlockObject && out.priorityLabel === 'Change block priority', out.priorityLabel);
record('the block ADS panel records on the block', out.adsLabel === undefined || out.adsLabel === 'Change block commercials', `${out.adsLabel}`);
record('credits speedup records a channel field', out.creditsLabel === undefined || /^Change CH \d+(\.\d+)? credits speedup$/.test(out.creditsLabel), `${out.creditsLabel}`);
record('a whole-config transform is one labelled step', out.patchLabel === 'Tag every channel', out.patchLabel);
record('undoing everything leaves config byte-identical', out.identicalAfterUndo, JSON.stringify(out.diffKeys || []));
record('no renderer page errors or history fallbacks', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
