# RerunTV Companion (React Native)

A phone remote for a RerunTV box, built with Expo (React Native, TypeScript) for Android and iOS. It talks
to the same companion HTTP API as the web remote the box serves (`plugins/companion-app/main.js`), so the
box needs the **Companion** service switched on and the phone on the same network.

Design: Material 3 structure (tonal surfaces, 48dp targets, bottom navigation with a pill indicator,
segmented buttons, bottom sheets, snackbars) in the box's retro colours (amber and cyan on near-black,
LED-style numerals). Tokens live in `src/theme.ts`; the small component kit is `src/components/ui.tsx`.

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
- **Guide**: now and next for every channel with search and a favorites filter, plus controls for the TV's
  on-screen guide.
- **Lineup**: tune, favorite and quick-channel toggles.
- **More**: breaking news, EAS test, trivia, ticker, setup shortcuts, PC shutdown (when the box allows it),
  connection info, and **BOX SETTINGS**.
- **Box settings** (`src/app/settings.tsx`): the same editor as the web remote. TV appearance first, then the
  curated groups and every plugin/channel section, with search, switches, sliders, pickers (bottom sheet),
  text lists and JSON lists. SAVE sends one patch to `POST /api/settings`; the box reports back what it
  applied or refused (read from `/state`) and the editor reloads. The curated tables (`src/lib/settings-meta.ts`)
  are generated from the web remote's; the tree logic is `src/lib/settings-model.ts`.

## Screen sizes

`src/lib/layout.ts` decides the layout (compact under 360dp, regular, large, wide from 700dp), `useLayout`
feeds it the window size and notch insets. Phones use the full width, tablets and landscape get a centered
column (560dp, or two columns up to 1040dp on the Remote tab). Small phones get smaller D-pad keys, a
smaller channel plate and icon-free segmented buttons. System font size is honoured up to 1.3x so dense
labels do not overflow. Rotation is allowed.

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # pure logic: addresses, layout, settings model, discovery (incl. a real local scan)
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
