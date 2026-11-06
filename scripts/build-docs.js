#!/usr/bin/env node
// Builds the HTML code reference with Doxygen (`npm run docs`) into docs/api/html.
//
// Needs Doxygen on PATH (https://www.doxygen.nl/download.html, or `winget install
// DimitriVanHeesch.Doxygen`, `brew install doxygen`, `apt-get install doxygen`). The Doxyfile at
// the repo root holds the settings. This adds two things to it: the package version, and an
// exclusion for every gitignored path, so local-only plugins and scratch files never end up in
// the reference. Doxygen's warnings go to docs/api/warnings.log.
//
// Graphviz (https://graphviz.org/download/, `winget install Graphviz.Graphviz`) is optional: with
// it the reference gets file and folder dependency graphs, plus the call, caller and class graphs
// scripts/doxygen-graphs.js draws; without it, none.
// After Doxygen finishes, every page gets the website's header bar (docs/doxygen/site-header.html)
// and every graph is recolored to the site palette (docs/doxygen/rerun.css styles the rest).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { addGraphs } = require('./doxygen-graphs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'docs', 'api');
const { version } = require('../package.json');

/**
 * Builds the reference: runs Doxygen with the generated settings, brands the pages and adds the
 * call and class graphs. With `--brand-only` it only re-brands an existing docs/api/html and
 * redraws its call and class graphs (for working on the look).
 * @returns {Promise<void>} Resolves when the reference is written.
 */
async function main() {
  if (process.argv.includes('--brand-only')) {
    brandPages(path.join(outDir, 'html'));
    await drawGraphs(findGraphviz());
    return;
  }
  const probe = spawnSync('doxygen', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.error('Doxygen is not installed or not on PATH. Install it (https://www.doxygen.nl/download.html)'
      + ' and run `npm run docs` again.');
    process.exit(1);
  }

  const dotDir = findGraphviz();
  if (dotDir === null) {
    console.warn('Graphviz (dot) was not found, so the reference is built without its dependency, call and'
      + ' class graphs. Install it (https://graphviz.org/download/) and run `npm run docs` again to get them.');
  }

  const ignored = spawnSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const excludes = ignored.status === 0
    ? ignored.stdout.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, ''))
    : [];
  if (ignored.status !== 0) console.warn('Not a git checkout: gitignored files are not left out of the reference.');

  // Empty the HTML folder rather than delete it: on Windows a folder a preview server is serving
  // can't be removed, though everything in it can.
  const htmlDir = path.join(outDir, 'html');
  fs.mkdirSync(htmlDir, { recursive: true });
  for (const name of fs.readdirSync(htmlDir)) fs.rmSync(path.join(htmlDir, name), { recursive: true, force: true });
  const warnings = path.join(outDir, 'warnings.log');
  const config = path.join(outDir, 'Doxyfile.generated');
  const quote = (p) => `"${p.split(path.sep).join('/')}"`;
  fs.writeFileSync(config, [
    `@INCLUDE = ${quote(path.join(root, 'Doxyfile'))}`,
    `PROJECT_NUMBER = ${version}`,
    `WARN_LOGFILE = ${quote(warnings)}`,
    ...(dotDir === null ? [] : ['HAVE_DOT = YES', ...(dotDir ? [`DOT_PATH = ${quote(dotDir)}`] : [])]),
    ...excludes.map((p) => `EXCLUDE += ${quote(p)}`),
    '',
  ].join('\n'));

  const run = spawnSync('doxygen', [config], { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) process.exit(run.status == null ? 1 : run.status);
  brandPages(path.join(outDir, 'html'));
  await drawGraphs(dotDir);

  const count = fs.existsSync(warnings) ? (fs.readFileSync(warnings, 'utf8').match(/warning:/g) || []).length : 0;
  console.log(`Code reference (Doxygen ${probe.stdout.trim().split(' ')[0]}): docs/api/html/index.html`);
  if (count) console.log(`${count} Doxygen warning(s) in docs/api/warnings.log`);
}

/**
 * Adds the call, caller and class graphs (scripts/doxygen-graphs.js), when Graphviz is installed.
 * @param {string|null} dotDir What findGraphviz returned.
 * @returns {Promise<void>} Resolves when the graphs are in the pages.
 */
async function drawGraphs(dotDir) {
  if (dotDir === null) return;
  const dotCommand = dotDir ? path.join(dotDir, process.platform === 'win32' ? 'dot.exe' : 'dot') : 'dot';
  const started = Date.now();
  const { functions, classes } = await addGraphs({ root, htmlDir: path.join(outDir, 'html'), dotCommand });
  console.log(`Call graphs for ${functions} functions and methods, class graphs for ${classes} classes`
    + ` (${((Date.now() - started) / 1000).toFixed(1)} s).`);
}

/**
 * Finds Graphviz's `dot`, which Doxygen needs to draw graphs.
 * @returns {string|null} '' when dot is on PATH, the folder holding it when it is only in its
 *   usual Windows install folder (the installer doesn't always add it to PATH), or null when it
 *   isn't installed.
 */
function findGraphviz() {
  const onPath = spawnSync('dot', ['-V'], { encoding: 'utf8' });
  if (!onPath.error && onPath.status === 0) return '';
  if (process.platform !== 'win32') return null;
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
    const dir = path.join(base, 'Graphviz', 'bin');
    if (fs.existsSync(path.join(dir, 'dot.exe'))) return dir;
  }
  return null;
}

/**
 * Puts the website's header bar on every generated page and recolors the graphs to match it.
 * Doxygen's own HTML_HEADER template changes between Doxygen versions (CI's Ubuntu package is
 * older than a fresh Windows install), so the bar is added to the finished pages instead.
 * @param {string} htmlDir The generated HTML folder (docs/api/html).
 */
function brandPages(htmlDir) {
  const { repoUrl, siteUrl } = siteLinks();
  const bar = fs.readFileSync(path.join(root, 'docs', 'doxygen', 'site-header.html'), 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/, '')
    .replace(/\{\{SITE_URL\}\}/g, siteUrl)
    .replace(/\{\{REPO_URL\}\}/g, repoUrl)
    .replace(/\{\{VERSION\}\}/g, version)
    .trim();
  for (const name of fs.readdirSync(htmlDir)) {
    const file = path.join(htmlDir, name);
    if (name.endsWith('.html')) {
      const html = fs.readFileSync(file, 'utf8');
      if (html.includes('class="rtv-top"')) continue; // already branded (--brand-only)
      const branded = html
        // Inside #top, so Doxygen's scripts count the bar when they size the side tree.
        .replace(/(<div id="top">(?:<!--[^>]*-->)?)/, `$1\n${bar}`)
        .replace('</head>', '<link rel="icon" type="image/png" href="favicon.png"/>\n</head>')
        // Mermaid diagrams in the site palette instead of Mermaid's own light or dark theme.
        .replace(/mermaid\.initialize\(\{ ?startOnLoad: true, theme: theme ?\}\);/, `mermaid.initialize(${MERMAID_THEME});`);
      if (branded !== html) fs.writeFileSync(file, branded);
    } else if (name.endsWith('.svg') || name.endsWith('.map')) {
      const svg = fs.readFileSync(file, 'utf8');
      const recolored = recolorGraph(svg);
      if (recolored !== svg) fs.writeFileSync(file, recolored);
    }
  }
}

/**
 * The repository's GitHub address and its Pages site, from package.json's `repository`.
 * @returns {{ repoUrl: string, siteUrl: string }} Both addresses, with a trailing `/` on the site.
 */
function siteLinks() {
  const pkg = require('../package.json');
  const url = (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
  const match = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return { repoUrl: '', siteUrl: '' };
  const [, owner, repo] = match;
  return { repoUrl: `https://github.com/${owner}/${repo}`, siteUrl: `https://${owner.toLowerCase()}.github.io/${repo}/` };
}

// Mermaid's settings for the design docs' diagrams: its "base" theme in the site palette.
const MERMAID_THEME = JSON.stringify({
  startOnLoad: true,
  theme: 'base',
  themeVariables: {
    darkMode: true,
    background: '#0a0f2c',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    primaryColor: '#2a3a9a',
    primaryTextColor: '#eef1ff',
    primaryBorderColor: '#5fd6ff',
    secondaryColor: '#23307f',
    secondaryTextColor: '#eef1ff',
    secondaryBorderColor: '#3a4bb0',
    tertiaryColor: '#111a48',
    tertiaryTextColor: '#eef1ff',
    tertiaryBorderColor: '#3a4bb0',
    lineColor: '#9fb0ff',
    textColor: '#eef1ff',
    mainBkg: '#2a3a9a',
    nodeBorder: '#5fd6ff',
    clusterBkg: '#111a48',
    clusterBorder: '#3a4bb0',
    titleColor: '#f6c90e',
    edgeLabelBackground: '#0a0f2c',
    actorBkg: '#2a3a9a',
    actorBorder: '#5fd6ff',
    actorTextColor: '#eef1ff',
    actorLineColor: '#9fb0ff',
    signalColor: '#eef1ff',
    signalTextColor: '#eef1ff',
    labelBoxBkgColor: '#23307f',
    labelBoxBorderColor: '#3a4bb0',
    labelTextColor: '#eef1ff',
    loopTextColor: '#eef1ff',
    noteBkgColor: '#f6c90e',
    noteTextColor: '#1a1400',
    noteBorderColor: '#f6c90e',
    activationBkgColor: '#3448b8',
    activationBorderColor: '#5fd6ff',
  },
});

// Graphviz colors Doxygen 1.18 writes into its graphs, and the site palette (site/src/style.css)
// that replaces each one. Each is a whole attribute, so a color already swapped isn't matched again.
const GRAPH_COLORS = [
  ['fill="#999999"', 'fill="#f6c90e"'], // the node the graph is about
  ['fill="white"', 'fill="#2a3a9a"'], // any other node
  ['fill="#fff0f0"', 'fill="#23307f"'], // a node with more behind it that the graph left out
  ['stroke="red"', 'stroke="#ff7a7a"'],
  ['stroke="#666666"', 'stroke="#5fd6ff"'], // node borders
  ['fill="#63b8ff"', 'fill="#9fb0ff"'], // edges and arrowheads
  ['stroke="#63b8ff"', 'stroke="#9fb0ff"'],
  ['fill="#edf0f7"', 'fill="#111a48"'], // folder graphs: the enclosing folder, sibling folders
  ['fill="#a2b4d6"', 'fill="#2a3a9a"'],
  ['fill="#f2f5e9"', 'fill="#23307f"'],
  ['fill="#404254"', 'fill="#0a0f2c"'],
  ['stroke="#404040"', 'stroke="#3a4bb0"'],
  ['fill="#404040"', 'fill="#3a4bb0"'],
  ['stroke="#606060"', 'stroke="#5fd6ff"'],
  ['stroke="#7f7f7f"', 'stroke="#3a4bb0"'],
];

/**
 * Recolors one Doxygen graph (SVG) from Graphviz's defaults to the site palette. Labels get the
 * site's light text, except on the yellow node the graph is about, which keeps dark ink.
 * @param {string} svg The SVG source.
 * @returns {string} The recolored SVG.
 */
function recolorGraph(svg) {
  if (!svg.includes('<svg')) return svg;
  let out = svg;
  for (const [from, to] of GRAPH_COLORS) out = out.split(from).join(to);
  // Doxygen shows a graph in an <iframe>. A frame whose color scheme differs from the dark page
  // gets an opaque white backdrop, so the graph declares the dark scheme too.
  if (!out.includes('color-scheme:dark')) out = out.replace(/<svg\b/, '<svg style="color-scheme:dark"');
  // The interactive graphs' hover highlight: yellow instead of red.
  out = out.replace(/(\.edge:hover [^}]*?)red/g, '$1#f6c90e').replace(/(\.edge:hover [^}]*?)red/g, '$1#f6c90e');
  // A label is a <text> following its node's shape. Unlabelled text takes the shape's ink.
  let ink = '#eef1ff';
  return out.replace(/<(polygon|ellipse|path|text)\b([^>]*)>/g, (tag, name, attrs) => {
    if (name !== 'text') {
      const fill = attrs.match(/fill="([^"]*)"/);
      if (fill && fill[1] !== 'none') ink = fill[1] === '#f6c90e' ? '#1a1400' : '#eef1ff';
      return tag;
    }
    return /\sfill="/.test(attrs) ? tag : `<text${attrs} fill="${ink}">`;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
