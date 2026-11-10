# RerunTV Companion (React Native)

A phone remote for a RerunTV box, built with Expo (React Native, TypeScript) for Android and iOS. It talks
to the same companion HTTP API as the web remote the box serves (`plugins/companion-app/main.js`), so the
box needs the **Companion** service switched on and the phone on the same network.

Design: Material 3 structure (tonal surfaces, 48dp targets, bottom navigation with a pill indicator,
segmented buttons, bottom sheets, snackbars) with LED-style numerals, in the paired box's own colours. The
box sends its theme's colour tokens on `/state` (`theme`, from `renderer/js/display/companion-theme.js`) and
`src/lib/palette.ts` turns them into the app's colour roles, keeping text readable. The last palette is
remembered, so the app opens in the box's colours. Before pairing, or with a box too old to send its theme,
the app wears its own amber and cyan on near-black. Screens read colours with `useTheme()` and build styles
with `makeStyles()` (`src/theme.tsx`); the small component kit is `src/components/ui.tsx`.

## Run it

```bash
cd companion-rn
npm install
npx expo start          # scan the QR code with Expo Go on your phone
```

Camera (pairing QR), secure store, haptics, network info and the slider are all in Expo Go. The one
exception is UDP broadcast discovery (see below), which needs a development build. For installable builds
use EAS (`npx eas-cli build`).

## Pairing and finding the box

On the pairing screen the app searches for boxes by itself and lists them under NEARBY BOXES; tap one, enter
the 8-digit code, PAIR. Or scan the pairing QR code the box shows, or type the address.

Two search methods run together:

- **Subnet scan** (works everywhere, including Expo Go): asks every address on the phone's /24 whether the
  companion port answers with the box's pairing page. Takes a few seconds. iOS asks for local network access
  the first time.
- **UDP broadcast** (`react-native-udp`, native): the box answers a one-line request on port 41234 with its
  name and ports. Only available in a development or release build; skipped quietly in Expo Go. iOS may
  restrict broadcast sockets without a special entitlement, which is why the scan exists.

Pairing trades the code for a session token (`GET /?pair=CODE` with `Accept: application/json`), kept in the
device's secure storage. The code itself is never stored. Sessions last 90 days and renew while in use.
"Forget this box" (MORE tab) deletes the token.

## Screens

- **Remote**: now-playing card (channel, programme, time left, next, sleep countdown, skip break), power /
  mute / guide / info, channel and volume rockers that repeat when held, channel list / keypad / D-pad,
  picture and sound, time machine. Tablets and landscape phones get two columns.
- **Screen** (`src/app/(tabs)/screen.tsx`): what the box's screen shows, from `GET /api/ui`
  (`renderer/js/remote/companion-control.js`): the top surface (dialog, TV menu, guide, setup page or live TV),
  the setup breadcrumb, and every control on it, grouped. A tap presses, picks, adjusts or focuses the real
  control (`POST /api/ui { op, snapshot, index }`), and the text box types into the focused field
  (`{ op: 'text', text, submit }`). Host-only controls (plug-ins, network, updates, backups, PIN lock, PC power)
  come back `locked` and can't be pressed. The D-pad sends RemoteKey names (`POST /command { remote, long }`),
  which the box routes through its TV-mode remote path; an older box without `remote-keys` in `/state`'s
  `features` gets the keyboard keys instead (`src/lib/screen-model.ts`).
- **Guide**: now and next for every channel with search and a favorites filter, plus controls for the TV's
  on-screen guide.
- **Lineup**: tune, favorite and quick-channel toggles.
- **More**: breaking news, EAS test, trivia, ticker, setup shortcuts, PC shutdown (when the box allows it),
  connection info, **BOX SETTINGS** and **SCHEDULE CALENDAR**.
- **Schedule calendar** (`src/app/calendar.tsx`, `src/app/block.tsx`): a channel's month as the box's
  SCHEDULE › CALENDAR draws it (`GET /api/calendar?channel&year&month`), with each day's block, overlaps,
  blocks with no folder and day overrides; the blocks themselves, and a block editor (dates or weekly hours,
  days, priority, loop / one a day / one a week, folder). Edits are calendar operations
  (`POST /api/calendar { channel, baseRevision, ops }`: create, update, remove, overrideDay) that the box applies
  through its config host as a remote client, so an edit made against an old revision of the same block is
  refused rather than merged. A folder is picked from `/api/roots` and `/api/files` and scanned on the box
  (`POST /api/calendar/folder`). The model is `src/lib/calendar.ts`.
- **Box settings** (`src/app/settings.tsx`): a box that serves `GET /api/settings/registry` (its settings
  registry, `renderer/js/core/settings-registry.js`) gets the box's own sections and pages, a SIMPLE / ADVANCED
  switch, defaults for settings never saved, and dimmed fields whose switch is off
  (`buildRegistryGroups`). Those fields save as `POST /api/settings { patch: { $set: [{ path, value }] } }`, which
  the box checks and clamps. Plugin and channel sections the registry doesn't cover, and every setting on an
  older box, use the generic editor shared with the web remote: search, switches, sliders, pickers (bottom
  sheet), text lists and JSON lists, sent as a plain patch. Either way the box reports back what it applied or
  refused (read from `/state`) and the editor reloads. The PIN lock, network, updates and PC power are never
  editable from a phone. The curated tables for older boxes (`src/lib/settings-meta.ts`) are generated from the
  web remote's; the logic is `src/lib/settings-model.ts`.

## Screen sizes

`src/lib/layout.ts` decides the layout (compact under 360dp, regular, large, wide from 700dp), `useLayout`
feeds it the window size and notch insets. Phones use the full width, tablets and landscape get a centered
column (560dp, or two columns up to 1040dp on the Remote tab). Small phones get smaller D-pad keys, a
smaller channel plate and icon-free segmented buttons. System font size is honoured up to 1.3x so dense
labels do not overflow. Rotation is allowed.

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # pure logic: addresses, layout, settings model, screen model, calendar, discovery (incl. a real local scan)
```

`npx expo export --platform android` bundles the JS and is a quick "does it build" check.

## Building the APK (GitHub Actions)

`.github/workflows/companion-apk.yml` builds both phone apps on Linux (the React Native Android build does not
work on Windows: its C++ step exceeds the 260-character path limit). It runs on pushes and pull requests that
touch `companion-rn/` or `android-companion-client/`, and by hand from the Actions tab (Run workflow, with a choice
of CPU architectures).

- `reruntv-companion-rn`: this app, a release APK (`arm64-v8a` and `armeabi-v7a` by default).
- `reruntv-companion-web`: the Kotlin WebView shell, a debug APK.

Download them from the run's summary page; they are kept for 30 days. They are artifacts, not GitHub Releases, so
they never interfere with the installer workflow's single-prerelease updates.

Without secrets the React Native APK is signed with the debug key the Expo template uses, which is fine for
sideloading. To sign with your own key, add these repository secrets: `ANDROID_KEYSTORE_BASE64` (the keystore file,
base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
