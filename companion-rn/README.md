# RerunTV Companion (React Native)

A phone remote for a RerunTV box, built with Expo (React Native, TypeScript) for Android and iOS. It talks
to the same companion HTTP API as the web remote the box serves (`plugins/companion-app/main.js`), so the
box needs the **Companion** service switched on and the phone on the same network.

Design: Material 3 structure (tonal surfaces, 48dp targets, bottom navigation with a pill indicator,
segmented buttons, snackbars) in the box's retro colours (amber and cyan on near-black, LED-style numerals).
Tokens live in `src/theme.ts`; the small component kit is `src/components/ui.tsx`.

## Run it

```bash
cd companion-rn
npm install
npx expo start          # scan the QR code with Expo Go on your phone
```

Native modules used (camera for the pairing QR, secure store, haptics) are all in Expo Go, so no
development build is needed yet. For installable builds use EAS (`npx eas-cli build`).

## Pairing

1. On the box, open the companion service to see its address, 8-digit pairing code and QR code.
2. In the app, scan the QR code (or type the address and code). The app trades the code for a session
   token (`GET /?pair=CODE` with `Accept: application/json`) and keeps it in the device's secure storage.
   The code itself is never stored. Sessions last 90 days and renew while in use.
3. "Forget this box" (MORE tab) deletes the token.

## Screens

- **Remote**: now-playing card (channel, programme, time left, next, sleep countdown, skip break), power /
  mute / guide / info, channel and volume rockers that repeat when held, channel list / keypad / D-pad,
  picture and sound, time machine.
- **Guide**: now and next for every channel with search and a favorites filter, plus controls for the TV's
  on-screen guide.
- **Lineup**: tune, favorite and quick-channel toggles.
- **More**: breaking news, EAS test, trivia, ticker, setup shortcuts, PC shutdown (when the box allows it),
  connection info.

Not here yet: the full box settings editor (use the web remote at the box's address), file browsing, and
automatic discovery of boxes on the network (the box answers a UDP broadcast on port 41234; that needs a
native module, so it waits for a development build).

## Checks

```bash
npm run typecheck   # tsc --noEmit
npm test            # pure helpers (address parsing, formatting), node --test
```

`npx expo export --platform android` bundles the JS and is a quick "does it build" check.
