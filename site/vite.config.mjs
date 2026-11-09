// Vite config for the GitHub Pages site (`npm run site` builds it into _site/, `npm run site:dev`
// serves it with live reload). The site is a small React app in site/src: a hash router picks the
// landing page, the features index or one feature page (listed in src/features.json).
//
// The build also looks up the repository, the newest release and the changelog, which the pages
// read through the __SITE_INFO__ constant. The repository comes from GITHUB_REPOSITORY (set in
// Actions), else the origin remote. The Downloads page lists the newest release's files, prereleases
// included, looked up with the GitHub CLI; without `gh` or a release, or in dev, it points at the
// Releases page. Its Linux download appears only when that release has an AppImage attached. The
// changelog is HELP > What's New, read from the same list CHANGELOG.md is generated from. After a
// build, the TypeDoc code reference (docs/api/html, from `npm run docs`) is copied in under api/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const releaseNotes = createRequire(import.meta.url)('../scripts/release-notes.js');
const siteDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(siteDir, '..');
const out = path.join(root, '_site');
const apiHtml = path.join(root, 'docs', 'api', 'html');
const screenshots = path.join(root, 'docs', 'screenshots');

/**
 * Returns "owner/name" from GITHUB_REPOSITORY or the origin remote's URL.
 * @returns {string} The repository slug.
 * @throws {Error} When neither names a GitHub repository.
 */
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  const match = remote.status === 0 && remote.stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) throw new Error('Set GITHUB_REPOSITORY=owner/name: the origin remote is not a GitHub repository.');
  return match[1];
}

/**
 * Runs the GitHub CLI and parses its JSON output.
 * @param {string[]} args The gh arguments.
 * @returns {*} The parsed output, or null if gh is missing or the call fails.
 */
function gh(args) {
  const run = spawnSync('gh', args, { cwd: root, encoding: 'utf8' });
  if (run.error || run.status !== 0) return null;
  try { return JSON.parse(run.stdout); } catch { return null; }
}

/**
 * Finds the newest release and the files the Downloads page offers from it.
 * @param {string} slug The repository, "owner/name".
 * @returns {Object|null} { tag, beta, date, windows, linux, checksums, demo }, or null when there is
 *   no release with a Windows installer. Each file is { name, url, size }; all but windows may be null.
 */
function newestRelease(slug) {
  const list = gh(['release', 'list', '-R', slug, '-L', '1', '--exclude-drafts', '--json', 'tagName,isPrerelease,publishedAt']);
  if (!list || !list.length) return null;
  const { tagName, isPrerelease, publishedAt } = list[0];
  const view = gh(['release', 'view', tagName, '-R', slug, '--json', 'assets']);
  if (!view) return null;
  const file = (pattern) => {
    const asset = view.assets.find((a) => pattern.test(a.name));
    return asset ? { name: asset.name, url: asset.url, size: asset.size } : null;
  };
  const windows = file(/^RerunTV-Setup-.+\.exe$/);
  if (!windows) return null;
  return {
    tag: tagName,
    beta: isPrerelease,
    date: publishedAt,
    windows,
    linux: file(/^RerunTV-.+\.AppImage$/),
    checksums: file(/^SHA256SUMS\.txt$/),
    demo: file(/^RerunTV-demo-library\.zip$/),
  };
}

/**
 * Reads the changelog from HELP > What's New.
 * @returns {Object[]} The entries, newest first: { date, items }.
 */
function readChangelog() {
  return releaseNotes.parseChangelog(fs.readFileSync(path.join(root, releaseNotes.SOURCE), 'utf8'));
}

/**
 * Works out what the pages say about the repository, the newest release and the changelog.
 * @param {boolean} lookUpRelease Whether to ask GitHub for the newest release (builds only).
 * @returns {Object} { repoUrl, releasesUrl, release, releaseNote, changelog }.
 */
function siteInfo(lookUpRelease) {
  const slug = repoSlug();
  const repoUrl = `https://github.com/${slug}`;
  const release = lookUpRelease ? newestRelease(slug) : null;
  if (lookUpRelease && !release) console.warn('No release installer found (or gh unavailable): Downloads links to the Releases page.');
  return {
    repoUrl,
    releasesUrl: `${repoUrl}/releases`,
    release,
    releaseNote: release ? `Latest: ${release.tag}${release.beta ? ' (beta)' : ''}.` : '',
    changelog: readChangelog(),
  };
}

/**
 * Copies the code reference and the share-card image into the finished build.
 * @returns {Object} A Vite plugin.
 */
function copyExtras() {
  return {
    name: 'rerun-site-extras',
    apply: 'build',
    closeBundle() {
      fs.copyFileSync(path.join(screenshots, 'guide.jpg'), path.join(out, 'og-image.jpg'));
      if (fs.existsSync(path.join(apiHtml, 'index.html'))) {
        fs.cpSync(apiHtml, path.join(out, 'api'), { recursive: true });
      } else {
        console.warn('No code reference in docs/api/html (run `npm run docs` first): api/ is left out.');
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  root: siteDir,
  // Relative URLs, so the site works under any Pages path (/RerunTV/) and from a local folder.
  base: './',
  plugins: [react(), copyExtras()],
  define: { __SITE_INFO__: JSON.stringify(siteInfo(command === 'build')) },
  resolve: { alias: { '@screenshots': screenshots } },
  server: { fs: { allow: [siteDir, screenshots] } },
  build: { outDir: out, emptyOutDir: true },
}));
