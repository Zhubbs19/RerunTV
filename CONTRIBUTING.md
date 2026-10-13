# Contributing to RerunTV

Thanks for your interest! RerunTV is an Electron app that simulates a broadcast cable box.

## How to contribute

- **Questions and ideas are welcome in [Discussions](https://github.com/Zhubbs19/RerunTV/discussions)**, and **bug reports as [issues](https://github.com/Zhubbs19/RerunTV/issues/new/choose)**.
- **Pull requests are limited to collaborators.** This is a repository setting, so the pull request
  button is not available to everyone. To propose a change, open an issue first and describe it. If it
  fits the project, the maintainer may apply it or invite you as a collaborator so you can open a pull
  request.
- Forking is fine, for your own experiments and plugins. Plugins can also live in their own repository;
  see `PLUGIN_DEVELOPMENT.md`.

## Getting started

```bash
npm install
npm start      # run the app from source
npm test       # unit tests (must pass before you open a PR)
```

Read `CLAUDE.md` first: it explains the one invariant that matters most (schedule and
playback code must read time through `viewNow()`, not `Date.now()`) and how config edits
and caches work. `PLUGIN_DEVELOPMENT.md` covers the plugin API.

## Pull requests (collaborators)

- Keep changes focused, and add or update a test in `tests/` when behavior changes.
- Match the surrounding code style and comment density.
- **Do not add copyrighted media, logos, trademarked channel or show branding, or
  real network schedules** to the repository. Fixtures and examples should use made-up
  names. RerunTV ships no media; users bring their own library.
- Report security issues privately; see `SECURITY.md`.

By contributing you agree that your contribution is licensed under the MIT license.
