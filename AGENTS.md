# AGENTS.md

Guidance for Codex (or any AI agent) working in this repository.

**Read [`CLAUDE.md`](CLAUDE.md) first.** It is the single source of truth for the architecture,
the `viewNow()` invariant, config mutation and the command layer, usage modes, the setup-screen
patterns, the directory map and the working conventions. This file used to be a drifting copy of
it; it is now only a pointer, so there is one document to keep current.

Agent-specific notes that apply to any tool:

- `npm test` (`node scripts/run-tests.js`) runs the tracked unit tests in `tests/*.test.js` and the
  plugin contract validator (`scripts/validate-plugin-contracts.js`). It needs no display.
- Do not launch the app, or run `tests/ui/*.mjs` directly, unless the maintainer asked: the app
  stores its real library in `<repo>/userData`, and the UI suite must go through its `.ps1`
  safety wrapper (see `tests/ui/README.md`).
- Only commit or push when asked. Release builds are produced by CI from the `deploy` branch
  (see `RELEASING.md`).
- `companion-rn/` has its own `AGENTS.md` for the Expo/React Native app.
