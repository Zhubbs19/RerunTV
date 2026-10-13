// Generates the RerunTV wiki pages from the repository's own docs (README, the in-app manual, the
// plugin manifests, SECURITY.md, PLUGIN_DEVELOPMENT.md), so the wiki stays accurate. Run it again
// whenever those change.
//
//   node scripts/generate-wiki.js <repoCheckoutDir> <outDir>
//
// To publish: clone https://github.com/<owner>/RerunTV.wiki.git, copy the generated *.md files into
// it, commit and push. (GitHub creates the wiki's git repo only after a first page is saved in the
// web UI.) Hand-written pages (Home, Installation, Quick Start, Comfort, Troubleshooting, FAQ ...) live
// in this file; edit them here and regenerate rather than editing the wiki by hand.
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
const OUT = process.argv[3];
const REPO = 'Zhubbs19/RerunTV';
const BLOB = `https://github.com/${REPO}/blob/master/`;
const RAW = `https://raw.githubusercontent.com/${REPO}/master/`;
const REL = `https://github.com/${REPO}/releases`;

const bt = (s) => s.split('«').join('`'); // « stands for a backtick in hand-written pages
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/\r\n/g, '\n');
const pages = {};
const add = (name, md) => { pages[name] = md.trim() + '\n'; };

// ---------- helpers ----------
function section(md, heading, n = 2) {
  const lines = md.split('\n');
  const want = '#'.repeat(n) + ' ' + heading;
  let fence = false; let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fence = !fence;
    if (!fence && lines[i].trim() === want) { start = i; break; }
  }
  if (start < 0) throw new Error('missing section: ' + heading);
  const stop = new RegExp('^#{1,' + n + '} ');
  let j = start + 1; fence = false;
  for (; j < lines.length; j++) {
    if (/^```/.test(lines[j])) fence = !fence;
    if (!fence && stop.test(lines[j])) break;
  }
  return lines.slice(start + 1, j).join('\n').trim();
}

function shiftHeadings(md, by) {
  let fence = false;
  return md.split('\n').map((l) => {
    if (/^```/.test(l)) fence = !fence;
    if (fence) return l;
    const m = /^(#{1,6}) /.exec(l);
    if (!m) return l;
    const n = Math.min(6, Math.max(1, m[1].length + by));
    return '#'.repeat(n) + l.slice(m[1].length);
  }).join('\n');
}

const ANCHORS = {
  '#download-and-install': 'Installation', '#setup': 'Building-from-Source',
  '#try-it-without-your-own-media': 'Quick-Start', '#screenshots': 'Home',
};
function fixLinks(md) {
  return md.replace(/\]\(([^)\s]+)\)/g, (m, u) => {
    if (/^(https?:|mailto:)/.test(u)) return m;
    if (u.startsWith('#')) return `](${ANCHORS[u] || 'Home'})`;
    if (/^\.\.\/\.\.\/releases/.test(u)) return `](${REL})`;
    const p = u.replace(/^\.\//, '');
    return `](${/\.(png|jpe?g|gif|svg)$/i.test(p) ? RAW : BLOB}${p})`;
  });
}
const clean = (md) => fixLinks(md);

const slug = (h) => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/ /g, '-');
const firstSentence = (t, max = 230) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  const m = s.split(/(?<=[.!?])\s+(?=[A-Z"'(])/)[0];
  return (m.length > max ? m.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : m);
};
const esc = (t) => String(t).replace(/\|/g, '\\|');

// ---------- sources ----------
const README = read('README.md');
const SECURITY = read('SECURITY.md');
const PLUGDEV = read('PLUGIN_DEVELOPMENT.md');
const settingsJs = read('renderer/js/setup/settings.js');
const HELP = eval('[' + settingsJs.match(/const HELP_GUIDE = \[([\s\S]*?)\n\];/)[1] + ']');

const intro = (() => {
  const lines = README.split('\n');
  const a = lines.findIndex((l) => l.startsWith('A desktop simulator'));
  const b = lines.findIndex((l) => l.startsWith('> **Photosensitivity notice'));
  return lines.slice(a, b).join('\n').trim();
})();

const SHOT = (f, alt) => `![${alt}](${RAW}docs/screenshots/${f})`;

// ---------- Home ----------
add('Home', bt(`
# RerunTV wiki

${intro}

| | |
| --- | --- |
| ${SHOT('live.jpg', 'Live TV')} | ${SHOT('guide.jpg', 'Program guide')} |
| ${SHOT('setup.png', 'Channel setup')} | ${SHOT('time-machine.jpg', 'Time machine')} |

*(Screenshots show the bundled synthetic demo library, not real shows.)*

> **Beta software.** Releases are numbered «0.2.0-beta.N«. The Windows installers are **not code-signed yet**, so Windows will warn you the first time you run one. See [Installation](Installation) for why and how to check a download.

## Start here

- [Installation](Installation): download, the SmartScreen warning, first run, where your data lives
- [Quick Start](Quick-Start): your first channel in a few minutes, or try the demo library
- [Keyboard Controls](Keyboard-Controls): every key, plus the time machine
- [Comfort and Photosensitivity](Comfort-and-Photosensitivity): flicker, static and flashing effects and how to turn them down

## Learn the app

- [Features](Features): the full feature list
- The manual, by topic: [Getting started](Manual-Getting-Started) · [Channels](Manual-Channels) · [Programming](Manual-Programming) · [Picture, sound and themes](Manual-Picture-Sound-and-Themes) · [Household, library and system](Manual-Household-Library-and-System) · [Special channels](Manual-Special-Channels) · [The setup screen](Manual-Using-the-Setup-Screen) · [The plug-ins tab](Manual-Plugins-Tab)
- [Plugins](Plugins) and [Themes](Themes)
- [Headless, LAN and Remotes](Headless-LAN-and-Remotes)
- [Updates and Versions](Updates-and-Versions)

## Get help

- [Troubleshooting](Troubleshooting) and the [FAQ](FAQ)
- [Report a bug or ask for a feature](https://github.com/${REPO}/issues/new/choose)
- Security issues: [Security](Security) (please report privately)

## Build on it

- [Building from Source](Building-from-Source), [Development](Development), [Architecture](Architecture)
- [Plugin Development](Plugin-Development)

RerunTV is MIT licensed and is not affiliated with or endorsed by any broadcaster, network or studio. It ships no media: you bring your own.
`));

// ---------- Installation ----------
add('Installation', bt(`
# Installation

${clean(section(README, 'Download and install'))}

## First run

A new install opens a short three-page setup before Channel Setup:

1. **Welcome**: what RerunTV changes and what it does not (your media stays where it is, setup autosaves and keeps backups, network features are optional).
2. **Choose how it looks**: *Full retro look* (the default), *Gentle* (no screen flicker or channel-change static) or *Minimal* (the CRT effect off as well). See [Comfort and Photosensitivity](Comfort-and-Photosensitivity).
3. **Choose how RerunTV updates**: before the app opens, after it opens (install when you quit, or ask when ready), only when you ask, or never. See [Updates and Versions](Updates-and-Versions).

Then you land on **Channel Setup**. Continue with the [Quick Start](Quick-Start).

On a TV, the same choices are in a remote-driven wizard (welcome, channels, look, updates, remote check).

## Where your data lives

RerunTV is portable: your channels, settings, backups, plugins and library live in a **«userData«** folder next to the app, so the whole box can be copied or backed up as one folder. Setup keeps rotating backups of your settings, and the app takes a backup before an update installs. Before any big change, copy the «userData« folder somewhere safe.

## Requirements

- Windows for the packaged installers. The source also runs where Electron does, and macOS and Linux builds are configured but untested.
- [ffmpeg](https://ffmpeg.org/download.html) on your PATH is optional. It is only needed to convert videos the built-in player cannot decode. See [Supported video formats](Troubleshooting#video-will-not-play-or-the-picture-is-black).

Building from source instead? See [Building from Source](Building-from-Source).
`));

// ---------- Quick Start ----------
add('Quick-Start', bt(`
# Quick Start

## Your first channel

1. Install and open RerunTV (see [Installation](Installation)) and work through the first-run setup.
2. In **Channel Setup**, open the **LINEUP** tab and click **+ ADD CHANNEL**.
3. Click **ADD FOLDER** and pick a folder of videos from your own library. The app scans it and reads each file's length. This takes a moment on a large folder.
4. Repeat for more channels (or **ADD FOLDER** again to merge more folders into one channel). Click a channel's name or number to rename or renumber it.
5. Click **START WATCHING** (bottom right).

You are now surfing live TV: the picture you land on is where the channel *would be* if its folder had been looping since you created it. Press **S** any time to go back to setup.

## Things to try first

| Key | What it does |
| --- | --- |
| ↑ / ↓ | Change channel |
| **G** | Open the program guide |
| **T** | Time machine: rewind or fast-forward (enable it in Box Settings first) |
| **C** | Toggle the CRT effect |
| **?** | Open the TV menu |
| **H** | Hide or show the hint bar |

All keys are listed on [Keyboard Controls](Keyboard-Controls).

## No media handy? Use the demo library

${clean(shiftHeadings(section(README, 'Try it without your own media'), 0))}

## Where next

- [Manual: Getting Started](Manual-Getting-Started) and [Manual: Channels](Manual-Channels)
- [Comfort and Photosensitivity](Comfort-and-Photosensitivity) if flicker or static bothers you
- [Troubleshooting](Troubleshooting) if something does not work
`));

// ---------- Keyboard controls ----------
add('Keyboard-Controls', bt(`
# Keyboard Controls

${clean(shiftHeadings(section(README, 'Controls'), 0))}

The same actions are available from a TV remote or the phone remote; see [Headless, LAN and Remotes](Headless-LAN-and-Remotes).
`));

// ---------- Features ----------
add('Features', bt(`
# Features

${clean(shiftHeadings(section(README, 'Features'), -1))}
`));

// ---------- Manual pages (mirrors the in-app manual) ----------
const MANUAL = [
  ['Manual-Getting-Started', 'Getting Started', [1, 2]],
  ['Manual-Channels', 'Channels', [3]],
  ['Manual-Programming', 'Programming', [4]],
  ['Manual-Picture-Sound-and-Themes', 'Picture, Sound, Guide and Theme', [5]],
  ['Manual-Household-Library-and-System', 'Household, Library and System', [6]],
  ['Manual-Special-Channels', 'Special and Virtual Channels', [7]],
  ['Manual-Using-the-Setup-Screen', 'Using the Setup Screen', [8]],
  ['Manual-Plugins-Tab', 'The Plug-ins Tab', [9]],
];
const para = (t) => t.replace(/^(STEP \d+|NOTE|TIP|CAUTION|WARNING|IMPORTANT):\s*/, (m, k) => `**${k}:** `);
MANUAL.forEach(([name, title, nums]) => {
  const entries = HELP.filter((e) => nums.includes(Number(e.group.match(/SECTION (\d+)/)[1])));
  const nav = MANUAL.map(([n, t]) => (n === name ? `**${t}**` : `[${t}](${n})`)).join(' · ');
  const body = entries.map((e) => `## ${e.title}\n\n${e.body.map(para).join('\n\n')}`).join('\n\n');
  add(name, `# Manual: ${title}\n\n*This page mirrors the in-app manual (the HELP tab in Setup). Words in capitals are labels you will see on screen.*\n\n${nav}\n\n${body}\n`);
});

// ---------- Plugins ----------
const pluginRows = fs.readdirSync(path.join(SRC, 'plugins'))
  .filter((d) => fs.existsSync(path.join(SRC, 'plugins', d, 'manifest.json')))
  .map((d) => { const m = JSON.parse(fs.readFileSync(path.join(SRC, 'plugins', d, 'manifest.json'), 'utf8')); return { dir: d, m }; });
const byId = Object.fromEntries(pluginRows.map((r) => [r.m.id || r.dir, r.m]));
const CAPNAME = { ipc: 'talks to the app', spawn: 'starts programs', net: 'network', system: 'system actions', mediaSource: 'media source' };
const caps = (m) => Object.keys(m.capabilities || {}).filter((k) => Array.isArray(m.capabilities[k]) && m.capabilities[k].length).map((k) => CAPNAME[k] || k).join(', ') || '-';
const GROUPS = [
  ['Virtual and special channels', ['video-in', 'guide-channel', 'public-access', 'local-weather', 'party-channel', 'tape-deck', 'mosaic', 'pay-per-view', 'teletext-arcade', 'digital-music-channel']],
  ['On-screen overlays and broadcast effects', ['breaking-news', 'eas-alerts', 'film-reel-marks', 'signal-glitches', 'smpte-test-pattern', 'sponsor-billboard', 'screensaver', 'ticker', 'closed-captions']],
  ['Audio', ['sap-audio', 'vintage-audio']],
  ['Services and integrations', ['noaa-weather', 'tmdb-metadata', 'cast-to-tv', 'companion-app', 'ffmpeg-transcode']],
];
const nonTheme = pluginRows.map((r) => r.m.id || r.dir).filter((id) => !id.startsWith('theme-'));
const listed = GROUPS.flatMap((g) => g[1]);
const missing = nonTheme.filter((id) => !listed.includes(id));
const unknown = listed.filter((id) => !byId[id]);
if (missing.length || unknown.length) throw new Error('plugin grouping out of date: missing ' + missing + ' unknown ' + unknown);

const groupTables = GROUPS.map(([title, ids]) => `### ${title}\n\n| Plugin | What it does | Runs isolated | Needs permission to |\n| --- | --- | --- | --- |\n` +
  ids.map((id) => { const m = byId[id]; return `| **${esc(m.name)}** | ${esc(firstSentence(m.description))} | ${m.isolated ? 'yes' : 'no'} | ${caps(m)} |`; }).join('\n')).join('\n\n');

add('Plugins', bt(`
# Plugins

Much of what RerunTV does comes from plugins: every special channel, the overlays, the remote control, weather and show-info lookups, even the themes. The app ships **${pluginRows.length} bundled plugins** (${nonTheme.length} features and ${pluginRows.length - nonTheme.length} theme packs, listed on [Themes](Themes)). Turn any of them on or off in **Setup > PLUG-INS**; a change takes effect after a restart.

Plugins that need more than basic access (talking to the network, starting a program, opening a port) list exactly what they need, and you approve it before they run. A plugin that asks for approval again after an update has changed its permissions or been renamed: check the list and approve it again.

${groupTables}

**Runs isolated** means the plugin's code runs in its own separate process, so a crash or misbehavior cannot take the app down with it, and what it may touch is enforced. Plugins that are not isolated run inside the app's main process, which is why you should only install plugins you trust.

## Plugins that can flash or flicker

If you are sensitive to flashing, you may want to turn off *Ambient Signal Glitches*, *Breaking News Alerts*, *Emergency Alert System* and *Film Reel-Change Cue Marks*. See [Comfort and Photosensitivity](Comfort-and-Photosensitivity).

## More

- How the PLUG-INS tab works: [Manual: The Plug-ins Tab](Manual-Plugins-Tab)
- Writing your own: [Plugin Development](Plugin-Development)
- Security model for plugins: [Security](Security)
`));

// ---------- Themes ----------
const eras = [...read('renderer/js/display/eras.js').matchAll(/id: '([^']+)', label: '([^']+)'/g)].map((m) => m[2]);
const themeRows = pluginRows.filter((r) => (r.m.id || r.dir).startsWith('theme-')).map((r) => r.m).sort((a, b) => a.name.localeCompare(b.name));
add('Themes', bt(`
# Themes

A theme re-skins the program guide, the on-screen banners and the setup screen. Each one is a bundled plugin; pick one in **Setup > GUIDE & THEME**. Themes marked *+ border* also draw a decorative frame around the picture.

| Theme | Look |
| --- | --- |
${themeRows.map((m) => `| **${esc(m.name)}** | ${esc(firstSentence(m.description.replace(/^Theme( \+ border)? pack:\s*/i, ''), 200))}${/^Theme \+ border/i.test(m.description) ? ' *(+ border)*' : ''} |`).join('\n')}

## Eras

An **era** applies a whole period look at once (theme, CRT settings and the matching on-screen style) and remembers what it replaced, so you can clear it and get your own settings back exactly. The built-in eras are:

${eras.map((e) => `- ${e}`).join('\n')}

Pick an era in setup, or from the TV menu on a TV.

## Comfort

Themes change colors and layout, not the flicker. If flicker or static is a problem, see [Comfort and Photosensitivity](Comfort-and-Photosensitivity).

See also [Manual: Picture, Sound, Guide and Theme](Manual-Picture-Sound-and-Themes).
`));

// ---------- Comfort and photosensitivity ----------
add('Comfort-and-Photosensitivity', bt(`
# Comfort and Photosensitivity

RerunTV imitates old television, and some of those effects flicker or flash. It also plays whatever video you give it, which the app cannot control. **If you are sensitive to flashing lights or patterns, set the effects down or off before you start watching.** This is general guidance, not medical advice. If you ever feel unwell while watching, stop and take a break.

## Choose a level on first run

The first-run setup has a **Choose how it looks** page (also in the TV wizard):

| Level | What it does |
| --- | --- |
| **Full retro look** (default) | Scanlines, screen flicker, and a brief static burst when you change channel. |
| **Gentle** | Keeps the scanlines but turns off screen flicker and the channel-change static. |
| **Minimal** | Also turns the CRT effect off entirely, for a clean picture. |

## Change it any time

In **Setup > PICTURE & SOUND**:

- **CRT effect**: the on/off switch (also the **C** key). With it off you also lose the scanlines, vignette and the power on/off animations.
- **Flicker** slider: set it to **0**.
- **Channel static**: turn it off to remove the burst when you change channel.
- The other CRT sliders (scanlines, vignette, grain, curvature, burn-in) change the picture's look, not its flicker.

In **Setup > PLUG-INS**, you can turn off the overlays that may flash:

- **Ambient Signal Glitches** (rare, brief static or tearing bursts)
- **Breaking News Alerts** (random or on-demand overlays; the **B** key triggers one)
- **Emergency Alert System** (a full-screen alert slate with a tone)
- **Film Reel-Change Cue Marks** (a small dot that flashes in a corner)

## The demo library is gentle on purpose

The generated demo library (see [Quick Start](Quick-Start)) uses slow, soft-colored gradients and quiet tones, and its ready-made config turns the static and flicker off. Your own videos are, of course, up to you.

More: [Manual: Picture, Sound, Guide and Theme](Manual-Picture-Sound-and-Themes) · [Plugins](Plugins)
`));

// ---------- Updates and versions ----------
const versioning = (README.match(/\*\*Versioning\.\*\*[\s\S]*?\n\n/) || [''])[0].trim();
add('Updates-and-Versions', bt(`
# Updates and Versions

${versioning}

## Choosing when updates happen

In **Setup > SYSTEM** the **Update policy** setting offers:

- **BEFORE APP OPENS — INSTALL AUTOMATICALLY**: check and install first, then open the full app
- **AFTER APP OPENS — INSTALL WHEN I QUIT**
- **AFTER APP OPENS — ASK WHEN READY**
- **ONLY WHEN I ASK**: use the **CHECK NOW** button
- **NEVER**

**HELP > WHAT'S NEW** lists what changed in each release. If an update fails or the network is down, RerunTV carries on normally.

## Your data is kept

Your channels and settings live in the «userData« folder next to the app, and a backup is taken before an update installs, so an update keeps your lineup. Some plugins are renamed between releases; your settings and approvals for them are carried over automatically, though a plugin whose permissions changed may ask you to approve it once.

## Checking a download

Releases are built by this repository's CI and are **not code-signed yet**. See [Installation](Installation) for why Windows warns and how to verify an installer with the checksum file or the GitHub attestation. Every release lists its files on the [Releases page](${REL}).

## Release assets

Each release has the installer (\`RerunTV-Setup-<version>.exe\`), its blockmap and \`latest.yml\` (what the in-app updater reads), and \`SHA256SUMS.txt\`.

See also [Security](Security).
`));

// ---------- Headless, LAN and remotes ----------
const entry = (prefix) => HELP.find((e) => e.title.startsWith(prefix));
const entryMd = (prefix) => { const e = entry(prefix); return `## ${e.title.replace(/^\d+\.\d+ /, '')}\n\n${e.body.map(para).join('\n\n')}`; };
add('Headless-LAN-and-Remotes', bt(`
# Headless, LAN and Remotes

RerunTV can be controlled and watched from other devices on your home network. These services are **off by default**, are protected by a pairing code, and are plain HTTP, so use them only on a network you trust. See [Security](Security).

${entryMd('6.2 ')}

${entryMd('6.3 ')}

${entryMd('6.5 ')}

## Headless / server mode

${clean(shiftHeadings(section(README, 'Headless / server mode', 3), 0))}

More: [Manual: Household, Library and System](Manual-Household-Library-and-System)
`));

// ---------- Troubleshooting ----------
add('Troubleshooting', bt(`
# Troubleshooting

## Windows says "Windows protected your PC"

Expected: the installers are not code-signed yet. Click **More info**, then **Run anyway**, and verify the download first (see [Installation](Installation)).

## Video will not play, or the picture is black

Best results come from **.mp4 (H.264)** and **.webm**; **.mov** and **.m4v** are scanned too. Anything the built-in player cannot decode is caught and converted once. For that, install [ffmpeg](https://ffmpeg.org/download.html) and make sure it is on your PATH (or set a custom path under **DISPLAY & SYSTEM > FFMPEG** in setup). To convert a whole channel up front instead of on demand, use **FIX PLAYBACK** on the channel. If a file still fails, try **CHECK CHANNELS** in setup to find files that cannot be read.

## A channel is empty or "nothing to play"

The folder may have moved, or the files may be unreadable. Use **RESCAN ALL FOLDERS** and **CHECK CHANNELS** in setup. A channel that points at a folder that no longer exists has nothing to schedule.

## The time machine key does nothing

The time machine is off until you enable it in **Box Settings**. Then press **T**. See [Keyboard Controls](Keyboard-Controls).

## Too much flicker, static or flashing

See [Comfort and Photosensitivity](Comfort-and-Photosensitivity): set the flicker slider to 0, turn **Channel static** off, press **C** to switch the CRT effect off, and turn off the glitch and alert plugins.

## A plugin stopped working or asks for approval again

After an update, a plugin whose permissions changed (or that was renamed) needs approving again. Open **Setup > PLUG-INS**, review what it asks for, and approve it. Plugin changes take effect after a restart.

## The phone remote or LAN viewer will not connect

Both only work on the same home Wi-Fi as the box (not cellular data, and not a guest network). Make sure the service is switched on in setup, then save and restart. Use the current pairing code or link. See [Headless, LAN and Remotes](Headless-LAN-and-Remotes).

## A key does nothing, or clashes with another shortcut

The single-letter keys can be remapped in **SETTINGS > System > Keys**. See [Keyboard Controls](Keyboard-Controls).

## I think I lost my channels

Setup keeps rotating backups; click **RESTORE** next to one (and Ctrl+Z undoes even that). If you copied your «userData« folder before an update, you can copy it back. See [Manual: Household, Library and System](Manual-Household-Library-and-System).

## Updates do not appear

Releases are pre-releases (beta), and the in-app check follows that series. Use **CHECK NOW** in **Setup > SYSTEM**, and check your **Update policy**. See [Updates and Versions](Updates-and-Versions).

## Reporting a bug

Open an [issue](https://github.com/${REPO}/issues/new/choose) with your RerunTV version (shown in HELP), what you did and what you expected. A **redacted support bundle** (**Setup > PLUG-INS**, diagnostics) helps; it removes credentials and user-specific paths first, and does not include your channel configuration or media inventory. Please do **not** attach copyrighted media, pairing links or codes, or your «channels.json«. For security problems, see [Security](Security).
`));

// ---------- FAQ ----------
add('FAQ', bt(`
# FAQ

**Does RerunTV include any shows, movies or music?**
No. It ships no media at all. You point it at folders in your own library. The demo library script generates synthetic test video so you can try the app without any.

**Is it affiliated with a broadcaster, network or studio?**
No. Any resemblance to a real channel's on-screen look is a period-style homage built from original code and free fonts.

**How does a channel know what is "playing now"?**
It never restarts. Each channel has an anchor time, and the app computes what would be airing if the folder had been looping since then, so tuning in mid-show works like real live TV. Nothing runs in the background, so closing the app for a week costs nothing.

**What is the time machine?**
Because "now" is just a number the app computes from, you can scrub backward or forward and see what would have aired. See [Keyboard Controls](Keyboard-Controls).

**Does it collect data or phone home?**
There is no telemetry. It only uses the network for things you choose: update checks, weather alerts, optional metadata lookups, the optional ffmpeg download, and Cast. LAN features are off by default. See [Security](Security).

**Which systems does it run on?**
The packaged installers are for Windows. The source runs wherever Electron does, and macOS and Linux builds are configured but untested.

**Why are the installers unsigned?**
Code signing needs a certificate and a validated publisher, which this project does not have yet. Releases ship with a checksum file and a signed build attestation so you can verify them. See [Installation](Installation).

**Where is my data?**
In the «userData« folder next to the app. See [Installation](Installation).

**Can I use it on a TV?**
Yes: there is a TV mode with remote-driven setup, a LAN viewer, and an Android TV client in the repository. See [Headless, LAN and Remotes](Headless-LAN-and-Remotes).

**Can I write my own plugin or theme?**
Yes. See [Plugin Development](Plugin-Development).

**Who built it?**
RerunTV is built with Claude Code, directed by a single project owner: Claude writes the code, and the project owner sets direction, makes the product and architecture calls, and reviews and approves everything that ships.

**What license is it under?**
MIT. Third-party notices are in the repository's [THIRD_PARTY_NOTICES.md](${BLOB}THIRD_PARTY_NOTICES.md).
`));

// ---------- Architecture ----------
const designDocs = fs.readdirSync(path.join(SRC, 'docs', 'design')).filter((f) => f.endsWith('.md')).sort()
  .map((f) => ({ f, title: (read('docs/design/' + f).match(/^# (.+)$/m) || [null, f])[1] }));
add('Architecture', bt(`
# Architecture

RerunTV has three kinds of process: the Electron **main** process (Node), the **renderer** (the on-screen "TV"), and optional **isolated plugin** processes for plugins that ask for them.

${clean(shiftHeadings(section(README, 'Architecture'), 0))}

## Design documents

The larger reworks each started as a numbered design document in the repository:

${designDocs.map((d) => `- [${d.title}](${BLOB}docs/design/${d.f})`).join('\n')}

Next: [Development](Development) · [Plugin Development](Plugin-Development)
`));

// ---------- Building from source ----------
add('Building-from-Source', bt(`
# Building from Source

## Requirements

${clean(section(README, 'Requirements'))}

## Run it

${clean(shiftHeadings(section(README, 'Setup'), 0).split('### Headless')[0].trim())}

## Tests

«npm test« runs the unit and contract tests (about 470 of them). It must pass before you open a pull request. CI runs it on every push and pull request.

A separate suite drives the real Electron window over the Chrome DevTools Protocol (the «tests/ui/« folder, with its own README). **Read that README first**: the app keeps its data in a «userData« folder next to the app, so any automated run must back up and restore that folder.

## Server mode

See [Headless, LAN and Remotes](Headless-LAN-and-Remotes).

## Packaging

${clean(shiftHeadings(section(README, 'Packaging'), 0))}

Next: [Development](Development)
`));

// ---------- Development ----------
add('Development', bt(`
# Development

${clean(section(README, 'Development'))}

## The one rule that matters most

Everything that reads "now" for schedule or playback must go through «viewNow()« (in «renderer/js/core/state.js«) and never «Date.now()«. It is time-machine-aware, so scrubbing and tuning in produce the right schedule with no separate history to keep. Schedule resolution is a **pure function of (channel, timestamp)**, which is what makes the time machine possible. Treat a bare «Date.now()« in schedule or playback code as a bug unless it is one of the few documented real-time exceptions.

## Editing config

Every config edit in the renderer is a **named command** (with an inverse, for undo). Do not add bare saves. Main-process edits go through the config host, which applies commands with revisions so two windows or a paired phone cannot overwrite each other. Do not cache anything derived from config without keying it on the config generation counter.

## Design decisions

${clean(shiftHeadings(section(README, 'Design decisions'), 0))}

## Contributing

Read [CONTRIBUTING.md](${BLOB}CONTRIBUTING.md) and the [Code of Conduct](${BLOB}CODE_OF_CONDUCT.md). In short:

- Keep changes focused and add or update a test when behavior changes.
- Match the surrounding code.
- **Never add copyrighted media, logos, trademarked branding or real network schedules.** Use made-up names in fixtures and examples.
- Report security issues privately ([Security](Security)).
- If a change is visible to users, add a dated entry to the in-app *What's New* (the «CHANGELOG« in «renderer/js/setup/settings.js«).

The repository has a pull request template, issue forms, Dependabot updates, CodeQL scanning, and a CI workflow.

More: [Architecture](Architecture) · [Plugin Development](Plugin-Development) · [Building from Source](Building-from-Source)
`));

// ---------- Plugin development ----------
const plugH = [...PLUGDEV.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
add('Plugin-Development', bt(`
# Plugin Development

The full plugin author's guide is [PLUGIN_DEVELOPMENT.md](${BLOB}PLUGIN_DEVELOPMENT.md) in the repository. It is the source of truth and is kept in step with the plugin API. This page is a map of it plus the two sections you should read first. A starter plugin lives in the repository's «plugin-dev-kit/« folder.

## Sections of the guide

${plugH.map((h) => `- [${h}](${BLOB}PLUGIN_DEVELOPMENT.md#${slug(h)})`).join('\n')}

## New plugin checklist

${clean(shiftHeadings(section(PLUGDEV, 'New plugin checklist'), 1))}

## Trust model

${clean(shiftHeadings(section(PLUGDEV, 'Trust model — read this first'), 1))}

See also [Plugins](Plugins), [Security](Security) and [Architecture](Architecture).
`));

// ---------- Security ----------
add('Security', bt(`
# Security

This page mirrors the repository's [SECURITY.md](${BLOB}SECURITY.md), which is the source of truth.

${clean(shiftHeadings(SECURITY.replace(/^# .+\n/, ''), 0).trim())}
`));

// ---------- Sidebar and footer ----------
add('_Sidebar', bt(`
**[Home](Home)**

**Use**
- [Installation](Installation)
- [Quick Start](Quick-Start)
- [Keyboard Controls](Keyboard-Controls)
- [Features](Features)
- [Comfort and Photosensitivity](Comfort-and-Photosensitivity)
- [Updates and Versions](Updates-and-Versions)

**Manual**
- [Getting Started](Manual-Getting-Started)
- [Channels](Manual-Channels)
- [Programming](Manual-Programming)
- [Picture, Sound and Themes](Manual-Picture-Sound-and-Themes)
- [Household, Library and System](Manual-Household-Library-and-System)
- [Special Channels](Manual-Special-Channels)
- [The Setup Screen](Manual-Using-the-Setup-Screen)
- [The Plug-ins Tab](Manual-Plugins-Tab)

**Extend**
- [Plugins](Plugins)
- [Themes](Themes)
- [Headless, LAN and Remotes](Headless-LAN-and-Remotes)

**Help**
- [Troubleshooting](Troubleshooting)
- [FAQ](FAQ)

**Develop**
- [Building from Source](Building-from-Source)
- [Development](Development)
- [Architecture](Architecture)
- [Plugin Development](Plugin-Development)
- [Security](Security)
`));
add('_Footer', `RerunTV is MIT licensed, in beta, and not affiliated with any broadcaster, network or studio. [Releases](${REL}) · [Issues](https://github.com/${REPO}/issues) · [Repository](https://github.com/${REPO})`);

// ---------- write ----------
fs.mkdirSync(OUT, { recursive: true });
for (const [name, md] of Object.entries(pages)) fs.writeFileSync(path.join(OUT, name + '.md'), md);
console.log(Object.keys(pages).length + ' pages written to ' + OUT);
