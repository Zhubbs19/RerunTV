// Every renderer ES module parses and links: import paths exist and every
// named import is actually exported. `node --check` can't see either (it
// parses as a script), and the unit tests only import the pure modules, so a
// syntax error or a stale import in a DOM module otherwise surfaces only when
// the app loads. Links without evaluating, so no DOM is needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');

function walk(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out); else if (entry.name.endsWith('.js')) out.push(p);
  });
  return out;
}

test('renderer modules parse and link', { skip: typeof vm.SourceTextModule !== 'function' && 'needs --experimental-vm-modules' }, async () => {
  const context = vm.createContext({});
  const cache = new Map();
  const load = (file) => {
    if (!cache.has(file)) cache.set(file, new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file, context }));
    return cache.get(file);
  };
  const failures = [];
  for (const file of walk(path.join(root, 'renderer', 'js'))) {
    const mod = load(file);
    if (mod.status !== 'unlinked') continue; // linked already, as another module's dependency
    try {
      await mod.link((specifier, referencing) => {
        if (!specifier.startsWith('.')) return new vm.SyntheticModule([], () => {}, { context });
        const target = path.resolve(path.dirname(referencing.identifier), specifier);
        if (!fs.existsSync(target)) throw new Error(`imports missing ${specifier}`);
        return load(target);
      });
    } catch (e) {
      failures.push(`${path.relative(root, file)}: ${e.message}`);
    }
  }
  assert.deepEqual(failures, []);
});
