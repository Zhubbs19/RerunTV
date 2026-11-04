#!/usr/bin/env node
// Builds the GitHub Pages site into _site/ (`npm run site`; the Pages workflow runs it after
// `npm run docs`).
//
// The landing page lives in site/. This copies it, fills its {{…}} placeholders, adds the
// README screenshots under screenshots/ and the Doxygen code reference (docs/api/html, from
// `npm run docs`) under api/. The repository comes from GITHUB_REPOSITORY (set in Actions),
// else the origin remote. The Download button points at the Windows installer of the newest
// release, prereleases included, looked up with the GitHub CLI; without `gh` or a release it
// points at the Releases page instead.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, '_site');
const apiHtml = path.join(root, 'docs', 'api', 'html');

// Returns "owner/name" from GITHUB_REPOSITORY or the origin remote's URL.
function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8' });
  const match = remote.status === 0 && remote.stdout.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) throw new Error('Set GITHUB_REPOSITORY=owner/name: the origin remote is not a GitHub repository.');
  return match[1];
}

// Runs the GitHub CLI and returns parsed JSON, or null if gh is missing or the call fails.
function gh(args) {
  const run = spawnSync('gh', args, { cwd: root, encoding: 'utf8' });
  if (run.error || run.status !== 0) return null;
  try { return JSON.parse(run.stdout); } catch { return null; }
}

// Picks the newest release and its Windows installer, or returns null.
function newestInstaller(slug) {
  const list = gh(['release', 'list', '-R', slug, '-L', '1', '--exclude-drafts', '--json', 'tagName,isPrerelease']);
  if (!list || !list.length) return null;
  const { tagName, isPrerelease } = list[0];
  const view = gh(['release', 'view', tagName, '-R', slug, '--json', 'assets']);
  const asset = view && view.assets.find((a) => /^RerunTV-Setup-.+\.exe$/.test(a.name));
  if (!asset) return null;
  return { tag: tagName, prerelease: isPrerelease, url: asset.url };
}

// HTML-escapes a value going into the page.
function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const slug = repoSlug();
const repoUrl = `https://github.com/${slug}`;
const release = newestInstaller(slug);
if (!release) console.warn('No release installer found (or gh unavailable): Download links to the Releases page.');

const values = {
  REPO_URL: repoUrl,
  DOWNLOAD_URL: release ? release.url : `${repoUrl}/releases`,
  RELEASE_NOTE: release ? `Latest: ${release.tag}${release.prerelease ? ' (beta)' : ''}.` : '',
};

// Empties _site rather than removing it, so a local preview server running in it keeps working
// (Windows won't remove a folder that is some process's working directory).
fs.mkdirSync(out, { recursive: true });
for (const entry of fs.readdirSync(out)) fs.rmSync(path.join(out, entry), { recursive: true, force: true });
fs.cpSync(path.join(root, 'site'), out, { recursive: true });
fs.cpSync(path.join(root, 'docs', 'screenshots'), path.join(out, 'screenshots'), { recursive: true });

const indexPath = path.join(out, 'index.html');
const html = fs.readFileSync(indexPath, 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => {
  if (!(key in values)) throw new Error(`site/index.html uses an unknown placeholder ${whole}`);
  return esc(values[key]);
});
fs.writeFileSync(indexPath, html);

if (fs.existsSync(path.join(apiHtml, 'index.html'))) {
  fs.cpSync(apiHtml, path.join(out, 'api'), { recursive: true });
} else {
  console.warn('No code reference in docs/api/html (run `npm run docs` first): api/ is left out.');
}

console.log(`Site: _site/index.html (${release ? `download ${release.tag}` : 'download → Releases page'})`);
