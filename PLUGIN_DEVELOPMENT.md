# Writing a RerunTV plugin

A plugin is a folder with a `manifest.json`, dropped into the app's plugins
folder (PLUGINS tab → OPEN PLUGINS FOLDER, or installed via INSTALL FROM
ZIP…). This guide covers everything you need to write one — a copyable
starting point lives in [`plugin-dev-kit/starter-plugin/`](plugin-dev-kit/starter-plugin/).

Every channel and settings panel that ships with the app itself —
Pay-Per-View, TMDB metadata lookup — is a plugin
built with exactly this API, no special first-party privileges. If you want
a worked example beyond the starter kit, read any folder under
[`plugins/`](plugins/).

## New plugin checklist

Before writing any code, decide these up front — each is cheap to get right
at the start and annoying to change later:

- **Isolated or not, and why?** Any real capability beyond a single
  `ipcMain` handler — spawning a process, network access, filesystem writes
  outside your own `dataDir` — means `"isolated": true` (see "Trust model"
  below). Every first-party plugin with real capabilities uses it now;
  same-process mode is for genuinely light plugins only.
- **Which `category`?** `"channel"` (registers a real channel number),
  `"theme"` (a `registerThemePack` entry), `"onscreen"` (an overlay/effect,
  not tuned to), or `"system"` (background service, remote control,
  integration, no on-screen presence). This is only a grouping hint for the
  PLUGINS tab's category tabs, but pick one deliberately — "OTHER" is what
  you get for skipping it.
- **Does it need a `dataDir`?** Only if you keep real data (a cache, guest
  uploads, anything beyond your own plugin folder) at the top level of
  `userData/`. Declaring it lets the app's own userData migration carry it
  along; if you don't need one, don't declare one.
- **Renderer entry point or not?** `renderer.js`/`settings.js` share the
  same document and DOM as core and every other plugin — no isolation at
  all, unlike `main.js`. If your UI doesn't need direct DOM integration,
  prefer a sandboxed iframe or Worker instead of a renderer entry point (see
  "Trust model" below).
- **Does settings UI belong in its own `settings.js`?** Every first-party
  plugin now splits its PLUGINS-tab settings panel out of `renderer.js` into
  its own `settings.js` (declared via manifest `"settings"`) so channel-
  render logic and settings-panel logic don't share a file. Do this from the
  start rather than retrofitting it later.
- **Does it need a cross-plugin service?** If another plugin (or core) needs
  to call into yours, publish it via `ctx.services` / `claimServiceKey`
  rather than having one plugin `import` another directly — plugins can't
  import each other's files across origins anyway (see "Cross-plugin
  services" below).
- **Read a similar existing plugin first.** `plugins/` has a first-party
  example for nearly every shape (channel, theme pack, system/isolated,
  media source) — copying the closest match's manifest/folder layout beats
  re-deriving these conventions from scratch.

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

**Only install plugins you trust the source of, isolated or not.** A ZIP
install records a SHA-256 digest outside the plugin folder. Manually copied
plugins require an explicit one-time trust decision, and any later byte
change blocks all of that plugin's main, renderer, settings, and CSS entry
points until the exact new digest is reviewed. This detects replacement or
local tampering; it is not an author signature and does not prove who wrote
the original ZIP.

Isolation
scopes *what* a plugin's main.js can touch on disk and which binaries it can
spawn; it does nothing to stop a plugin from, say, exfiltrating data over the
network it already declared a capability to use. It does not isolate
`renderer.js`, `settings.js`, or `style.css`: those intentionally join the
same renderer document as core and can inspect or modify the whole UI and
call the exposed `window.api` surface. If third-party UI does not require
direct DOM integration, prefer a sandboxed iframe or Worker communicating
through narrow messages instead of a renderer entry point. If you're
distributing a plugin, say clearly what it does and what
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
  "settings": "settings.js",
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
| `category` | no | One of `"channel"` (registers a real channel number), `"theme"` (a `registerThemePack` entry — see below), `"onscreen"` (an overlay/effect, not tuned to), or `"system"` (background service, remote control, integration — no on-screen presence of its own). Purely a grouping hint for the PLUGINS tab's category tabs — omit or use anything else and your plugin just lands in an "OTHER" tab, nothing breaks. |
| `style` | no | Path to a CSS file, loaded globally (as a real `<link>`) whenever the plugin is enabled. Omit if you have no CSS of your own. |
| `renderer` | no | Path to the runtime JS entry point loaded as an ES module in the renderer process. This is where channel, theme, overlay, and other runtime registrations normally go. Omit for a settings-only or main-process-only plugin. |
| `settings` | no | Path to a separate JS settings entry point, loaded after `renderer`. Use it for `registerPluginSettings` so runtime channel/overlay behavior stays separate from setup-screen UI. Existing plugins may continue registering settings from `renderer`. |
| `main` | no | Path to a JS file `require()`'d in the Electron main process. Must export `{ activate(ctx) }`. Omit if you have no main-process code. |
| `dependsOn` | no | Array of other plugin ids yours needs. Purely informational + load-ordering (see below) — the app doesn't hard-block loading if a dependency is missing, so check for it yourself at runtime (`ctx.services.whatever` being undefined, or `window.RCBPlugins.otherPlugin` being undefined) and degrade gracefully. |
| `dataDir` | no | Name of a folder your plugin keeps at the top level of `userData/` (sibling to `userData/plugins/`) for real data beyond your own plugin folder — a download cache, guest uploads, whatever. Declaring it here means the app's own userData migration (moving to a new install layout) knows to carry it along; skip this field if your plugin has no such folder. |
| `capabilities` | no, but required if your `main.js` needs `ctx.ipcMain`/`ctx.spawn`/`ctx.createServer` | What your `main.js` needs to touch beyond reading files — see "Declaring capabilities" below. Shown to the user as a permission-approval prompt before your plugin is allowed to activate. |
| `isolated` | no | `true` runs your `main.js` in its own real OS process instead of the same-process default — see "Isolated plugins" below. Recommended for any plugin with real `spawn`/`net`/filesystem-write capabilities. |
| `minCtxVersion` | no | Integer. Declare this if your `renderer`/`settings` code depends on a `window.RCBPlugins.ctx` shape newer than the app's current `ctx.version` — see "renderer-process side" below. An app build whose `ctx.version` is lower refuses to import your entry with a clear error instead of letting it crash on a missing property. |

At least one of `style`/`renderer`/`settings`/`main` should be present, or your plugin
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
  ],
  "mediaSource": [
    { "providerId": "my-source", "displayName": "My Source", "why": "streams channel content from somewhere other than local disk" }
  ],
  "system": [
    { "action": "shell.openExternal", "why": "opens the project's homepage from a Settings link" }
  ]
}
```

`capabilities.system` gates the two OS-level actions proxied to an **isolated**
plugin's `ctx.shell.openExternal`/`ctx.desktopCapturer.getSources` (see below)
— declare `"shell.openExternal"` and/or `"desktopCapturer.getSources"` there
if your isolated plugin calls either; an undeclared one throws the same way
an undeclared `ipc` channel does. A non-isolated plugin's `ctx.shell`/
`ctx.desktopCapturer` are the real, unwrapped Electron modules regardless —
same-process plugins already have unrestricted access via `require('electron')`
directly, so there's nothing this capability could meaningfully gate there.

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

If your plugin's local server streams audio/video and you hand the renderer
a plain `http://127.0.0.1:<port>/...` URL to play (rather than routing it
through `app://media`), every `net` port you declare above is automatically
allowed in the renderer's media-src Content Security Policy once your plugin
is approved and activates — no separate CSP configuration needed. That
wiring lives in `setAllowedMediaSrcPorts` (`main-protocol.js`), fed from
`loadMainPlugins()`'s `activatedNetPorts` (`main-plugins.js`).

Unlike `ipc`/`spawn`/`net`, `mediaSource` isn't checked against a runtime
wrapper — it's declarative: it's what shows in the approval prompt so a user
consciously accepts "this plugin can supply channel media," and it's what
lets the CHANNELS tab's source picker list your provider. Nothing enforces
what your provider's implementation actually does over the network (see
"Media sources" below) — the `why` you give here is the user's only real
signal, so be specific about it (e.g. "fetches video from your configured
WebDAV server," not just "provides media").

### Media sources

A plugin can supply channel content from somewhere other than local disk —
cloud storage, a network share, anything reachable over HTTP — by declaring
`capabilities.mediaSource` (above) and, in `activate(ctx)`, registering four
services keyed `mediaSource:<your-providerId>:<verb>` via `ctx.registerService`
(see "Cross-plugin services" below — same mechanism, just a reserved key
format core's dispatch layer looks for):

```js
ctx.registerService('mediaSource:my-source:list', async (folderRef) => {
  // folderRef: whatever your own "choose a folder" UI produced.
  // Returns { refs: string[] } — your own natural, unprefixed refs; core
  // wraps them with a mediasource:my-source: prefix before they ever reach
  // config, so you never construct that prefix yourself.
  return { refs: [...] };
});
ctx.registerService('mediaSource:my-source:probe', async (ref) => {
  // Returns { duration } in seconds, or { error } if you genuinely can't
  // tell (core falls back to a generous default rather than failing).
  return { duration: 1234 };
});
ctx.registerService('mediaSource:my-source:readRange', async (ref, start, end) => {
  // The streaming primitive — called repeatedly as the player seeks, same
  // as an HTTP Range request. `end` is inclusive; null means "to EOF".
  // Return a Buffer chunk, not a stream — this is a bounded request/response
  // call, matching how a seeking <video> element already requests bounded
  // ranges rather than a whole file in one shot.
  return { status: 206, contentType: 'video/mp4', totalSize: 999999, chunk: buf };
});
ctx.registerService('mediaSource:my-source:checkAvailable', async (ref) => {
  return true; // cheap existence check, used by the CHECK CHANNELS health scan
});
```

All four must be registered — core does not fall back to local behavior for
a verb you didn't implement, it surfaces the call failure instead.

For "browse for a folder" UI when the user clicks CHOOSE SOURCE on a
channel, you have three options, tried in this order and each optional:

1. **`ctx.registerMediaSourcePicker(providerId, pickerFn)`** (in your
   `renderer.js`, not `main.js`) — `pickerFn: () => Promise<folderRef |
   null>`. This is the recommended option if you want real picker UI:
   since your `renderer.js` runs in the same window/process as core (same
   reason `registerSettingsPanel`/`registerChannelType` are plain function
   calls, not IPC), `pickerFn` can build and show a genuine modal —
   breadcrumbs, a clickable folder list, whatever fits your provider's own
   data shape — with no cross-process choreography needed. Reuse the app's
   own `confirm-dialog`/`confirm-dialog-box`/`confirm-dialog-title`/
   `confirm-dialog-actions`/`folder-row` CSS classes (`css/setup.css`) for
   visual consistency; they're globally available — e.g. a breadcrumb
   folder browser backed by an extra `listFolders` verb on the same
   provider (see "Extra verbs" below).
2. A main-process `mediaSource:my-source:pickFolder` verb (`() =>
   Promise<folderRef | null>`, registered in `main.js` like the four core
   verbs) — for a provider that would rather not ship any renderer UI at
   all. Tried only if no picker is registered via option 1.
3. A plain text-input prompt — always available as the last resort, so
   CHOOSE SOURCE never dead-ends even for the simplest possible provider.
   Not something you implement; core falls back to it automatically if
   neither option above is registered.

**Extra verbs**: nothing stops you from registering more
`mediaSource:my-source:<anything>` services beyond the four core ones plus
`pickFolder` — e.g. a settings-panel-facing `configure`/`signIn`/`status`
for a provider that needs its own credentials, or a `listFolders` verb
purpose-built to back your own picker UI (option 1 above). Your
`renderer.js` calls any of them the same way:
`window.api.callMediaSourceHook(providerId, verb, ...args)` — a generic
passthrough to whatever you've registered, not limited to the reserved
verb names. See `plugins/gdrive-media-source` for a complete worked
example of both patterns together.

**`getFetchProgress(ref) => Promise<{ ready: boolean, progress?: number, label?: string }>`**
— another optional, well-known verb name (not one of the four core ones,
but recognized by core rather than provider-invented): if your `readRange`
can legitimately take a long time on first access (e.g. downloading to a
local cache before it can serve anything — see `plugins/gdrive-media-source`'s
lazy-cache strategy), register this and `renderer/js/playback.js` will call
it before attempting playback, showing a visible progress card
(`{ready: false, progress: 0-1, label}`) and polling once a second until
you return `{ready: true}`, instead of the tune just sitting on static with
no explanation while `readRange` blocks underneath. Don't register it if
your `readRange` is always fast — its absence is a pure no-op, straight to
playback as before.

**`getLocalCachePath(ref) => Promise<string | null>`** — pairs with
`getFetchProgress`: if your provider caches a file to local disk (rather
than serving `readRange` live), register this too and
`main/main.js`'s `media:resolvePlayablePath` will redirect playback to that
real local path once you return one, instead of continuing to route it
through your `readRange`. Return `null` while nothing's cached yet. Once
redirected, the file gets full local-file treatment — including `FIX
PLAYBACK`'s codec auto-fix, which operates on your cache file directly, not
the original remote copy. `renderer/js/playback.js` calls this as a
fallback only, after a genuine live playback attempt (going straight
through your `readRange`, same as any file) fails to decode — see
`plugins/gdrive-media-source` for the full pattern: live streaming by
default, caching only kicks in if live genuinely doesn't work for a given
file.

**`getDisplayName(ref) => Promise<string | null>`** — a `ch.files[].path`
for your provider is an opaque ref (e.g. a Drive file id), which has no
meaningful basename the way a local path's filename does — without this,
every UI that shows a file's title (`getDisplayTitle`, `util.js`) falls
back to showing that raw ref. Register this to return a real human-readable
name; `setup-channels.js` calls it once per file at scan time
(`addPluginSourceToChannel`/`rescanAllFolders`) and stores it as the file's
`title`.

Your provider is responsible for its own auth/token refresh (if any) — the
core verbs (`probe`/`readRange`/`checkAvailable`) are called fresh each
time, so refresh transparently inside them rather than assuming a token
stays valid.

`ctx.fs` is similar but always available (no declaration needed): reads
(`existsSync`/`readFile`/`readFileSync`/`readdirSync`) take any path — this
is deliberately unrestricted, since checking whether a user-configured
executable exists is a legitimate need with no folder to scope it to in
advance. Writes (`writeFile`/`writeFileSync`/`mkdirSync`/`createWriteStream`/
`unlink`) are scoped to your own declared `dataDir` and take a path relative
to it — `ctx.fs.dataDir` is the resolved absolute path, if you need it
directly (e.g. to build a path yourself before handing it to something
else, like `spawn`'s output path).

### Cross-plugin services

`ctx.registerService(key, fn)` publishes a function under a string key any
plugin (same-process or isolated, yours or another's) can call with
`ctx.callService(key, ...args)` — you never need to know where the provider
actually lives; the call is proxied over RPC automatically if it's in a
different process. This is how a media-source provider's `list`/`probe`/
`readRange`/`checkAvailable` verbs are exposed (see "Media sources" above) —
that's a reserved `mediaSource:<providerId>:<verb>` key convention on top of
this same general mechanism, not a separate one. A **plain value** (a
string, an array) instead of a function still just uses `ctx.services`
directly — publish with `ctx.services.someKey = value`, read the same way;
see the isolated-plugins section below for the one caveat that applies only
to that case (a snapshot, not a live reference, across the process
boundary).

Renderer plugins can publish a renderer-local object with
`window.RCBPlugins.registerRendererService(id, service)` and retrieve it with
`window.RCBPlugins.getRendererService(id)`. Use this for UI-only collaboration
such as a queue controller that another renderer plugin can drive. Prefer a
capability-shaped id (for example, `online-audio-queue`) over a provider name,
and treat a missing service as an optional dependency. Main-process and
isolated-process work must continue to use `ctx.registerService` /
`ctx.callService` instead.

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
- `ctx.pluginDir`, `ctx.mimeFor`, `ctx.readJsonBody`, `ctx.serveStatic`,
  `ctx.getLanAddresses`, `ctx.getViewerUrls`, `ctx.busboy`, `ctx.QRCode`,
  `ctx.remotePort` — all still there, unchanged. `ctx.serveStatic(baseDir,
  pathname, req, res)` serves one static file out of `baseDir` — method
  check, path-containment check, and 403/404/405 all handled internally —
  the usual last-route fallback for a plugin's own small browser-facing page:
  put it as the final line of your request handler, after every other route
  has already been checked and didn't match (see `plugins/party-channel/
  main.js` or `plugins/universal-remote/main.js` for a worked example).
  There's no `ctx.getPartyUrls`/`ctx.partyPort` —
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
- `ctx.shell.openExternal(url)` / `ctx.desktopCapturer.getSources(opts)` —
  proxied over RPC to the real Electron call, but only if you declared the
  matching `capabilities.system` entry (`"shell.openExternal"` /
  `"desktopCapturer.getSources"`, see "Declaring capabilities" above) —
  undeclared throws, same as an undeclared `ipc` channel.

**Different — no real Electron `BrowserWindow`/`ipcMain` handle can cross a
process boundary, so these replace the same-process equivalents:**
- `ctx.sendToMainWindow(channel, data)` replaces
  `getMainWindow().webContents.send(channel, data)` — no null/isDestroyed
  check needed, it's already a safe no-op if the window is gone.
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
else from `require('electron')` directly — an isolated plugin's process
never has the `electron` module. If your plugin needs an Electron API not
listed above, it isn't supported for isolated plugins yet; ask before
assuming you can work around it.

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
next app restart. Once a plugin is already active, though, the PLUGINS tab's
RELOAD button re-fetches and re-registers its `style.css`/`renderer.js`/
`settings.js` live, no restart needed — the fast path for iterating on
styling, UI, and settings-panel code. It does NOT re-run `main.js`: a
same-process plugin has no deactivate() hook to cleanly unregister its
`ipcMain` handlers or spawned processes, so a change to `main.js` still needs
a real restart. It also only cleans up what your code declares through the
`register*()` calls documented below — a `setInterval`/`setTimeout` your
renderer.js starts, an `<audio>` element it creates and keeps the only
reference to locally, or a `registerCoreHook` subscription can leak a stale
instance across a reload, since nothing tracks which plugin owns those. Keep
that in mind if your plugin does anything at module scope beyond calling a
`register*()` function.

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
  `serveStatic`, `loadConfig`, `trackConnection`, `mimeFor`. These aren't a stable
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

This is a **fully trusted UI extension point**, not the isolated-main
sandbox. Its module shares RerunTV's renderer document and its CSS is global.
The PLUGINS screen labels this access explicitly and verifies the installed
file digest before loading it.

Loaded as ES modules, with `window.RCBPlugins` already set up before your
top-level code runs. `renderer` loads before `settings` when both are present.
A plugin can provide runtime behavior, settings UI, both, or neither.

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

Every registered channel automatically gets a **CHANNEL DISPLAY** settings
section containing RESOLUTION and DISPLAY ASPECT overrides. Core renders and
persists those controls under `S.config.pluginSettings[id].channelDisplay`;
the plugin should not duplicate them in its own settings UI. A channel can
provide `resolutionOverride` / `displayAspectOverride` on its definition as
backward-compatible initial defaults, but an explicit saved user choice wins.

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
- `ctx.getPluginSettings(id)` — reads the generic persisted settings object
  for a plugin without mutating config when no settings exist yet.
- `ctx.updatePluginSettings(id, patch)` — shallow-merges generic settings and
  saves through the app's normal config-generation/undo funnel.

`ctx` also groups everything above by concern, so you can destructure just
the piece you need instead of pulling every key off the flat object:

- `ctx.core` — `{ S, viewNow, player, saveConfigDebounced }`
- `ctx.audio` — `{ playTone, playNoiseBurst, getAudioCtx }`
- `ctx.channels` — `{ sortedChannels, buildChannelBadge, getChannel, getChannelSchedule, getDisplayTitle, formatSlotLabel, addFilesToChannel, addInterstitialPoolEntry }`
- `ctx.settings` — `{ getPluginSettings, updatePluginSettings, getRedactedPluginSettings }`
- `ctx.util` — `{ formatClock, WEEKDAYS, MONTHS }`

The flat top-level keys (`ctx.S`, `ctx.player`, `ctx.sortedChannels`, …) stay
available too — nothing existing breaks — but new code should prefer the
grouped form. `ctx.version` is a plain integer, bumped whenever this shape
changes in a way a plugin might depend on. If your plugin needs a ctx
feature newer than some installed base of the app, declare
`"minCtxVersion": <n>` in `manifest.json` — an app version whose `ctx.version`
is lower refuses to load your `renderer`/`settings` entry with a clear
one-line error instead of crashing partway through your own top-level code
on a property that doesn't exist yet.

### `registerThemePack(id, definition)`

Bundles a CRT theme's look with the behavioral bits a handful of themes also
carry beyond CSS — CRT bias defaults, a channel-change static style,
channel/power SFX, ambient audio texture, and an optional border/bezel image
for non-16:9 content. Every first-party theme plugin
(`plugins/theme-*/`) uses this — see any of them for a full worked example,
or `plugins/theme-wood-console-70s/renderer.js` for one that uses every
optional field.

```js
window.RCBPlugins.registerThemePack('wood-console-70s', {
  label: 'WOOD-GRAIN CONSOLE (1978 FOREST & BRASS)', // required
  group: 'ERA (BY DECADE)',   // optional — <optgroup> in the theme <select>;
                               // reuse 'ERA (BY DECADE)' / 'REAL CABLE-BOX UI' /
                               // 'BROADCAST/STUDIO' / 'STYLIZED' where it fits
  preview: {                  // optional — stable browser-card swatch;
    background: '#050f0a',   // CSS colors, shown without applying the theme
    accent: '#b5893a',
    secondary: '#e8dcae',
  },
  crtBias: { scanlines: 1.1, vignette: 1.15, grain: 1.3, flicker: 1.2, curvatureFloor: 0 },
  staticStyle: 'roll',
  powerOnMs: 900, // optional — how long core holds '.powering-on' before
                  // removing it (default: POWER_ON_ANIM_MS, power.js).
                  // Only needed if your theme's own CSS override of
                  // .crt.powering-on .crt-power-fx-line also overrides
                  // animation-duration to run longer than the shared
                  // default — otherwise the class removal would cut your
                  // animation short.
  guidePreviewDefault: false,  // optional — default the full-page guide's
                               // live-picture preview box off for this theme
                               // (e.g. a pre-PIP era); the user's own DISPLAY
                               // > GUIDE LIVE PREVIEW choice, once set, always
                               // wins over this. Omit for today's default (on).
  channelChangeSfx() { /* build a click with window.RCBPlugins.ctx's playTone/playNoiseBurst */ },
  powerSfx(isOn) { /* same, for power on/off */ },
  ambientTexture: { /* read by the vintage-audio plugin, not core */ },
  captionStyle: { /* read by the closed-captions plugin, not core */ },
  borderImage: 'app://plugins/my-plugin/border.svg', // or `true` for the plain CSS fallback frame
  safeAreaPct: { top: 0.04, right: 0.04, bottom: 0.04, left: 0.04 }, // only with borderImage
});
```

`id` here is the *theme* id (`S.config.theme`'s value, e.g.
`"wood-console-70s"`) — mirroring how the pack's own CSS keys off
`html[data-theme="<id>"]` — not necessarily your plugin's manifest `id`
(a plugin folder named `theme-wood-console-70s` registering theme id
`wood-console-70s` is the normal convention). Every field but `label` is
optional; a color-only theme (most of them) registers just `{ label }`
(plus maybe `borderImage`), and every core lookup falls back to today's
generic defaults when a field is absent — same as if no pack were
registered for that theme at all. Manifest `category: "theme"` (see the
manifest table above) is the convention every first-party theme plugin
uses to land in the PLUGINS tab's own THEMES tab, though nothing enforces it.

`preview` is presentation metadata only. It does not replace the theme's CSS
tokens and never activates the theme while the browser is open. Omit it for a
neutral fallback swatch; first-party packs provide it so every card remains
recognizable even when another theme is currently active.

Theme CSS can also reshape the program guide through semantic composition
tokens instead of replacing core layout rules for simple variations:

| Token | Controls |
|---|---|
| `--guide-grid-bg` | Guide canvas behind rows |
| `--guide-channel-bg`, `--guide-channel-fg`, `--guide-channel-subtle` | Channel-number rail |
| `--guide-program-bg`, `--guide-program-alt-bg` | Alternating program cells |
| `--guide-selection-bg`, `--guide-selection-fg` | Remote-focused program |
| `--guide-timebar-bg` | Time-axis surface |
| `--guide-row-height`, `--guide-row-gap` | Grid density |

Use scoped `html[data-theme="..."]` selectors for identity that cannot be
expressed as a token—such as a split preview/info header or square ruled
cells. Keep keyboard focus obvious, preserve reduced-motion behavior, and
avoid copying logos or artwork from a real cable provider.

### `registerPluginSettings(id, definition)`

Adds one or more plugin-specific sections after any settings supplied by the
plugin type. Put this call in the manifest's optional `settings.js` entry point
when possible:

```js
window.RCBPlugins.registerPluginSettings('my-plugin', {
  schemaVersion: 2,
  defaults: { enabled: false, account: { apiKey: '' } },
  sensitivePaths: ['account.apiKey'],
  migrations: {
    1(settings) {
      return { ...settings, enabled: settings.active ?? settings.enabled ?? false };
    },
  },
  validate(settings) {
    return typeof settings.enabled === 'boolean' ? true : 'enabled must be a boolean';
  },
  sections: [{
    id: 'behavior',
    label: 'MY PLUGIN OPTIONS',
    layout: 'two-column',
    render(container, ctx) {
      const cfg = ctx.settings;
      container.innerHTML = `
        <label class="panel-toggle"><input type="checkbox">ENABLE THE THING</label>
      `;
      const enabled = container.querySelector('input');
      enabled.checked = !!cfg.enabled;
      enabled.addEventListener('change', () => ctx.updateSettings({ enabled: enabled.checked }));
    },
  }],
});
```

The schema fields are optional, but recommended for persisted settings.
`schemaVersion` is a positive integer. `defaults` are deep-filled without
overwriting saved values. `migrations` maps each source version to a function
that returns the next version's settings (the example migrates v1 to v2), and
core records the applied version in `pluginSettingsMeta`. `validate` runs after
migration/defaulting and before every `updateSettings` write; return `true`,
return an error string, or throw. Dotted `sensitivePaths` are redacted by
`ctx.getRedactedPluginSettings(id)` when settings are copied into diagnostics
or support output. Do not render secrets into the DOM or write them to logs.

The section context contains `S`, `player`, `saveConfigDebounced`, and
`selectExecutable` plus `pluginId`, a current generic `settings` snapshot,
and the id-bound `updateSettings(patch)` helper. `player` is useful for a
settings action such as capturing the current frame; runtime playback still
belongs in the channel's `render`/`stop` lifecycle.

Each section may set `layout` to `stack` (the default), `two-column`, or
`wide`. Core owns the responsive breakpoint: `two-column` becomes one column
in narrow windows, so plugins should describe their layout intent instead of
adding app-wide setup selectors or hardcoding a particular viewport. `wide`
keeps the section spanning the available settings grid.

### `registerSettingsPanel(id, definition)` (legacy)

Existing plugins can keep using the original single-panel API. Core treats it
as one custom section and composes it after type-provided settings. New plugins
should prefer `registerPluginSettings` and a separate `settings.js` entry.

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
trigger on top of whatever's tuned — a
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
`plugins/noaa-weather/renderer.js`'s real-alert trigger into `breaking-news`
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
call into `getInterrupt('breaking-news')` for a worked example of one plugin
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

New plugins should store ordinary settings through the id-bound
`ctx.settings`/`ctx.updateSettings()` contract. Existing private config under
`S.config.<your-plugin-id-or-similar>` remains supported; migrate it only when
there is a concrete benefit rather than rewriting user configuration eagerly.
Don't write to config keys that look like they belong to another plugin or
to core. The one exception is a plugin that's genuinely extending a
core-shared feature.

## Verifying your plugin works

The PLUGINS tab includes **PLUGIN DEVELOPER DIAGNOSTICS**. It inventories
registered renderer extension points, main-process activation state, published services,
declared capability activity, renderer/main load errors, recent bounded logs, and whether
an enable/disable change still needs a restart.

**EXPORT REDACTED SUPPORT BUNDLE** writes the same information as JSON. The export does not
contain `channels.json` or the media inventory. Before writing, core recursively redacts
credential-shaped keys, authorization strings, URL credentials, GitHub-style tokens, the
user-data path, and the home path. A plugin settings schema should still declare
`sensitivePaths` so `ctx.getRedactedPluginSettings(id)` is safe anywhere else it is used.

`npm test` permanently checks every bundled/starter manifest entry, bundled
seeding upgrades, renderer bridge parity, boot ordering, viewer HTTP assets,
schedule clock behavior, and config-cache invalidation. It is not a general
third-party plugin behavior harness. Practically: drop your folder into the
plugins directory, approve its recorded SHA-256 in PLUGINS, restart the app, and
check the PLUGINS tab shows it with no error. If it registers a channel,
tune to its number and confirm it renders and cleans up correctly on
tune-away. If it registers settings, expand its SETTINGS row and confirm
values persist across a restart.
