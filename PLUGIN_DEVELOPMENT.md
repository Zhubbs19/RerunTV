# Writing a RerunTV plugin

A plugin is a folder with a `manifest.json`, dropped into the app's plugins
folder (PLUGINS tab → OPEN PLUGINS FOLDER, or installed via INSTALL FROM
ZIP…). This guide covers everything you need to write one — a copyable
starting point lives in [`plugin-dev-kit/starter-plugin/`](plugin-dev-kit/starter-plugin/).

Every channel and settings panel that ships with the app itself — HBO,
Pay-Per-View, the Emergency Alert System, TMDB metadata lookup — is a plugin
built with exactly this API, no special first-party privileges. If you want
a worked example beyond the starter kit, read any folder under
[`plugins/`](plugins/).

## Trust model — read this first

By default, a plugin's `main.js` runs via `require()` in the Electron **main
process** — full Node/Electron access (`ipcMain`, `child_process`, `fs`, all
of it), the same privilege level as the app's own code. There is no sandbox
between plugins, or between a plugin and the app, in this mode.

Set `"isolated": true` in `manifest.json` and your `main.js` instead runs in
its own real OS process (a forked Node process, no direct Electron access at
all — see "Isolated plugins" below), with Node's own `--experimental-permission`
flags actually enforcing (not just checking) that it can only read/write the
paths and spawn the processes it declared. This is a genuine process
boundary, not a same-process convention — a plugin that bypasses `ctx.fs`/
`ctx.spawn` entirely and calls `require('fs')`/`require('child_process')`
directly still gets denied. **New plugins with any real capabilities (spawn,
network, filesystem writes beyond their own dataDir) should default to
`"isolated": true`** — every first-party plugin that needs one now does.
Same-process mode still exists for plugins with lighter needs (a single
`ipcMain` handler, nothing else) where the extra process overhead isn't
worth it, and capabilities are still checked there too — just not by the OS,
only by the same JS-level wrapper as before.

**Only install plugins you trust the source of, isolated or not.** Isolation
scopes *what* a plugin's main.js can touch on disk and which binaries it can
spawn; it does nothing to stop a plugin from, say, exfiltrating data over the
network it already declared a capability to use, or a renderer-side
`registerChannelType`/`registerSettingsPanel` doing something malicious in
the UI. If you're distributing a plugin, say clearly what it does and what
it talks to (network requests, spawned processes, file access) so users can
make that call.

## manifest.json

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "One sentence describing what this does — shown in the PLUGINS tab.",
  "category": "channel",
  "style": "style.css",
  "renderer": "renderer.js",
  "main": "main.js",
  "dependsOn": ["other-plugin-id"],
  "isolated": true
}
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | A stable, unique, lowercase-hyphenated string. This is your plugin's install-folder name, its `registerChannelType`/`registerSettingsPanel` key, and how other plugins refer to you in `dependsOn`. Don't change it after release — it's how the app recognizes an update vs. a reinstall. |
| `name` | no | Human-readable, shown in the PLUGINS tab. Falls back to `id`. |
| `version` | no | Free-form string, shown next to the name. Not currently used for update checks. |
| `description` | no | One sentence, shown in the PLUGINS tab. |
| `category` | no | One of `"channel"` (registers a real channel number), `"onscreen"` (an overlay/effect, not tuned to), or `"system"` (background service, remote control, integration — no on-screen presence of its own). Purely a grouping hint for the PLUGINS tab's category tabs — omit or use anything else and your plugin just lands in an "OTHER" tab, nothing breaks. |
| `style` | no | Path to a CSS file, loaded globally (as a real `<link>`) whenever the plugin is enabled. Omit if you have no CSS of your own. |
| `renderer` | no | Path to a JS file loaded as an ES module in the renderer process. This is where `registerChannelType`/`registerSettingsPanel` calls go. Omit for a main-process-only plugin (e.g. one that just adds an IPC handler another plugin depends on). |
| `main` | no | Path to a JS file `require()`'d in the Electron main process. Must export `{ activate(ctx) }`. Omit if you have no main-process code. |
| `dependsOn` | no | Array of other plugin ids yours needs. Purely informational + load-ordering (see below) — the app doesn't hard-block loading if a dependency is missing, so check for it yourself at runtime (`ctx.services.whatever` being undefined, or `window.RCBPlugins.otherPlugin` being undefined) and degrade gracefully. |
| `dataDir` | no | Name of a folder your plugin keeps at the top level of `userData/` (sibling to `userData/plugins/`) for real data beyond your own plugin folder — a download cache, guest uploads, whatever. Declaring it here means the app's own userData migration (moving to a new install layout) knows to carry it along; skip this field if your plugin has no such folder. |
| `capabilities` | no, but required if your `main.js` needs `ctx.ipcMain`/`ctx.spawn`/`ctx.createServer` | What your `main.js` needs to touch beyond reading files — see "Declaring capabilities" below. Shown to the user as a permission-approval prompt before your plugin is allowed to activate. |
| `isolated` | no | `true` runs your `main.js` in its own real OS process instead of the same-process default — see "Isolated plugins" below. Recommended for any plugin with real `spawn`/`net`/filesystem-write capabilities. |

At least one of `style`/`renderer`/`main` should be present, or your plugin
does nothing.

### Declaring capabilities

If your `main.js` needs to register `ipcMain` handlers, spawn a child
process, or bind an HTTP server, declare it in `manifest.json`:

```json
"capabilities": {
  "ipc": [
    { "channel": "my-plugin:doThing", "why": "lets the renderer ask this plugin to do the thing" }
  ],
  "spawn": [
    { "bin": "ffmpeg", "why": "transcodes the stream this plugin serves" }
  ],
  "net": [
    { "port": 8730, "why": "serves this plugin's own local stream to the renderer" }
  ]
}
```

Every entry needs a `why` — it's shown verbatim in the approval prompt the
user sees before your plugin is allowed to activate (a fresh install, or an
update that adds a new entry, both re-prompt). Use `ctx.ipcMain`/
`ctx.spawn`/`ctx.createServer` from your `activate(ctx)` instead of
`require('electron').ipcMain`/`require('child_process').spawn`/
`require('http').createServer` directly — those are checked against exactly
what you declared here; an undeclared channel/binary/port throws instead of
silently working, the same as any other `activate()` error (your plugin
fails to load, shown in the PLUGINS tab, nothing else breaks). This is a
same-process check, not a hard sandbox, but it's what the approval prompt is
actually checking — don't bypass it with a raw `require()`, since that
defeats the whole point for whoever's deciding whether to trust your
plugin. See `plugins/party-channel/main.js` for a real, larger worked example.

`ctx.fs` is similar but always available (no declaration needed): reads
(`existsSync`/`readFile`/`readFileSync`/`readdirSync`) take any path — this
is deliberately unrestricted, since checking whether a user-configured
executable exists is a legitimate need with no folder to scope it to in
advance. Writes (`writeFile`/`writeFileSync`/`mkdirSync`/`createWriteStream`/
`unlink`) are scoped to your own declared `dataDir` and take a path relative
to it — `ctx.fs.dataDir` is the resolved absolute path, if you need it
directly (e.g. to build a path yourself before handing it to something
else, like `spawn`'s output path).

### Isolated plugins

Set `"isolated": true` and your `main.js` is forked into its own real OS
process (`utilityProcess.fork()`) instead of `require()`'d into the app's
own. This is a genuinely different execution environment, not just an extra
permission check — some things work identically, some need a different
`ctx` method, and a few things aren't available at all:

**Works exactly the same:**
- `ctx.ipcMain.handle`/`.on` — still just works, transparently relayed.
- `ctx.fs`/`ctx.spawn`/`ctx.createServer` — still capability-checked the same
  way, PLUS actually OS-enforced now via Node's `--experimental-permission`
  (fs-read is scoped to your plugin's own folder plus the app's install
  directory, fs-write to your declared `dataDir` only, and spawning anything
  at all requires at least one declared `capabilities.spawn` entry).
- `ctx.services.someValue` — reading/publishing a plain value (a string, an
  array) works the same. It's a **snapshot taken when your process is
  forked**, not a live shared reference — if you read a value published by a
  plugin you `dependsOn`, that's fine (dependency ordering guarantees the
  publisher finished activating, snapshot included, before you're forked).
  Don't rely on it for a value that changes after boot.
- `ctx.pluginDir`, `ctx.mimeFor`, `ctx.readJsonBody`, `ctx.getLanAddresses`,
  `ctx.getViewerUrls`, `ctx.busboy`, `ctx.QRCode`, `ctx.remotePort` — all
  still there, unchanged. There's no `ctx.getPartyUrls`/`ctx.partyPort` —
  those were core-owned helpers for one specific plugin's port and got
  removed; a plugin with its own LAN-facing port declares that port as its
  own local constant and builds its own URL list from `ctx.getLanAddresses()`
  instead (see `plugins/party-channel/main.js` for a worked example).
- `ctx.fetchJsonCached`, `ctx.loadConfig` — same signatures, but now genuinely
  async (they always were promises; just make sure you're `await`-ing them,
  a same-process plugin could occasionally get away with not doing so since
  the underlying call happened to resolve synchronously-ish — an isolated
  plugin never can).
- `ctx.app.on('before-quit', fn)` — still works.

**Different — no real Electron `BrowserWindow`/`ipcMain` handle can cross a
process boundary, so these replace the same-process equivalents:**
- `ctx.sendToMainWindow(channel, data)` replaces
  `getMainWindow().webContents.send(channel, data)` — no null/isDestroyed
  check needed, it's already a safe no-op if the window is gone.
- `ctx.registerService(key, fn)` / `ctx.callService(key, ...args)` replace
  publishing/reading a **function-valued** `ctx.services` entry (a plain
  value like a string still just uses `ctx.services` directly — see above).
  `callService` works whether the provider is same-process or isolated; you
  never need to know which.
- `ctx.registerPartyRoute(method, pathname, handler)` /
  `ctx.dispatchPartyRoute(requestDescriptor)` replace the old
  `ctx.services.partyRoutes` array extension point on party-channel's server.
  `handler` is now a pure function of a plain request descriptor to a plain
  response descriptor — `async ({method, pathname, headers, body}) =>
  ({status, headers, body})` — since it may run in a different process than
  the one holding the real `req`/`res`. See `plugins/party-channel/main.js`
  for the dispatch side of a real, working example.

**Not available at all** (main-process-only, no equivalent):
`getMainWindow()` itself (use `ctx.sendToMainWindow` instead), and anything
from `require('electron')` directly — an isolated plugin's process never has
the `electron` module. If your plugin needs an Electron API not listed
above, it isn't supported for isolated plugins yet; ask before assuming you
can work around it.

## Folder layout

```
my-plugin/
  manifest.json
  main.js        (optional — main-process code)
  renderer.js     (optional — renderer-process code)
  style.css       (optional — global CSS while enabled)
  <anything else your code needs — images, sub-scripts, a bundled binary, whatever>
```

## Two ways to install

1. **Drop the folder in by hand**: PLUGINS tab → OPEN PLUGINS FOLDER, copy
   your folder in, then RESCAN. Fastest for developing your own plugin.
2. **Zip install**: zip your folder (manifest.json can be at the zip's root,
   or one level deep inside a single top-level folder — both are
   auto-detected), then PLUGINS tab → INSTALL FROM ZIP…. This is what you'd
   hand to someone else to install your plugin.

Either way, enabling/disabling and newly added plugins take effect on the
next app restart — nothing is loaded live while the setup screen is open.

## The main-process side: `main.js`

```js
function activate(ctx) {
  const { ipcMain, app, shell, desktopCapturer, pluginDir } = ctx;

  ipcMain.handle('my-plugin:doThing', async (event, opts) => {
    return { ok: true };
  });

  app.on('before-quit', () => {
    // clean up any child process you spawned, close any server you opened
  });
}

module.exports = { activate };
```

`ctx` always includes:

- `ipcMain`, `app`, `shell`, `desktopCapturer` — the real Electron modules,
  not wrapped.
- `pluginDir` — absolute path to your plugin's own installed folder (useful
  for `path.join(pluginDir, 'some-asset.png')` or spawning a bundled
  executable).
- `services` — a shared object other main-process plugins can publish
  capabilities onto and you can read from (e.g. `ctx.services.ffmpegPath`,
  published by the ffmpeg-transcode plugin). Check for existence before
  using anything on it — a plugin you depend on may be disabled or missing.
- A handful of app-specific helpers plugins have found useful:
  `getMainWindow`, `getLanAddresses`, `fetchJsonCached`, `readJsonBody`,
  `loadConfig`, `trackConnection`, `mimeFor`. These aren't a stable
  guaranteed API in the way the Electron modules above are — check an
  existing plugin under [`plugins/`](plugins/) that uses the one you need to
  confirm it's still passed through, since this list can grow but shouldn't
  be relied on blindly.

**Loading order**: plugins with a `dependsOn` are loaded after the plugins
they depend on (topological sort — see `main-plugins.js`'s
`orderByDependencies`), so by the time your `activate()` runs, a dependency
listed in `dependsOn` has already had the chance to publish to
`ctx.services`. This is ordering only, not a hard guarantee the dependency
is actually present and enabled — always check.

## The renderer-process side: `renderer.js`

Loaded as an ES module, with `window.RCBPlugins` already set up before your
top-level code runs. You get two registration calls, and you can use either,
both, or neither (a plugin can be pure settings-UI with no channel, or a
pure channel with no settings).

### A big constraint: **you cannot `import` core app code**

Your `renderer.js` is served from a different origin
(`app://plugins/<id>/renderer.js`) than the app's own renderer code
(`app://bundle/...`). Browsers don't let one origin's ES module `import`
another's. So:

- **You CAN**: use any Web API directly (`document.*`, `fetch`, Web Audio,
  `getUserMedia`, etc.) — your code runs in the same page as everything
  else, so DOM manipulation on core-owned elements (`document.querySelector('.crt')`,
  for instance) works fine. It's only `import` statements across the two
  origins that are blocked.
- **You CANNOT**: `import { something } from '../../renderer/js/whatever.js'`.
- **The workaround**: core exposes select functions on `window` for exactly
  this reason (see the table below). If something you need isn't listed,
  either it's not meant to be depended on yet (ask, or check whether a
  `window.RCBPlugins.ctx`-available primitive covers it) or it's genuinely
  internal.

### `registerChannelType(id, definition)`

Gives your plugin a real channel number in the guide. Real user media
channels always take priority over a plugin channel at the same number — if
someone creates a real channel 51, your plugin channel at 51 just doesn't
show up until they remove it.

```js
window.RCBPlugins.registerChannelType('my-plugin', {
  number: 51,                                    // required, integer
  label: 'MY CHANNEL',                            // shown in the guide
  nowText: 'Whatever is on right now',            // shown in the guide
  badge: { bg: '#8b5cf6', label: 'MY' },          // channel-change tint/logo bug
  render(container, ctx) {
    // called every time the box tunes to `number` — rebuild container's
    // contents from scratch each call, don't assume it's still whatever
    // you left it as.
    container.innerHTML = `<div class="my-plugin-channel">Hello</div>`;
  },
  stop(ctx) {
    // called when tuning away — clear intervals, stop audio/video capture,
    // release anything you started in render().
  },
  onOk(ctx) {
    // optional — called when Enter/Space is pressed (or a remote's OK
    // button) while this channel is tuned in. Return truthy if you handled
    // it, so the app doesn't also treat it as "open the guide overlay".
  },
  onKey(key, ctx) {
    // optional — called for every keydown while this channel is tuned in,
    // before any of the app's own key handling. Return true if you handled
    // it (e.g. arrow-key game controls), false/undefined to let normal key
    // handling continue.
  },
  viewerLink: {
    // optional — offer a "watch live" link on the LAN viewer page whenever
    // this channel is the one actually live (installed, enabled, not
    // overridden by a real user channel at the same number). fetchUrl()
    // is called from the viewer's own page — return the URL to link to, or
    // null/undefined to show nothing. See plugins/party-channel/renderer.js
    // and its main.js (which publishes the actual URL(s) onto
    // ctx.services.viewerLiveLinkUrls for the generic
    // /api/viewer-live-link endpoint to serve) for a full worked example.
    fetchUrl: () => fetch('/api/viewer-live-link').then((r) => r.json()).then((d) => (d.urls && d.urls[0] && d.urls[0].url) || null),
  },
});
```

`ctx` passed to `render`/`stop`/`onOk`/`onKey` is `{ S, viewNow, player }`:

- `S` — the live, mutable app-state object. `S.config` is the whole user
  config (read/write your own slice of it, e.g. `S.config.myPlugin = {...}`
  — pick a config key that matches your plugin id so you don't collide with
  anyone else). `S.currentNumber`, `S.isPoweredOn`, `S.timeMachineOn` etc.
  are useful read-only state.
- `viewNow()` — the current time in milliseconds, time-machine-aware (call
  this instead of `Date.now()` for anything schedule-related, so your
  channel behaves correctly while the user is scrubbing).
- `player` — the app's single shared `<video>` element. If your channel
  wants real playback (or, like the AUX/Video-In plugin, a live capture
  stream), this is what you drive — `player.src`/`player.srcObject`. Only
  one thing can own it at a time; you get it when your channel is tuned in,
  and should release/reset it in `stop()`.

This same shape is also available synchronously at `window.RCBPlugins.ctx`
from your module's own top-level code (not just inside `render`) — useful
for something like registering an IPC listener at load time that needs to
read `S` before the user ever tunes to your channel. It also carries a
couple of narrow write helpers so you can add real content without knowing
the config schema:

- `ctx.addFilesToChannel(ch, entries)` — appends already-known files
  (`[{path, duration, folder}]`) to a channel's playlist. Dedupes by path,
  reshuffles if the channel is in shuffle mode, and anchors an unanchored
  channel to "now" — the same logic core's own OS-drag-drop feature uses.
- `ctx.addInterstitialPoolEntry(fields)` — pushes one entry onto the shared
  interstitials pool, filling in the usual defaults (`type: 'commercial'`,
  `channelAffinity: 'any'`, a fresh id, …) — pass just the fields you're
  overriding, e.g. `{ file: { path, duration } }` or `{ text: 'Some fact' }`.

### `registerSettingsPanel(id, definition)`

Gives your plugin a SETTINGS toggle on its own row in the PLUGINS tab.

```js
window.RCBPlugins.registerSettingsPanel('my-plugin', {
  render(container, ctx) {
    // called every time the panel is expanded — rebuild from scratch each
    // time, same contract as a channel's render().
    if (!ctx.S.config.myPlugin) ctx.S.config.myPlugin = {};
    const cfg = ctx.S.config.myPlugin;
    container.innerHTML = `
      <label class="panel-toggle">MY PLUGIN</label>
      <div class="panel-body">
        <label class="shuffle-toggle"><input type="checkbox" data-el="enabled">ENABLE THE THING</label>
      </div>
    `;
    const enabledEl = container.querySelector('[data-el="enabled"]');
    enabledEl.checked = !!cfg.enabled;
    enabledEl.addEventListener('change', () => {
      cfg.enabled = enabledEl.checked;
      ctx.saveConfigDebounced();
    });
  },
});
```

`ctx` here is `{ S, saveConfigDebounced, selectExecutable }` — narrower than
the channel-type ctx (no `viewNow`/`player`, since a settings panel isn't
tied to the live TV screen). `saveConfigDebounced()` persists whatever you
changed on `S.config`; call it after every edit. `selectExecutable` opens a
native file picker scoped to executables, if your plugin needs the user to
point at one (matches `window.api.selectExecutable` — most file pickers you
want are on `window.api` instead, see below).

Reuse the app's own CSS classes for a consistent look — `.panel-toggle`,
`.panel-body`, `.shuffle-toggle`, `.panel-status`, `.panel-interval`,
`.title-row-input`, `.btn` / `.btn-primary` / `.btn remove-btn` — rather
than inventing your own. Check `renderer/css/setup.css` for the full set, or
just look at how an existing plugin's settings panel is built.

### `registerInterrupt(id, definition)`

A full-screen (or otherwise attention-grabbing) interrupt your plugin can
trigger on top of whatever's tuned — an emergency-alert slate, a
breaking-news crawl, or anything similar. Registering here gets you, for
free: a TV-menu button, an optional single-letter hotkey on live TV, an
auto-hiding hint-bar entry (tag your `#hint-bar` span
`data-plugin-hint="true"` with a matching `data-hint-key`), and automatic
cleanup on power-off/channel-change.

```js
window.RCBPlugins.registerInterrupt('my-plugin', {
  label: 'MY ALERT',        // TV-menu button text
  hintKey: 'my-alert',      // matches a hint-bar span's data-hint-key
  hotkey: 'x',              // optional — pressing X on live TV runs this
  run(opts) {
    // opts.manual = true when triggered by the hotkey/menu/another plugin,
    // as opposed to your own internal auto-fire logic.
  },
  cancel() {
    // called on power-off and on every channel change — stop an
    // in-progress alert, hide your overlay.
  },
  scheduleNext() {
    // optional — called after a tune-in completes, so a plugin that
    // auto-fires periodically can re-arm its own timer.
  },
  cancelScheduled() {
    // optional — called when entering setup, so a pending scheduleNext()
    // timer doesn't fire while there's no live TV to interrupt. Distinct
    // from cancel(), which only stops something already in progress.
  },
});
```

Look up another plugin's registration with
`window.RCBPlugins.getInterrupt('other-plugin-id')?.run(opts)` — see
`plugins/noaa-weather/renderer.js`'s real-alert trigger into `eas-alerts`
for a worked example of one interrupt plugin calling into another.

### `registerTuneGate(id, definition)`

A gate that can block tuning into a channel until some condition is met —
core's own PIN-lock parental control (`plugins/../renderer/js/pin-lock.js`)
is built on exactly this, alongside anything a third-party plugin might add
(a bedtime lock, a "spend a credit to watch this" gate).

```js
window.RCBPlugins.registerTuneGate('my-plugin', {
  isBlocked(number) {
    // return true to block tuning to this channel number right now.
    return false;
  },
  onBlocked(number) {
    // called instead of tuning — show whatever UI resolves the block, and
    // call window.tuneToChannel(number, { bypassGateIds: ['my-plugin'] })
    // once satisfied to actually complete the tune.
  },
});
```

### `registerCoreHook(event, fn)`

Subscribes to a named lifecycle event core fires generically, with no idea
which (if any) plugin is listening — this is how core reaches into a plugin
for something not covered by one of the other registries above, without
hardcoding that plugin's name anywhere. Current events: `'power-off'`,
`'power-on'`, `'enter-setup'`, `'idle-reset'` (fired whenever the idle timer
resets — any activity), `'idle-armed'` (fired only when the idle timer is
actually rescheduled), `'theme-audio-refresh'` (fired whenever something
that could affect ambient theme audio changes — a theme switch, movie mode,
power state), `'draw-test-pattern'` (fired instead of the plain no-signal
card, for an unconfigured channel number).

```js
window.RCBPlugins.registerCoreHook('power-off', () => {
  // do whatever your plugin needs when the box powers off
});
```

Multiple plugins may subscribe to the same event; one plugin may subscribe
to several. A throw in your handler is caught and logged, same per-plugin
failure isolation every other registry here gives — it won't stop other
plugins' handlers for that event from running. See
`plugins/vintage-audio/renderer.js` (subscribes to four events with the same
handler) and `plugins/screensaver/renderer.js` for real, worked examples.

### `registerTitleRowAction(id, definition)`

Adds your own per-file action (a metadata-lookup button, etc.) to every file
row on the TITLES tab — and, since that same row renderer is reused for a
SCHEDULE block's own file list, there too.

```js
window.RCBPlugins.registerTitleRowAction('my-plugin', {
  // Called once per visible file row — build your UI into `container`.
  renderRowCell(container, file, ctx) {
    const btn = document.createElement('button');
    btn.textContent = 'DO THING';
    btn.addEventListener('click', () => { /* ... use `file`, ctx.saveConfigDebounced() ... */ });
    container.appendChild(btn);
  },
  // Optional — adds a control to the bulk-action bar (acts on every
  // currently-selected file at once).
  renderBulkAction(container, ctx) {
    const btn = document.createElement('button');
    btn.textContent = 'DO THING FOR SELECTED';
    btn.addEventListener('click', () => {
      ctx.getSelectedFiles().forEach((file) => { /* ... */ });
      ctx.rerender();
    });
    container.appendChild(btn);
  },
});
```

`ctx` is the standard `window.RCBPlugins.ctx`, plus `getSelectedFiles()`
(bulk action only) and `rerender()`. See `plugins/tmdb-metadata/renderer.js`
for a full real example (search, bulk match, per-file re-match).

### `window.api` — the IPC bridge

Your renderer code also has full access to `window.api`, the same
contextBridge surface the core app uses (see `main/preload.js` for the
complete list) — file pickers (`selectAudio`, `selectImage`, `selectVideo`,
`selectCss`, …), `toFileUrl`, backups, config load/save, and anything
another plugin's `main.js` registered an `ipcMain.handle` for. If your own
`main.js` adds a new IPC channel, you'll need it added to `preload.js` too
(core-owned file) for your renderer code to call it — first-party plugins
do this by editing `main/preload.js` directly; if you're a third-party
plugin author without an app fork, structure your `main.js` to use IPC
channels the app already exposes, or ask for your channel to be added.

### Cross-plugin calls: the `window.RCBPlugins.<yourId>` escape hatch

If another plugin (or core) needs to call into yours, expose a small object:

```js
window.RCBPlugins.myPlugin = {
  someMethod(arg) { /* ... */ },
};
```

Callers should always guard: `if (window.RCBPlugins.myPlugin) window.RCBPlugins.myPlugin.someMethod();`
— your plugin might be disabled or not installed. If what you're exposing is
a full-screen alert/interrupt or a tune-time gate, prefer `registerInterrupt`
or `registerTuneGate` above instead; if it's **core** that needs to call into
you, prefer `registerCoreHook` instead — core no longer has any hardcoded
per-plugin name to call at all, it only fires generic named events. Reach
for this raw escape hatch for **plugin-to-plugin** calls that don't fit any
of those shapes — a plugin author choosing to depend on another specific
plugin's feature (declared via `dependsOn`) is a different, legitimate case
from core assuming a plugin exists. See `plugins/noaa-weather/renderer.js`'s
call into `getInterrupt('eas-alerts')` for a worked example of one plugin
reaching into another for something plugin-specific (a *real*-alert
override) that the generic `run(opts)` contract alone doesn't carry.

### Modal dismiss/confirm convention

If your channel shows a modal (an order-confirmation dialog, a picker, …),
give it class `preview-modal` and tag its buttons `data-modal-dismiss` /
`data-modal-confirm`. The app's keyboard handler automatically wires
Escape-to-dismiss and Enter/Space-to-confirm for any modal matching that
convention inside your channel's container — you don't need to write your
own key handling for it. See `plugins/pay-per-view/renderer.js` for a
worked example (its order-confirm modal has both buttons; its success
modal, being a single "OK" action, only has `data-modal-dismiss`).

### Functions core exposes on `window` for exactly this reason

| `window.<name>` | What it does |
|---|---|
| `S` | The live app-state object (same as `ctx.S`) |
| `tuneToChannel(number, opts)` | Switch the box to a channel |
| `checkBreakState(ch)` | Re-evaluate whether a commercial break should be starting |
| `cancelUpNextBar()` | Dismiss the "UP NEXT" banner |
| `playChannelLive(ch)` | Resume normal scheduled playback on a real channel |
| `getChannel(number)` | Look up a real channel's config object by number |
| `isVirtualChannel(number)` | Whether a number belongs to a virtual/plugin channel right now |
| `alertDialog(message, opts)` | The app's themed alert (never use raw `alert()`) |
| `getAudioCtx()` | The shared `AudioContext`/mix bus — connect your own oscillators/sources into it so mute/volume apply for free, instead of creating a second unmixed `AudioContext` |
| `playNoiseBurst(opts)` / `playPpvOrderSound()` | A couple of pre-built sound-effect primitives, exposed because they're reused heavily in core |
| `applyTickerState()` / `startTriviaRound()` | Re-apply the on-screen ticker / kick off a trivia round, if you're integrating with those core features |

This list can grow — if you need something that isn't here and it's a
reasonable, narrow primitive (not "just expose your whole internal module"),
that's a legitimate ask.

## Config namespacing

Store your plugin's settings under `S.config.<your-plugin-id-or-similar>`.
Don't write to config keys that look like they belong to another plugin or
to core. The one exception is a plugin that's genuinely extending a
core-shared feature (NOAA Weather reads/writes fields inside `config.eas`
alongside the EAS plugin's own fields, since a real weather alert and a
random EAS test are the same underlying interrupt mechanism) — if you're in
that situation, document why in a comment, the way `noaa-weather`'s
renderer.js does.

## Verifying your plugin works

There's no automated test harness for third-party plugins. Practically:
drop your folder into the plugins directory, RESCAN, restart the app, and
check the PLUGINS tab shows it with no error. If it registers a channel,
tune to its number and confirm it renders and cleans up correctly on
tune-away. If it registers settings, expand its SETTINGS row and confirm
values persist across a restart.
