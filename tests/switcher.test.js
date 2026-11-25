import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwitcher } from '../extension/lib/switcher.js';

/** A runSwap that records calls and only finishes when released. */
function gated() {
  const calls = [];
  const releases = [];
  let running = 0;
  let maxRunning = 0;
  const runSwap = (id) => {
    calls.push(id);
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    return new Promise((resolve) => releases.push(() => { running -= 1; resolve(); }));
  };
  const tick = () => new Promise((r) => setImmediate(r));
  return { calls, runSwap, releaseNext: async () => { await tick(); releases.shift()(); await tick(); }, max: () => maxRunning };
}

test('switcher coalesces to latest', async () => {
  const g = gated();
  const s = createSwitcher(g.runSwap);
  const all = [s.request('A'), s.request('B'), s.request('C'), s.request('D')];
  await g.releaseNext(); // finishes A
  await g.releaseNext(); // finishes D
  await Promise.all(all);
  assert.deepEqual(g.calls, ['A', 'D']);
});

test('switcher runs one at a time', async () => {
  const g = gated();
  const s = createSwitcher(g.runSwap);
  const p1 = s.request('A');
  await new Promise((r) => setImmediate(r));
  const p2 = s.request('B');
  await g.releaseNext();
  await g.releaseNext();
  await Promise.all([p1, p2]);
  assert.equal(g.max(), 1);
  assert.deepEqual(g.calls, ['A', 'B']);
});

test('switcher survives a failing swap', async () => {
  const calls = [];
  const s = createSwitcher(async (id) => {
    calls.push(id);
    if (id === 'A') throw new Error('boom');
  });
  const origError = console.error;
  console.error = () => {};
  try {
    await s.request('A');
    await s.request('B');
  } finally {
    console.error = origError;
  }
  assert.deepEqual(calls, ['A', 'B']);
});
