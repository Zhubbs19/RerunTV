#!/usr/bin/env node
// Builds the HTML code reference with TypeDoc (`npm run docs`) into docs/api/html.
//
// TypeDoc reads the JavaScript through the TypeScript compiler (tsconfig.docs.json: allowJs, no
// type checking), so the JSDoc types on every function become real, linked types. The reference
// covers every tracked file under main/, renderer/js/, plugins/ and plugin-dev-kit/, so gitignored
// local-only plugins and scratch files never end up in it; README.md is its front page, and the
// other guides and the design docs are pages beside the API. scripts/typedoc-plugin.mjs adds the
// file header descriptions, the non-exported helpers, the website's look and the graphs.
// Graphviz (https://graphviz.org/download/, `winget install Graphviz.Graphviz`) is optional: with
// it the reference gets import, call, caller and class graphs; without it, none.
//
// `--strict` fails the build on any TypeDoc warning.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'api', 'html');
const SOURCE_DIRS = ['main', 'renderer/js', 'plugins', 'plugin-dev-kit'];
// Guides shown beside the API. README.md is the front page.
const DOCUMENTS = [
  'PLUGIN_DEVELOPMENT.md', 'CONTRIBUTING.md', 'SECURITY.md', 'RELEASING.md', 'THIRD_PARTY_NOTICES.md',
  'CLAUDE.md', 'docs/design/*.md',
];

/**
 * The JavaScript files the reference documents: tracked files only, so local-only plugins stay out.
 * @returns {string[]} Absolute paths.
 */
function sourceFiles() {
  const listed = spawnSync('git', ['ls-files', '-z', ...SOURCE_DIRS], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error('npm run docs needs a git checkout (it documents tracked files only).');
  return listed.stdout.split('\0')
    .filter((f) => /\.(c|m)?js$/.test(f) && !/(^|\/)node_modules\//.test(f) && !f.endsWith('.min.js'))
    .map((f) => `${root.split(path.sep).join('/')}/${f}`);
}

/**
 * Builds the reference.
 * @returns {Promise<void>} Resolves when the HTML is written.
 */
async function main() {
  const strict = process.argv.includes('--strict');
  const { Application, LogLevel } = await import('typedoc');

  // Empty the folder rather than delete it: on Windows a folder a preview server is serving can't
  // be removed, though everything in it can.
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });

  const app = await Application.bootstrapWithPlugins({
    name: 'RerunTV',
    entryPoints: sourceFiles(),
    entryPointStrategy: 'resolve',
    tsconfig: path.join(root, 'tsconfig.docs.json'),
    basePath: root,
    displayBasePath: root,
    readme: path.join(root, 'README.md'),
    projectDocuments: DOCUMENTS.map((d) => path.join(root, d).split(path.sep).join('/')),
    plugin: [pathToFileURL(path.join(__dirname, 'typedoc-plugin.mjs')).href],
    out: outDir,
    cleanOutputDir: false,
    skipErrorChecking: true,
    commentStyle: 'all',
    excludePrivate: false,
    excludeInternal: false,
    groupOrder: ['Guides', 'Design docs', 'Documents', 'Modules', 'Classes', 'Functions', 'Variables', 'Internal classes', 'Internal functions', 'Internal variables', '*'],
    sort: ['kind', 'instance-first', 'source-order'],
    customCss: path.join(root, 'docs', 'typedoc', 'rerun.css'),
    favicon: path.join(root, 'docs', 'typedoc', 'favicon.png'),
    ignoredHighlightLanguages: ['mermaid'],
    highlightLanguages: ['javascript', 'typescript', 'json', 'jsonc', 'bash', 'powershell', 'shell', 'html', 'css', 'diff', 'jsx', 'kotlin', 'yaml', 'markdown', 'text'],
    router: 'rerun', // scripts/typedoc-plugin.mjs: document pages named from their paths
    navigation: { includeCategories: false, includeGroups: true, includeFolders: true },
    hideGenerator: false,
    logLevel: LogLevel.Info,
    treatWarningsAsErrors: strict,
  });
  const project = await app.convert();
  if (!project) process.exit(1);
  await app.generateOutputs(project);
  const warnings = app.logger.warningCount;
  if (app.logger.hasErrors()) process.exit(1);
  console.log(`Code reference (TypeDoc ${Application.VERSION}): docs/api/html/index.html`);
  if (warnings) console.log(`${warnings} TypeDoc warning(s) above.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
