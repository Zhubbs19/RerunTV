// End-to-end check of the companion app's server contract, against a real
// running box: pairs the way a phone does (the pairing code the box itself
// publishes), then exercises the routes the phone UI depends on.
//
// Launched by run-ui-tests.ps1 -Script verify-companion-app.mjs with the
// INSTALLED app's userData as -UserDataSource — the companion plugin has to
// be enabled and approved, which a fresh profile has not done.
//
// The HTTP calls run here in Node rather than in the page: the renderer's
// origin is app://, so a cross-origin fetch to the companion's port could
// not read its responses even when authorized.
import path from 'node:path';
import fs from 'node:fs';
import { connectToApp, sleep } from './lib/cdp.mjs';

const PORT = Number(process.argv[2] || 9222);
const OUT_DIR = path.join(process.cwd(), 'test', 'companion-out');
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function evalJs(session, body) {
  return session.evaluate(`(async () => { ${body} })()`, { awaitPromise: true });
}

let cookie = '';
async function get(base, route) {
  const res = await fetch(base + route, { headers: cookie ? { Cookie: cookie } : {} });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not every route answers JSON */ }
  return { status: res.status, text, json, type: res.headers.get('content-type') || '' };
}
async function post(base, route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const session = await connectToApp(PORT);
  const pageErrors = [];
  session.on('Runtime.exceptionThrown', (p) => {
    pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text);
  });

  for (let i = 0; i < 40; i++) {
    if (await session.evaluate(`!!(window.RCBPlugins && window.RCBPlugins.ctx)`)) break;
    await sleep(500);
  }
  await session.evaluate(`const d = document.getElementById('update-changelog-done'); if (d) d.click();`);
  await sleep(500);

  const urls = await evalJs(session, `return (await window.api.getCompanionUrl()) || [];`);
  if (!urls.length) { record('companion server is publishing a URL', false, 'none returned'); process.exit(1); }
  // Any address works; the loopback-reachable one is whatever it published.
  const paired = new URL(urls[0].url);
  const base = `${paired.protocol}//127.0.0.1:${paired.port}`;
  record('companion server is publishing a URL', true, urls[0].url.replace(/pair=.*/, 'pair=…'));

  // Pair exactly as a phone opening the QR link does: the code rides in the
  // query string and the answer is a 303 back to '/' that carries the
  // session cookie. redirect:'manual' because following it would hand us the
  // redirect target's headers instead of the ones holding the cookie, and
  // Node's fetch keeps no cookie jar of its own to carry it either way.
  const pairRes = await fetch(`${base}/?${paired.searchParams.toString()}`, { redirect: 'manual' });
  const pairCookie = pairRes.headers.get('set-cookie');
  if (pairCookie) cookie = pairCookie.split(';')[0];
  record('pairing with the published code is accepted', pairRes.status === 303 && !!cookie,
    `status ${pairRes.status}, cookie ${cookie ? 'set' : 'MISSING'}`);

  // Tune somewhere known so the state has real content in it.
  await evalJs(session, `
    const core = await import('./js/playback-core.js');
    core.tuneToChannel(7);
    return 'tuned';
  `);
  await sleep(3000);

  const state = await get(base, '/state');
  const s = state.json || {};
  record('/state reports the box audio state', typeof s.muted === 'boolean' && typeof s.volume === 'number',
    `muted=${s.muted} volume=${s.volume}`);
  record('/state reports the picture/audio modes',
    !!s.pictureMode && !!s.aspectMode && !!s.audioMode && s.crt != null,
    `picture=${s.pictureMode} aspect=${s.aspectMode} audio=${s.audioMode} crt=${s.crt}`);
  record('/state reports whether a break is on air', s.onAir === 'content' || s.onAir === 'break', `onAir=${s.onAir}`);
  record('/state reports the time-machine slots', s.quickJumpSlots && typeof s.quickJumpSlots === 'object',
    JSON.stringify(s.quickJumpSlots));

  // The lineup snapshot is pushed on a timer; it fires once at startup, so
  // it should already be there by now.
  const channels = await get(base, '/channels');
  const rows = Array.isArray(channels.json) ? channels.json : [];
  record('/channels still answers with a bare array', Array.isArray(channels.json),
    Array.isArray(channels.json) ? `${rows.length} channels` : `got ${typeof channels.json}`);
  const withProgramming = rows.filter((r) => r.now);
  record('/channels carries now/next programming', withProgramming.length > 0,
    `${withProgramming.length}/${rows.length} channels have a NOW title` +
    (withProgramming[0] ? ` (e.g. CH ${withProgramming[0].number}: ${withProgramming[0].now})` : ''));

  // A patch the box must refuse, and one it must accept.
  await post(base, '/api/settings', { patch: { notARealSetting: { nope: 1 } } });
  await sleep(2500);
  const afterBad = (await get(base, '/state')).json || {};
  const badResult = afterBad.settingsResult || {};
  record('a refused settings patch is reported as refused',
    (badResult.rejected || []).some((r) => r.section === 'notARealSetting'),
    JSON.stringify(badResult));

  const currentPicture = s.pictureMode;
  const nextPicture = currentPicture === 'vivid' ? 'cinema' : 'vivid';
  await post(base, '/api/settings', { patch: { pictureMode: nextPicture } });
  await sleep(2500);
  const afterGood = (await get(base, '/state')).json || {};
  const goodResult = afterGood.settingsResult || {};
  record('an applied settings patch is reported as applied',
    (goodResult.applied || []).includes('pictureMode') && !(goodResult.rejected || []).length,
    JSON.stringify(goodResult));
  record('the applied setting actually took effect on the box', afterGood.pictureMode === nextPicture,
    `pictureMode ${currentPicture} -> ${afterGood.pictureMode}`);

  const manifest = await get(base, '/manifest.webmanifest');
  record('the home-screen manifest is served',
    manifest.status === 200 && manifest.json && manifest.json.start_url === '/',
    `status ${manifest.status}, type ${manifest.type}`);
  const icon = await get(base, '/icon.png');
  record('the home-screen icon is served', icon.status === 200 && icon.type.includes('image/png'),
    `status ${icon.status}, type ${icon.type}`);

  record('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  fs.writeFileSync(path.join(OUT_DIR, 'results.json'), JSON.stringify({ results, state: s }, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  session.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('DRIVER FAILED:', e); process.exit(1); });
