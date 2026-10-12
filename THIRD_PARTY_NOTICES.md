# Third-party notices

RerunTV bundles the following third-party assets. Everything else in this repository
is covered by the project's [MIT license](LICENSE).

## Fonts (`renderer/fonts/`)

These typefaces are distributed under the [SIL Open Font License 1.1](https://openfontlicense.org/).
They are redistributed unmodified apart from conversion to WOFF2. Each family's
copyright belongs to its respective authors; see the upstream project pages.

| Family | Upstream |
| --- | --- |
| Archivo Black, Archivo Narrow | https://github.com/Omnibus-Type/Archivo |
| Barlow, Barlow Condensed | https://github.com/jpt/barlow |
| Comfortaa | https://github.com/googlefonts/comfortaa |
| Fjalla One | https://github.com/googlefonts/fjalla |
| IBM Plex Mono | https://github.com/IBM/plex |
| Monoton | https://github.com/googlefonts/monoton |
| VT323 | https://github.com/googlefonts/vt323 |

## npm dependencies

Runtime dependencies (`adm-zip`, `busboy`, `electron-updater`, `qrcode`) and the
build tooling (Electron, electron-builder) are installed from npm under their own
licenses; see each package's `LICENSE` in `node_modules/`.

## ffmpeg

RerunTV does **not** bundle ffmpeg. The optional FFmpeg Transcode plugin runs an
`ffmpeg` binary that you install yourself. ffmpeg is licensed under the LGPL or GPL
depending on how it was built; see https://ffmpeg.org/legal.html.

## Data services

- Weather data comes from the U.S. National Weather Service / NOAA public APIs.
- The optional TMDB metadata plugin uses the TMDB API but is not endorsed or
  certified by TMDB. It requires your own API key and TMDB's terms apply.
