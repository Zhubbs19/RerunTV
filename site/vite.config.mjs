// Vite config for the GitHub Pages site (`npm run site` builds it into _site/, `npm run site:dev`
// serves it with live reload). The site is a small React app in site/src: a hash router picks the
// landing page, the features index or one feature page (listed in src/features.json).
//
// The build also looks up the repository and the newest release, which the pages read through the
// __SITE_INFO__ constant. The repository comes from GITHUB_REPOSITORY (set in Actions), else the
// origin remote. The Download button points at the Windows installer of the newest release,
// prereleases included, looked up with the GitHub CLI; without `gh` or a release, or in dev, it
// points at the Releases page. After a build, the TypeDoc code reference (docs/api/html, from
// `npm run docs`) is copied in under api/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
 * Picks the newest release and its Windows installer.
 * @param {string} slug The repository, "owner/name".
 * @returns {Object|null} { tag, prerelease, url }, or null when there is none.
 */
function newestInstaller(slug) {
  const list = gh(['release', 'list', '-R', slug, '-L', '1', '--exclude-drafts', '--json', 'tagName,isPrerelease']);
  if (!list || !list.length) return null;
  const { tagName, isPrerelease } = list[0];
  const view = gh(['release', 'view', tagName, '-R', slug, '--json', 'assets']);
  const asset = view && view.assets.find((a) => /^RerunTV-Setup-.+\.exe$/.test(a.name));
  if (!asset) return null;
  return { tag: tagName, prerelease: isPrerelease, url: asset.url };
}

/**
 * Works out what the pages say about the repository and the newest release.
 * @param {boolean} lookUpRelease Whether to ask GitHub for the newest release (builds only).
 * @returns {Object} { repoUrl, downloadUrl, releaseNote }.
 */
function siteInfo(lookUpRelease) {
  const slug = repoSlug();
  const repoUrl = `https://github.com/${slug}`;
  const release = lookUpRelease ? newestInstaller(slug) : null;
  if (lookUpRelease && !release) console.warn('No release installer found (or gh unavailable): Download links to the Releases page.');
  return {
    repoUrl,
    downloadUrl: release ? release.url : `${repoUrl}/releases`,
    releaseNote: release ? `Latest: ${release.tag}${release.prerelease ? ' (beta)' : ''}.` : '',
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
