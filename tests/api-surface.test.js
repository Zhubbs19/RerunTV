// The browser shim really satisfies the window.api contract.
//
// renderer/js/api-contract.js's createApiSurface THROWS when a viewer-facing
// contract method is missing or is not a function, and browser-api-shim.js
// builds window.api by calling it at the top of an IIFE. So a mismatch is not
// a degraded feature — it leaves a LAN browser with no window.api at all and
// the whole page dead. That happened: `quitApp` was declared a viewer method
// while the shim defined it as `null`, and `musicChoiceScanFolder` /
// `musicChoiceEmbeddedArt` were declared viewer methods the shim never defined
// at all. Nothing caught it, because every automated run drove the Electron
// window, where preload provides window.api and the shim is a no-op.
//
// Checked against the shim's source rather than by executing it: the shim needs
// a DOM, fetch, screen and location, and standing all of that up would test the
// mock more than the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contract = require('../renderer/js/api-contract.js');
const shimSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'js', 'browser-api-shim.js'), 'utf8');

// The object literal passed to createApiSurface. Its keys are at one fixed
// indent, which is what makes a flat text scan reliable here.
const browserApiBody = shimSource.slice(shimSource.indexOf('const browserApi = {'));
const definedKeys = [...browserApiBody.matchAll(/^ {4}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);

const viewerMethods = Object.entries(contract.methods)
  .filter(([, descriptor]) => descriptor.viewer !== 'host-only')
  .map(([name]) => name);

test('the shim defines every viewer-facing contract method', () => {
  const defined = new Set(definedKeys);
  const missing = viewerMethods.filter((name) => !defined.has(name));
  assert.deepEqual(missing, [],
    'createApiSurface throws on a missing method, which leaves a LAN browser with no window.api at all. '
    + 'Either implement it in browser-api-shim.js or move it to hostOnlyMethods in api-contract.js.');
});

test('the shim defines no method as null or undefined', () => {
  const notFunctions = [...browserApiBody.matchAll(/^ {4}([A-Za-z0-9_]+):\s*(null|undefined)\s*,/gm)].map((m) => m[1]);
  assert.deepEqual(notFunctions, [],
    'createApiSurface requires a function. A method that cannot work off-host belongs in hostOnlyMethods, '
    + 'where callers already check for its absence.');
});

test('the shim defines nothing outside the contract', () => {
  const extras = definedKeys.filter((name) => !contract.methods[name]);
  assert.deepEqual(extras, [], 'createApiSurface rejects methods outside the contract.');
});

test('host-only methods are absent from the shim, not stubbed into it', () => {
  const hostOnly = Object.entries(contract.methods)
    .filter(([, descriptor]) => descriptor.viewer === 'host-only')
    .map(([name]) => name);
  const defined = new Set(definedKeys);
  const stubbed = hostOnly.filter((name) => defined.has(name));
  assert.deepEqual(stubbed, [], 'createApiSurface drops host-only methods for a viewer, so a stub here is dead code.');
});

test('createApiSurface builds a viewer surface from a shim-shaped implementation', () => {
  // The real thing, with every key the shim defines stubbed as a function:
  // this is what the shim's own call does, so it fails the same way the shim
  // would if the two lists ever drift apart again.
  const implementations = Object.fromEntries(definedKeys.map((name) => [name, () => {}]));
  const api = contract.createApiSurface(implementations, 'viewer');
  viewerMethods.forEach((name) => {
    assert.equal(typeof api[name], 'function', `${name} is callable on a viewer`);
  });
  assert.equal(api.quitApp, undefined, 'a host-only method is simply not there');
});
