// Each release keeps an archive/<tag> git tag after the release itself is replaced
// (build-installer.yml). Bare tags appear in GitHub's releases.atom feed, which the
// installed app's updater reads, so this checks the real electron-updater provider
// against a feed where an archive tag comes first.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');

const LATEST_YML = 'version: 0.2.0-beta.25\npath: x.exe\nsha512: abc\nreleaseDate: 2026-01-01T00:00:00.000Z\nfiles:\n  - url: x.exe\n    sha512: abc\n    size: 1\n';

function entry(tag) {
  return `<entry><id>${tag}</id><link rel="alternate" type="text/html" href="https://github.com/o/r/releases/tag/${tag}"/><title>${tag}</title><content>notes</content></entry>`;
}

async function updateFrom(tags) {
  const feed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${tags.map(entry).join('')}</feed>`;
  const provider = new GitHubProvider(
    { provider: 'github', owner: 'o', repo: 'r' },
    { allowPrerelease: true, currentVersion: '0.2.0-beta.24', channel: null },
    { executor: { request: async () => LATEST_YML }, platform: 'win32', isUseMultipleRangeRequest: false },
  );
  provider.httpRequest = async () => feed;
  return (await provider.getLatestVersion()).tag;
}

test('the beta updater skips archive/ tags in the releases feed', async () => {
  // GitHub URL-encodes the slash, so the tag is not valid semver.
  assert.equal(await updateFrom(['archive%2Fv0.2.0-beta.24', 'v0.2.0-beta.25']), 'v0.2.0-beta.25');
});

test('a plain tag with no release behind it would be offered as the update', async () => {
  // Why the old vX tag is deleted with its release rather than kept.
  assert.equal(await updateFrom(['v0.2.0-beta.24', 'v0.2.0-beta.25']), 'v0.2.0-beta.24');
});

test('the release workflow tags a replaced release archive/<tag> before deleting it', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'build-installer.yml'), 'utf8');
  const loop = workflow.slice(workflow.indexOf('for old_tag in'));
  const archive = loop.indexOf('-f ref="refs/tags/archive/$old_tag"');
  assert.ok(archive >= 0, 'the loop keeps an archive tag');
  assert.ok(archive < loop.indexOf('gh release delete'), 'before the release and its tag are deleted');
  assert.match(workflow, /fetch-depth: 0/, 'the old tag must be in the checkout to find its commit');
});
