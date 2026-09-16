// Scratch: host writes announce config:changed to a paired LAN viewer (doc 05 step 4).
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
const results = [];
const record = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); };
const wait = (ms) => page.waitForTimeout(ms);

await wait(4000);
const viewerUrl = await page.evaluate(async () => (window.api.getViewerUrl ? window.api.getViewerUrl() : null));
const raw = typeof viewerUrl === 'string' ? viewerUrl : (viewerUrl && (viewerUrl.url || (viewerUrl[0] && viewerUrl[0].url))) || JSON.stringify(viewerUrl);
const code = (String(raw).match(/[?&]pair=(\d+)/) || [])[1];
const viewerPort = (String(raw).match(/:(\d{4,5})\//) || [])[1] || '8724';
record('host exposes a viewer pairing link', !!code, String(raw).replace(/pair=\d+/, 'pair=********'));

let token = null;
if (code) {
  const pair = await fetch(`http://127.0.0.1:${viewerPort}/?pair=${code}`, { headers: { Accept: 'application/json' } });
  token = pair.ok ? (await pair.json()).token : null;
}
record('paired a viewer session from Node', !!token);

const events = async (after) => {
  const q = after == null ? '' : `?after=${after}`;
  const res = await fetch(`http://127.0.0.1:${viewerPort}/api/remote-events${q}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
};

if (token) {
  // Let boot-time saves settle, then take a cursor.
  await wait(2500);
  let { cursor } = await events(null);

  // 1. Host-local watching state: tune two channels (lastChannel skipUndo writes) and change volume.
  await page.evaluate(async () => {
    const chans = window.S.config.channels.map((c) => c.number);
    const { tuneToChannel } = await import('app://bundle/renderer/js/playback/core.js');
    await tuneToChannel(chans[1]);
    await new Promise((r) => { setTimeout(r, 900); });
    await tuneToChannel(chans[2]);
    const { adjustVolume } = await import('app://bundle/renderer/js/playback/power.js');
    adjustVolume(-0.1);
  });
  await wait(1800);
  const quiet = await events(cursor);
  const quietChanged = quiet.events.filter((e) => e.channel === 'config:changed').length;
  record('surfing and volume on the host announce nothing to viewers', quietChanged === 0, `${quiet.events.map((e) => e.channel).join(',') || 'no events'}`);
  cursor = quiet.cursor;

  // 2. A real setup edit through a named command.
  const t0 = Date.now();
  await page.evaluate(async () => {
    const st = await import('app://bundle/renderer/js/core/state.js');
    const ch = window.S.config.channels[0];
    st.dispatch({ type: 'channel.rename', channel: ch.number, name: `${ch.name} (push test)` });
  });
  let seenAt = null;
  for (let i = 0; i < 30 && !seenAt; i++) {
    // eslint-disable-next-line no-await-in-loop
    const got = await events(cursor);
    if (got.events.some((e) => e.channel === 'config:changed')) seenAt = Date.now();
    else await wait(100); // eslint-disable-line no-await-in-loop
  }
  record('a setup edit reaches a paired viewer as config:changed within 2 s', !!seenAt && seenAt - t0 < 2000, seenAt ? `${seenAt - t0} ms after the edit (includes the 600 ms save debounce)` : 'never');

  // 3. The viewer's refetch sees the edit through its own redacted projection.
  const cfg = await (await fetch(`http://127.0.0.1:${viewerPort}/api/config`, { headers: { Authorization: `Bearer ${token}` } })).json();
  record('the refetched viewer config has the edit', /\(push test\)$/.test(cfg.channels[0].name), cfg.channels[0].name);

  // 4. Undo is a write too.
  const { cursor: c2 } = await events(null);
  await page.evaluate(async () => { const st = await import('app://bundle/renderer/js/core/state.js'); st.performUndo(); });
  await wait(900);
  const undone = await events(c2);
  record('undo is announced as well', undone.events.some((e) => e.channel === 'config:changed'));
}

record('no renderer page errors', errors.length === 0, errors.slice(0, 4).join(' || '));
await browser.close();
process.exit(results.every((r) => r.ok) ? 0 : 1);
