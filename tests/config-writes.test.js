// Burn-down ratchet for untyped config writes (docs/design/05 step 5). See
// scripts/audit-config-writes.js for the report and how to lower a ceiling.
const test = require('node:test');
const assert = require('node:assert/strict');
const { countUntypedWrites, readCeiling } = require('../scripts/audit-config-writes');

test('no renderer file adds untyped saveConfigDebounced() writes above its ceiling', () => {
  const counts = countUntypedWrites();
  const ceiling = readCeiling();
  const above = Object.entries(counts)
    .filter(([name, n]) => n > (ceiling[name] || 0))
    .map(([name, n]) => `${name}: ${n} (ceiling ${ceiling[name] || 0})`);
  assert.deepEqual(above, [], 'Use dispatch() with a named command for new config edits (CLAUDE.md, "Commands").');
});
