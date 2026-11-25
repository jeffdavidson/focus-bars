import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jaccard, matchWindows, prunePrints } from '../extension/lib/fingerprint.js';

const DAY = 24 * 3600 * 1000;

test('jaccard basics', () => {
  assert.equal(jaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccard(['a', 'b'], ['c']), 0);
  assert.equal(jaccard(['a', 'b', 'c'], ['a', 'b', 'd']), 0.5);
  assert.equal(jaccard([], []), 0);
  assert.equal(jaccard(['a', 'a', 'b'], ['a', 'b']), 1, 'duplicates count once');
});

test('matchWindows matches at or above threshold', () => {
  const prints = { p1: { urls: ['a', 'b', 'c'], focusId: 'dev', lastSeen: 0 } };
  assert.deepEqual(matchWindows([{ id: 1, urls: ['a', 'b', 'd'] }], prints), { 1: 'p1' });
});

test('matchWindows below threshold leaves unmatched', () => {
  const prints = { p1: { urls: ['a', 'b', 'c', 'd'], focusId: 'dev', lastSeen: 0 } };
  assert.deepEqual(matchWindows([{ id: 1, urls: ['a', 'x', 'y'] }], prints), {});
});

test('matchWindows assigns each print once', () => {
  const prints = { p1: { urls: ['a', 'b', 'c'], focusId: 'dev', lastSeen: 0 } };
  const wins = [
    { id: 1, urls: ['a', 'b'] }, // 2/3
    { id: 2, urls: ['a', 'b', 'c'] }, // 1.0
  ];
  assert.deepEqual(matchWindows(wins, prints), { 2: 'p1' });
});

test('matchWindows pairs two windows with two prints', () => {
  const prints = {
    dev: { urls: ['g1', 'g2', 'g3'], focusId: 'D', lastSeen: 0 },
    music: { urls: ['m1', 'm2'], focusId: 'M', lastSeen: 0 },
  };
  const wins = [{ id: 10, urls: ['m1', 'm2'] }, { id: 11, urls: ['g1', 'g2', 'g3', 'g4'] }];
  assert.deepEqual(matchWindows(wins, prints), { 10: 'music', 11: 'dev' });
});

test('prunePrints keeps live and recent', () => {
  const now = 100 * DAY;
  const prints = {
    live: { urls: [], focusId: 'a', lastSeen: 0 },
    recent: { urls: [], focusId: 'a', lastSeen: now - 29 * DAY },
    old: { urls: [], focusId: 'a', lastSeen: now - 31 * DAY },
  };
  assert.deepEqual(Object.keys(prunePrints(prints, new Set(['live']), now)).sort(), ['live', 'recent']);
});
