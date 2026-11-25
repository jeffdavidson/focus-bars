import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seeded } from './helpers.js';
import { listFocuses, createFocus, renameFocus, deleteFocus, handleExternalChange } from '../extension/lib/focuses.js';
import { readState, readWindows, writeWindows, writeState } from '../extension/lib/store.js';
import { swapBar } from '../extension/lib/swap.js';

const swapper = (api) => (id) => swapBar(api, id).then(() => {});

async function withWindows(api, map) {
  await writeWindows(api.storage.session, map);
}

test('listFocuses returns names in order', async () => {
  const { api, generalId, devId } = await seeded();
  assert.deepEqual(await listFocuses(api), [{ id: generalId, name: 'General' }, { id: devId, name: 'Dev' }]);
});

test('create empty focus', async () => {
  const { api, rootId, generalId, devId } = await seeded();
  const id = await createFocus(api, 'Music', { copyCurrent: false });
  assert.deepEqual(api._titles(rootId), ['General', 'Dev', 'Music']);
  assert.deepEqual(api._titles(id), []);
  assert.deepEqual((await readState(api.storage.local)).focusIds, [generalId, devId, id]);
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c']);
});

test('create copy of current bar copies nested folders', async () => {
  const { api } = await seeded();
  await api.bookmarks.create({ parentId: '1', title: 'F' });
  const f = api._id('F');
  await api.bookmarks.create({ parentId: f, title: 'f1', url: 'https://f1/' });
  const id = await createFocus(api, 'Copy', { copyCurrent: true });
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c', 'F'], 'bar unchanged');
  assert.deepEqual(api._titles(id), ['a', 'b', 'c', 'F']);
  const [copy] = await api.bookmarks.getSubTree(id);
  const copiedF = copy.children[3];
  assert.notEqual(copiedF.id, f);
  assert.deepEqual(copiedF.children.map((n) => [n.title, n.url]), [['f1', 'https://f1/']]);
  assert.equal(copy.children[0].url, 'https://a/');
});

test('rename changes folder title', async () => {
  const { api, devId } = await seeded();
  await renameFocus(api, devId, 'Code');
  assert.equal((await api.bookmarks.get(devId))[0].title, 'Code');
});

test('delete inactive focus renames to Removed and reassigns windows', async () => {
  const { api, generalId, devId } = await seeded();
  await withWindows(api, { 7: { focusId: devId, printKey: 'p7' }, 8: { focusId: generalId, printKey: 'p8' } });
  await deleteFocus(api, devId, swapper(api));
  assert.equal((await api.bookmarks.get(devId))[0].title, 'Removed – Dev');
  assert.deepEqual(api._titles(devId), ['x', 'y'], 'bookmarks kept');
  const state = await readState(api.storage.local);
  assert.deepEqual(state.focusIds, [generalId]);
  const wins = await readWindows(api.storage.session);
  assert.equal(wins[7].focusId, generalId);
  assert.equal(wins[8].focusId, generalId);
});

test('delete active focus swaps to General first', async () => {
  const { api, generalId, devId } = await seeded();
  await swapBar(api, devId);
  await deleteFocus(api, devId, swapper(api));
  assert.deepEqual(api._titles('1'), ['a', 'b', 'c']);
  assert.deepEqual(api._titles(devId), ['x', 'y']);
  assert.equal((await api.bookmarks.get(devId))[0].title, 'Removed – Dev');
  const state = await readState(api.storage.local);
  assert.equal(state.activeId, generalId);
});

test('cannot delete General', async () => {
  const { api, generalId } = await seeded();
  await assert.rejects(deleteFocus(api, generalId, swapper(api)));
  assert.equal((await api.bookmarks.get(generalId))[0].title, 'General');
});

test('external delete of inactive focus reassigns windows to General', async () => {
  const { api, generalId, devId } = await seeded();
  await withWindows(api, { 7: { focusId: devId, printKey: 'p7' } });
  await api.bookmarks.removeTree(devId);
  const r = await handleExternalChange(api, 'removed', devId, { parentId: (await readState(api.storage.local)).rootId });
  assert.equal(r.changed, true);
  assert.deepEqual((await readState(api.storage.local)).focusIds, [generalId]);
  assert.equal((await readWindows(api.storage.session))[7].focusId, generalId);
});

test('external delete of active focus recreates it', async () => {
  const { api, rootId, generalId, devId } = await seeded();
  await swapBar(api, devId);
  await withWindows(api, { 7: { focusId: devId, printKey: 'p7' } });
  const st = await readState(api.storage.local);
  st.prints = { p7: { urls: [], focusId: devId, lastSeen: 1 } };
  await writeState(api.storage.local, st);
  const [node] = await api.bookmarks.getSubTree(devId);
  await api.bookmarks.removeTree(devId);
  await handleExternalChange(api, 'removed', devId, { parentId: rootId, node });
  const state = await readState(api.storage.local);
  const newDev = state.activeId;
  assert.notEqual(newDev, devId);
  assert.equal((await api.bookmarks.get(newDev))[0].title, 'Dev');
  assert.deepEqual(state.focusIds, [generalId, newDev]);
  assert.equal((await readWindows(api.storage.session))[7].focusId, newDev, 'windows keep it');
  assert.equal(state.prints.p7.focusId, newDev);
  assert.deepEqual(api._titles('1'), ['x', 'y'], 'bar untouched');
  await swapBar(api, generalId);
  assert.deepEqual(api._titles(newDev), ['x', 'y']);
});

test('external delete of inactive General recreates it', async () => {
  const { api, rootId, generalId, devId } = await seeded();
  await swapBar(api, devId);
  await withWindows(api, { 8: { focusId: generalId, printKey: 'p8' } });
  await api.bookmarks.removeTree(generalId);
  await handleExternalChange(api, 'removed', generalId, { parentId: rootId });
  const state = await readState(api.storage.local);
  assert.notEqual(state.generalId, generalId);
  assert.ok(api._exists(state.generalId));
  assert.deepEqual(state.focusIds, [state.generalId, devId]);
  assert.equal((await readWindows(api.storage.session))[8].focusId, state.generalId);
});

test('external move out of Focus Bars drops focus', async () => {
  const { api, generalId, devId } = await seeded();
  await api.bookmarks.move(devId, { parentId: '2' });
  const r = await handleExternalChange(api, 'moved', devId, { parentId: '2' });
  assert.equal(r.changed, true);
  assert.deepEqual((await readState(api.storage.local)).focusIds, [generalId]);
  assert.deepEqual(api._titles(devId), ['x', 'y'], 'bookmarks stay in the moved folder');
});

test('external delete of whole Focus Bars folder recreates it', async () => {
  const { api, rootId, devId } = await seeded();
  await swapBar(api, devId);
  const [node] = await api.bookmarks.getSubTree(rootId);
  await api.bookmarks.removeTree(rootId);
  const r = await handleExternalChange(api, 'removed', rootId, { parentId: '2', node });
  assert.equal(r.changed, true);
  const state = await readState(api.storage.local);
  assert.notEqual(state.rootId, rootId);
  assert.deepEqual(api._titles(state.rootId), ['General', 'Dev']);
  assert.equal((await api.bookmarks.get(state.activeId))[0].title, 'Dev');
  await swapBar(api, state.generalId);
  assert.deepEqual(api._titles('1'), []);
  assert.deepEqual(api._titles(state.activeId === state.generalId ? state.focusIds[1] : state.activeId), ['x', 'y'], 'bar items intact');
});

test('swap moves are not treated as external', async () => {
  const { api, devId, generalId } = await seeded();
  const start = api._events.length;
  await swapBar(api, devId);
  await swapBar(api, generalId);
  const moves = api._events.slice(start).filter((e) => e.name === 'onMoved');
  assert.ok(moves.length > 0);
  for (const e of moves) {
    const r = await handleExternalChange(api, 'moved', ...e.args);
    assert.equal(r.changed, false);
  }
});

test('unrelated removal is ignored', async () => {
  const { api } = await seeded();
  const a = api._id('a');
  await api.bookmarks.removeTree(a);
  assert.deepEqual(await handleExternalChange(api, 'removed', a, { parentId: '1' }), { changed: false });
});
