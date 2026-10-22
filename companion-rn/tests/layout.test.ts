import test from 'node:test';
import assert from 'node:assert/strict';
import { columnsFor, computeLayout, sizeClass } from '../src/lib/layout.ts';

test('size classes at common device widths', () => {
  assert.equal(sizeClass(320), 'compact'); // small iPhone / older Android
  assert.equal(sizeClass(375), 'regular'); // iPhone 13 mini / SE 3
  assert.equal(sizeClass(393), 'regular'); // most current phones
  assert.equal(sizeClass(430), 'large'); // Pro Max sizes
  assert.equal(sizeClass(600), 'large'); // small tablet portrait
  assert.equal(sizeClass(844), 'wide'); // phone landscape
  assert.equal(sizeClass(1024), 'wide'); // tablet landscape
});

test('columnsFor fits cells and clamps', () => {
  assert.equal(columnsFor(300, 92, 8, 2, 4), 3);
  assert.equal(columnsFor(150, 92, 8, 2, 4), 2);
  assert.equal(columnsFor(900, 92, 8, 2, 4), 4);
});

test('a phone in portrait is one column using the full width', () => {
  const l = computeLayout(393, 852);
  assert.equal(l.twoColumn, false);
  assert.equal(l.landscape, false);
  assert.equal(l.contentWidth, 393 - 32);
  assert.equal(l.quickColumns, 3);
  assert.equal(l.padKey, 84);
});

test('a small phone gets smaller keys and fewer columns', () => {
  const l = computeLayout(320, 568);
  assert.equal(l.isCompact, true);
  assert.equal(l.padKey, 68);
  assert.equal(l.quickColumns, 2);
});

test('landscape phones and tablets go two columns with a capped width', () => {
  const phone = computeLayout(844, 390, 47, 47);
  assert.equal(phone.twoColumn, true);
  assert.equal(phone.landscape, true);
  assert.ok(phone.contentWidth <= 844 - 94 - 32);
  const tablet = computeLayout(1180, 820);
  assert.equal(tablet.contentWidth, 1040);
  const portraitTablet = computeLayout(768, 1024);
  assert.equal(portraitTablet.twoColumn, true);
});

test('side insets (notch) shrink the usable width', () => {
  const plain = computeLayout(390, 844);
  const notched = computeLayout(390, 844, 20, 20);
  assert.equal(plain.contentWidth - notched.contentWidth, 40);
});
