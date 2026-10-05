#!/usr/bin/env node
// Cross-platform `npm run pack:personal`: an unpacked build that also bundles the
// gitignored, machine-local plugins in this checkout (electron-builder.config.js
// reads RERUNTV_INCLUDE_LOCAL_PLUGINS). Replaces a Windows-only `set VAR=1&& ...`
// package.json script.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const cli = require.resolve('electron-builder/cli.js', { paths: [root] });
const result = spawnSync(
  process.execPath,
  [cli, '--dir', '--config', 'electron-builder.config.js', ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit', env: { ...process.env, RERUNTV_INCLUDE_LOCAL_PLUGINS: '1' } },
);
process.exit(result.status == null ? 1 : result.status);
