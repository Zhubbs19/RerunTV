const fs = require('node:fs');
const path = require('node:path');

const pluginManifestPath = path.join(__dirname, 'build', 'bundled-plugins.json');
const bundledPluginIds = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8')).plugins;
const includeLocalPlugins = process.env.RERUNTV_INCLUDE_LOCAL_PLUGINS === '1';
const pluginFiles = includeLocalPlugins
  ? ['plugins/**/*']
  : bundledPluginIds.map((id) => `plugins/${id}/**/*`);

module.exports = {
  appId: 'com.retrocablebox.foss',
  productName: 'RerunTV',
  directories: { output: 'dist' },
  artifactName: '${productName}-Setup-${version}.${ext}',
  files: ['main/**/*.js', 'renderer/**/*', ...pluginFiles, 'package.json'],
  // These live beside RerunTV.exe in installed/unpacked builds. Each batch
  // file also retains a development fallback for running from the repo.
  extraFiles: ['run-server.bat', 'run-headless.bat'],
  asarUnpack: ['plugins/**'],
  publish: {
    provider: 'github', owner: 'Zhubbs19', repo: 'RerunTV',
  },
  win: { target: 'nsis', icon: 'build/icon.png' },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
  mac: { target: 'dmg', category: 'public.app-category.entertainment', icon: 'build/icon.png' },
  linux: { target: 'AppImage', category: 'AudioVideo', icon: 'build/icon.png' },
};
