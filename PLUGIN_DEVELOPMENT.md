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
| `description` | no | What the plugin does, shown in full on its page in Plug-ins. |
| `summary` | no | One short line for the plugin list (under ~100 characters). Without it the list shows the description's first sentence. |
| `category` | no | One of `"channel"` (registers a real channel number), `"theme"` (a `registerThemePack` entry — see below), `"onscreen"` (an overlay/effect, not tuned to), or `"system"` (background service, remote control, integration — no on-screen presence of its own). Purely a grouping hint for the PLUGINS tab's category tabs — omit or use anything else and your plugin just lands in an "OTHER" tab, nothing breaks. |
| `style` | no | Path to a CSS file, loaded globally (as a real `<link>`) whenever the plugin is enabled. Omit if you have no CSS of your own. |
| `renderer` | no | Path to the runtime JS entry point loaded as an ES module in the renderer process. This is where channel, theme, overlay, and other runtime registrations normally go. Omit for a settings-only or main-process-only plugin. |
| `settings` | no | Path to a separate JS settings entry point, loaded after `renderer`. Use it for `registerPluginSettings` so runtime channel/overlay behavior stays separate from setup-screen UI. Existing plugins may continue registering settings from `renderer`. |
| `main` | no | Path to a JS file `require()`'d in the Electron main process. Must export `{ activate(ctx) }`. Omit if you have no main-process code. |
| `dependsOn` | no | Array of other plugin ids yours needs. Purely informational + load-ordering (see below) — the app doesn't hard-block loading if a dependency is missing, so check for it yourself at runtime (`ctx.services.whatever` being undefined, or `window.RCBPlugins.otherPlugin` being undefined) and degrade gracefully. |
| `dataDir` | no | Name of a folder your plugin keeps at the top level of `userData/` (sibling to `userData/plugins/`) for real data beyond your own plugin folder — a download cache, guest uploads, whatever. Declaring it here means the app's own userData migration (moving to a new install layout) knows to carry it along; skip this field if your plugin has no such folder. |
| `userPaths` | no | Name of one of your plugin's OWN settings (or a dotted path into the box config, e.g. `party.soundboardFolder`) holding a folder (or a list of folders) the user picked for it — where a recorder should put its output, say. Those folders are granted read and write alongside your `dataDir`, and `ctx.fs.writeDirs` tells you which ones actually were. Requires `dataDir` too: this widens where you may write, it does not replace having somewhere of your own. **Not dynamic** — an isolated plugin's OS-level permissions are fixed when its process forks, so a folder the user picks now takes effect at the next restart. Say so in your settings panel, and fall back to `dataDir` until then rather than throwing on every write (see `plugins/tape-deck`'s `resolveTapesRoot`). |
| `capabilities` | no, but required if your `main.js` needs `ctx.ipcMain`/`ctx.spawn`/`ctx.createServer` | What your `main.js` needs to touch beyond reading files — see "Declaring capabilities" below. Shown to the user as a permission-approval prompt before your plugin is allowed to activate. |
| `isolated` | no | `true` runs your `main.js` in its own real OS process instead of the same-process default — see "Isolated plugins" below. Recommended for any plugin with real `spawn`/`net`/filesystem-write capabilities. |
| `minCtxVersion` | no | Integer. Declare this if your `renderer`/`settings` code depends on a `window.RCBPlugins.ctx` shape newer than the app's current `ctx.version` — see "renderer-process side" below. An app build whose `ctx.version` is lower refuses to import your entry with a clear error instead of letting it crash on a missing property. |
| `fallbackIpc` | no | Object mapping an IPC channel name to a JSON value, e.g. `{ "my-plugin:getStatus": { "ready": false } }`. While your plugin is disabled, or waiting on a permissions approval, core registers each channel to answer with that value, so renderer code that calls it unconditionally gets an empty result instead of a raw "no handler registered" rejection. Your own `main.js` is never loaded in that state. This replaced the old `registerFallback` hook: **core no longer calls `registerFallback`** (it would run unapproved code), so move any fallback answers into this field. |

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

#### `internet`: the sites your plugin connects to

```json
"internet": [
  { "host": "*.api.example.org", "why": "searches the example directory" },
  { "host": "*", "why": "plays whatever station you add, from its own server" }
]
```

`host` is a name (`api.example.org`), a domain and everything under it
(`*.example.org`), a literal IPv4 address, `localhost`, or `*` for anywhere.
No schemes, ports or paths.

- **Isolated plugins are held to it.** Once declared, every connection the
  plugin's own process makes (`net`, `tls`, `http`/`https`, `fetch`, UDP) to
  a host that isn't listed fails with `ERR_PLUGIN_HOST_NOT_ALLOWED`, and is
  logged and shown as blocked on the plugin's page. The check runs inside
  the plugin's process (`main/plugins/net-guard.js`), with Node's permission
  model blocking the usual ways around it. It isn't an OS firewall, and a
  program the plugin spawns isn't covered.
- **Not declaring it** leaves an isolated plugin unlimited, as before. The
  approval prompt says so, and the plugin's page still lists where it
  connected.
- **A same-process plugin** has full access regardless. The prompt says that
  in red.
- Declaring `internet` is optional and only enters the approval signature
  when present, so adding it to an existing plugin asks for approval once.

#### What the user is shown

The approval prompt and the plugin's page describe these capabilities in
plain words (`renderer/js/plugin/permissions.js`): where the plugin runs,
that its on-screen part shares the app's window, the sites it may reach,
the files it may read and write, programs, ports and system actions, each
with your `why`, and whether its files are built in, installed and
unchanged, or copied in by hand. The raw entries sit under a Details fold.
A plugin that isn't isolated is approved with a red APPROVE FULL ACCESS
button. Each plugin's page also shows what it has done since the app
started: bridge calls, refused calls, sites it connected to, and anything
it was blocked from.

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
wiring lives in `setAllowedMediaSrcPorts` (`main/media/protocol.js`), fed from
`loadMainPlugins()`'s `activatedNetPorts` (`main/plugins/plugins.js`).

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
   `confirm-dialog-actions`/`folder-row` CSS classes (`renderer/css/setup.css`) for
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
verb names.

**`getFetchProgress(ref) => Promise<{ ready: boolean, progress?: number, label?: string }>`**
— another optional, well-known verb name (not one of the four core ones,
but recognized by core rather than provider-invented): if your `readRange`
can legitimately take a long time on first access (e.g. downloading to a
local cache before it can serve anything), register this and
`renderer/js/playback/core.js` will call
it before attempting playback, showing a visible progress card
(`{ready: false, progress: 0-1, label}`) and polling once a second until
you return `{ready: true}`, instead of the tune just sitting on static with
no explanation while `readRange` blocks underneath. Don't register it if
your `readRange` is always fast — its absence is a pure no-op, straight to
playback as before.

**`getLocalCachePath(ref) => Promise<string | null>`** — pairs with
`getFetchProgress`: if your provider caches a file to local disk (rather
than serving `readRange` live), register this too and
`main/media/dispatch.js`'s `media:resolvePlayablePath` will redirect playback to that
real local path once you return one, instead of continuing to route it
through your `readRange`. Return `null` while nothing's cached yet. Once
redirected, the file gets full local-file treatment — including `FIX
PLAYBACK`'s codec auto-fix, which operates on your cache file directly, not
the original remote copy. `renderer/js/playback/core.js` calls this as a
fallback only, after a genuine live playback attempt (going straight
through your `readRange`, same as any file) fails to decode: live streaming
by default, caching only kicks in if live genuinely doesn't work for a
given file.

**`getDisplayName(ref) => Promise<string | null>`** — a `ch.files[].path`
for your provider is an opaque ref (e.g. a Drive file id), which has no
meaningful basename the way a local path's filename does — without this,
every UI that shows a file's title (`getDisplayTitle`, `util.js`) falls
back to showing that raw ref. Register this to return a real human-readable
name; `setup-channels.js` calls it once per file at scan time
(`addPluginSourceToChannel`/`rescanAllFolders`) and stores it as the file's
`title`.

**`getMetadata(ref) => Promise<{ description?, facets?: { genre?, era?, contentType? } } | null>`**
— optional, called alongside `getDisplayName` at the same scan-time sites,
for a provider that can identify real descriptive metadata about a specific
file (not just a cleaned-up name) — e.g. a synopsis, release year, or genre
from the source's own catalog. Whatever you return is merged into the new
file's `description`/`facets` fields exactly once, at scan time, the same as
a locally-derived title — not re-fetched on every render, so return `null`
rather than a guess you're not confident in (a wrong description is worse
than a missing one, and there's no later re-clean pass the way an
unset title gets one from `getDisplayTitle`'s own fallback). If your
source's metadata is per-collection rather than per-file (e.g. one shared
synopsis for an entire multi-episode/multi-movie folder), return `null`
rather than applying it identically to every file in that collection —
worse than no description is a wrong one repeated dozens of times.

Your provider is responsible for its own auth/token refresh (if any) — the
core verbs (`probe`/`readRange`/`checkAvailable`) are called fresh each
time, so refresh transparently inside them rather than assuming a token
stays valid.

`ctx.fs` is similar but always available (no declaration needed): reads
(`existsSync`/`readFile`/`readFileSync`/`readdirSync`/`statSync`, plus
`readRange(path, start, length)`, which resolves a Buffer of at most `length`
bytes so a header or tag reader need not load a whole media file) take any path — this
is deliberately unrestricted, since checking whether a user-configured
executable exists is a legitimate need with no folder to scope it to in
advance. Writes (`writeFile`/`writeFileSync`/`mkdirSync`/`createWriteStream`/
`unlink`) are scoped to your own declared `dataDir` and take a path relative
to it — `ctx.fs.dataDir` is the resolved absolute path, if you need it
directly (e.g. to build a path yourself before handing it to something
else, like `spawn`'s output path). A write may also take an ABSOLUTE path,
which is accepted only when it lands inside `dataDir` or one of the folders
the user chose for you (manifest `userPaths`, above). `ctx.fs.writeDirs`
lists every folder you may actually write to, `dataDir` included, and is the
authority on whether a folder from your settings was really granted — under
isolation those permissions are fixed at fork, so a folder picked since
startup will not be in it yet.

One asymmetry worth remembering under isolation: a read outside your granted
paths does not throw, it answers `false`/empty. `fs.existsSync` on a file you
were not granted looks exactly like a file that is not there. If a plugin
concludes something is missing when you can see it on disk, check the grant
before believing it.

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
  main.js` or `plugins/companion-app/main.js` for a worked example).
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
  published by the ffmpeg-transcode plugin, or `ctx.services.pcShutdown`,
  core's PC-shutdown countdown — `schedule({ source })`, `cancel()`,
  `status()` — which refuses until the user switches it on under SYSTEM ›
  POWER, so only put it behind an authenticated, confirmed control). Check
  for existence before using anything on it — a plugin you depend on may be
  disabled or missing.
- A handful of app-specific helpers plugins have found useful:
  `getMainWindow`, `sendToMainWindow`, `getLanAddresses`, `fetchJsonCached`, `readJsonBody`,
  `serveStatic`, `loadConfig`, `trackConnection`, `mimeFor`. These aren't a stable
  guaranteed API in the way the Electron modules above are — check an
  existing plugin under [`plugins/`](plugins/) that uses the one you need to
  confirm it's still passed through, since this list can grow but shouldn't
  be relied on blindly.

**Loading order**: plugins with a `dependsOn` are loaded after the plugins
they depend on (topological sort — see `main/plugins/plugins.js`'s
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
  onAction(action, ctx) {
    // optional (ctx v5) — in TV mode, remote buttons arrive here as actions
    // instead of keys: 'move.up', 'move.down', 'move.left', 'move.right',
    // 'select', 'back', 'info', and since v8 the transport buttons
    // 'media.playPause', 'media.rewind', 'media.fastForward', 'media.previous',
    // 'media.next'. Return true if you handled it; otherwise core does what it
    // would have (▲▼ change channel, Back asks to leave, play/pause opens the
    // menu). The
    // simplest adoption forwards to your existing onKey:
    //   const key = ctx.input.keyForAction(action); return key ? this.onKey(key, ctx) : false;
    // onKey keeps working everywhere; desktop mode never calls onAction.
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

`number`/`label` above are just your plugin's defaults, not guarantees — the
Channel Setup screen's **PLUGIN CHANNELS** section lets a user rename or
renumber your channel (persisted under
`S.config.pluginSettings[id].channelOverride`, same pattern as
`channelDisplay`). Every core lookup of "what number/name is this channel
right now" (the guide, tune-in, `getPluginChannelEntryForNumber`) already
resolves through that override, so if your own code only ever compares
against `S.currentNumber`/`window.S.currentNumber` (rather than closing over
your own `number` at registration time in a module-level constant), renumbering
just works with no changes on your end.

If your plugin DOES keep its own channel number in a constant and compares
`S.currentNumber` against it directly (e.g. to decide "am I the currently
tuned channel" inside a timer or event handler) — like `digital-music-channel`
and `party-channel` both do today — a renumber would desync that comparison
from the real number the channel got moved to, silently breaking your
plugin while it still appears in the guide under its new number. Until you
fix that (read the live number instead of a hardcoded constant), set
`numberLocked: true` on your `registerChannelType` definition to hide the
number field in the PLUGIN CHANNELS section rather than shipping a plugin
that can be renumbered into breaking itself. Renaming (the label) has no
such hazard and is always safe to leave enabled.

### Claim keys sparingly

`onKey` runs before any of core's own key handling, and returning `true`
swallows the key outright. Claim only the keys you actually handle. In
particular, `ArrowUp`/`ArrowDown` are core's CHANGE CHANNEL keys — claiming
those leaves the viewer unable to tune away from your channel with the keys
anyone would reach for. `ArrowLeft`/`ArrowRight` are free unless the time
machine is on (core shuttles with them then), so they are the natural place
for "move sideways within this channel". If your channel opens a full-screen
list or overlay, still let unrelated keys through rather than returning
`true` for everything — otherwise direct channel entry, the guide, setup and
power all stop working while it is up.

### Time machine support

Core used to refuse the time machine on every plugin channel, on the grounds
that it has no schedule of its own to re-derive for one. If your channel
computes what it is playing as a pure function of a timestamp — reading
`ctx.viewNow()` rather than keeping its own playback log, the same property
core's `schedule.js` relies on — then scrubbing already works, and you opt in:

```js
window.RCBPlugins.registerChannelType('my-plugin', {
  // ...
  supportsTimeMachine: true,
  // Optional, but without it the VCR display's programme line is blank —
  // core cannot know what your channel is playing at the scrubbed instant.
  timeMachineNowText(nowMs) {
    const playing = whatIPlayAt(nowMs); // your own pure (state, now) function
    return playing ? `${playing.artist} — ${playing.title}` : '';
  },
});
```

Do not set the flag if your channel plays live or otherwise cannot answer
"what were you playing an hour ago" — the time machine would enter and then
show something that never aired. While `S.shuttleDir` is non-zero the viewer
is scrubbing at speed; skip reloading media on each tick and just keep the
on-screen readout tracking, or you will thrash the decoder for something
nobody can hear.

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

`getChannelSchedule(ch, from, to)` lists the CONTENT airing across a range.
Two more resolvers cover the breaks between it, so a plugin can reconstruct
a channel's entire broadcast rather than just its programme listing:

- `resolveBreakAt(ch, atMs)` — what, if anything, is interrupting content at
  that exact instant. Returns `null` when nothing is, or
  `{ type, entry, windowStart, windowEnd, label? }`. `entry` is the
  interstitial pool entry, whose `file` (or `bgFile`, for a dynamic text
  bumper) is the clip that plays; a break with no file at all is one core
  draws as an on-screen card over a paused picture. The one break that does
  NOT pause anything is a text-only station ID (`type === 'channelId'` with
  no `entry.file`) — core overlays that bar on top of the still-running show.
- `nextBreakBoundary(ch, fromMs)` — the next instant the answer above
  changes, so you can step boundary to boundary instead of sampling.
  `Infinity` when nothing is ever scheduled.

Both are pure functions of `(channel, timestamp)`, exactly like
`getChannelSchedule`, so a whole range resolves without playing any of it.
`plugins/tape-deck/renderer.js`'s `planSegments` is a worked example: it
walks a range with these three and produces the list of cuts that becomes a
recording. It is also worth reading for two rules any similar walk needs:
a break with no `entry.file` is a card core draws over a PAUSED picture, so
it occupies time; and a text-only station ID is the one break that does not
pause anything, so it occupies none.

`ctx` also groups everything above by concern, so you can destructure just
the piece you need instead of pulling every key off the flat object:

- `ctx.core` — `{ S, viewNow, player, saveConfigDebounced }`
- `ctx.audio` — `{ playTone, playNoiseBurst, getAudioCtx }`
- `ctx.channels` — `{ sortedChannels, buildChannelBadge, getChannel, getChannelSchedule, getDisplayTitle, formatSlotLabel, addFilesToChannel, addInterstitialPoolEntry, resolveBreakAt, nextBreakBoundary }`
- `ctx.settings` — `{ getPluginSettings, updatePluginSettings, getRedactedPluginSettings }`
- `ctx.util` — `{ formatClock, WEEKDAYS, MONTHS }`
- `ctx.search` — `{ registerEntries }` (v4, see "Setup search entries" below)
- `ctx.input` — `{ usageMode, keyForAction, actions }` (v5, see `onAction` under `registerChannelType` above), plus `openKeyboard({ title, value, maxLength })` (v8): the D-pad on-screen keyboard, resolving the typed text (upper-cased) or `null` if cancelled — use it for text entry in TV mode, where a focused `<input>` can't be typed into from a remote
- `ctx.ui` — the component kit (v6, see "Building UI with `ctx.ui`" below)
- `ctx.ipc` — `{ invoke, on, available }` (v10, see "Calling your own `main.js`" below)
- `ctx.commands` — `{ register, dispatch, type }` (v7, see "Undoable edits with
  `ctx.commands`" below)

The flat top-level keys (`ctx.S`, `ctx.player`, `ctx.sortedChannels`, …) stay
available too — nothing existing breaks — but new code should prefer the
grouped form. `ctx.version` is a plain integer, bumped whenever this shape
changes in a way a plugin might depend on. If your plugin needs a ctx
feature newer than some installed base of the app, declare
`"minCtxVersion": <n>` in `manifest.json` — an app version whose `ctx.version`
is lower refuses to load your `renderer`/`settings` entry with a clear
one-line error instead of crashing partway through your own top-level code
on a property that doesn't exist yet.

### Undoable edits with `ctx.commands` (ctx v7)

`ctx.saveConfigDebounced()` still works, but everything it writes reaches undo
history as one anonymous structural patch — the step reads "Edit" and there is
no way for your plugin to say what it was. A registered command names the step,
undoes exactly, and is recorded the same way core's own edits are.

```js
// In your renderer.js or settings.js, once, at load.
ctx.commands.register('digital-music-channel', 'setEra', {
  // All three receive YOUR settings object — never the app's config.
  validate(settings, cmd) {
    if (typeof cmd.era !== 'string') throw new Error('An era is required');
  },
  apply(settings, cmd) {
    const before = settings.era;
    settings.era = cmd.era;                       // mutate in place
    return [{ name: 'setEra', era: before ?? '' }]; // the inverse, in YOUR names
  },
  describe(settings, cmd) { return `Switch to the ${cmd.era} era`; },
  touches() { return ['era']; },                   // optional; see below
});

// Later, wherever the user actually changes it:
ctx.commands.dispatch('digital-music-channel', 'setEra', { era: '1999' });
```

The undo button now reads "Undo: Switch to the 1999 era".

**What your command can reach.** `apply`, `validate` and `describe` are handed
your plugin's settings object and nothing else — not the channel lineup, not
box settings, not another plugin's settings. That is not a rule you are asked
to follow; those objects are simply never passed to you. The registered type is
always `plugin:<your-id>.<name>`, built by core from the id you pass, so a
command can neither shadow a core command nor land in another plugin's
namespace.

**The inverse** is a list of `{ name, ...payload }` objects using your own
command names, which core maps back into your namespace. Return `[]` if your
command changed nothing. A name you have not registered is an error, so a typo
fails loudly at edit time rather than silently at undo time.

**`touches`** returns tokens describing which part of your settings changed,
relative to them — `['era']`, `['stations', id]`. Core prefixes them with
`plugins/<your-id>/settings/`. They are what lets two people editing different
things at the same time both succeed; omit it and every edit of yours conflicts
with every other edit of yours, which is safe but chatty. See
`docs/design/05-command-layer-and-sync.md` §2.3.

**Batching.** `ctx.commands.type(id, name)` gives the full type string, so
several of your commands (or yours mixed with core's) can go through
`ctx.core.dispatch([...], { label: '…' })` as one undo step.

**What travels to the host.** The host process has no plugin renderers, so it
does not know your command type. Core sends it the resulting settings as a
plain `plugin.setSettings` instead, which is what reaches `channels.json` and
any other paired editor. Your precise command stays in this client's undo
history. You do not have to do anything about this — it is worth knowing only
because another device sees "plugin settings changed", not your step's label.

### Escaping text, and the other helpers on `ctx` (ctx v9)

Anything you put into `innerHTML` that did not come from a literal in your own
source (a title, a file or station name, a path, an error message, a string from a
remote service) must be escaped, or it can become markup. `ctx.ui.escapeHtml(value)`
escapes `& < > " '`, so it is safe in element text and inside quoted attributes;
`null`/`undefined` become an empty string. `ctx.ui.formatDuration(seconds)` gives
`m:ss` / `h:mm:ss`.

```js
const { escapeHtml } = window.RCBPlugins.ctx.ui;
container.innerHTML = `<span class="name">${escapeHtml(station.name)}</span>`;
```

Prefer `textContent` or building nodes when that is just as easy. A test
(`tests/plugin-template-safety.test.js`) scans bundled plugins for unescaped
free-text `${...}` inside `innerHTML` templates.

First-party plugins whose settings predate `pluginSettings` (breaking news, closed
captions, the companion app) edit their older config section with
`ctx.settings.updateLegacyConfig(pluginId, patch, { label })` and read or seed it with
`ctx.settings.ensureLegacyConfig(pluginId, defaults)`. Only a plugin id core knows
about is accepted. New plugins should use `ctx.settings.updatePluginSettings`
or `ctx.commands` instead of assigning to `ctx.S.config` (guarded by
`tests/plugin-config-writes.test.js`).

### Building UI with `ctx.ui` (ctx v6)

Core's own screens are built from a small component kit (docs/design/04 §3), and
`ctx.ui` hands your settings panel or channel UI the same pieces. Each is a plain
function that returns a DOM element (no framework), styled by the active theme's
tokens, sized for the current mode (`html[data-mode="tv"]` gets 10-foot text and
64 px targets automatically), and D-pad friendly. Prefer them over hand-built
`<button>`s: you get theme-correct colours, focus rings and TV handling for free.

```js
const { ui } = window.RCBPlugins.ctx;
container.append(
  ui.SettingRow({ label: 'Crawl speed', help: 'How fast the ticker moves.',
    control: ui.Slider({ min: 1, max: 10, value: 4, format: (v) => `${v}x`, onChange: save }) }),
  ui.Button({ label: 'TEST CRAWL', variant: 'primary', onPress: runTest }),
);
const ok = await ui.Dialog({ title: 'RESET CRAWL?', message: 'Your custom text is removed.',
  actions: [{ label: 'CANCEL', value: false }, { label: 'RESET', variant: 'danger', value: true }] }).result;
```

| Component | Returns | Notes |
|---|---|---|
| `Button({ label, variant, icon, onPress, disabled, isDefault })` | `<button class="btn">` | variant `default`/`primary`/`danger`/`quiet`; `onPress` fires on click, Enter, Space and the remote's OK |
| `IconButton({ icon, label, onPress })` | button | `label` required (accessible name and tooltip) |
| `Field({ label, help, control })`, `SettingRow({ label, help, control, dependsOn })` | element | wires `<label for>`; `Field` has `setError(text)` |
| `Toggle`, `Slider({ min, max, step, value, format })`, `Select({ options })`, `Segmented({ items, value })`, `NumberStepper`, `ColorPick` | control | ◀▶ step a Slider/Segmented/NumberStepper, in TV dialogs too |
| `Tabs({ items, orientation, onSelect })` | tab bar | roving focus, `aria-selected` |
| `ListDetail({ items, key, renderRow, renderDetail, onSelect })` | wrapper | keyed rows; `refresh(items, selected)` |
| `Menu({ groups, focus })` / `MenuButton({ label, groups })` | controller / `{ button }` | last group is for destructive items (`danger: true`) |
| `Dialog({ title, message, body, actions })` | `{ result }` | focus starts on the safe action, never a danger one; Back/Escape cancel |
| `Toast(text, { element, key, duration })` | — | transient one-line readout |
| `EmptyState({ message, action })`, `Badge({ text, tone })`, `Chip({ text, tone })` | element | badges and chips are never focusable |
| `FocusScope(container)`, `SpatialFocus.move(container, direction)` | release fn / bool | for a custom full-screen overlay of your own |

Settings section `render(container, ctx)` also receives `ctx.ui`. Use
`ctx.ui?.Button` or `"minCtxVersion": 6` if you support older app builds.

**Scope your CSS.** Core wraps every plugin settings panel, and a plugin channel's
container while it's tuned, in `[data-plugin="<id>"]`. Write
`[data-plugin="my-plugin"] .crawl-preview { … }`; selectors that reach outside
that element (`.btn`, `#setup-screen …`) are unsupported and can break when core
or a theme changes.

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

### `registerEra(era)`

Adds an era to the ERA picker (Guide & theme setup, TV menu › Guide & Theme,
docs/design/10). An era is data, never CSS — it names a `registerThemePack`
id and a handful of box-wide presentation values; applying it changes those
values (and only those), one undo step, exactly like picking one of the five
built-in eras.

```js
window.RCBPlugins.registerEra({
  id: 'my-plugin-1988', // required, unique
  label: '1988 — My Plugin\'s Take', // required
  range: [1988, 1988], // required, [startYear, endYear] — shown next to the label
  presentation: { // required — only the keys you list are touched
    theme: 'wood-console-70s', // must be a registered theme pack id
    crtEnabled: true, crtScanlines: 75, crtCurvature: 50, crtGrain: 65,
    resolution: 'sd240', aspect: '4:3', uiExtent: 'confined', clock24: false,
  },
  notes: ['Shown in the era notes panel — one string per line.'], // optional
});
```

Applying/clearing is core's job (the ERA panel and TV menu already call it);
a plugin only supplies the data. There is no dedicated hook for a plugin to
react to an era being applied in v1 — a channel plugin reading its own
`ctx.config` sees the same `config.era` shape (`{ id, fields, overrides, … }`)
core does, if you need to know which one is active.

### `registerTemplate(template)`

Adds a channel preset (a "template", docs/design/08) to CHANNELS › `+ ADD
CHANNEL` › FROM TEMPLATE and to LIBRARY › PRESETS, alongside the built-ins
and whatever the person has saved there. A preset names no paths or media —
only slots the library resolver matches against whatever the person's own
tagged library has, and the structure to compile around them once every
required slot is filled: schedule blocks (or none, for a 24/7 loop), a slot
of ads for the breaks, and the channel's on-screen look.

```js
window.RCBPlugins.registerTemplate({
  templateVersion: 1, // required, currently always 1
  id: 'my-plugin-saturday-anime', // required, unique
  name: 'Saturday Anime Block', // required
  description: 'Anime every Saturday morning, with the network bumpers in the breaks.', // optional, shown in PRESETS
  slots: { // required — at least one
    anime: { label: 'Anime', match: { 'facets.genre': ['anime'] }, min: 4, order: 'series' },
    bumpers: { label: 'Network bumpers', match: { kind: ['bumper'] }, optional: true },
  },
  // required. Only name, rating, shuffle, adsEnabled, identity, icon,
  // vhsQuality and trackCard are read; anything else is dropped at compile.
  channel: { name: 'Anime Block', rating: 'TV-14' },
  programming: [ // optional — [] or absent means the slots loop 24/7, no blocks
    { block: { days: [6], hours: [9, 12], play: { slot: 'anime' } } },
    { block: { dateRange: [12, 1, 12, 25], play: { slot: 'anime' } } }, // or a yearly date range
  ],
  // optional — the slot's files are added to the box-wide ad pool as entries
  // carrying `contentTag`, and the channel carries the same tag, so they play
  // in this channel's breaks and nowhere else. Re-applying never duplicates.
  breaks: { pool: { slot: 'bumpers' }, contentTag: 'anime-block' },
});
```

`match` is a library query (`renderer/js/library/query.js`): equality,
any-of arrays, `text`, `tags`, `any`/`not`. `order` is one of `series`,
`natural`, `shuffle` (stable per seed) or `recent`.

`channel.trackCard` — `{ enabled: true, atStart: true, atEnd: true, seconds: 8 }`
— turns on the artist / song lower third a music-video channel shows as each
video starts and ends (`renderer/js/playback/track-card.js`). The card reads
`artist` / `title` / `album` from the library item, or parses an
"Artist - Title" filename when the item has none. The built-in MUSIC
TELEVISION preset is the reference: `kind: 'music'` videos, shuffled, 24/7,
with music ads in the breaks under the `music-videos` tag.

Thrown validation errors (missing fields, a programming block naming an
unknown slot, a breaks pool naming an unknown slot) surface immediately at
registration, the same as a malformed `.rerun-template.json` import would.

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

#### Theme CSS: tokens and slots

A theme owns presentation while core owns layout, state, and density. Scope every
rule to the registered theme id. A `style.css` may contain only:

1. `html[data-theme="my-theme"]` token blocks, optionally with
   `[data-mode="tv"]`;
2. decoration rules for the documented `[data-slot="..."]` hooks;
3. scoped native-field chrome for `input`, `select`, and `textarea`;
4. keyframes. Core disables theme animation when reduced motion is requested.

Start with semantic tokens instead of the older palette names:

| Group | Main tokens |
|---|---|
| Surfaces and text | `--surface-0..3`, `--surface-panel`, `--text`, `--text-muted`, `--border` |
| Accents and states | `--accent`, `--accent-rgb`, `--accent-text`, `--accent-2`, `--focus-ring`, `--danger`, `--selected-bg`, `--selected-text`, `--button-selected-border` |
| Controls | `--control-bg`, `--control-text`, `--control-border`, `--control-border-width`, `--control-border-style`, `--control-radius`, `--control-shadow`, `--control-hover-bg`, `--control-hover-border`, `--control-active-bg`, `--control-active-shadow`, `--control-active-border-style` |
| Guide | `--guide-grid-bg`, `--guide-rail-bg`, `--guide-rail-text`, `--guide-rail-subtle`, `--guide-cell-bg`, `--guide-cell-alt-bg`, `--guide-cell-text`, `--guide-selected-bg`, `--guide-selected-text`, `--guide-timebar-bg`, `--guide-row-height`, `--guide-row-gap` |
| Motion | `--motion-control-*`, `--motion-card-*`, `--power-on-*`, `--power-off-*`, `--banner-animation`, `--channel-entry-flash-animation`, `--guide-info-update-animation`, `--guide-selected-settle-name`, `--guide-selected-pulse-name`, `--theme-guide-enter-*` |
| Optional placement | `--guide-rail-width`, `--banner-left`, `--banner-bottom`, `--banner-min-width`, `--banner-max-width`, `--channel-entry-top`, `--channel-entry-right`, `--volume-right`, `--volume-bottom` |

Core still exposes older palette names such as `--gold`, `--ink`, and
`--guide-channel-bg` as read aliases for plugin content. New theme packs should
declare the semantic names above. Themes must not set density tokens such as
`--space-*`, `--target-min`, `--font-size-*`, `--safe-*`, or `--density`.

Slots currently cover the guide (`guide-grid`, `guide-topbar`, `guide-info-*`,
`guide-timeheader`, `guide-rail`, `guide-rail-number`, `guide-rail-name`,
`guide-track`, `guide-cell`, `guide-gridlines`, `guide-now-line`, `guide-hint`),
live-TV cards (`guide-banner`, `guide-banner-number`, `guide-banner-name`,
`guide-progress`, `guide-progress-fill`, `channel-entry`, `hint-bar`,
`rating-bug`, `volume-indicator`, `volume-bar`, `volume-bar-fill`), and
`tv-menu-button` / `power-fx`. Slot rules may change color, border, radius,
shadow, typography, spacing, opacity, filters, transforms, and animation. They
may not change position, dimensions, display, overflow, or stacking. Supported
state suffixes are `.sel`, `.past`, `.digit-flash`, `.gi-update`,
`[data-active="true"]`, `:hover`, `:focus-visible`, `:active`, `:disabled`, and
`:nth-child(even)`.

Use `plugins/theme-dual-tuner-dvr-05/style.css` as the maintained reference;
`widescreen-grid-13` was the migration pilot. To convert an older pack:

1. replace palette declarations with semantic tokens;
2. move shared control and selected-state rules into control tokens;
3. replace supported visual selectors with slots and move layout values into
   the optional placement tokens;
4. keep only native-field rules and keyframes outside those blocks;
5. run `node --experimental-vm-modules --test tests/theme-contract.test.js tests/theme-tokens.test.js`, then inspect desktop and TV states in the theme sweep.

The contract and contrast checks also appear in PLUGINS diagnostics. Keep
keyboard focus visible and avoid copying logos or artwork from a real provider.

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

**Declarative fields (ctx v6).** Instead of `render`, a section can list `fields`
and core draws them from the component kit: sentence-case rows with the right
control, TV density, D-pad focus, setup search entries for every field (no
`registerEntries` needed) and inline errors when your `validate` rejects a value.

```js
sections: [{
  id: 'behavior',
  label: 'CRAWL',
  fields: [
    { key: 'enabled', type: 'toggle', label: 'Show the crawl' },
    { key: 'crawl.speed', type: 'slider', label: 'Crawl speed', min: 1, max: 10, step: 1, unit: 'x',
      dependsOn: 'enabled', synonyms: 'scroll pace', help: 'How fast the ticker moves.' },
    { key: 'crawl.style', type: 'select', label: 'Style', options: [{ value: 'ticker', label: 'Ticker' }, 'marquee'] },
    { key: 'lines', type: 'number', label: 'Lines of text', min: 1, max: 3 },
    { key: 'crawl.text', type: 'text', label: 'Custom text', placeholder: 'Leave blank for headlines' },
    { key: 'crawl.color', type: 'color', label: 'Text colour' },
  ],
}],
```

`key` is a dotted path into your plugin's settings; each change is one
`updatePluginSettings` write of that path, so `defaults`, `migrations` and
`validate` apply exactly as they do for a hand-drawn section. `dependsOn` names
a toggle field's key: the row is disabled (not hidden) while that toggle is off.
Types: `toggle`, `slider` (needs `min` < `max`), `number`, `select` (needs
`options`), `text`, `color`. A section with both `render` and `fields` uses
`render`.

Each section may set `layout` to `stack` (the default), `two-column`, or
`wide`. Core owns the responsive breakpoint: `two-column` becomes one column
in narrow windows, so plugins should describe their layout intent instead of
adding app-wide setup selectors or hardcoding a particular viewport. `wide`
keeps the section spanning the available settings grid.

### Setup search entries: `ctx.search.registerEntries(id, entries)`

The setup screen's search (Ctrl+K) always finds your plugin by its manifest `name` and
`description`, and by your sections' labels. Your individual settings are drawn by your own
`render`, so search can't see them until the plugin is open. Name them once, from `settings.js`:

```js
window.RCBPlugins.ctx.search?.registerEntries('my-plugin', [
  { label: 'Crawl speed', keywords: 'scroll pace', section: 'behavior' },
]);
```

`label` is what the result shows (sentence case), `keywords` are extra words to match, and
`section` is a `registerPluginSettings` section id to scroll to. Choosing a result opens your
plugin in Plug-ins. Calling it again replaces your earlier entries. Available from ctx v4:
use the `?.` above, or set `"minCtxVersion": 4`. `plugins/guide-channel/settings.js` has a real example.

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
core's own PIN-lock parental control (`renderer/js/setup/pin-lock.js`)
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
card, for an unconfigured channel number), `'guide-channel-cell'` (fired as
each programme-guide row is built, with `{ channel, cell }`, so a plugin can
decorate that channel's cell — append to `cell` and core neither knows nor
cares what you added), `'guide-program-actions'` (fired when someone holds OK
on a program in the guide, with `{ channel, entry, actions }` — push
`{ label, run }` onto `actions` to add an item to that program's actions menu;
`entry` is a schedule entry `{ file, start, end }`, and `run` is called after
the menu closes. `plugins/tape-deck/renderer.js` adds RECORD this way).

One thing to know about `'guide-channel-cell'`: the guide does NOT rebuild
its rows on its 30-second tick (see the render-signature fast path in
`guide.js`), so a marker added only from this hook goes stale as soon as
whatever it reports changes. Core stamps `data-channel-number` on every
channel cell for exactly that reason — re-apply your marker by querying
`.guide-row-chan[data-channel-number="N"]` when your own state changes, and
use the hook only to cover a guide opened after the fact.
`plugins/tape-deck/renderer.js`'s `paintGuideMarkers` is a worked example of
both halves.

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

### Calling your own `main.js`: `ctx.ipc` (ctx v10)

Your renderer and settings code reach your own `main.js` through the generic
plugin bridge. No `preload.js` entry is needed, so a plugin you install
yourself works in any app build at ctx v10 or later.

```js
const { ipc } = window.RCBPlugins.ctx;
// main.js: ctx.ipcMain.handle('my-plugin:search', async (event, query) => …)
const results = await ipc.invoke('my-plugin', 'my-plugin:search', 'jazz');
// main.js: ctx.sendToMainWindow('my-plugin:status', { playing: true })
const off = ipc.on('my-plugin', 'my-plugin:status', (data) => render(data));
```

- **What goes through.** `invoke` reaches a channel only if your plugin
  registered it through its own `ctx.ipcMain.handle`/`.on`, the channel is in
  your manifest's `capabilities.ipc`, and the user approved those
  capabilities. Anything else is refused with an error, including another
  plugin's channels under your id.
- **While your plugin is off.** If it's disabled or waiting for approval,
  `invoke` answers with your manifest's `fallbackIpc` value for that channel,
  or rejects if you declared none.
- **Events.** Every `ctx.sendToMainWindow(channel, data)` your `main.js`
  makes also reaches `ctx.ipc.on(yourId, channel, cb)`. Core tags each one
  with the id of the plugin that sent it, so a plugin can't speak as
  another. `on` returns a function that removes the listener.
- **Host only.** A LAN viewer has no bridge: `invoke` rejects there, and
  `ctx.ipc.available()` says whether this window has one.
- Declare `"minCtxVersion": 10` if your plugin needs it.

### `window.api` — the app's own IPC surface

Your renderer code also has full access to `window.api`, the same
contextBridge surface the core app uses (see `main/preload.js` for the
complete list) — file pickers (`selectAudio`, `selectImage`, `selectVideo`,
`selectCss`, …), `toFileUrl`, backups, config load/save. Some older
first-party plugins still have named entries of their own there; new
plugins use `ctx.ipc` above instead of adding to `preload.js`.

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

If that feature is programming — a plugin adding its own ad preset or flow to
`S.config.interstitials.presets` / `.flows` — set `pluginId: '<your-plugin-id>'`
on the item. SCHEDULE › ON AIR's explanation then shows it as
"OWNED BY <your-plugin-id>" and offers no edit, and timeline gestures that
would change its breaks say the plugin owns them instead of editing the item
(docs/design/02 §4.4). This is a data marker, not a new `ctx` call.

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
