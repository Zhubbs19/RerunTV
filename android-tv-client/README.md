# RerunTV for Android TV

A native Android TV shell for watching RerunTV from a PC on the same network. The TV runs
the full RerunTV viewer in a fullscreen WebView, while the PC supplies schedule data and
media. There is no cloud account or casting session to keep alive.

## Start the PC server

From the RerunTV folder, run:

```bash
npm run server
```

The full desktop TV window stays closed. A small local webpage opens with the pairing code,
viewer addresses, connection steps, and a Stop button. `npm run headless` provides the same
viewer service without opening that page. Server mode forces the paired viewer online for
that run even if **WATCH ON OTHER DEVICES** was disabled in the saved desktop settings.

## TV experience

- **Automatic discovery:** choose **SCAN FOR RERUNTV** instead of entering a PC address.
- **Stable 4K presentation:** the WebView uses a fixed 1920-pixel logical TV canvas and lets
  Android composite it at the panel's native resolution. The guide and overlays therefore
  retain the same readable size on 1080p and 4K televisions.
- **Overscan protection:** important controls stay inside a TV-safe perimeter.
- **Immersive playback:** system bars remain hidden and the screen stays awake.
- **Connection recovery:** a branded signal-loss screen retries the PC automatically.
- **New RerunTV branding:** launcher, Google TV banner, and startup screen use the same
  skeuomorphic rewind-TV artwork as the desktop app.
- **Exit Setup remotely:** **WATCH TV / EXIT SETUP** returns directly to playback. Back remains
  a contextual navigation button inside Setup.
- **Raw remote-key bridge:** at `window.RerunTVInput.version` 2 and up, the app posts real
  Android key events — keycode, scan code, repeat, long-press, hold duration, and
  up/down action — and the page itself (`remote-input.js`) decides what each button means,
  including this device's own **CUSTOMIZE BUTTONS** (learn-mode) overrides. There is no
  per-remote keycode table in this app; teaching it a new button is a JS change, not a
  Kotlin one. Against an older page that predates version 2, the app instead sends
  named RemoteKey values (`native({ key })`), the same call the phone remote and touch
  controls still use.
- **Remote Test and Customize Buttons:** Setup → Remote on the TV runs the same capture/learn
  flow as desktop, using this client's real key events — useful for checking (or teaching)
  what a specific remote's buttons actually send before relying on them.

## Controls

| TV remote button | Action |
| --- | --- |
| D-pad Up/Down or CH rocker | Change channel |
| D-pad Left/Right | Time Machine shuttle while active |
| OK / Center | Select, confirm, or show program information |
| Play/Pause | Open the native TV menu |
| Back | Leave the app normally |
| Digits | Enter a channel number when the remote supplies digit keycodes |

The native TV menu exposes **WATCH TV**, Guide, Setup, Info, Mute, Volume, CRT, Picture,
Aspect, Sleep, Power, and SAP/Audio controls. The TV's system volume keys remain system
volume keys.

## Phone remote for this TV

The Android app serves a lightweight remote on port `8725`. Open the address shown in the
TV menu from a phone on the same Wi-Fi network. This remote controls the TV viewer itself,
so it also works when the PC is running headless. It includes a dedicated **WATCH TV / EXIT
SETUP** button.

## Build the APK

Open `android-tv-client/` in Android Studio, allow Gradle to sync, then choose **Build →
Build Bundle(s) / APK(s) → Build APK(s)**. The debug APK is written to:

```text
app/build/outputs/apk/debug/app-debug.apk
```

A debug build is suitable for personal sideloading. This project targets Android SDK 34,
requires Android 7.0 or newer, and does not require a touchscreen.

## Sideload

With Android platform tools and network debugging enabled on the TV:

```bash
adb connect <tv-ip>:5555
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

You can also copy the APK to USB storage and install it with a TV file manager after
allowing that app to install unknown packages.

## First connection

1. Start RerunTV on the PC with `npm run server`.
2. Open RerunTV on the TV.
3. Choose **SCAN FOR RERUNTV**.
4. Select the discovered PC and enter the pairing code shown on the PC control page.

The address and paired session are remembered. Open the native TV menu to rescan or change
the address later.
