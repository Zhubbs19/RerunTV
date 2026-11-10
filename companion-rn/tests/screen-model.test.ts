import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackKey, groupItems, isSnapshot, isTextItem, itemAction, itemValueText, screenHeading, stepValue, surfaceLabel,
  type ScreenItem, type ScreenSnapshot,
} from '../src/lib/screen-model.ts';

const item = (over: Partial<ScreenItem>): ScreenItem => ({ index: 0, kind: 'button', label: 'OK', group: '', ...over });

function snapshot(over: Partial<ScreenSnapshot> = {}): ScreenSnapshot {
  return { id: 1, screen: 'setup', mode: 'desktop', kind: 'setup', title: 'SETUP', trail: [], focusedIndex: null, items: [], truncated: false, ...over };
}

test('isSnapshot accepts the box reply and rejects anything else', () => {
  assert.equal(isSnapshot(snapshot()), true);
  assert.equal(isSnapshot({ id: 'x', items: [], title: '' }), false);
  assert.equal(isSnapshot(null), false);
  assert.equal(isSnapshot({ error: 'no screen' }), false);
});

test('groupItems keeps screen order, merges runs and filters by search', () => {
  const items = [
    item({ index: 0, label: 'CHANNELS', group: 'SECTIONS' }),
    item({ index: 1, label: 'BREAKS', group: 'SECTIONS' }),
    item({ index: 2, label: 'Clock style', group: 'Picture', kind: 'select', value: '12h' }),
    item({ index: 3, label: 'LIBRARY', group: 'SECTIONS' }),
  ];
  assert.deepEqual(groupItems(items).map((g) => [g.title, g.items.length]), [['SECTIONS', 2], ['Picture', 1], ['SECTIONS', 1]]);
  assert.deepEqual(groupItems(items, 'clock').map((g) => g.items.map((i) => i.index)), [[2]]);
  assert.deepEqual(groupItems(items, '12h').map((g) => g.title), ['Picture'], 'a value matches too');
  assert.deepEqual(groupItems(items, 'nothing'), []);
});

test('itemValueText shows toggles, choices, numbers and hides secrets', () => {
  assert.equal(itemValueText(item({ kind: 'switch', checked: true })), 'ON');
  assert.equal(itemValueText(item({ kind: 'checkbox', checked: false })), 'OFF');
  assert.equal(itemValueText(item({ kind: 'select', value: 'b', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] })), 'Beta');
  assert.equal(itemValueText(item({ kind: 'range', value: 40 })), '40');
  assert.equal(itemValueText(item({ kind: 'password', secret: true, value: null })), '••••');
  assert.equal(itemValueText(item({ kind: 'button' })), '');
});

test('itemAction decides what a tap does, and locked or off controls do nothing', () => {
  assert.equal(itemAction(item({ kind: 'tab' })), 'press');
  assert.equal(itemAction(item({ kind: 'checkbox' })), 'press');
  assert.equal(itemAction(item({ kind: 'select' })), 'pick');
  assert.equal(itemAction(item({ kind: 'range' })), 'adjust');
  assert.equal(itemAction(item({ kind: 'text' })), 'type');
  assert.equal(itemAction(item({ kind: 'button', locked: 'Plug-ins can only be changed on the host.' })), 'none');
  assert.equal(itemAction(item({ kind: 'button', disabled: true })), 'none');
  assert.equal(isTextItem(item({ kind: 'textarea' })), true);
  assert.equal(isTextItem(null), false);
});

test('stepValue moves by the step and stays in range', () => {
  assert.equal(stepValue(item({ kind: 'range', value: 5, min: 0, max: 10, step: 1 }), 1), 6);
  assert.equal(stepValue(item({ kind: 'range', value: 10, min: 0, max: 10 }), 1), 10);
  assert.equal(stepValue(item({ kind: 'range', value: 0.2, step: 0.1, min: 0, max: 1 }), 1), 0.3);
  assert.equal(stepValue(item({ kind: 'number', value: null, min: 3 }), -1), 3);
});

test('the heading reads the setup breadcrumb, or the surface title', () => {
  assert.equal(screenHeading(snapshot({ trail: ['CHANNELS', 'CH 5 Rewind', 'SCHEDULE'] })), 'CHANNELS › CH 5 Rewind › SCHEDULE');
  assert.equal(screenHeading(snapshot({ kind: 'dialog', title: 'DELETE CHANNEL?', trail: ['CHANNELS'] })), 'CHANNELS › DELETE CHANNEL?');
  assert.equal(screenHeading(snapshot({ kind: 'tv', screen: 'tv', title: 'LIVE TV · CH 5' })), 'LIVE TV · CH 5');
  assert.equal(surfaceLabel(snapshot({ kind: 'dialog', mode: 'tv' })), 'ON SCREEN NOW · TV MODE');
});

test('an older box gets the keyboard key for a remote button', () => {
  assert.equal(fallbackKey('up'), 'ArrowUp');
  assert.equal(fallbackKey('back'), 'Escape');
  assert.equal(fallbackKey('menu'), '?');
  assert.equal(fallbackKey('red'), null);
});
