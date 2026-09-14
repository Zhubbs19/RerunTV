// Scratch: docs/design/02 §5.3 — the rule stack (programming-rules.js) resolves exactly what today's
// layers resolve, for 60 days, on every channel of a copy of the installed config. Also reports how
// much layering the real lineup actually uses, which is the evidence §5.2's gate asks for.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0];
let page = null;
for (let i = 0; i < 60 && !page; i += 1) {
  page = context.pages().find((p) => p.url().includes('renderer/index.html'));
  if (!page) await new Promise((r) => setTimeout(r, 500));
}
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.waitForTimeout(4000);

const report = await page.evaluate(async () => {
  const rules = await import('app://bundle/renderer/js/programming-rules.js');
  const { S } = await import('app://bundle/renderer/js/state.js');
  const DAY = 86400000;
  const from = new Date(Date.now() + S.timeOffsetMs).setHours(0, 0, 0, 0);
  const to = from + 60 * DAY;
  const out = [];
  for (const ch of S.config.channels) {
    const began = performance.now();
    const result = rules.compareRulesToLayers(ch, S.config, from, to, { limit: 5 });
    const programming = rules.rulesFromLayers(ch, S.config);
    out.push({
      number: ch.number,
      name: ch.name,
      ms: Math.round(performance.now() - began),
      rules: programming.rules.map((r) => r.id),
      signOff: programming.signOff,
      blocks: (ch.blocks || []).length,
      instants: result.instants,
      checks: result.checks,
      mismatches: result.mismatches.map((m) => ({ ...m, at: new Date(m.atMs).toString() })),
    });
  }
  const interstitials = S.config.interstitials || {};
  return {
    channels: out,
    flows: (interstitials.flows || []).map((f) => ({ id: f.id, enabled: f.enabled !== false, channels: f.channels || [], tags: f.contentTags || [] })),
    presets: (interstitials.presets || []).map((p) => ({ id: p.id, enabled: p.enabled !== false, channels: p.channels || [], tags: p.contentTags || [] })),
  };
});

fs.writeFileSync('test/rules-equivalence-report.json', JSON.stringify(report, null, 1));
let failed = 0;
for (const c of report.channels) {
  const ok = c.mismatches.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} CH ${c.number} ${c.name || ''}: ${c.checks} checks over ${c.instants} instants in ${c.ms} ms · ${c.rules.length} rules [${c.rules.join(', ')}]${c.signOff ? ` · signs off ${c.signOff.hours.join('–')}` : ''}${ok ? '' : ` · ${JSON.stringify(c.mismatches.slice(0, 2))}`}`);
}
const layered = report.channels.filter((c) => c.rules.length > 1 || c.signOff);
console.log(`flows: ${JSON.stringify(report.flows)}`);
console.log(`presets: ${JSON.stringify(report.presets)}`);
console.log(`channels whose programming uses more than the default rule: ${layered.length}/${report.channels.length}`);
console.log(`channels with blocks: ${report.channels.filter((c) => c.blocks).length}`);
console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');
console.log(failed === 0 && !errors.length ? `PASS all ${report.channels.length} channels equivalent for 60 days` : `FAIL ${failed} channels differ`);
await browser.close();
process.exit(failed === 0 && !errors.length ? 0 : 1);
