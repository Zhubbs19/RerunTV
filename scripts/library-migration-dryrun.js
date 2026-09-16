#!/usr/bin/env node
// Dry run of the library migration against a real lineup (docs/design/07 §7-8).
//
// Reads a channels.json, plans the migration, and checks every channel with the
// real renderer diffSchedules over 60 days (the acceptance criterion in §8).
// It WRITES NOTHING to the profile it reads — the only output is a report in
// the directory passed as --out, which is meant to be a scratch location.
//
//   node scripts/library-migration-dryrun.js --config <channels.json> --out <dir> [--days 60]
//
// Exit code is 0 only when every channel migrates with an empty diff.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { planMigration, finalizeMigration } = require('../main/library/migrate');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const configPath = arg('config');
  const outDir = arg('out');
  const days = Number(arg('days', '60'));
  if (!configPath || !outDir) {
    console.error('usage: library-migration-dryrun.js --config <channels.json> --out <dir> [--days 60]');
    process.exit(2);
  }

  // The renderer modules touch `window` once at load; schedule-query's own tests
  // use the same shim.
  globalThis.window = globalThis.window || { matchMedia: () => ({ matches: false }), api: {} };
  globalThis.document = globalThis.document || { getElementById: () => null };
  const load = (name) => import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', name)).href);
  const { S } = await load('core/state.js');
  const { diffSchedules } = await load('core/schedule-query.js');

  const raw = fs.readFileSync(configPath, 'utf-8');
  const original = JSON.parse(raw);
  const plan = planMigration(original);

  // The plan must not have mutated what it was given. Checked, not assumed.
  if (fs.readFileSync(configPath, 'utf-8') !== raw || JSON.stringify(original) !== JSON.stringify(JSON.parse(raw))) {
    console.error('ABORT: planMigration modified its input');
    process.exit(1);
  }

  const from = Date.now();
  const to = from + days * 24 * 3600 * 1000;
  const verdicts = {};
  const report = [];

  for (const before of original.channels) {
    const after = plan.config.channels.find((ch) => ch.number === before.number);
    const started = Date.now();
    // Box-wide programming (presets, flows, the ad pool) is read from S.config,
    // so "before" is evaluated against the original config and "after" against
    // the planned one — the migration must not change either side's context.
    S.config = original;
    const diff = diffSchedules(before, after, from, to, { breaks: true, afterConfig: plan.config });
    verdicts[before.number] = { identical: diff.identical };
    report.push({
      number: before.number,
      name: before.name,
      files: (before.files || []).length,
      identical: diff.identical,
      added: diff.added.length,
      removed: diff.removed.length,
      breaksAdded: diff.breaksAdded.length,
      breaksRemoved: diff.breaksRemoved.length,
      offAirChanged: diff.offAirChanged.length,
      changedRanges: diff.changed.slice(0, 5).map((r) => ({ start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() })),
      ms: Date.now() - started,
    });
  }

  const final = finalizeMigration(original, plan, verdicts);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'migration-report.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: configPath,
    windowDays: days,
    channels: report,
    conflicts: plan.conflicts,
    accepted: final.accepted,
    rejected: final.rejected,
    library: { roots: final.index.roots.length, items: Object.keys(final.index.items).length },
  }, null, 2));
  fs.writeFileSync(path.join(outDir, 'planned-index.json'), JSON.stringify(final.index, null, 2));

  console.log(`window: ${days} days from ${new Date(from).toISOString()}`);
  report.forEach((r) => {
    const detail = r.identical ? 'identical' : `CHANGED  +${r.added} -${r.removed} breaks +${r.breaksAdded} -${r.breaksRemoved} offAir ${r.offAirChanged}`;
    console.log(`CH ${String(r.number).padStart(4)}  ${String(r.files).padStart(5)} files  ${String(r.ms).padStart(6)} ms  ${detail}  ${r.name}`);
  });
  console.log(`\nconflicts: ${plan.conflicts.length}`);
  console.log(`accepted: ${final.accepted.length}/${report.length}  rejected: ${final.rejected.length}`);
  console.log(`library would hold ${Object.keys(final.index.items).length} items in ${final.index.roots.length} roots`);
  console.log(`report: ${path.join(outDir, 'migration-report.json')}`);
  process.exit(final.rejected.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
