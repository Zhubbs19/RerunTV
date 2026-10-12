# Third-party notices

RerunTV bundles the following third-party assets. Everything else in this repository
is covered by the project's [MIT license](LICENSE).

## Fonts (`renderer/fonts/`)

These typefaces are distributed under the [SIL Open Font License 1.1](https://openfontlicense.org/).
They are redistributed unmodified apart from conversion to WOFF2. The full license text and each
family's copyright notice are in [`renderer/fonts/OFL.txt`](renderer/fonts/OFL.txt).

| Family | Upstream |
| --- | --- |
| Archivo Black | https://github.com/Omnibus-Type/ArchivoBlack |
| Archivo Narrow | https://github.com/Omnibus-Type/ArchivoNarrow |
| Barlow, Barlow Condensed | https://github.com/jpt/barlow |
| Comfortaa | https://github.com/alexeiva/comfortaa |
| Fjalla One | https://github.com/SorkinType/FjallaOne |
| IBM Plex Mono | https://github.com/IBM/plex |
| Monoton | Vernon Adams, via Google Fonts (OFL) |
| VT323 | Peter Hull, via Google Fonts (OFL) |

## npm dependencies

Runtime dependencies (`adm-zip`, `busboy`, `electron-updater`, `qrcode`) and the
build tooling (Electron, electron-builder) are installed from npm under their own
licenses; see each package's `LICENSE` in `node_modules/`.

## Android clients

The companion apps in `android-tv-client/` and `android-companion-client/` build against AndroidX
(appcompat, core-ktx, lifecycle, swiperefreshlayout), Kotlin and kotlinx-coroutines, all
Apache License 2.0, and ship the Gradle wrapper (Apache 2.0).

## Artwork

The app icon, the Android launcher and banner images, and the companion-app icon show a
rewind-symbol TV design created for this project and covered by the MIT license. Everything else visual (theme borders, overlays,
test patterns) is original SVG, CSS or code in this repository.

## ffmpeg

RerunTV does **not** bundle ffmpeg. The optional FFmpeg Transcode plugin runs an
`ffmpeg` binary that you install yourself. ffmpeg is licensed under the LGPL or GPL
depending on how it was built; see https://ffmpeg.org/legal.html.

## Data services

- Weather data comes from the U.S. National Weather Service / NOAA public APIs.
- The optional TMDB metadata plugin uses the TMDB API but is not endorsed or
  certified by TMDB. It requires your own API key and TMDB's terms apply.
