// TypeDoc plugin for RerunTV's code reference (`npm run docs`; scripts/build-docs.js loads it).
//
// TypeDoc documents what each file exports and reads `/** */` comments. This adds what the
// codebase's own conventions need on top of that:
// - each file's leading comment block (a `//` header here) becomes the module's description;
// - functions, classes and constants a file keeps to itself are documented too, in "Internal"
//   groups after the exported ones;
// - `// ---------- Section ----------` divider lines are dropped from comments;
// - every page gets the website's header bar (docs/typedoc/site-header.html) and icon;
// - the design docs' ```mermaid blocks are drawn in the page, in the site palette;
// - file import, call, caller and class graphs (scripts/docs-graphs.js) go into the pages of the
//   files, functions, classes and methods they describe, when Graphviz is installed.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  Comment, CommentTag, Converter, JSX, ReflectionKind, RendererEvent, TypeScript as ts,
} from 'typedoc';

const require = createRequire(import.meta.url);
const { analyzeSource, drawGraphs, findGraphviz, graphSection } = require('./docs-graphs.js');

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME_DIR = path.join(ROOT, 'docs', 'typedoc');

// Mermaid's settings for the design docs' diagrams: its "base" theme in the site palette.
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';
const MERMAID_CONFIG = {
  startOnLoad: false,
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
};

// Draws every ```mermaid block in a page. TypeDoc prints them as plain code blocks.
const MERMAID_SCRIPT = `<script type="module">
const blocks = [...document.querySelectorAll('pre > code.mermaid, pre > code.language-mermaid')];
if (blocks.length) {
  const { default: mermaid } = await import(${JSON.stringify(MERMAID_URL)});
  mermaid.initialize(${JSON.stringify(MERMAID_CONFIG)});
  const nodes = blocks.map((code) => {
    const div = document.createElement('div');
    div.className = 'rtv-mermaid';
    div.textContent = code.textContent;
    code.parentElement.replaceWith(div);
    return div;
  });
  await mermaid.run({ nodes });
}
</script>`;

/**
 * The repository's GitHub address and its Pages site, from package.json's `repository`.
 * @returns {{ repoUrl: string, siteUrl: string, version: string }} Both addresses, with a
 *   trailing `/` on the site, and the package version.
 */
function siteLinks() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const url = (pkg.repository && (pkg.repository.url || pkg.repository)) || '';
  const match = String(url).match(/github\.com[/:]([^/]+)\/([^/.]+)/);
  if (!match) return { repoUrl: '', siteUrl: '', version: pkg.version };
  const [, owner, repo] = match;
  return { repoUrl: `https://github.com/${owner}/${repo}`, siteUrl: `https://${owner.toLowerCase()}.github.io/${repo}/`, version: pkg.version };
}

/**
 * A file's leading comment block, as plain text: consecutive `//` lines or one block comment
 * before any code. A `/** *\/` block sitting directly on the first declaration documents that
 * declaration instead, so it isn't taken.
 * @param {object} file A TypeScript SourceFile.
 * @returns {string} The comment's text, or '' when the file has none.
 */
export function headerComment(file) {
  const text = file.text;
  const first = file.statements[0];
  const ranges = ts.getLeadingCommentRanges(text, 0) || [];
  if (!ranges.length) return '';
  const lineOf = (pos) => file.getLineAndCharacterOfPosition(pos).line;
  const block = [ranges[0]];
  if (ranges[0].kind === ts.SyntaxKind.SingleLineCommentTrivia) {
    for (const r of ranges.slice(1)) {
      const last = block[block.length - 1];
      if (r.kind !== ts.SyntaxKind.SingleLineCommentTrivia || lineOf(r.pos) !== lineOf(last.pos) + 1) break;
      block.push(r);
    }
  }
  const end = block[block.length - 1].end;
  const raw = text.slice(block[0].pos, end);
  if (raw.startsWith('#!')) return '';
  const isJsDoc = raw.startsWith('/**');
  if (first && isJsDoc && lineOf(first.getStart(file)) === lineOf(end) + 1) return '';
  return raw.startsWith('//')
    ? block.map((r) => text.slice(r.pos + 2, r.end).replace(/^ /, '')).join('\n')
    : raw.replace(/^\/\*+/, '').replace(/\*+\/$/, '').split('\n').map((l) => l.replace(/^\s*\* ?/, '')).join('\n');
}

const DIVIDER = /^\s*-{3,}.*-{3,}\s*$/;

/**
 * Takes `// ---------- Section ----------` divider lines out of a comment's summary, and empties
 * the comment if nothing else is left.
 * @param {object} owner A reflection or signature.
 */
function dropDividers(owner) {
  const comment = owner.comment;
  if (!comment) return;
  for (const part of comment.summary) {
    if (part.kind === 'text') part.text = part.text.split('\n').filter((l) => !DIVIDER.test(l)).join('\n');
  }
  if (!comment.summary.some((p) => p.text.trim()) && !comment.blockTags.length && !comment.modifierTags.size) owner.comment = undefined;
}

/**
 * Whether a top-level statement is exported with the `export` keyword.
 * @param {object} stmt A TypeScript statement node.
 * @returns {boolean} True when it carries `export`.
 */
function hasExportKeyword(stmt) {
  return !!(ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

/**
 * Whether a variable's initializer loads a module (`require(...)`, `require(...).x`, `await import(...)`).
 * @param {object} init A TypeScript expression node, or undefined.
 * @returns {boolean} True for a module load, which isn't worth documenting as a constant.
 */
export function isModuleLoad(init) {
  let node = init;
  while (node && (ts.isPropertyAccessExpression(node) || ts.isAwaitExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
  return !!node && ts.isCallExpression(node)
    && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword);
}

/**
 * Registers the plugin with TypeDoc.
 * @param {object} app The TypeDoc Application.
 */
export function load(app) {
  const moduleFile = new Map(); // module reflection id -> repo-relative file
  const exportLocal = new Map(); // file -> Map exported name -> local name
  const internalIds = new Set();
  const headerById = new Map(); // module reflection id -> its header comment's text

  // ---------- Converting ----------
  app.converter.on(Converter.EVENT_CREATE_DECLARATION, (context, reflection) => {
    if (!reflection.kindOf(ReflectionKind.Module)) return;
    const symbol = context.getSymbolFromReflection(reflection);
    const file = symbol?.declarations?.find((d) => ts.isSourceFile(d));
    if (!file) return;
    const rel = path.relative(ROOT, file.fileName).split(path.sep).join('/');
    moduleFile.set(reflection.id, rel);
    const analysis = analyzeSource(file.text, rel);
    exportLocal.set(rel, analysis ? analysis.exports : new Map());

    if (!reflection.comment) {
      const header = headerComment(file).trim();
      if (header) {
        reflection.comment = new Comment([{ kind: 'text', text: header }]);
        headerById.set(reflection.id, header);
      }
    }

    // What the file keeps to itself: our own export analysis knows the CommonJS patterns too.
    const exported = new Set(analysis ? [...analysis.exports.values(), ...analysis.exports.keys()] : []);
    const scope = context.withScope(reflection);
    for (const stmt of file.statements) {
      if (hasExportKeyword(stmt)) continue;
      let names = [];
      if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) names = [stmt.name];
      else if (ts.isVariableStatement(stmt)) {
        names = stmt.declarationList.declarations
          .filter((d) => ts.isIdentifier(d.name) && !isModuleLoad(d.initializer))
          .map((d) => d.name);
      }
      for (const name of names) {
        if (exported.has(name.text) || name.text === 'module' || name.text === 'exports') continue;
        const local = context.checker.getSymbolAtLocation(name);
        if (!local || context.getReflectionFromSymbol(local)) continue;
        context.converter.convertSymbol(scope, local);
        const made = context.getReflectionFromSymbol(local);
        if (made) internalIds.add(made.id);
      }
    }
  });

  // Internal members get their own groups, after the exported ones.
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    for (const id of internalIds) {
      const r = context.project.getReflectionById(id);
      if (!r) continue;
      const group = r.kindOf(ReflectionKind.Class) ? 'Internal classes'
        : r.kindOf(ReflectionKind.Function) ? 'Internal functions' : 'Internal variables';
      r.comment = r.comment || new Comment();
      r.comment.blockTags.push(new CommentTag('@group', [{ kind: 'text', text: group }]));
    }
    for (const r of Object.values(context.project.reflections)) {
      dropDividers(r);
      for (const sig of r.signatures || []) dropDividers(sig);
      // A file header sitting directly on the first declaration documents the file, not it.
      const header = r.parent && headerById.get(r.parent.id);
      for (const owner of [r, ...(r.signatures || [])]) {
        if (header && owner.comment && Comment.combineDisplayParts(owner.comment.summary).trim() === header) {
          owner.comment.summary = [];
          if (!owner.comment.blockTags.length && !owner.comment.modifierTags.size) owner.comment = undefined;
        }
      }
    }
    // Guides and design docs: titled by their own first heading, in two groups.
    for (const doc of context.project.getReflectionsByKind(ReflectionKind.Document)) {
      const isDesign = /design/.test(doc.name);
      const text = Comment.combineDisplayParts(doc.content);
      const heading = (text.match(/^#\s+(.+)$/m) || [])[1];
      if (heading) doc.name = heading.replace(/[`*_]/g, '').trim();
      doc.frontmatter = { ...doc.frontmatter, group: isDesign ? 'Design docs' : 'Guides' };
    }
  }, 100);

  // `@param opts.key` lines describe fields of a parameter. When TypeScript can't attach them to
  // the parameter's type (say it is `{string|object}`), TypeDoc would drop them, so they become a
  // list under that parameter's own description instead.
  app.converter.on(Converter.EVENT_CREATE_SIGNATURE, (context, signature) => {
    const comment = signature.comment;
    if (!comment) return;
    const params = new Map(comment.blockTags.filter((t) => t.tag === '@param' && t.name && !t.name.includes('.')).map((t) => [t.name, t]));
    const fieldsOf = (param) => {
      const decl = param && param.type && param.type.type === 'reflection' ? param.type.declaration : null;
      return new Set(decl && decl.children ? decl.children.map((c) => c.name) : []);
    };
    comment.blockTags = comment.blockTags.filter((tag) => {
      if (tag.tag !== '@param' || !tag.name || !tag.name.includes('.')) return true;
      const [base, ...rest] = tag.name.split('.');
      const field = rest.join('.');
      const parent = params.get(base);
      const param = (signature.parameters || []).find((p) => p.name === base);
      if (!parent || fieldsOf(param).has(field)) return true;
      parent.content.push({ kind: 'text', text: '\n- ' }, { kind: 'code', text: `\`${field}\`` }, { kind: 'text', text: ' ' }, ...tag.content);
      return false;
    });
  });

  // ---------- Graphs ----------
  const graphs = new Map(); // graph key -> [{ heading, svg }]
  const reflectionByKey = new Map();
  const keyById = new Map();
  const keyOf = (r) => {
    if (r.kindOf(ReflectionKind.Module)) return moduleFile.get(r.id) || null;
    let mod = r.parent;
    while (mod && !mod.kindOf(ReflectionKind.Module)) mod = mod.parent;
    const file = mod && moduleFile.get(mod.id);
    if (!file) return null;
    const local = (name) => (exportLocal.get(file) && exportLocal.get(file).get(name)) || name;
    if (r.kindOf(ReflectionKind.Function | ReflectionKind.Class)) return `${file}::${local(r.name)}`;
    if (r.kindOf(ReflectionKind.Method | ReflectionKind.Constructor) && r.parent && r.parent.kindOf(ReflectionKind.Class)) {
      const cls = local(r.parent.name);
      return `${file}::${cls}.${r.kindOf(ReflectionKind.Constructor) ? cls : r.name}`;
    }
    return null;
  };

  app.renderer.preRenderAsyncJobs.push(async (event) => {
    const dotCommand = findGraphviz();
    if (!dotCommand) {
      app.logger.warn('Graphviz (dot) was not found, so the reference has no import, call or class graphs.'
        + ' Install it (https://graphviz.org/download/) and run `npm run docs` again to get them.');
      return;
    }
    const kinds = ReflectionKind.Module | ReflectionKind.Function | ReflectionKind.Class | ReflectionKind.Method | ReflectionKind.Constructor;
    for (const r of event.project.getReflectionsByKind(kinds)) {
      const key = keyOf(r);
      if (!key || reflectionByKey.has(key)) continue;
      reflectionByKey.set(key, r);
      keyById.set(r.id, key);
    }
    const started = Date.now();
    const drawn = await drawGraphs({
      files: [...new Set(moduleFile.values())],
      dotCommand,
      workDir: path.join(event.outputDirectory, '..', 'graphs-tmp'),
      hrefOf: (key) => (reflectionByKey.has(key) ? `rtv-ref:${encodeURIComponent(key)}` : null),
    });
    for (const [key, list] of drawn) graphs.set(key, list);
    const count = [...drawn.values()].reduce((n, l) => n + l.length, 0);
    app.logger.info(`Drew ${count} graphs in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  });

  // The graphs for a reflection, with their links made relative to the page being written.
  const graphHtml = (context, reflection) => {
    const key = keyById.get(reflection.id);
    const list = key && graphs.get(key);
    if (!list || !list.length) return null;
    const html = list.map((g) => graphSection(g.heading, g.svg)).join('').replace(/rtv-ref:([^"]+)/g, (m, enc) => {
      const target = reflectionByKey.get(decodeURIComponent(enc));
      return target ? context.urlTo(target) : '#';
    });
    return JSX.createElement(JSX.Raw, { html });
  };
  let shownOnPage = new Set();
  app.renderer.hooks.on('head.begin', () => {
    shownOnPage = new Set();
    return JSX.createElement(JSX.Fragment, null);
  });
  // Files and classes: right after their description. Methods: after their own comment.
  app.renderer.hooks.on('comment.afterTags', (context, comment, reflection) => {
    let owner = reflection;
    if (owner.kindOf(ReflectionKind.CallSignature | ReflectionKind.ConstructorSignature)) owner = owner.parent;
    if (!owner || shownOnPage.has(owner.id)) return JSX.createElement(JSX.Fragment, null);
    const isPageModel = context.page.model === owner;
    const wanted = owner.kindOf(ReflectionKind.Method | ReflectionKind.Constructor)
      || (isPageModel && owner.kindOf(ReflectionKind.Module | ReflectionKind.Class));
    if (!wanted) return JSX.createElement(JSX.Fragment, null);
    shownOnPage.add(owner.id);
    return graphHtml(context, owner) || JSX.createElement(JSX.Fragment, null);
  });
  // Functions (one per page), and any page model whose comment had nowhere to put them.
  app.renderer.hooks.on('content.end', (context) => {
    const model = context.page.model;
    if (!model || shownOnPage.has(model.id)) return JSX.createElement(JSX.Fragment, null);
    shownOnPage.add(model.id);
    return graphHtml(context, model) || JSX.createElement(JSX.Fragment, null);
  });

  // ---------- The site's look ----------
  const links = siteLinks();
  const bar = fs.readFileSync(path.join(THEME_DIR, 'site-header.html'), 'utf8')
    .replace(/^<!--[\s\S]*?-->\s*/, '')
    .replace(/\{\{SITE_URL\}\}/g, links.siteUrl)
    .replace(/\{\{REPO_URL\}\}/g, links.repoUrl)
    .replace(/\{\{VERSION\}\}/g, links.version);
  app.renderer.hooks.on('body.begin', (context) => {
    const base = context.relativeURL('index.html').replace(/index\.html$/, '');
    return JSX.createElement(JSX.Raw, { html: bar.replace(/\{\{BASE\}\}/g, base) });
  });
  // The front page's README has its own title, so the project name above it would repeat it.
  app.renderer.hooks.on('head.end', (context) => JSX.createElement(JSX.Raw, {
    html: MERMAID_SCRIPT + (context.page.model.isProject() ? '<style>.col-content > .tsd-page-title { display: none; }</style>' : ''),
  }));
  app.renderer.on(RendererEvent.END, (event) => {
    fs.copyFileSync(path.join(THEME_DIR, 'icon.png'), path.join(event.outputDirectory, 'assets', 'rerun-icon.png'));
  });
}
