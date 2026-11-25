import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome } from './fake-chrome.js';
import { seeded } from './helpers.js';
import { initialize, resolveRecovery } from '../extension/lib/setup.js';
import { readState } from '../extension/lib/store.js';
import { swapBar } from '../extension/lib/swap.js';

const bm = (t) => ({ title: t, url: `https://${t}/` });

test('first run keeps bar in place', async () => {
  const api = createFakeChrome({ bar: [bm('a'), bm('b')] });
  const before = api._events.filter((e) => e.name === 'onMoved').length;
  const state = await initialize(api);
  assert.deepEqual(api._titles('1'), ['a', 'b']);
  assert.equal(api._events.filter((e) => e.name === 'onMoved').length, before, 'nothing moved');
  const root = api._id('Focus Bars');
  assert.deepEqual(api._titles('2'), ['Focus Bars']);
  assert.deepEqual(api._titles(root), ['General']);
  assert.equal(state.rootId, root);
  assert.equal(state.generalId, api._id('General'));
  assert.equal(state.activeId, state.generalId);
  assert.deepEqual(state.focusIds, [state.generalId]);
  assert.equal(state.needsRecovery, false);
  assert.equal(state.barId, '1');
  assert.deepEqual(await readState(api.storage.local), state);
});

test('first run twice is idempotent', async () => {
  const api = createFakeChrome({ bar: [bm('a')] });
  const s1 = await initialize(api);
  const s2 = await initialize(api);
  assert.deepEqual(api._titles('2'), ['Focus Bars']);
  assert.deepEqual(s2, s1);
});

test('restart replays journal', async () => {
  const { api, generalId, devId } = await seeded();
  api._failAfterMoves(2);
  await assert.rejects(swapBar(api, devId));
  const state = await initialize(api);
  assert.deepEqual(api._titles('1'), ['x', 'y']);
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c']);
  assert.equal(state.activeId, devId);
  assert.equal(state.journal, null);
});

test('missing Focus Bars folder is recreated', async () => {
  const { api, rootId } = await seeded();
  await api.bookmarks.removeTree(rootId);
  const state = await initialize(api);
  const root = api._id('Focus Bars');
  assert.ok(root && root !== rootId);
  assert.equal(state.rootId, root);
  assert.equal(state.generalId, api._id('General'));
  assert.ok(state.focusIds.includes(state.generalId));
  assert.ok(state.focusIds.includes(state.activeId));
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c'], 'bar untouched');
});

test('missing General folder is recreated', async () => {
  const { api, generalId, devId } = await seeded();
  await swapBar(api, devId);
  await api.bookmarks.removeTree(generalId);
  const state = await initialize(api);
  assert.notEqual(state.generalId, generalId);
  assert.ok(api._exists(state.generalId));
  assert.deepEqual(state.focusIds, [state.generalId, devId]);
  assert.equal(state.activeId, devId);
});

function reinstall(focusChildren, bar = [bm('x'), bm('y')]) {
  return createFakeChrome({ bar, other: [{ title: 'Focus Bars', children: focusChildren }] });
}

test('reinstall picks the single empty folder', async () => {
  const api = reinstall([{ title: 'General', children: [bm('a'), bm('b')] }, { title: 'Dev', children: [] }]);
  const state = await initialize(api);
  assert.equal(state.activeId, api._id('Dev'));
  assert.equal(state.generalId, api._id('General'));
  assert.deepEqual(state.focusIds, [api._id('General'), api._id('Dev')]);
  assert.equal(state.needsRecovery, false);
  assert.deepEqual(api._titles('1'), ['x', 'y'], 'nothing moved');
});

test('reinstall with two empty folders needs recovery', async () => {
  const api = reinstall([{ title: 'General', children: [] }, { title: 'Dev', children: [] }]);
  const state = await initialize(api);
  assert.equal(state.needsRecovery, true);
  assert.equal(state.activeId, state.generalId);
});

test('reinstall ignores Removed folders', async () => {
  const api = reinstall([
    { title: 'General', children: [bm('a')] },
    { title: 'Dev', children: [] },
    { title: 'Removed – Old', children: [] },
  ]);
  const state = await initialize(api);
  assert.deepEqual(state.focusIds, [api._id('General'), api._id('Dev')]);
  assert.equal(state.activeId, api._id('Dev'));
  assert.equal(state.needsRecovery, false);
});

test('reinstall without a General folder creates one', async () => {
  const api = reinstall([{ title: 'Dev', children: [bm('d')] }, { title: 'Music', children: [] }]);
  const state = await initialize(api);
  assert.equal(state.generalId, api._id('General'));
  assert.ok(state.focusIds.includes(state.generalId));
  // General is new and empty, Music is empty too: ambiguous.
  assert.equal(state.needsRecovery, true);
});

test('resolveRecovery clears flag', async () => {
  const api = reinstall([{ title: 'General', children: [] }, { title: 'Dev', children: [] }]);
  await initialize(api);
  const devId = api._id('Dev');
  const state = await resolveRecovery(api, devId);
  assert.equal(state.needsRecovery, false);
  assert.equal(state.activeId, devId);
  assert.deepEqual(await readState(api.storage.local), state);
});

const oldLink = (id) => ({ title: '✓ Dev', url: `chrome-extension://oldid/switch.html?focus=${id}` });

test('first run adopts a leftover switcher', async () => {
  const api = createFakeChrome({ bar: [{ title: '⇄ Dev', children: [oldLink(9)] }, bm('a')] });
  const state = await initialize(api);
  const sw = api._id('⇄ Dev');
  assert.equal(state.switcherId, sw);
  assert.equal(state.showSwitcher, true);
  const { createFocus } = await import('../extension/lib/focuses.js');
  const dev = await createFocus(api, 'Dev', { copyCurrent: false });
  await swapBar(api, dev);
  assert.deepEqual(api._titles('1'), ['⇄ Dev']);
  assert.deepEqual(api._titles(state.generalId), ['a'], 'switcher not filed under General');
});

test('reinstall adopts a leftover switcher', async () => {
  const api = createFakeChrome({
    bar: [{ title: '⇄ Dev', children: [oldLink(9)] }, bm('x')],
    other: [{ title: 'Focus Bars', children: [{ title: 'General', children: [bm('a')] }, { title: 'Dev', children: [] }] }],
  });
  const state = await initialize(api);
  assert.equal(state.switcherId, api._id('⇄ Dev'));
  assert.equal(state.activeId, api._id('Dev'));
});

test('a folder of ordinary bookmarks named ⇄ is not adopted', async () => {
  const api = createFakeChrome({ bar: [{ title: '⇄ stuff', children: [bm('q')] }, bm('a')] });
  const state = await initialize(api);
  assert.equal(state.switcherId, null);
});
