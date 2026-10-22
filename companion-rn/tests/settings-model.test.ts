import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGroups, buildNode, countLeaves, describeResult, filterGroups, getIn, isSensitiveKey, labelFor, parseJsonList, parseTyped, setIn, toDisplay, toStored,
  type LeafNode, type ObjectNode,
} from '../src/lib/settings-model.ts';

const config = {
  volume: 0.6,
  muted: false,
  pictureMode: 'vivid',
  theme: 'blue-classic',
  channels: [{ number: 2 }],
  display: { uiScale: 'auto', guideSlotMinutes: 30, logoBugHideOnBreaks: true },
  controls: { sleepSteps: ['30', '60'], startupChannel: 'last', volumeMaxPct: 80 },
  ticker: { apiKey: 'abc', items: [{ a: 1 }] },
  weirdPlugin: { note: 'x' },
};
const themes = [{ id: 'blue-classic', label: 'BLUE CLASSIC' }, { id: 'amber', label: 'AMBER' }];

test('labelFor splits camel case and separators', () => {
  assert.equal(labelFor('guideSlotMinutes'), 'GUIDE SLOT MINUTES');
  assert.equal(labelFor('night-mode_on'), 'NIGHT MODE ON');
});

test('leaf kinds follow the value and the metadata tables', () => {
  const kind = (key: string, value: unknown, path = [key]) => (buildNode(key, value, path, themes) as LeafNode).kind;
  assert.equal(kind('muted', true), 'boolean');
  assert.equal(kind('pictureMode', 'vivid'), 'enum');
  assert.equal(kind('volume', 0.6), 'range');
  assert.equal(kind('theme', 'amber'), 'enum');
  assert.equal(kind('entry', 5, ['controls', 'unknown']), 'number');
  assert.equal(kind('note', 'hi'), 'text');
  assert.equal(kind('apiKey', 'abc'), 'secret');
  assert.equal(kind('tags', ['a', 'b']), 'stringList');
  assert.equal(kind('items', [{ a: 1 }]), 'json');
  assert.equal(kind('empty', []), 'json');
});

test('an unknown current enum value stays selectable', () => {
  const node = buildNode('pictureMode', 'sepia', ['pictureMode'], themes) as LeafNode;
  assert.equal(node.choices?.[0][0], 'sepia');
  assert.match(node.choices?.[0][1] ?? '', /CURRENT/);
});

test('TV appearance comes first, channels are hidden, leftovers are last', () => {
  const groups = buildGroups(config, themes);
  assert.equal(groups[0].title, 'TV APPEARANCE');
  assert.deepEqual(groups[0].nodes.map((n) => n.dotted), ['theme', 'display.uiScale']);
  const all = groups.flatMap((g) => g.nodes.map((n) => n.key));
  assert.ok(!all.includes('channels'));
  assert.equal(groups[groups.length - 1].title, 'PLUGIN & CHANNEL FEATURES');
  assert.ok(groups[groups.length - 1].nodes.some((n) => n.key === 'weirdPlugin'));
  const display = groups.flatMap((g) => g.nodes).find((n) => n.key === 'display') as ObjectNode;
  assert.ok(!display.children.some((c) => c.key === 'uiScale'), 'uiScale is not repeated under display');
});

test('search keeps matching leaves with their parents, or a whole matching section', () => {
  const groups = buildGroups(config, themes);
  const sleep = filterGroups(groups, 'sleep');
  assert.ok(countLeaves(sleep.flatMap((g) => g.nodes)) >= 1);
  const flat = JSON.stringify(sleep.map((g) => g.nodes.map((n) => n.dotted)));
  assert.match(flat, /controls/);
  assert.ok(!/ticker/.test(flat));
  assert.equal(filterGroups(groups, 'zzzzzz').length, 0);
  assert.equal(filterGroups(groups, '  ').length, groups.length);
  const byGroupName = filterGroups(groups, 'tv appearance');
  assert.equal(byGroupName[0].nodes.length, 2);
});

test('setIn and getIn work on nested paths without mutating', () => {
  const before = { display: { guideSlotMinutes: 30 } };
  const after = setIn(before, ['display', 'guideSlotMinutes'], 60);
  assert.equal(getIn(after, ['display', 'guideSlotMinutes']), 60);
  assert.equal(before.display.guideSlotMinutes, 30);
  assert.deepEqual(setIn({}, ['a', 'b', 'c'], 1), { a: { b: { c: 1 } } });
  assert.equal(getIn({}, ['x', 'y']), undefined);
});

test('typed text and scaled ranges convert back to stored values', () => {
  assert.equal(parseTyped(5, '7.5'), 7.5);
  assert.equal(parseTyped(5, 'abc'), 5);
  assert.equal(parseTyped('x', 'y'), 'y');
  const volume: [number, number, number, string, number] = [0, 100, 1, '%', 0.01];
  assert.equal(toDisplay(0.6, volume), 60);
  assert.equal(toStored(60, volume), 0.6);
});

test('JSON lists, sensitive keys and the box verdict', () => {
  assert.deepEqual(parseJsonList('[1,2]'), [1, 2]);
  assert.equal(parseJsonList('{"a":1}'), null);
  assert.equal(parseJsonList('[1,'), null);
  assert.equal(isSensitiveKey('apiKey'), true);
  assert.equal(isSensitiveKey('volume'), false);
  assert.deepEqual(describeResult({ at: 1, applied: ['volume'] }), { ok: true, text: 'Applied: volume.' });
  assert.equal(describeResult({ at: 1 }).ok, true);
  const refused = describeResult({ at: 1, applied: ['a'], rejected: [{ section: 'b', reason: 'unknown' }] });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /refused 1: b \(unknown\)/);
});
