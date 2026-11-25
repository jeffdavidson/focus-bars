import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeChrome } from './fake-chrome.js';
import { seeded } from './helpers.js';
import { findRoots } from '../extension/lib/roots.js';
import { readState } from '../extension/lib/store.js';
import { swapBar, recoverJournal } from '../extension/lib/swap.js';

test('swapBar moves bar to active folder and target onto bar', async () => {
  const { api, generalId, devId } = await seeded();
  const state = await swapBar(api, devId);
  assert.deepEqual(api._titles('1'), ['x', 'y']);
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c']);
  assert.deepEqual(api._titles(devId), []);
  assert.equal(state.activeId, devId);
  assert.equal(state.journal, null);
  assert.equal(typeof state.lastSwapMs, 'number');
  assert.deepEqual(await readState(api.storage.local), state);
});

test('swapBar preserves order including subfolders', async () => {
  const api = createFakeChrome({
    bar: [{ title: 'a', url: 'https://a/' }, { title: 'F', children: [{ title: 'f1', url: 'https://f1/' }, { title: 'f2', url: 'https://f2/' }] }, { title: 'c', url: 'https://c/' }],
    other: [{ title: 'Focus Bars', children: [{ title: 'General', children: [] }, { title: 'Dev', children: [] }] }],
  });
  const { writeState } = await import('../extension/lib/store.js');
  const g = api._id('General');
  const d = api._id('Dev');
  await writeState(api.storage.local, { version: 1, barId: '1', rootId: api._id('Focus Bars'), generalId: g, focusIds: [g, d], activeId: g, journal: null, needsRecovery: false, prints: {}, lastSwapMs: null });
  await swapBar(api, d);
  assert.deepEqual(api._titles(g), ['a', 'F', 'c']);
  assert.deepEqual(api._titles(api._id('F')), ['f1', 'f2']);
  await swapBar(api, g);
  assert.deepEqual(api._titles('1'), ['a', 'F', 'c']);
});

test('swapBar to active is a no-op', async () => {
  const { api, generalId } = await seeded();
  const before = api._events.length;
  await swapBar(api, generalId);
  assert.equal(api._events.length, before);
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c']);
});

test('recoverJournal after partial move to folder', async () => {
  const { api, generalId, devId } = await seeded();
  api._failAfterMoves(2);
  await assert.rejects(swapBar(api, devId));
  assert.equal((await readState(api.storage.local)).journal.phase, 'toFolder');
  const state = await recoverJournal(api);
  assert.deepEqual(api._titles('1'), ['x', 'y']);
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c']);
  assert.deepEqual(api._titles(devId), []);
  assert.equal(state.activeId, devId);
  assert.equal(state.journal, null);
  const events = api._events.length;
  await recoverJournal(api);
  assert.equal(api._events.length, events, 'second recovery changes nothing');
});

test('recoverJournal after partial move to bar', async () => {
  const { api, generalId, devId } = await seeded();
  api._failAfterMoves(4);
  await assert.rejects(swapBar(api, devId));
  assert.equal((await readState(api.storage.local)).journal.phase, 'toBar');
  assert.deepEqual(api._titles('1'), ['x']);
  await recoverJournal(api);
  assert.deepEqual(api._titles('1'), ['x', 'y']);
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c']);
  assert.deepEqual(api._titles(devId), []);
});

test('recoverJournal with missing folder', async () => {
  const { api, generalId, devId } = await seeded();
  api._failAfterMoves(2);
  await assert.rejects(swapBar(api, devId));
  await api.bookmarks.removeTree(devId);
  const state = await recoverJournal(api);
  const recovered = api._id('Recovered focus');
  assert.ok(recovered, 'replacement folder created');
  assert.equal(state.journal, null);
  assert.equal(state.activeId, recovered);
  assert.ok(state.focusIds.includes(recovered));
  assert.ok(!state.focusIds.includes(devId));
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c'], 'no bar item lost');
});

test('findRoots uses folderType', async () => {
  const api = createFakeChrome();
  assert.deepEqual(await findRoots(api.bookmarks), { barId: '1', otherId: '2' });
});

test('findRoots falls back without folderType', async () => {
  const api = createFakeChrome();
  const real = api.bookmarks.getTree;
  api.bookmarks.getTree = async () => {
    const tree = await real();
    for (const c of tree[0].children) delete c.folderType;
    return tree;
  };
  assert.deepEqual(await findRoots(api.bookmarks), { barId: '1', otherId: '2' });
});

test('a failed swap is finished before the next one (no restart in between)', async () => {
  const { api, rootId, generalId, devId } = await seeded();
  const music = await api.bookmarks.create({ parentId: rootId, title: 'Music' });
  await api.bookmarks.create({ parentId: music.id, title: 'm1', url: 'https://m1/' });
  const st = await readState(api.storage.local);
  st.focusIds.push(music.id);
  await (await import('../extension/lib/store.js')).writeState(api.storage.local, st);
  api._failAfterMoves(4); // dies mid 'toBar': bar = [x], Dev = [y]
  await assert.rejects(swapBar(api, devId));
  const state = await swapBar(api, music.id);
  assert.deepEqual(api._titles('1'), ['m1']);
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c'], 'no Dev item filed under General');
  assert.deepEqual(api._titles(devId), ['x', 'y']);
  assert.equal(state.activeId, music.id);
  assert.equal(state.journal, null);
});

test('a bookmark deleted mid-swap is skipped, not fatal', async () => {
  const { api, generalId, devId } = await seeded();
  const b = api._id('b');
  let once = false;
  api.bookmarks.onMoved.addListener(() => {
    if (!once) { once = true; api.bookmarks.removeTree(b); } // user deletes 'b' after 'a' moved
  });
  const state = await swapBar(api, devId);
  assert.equal(state.journal, null);
  assert.deepEqual(api._titles('1'), ['x', 'y']);
  assert.deepEqual(api._titles(generalId), ['a', 'c']);
});

async function withSwitcher(api) {
  const { writeState } = await import('../extension/lib/store.js');
  const sw = await api.bookmarks.create({ parentId: '1', index: 0, title: '⇄ General' });
  await api.bookmarks.create({ parentId: sw.id, title: '✓ General', url: api.runtime.getURL('switch.html?focus=g') });
  const st = await readState(api.storage.local);
  st.switcherId = sw.id;
  await writeState(api.storage.local, st);
  return sw.id;
}

test('swap leaves the switcher first on the bar', async () => {
  const { api, generalId, devId } = await seeded();
  await withSwitcher(api);
  await swapBar(api, devId);
  assert.deepEqual(api._titles('1'), ['⇄ General', 'x', 'y']);
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c']);
  await swapBar(api, generalId);
  assert.deepEqual(api._titles('1'), ['⇄ General', 'a', 'b', 'c']);
  assert.deepEqual(api._titles(devId), ['x', 'y']);
});

test('recovery leaves the switcher on the bar', async () => {
  const { api, generalId, devId } = await seeded();
  await withSwitcher(api);
  api._failAfterMoves(1);
  await assert.rejects(swapBar(api, devId));
  await recoverJournal(api);
  assert.deepEqual(api._titles('1'), ['⇄ General', 'x', 'y']);
  assert.deepEqual(api._titles(generalId), ['a', 'b', 'c']);
});
