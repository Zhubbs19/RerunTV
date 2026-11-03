#!/usr/bin/env node
// Release notes from HELP > What's New: the hand-kept CHANGELOG list in
// renderer/js/setup/help.js is the one place user-facing changes are written,
// and this script turns it into the two public copies.
//
//   node scripts/release-notes.js --since <git-ref>
//       Markdown for a GitHub release: the What's New items added since <ref>
//       (the previous release's tag). With no usable ref, the newest entry.
//   node scripts/release-notes.js --changelog
//       Rewrites CHANGELOG.md from the whole list.
//
// tests/release-notes.test.js fails when CHANGELOG.md is out of date, so a
// What's New edit and its CHANGELOG.md regeneration land together.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE = 'renderer/js/setup/help.js';
const CHANGELOG_MD = path.join(ROOT, 'CHANGELOG.md');

// The CHANGELOG array is plain data in an ES module that also touches the DOM,
// so it is cut out of the source text and evaluated on its own.
function parseChangelog(source) {
  const start = source.indexOf('const CHANGELOG = [');
  if (start < 0) throw new Error(`No CHANGELOG list in ${SOURCE}.`);
  const open = source.indexOf('[', start);
  const close = source.indexOf('\n];', open);
  if (close < 0) throw new Error(`The CHANGELOG list in ${SOURCE} has no closing "];" line.`);
  const entries = vm.runInNewContext(`(${source.slice(open, close + 2)})`, {}, { timeout: 1000 });
  const valid = Array.isArray(entries) && entries.every((e) => e
    && /^\d{4}-\d{2}-\d{2}$/.test(e.date)
    && Array.isArray(e.items) && e.items.every((item) => typeof item === 'string'));
  if (!valid) throw new Error(`Every CHANGELOG entry in ${SOURCE} needs a YYYY-MM-DD date and a list of strings.`);
  // Copied out of the sandbox's realm, so callers get ordinary arrays.
  return JSON.parse(JSON.stringify(entries));
}

// The items in `current` that `previous` doesn't have, keeping their entries' dates.
// A reworded item counts as new.
function newEntries(current, previous) {
  const known = new Set(previous.flatMap((e) => e.items));
  return current
    .map((e) => ({ date: e.date, items: e.items.filter((item) => !known.has(item)) }))
    .filter((e) => e.items.length);
}

function entryMarkdown(entry, heading) {
  return `${heading} ${entry.date}\n\n${entry.items.map((item) => `- ${item}`).join('\n')}\n`;
}

function releaseNotesMarkdown(entries) {
  if (!entries.length) {
    return "## What's new\n\nNothing you would notice: this build carries dependency updates and maintenance only.\n";
  }
  return `## What's new\n\n${entries.map((e) => entryMarkdown(e, '###')).join('\n')}`;
}

function changelogMarkdown(entries) {
  return [
    '# Changelog\n',
    'What changed in RerunTV, newest first. This is the list the app shows under HELP > What\'s New.',
    `It is generated from \`${SOURCE}\` by \`node scripts/release-notes.js --changelog\`, so edit it there.`,
    'Each GitHub release lists the entries that are new since the release before it.\n',
    entries.map((e) => entryMarkdown(e, '##')).join('\n'),
  ].join('\n');
}

function readSource(ref) {
  if (!ref) return fs.readFileSync(path.join(ROOT, SOURCE), 'utf8');
  return execFileSync('git', ['show', `${ref}:${SOURCE}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function main(argv) {
  const current = parseChangelog(readSource());
  if (argv[0] === '--changelog') {
    fs.writeFileSync(CHANGELOG_MD, changelogMarkdown(current));
    console.log(`Wrote ${path.relative(ROOT, CHANGELOG_MD)} (${current.length} entries).`);
    return;
  }
  if (argv[0] === '--since') {
    let previous;
    try { previous = argv[1] ? parseChangelog(readSource(argv[1])) : null; } catch (e) { previous = null; }
    const entries = previous ? newEntries(current, previous) : current.slice(0, 1);
    process.stdout.write(releaseNotesMarkdown(entries));
    return;
  }
  console.error('Usage: node scripts/release-notes.js --since <git-ref> | --changelog');
  process.exit(2);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { SOURCE, parseChangelog, newEntries, releaseNotesMarkdown, changelogMarkdown };
