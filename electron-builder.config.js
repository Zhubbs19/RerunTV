const fs = require('node:fs');
const path = require('node:path');

const pluginManifestPath = path.join(__dirname, 'build', 'bundled-plugins.json');
const bundledPluginIds = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8')).plugins;
const includeLocalPlugins = process.env.RERUNTV_INCLUDE_LOCAL_PLUGINS === '1';
const pluginFiles = includeLocalPlugins
  ? ['plugins/**/*']
  : bundledPluginIds.map((id) => `plugins/${id}/**/*`);

module.exports = {
  // Legacy identifier from before the RerunTV name. It is the installer's
  // identity, so changing it would break in-place updates for existing installs.
  appId: 'com.retrocablebox.foss',
  productName: 'RerunTV',
  directories: { output: 'dist' },
  artifactName: '${productName}-Setup-${version}.${ext}',
  files: ['main/**/*.js', 'renderer/**/*', ...pluginFiles, 'package.json'],
  // These live beside RerunTV.exe in installed/unpacked builds. Each batch
  // file also retains a development fallback for running from the repo.
  extraFiles: ['run-server.bat', 'run-headless.bat'],
  asarUnpack: ['plugins/**'],
  // Packaged-build hardening. The app starts its own helper processes with
  // utilityProcess.fork() (plugin isolation, the splicer), never by running the
  // exe as plain Node, so the exe cannot be turned into a general Node
  // interpreter (ELECTRON_RUN_AS_NODE) or have --inspect / NODE_OPTIONS
  // injected. Dev runs (`electron .`) are not affected.
  electronFuses: {
    runAsNode: false,
    enableNodeCliInspectArguments: false,
    enableNodeOptionsEnvironmentVariable: false,
  },
  publish: {
    provider: 'github', owner: 'Zhubbs19', repo: 'RerunTV',
  },
  // Windows is the only packaged platform (CI builds only the NSIS installer).
  win: { target: 'nsis', icon: 'build/icon.png' },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
};
